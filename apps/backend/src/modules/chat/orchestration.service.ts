import { Injectable, Logger } from "@nestjs/common";
import {
  CHAT_INTENT_KEY,
  INTENT_TABLE,
  type ChatCitation,
  type FallbackInfo,
  type FallbackReason,
  type ResolvedNodeConfig,
} from "@codecrush/contracts";
import { withSpan } from "@codecrush/otel";
import { CODECRUSH_SPAN_KIND, RAG } from "@codecrush/otel-conventions";
import { ApplicationsService } from "../applications/applications.service";
import { NodeRuntimeService } from "../node-runtime/executor/node-runtime.service";
import { RetrievalService } from "../retrieval/retrieval.service";
import { KnowledgeBasesService } from "../knowledge-bases/knowledge-bases.service";
import { ConversationsService } from "../conversations/conversations.service";
import { buildRetrievalRequests, mergeHits, type TaggedHit } from "./retrieval-mapping";
import {
  decideFallback,
  deriveConfidence,
  deriveCoverage,
  resolveRetrievalKbIds,
} from "./derived-metrics";
import { FALLBACK_THRESHOLD } from "./orchestration.constants";
import type { OrchestrationResult } from "./orchestration.types";

const TITLE_MAX = 30;
const HISTORY_MAX_MESSAGES = 6;

/**
 * M8 T1 RAG 编排内核（013 §编排 + 014 意图路由）：
 * resolvePublic → rewrite → intent → 路由映射 → 逐 KB 检索合并 → 生成/兜底 → 派生指标 → 落库。
 * chain 根 span 用 withSpan 活动上下文，NodeRuntime/检索的子 span 自动挂父。
 * T1 非流式：返回完整结果，SSE 合成归 controller（T2 逐 token）。
 */
@Injectable()
export class OrchestrationService {
  private readonly logger = new Logger(OrchestrationService.name);

  constructor(
    private readonly applications: ApplicationsService,
    private readonly nodeRuntime: NodeRuntimeService,
    private readonly retrieval: RetrievalService,
    private readonly kbs: KnowledgeBasesService,
    private readonly conversations: ConversationsService,
  ) {}

