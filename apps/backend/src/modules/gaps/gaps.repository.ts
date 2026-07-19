import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import type { GapItemSource, GapRootCause } from "./gap.constants";
import { gapClusters, gapItems, gapWatermarks } from "./schema";

/**
 * 问题池的 Postgres 读写。**只碰 `gap_*` 三张表**——Global Constraint 9：
 * 收集器绝不写 `eval_watermarks` / `eval_candidate_ledger`（那是 evaluations 域的资产），
 * 自己的进度落自己的 `gap_watermarks`。守护网见 `test/gap-pool-isolation.spec.ts`。
 */

/** 游标状态。`lastTs` 是原样 CH 时间串，见 `schema.ts:gapWatermarks.lastTs` 的注释。 */
export interface GapCursorState {
  lastTs: string;
  lastTraceId: string;
}

/** 最近邻查询的返回：候选簇的全部归簇决策所需信息（相似度判定在 processor 里做）。 */
export interface NearestCluster {
  id: string;
  centroid: number[];
  freq: number;
}

/**
 * 归簇目标。**由 processor 决定**（它持有 `cosineSimilarity` 与阈值），repository 只负责落库。
 * 把决策留在 processor 是为了让它可以被纯内存 fake 测到——若判定藏进 SQL，
 * 单测就只能测到 fake 自己重写的一份判定逻辑。
 */
export type GapClusterTarget =
  | { kind: "existing"; clusterId: string; nextCentroid: number[] }
  | { kind: "new"; representativeQuestion: string; centroid: number[] };

export interface GapItemDraft {
  source: GapItemSource;
  sourceTraceId: string;
  question: string;
  rewrittenQuestion: string | null;
  rewriteResolved: boolean;
  embedding: number[];
  traceStartTime: Date | null;
  faithfulness: number | null;
  answerRelevancy: number | null;
  contextPrecision: number | null;
  confidence: number | null;
  fallbackUsed: boolean;
  noCitations: boolean;
  followUpSuspected: boolean;
}

/** 重算簇根因所需的成员信号（只取分诊要用的几列，不拉整行）。 */
export interface ClusterTriageInput {
  confidence: number | null;
  contextPrecision: number | null;
  faithfulness: number | null;
  followUpSuspected: boolean;
}

export interface AttachItemResult {
  clusterId: string;
  /** false = 这条 trace 已在池中（唯一索引挡下）⇒ 本次不该计频、不该动 centroid。 */
  inserted: boolean;
}

/**
 * processor 依赖的最小端口。**测试用内存 fake 实现它**，故这里只列真正被调用的方法——
 * 端口越窄，fake 与真实实现产生行为分歧的面就越小。
 */
export interface GapCollectorStore {
  getOrCreateWatermark(workerName: string, now: Date, seedFrom: string): Promise<GapCursorState>;
  tryAcquireLease(workerName: string, owner: string, now: Date, ttlMs: number): Promise<boolean>;
  releaseLease(workerName: string, owner: string, now: Date): Promise<void>;
  recordFailure(workerName: string, message: string): Promise<void>;
  findNearestCluster(embedding: number[]): Promise<NearestCluster | null>;
  attachItem(target: GapClusterTarget, item: GapItemDraft, now: Date): Promise<AttachItemResult>;
  listClusterTriageInputs(clusterId: string): Promise<ClusterTriageInput[]>;
  setClusterRootCauseAuto(clusterId: string, cause: GapRootCause, now: Date): Promise<void>;
  /** @returns false = 租约已被别人抢走，本轮什么都没落库（见实现处注释）。 */
  finishCycle(
    workerName: string,
    owner: string,
    cursor: GapCursorState,
    now: Date,
    cursorMoved: boolean,
  ): Promise<boolean>;
}

/**
 * 内部哨兵：`attachItem` 用它把「唯一索引挡下了插入」变成事务回滚信号。
 * 不外泄给调用方——`attachItem` 捕获后转成 `inserted: false`。
 */
