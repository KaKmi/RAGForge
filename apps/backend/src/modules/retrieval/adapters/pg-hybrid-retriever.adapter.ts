import { Injectable } from "@nestjs/common";
import type { RetrievalHit, RetrievalTestRequest } from "@codecrush/contracts";
import { withSpan } from "@codecrush/otel";
import { CODECRUSH_SPAN_KIND, GEN_AI, OTEL_OPERATIONS, RAG } from "@codecrush/otel-conventions";
import { ChunksService } from "../../chunks/chunks.service";
import { ModelsService } from "../../models/models.service";
import { KnowledgeBasesService } from "../../knowledge-bases/knowledge-bases.service";
import type { RetrieverPort } from "../ports/retriever.port";

// 平台级重排候选池上限，独立于用户可自由输入的 topK（008 §性能/规模），防止重排调用成本
// 随 topK 无界增长。50–100 是工程判断，未经真实供应商实测校准（008 Revisit）。
export const RERANK_POOL_CAP = 80;

interface FusedCandidate {
  chunkId: string;
  docId: string;
  docName: string;
  text: string;
  section: string;
  vecScore: number;
  kwScore?: number;
  rerankScore?: number;
  finalScore: number;
}

/**
 * RetrieverPort 的第一个真实适配器（008 §数据流程图的 9 步管线）：
 * 解析 activeVersion → 查询向量化 → 双路并行召回 → 去重融合 → 相似度阈值 → 截断候选池 →
 * 可选 rerank + rerank 阈值 → 最终排序截断 topN。
 * 降级不对称（008 Invariant 3）：向量失败=硬失败；关键词失败=降级纯向量；rerank 失败=跳过重排。
 * 仅经 RETRIEVER_PORT token 注入消费，禁止直接 import（003 边界）。
 */
@Injectable()
export class PgHybridRetriever implements RetrieverPort {
  constructor(
    private readonly chunks: ChunksService,
    private readonly models: ModelsService,
    private readonly kbs: KnowledgeBasesService,
  ) {}

  async retrieve(req: RetrievalTestRequest): Promise<RetrievalHit[]> {
    return await withSpan(
      "retrieval.retrieve",
      {
        attributes: {
          [GEN_AI.OPERATION_NAME]: OTEL_OPERATIONS.RETRIEVE,
          "codecrush.span.kind": CODECRUSH_SPAN_KIND.RETRIEVAL,
          [RAG.RETRIEVAL_TOP_K]: req.topK,
          [RAG.RETRIEVAL_THRESHOLD]: req.threshold,
          [RAG.MULTI_RECALL]: req.multi,
          [RAG.VEC_WEIGHT]: req.vecWeight ?? 0.5,
          ...(req.rerankThreshold !== undefined
            ? { [RAG.RERANK_THRESHOLD]: req.rerankThreshold }
            : {}),
          ...(req.topN !== undefined ? { [RAG.RETRIEVAL_TOP_N]: req.topN } : {}),
        },
      },
      (span) => this.doRetrieve(req, (k, v) => span.setAttribute(k, v)),
    );
  }

  private async doRetrieve(
    req: RetrievalTestRequest,
    tag: (key: string, value: string) => void,
  ): Promise<RetrievalHit[]> {
    const kb = await this.kbs.get(req.kbId);
    // M8 T3：embed 子 span——doRetrieve 整段在 retrieval.retrieve 的活动上下文内，
    // 嵌套 withSpan 自动挂父。embed 抛出 = 向量核心信号硬失败，子 span 自动标 ERROR 并冒泡。
    // gen_ai.system（协议）省略：adapter 只有 embedModelId、不知其协议（协议在 models 域 row）。
    const [queryVector] = await withSpan(
      "retrieval.embedding",
      {
        attributes: {
          [GEN_AI.OPERATION_NAME]: OTEL_OPERATIONS.EMBEDDINGS,
          [GEN_AI.REQUEST_MODEL]: req.embedModelId,
          "codecrush.span.kind": CODECRUSH_SPAN_KIND.EMBEDDINGS,
        },
      },
      () => this.models.embedTexts(req.embedModelId, [req.query]),
    );

    const vecWeight = req.vecWeight ?? 0.5;
    const poolSize = Math.min(req.topK, RERANK_POOL_CAP);

    const [vecOutcome, kwOutcome] = await Promise.allSettled([
      this.chunks.searchByVector(req.kbId, kb.activeVersion, queryVector, poolSize),
      req.multi
        ? this.chunks.searchByKeyword(req.kbId, kb.activeVersion, req.query, poolSize)
        : Promise.resolve([]),
    ]);

    // 向量召回是核心信号，无先例支持降级（008 Invariant 3，非对称降级）
    if (vecOutcome.status === "rejected") {
      throw new Error(`向量召回失败：${(vecOutcome.reason as Error).message}`);
    }
    const vecRows = vecOutcome.value;
    // 关键词路失败 → 降级为纯向量继续（001 既定先例），span 打标；降级语义 = 结果如同只跑了
    // 向量路（finalScore=vecScore，不套权重——否则单路分数被 vecWeight 无谓腰斩，Invariant 2）。
    const kwDegraded = req.multi && kwOutcome.status === "rejected";
    if (kwDegraded) {
      // 独立 key（非共用 "rag.degraded"）：同请求可能双降级（关键词+rerank），共用 key 会互相覆盖
      tag(
        "rag.degraded.keyword_recall",
        ((kwOutcome as PromiseRejectedResult).reason as Error).message,
      );
    }
    const useFusion = req.multi && !kwDegraded;

    const merged = useFusion
      ? this.fuse(vecRows, kwOutcome.status === "fulfilled" ? kwOutcome.value : [], vecWeight)
      : vecRows.map<FusedCandidate>((r) => ({ ...r, finalScore: r.vecScore }));

    const fused = merged
      .filter((c) => c.finalScore >= req.threshold)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, poolSize);