  async run(
    agentId: string,
    query: string,
    convId?: string,
    userId?: string,
  ): Promise<OrchestrationResult> {
    // resolvePublic 在 span 之外：未上线/停用异常直接冒泡给 controller 翻 404/403（写头之前）。
    const cfg = await this.applications.resolvePublic(agentId);

    return withSpan(
      "rag.pipeline",
      {
        attributes: {
          "codecrush.span.kind": CODECRUSH_SPAN_KIND.CHAIN,
          [RAG.PROMPT_VERSION_ID]: cfg.configVersionId,
          [RAG.PREVIEW]: cfg.preview,
        },
      },
      async (span) => {
        const traceId = span.spanContext().traceId;
        const kbRows = await this.kbs.findByIds(cfg.kbIds);
        const kbNameById = new Map(kbRows.map((k) => [k.id, k.name]));
        // review P2：convId 归属校验——客户端自报的 convId 若属于别的 agentId，不得读其历史
        // 或写入其消息（跨应用会话串号）；不属于/不存在均按未传 convId 处理，降级新建会话。
        const validConvId = await this.resolveConvId(agentId, convId);
        const history = await this.loadHistory(validConvId);

        // 1) rewrite：降级时契约 fallback 已回填原 query
        const rewrite = await this.executeNode<{ rewrittenQuery: string }>(
          cfg.nodes.rewrite,
          "rewrite",
          { query, history },
          {},
        );
        const rewrittenQuery = rewrite.rewrittenQuery;

        // 2) intent：候选恒注入静态全表（014 D3）
        const intentOut = await this.executeNode<{ intent: string }>(
          cfg.nodes.intent,
          "intent",
          { query, history },
          { availableIntents: INTENT_TABLE },
        );
        const intent = intentOut.intent;

        // 3) CHAT 短路：不检索，直走兜底（014 D4）
        if (intent === CHAT_INTENT_KEY) {
          const reasons: FallbackReason[] = ["chitchat", "handled_by_fallback"];
          const fallbackInfo: FallbackInfo = { reasons, scopeKbNames: [] };
          const replyText = await this.streamNode(cfg.nodes.fallback, "fallback");
          const result: OrchestrationResult = {
            traceId,
            replyText,
            citations: [],
            confidence: undefined,
            coverage: "partial",
            isFallback: true,
            fallbackReasons: reasons,
            fallbackInfo,
          };
          result.convId = await this.persist(result, { agentId, query, convId: validConvId, userId });
          return result;
        }

        // 4) 路由映射 + 逐 KB 检索 + 合并去重（保持 routeKbIds 顺序，去重同分保留先到组）
        const routeKbIds = resolveRetrievalKbIds(intent, cfg, kbRows);
        const reqs = buildRetrievalRequests({
          query: rewrittenQuery,
          routeKbIds,
          embedModelId: kbRows[0]?.embeddingModelId ?? "",
          retrieval: cfg.retrieval,
        });
        const perKb = await Promise.all(
          reqs.map(async (r) => ({ kbId: r.kbId, hits: (await this.retrieval.test(r)).hits })),
        );
        const hits: TaggedHit[] = mergeHits(perKb).slice(0, cfg.retrieval.topN);

        // 5) 兜底判定：rerank 开启时用 rerankThreshold（缺省回退平台阈值）
        const threshold = cfg.retrieval.rerankEnabled
          ? (cfg.retrieval.rerankThreshold ?? FALLBACK_THRESHOLD)
          : FALLBACK_THRESHOLD;
        const scopeKbNames = routeKbIds.map((id) => kbNameById.get(id) ?? id);
        const decision = decideFallback({
          topScore: hits[0]?.finalScore,
          hitCount: hits.length,
          threshold,
          scopeKbNames,
        });
        const fallbackInfo: FallbackInfo = {
          reasons: decision.reasons,
          topScore: decision.topScore,
          threshold: decision.threshold,
          scopeKbNames: decision.scopeKbNames,
        };

        // 6) 生成：正常 reply（携检索上下文+引用）；兜底 fallback 纯文本
        let replyText: string;
        let citations: ChatCitation[] = [];
        if (decision.isFallback) {
          replyText = await this.streamNode(cfg.nodes.fallback, "fallback");
        } else {
          citations = hits.map((h, i) => ({
            n: i + 1,
            doc: h.docName,
            kb: kbNameById.get(h.kbId) ?? "",
            section: h.section,
            score: h.finalScore,
          }));
          const retrievalContext = hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n\n");
          replyText = await this.streamNode(cfg.nodes.reply, "reply", {
            input: { query, history, retrievalContext },
            reserved: { citations },
          });
        }

        // 7) 派生指标（F3：从正文 [n] 反查被引用 citation 的 score）
        const marks = new Set(
          [...replyText.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
        );
        const citedScores = citations.filter((c) => marks.has(c.n)).map((c) => c.score);
        const confidence = decision.isFallback
          ? undefined
          : deriveConfidence(
              citedScores.length ? citedScores : citations.slice(0, 1).map((c) => c.score),
            );
        const coverage = deriveCoverage(replyText, citations.length, decision.isFallback);

        const result: OrchestrationResult = {
          traceId,
          replyText,
          citations,
          confidence,
          coverage,
          isFallback: decision.isFallback,
          fallbackReasons: decision.reasons,
          fallbackInfo,
        };
        result.convId = await this.persist(result, { agentId, query, convId: validConvId, userId });
        return result;
      },
    );
  }

  private async executeNode<TOutput>(
    node: ResolvedNodeConfig,
    name: "rewrite" | "intent",
    input: Record<string, unknown>,
    reserved: unknown,
  ): Promise<TOutput> {
    const r = await this.nodeRuntime.executeStructured<Record<string, unknown>, TOutput, unknown>(
      name,
      node.contractVersion,
      node.promptBody,
      node.modelId,
      input,
      reserved,
      { temperature: node.temperature },
    );
    return r.output;
  }

  private async streamNode(
    node: ResolvedNodeConfig,
    name: "reply" | "fallback",
    payload: { input?: Record<string, unknown>; reserved?: unknown } = {},
  ): Promise<string> {
    const r = await this.nodeRuntime.streamText(
      name,
      node.contractVersion,
      node.promptBody,
      node.modelId,
      payload.input ?? {},
      payload.reserved ?? {},
      { temperature: node.temperature },
    );
    return r.text;
  }

  /**
   * review P2：校验 convId 归属当前 agentId，防跨应用会话读写（IDOR）——客户端自报的 convId
   * 若实际属于别的 agentId，会话历史不得被读进当前应用的提示词、也不得被追加消息。
   * 不存在/不属于/查询失败均按未传 convId 处理（降级新建会话），不冒泡为请求失败。
   */
  private async resolveConvId(agentId: string, convId?: string): Promise<string | undefined> {
    if (!convId) return undefined;
    try {
      const conv = await this.conversations.get(convId);
      if (conv.agentId !== agentId) {
        this.logger.warn(
          `convId ${convId} 不属于 agentId ${agentId}（实际属于 ${conv.agentId}）——拒绝跨应用复用，按新会话处理`,
        );
        return undefined;
      }
      return convId;
    } catch (err) {
      this.logger.warn(`convId ${convId} 校验失败（${(err as Error).message}），按新会话处理`);
      return undefined;
    }
  }

  /** 历史注入：读会话既有消息（尾部 N 条）拼接为 "role: content" 行；失败降级 undefined。 */
  private async loadHistory(convId?: string): Promise<string | undefined> {
    if (!convId) return undefined;
    try {
      const msgs = await this.conversations.listMessages(convId);
      if (msgs.length === 0) return undefined;
      return msgs
        .slice(-HISTORY_MAX_MESSAGES)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
    } catch (err) {
      this.logger.warn(`加载会话历史失败（降级为无历史）：${(err as Error).message}`);
      return undefined;
    }
  }

  /** 落库（user+assistant）——边界 7：持久化异常兜住不冒泡为 500，降级仍返回回答。 */
  private async persist(
    result: OrchestrationResult,
    a: { agentId: string; query: string; convId?: string; userId?: string },
  ): Promise<string | undefined> {
    // review P3：convId 声明在 try 外层（非 const）——若 createConversation 已成功但后续
    // appendMessage 失败，catch 分支能返回这个刚创建的会话 id，而不是回退到调用方原始
    // 入参（新会话场景下是 undefined），避免已落库的会话在异常路径里“丢失”。
    let convId = a.convId;
    try {
      if (!convId) {
        convId = (
          await this.conversations.createConversation({
            agentId: a.agentId,
            userId: a.userId,
            title: a.query.slice(0, TITLE_MAX),
          })
        ).id;
      }
      await this.conversations.appendMessage({ convId, role: "user", content: a.query });
      await this.conversations.appendMessage({
        convId,
        role: "assistant",
        content: result.replyText,
        traceId: result.traceId,
        confidence: result.confidence,
        coverage: result.coverage,
        isFallback: result.isFallback,
        fallbackInfo: result.fallbackInfo,
        citations: result.citations.map((c) => String(c.n)),
      });
      return convId;
    } catch (err) {
      this.logger.error(`会话落库失败（降级继续返回回答）：${(err as Error).message}`);
      return convId;
    }
  }
}
