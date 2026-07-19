import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { GAP_COLLECT_JOB, GAP_COLLECT_QUEUE } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { EvaluationsRepository } from "../evaluations/evaluations.repository";
import { ModelsService } from "../models/models.service";
import {
  ClickHouseGapsRepository,
  GAP_POOL_CURSOR_START,
  type PoolCandidate,
} from "./clickhouse-gaps.repository";
import {
  CLUSTER_SIMILARITY_MIN,
  GAP_COLLECT_CANDIDATE_LIMIT,
  GAP_COLLECT_CRON,
  GAP_COLLECT_LAG_BUFFER_MS,
  GAP_COLLECT_LEASE_MS,
  GAP_COLLECT_WORKER_NAME,
} from "./gap.constants";
import { cosineSimilarity, updateCentroid } from "./gap-clustering";
import {
  clusterKeyOf,
  detectFollowUp,
  isRewriteResolved,
  shouldEnterPool,
  triageCluster,
  triageItem,
} from "./gap-triage";
import { GapsRepository, type GapClusterTarget, type GapCursorState } from "./gaps.repository";

const WorkerPayloadSchema = z.strictObject({ workerName: z.string().min(1).max(100) });

export interface GapCollectCycleResult {
  status: "lease_busy" | "lease_lost" | "model_unavailable" | "healthy";
  /** 真的新入池的条数（重投命中唯一索引的不算）。 */
  collected: number;
  /**
   * 本页里没有新入池的条数。**注意它混了两种命运**：
   * 「不满足入池判据 / 已在池中」是游标已越过、不会重来的；而「没拿到 embedding」是游标
   * 特意没越过、下轮还会重扫的。看这个数不能推断「这些已被放弃」。
   */
  skipped: number;
  cursor?: GapCursorState;
}

/**
 * 问题池收集器（021 决策 C）。
 *
 * 形态照 `EvaluationWorkerProcessor`：cron 驱动 → 抢租约 → 按游标扫一页 → 逐条处理 → 落游标。
 * 与它的关键差别是**只读**别人的域：候选来自 gaps 自己的 ClickHouse 读模型，判官版本与
 * embedding 模型来自 `EvaluationsRepository.getSettings()`（纯读），写入只落 `gap_*` 三张表
 * （Global Constraint 9）。
 *
 * 归簇/分诊的判定全部走 `gap-clustering.ts` / `gap-triage.ts` 的纯函数——本文件只负责编排
 * 与 IO 顺序，不重复实现任何阈值比较。
 *
 * ⚠️ **本类尚未注册进任何 Nest module**（B2a Task 6 才交付 `gaps.module.ts` + `app.module.ts`
 * 接线）。在那之前 `onModuleInit` 不会执行 ⇒ cron 从不触发 ⇒ `gap_watermarks` 恒 0 行、
 * 问题池恒空。两个 spec 都手工 `new` 了本类，所以测试全绿**证明不了**它在跑。
 * 这行写在代码里而不是只写在 `.ship/` 的 ledger 里：`.ship/` 被 gitignore，
 * 「代码已合并」会被下一个会话读成「功能已上线」（002 记的 M8 同款事故）。
 */
@Injectable()
export class GapCollectorProcessor implements OnModuleInit {
  private readonly logger = new Logger(GapCollectorProcessor.name);

  constructor(
    @Inject(GAP_COLLECT_QUEUE) private readonly queue: Queue,
    // 类型必须写**具体类**而不是 `GapCollectorStore & GapsRepository`：
    // `emitDecoratorMetadata` 把交叉类型/联合类型一律序列化成 `Object`，
    // `design:paramtypes` 里就没有可解析的 token ⇒ 一旦 Task 6 把它注册进 `GapsModule`，
    // 应用启动即抛「Nest can't resolve dependencies … index [1]」。
    // 单测照样能传内存 fake（`GapsRepository implements GapCollectorStore`，端口约束不丢），
    // 而这类错误在测试里发现不了——tsconfig 把 spec 与 test/ 都排除在类型检查外。
    private readonly store: GapsRepository,
    private readonly clickhouse: ClickHouseGapsRepository,
    private readonly evaluations: EvaluationsRepository,
    private readonly models: ModelsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.subscribe(GAP_COLLECT_JOB, async (data) => {
      const payload = WorkerPayloadSchema.parse(data);
      try {
        await this.processCycle(payload.workerName);
      } catch (error) {
        await this.store.recordFailure(payload.workerName, toMessage(error));
        throw error;
      }
    });
    await this.queue.schedule(
      GAP_COLLECT_JOB,
      GAP_COLLECT_CRON,
      { workerName: GAP_COLLECT_WORKER_NAME },
      { tz: "UTC", key: GAP_COLLECT_WORKER_NAME, retryLimit: 1 },
    );
  }

