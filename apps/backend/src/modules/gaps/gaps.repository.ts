import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import type { GapClusterStatus, GapItemSource, GapRootCause } from "./gap.constants";
import { meanVector } from "./gap-clustering";
import { gapClusters, gapItems, gapWatermarks, type GapClusterRow, type GapItemRow } from "./schema";

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
  /** `followUpRatio` 的分母要排除 `offline_run`（见 `gap-ingest.ts:recomputeRootCause`）。 */
  source: GapItemSource;
}

/** `listClusters` 的一行（未转成契约形状——日期还是 Date，数值还可能是 PG 的字符串）。 */
export interface GapClusterListRow {
  id: string;
  representativeQuestion: string;
  freq: number;
  status: string;
  rootCause: string | null;
  rootCauseIsManual: boolean;
  enteredEvalSetAt: Date | null;
  /** B2b：非空即屏5 显示「复发」红点（契约层转成布尔 `recurred`）。 */
  recurredAt: Date | null;
  /** B2b：「41→89」的两端。均为 null 表示这个簇还没走到 filled/verified。 */
  fillPreScore: number | null;
  verifiedScore: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  freq30d: number | string;
  avgQuality: string | number | null;
  followUpRatio: string | number | null;
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

/**
 * `moveItems` 的 CAS 失败：成员在事务提交前被别人搬走了（并发拆分/合并）。
 *
 * 是**领域错误而不是 HTTP 异常**——仓库层不该知道 HTTP（全仓其他 `*.repository.ts` 都没有
 * 这种依赖），由 service 映射成 409。语义上也确实是 409 而非 400：请求本身完全良构、
 * 刷新后重试就会成功，客户端要能把它与 `assertItemsBelongTo` 的真 400 区分开才好自动重试。
 */
export class GapItemsMovedConcurrentlyError extends Error {
  constructor() {
    super("缺口成员在本次操作期间被改动过（可能是重复提交），请刷新后重试");
    this.name = "GapItemsMovedConcurrentlyError";
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
        source: gapItems.source,
      })
      .from(gapItems)
      .where(eq(gapItems.clusterId, clusterId));
    return rows.map((row) => ({
      confidence: toScore(row.confidence),
      contextPrecision: toScore(row.contextPrecision),
      faithfulness: toScore(row.faithfulness),
      followUpSuspected: row.followUpSuspected,
      source: row.source as GapItemSource,
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

  // ───────────────────────── 屏5 读模型与簇操作（Task 6） ─────────────────────────

  /**
   * 屏5 列表。`freq_30d` / `avg_quality` / `follow_up_ratio` 三个都是**查询期聚合**，不是列。
   *
   * - `freq_30d` 谓词是 **`source <> 'offline_run'`，不是 `= 'online'`**（drill 二轮裁定）：
   *   `manual_trace` 是人从 Trace 详情挑的**真实线上 trace**，只是发现方式是人工；
   *   写成 `= 'online'` 会把它踢出 30 天口径，与原型 `:377` 的频次语义不符。
   *   `freq` 是累计列（只增不减，簇内 trace 过期不减）；两者都进 `GapClusterSchema`。
   * - `avg_quality` 用 PG 的 `LEAST`：它**忽略 NULL**，只在三个全 NULL 时才返回 NULL，
   *   正好等于「min(三个非空指标)，全未评则无分」。外层 `avg` 再跳过 NULL 行 ⇒
   *   一个分数都没有的簇得 NULL 而不是 0（Global Constraint 6：绝不落 0 冒充未评）。
   * - `follow_up_ratio` 的分母是 **`source = 'online'`**，与 `freq_30d` 的谓词**故意不同**
   *   （peer review 抓出：一度被"对齐"成 `<> 'offline_run'`，那是错的）。
   *   `follow_up_suspected` 只可能由收集器对 online 样本置真——手动入池的行恒为 false
   *   （它拿不到 `contextPrecision`，也没有改写数据）。把恒不可能进分子的行放进分母，
   *   只会**稀释比例**：一个 3/3 全是指代追问的簇，人再手动补 4 条同题样本就变成 3/7 = 0.43，
   *   `triageCluster` 的强制 `retrieval` 覆写随即失效、根因翻回 `missing`
   *   ⇒ 021 §6.4 要防的「把人力引去补一篇根本不缺的文档」恰好发生。**补充证据反而让诊断变坏。**
   * - 排序：`status='pending'` 在前、`freq DESC`，**末尾必须再跟一个唯一键**（`id`）：
   *   问题池里 `freq=1` 是绝对多数，没有 tiebreaker 时 PG 对并列行的顺序在两次查询间不保证一致
   *   ⇒ 分页会让同一个簇在第 1、2 页各出现一次，而另一个簇一次都不出现。
   * - 软删的簇（合并后被清空的源簇）一律不出现在列表里，但行还在（「已进评测集」的关联要留痕）。
   */
  async listClusters(
    query: { status?: string; rootCause?: string; limit: number; offset: number },
    windowStart: Date,
  ): Promise<{ items: GapClusterListRow[]; total: number }> {
    const filters = [isNull(gapClusters.deletedAt)];
    if (query.status) {
      filters.push(eq(gapClusters.status, query.status));
    } else {
      /**
       * 不传 status 时**排除已忽略**（原型 §18.C `:707`：「忽略 → 默认列表隐藏(筛选可见)」）。
       *
       * 不做这条的后果不只是"少一个便利"：屏5 的忽略确认框承诺「忽略后默认列表不再显示」，
       * 而列表刷新后那行**原地不动**、只有状态文字变了 ⇒ 用户以为没生效、重复点，
       * 第二次直接撞非法迁移 400。选「已忽略」筛选或点概览卡仍然看得到它们。
       */
      filters.push(sql`${gapClusters.status} <> 'ignored'`);
    }
    if (query.rootCause) {
      // 按**生效**根因过滤（COALESCE），不是按 auto——人工改判过的簇要能被新根因筛到。
      filters.push(
        sql`COALESCE(${gapClusters.rootCauseManual}, ${gapClusters.rootCauseAuto}) = ${query.rootCause}`,
      );
    }
    const where = and(...filters)!;

    const rows = await this.selectClusterRows(where, windowStart, query.limit, query.offset);
    const [counted] = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(gapClusters)
      .where(where);
    return { items: rows, total: Number(counted?.total ?? 0) };
  }

  /**
   * 按 id 取**一行**列表投影。写操作读回自己那一行专用。
   *
   * 不能用「列一页再 find」来代替（peer review 抓出的 404）：列表按
   * 「pending 在前、freq 倒序」排，一个刚被忽略的低频簇会掉到 200 行之外
   * ⇒ 写明明成功了，响应却是 404「缺口不存在」，用户重试还会撞上一个合法的 400。
   * 顺带也省掉每次写都跑一遍 200 行 + 三个相关子查询的开销。
   */
  async findClusterListRow(id: string, windowStart: Date): Promise<GapClusterListRow | undefined> {
    const [row] = await this.selectClusterRows(
      and(eq(gapClusters.id, id), isNull(gapClusters.deletedAt))!,
      windowStart,
      1,
      0,
    );
    return row;
  }

  /** 列表投影的唯一实现——`listClusters` 与 `findClusterListRow` 共用，免得两处口径漂移。 */
  private async selectClusterRows(
    where: SQL,
    windowStart: Date,
    limit: number,
    offset: number,
  ): Promise<GapClusterListRow[]> {
    const rows = await this.db
      .select({
        id: gapClusters.id,
        representativeQuestion: gapClusters.representativeQuestion,
        freq: gapClusters.freq,
        status: gapClusters.status,
        rootCause: sql<
          string | null
        >`COALESCE(${gapClusters.rootCauseManual}, ${gapClusters.rootCauseAuto})`,
        rootCauseIsManual: sql<boolean>`${gapClusters.rootCauseManual} IS NOT NULL`,
        enteredEvalSetAt: gapClusters.enteredEvalSetAt,
        recurredAt: gapClusters.recurredAt,
        fillPreScore: gapClusters.fillPreScore,
        verifiedScore: gapClusters.verifiedScore,
        firstSeenAt: gapClusters.firstSeenAt,
        lastSeenAt: gapClusters.lastSeenAt,
        /**
         * ⚠️ 关联引用**必须写成 `gap_clusters.id` 字面量，不能用 `${gapClusters.id}`**。
         * drizzle 在这个位置把列对象渲染成**不带表名**的 `"id"`，而 `"id"` 在子查询里
         * 会被解析成**内层** `gap_items.id`（内层作用域优先）⇒ 条件变成 `i.cluster_id = i.id`
         * ⇒ 恒不成立 ⇒ 三个聚合**静默全部归零/归 NULL**，不报错、不告警。
         * 本 story 初版就是这么写的，靠 `freq30d` 的用例才抓出来。
         */
        freq30d: sql<number>`(
          SELECT count(*) FROM gap_items i
          WHERE i.cluster_id = gap_clusters.id
            AND i.source <> 'offline_run'
            AND i.trace_start_time >= ${windowStart}
        )`,
        avgQuality: sql<string | null>`(
          SELECT avg(LEAST(i.faithfulness, i.answer_relevancy, i.context_precision))
          FROM gap_items i WHERE i.cluster_id = gap_clusters.id
        )`,
        followUpRatio: sql<string | null>`(
          SELECT count(*) FILTER (WHERE i.follow_up_suspected)::float8
                 / NULLIF(count(*), 0)
          FROM gap_items i
          WHERE i.cluster_id = gap_clusters.id AND i.source = 'online'
        )`,
      })
      .from(gapClusters)
      .where(where)
      .orderBy(
        sql`(${gapClusters.status} = 'pending') DESC`,
        desc(gapClusters.freq),
        // 唯一键收尾——没有它，freq 并列的行在分页间顺序不稳（见方法注释）。
        gapClusters.id,
      )
      .limit(limit)
      .offset(offset);
    return rows as GapClusterListRow[];
  }

  /** 概览卡 ×4（原型 `:629`）。`enteredEvalSet` 是**叠加标志**，与三个状态计数互不排斥。 */
  async summary(): Promise<{
    pending: number;
    routedRetrieval: number;
    ignored: number;
    enteredEvalSet: number;
  }> {
    const [row] = await this.db
      .select({
        pending: sql<number>`count(*) FILTER (WHERE ${gapClusters.status} = 'pending')`,
        routedRetrieval: sql<number>`count(*) FILTER (WHERE ${gapClusters.status} = 'routed_retrieval')`,
        ignored: sql<number>`count(*) FILTER (WHERE ${gapClusters.status} = 'ignored')`,
        enteredEvalSet: sql<number>`count(*) FILTER (WHERE ${gapClusters.enteredEvalSetAt} IS NOT NULL)`,
      })
      .from(gapClusters)
      .where(isNull(gapClusters.deletedAt));
    return {
      pending: Number(row?.pending ?? 0),
      routedRetrieval: Number(row?.routedRetrieval ?? 0),
      ignored: Number(row?.ignored ?? 0),
      enteredEvalSet: Number(row?.enteredEvalSet ?? 0),
    };
  }

  async findCluster(id: string): Promise<GapClusterRow | undefined> {
    const [row] = await this.db.select().from(gapClusters).where(eq(gapClusters.id, id)).limit(1);
    return row;
  }

  async listItems(clusterId: string): Promise<GapItemRow[]> {
    return this.db
      .select()
      .from(gapItems)
      .where(eq(gapItems.clusterId, clusterId))
      // NULLS LAST：手动入池的行没有 trace 开始时间，PG 的 DESC 默认 NULLS FIRST
      // 会把它们顶到最新真实样本之上，读起来像「最近发生的」。
      .orderBy(sql`${gapItems.traceStartTime} DESC NULLS LAST`);
  }

  /** 状态迁移。合法性由 service 的迁移表判定，这里只落库。 */
  async updateStatus(id: string, status: GapClusterStatus, now: Date): Promise<void> {
    await this.db
      .update(gapClusters)
      .set({ status, updatedAt: now })
      .where(eq(gapClusters.id, id));
  }

  /** 人工改判根因。**只写 manual 列**，auto 保留——「worker 现在会怎么判」要始终可回答。 */
  async setRootCauseManual(id: string, cause: GapRootCause, now: Date): Promise<void> {
    await this.db
      .update(gapClusters)
      .set({ rootCauseManual: cause, updatedAt: now })
      .where(eq(gapClusters.id, id));
  }

  /**
   * 「已进评测集」是**叠加标志不是状态**（原型 `:634` 明令非排他）——只写时间戳，**不碰 status**。
   * 幂等：已标记过就保留首次时间，不刷新（它回答的是「什么时候进的」）。
   */
  async markEnteredEvalSet(id: string, now: Date): Promise<void> {
    await this.db
      .update(gapClusters)
      .set({ enteredEvalSetAt: now, updatedAt: now })
      .where(and(eq(gapClusters.id, id), isNull(gapClusters.enteredEvalSetAt)));
  }

  /** 指定 item 是否都属于该簇——拆分/合并前的归属校验（防跨簇搬运别人的成员）。 */
  async listItemsByIds(itemIds: string[]): Promise<GapItemRow[]> {
    if (itemIds.length === 0) return [];
    return this.db.select().from(gapItems).where(inArray(gapItems.id, itemIds));
  }

  /**
   * 把选中的 item 搬到目标簇，并按**实际成员数**重算两簇的 `freq` 与质心。整段一个事务。
   *
   * `freq` 在这里是**重算**而不是加减：拆分/合并后「累计命中」的口径就是当前成员数——
   * 增量式在成员集整体变动后无法回退（`updateCentroid` 的注释同理）。这也是 AC8「拆分后
   * 两簇 item 数之和守恒」能成立的原因。
   *
   * 源簇被清空时**软删**（`deleted_at`），不物理删：「已进评测集」的关联要留痕，
   * 且 `gap_items.cluster_id` 上有 FK——物理删会连带毁掉已搬走成员的历史归属可读性。
   */
  async moveItems(
    itemIds: string[],
    fromClusterId: string,
    target: { kind: "existing"; clusterId: string } | { kind: "new"; representativeQuestion: string },
    now: Date,
  ): Promise<{ targetClusterId: string; sourceSoftDeleted: boolean }> {
    return this.db.transaction(async (tx) => {
      const moved = await tx.select().from(gapItems).where(inArray(gapItems.id, itemIds));
      const centroid = meanVector(moved.map((item) => item.embedding));

      let targetClusterId: string;
      if (target.kind === "existing") {
        targetClusterId = target.clusterId;
      } else {
        const [created] = await tx
          .insert(gapClusters)
          .values({
            representativeQuestion: target.representativeQuestion.slice(0, 500),
            centroid,
            freq: 0,
            firstSeenAt: now,
            lastSeenAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: gapClusters.id });
        targetClusterId = created.id;
      }

      /**
       * **CAS：`AND cluster_id = fromClusterId` 不能省，行数对不上就整段回滚。**
       *
       * 归属校验（`GapsService.assertItemsBelongTo`）在事务**之外**跑，挡不住并发。
       * 用户双击「拆分」⇒ 两个请求都通过校验 ⇒ R1 先提交（item 已搬进新簇 N1），
       * R2 再按 id 把同样的 item 搬进 N2，而 R2 只会刷新 `fromCluster` 与 N2
       * ⇒ **N1 永远没人管**：freq=2、零成员、`deleted_at` 为空，在屏5 上是一个展开为空的「×2」，
       * 无自愈路径。加上这个条件后 R2 影响 0 行 ⇒ 抛错回滚 ⇒ 连它建的 N2 一起消失。
       */
      const relocated = await tx
        .update(gapItems)
        .set({ clusterId: targetClusterId })
        .where(and(inArray(gapItems.id, itemIds), eq(gapItems.clusterId, fromClusterId)))
        .returning({ id: gapItems.id });
      if (relocated.length !== itemIds.length) throw new GapItemsMovedConcurrentlyError();

      for (const clusterId of new Set([fromClusterId, targetClusterId])) {
        await this.refreshClusterAggregates(tx, clusterId, now);
      }

      const [remaining] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(gapItems)
        .where(eq(gapItems.clusterId, fromClusterId));
      const emptied = Number(remaining?.n ?? 0) === 0;
      if (emptied) {
        await tx
          .update(gapClusters)
          .set({ deletedAt: now, updatedAt: now })
          .where(eq(gapClusters.id, fromClusterId));
      }
      return { targetClusterId, sourceSoftDeleted: emptied };
    });
  }

  /** 按当前成员重算一个簇的 `freq` 与质心。成员为空时保持原样（调用方随后软删它）。 */
  private async refreshClusterAggregates(
    tx: Parameters<Parameters<DB["transaction"]>[0]>[0],
    clusterId: string,
    now: Date,
  ): Promise<void> {
    const members = await tx
      .select({ embedding: gapItems.embedding })
      .from(gapItems)
      .where(eq(gapItems.clusterId, clusterId));
    if (members.length === 0) return;
    await tx
      .update(gapClusters)
      .set({
        freq: members.length,
        centroid: meanVector(members.map((m) => m.embedding)),
        updatedAt: now,
      })
      .where(eq(gapClusters.id, clusterId));
  }
}
