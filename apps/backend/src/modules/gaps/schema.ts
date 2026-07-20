import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { vector1024 } from "../../platform/persistence/pgvector-type";

/**
 * B2a 知识缺口/问题池域的表定义（021 决策 H）。纯表定义、零 service 引用（AGENTS.md 边界 8）。
 * 迁移见 `drizzle/0026_gap_pool.sql`（手写，`drizzle-kit generate` 已停用）。
 */

/** 缺口簇。软删（合并后源簇清空时留痕——「已进评测集」的关联要保留）。 */
export const gapClusters = pgTable(
  "gap_clusters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 代表问题：建簇时那条的聚类键文本（原型 mock 里「能开专用发票吗/对公转账」那一列）。 */
    representativeQuestion: varchar("representative_question", { length: 500 }).notNull(),
    /**
     * 簇中心向量，随归簇增量平均更新 `(c*f+v)/(f+1)`。
     * 维度 1024 与 `chunks.embedding` 一致（开工前实测：chunks 全量 408 行均为 1024）。
     */
    centroid: vector1024("centroid").notNull(),
    /**
     * **累计**命中次数（原型 mock 的「×23」）。只增不减——原型 `:377`「簇内 trace 过期不减频次」。
     * 这也是它必须落 PG 而非查 CH 的原因：`otel_traces` 有 TTL 30 天，到期真删。
     * 滚动 30 天口径是查询期聚合（`freq_30d`），不建列。
     */
    freq: integer("freq").notNull().default(0),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    /** worker 写。人工改判后**永不覆盖**——读取一律 COALESCE(manual, auto)。 */
    rootCauseAuto: varchar("root_cause_auto", { length: 20 }),
    /** 人工改判写。两列而非一列：单列会丢失 auto 值，「worker 现在会怎么判」将不可回答。 */
    rootCauseManual: varchar("root_cause_manual", { length: 20 }),
    /** 「已进评测集」是**叠加标志不是状态**（原型 `:634` 明令非排他）——故用时间戳而非 status 值。 */
    enteredEvalSetAt: timestamp("entered_eval_set_at", { withTimezone: true }),

    // ── B2b [补知识库] 向导与自动回验（021 决策 K，迁移 0028）──────────────
    // 全部 nullable：pending/ignored/routed_retrieval 状态下恒 NULL。
    /** 草拟/人审阶段的 Q（原型 §19.1：1–200 字）。取消人审时**保留**，供再次进入向导（原型 `:704`）。 */
    fillDraftQuestion: varchar("fill_draft_question", { length: 200 }),
    /** 草拟/人审阶段的 A（原型 §19.1：1–2000 字），UI 上标「来源未确认」。 */
    fillDraftAnswer: text("fill_draft_answer"),
    /** 人审选定的目标 KB。跨域只存 id、不建 FK（同 `gap_items.source_trace_id` 的既定风格）。 */
    fillTargetKbId: uuid("fill_target_kb_id"),
    /** 入库后 `DocumentsService.upload()` 返回的文档 id；回验监听器按它反查本簇。 */
    fillTargetDocumentId: uuid("fill_target_document_id"),
    /**
     * 回验用的应用 id 与配置版本 id，**由前端在人审步骤显式选定后传入**。
     * 后端不去猜（`gaps → applications` 不是允许边，且一个簇的成员可能横跨多个应用，
     * 众数启发式没有原型依据）。
     */
    fillVerifyApplicationId: uuid("fill_verify_application_id"),
    fillVerifyConfigVersionId: uuid("fill_verify_config_version_id"),
    /**
     * 点 [补知识库] 那一刻的 `avgQuality` **快照**（原型 `:360` 的「41→89」里的 41）。
     * 必须快照而不是展示时现读：`avgQuality` 是对 `gap_items` 的查询期聚合，
     * 而向导从点击到回验完成可能跨越数分钟到下一个收集器周期（半小时一轮的 cron），
     * 现读会让「之前」这个数随新坏样本涌入而静默漂移。
     */
    fillPreScore: smallint("fill_pre_score"),
    /** 回验完成时的新分数（「41→89」里的 89）。 */
    verifiedScore: smallint("verified_score"),
    /**
     * 「复发」角标（原型 `:631` 红点、`:376`/`:708`）。非空即显示。
     * 两个置位点：① 回验分数 <80（`verifyFail`）；② worker 发现 `ignored`/`verified` 簇
     * 7 天内新增 ≥5 条相似样本。**入库失败（`verifyIngestFailed`）不置位**——那是工程故障，
     * 不是「这个缺口又出现新证据了」，混在一个红点里运营无法分辨该重投文档还是该重查缺口。
     */
    recurredAt: timestamp("recurred_at", { withTimezone: true }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // B2a 放行三态、B2b（迁移 0028）ALTER 后放行七态——正是 B2a 注释里预告的那次兑现。
    // 用 varchar+CHECK 而非 PG enum 正为此：ALTER CHECK 不改类型、不锁表重写。
    // 值域与 `gap.constants.ts:GAP_CLUSTER_STATUSES` 及契约 `packages/contracts/src/gaps.ts`
    // 的同名常量**三处必须同步**（三份独立声明，不是互相 re-export）。
    check(
      "gap_clusters_status_check",
      sql`${t.status} IN ('pending','routed_retrieval','ignored','drafting','reviewing','filled','verified')`,
    ),
    check(
      "gap_clusters_fill_scores_check",
      sql`(${t.fillPreScore} IS NULL OR ${t.fillPreScore} BETWEEN 0 AND 100)
        AND (${t.verifiedScore} IS NULL OR ${t.verifiedScore} BETWEEN 0 AND 100)`,
    ),
    check(
      "gap_clusters_root_cause_auto_check",
      sql`${t.rootCauseAuto} IS NULL OR ${t.rootCauseAuto} IN ('missing','retrieval','generation')`,
    ),
    check(
      "gap_clusters_root_cause_manual_check",
      sql`${t.rootCauseManual} IS NULL OR ${t.rootCauseManual} IN ('missing','retrieval','generation')`,
    ),
    // 屏5 默认排序：待处理在前、频次倒序（原型 `:631`）。
    index("gap_clusters_status_freq_idx").on(t.status, t.freq.desc()),
    // ⚠️ `centroid` 上还有一个 **HNSW cosine 索引** `gap_clusters_centroid_hnsw_idx`，
    // 它**只存在于迁移 SQL**（`drizzle/0026_gap_pool.sql`）里，此处无法声明——
    // drizzle 表达不了 `USING hnsw (... vector_cosine_ops)`（自定义 `vector1024` 类型没有该算子类）。
    // 同 `chunks_embedding_hnsw_idx` 的既有先例（`drizzle/0006_*.sql:49`，chunks/schema.ts 亦未声明）。
    // 无运行时后果：`drizzle-kit generate` 已停用，不会据此"补"出一个删索引的迁移。
    // 别据本文件断言「centroid 没有向量索引」——最近邻查询正依赖它。
  ],
);