class GapItemConflictError extends Error {
  constructor(sourceTraceId: string) {
    super(`gap item already exists for trace ${sourceTraceId}`);
    this.name = "GapItemConflictError";
  }
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function toScore(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class GapsRepository implements GapCollectorStore {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  /**
   * 水位线行在 worker 首次开工时诞生，起点由调用方给（`GAP_POOL_CURSOR_START.lastTs`）。
   * `onConflictDoNothing` 保护重启：行已存在时**绝不**把游标推回起点。
   */
  async getOrCreateWatermark(
    workerName: string,
    now: Date,
    seedFrom: string,
  ): Promise<GapCursorState> {
    await this.db
      .insert(gapWatermarks)
      .values({ workerName, lastTs: seedFrom, lastTraceId: "", updatedAt: now })
      .onConflictDoNothing();
    const [row] = await this.db
      .select({ lastTs: gapWatermarks.lastTs, lastTraceId: gapWatermarks.lastTraceId })
      .from(gapWatermarks)
      .where(eq(gapWatermarks.workerName, workerName))
      .limit(1);
    if (!row) throw new Error(`gap watermark unavailable: ${workerName}`);
    return row;
  }

  /** 条件更新式租约（范式照 `evaluations.repository.ts:tryAcquireLease`）：过期或本人持有才拿得到。 */
  async tryAcquireLease(
    workerName: string,
    owner: string,
    now: Date,
    ttlMs: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(gapWatermarks)
      .set({
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + ttlMs),
        lastRunAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(gapWatermarks.workerName, workerName),
          or(
            isNull(gapWatermarks.leaseUntil),
            lt(gapWatermarks.leaseUntil, now),
            eq(gapWatermarks.leaseOwner, owner),
          ),
        ),
      )
      .returning({ workerName: gapWatermarks.workerName });
    return rows.length === 1;
  }

  async releaseLease(workerName: string, owner: string, now: Date): Promise<void> {
    await this.db
      .update(gapWatermarks)
      .set({ leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(gapWatermarks.workerName, workerName), eq(gapWatermarks.leaseOwner, owner)));
  }

  async recordFailure(workerName: string, message: string): Promise<void> {
    await this.db
      .update(gapWatermarks)
      .set({
        consecutiveFailures: sql`${gapWatermarks.consecutiveFailures} + 1`,
        lastError: message.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(gapWatermarks.workerName, workerName));
  }

  /**
   * 最近邻取一条候选簇（HNSW `vector_cosine_ops` 索引在迁移 0026 建好）。
   *
   * 这里**只负责找**，不负责判——相似度由 processor 用 `cosineSimilarity` 在 TS 里重算。
   * 两件事都交给 SQL 看似更省，但 pgvector 的 `<=>` 与我们的纯函数在零向量等边界上语义不同，
   * 让判定只有一处实现（且是被表驱动单测覆盖的那处）比省一次距离计算重要。
   * 软删的簇不参与归簇——它们的成员已被合并走了。
   */
  async findNearestCluster(embedding: number[]): Promise<NearestCluster | null> {
    const literal = toVectorLiteral(embedding);
    const [row] = await this.db
      .select({
        id: gapClusters.id,
        centroid: gapClusters.centroid,
        freq: gapClusters.freq,
      })
      .from(gapClusters)
      .where(isNull(gapClusters.deletedAt))
      .orderBy(sql`${gapClusters.centroid} <=> ${literal}::vector`)
      .limit(1);
    return row ?? null;
  }

  /**
   * 建簇/归簇 + 插 item，**整段一个事务**。
   *
   * 为什么不拆成 `createCluster` + `insertItem` 两个调用：崩在两者之间会留下一个 `freq=0`、
   * 没有任何成员的空簇，它照样出现在屏5 的列表里（×0），且没有自愈路径。
   *
   * 同一个洞还有第二个入口，**必须先查再建**才堵得住（peer review 抓出）：重投一页时，
   * 某条已入池的 trace 的原簇质心可能已被同页其他成员挪走 ⇒ 相似度跌破阈值 ⇒ 走 `new` 分支
   * ⇒ 先 INSERT 新簇、再插 item 撞唯一索引、早返回 —— **事务照常提交，空簇留下**。
   * （换过 embedding 模型后重投一整页会让每条都走这条路。）故先按 `source_trace_id` 探一次，
   * 命中就一行不写地返回；探测与插入之间的并发缝隙由唯一索引兜底，此时抛错让整个事务回滚，
   * 新建的簇随之消失。
   *
   * `freq` 与 centroid 只在**真的插入了新 item** 时才动。唯一索引 `gap_items_source_trace_unique`
   * 挡下的重复（崩溃重跑同一批）走 `inserted=false` ⇒ 不重复计频。这是幂等的全部依据，
   * 不要在 processor 里再加一层「查一下在不在」——查完到写之间照样可以并发插入。
   *
   * **不碰 `status`**：一个 `ignored` 的簇再次被命中只涨频次，不复活（原型 `:634` 的语义——
   * 「忽略」是人的判断，收集器无权推翻）。也不碰 `root_cause_manual`（Global Constraint 8）。
   */
  async attachItem(
    target: GapClusterTarget,
    item: GapItemDraft,
    now: Date,
  ): Promise<AttachItemResult> {
    try {
      return await this.runAttachItem(target, item, now);
    } catch (error) {
      if (!(error instanceof GapItemConflictError)) throw error;
      // 并发插入赢了：事务已回滚（没留下空簇），按「已在池中」返回赢家所属的簇。
      const [row] = await this.db
        .select({ clusterId: gapItems.clusterId })
        .from(gapItems)
        .where(eq(gapItems.sourceTraceId, item.sourceTraceId))
        .limit(1);
      if (!row) throw error; // 冲突了却查不到——不是并发，是别的问题，别吞掉
      return { clusterId: row.clusterId, inserted: false };
    }
  }

  private async runAttachItem(
    target: GapClusterTarget,
    item: GapItemDraft,
    now: Date,
  ): Promise<AttachItemResult> {
    return this.db.transaction(async (tx) => {
      // ① 先探：这条 trace 已在池中就一行不写地返回，绝不先建簇再发现插不进去。
      const [existing] = await tx
        .select({ clusterId: gapItems.clusterId })
        .from(gapItems)
        .where(eq(gapItems.sourceTraceId, item.sourceTraceId))
        .limit(1);
      if (existing) return { clusterId: existing.clusterId, inserted: false };

      let clusterId: string;
      if (target.kind === "existing") {
        clusterId = target.clusterId;
      } else {
        const [created] = await tx
          .insert(gapClusters)
          .values({
            representativeQuestion: target.representativeQuestion.slice(0, 500),
            centroid: target.centroid,
            freq: 0,
            firstSeenAt: now,
            lastSeenAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: gapClusters.id });
        clusterId = created.id;
      }

      const inserted = await tx
        .insert(gapItems)
        .values({
          clusterId,
          source: item.source,
          sourceTraceId: item.sourceTraceId,
          question: item.question.slice(0, 500),
          rewrittenQuestion: item.rewrittenQuestion?.slice(0, 500) ?? null,
          rewriteResolved: item.rewriteResolved,
          embedding: item.embedding,
          traceStartTime: item.traceStartTime,
          faithfulness: item.faithfulness,
          answerRelevancy: item.answerRelevancy,
          contextPrecision: item.contextPrecision,
          confidence: item.confidence,
          fallbackUsed: item.fallbackUsed,
          noCitations: item.noCitations,
          followUpSuspected: item.followUpSuspected,
          createdAt: now,
        })
        .onConflictDoNothing({ target: gapItems.sourceTraceId })
        .returning({ id: gapItems.id });

      // ② 探测之后、插入之前的并发缝隙（租约让它极罕见，但不是不可能）。
      // 此时**必须抛**而不是早返回：`new` 分支下已经写了一个簇，早返回会把它留在库里成空簇。
      // 抛错回滚整个事务 ⇒ 簇消失、item 保持原样，调用方按「没插进去」处理。
      if (inserted.length === 0) throw new GapItemConflictError(item.sourceTraceId);

      await tx
        .update(gapClusters)
        .set({
          freq: sql`${gapClusters.freq} + 1`,
          ...(target.kind === "existing" ? { centroid: target.nextCentroid } : {}),
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(gapClusters.id, clusterId));
      return { clusterId, inserted: true };
    });
  }

  async listClusterTriageInputs(clusterId: string): Promise<ClusterTriageInput[]> {
    const rows = await this.db
      .select({
        confidence: gapItems.confidence,
        contextPrecision: gapItems.contextPrecision,
        faithfulness: gapItems.faithfulness,
        followUpSuspected: gapItems.followUpSuspected,
      })
      .from(gapItems)
      .where(eq(gapItems.clusterId, clusterId));
    return rows.map((row) => ({
      confidence: toScore(row.confidence),
      contextPrecision: toScore(row.contextPrecision),
      faithfulness: toScore(row.faithfulness),
      followUpSuspected: row.followUpSuspected,
    }));
  }

  /** 只写 `root_cause_auto`。`root_cause_manual` 由人写、worker 永不覆盖（Global Constraint 8）。 */
  async setClusterRootCauseAuto(
    clusterId: string,
    cause: GapRootCause,
    now: Date,
  ): Promise<void> {
    await this.db
      .update(gapClusters)
      .set({ rootCauseAuto: cause, updatedAt: now })
      .where(eq(gapClusters.id, clusterId));
  }

  /**
   * 推进游标。`lastCursorMoveAt` 只在游标**真的动了**时更新——「跑过」与「走过」要能分开看：
   * 一个连续空转三天的收集器，`lastRunAt` 是新鲜的而 `lastCursorMoveAt` 是三天前的。
   * 成功一轮同时清掉失败计数（`recordFailure` 攒的），否则一次偶发失败会永远挂在那儿。
   *
   * **返回是否真的写成了**：WHERE 带 `lease_owner = owner`，租约在本轮跑超时被别人抢走后
   * 这条 UPDATE 会影响 0 行且**不报错**。不把这个信号交出去，processor 就会一边什么都没落库、
   * 一边返回 `healthy` 并在日志里宣称游标推进到了 X——一个查不出来的假象。
   */
  async finishCycle(
    workerName: string,
    owner: string,
    cursor: GapCursorState,
    now: Date,
    cursorMoved: boolean,
  ): Promise<boolean> {
    const rows = await this.db
      .update(gapWatermarks)
      .set({
        lastTs: cursor.lastTs,
        lastTraceId: cursor.lastTraceId,
        lastRunAt: now,
        ...(cursorMoved ? { lastCursorMoveAt: now } : {}),
        consecutiveFailures: 0,
        lastError: null,
        updatedAt: now,
      })
      .where(and(eq(gapWatermarks.workerName, workerName), eq(gapWatermarks.leaseOwner, owner)))
      .returning({ workerName: gapWatermarks.workerName });
    return rows.length === 1;
  }
}
