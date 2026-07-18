import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * E-W2a 离线评测域的表定义（018 §10）。纯表定义、零 service 引用（AGENTS.md 边界 8）。
 * 字段级约束取自原型 §19.1（表单校验），不是臆造。
 */

/** `eval_case_versions.gold_doc_refs` 的行内结构（jsonb）。 */
export interface GoldDocRefRow {
  docId: string;
  chunkId: string | null;
  docName: string;
  section: string | null;
}

/** 评测集。软删（原型 §18.B：历史报告仍可查看）。 */
export const evalSets = pgTable(
  "eval_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 50 }).notNull(), // §19.1：1-50 字
    description: text("description").notNull().default(""),
    kbIds: uuid("kb_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`), // 关联知识库（原型 §5：LLM 生成与统计口径）
    createdBy: varchar("created_by", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // §19.1「名称已存在」；部分索引 → 软删后名字可复用
    uniqueIndex("eval_sets_name_unique")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * 用例身份（稳定 id）。`status`/`deletedAt` 是「逻辑用例」属性，跨版本延续
 * —— 原型 §18.B：reviewed --编辑保存--> reviewed(v+1)，不回退 draft。
 */
export const evalCases = pgTable(
  "eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    setId: uuid("set_id")
      .notNull()
      .references(() => evalSets.id),
    status: varchar("status", { length: 20 }).notNull().default("draft"), // 原型 §18.B 两态
    currentVersion: integer("current_version").notNull().default(1),
    /** 原型 §18.B。W2a 建列不建检测器 → 恒 false，UI 不显示橙 tag（018 已知缺口 4）。 */
    goldStale: boolean("gold_stale").notNull().default(false),
    /** 来源 trace（可空；过 TTL 仅置灰不删）。 */
    sourceTraceId: varchar("source_trace_id", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("eval_cases_status_check", sql`${t.status} IN ('draft','reviewed')`),
    index("eval_cases_set_status_idx").on(t.setId, t.status),
  ],
);

/** 用例内容的不可变版本（原型 §5/§18.B：保存即新版本，旧版本冻结供历史 run 引用）。 */
export const evalCaseVersions = pgTable(
  "eval_case_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => evalCases.id),
    version: integer("version").notNull(),
    question: varchar("question", { length: 500 }).notNull(), // §19.1：1-500 字
    /** §19.1：每条 ≤200 字；draft 可空，reviewed 要求 ≥1（service 层校验——两态阈值不同，DB check 表达不了）。 */
    goldPoints: text("gold_points")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * §19.1：≤10 个引用（F3：chunk 级）。jsonb `[{docId, chunkId, docName, section}]`——
     * docName/section 为保存时快照，供 UI 显示，不回查文档表。F2 检索指标消费。
     */
    goldDocRefs: jsonb("gold_doc_refs")
      .notNull()
      .$type<GoldDocRefRow[]>()
      .default(sql`'[]'::jsonb`),
    /** §19.1：≤5 个、每个 ≤12 字。 */
    tags: varchar("tags", { length: 12 })
      .array()
      .notNull()
      .default(sql`'{}'::varchar[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("eval_case_versions_case_version_unique").on(t.caseId, t.version)],
);

/**
 * 「全局活跃槽位」部分唯一索引的名字（018 §12 缺口 13）。
 *
 * **必须是常量，不能两处各写一遍字面量**：`eval-runs.repository.ts` 的
 * `isSingleActiveRunConflict` 按此名**精确匹配** 23505（笼统匹配会把
 * `eval_run_results_run_case_unique` 这类真 bug 伪装成正常的 409）。改了索引名却漏改
 * 判别函数，`POST /eval/runs` 的并发兜底就从 409 静默退化成 500，且编译期毫无信号。
 *
 * 第三处副本在 `drizzle/0023_eval_run_active_slot.sql`（迁移是手写 SQL，无从共享常量；
 * 该文件已冻结，见 `drizzle/README.md`），由 `eval-runs.lease.db.spec.ts` 的真库断言钉住。
 */
export const EVAL_RUNS_SINGLE_ACTIVE_UNIQUE = "eval_runs_single_active_unique";

/** run。 */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    setId: uuid("set_id")
      .notNull()
      .references(() => evalSets.id),
    // 跨域引用只存 id、不建 FK（AGENTS.md 边界 5：跨域只走 service/端口）
    applicationId: uuid("application_id").notNull(),
    configVersionId: uuid("config_version_id").notNull(),
    judgeModelId: uuid("judge_model_id").notNull(),
    embeddingModelId: uuid("embedding_model_id").notNull(),
    /** 离线独立量具版本；v2 默认仅作用于新建 run，不重写历史行。 */
    offlineJudgeVersion: varchar("offline_judge_version", { length: 100 })
      .notNull()
      .default("offline-v2"),
    /** §14/F5：每题重复次数（1-5），worker 每 case 跑 N 次取非空均值。 */
    repeatCount: integer("repeat_count").notNull().default(1),
    status: varchar("status", { length: 20 }).notNull().default("queued"), // 原型 §18.A 逐字
    scope: varchar("scope", { length: 20 }).notNull().default("all"), // W2a 仅 all；low_score/tags 留 W2b
    /**
     * [{caseId, caseVersionId, seq}]：发起时快照（原型 §18.B「运行中 run 不受影响」）；
     * 亦是推导 skipped 用例的唯一依据。
     */
    caseVersionSnapshot: jsonb("case_version_snapshot").notNull(),
    totalCases: integer("total_cases").notNull().default(0),
    doneCases: integer("done_cases").notNull().default(0),
    tokenBudget: integer("token_budget").notNull().default(500000),
    /** 决策 G：已知上报之和；provider 不回传 usage 时计 0 → 熔断偏松，不假装精确。 */
    tokensUsed: integer("tokens_used").notNull().default(0),
    /** 停止信号（worker 逐条检查）。 */
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    // 串行化：全局同时最多 1 个 running（原型 §6）
    leaseOwner: varchar("lease_owner", { length: 200 }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdBy: varchar("created_by", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "eval_runs_status_check",
      sql`${t.status} IN ('queued','running','done','partial','budget_stop','failed')`,
    ),
    // W2a 只认 'all'。不预先放行 low_score/tags —— 放行一个引擎不遵守的值 = 投机
    // （同 D6「加一个不被遵守的列是投机」的判断）。W2b 实现「范围」时 ALTER 此 CHECK。
    check("eval_runs_scope_check", sql`${t.scope} IN ('all')`),
    index("eval_runs_idempotency_idx").on(t.setId, t.configVersionId, t.createdAt), // 1h 幂等查询
    index("eval_runs_active_idx").on(t.status), // queued/running 并发检查
    /**
     * 018 §12 缺口 13：**「全局同时最多 1 个 run」的唯一硬保证**。
     * 索引名走 `EVAL_RUNS_SINGLE_ACTIVE_UNIQUE` 常量，与判别函数同源（见该常量注释）。
     *
     * `create()` 的 `findActiveRun()` 只是快速路径与文案来源——它与 `insertRun()`
     * 之间无事务、无锁，两个并发请求会双双越过它（TOCTOU 双开）。后果非良性：
     * 第二条 run 干等到超过一个 GRACE 后被回收器判 failed，**无声失败**。
     * 删掉本索引 = 把缺口 13 原样放回来。
     *
     * 索引表达式在部分索引内恒为 true ⇒ 至多一行活跃。终态行不在谓词内、不占槽位。
     * 迁移见 `drizzle/0023_eval_run_active_slot.sql`；冲突判别见
     * `eval-runs.repository.ts` 的 `isSingleActiveRunConflict`（按此名精确匹配）。
     */
    uniqueIndex(EVAL_RUNS_SINGLE_ACTIVE_UNIQUE)
      .on(sql`(${t.status} IN ('queued','running'))`)
      .where(sql`${t.status} IN ('queued','running')`),
  ],
);

/** 逐用例结果。未跑到的用例**不写行**——由 snapshot − 结果行推导 skipped，不留垃圾行。 */
export const evalRunResults = pgTable(
  "eval_run_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    caseVersionId: uuid("case_version_id")
      .notNull()
      .references(() => evalCaseVersions.id),
    seq: integer("seq").notNull(), // 报告里的 # 列
    /** §14/F5：本行属于第几次重复（1-5）。唯一索引含此列。 */
    repeatIndex: integer("repeat_index").notNull().default(1),
    verdict: varchar("verdict", { length: 20 }).notNull(),
    // NULL = 未评（裁判失败 / 无 gold / 超时）——**绝不写 0**（原型 §6，防拉低均值）
    faithfulness: smallint("faithfulness"),
    answerRelevancy: smallint("answer_relevancy"),
    contextPrecision: smallint("context_precision"),
    correctness: smallint("correctness"),
    /** F4：Citation（仅记分卡/evidence，不进 verdict/综合分）。 */
    citation: smallint("citation"),
    /** F2：检索层 gold-docs 指标（确定性排序真值，不进 verdict/综合分）。 */
    contextRecall: smallint("context_recall"),
    ndcg5: smallint("ndcg5"),
    hitRate5: smallint("hit_rate5"),
    minMetric: varchar("min_metric", { length: 30 }), // 最差指标（默认排序键）
    minScore: smallint("min_score"),
    /** {faithfulness:[],answerRelevancy:[],contextPrecision:[],correctness:[]}——只收评出来的指标。 */
    evidence: jsonb("evidence")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** 「trace」链接；编排失败时为空。 */
    previewTraceId: varchar("preview_trace_id", { length: 32 }),
    answer: text("answer").notNull().default(""),
    tokensUsed: integer("tokens_used").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "eval_run_results_verdict_check",
      sql`${t.verdict} IN ('pass','weak','low','timeout','unscored')`,
    ),
    // 分数 0-100 的 DB 级兜底（对齐 evaluations/schema.ts:36-47 的同域约定）。
    // NULL 不受 CHECK 约束（NULL → unknown → 通过），故「未评记 NULL」不受影响。
    check(
      "eval_run_results_scores_check",
      sql`(${t.faithfulness} IS NULL OR ${t.faithfulness} BETWEEN 0 AND 100)
        AND (${t.answerRelevancy} IS NULL OR ${t.answerRelevancy} BETWEEN 0 AND 100)
        AND (${t.contextPrecision} IS NULL OR ${t.contextPrecision} BETWEEN 0 AND 100)
        AND (${t.correctness} IS NULL OR ${t.correctness} BETWEEN 0 AND 100)
        AND (${t.citation} IS NULL OR ${t.citation} BETWEEN 0 AND 100)
        AND (${t.contextRecall} IS NULL OR ${t.contextRecall} BETWEEN 0 AND 100)
        AND (${t.ndcg5} IS NULL OR ${t.ndcg5} BETWEEN 0 AND 100)
        AND (${t.hitRate5} IS NULL OR ${t.hitRate5} BETWEEN 0 AND 100)
        AND (${t.minScore} IS NULL OR ${t.minScore} BETWEEN 0 AND 100)`,
    ),
    // min_metric CHECK 不动——citation/检索三项不进 argmin（diff D1）。
    check(
      "eval_run_results_min_metric_check",
      sql`${t.minMetric} IS NULL OR ${t.minMetric} IN ('faithfulness','answerRelevancy','contextPrecision','correctness')`,
    ),
    uniqueIndex("eval_run_results_run_case_unique").on(t.runId, t.caseVersionId, t.repeatIndex),
    index("eval_run_results_worst_idx").on(t.runId, t.minScore), // 「最差指标升序」默认排序
  ],
);

export type EvalSetRow = typeof evalSets.$inferSelect;
export type EvalCaseRow = typeof evalCases.$inferSelect;
export type EvalCaseVersionRow = typeof evalCaseVersions.$inferSelect;
export type EvalRunRow = typeof evalRuns.$inferSelect;
export type EvalRunResultRow = typeof evalRunResults.$inferSelect;

/** `eval_runs.case_version_snapshot` 的行内结构（jsonb，无 drizzle 类型）。 */
export interface EvalRunSnapshotEntry {
  caseId: string;
  caseVersionId: string;
  seq: number;
}