  async processCycle(
    workerName = GAP_COLLECT_WORKER_NAME,
    now = new Date(),
  ): Promise<GapCollectCycleResult> {
    // 水位线行必须**先**建出来：`recordFailure` 是一条 UPDATE，行不存在时静默影响 0 行。
    // 全新环境（还没配 embedding 模型）下若先判模型再建行，`consecutive_failures` / `last_error`
    // 永远是空的，运维完全看不到「收集器因缺模型一直没开工」。
    await this.store.getOrCreateWatermark(workerName, now, GAP_POOL_CURSOR_START.lastTs);

    const settings = await this.evaluations.getSettings();
    // 只卡 embedding 模型：问题池的入池信号里，confidence / fallback / no_citations 三支
    // 根本不经过裁判，所以在线评测被关掉时收集器**照样该跑**。但没有 embedding 就无法聚类，
    // 此时**绝不推进游标**——推了这段流量就永久出不了候选集（`listPoolCandidates` 只往前看）。
    if (!settings.embeddingModelId) {
      await this.store.recordFailure(workerName, "embedding model is not configured");
      return { status: "model_unavailable", collected: 0, skipped: 0 };
    }

    const owner = randomUUID();
    if (!(await this.store.tryAcquireLease(workerName, owner, now, GAP_COLLECT_LEASE_MS))) {
      return { status: "lease_busy", collected: 0, skipped: 0 };
    }

    try {
      // 抢到租约后**重读**一次才是权威游标：上面那次只为把行建出来，
      // 它读到的值可能是另一个实例刚推进前的旧值（重跑不会坏数据，但会白扫一页）。
      const watermark = await this.store.getOrCreateWatermark(
        workerName,
        now,
        GAP_POOL_CURSOR_START.lastTs,
      );
      const candidates = await this.clickhouse.listPoolCandidates(
        watermark,
        new Date(now.getTime() - GAP_COLLECT_LAG_BUFFER_MS),
        settings.judgeVersion,
        GAP_COLLECT_CANDIDATE_LIMIT,
      );

      // 入池判据在 TS 侧复判一次。SQL 已预筛，但两处口径一旦漂移（改了阈值只改一边），
      // 这一道能把错误挡在写库之前——反向的漏收远比把正常流量灌进池子好收拾。
      const admitted = candidates.filter((c) => shouldEnterPool(c));
      const enriched = admitted.map((c) => this.enrich(c));

      // 批量 embed：一次网络往返顶 N 次。顺序即入参顺序，下面按 index 对齐。
      const vectors =
        enriched.length > 0
          ? await this.models.embedTexts(
              settings.embeddingModelId,
              enriched.map((e) => e.clusterKey),
            )
          : [];

      let collected = 0;
      // 没拿到向量的候选：游标**不许越过**它们（见下方推进循环）。
      const unembedded = new Set<string>();
      for (let index = 0; index < enriched.length; index += 1) {
        const entry = enriched[index];
        const embedding = vectors[index];
        // `length === 0` 必须一起拦：空数组是 truthy，放行的话 centroid 会写成 `[]`，
        // PG 抛「expected 1024 dimensions, not 0」⇒ 整轮抛出 ⇒ 游标不推进 ⇒ 下轮取到
        // 同一页同一条再炸 —— 永久崩溃循环，只有 consecutive_failures 在涨。
        if (!embedding || embedding.length === 0) {
          // 绝不拿别人的向量给它归簇——那会污染一个真实簇的质心。
          this.logger.warn(`embedding 缺失，本轮不处理 trace ${entry.candidate.traceId}`);
          unembedded.add(entry.candidate.traceId);
          continue;
        }
        const inserted = await this.ingest(entry, embedding, now);
        if (inserted) collected += 1;
      }

      /**
       * 游标推到**第一条没能处理的候选之前**就停（范式同 `evaluation-worker.processor.ts`
       * 的 `advancesCursor` + `break`）。
       *
       * 没入池的候选可以放心越过：`shouldEnterPool` 是幂等纯函数，重扫只会得到同样结论。
       * 但 embedding 少返的候选**不能**越过——`listPoolCandidates` 只往前看，越过即永久丢失。
       * provider 若对大批量恒截断，每轮都会静默丢掉近百条真实缺口样本，而
       * `collected`/`skipped`/`healthy` 全都显示正常。宁可原地卡住等下一轮重试。
       */
      let cursor: GapCursorState = {
        lastTs: watermark.lastTs,
        lastTraceId: watermark.lastTraceId,
      };
      for (const item of candidates) {
        if (unembedded.has(item.traceId)) break;
        cursor = { lastTs: item.cursorTs, lastTraceId: item.traceId };
      }
      const cursorMoved =
        cursor.lastTs !== watermark.lastTs || cursor.lastTraceId !== watermark.lastTraceId;
      const persisted = await this.store.finishCycle(workerName, owner, cursor, now, cursorMoved);
      if (!persisted) {
        // 租约在本轮跑的过程中被抢走 ⇒ 上面这次 UPDATE 影响 0 行、什么都没落库。
        // 必须如实报出来：报 healthy 等于宣称游标推进了，而实际它还停在原处。
        this.logger.error(
          `租约已被接管，本轮游标未落库（worker=${workerName}）——本轮处理的 ${collected} 条已入池，游标由接管方推进`,
        );
        return { status: "lease_lost", collected, skipped: candidates.length - collected };
      }

      return {
        status: "healthy",
        collected,
        skipped: candidates.length - collected,
        cursor,
      };
    } finally {
      await this.store.releaseLease(workerName, owner, now);
    }
  }