/** 簇内真实问题。跨存储引用 trace 只存 id、不建 FK（trace 在 ClickHouse 且有 TTL）。 */
export const gapItems = pgTable(
  "gap_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => gapClusters.id),
    source: varchar("source", { length: 20 }).notNull(),
    sourceTraceId: varchar("source_trace_id", { length: 32 }).notNull(),
    /** 用户原文（屏5 展开时显示「用户实际问的」）。 */
    question: varchar("question", { length: 500 }).notNull(),
    /**
     * 决策 F：rewrite 节点消解指代后的独立问题。**聚类与 gold 沉淀都用它**。
     * `rewrite_resolved = false` 时为 NULL（改写没消解成功，没有可用的独立形式）。
     */
    rewrittenQuestion: varchar("rewritten_question", { length: 500 }),
    /**
     * false = 非首轮 且 改写结果实质等于原文 ⇒ 指代未被消解（缺口 23 的直接测量）。
     * 首轮恒 true（无指代可消解）。它同时是入集守卫的开关：false 的行必须人工改写后才能沉淀成 gold。
     */
    rewriteResolved: boolean("rewrite_resolved").notNull().default(true),
    /** 对 COALESCE(rewritten_question, question) 算出的聚类向量。 */
    embedding: vector1024("embedding").notNull(),
    /** 源 trace 的开始时间，用于 `freq_30d` 滚动窗口；手动入池且取不到时为 NULL（不计入窗口）。 */
    traceStartTime: timestamp("trace_start_time", { withTimezone: true }),
    // 入池当时的分数快照。NULL = 未评，**绝不写 0**（防把未评当低分）。
    faithfulness: smallint("faithfulness"),
    answerRelevancy: smallint("answer_relevancy"),
    contextPrecision: smallint("context_precision"),
    confidence: smallint("confidence"),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    noCitations: boolean("no_citations").notNull().default(false),
    /** = (rewriteResolved === false) && contextPrecision <= 10（021 §6.4）。 */
    followUpSuspected: boolean("follow_up_suspected").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("gap_items_source_check", sql`${t.source} IN ('online','manual_trace','offline_run')`),
    check(
      "gap_items_scores_check",
      sql`(${t.faithfulness} IS NULL OR ${t.faithfulness} BETWEEN 0 AND 100)
        AND (${t.answerRelevancy} IS NULL OR ${t.answerRelevancy} BETWEEN 0 AND 100)
        AND (${t.contextPrecision} IS NULL OR ${t.contextPrecision} BETWEEN 0 AND 100)
        AND (${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 100)`,
    ),
    /**
     * worker 崩溃重跑的幂等凭据：**一条 trace 全局只入池一次**。
     *
     * 键里**故意不含 `cluster_id`**（peer review 抓出的数据完整性洞）：若含簇 id，
     * 「插入成功但游标未推进就崩溃」的重跑里，簇 centroid 可能已被其他 item 的增量平均挪动，
     * 同一条 trace 会归到另一个簇 ⇒ 唯一索引不冲突 ⇒ 两簇各留一行、各 freq+1。
     * 而 `freq` 按设计「只增不减」，这种重复计数**无自愈路径**。
     *
     * 也**不含 `source`**：同一条 trace 被 worker 自动收过、人又从 Trace 详情手动加一次，
     * 同样会双计。全局唯一正好实现原型 `:648` 要的行为——手动入池时命中冲突即返回
     * 「已在缺口『…』(×N) 中 · 查看」，而不是再插一行。
     */
    uniqueIndex("gap_items_source_trace_unique").on(t.sourceTraceId),
    index("gap_items_cluster_time_idx").on(t.clusterId, t.traceStartTime.desc()),
  ],
);

