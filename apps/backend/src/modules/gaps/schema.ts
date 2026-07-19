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
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // B2a 只放行可达三态。B2b 加 drafting/reviewing/filled/verified 时**必须 ALTER 此 CHECK**
    // ——同 eval_runs.scope 的既定做法（放行一个引擎不遵守的值 = 投机）。
    // 用 varchar+CHECK 而非 PG enum 正为此：ALTER CHECK 不改类型、不锁表重写。
    check("gap_clusters_status_check", sql`${t.status} IN ('pending','routed_retrieval','ignored')`),
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
    // worker 崩溃重跑的幂等凭据：同一条 trace 在同簇同来源下只入池一次。
    uniqueIndex("gap_items_cluster_source_trace_unique").on(
      t.clusterId,
      t.source,
      t.sourceTraceId,
    ),
    index("gap_items_cluster_time_idx").on(t.clusterId, t.traceStartTime.desc()),
  ],
);

/**
 * 收集器游标。形状照 `evaluations` 的 `eval_watermarks`，但**是自己的表**——
 * 往别人域的表里加一行是跨域写（B1 的手动评分作业就是因这条走了独立表）。
 */
export const gapWatermarks = pgTable("gap_watermarks", {
  workerName: varchar("worker_name", { length: 100 }).primaryKey(),
  lastTs: timestamp("last_ts", { withTimezone: true }).notNull(),
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