  /** 把候选算成「入池所需的全部派生信号」。全部走纯函数，本方法不含任何阈值。 */
  private enrich(candidate: PoolCandidate) {
    const rewriteResolved = isRewriteResolved({
      isFirstTurnInSession: candidate.isFirstTurnInSession,
      raw: candidate.question,
      rewritten: candidate.rewrittenQuestion,
    });
    // 未消解时把改写结果丢掉：它只是原文的复读，留着会让屏5 的「改写后」列显示一句
    // 看起来像模像样、实则没有独立语义的问题，也会被后续入集当成可用 gold。
    const rewrittenQuestion = rewriteResolved ? candidate.rewrittenQuestion : null;
    return {
      candidate,
      rewriteResolved,
      rewrittenQuestion,
      clusterKey: clusterKeyOf({ question: candidate.question, rewrittenQuestion }),
      followUpSuspected: detectFollowUp({
        rewriteResolved,
        contextPrecision: candidate.contextPrecision,
      }),
    };
  }

  /** 单条候选落库：归簇决策 → 写 item（幂等）→ 重算簇根因。返回是否真的新增了成员。 */
  private async ingest(
    entry: ReturnType<GapCollectorProcessor["enrich"]>,
    embedding: number[],
    now: Date,
  ): Promise<boolean> {
    const { candidate } = entry;
    const nearest = await this.store.findNearestCluster(embedding);
    // pgvector 只用来**找**候选，相似度用纯函数重算——判定只有一处实现（见 repository 注释）。
    const similarity = nearest ? cosineSimilarity(nearest.centroid, embedding) : 0;
    const target: GapClusterTarget =
      nearest && similarity >= CLUSTER_SIMILARITY_MIN
        ? {
            kind: "existing",
            clusterId: nearest.id,
            nextCentroid: updateCentroid(nearest.centroid, nearest.freq, embedding),
          }
        : { kind: "new", representativeQuestion: entry.clusterKey, centroid: embedding };

    const { clusterId, inserted } = await this.store.attachItem(
      target,
      {
        source: "online",
        sourceTraceId: candidate.traceId,
        question: candidate.question,
        rewrittenQuestion: entry.rewrittenQuestion,
        rewriteResolved: entry.rewriteResolved,
        embedding,
        traceStartTime: toDateOrNull(candidate.startTime),
        faithfulness: candidate.faithfulness,
        answerRelevancy: candidate.answerRelevancy,
        contextPrecision: candidate.contextPrecision,
        // 已是百分制：换算在 `clickhouse-gaps.repository.ts` 就做完了（量纲接缝只此一处）。
        confidence: candidate.confidence,
        fallbackUsed: candidate.fallbackUsed,
        noCitations: candidate.noCitations,
        followUpSuspected: entry.followUpSuspected,
      },
      now,
    );
    // 没插进去（同一条 trace 已在池中）⇒ 簇的成员集没变，重算根因是纯粹的空转。
    if (!inserted) return false;

    await this.retriage(clusterId, now);
    return true;
  }

  /**
   * 按簇现有全部成员重算 `root_cause_auto`。
   * **只写 auto 列**——人工判定（`root_cause_manual`）永不被 worker 覆盖（Global Constraint 8）。
   */
  private async retriage(clusterId: string, now: Date): Promise<void> {
    const inputs = await this.store.listClusterTriageInputs(clusterId);
    if (inputs.length === 0) return;
    const causes = inputs.map((i) =>
      triageItem({
        confidence: i.confidence,
        contextPrecision: i.contextPrecision,
        faithfulness: i.faithfulness,
      }),
    );
    const followUpRatio = inputs.filter((i) => i.followUpSuspected).length / inputs.length;
    await this.store.setClusterRootCauseAuto(clusterId, triageCluster(causes, followUpRatio), now);
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDateOrNull(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