/**
 * 收集器游标。形状照 `evaluations` 的 `eval_watermarks`，但**是自己的表**——
 * 往别人域的表里加一行是跨域写（B1 的手动评分作业就是因这条走了独立表）。
 */
export const gapWatermarks = pgTable("gap_watermarks", {
  workerName: varchar("worker_name", { length: 100 }).primaryKey(),
  /**
   * 游标的时间分量，**存原样 ClickHouse 时间串**（`YYYY-MM-DD HH:MM:SS.fffffffff`），不是时间戳类型。
   *
   * 排序键 `codecrush_traces.start_time` 是 `DateTime64(9)`；经 timestamptz 往返会被截断到微秒，
   * 而 node-postgres 更是直接还原成 JS `Date`（毫秒）⇒ 元组比较 `(ns, id) > (截断后, id)` 恒成立
   * ⇒ 最后一行每轮重取、游标永远推不过它。同 `GapPoolCursor.lastTs` 的取舍，见迁移 0027。
   * 定宽格式 ⇒ 字典序即时间序，`ORDER BY last_ts` 仍然有意义。
   */
  lastTs: varchar("last_ts", { length: 40 }).notNull(),
  lastTraceId: varchar("last_trace_id", { length: 32 }).notNull().default(""),
  leaseOwner: varchar("lease_owner", { length: 200 }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  /** 游标**真正前进**的时刻（只在 lastTs/lastTraceId 变了才更新）——「跑过」vs「走过」的区分。 */
  lastCursorMoveAt: timestamp("last_cursor_move_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GapClusterRow = typeof gapClusters.$inferSelect;
export type GapItemRow = typeof gapItems.$inferSelect;
export type GapWatermarkRow = typeof gapWatermarks.$inferSelect;