    let candidates = fused;
    if (req.rerankModelId && candidates.length > 0) {
      const rerankModelId = req.rerankModelId;
      try {
        // M8 T3：rerank 子 span——try/catch 放 withSpan 外层，使 rerank 失败时子 span
        // 标 ERROR（瀑布图可见），同时父检索照常降级保留融合分（008 Invariant 3 非对称降级）。
        const rerankResults = await withSpan(
          "retrieval.rerank",
          {
            attributes: {
              [GEN_AI.OPERATION_NAME]: OTEL_OPERATIONS.RERANK,
              [GEN_AI.REQUEST_MODEL]: rerankModelId,
              "codecrush.span.kind": CODECRUSH_SPAN_KIND.RERANK,
            },
          },
          () => this.models.rerankTexts(rerankModelId, req.query, candidates.map((c) => c.text)),
        );
        const byIndex = new Map(rerankResults.map((r) => [r.index, r.score]));
        candidates = candidates.map((c, i) => {
          const score = byIndex.get(i);
          return score === undefined ? c : { ...c, rerankScore: score, finalScore: score };
        });
        if (req.rerankThreshold !== undefined) {
          const min = req.rerankThreshold;
          candidates = candidates.filter(
            (c) => c.rerankScore === undefined || c.rerankScore >= min,
          );
        }
      } catch (err) {
        // rerank 失败/超时 → 降级为跳过重排，保留融合分作为 finalScore（008 Invariant 3）
        tag("rag.degraded.rerank", (err as Error).message);
      }
    }

    const topN = req.topN ?? candidates.length;
    const finalHits = candidates
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, topN)
      .map((c) => ({
        chunkId: c.chunkId,
        docId: c.docId,
        docName: c.docName,
        text: c.text,
        section: c.section,
        vecScore: c.vecScore,
        kwScore: c.kwScore,
        rerankScore: c.rerankScore,
        finalScore: c.finalScore,
      }));

    // M8 T3：命中分表——每命中分块的向量/关键词/rerank/最终分落 retrieval span（供 M9 命中面板）。
    // 正文不落（004 §「命中只存 chunk_id 引用，正文回 Postgres 取」）；对象数组必须 JSON 串
    // （span attribute 只能是 primitive/数组，ClickHouse attributes 是开放字符串 Map）。
    tag(
      RAG.CHUNK_SCORES,
      JSON.stringify(
        finalHits.map((h) => ({
          chunkId: h.chunkId,
          doc: h.docName, // M9 W2 D1：命中分表文档名（读侧纯 CH，不回 Postgres 取名）
          section: h.section ?? null,
          vec: h.vecScore,
          kw: h.kwScore ?? null,
          rerank: h.rerankScore ?? null,
          final: h.finalScore,
        })),
      ),
    );
    return finalHits;
  }

  // 加权线性和（不是 RRF——008 §融合算法：finalScore 已被契约锁死 [0,1]，凸组合天然满足，
  // RRF 还要再套一层归一化）。缺席某一路的 chunk，该路分数按 0 参与融合（未被该路召回 =
  // 该路贡献为 0，是"候选池限定召回"的自然推论，不是刻意惩罚）。
  private fuse(
    vecRows: {
      chunkId: string;
      docId: string;
      docName: string;
      text: string;
      section: string;
      vecScore: number;
    }[],
    kwRows: {
      chunkId: string;
      docId: string;
      docName: string;
      text: string;
      section: string;
      kwScore: number;
    }[],
    vecWeight: number,
  ): FusedCandidate[] {
    const byId = new Map<string, FusedCandidate>();
    for (const r of vecRows) {
      byId.set(r.chunkId, { ...r, finalScore: r.vecScore });
    }
    for (const r of kwRows) {
      const existing = byId.get(r.chunkId);
      if (existing) {
        existing.kwScore = r.kwScore;
      } else {
        byId.set(r.chunkId, { ...r, vecScore: 0, finalScore: 0 });
      }
    }
    for (const c of byId.values()) {
      c.finalScore = vecWeight * c.vecScore + (1 - vecWeight) * (c.kwScore ?? 0);
    }
    return [...byId.values()];
  }
}
