import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const onlineEvalSettings = pgTable(
  "online_eval_settings",
  {
    id: varchar("id", { length: 64 }).primaryKey().default("default"),
    enabled: boolean("enabled").notNull().default(false),
    sampleRate: numeric("sample_rate", { precision: 5, scale: 4, mode: "number" })
      .notNull()
      .default(0.1),
    judgeModelId: uuid("judge_model_id"),
    embeddingModelId: uuid("embedding_model_id"),
    faithfulnessThreshold: smallint("faithfulness_threshold").notNull().default(85),
    answerRelevancyThreshold: smallint("answer_relevancy_threshold").notNull().default(80),
    contextPrecisionThreshold: smallint("context_precision_threshold").notNull().default(80),
    dailyCap: integer("daily_cap").notNull().default(500),
    judgeVersion: varchar("judge_version", { length: 100 }).notNull().default("online-v2"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("online_eval_settings_sample_rate_check", sql`${table.sampleRate} BETWEEN 0 AND 1`),
    check(
      "online_eval_settings_faithfulness_threshold_check",
      sql`${table.faithfulnessThreshold} BETWEEN 0 AND 100`,
    ),
    check(
      "online_eval_settings_answer_relevancy_threshold_check",
      sql`${table.answerRelevancyThreshold} BETWEEN 0 AND 100`,
    ),
    check(
      "online_eval_settings_context_precision_threshold_check",
      sql`${table.contextPrecisionThreshold} BETWEEN 0 AND 100`,
    ),
    check("online_eval_settings_daily_cap_check", sql`${table.dailyCap} BETWEEN 1 AND 10000`),
  ],
);

export const evalWatermarks = pgTable("eval_watermarks", {
  workerName: varchar("worker_name", { length: 100 }).primaryKey(),
  lastTs: timestamp("last_ts", { withTimezone: true }).notNull(),
  lastTraceId: varchar("last_trace_id", { length: 32 }).notNull().default(""),
  dailyDate: date("daily_date", { mode: "string" }).notNull(),
  dailyCount: integer("daily_count").notNull().default(0),
  leaseOwner: varchar("lease_owner", { length: 200 }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  // 游标**上次真正前进**的时刻（只在 lastTs/lastTraceId 变了才更新）。
  // 与 lastRunAt 的区别是「跑过」vs「走过」：worker 每 15 分钟空转一轮也会更新 lastRunAt，
  // 但游标可能几天没动。缺了这一列，「游标是什么时候、因为哪一轮走到这儿的」事后无从回答
  // ——018 §12 缺口 20 那个至今没解开的谜（游标停在一条高风险 trace 上却零 span）正卡在这里。
  lastCursorMoveAt: timestamp("last_cursor_move_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 游标越过的每一条 trace 在这里留一行——**这份表就是游标的审计轨迹**。
 *
 * 为什么需要它：`eval_watermarks` 的单点游标被迫同时表达「我扫到哪了」（不能倒退，否则每轮
 * 重扫）与「我评过哪些」（真实进度）。平时两者重合，一旦有候选被跳过就分叉，而单点游标只能
 * 存一个值 —— 于是被跳过的 trace 在账上彻底消失。**解法不是让游标别推进**（`sampled_out`
 * 不推进会让水位线卡在第一条没抽中的 trace 上、worker 每轮重扫同一条，死锁），而是把两个
 * 语义拆成两份记录：游标继续管扫描前沿，这张表管「看过哪些、为什么没评」。
 *
 * 记**全部 6 种推进 outcome**（含 `success`/`already_scored`），不只记跳过：
 * 它是**唯一不依赖 ClickHouse span 投递成败**的持久证据（`forceFlushTelemetry` 被有意设计成
 * 吞掉一切导出失败，见 `packages/otel/src/trace.ts`），故本表与 `codecrush_eval_targets` 的
 * **差集**就是丢包的量化手段。只记跳过拿不到这个能力，且日后要加得改 schema。
 *
 * 不记 `cap_deferred`/`circuit_deferred`：它们不推进游标，下一轮会重新取到——记了会造出
 * 「看过但其实还会再看」的假账。
 */
export const evalCandidateLedger = pgTable(
  "eval_candidate_ledger",
  {
    targetTraceId: varchar("target_trace_id", { length: 32 }).notNull(),
    // 同一条 trace 换 judgeVersion 重评是**另一笔账**（017 的 judgeVersion 升版即口径断代）
    judgeVersion: varchar("judge_version", { length: 100 }).notNull(),
    workerName: varchar("worker_name", { length: 100 }).notNull(),
    outcome: varchar("outcome", { length: 32 }).notNull(),
    // 回补/排查要按时间范围找，只有 trace_id 够不着（ClickHouse 那边按 start_time 分区）
    traceStartTime: timestamp("trace_start_time", { withTimezone: true }).notNull(),
    agentId: varchar("agent_id", { length: 64 }).notNull().default(""),
    // 同一条被看过几次。>1 说明它被重复扫描过（cap/circuit 前缀之后的候选会这样），
    // 是排查「为什么这条评了两次」的入口。
    seenCount: integer("seen_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
  },
  (t) => [
    primaryKey({ columns: [t.targetTraceId, t.judgeVersion] }),
    index("eval_candidate_ledger_trace_start_time_idx").on(t.traceStartTime),
  ],
);

export type OnlineEvalSettingsRow = typeof onlineEvalSettings.$inferSelect;
export type EvalWatermarkRow = typeof evalWatermarks.$inferSelect;
export type EvalCandidateLedgerRow = typeof evalCandidateLedger.$inferSelect;

/**
 * B1/F3：人工「立即评测」的作业表。**刻意与 eval_candidate_ledger 分开**——
 * 见 0025 迁移注释：账本表达的是游标推进语义，人工旁路不推进游标。
 * 主键与账本同形 (target_trace_id, judge_version)，正因如此更不能混用同一张表。
 */
export const evalManualScoreJobs = pgTable(
  "eval_manual_score_jobs",
  {
    targetTraceId: varchar("target_trace_id", { length: 32 }).notNull(),
    judgeVersion: varchar("judge_version", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    requestedBy: varchar("requested_by", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 显式命名：不给名字时 drizzle 生成的是
    // `eval_manual_score_jobs_target_trace_id_judge_version_pk`（见 0020 里账本表的实例），
    // 与手写迁移里的 `..._pk` 对不上 —— 名字漂移会让将来任何按名字 DROP CONSTRAINT 的迁移失败。
    primaryKey({ name: "eval_manual_score_jobs_pk", columns: [t.targetTraceId, t.judgeVersion] }),
    check(
      "eval_manual_score_jobs_status_check",
      sql`${t.status} IN ('queued','running','scored','failed')`,
    ),
    index("eval_manual_score_jobs_status_idx").on(t.status, t.updatedAt),
  ],
);
export type EvalManualScoreJobRow = typeof evalManualScoreJobs.$inferSelect;
