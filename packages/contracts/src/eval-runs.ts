import { z } from "zod";
import type { ChatStreamEvent } from "./chat";

const isoString = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
/** 逐指标分数：整数 0-100（原型 §7 逐用例表与记分卡均显示整数）。 */
const score = z.number().int().min(0).max(100);
/**
 * 综合分：**允许一位小数**——原型 §5「上次得分」显示 `82.0`。与 `EvalSet.lastRunScore`
 * 是同一个量（同一 run 的综合分），两处口径必须一致，故都不加 `.int()`。
 * 计算方与舍入规则见 eval-runs.service（Story 6）：四指标非空均值 → 四舍五入到一位小数。
 */
const overallScoreValue = z.number().min(0).max(100);

/** 原型 §18.A 状态机逐字对齐。 */
export const EvalRunStatusSchema = z.enum([
  "queued",
  "running",
  "done",
  "partial",
  "budget_stop",
  "failed",
]);
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

/**
 * 原型 §7 判定：各指标最低档（<60 low / 60-79 weak / ≥80 pass）。
 * `timeout` = 单用例编排超时；`unscored` = 三个基础指标全 NULL（裁判全挂）。
 * 后两者不进 pass/weak/low 分母——原型未写全，018 §11 显式补全。
 */
export const EvalVerdictSchema = z.enum(["pass", "weak", "low", "timeout", "unscored"]);
export type EvalVerdict = z.infer<typeof EvalVerdictSchema>;

/**
 * `citation`（F4）仅供 evidence 键与 METRIC_LABEL 使用；**`minMetric` 永不产出该值**
 * （EVAL_RUN_METRIC_KEYS argmin 序不含它，diff D1）——citation 不进 verdict/综合分。
 * 检索层三项（contextRecall/ndcg5/hitRate5）不是 LLM 判分指标，不进本 enum（无 evidence 键）。
 */
export const EvalMetricKeySchema = z.enum([
  "faithfulness",
  "answerRelevancy",
  "contextPrecision",
  "correctness",
  "citation",
]);
export type EvalMetricKey = z.infer<typeof EvalMetricKeySchema>;

/**
 * §6 弹窗「每题重复 1 次」；§19.1「每题重复：1-5 整数」；§14「取均值」(默认 1)。
 */
export const CreateEvalRunRequestSchema = z.object({
  setId: uuid,
  applicationId: uuid,
  configVersionId: uuid,
  judgeModelId: uuid,
  embeddingModelId: uuid,
  /** true = 跳过 1h 幂等复用检查（用户点「仍重新运行」）。 */
  force: z.boolean().default(false),
  /** §19.1：1-5 整数，默认 1；每题跑 N 次取非空均值（F5）。 */
  repeatCount: z.number().int().min(1).max(5).default(1),
});
export type CreateEvalRunRequest = z.infer<typeof CreateEvalRunRequestSchema>;

export const EvalRunListItemSchema = z.object({
  id: uuid,
  setId: uuid,
  setName: z.string(),
  applicationId: uuid,
  configVersionId: uuid,
  configVersionLabel: z.string(),
  status: EvalRunStatusSchema,
  overallScore: overallScoreValue.nullable(),
  totalCases: z.number().int().nonnegative(),
  doneCases: z.number().int().nonnegative(),
  /** §14/F5：每题重复次数（1-5）。前端进度分母 = totalCases × repeatCount。 */
  repeatCount: z.number().int().min(1).max(5),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: isoString,
});
export type EvalRunListItem = z.infer<typeof EvalRunListItemSchema>;

export const EvalRunListResponseSchema = z.array(EvalRunListItemSchema);
export type EvalRunListResponse = z.infer<typeof EvalRunListResponseSchema>;

/** 每个指标带覆盖率：avg 只按非 NULL 样本算，scoredCount/total 显性表达「未评」占比。 */
const metricAggregate = z.object({
  value: score.nullable(),
  scoredCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const EvalRunScorecardSchema = z.object({
  /**
   * 检索层四指标（F2）。contextPrecision 是 LLM 判分；contextRecall/ndcg5/hitRate5 是
   * gold-docs 排序真值指标（确定性，非 LLM）——均不进 verdict/综合分。`goldCoverage`
   * 按**本 run 快照**用例的 goldDocRefs 非空数算（原型 §7「gold 38/50」旁标）。
   */
  retrieval: z.object({
    contextPrecision: metricAggregate,
    contextRecall: metricAggregate,
    ndcg5: metricAggregate,
    hitRate5: metricAggregate,
    goldCoverage: z.object({
      withGold: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  }),
  /** 生成层四项（citation F4：仅记分卡 + evidence，不进 verdict/综合分）。 */
  generation: z.object({
    faithfulness: metricAggregate,
    answerRelevancy: metricAggregate,
    correctness: metricAggregate,
    citation: metricAggregate,
  }),
  passCount: z.number().int().nonnegative(),
  weakCount: z.number().int().nonnegative(),
  lowCount: z.number().int().nonnegative(),
  /** 超时/未评：不进 pass/weak/low 分母，但必须显性可见（018 已知取舍 2 的代价缓解）。 */
  timeoutCount: z.number().int().nonnegative(),
  unscoredCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
});
export type EvalRunScorecard = z.infer<typeof EvalRunScorecardSchema>;

/** 单次重复的完整明细（F5）。repeatCount=1 时顶层字段 == repeats[0] 明细。 */
export const EvalRunRepeatSchema = z.object({
  repeatIndex: z.number().int().min(1).max(5),
  faithfulness: score.nullable(),
  answerRelevancy: score.nullable(),
  contextPrecision: score.nullable(),
  correctness: score.nullable(),
  citation: score.nullable(),
  contextRecall: score.nullable(),
  ndcg5: score.nullable(),
  hitRate5: score.nullable(),
  verdict: EvalVerdictSchema,
  previewTraceId: z.string().nullable(),
  answer: z.string(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
  evidence: z.partialRecord(EvalMetricKeySchema, z.array(z.string())),
});
export type EvalRunRepeat = z.infer<typeof EvalRunRepeatSchema>;

export const EvalRunResultSchema = z.object({
  seq: z.number().int().positive(),
  caseId: uuid,
  caseVersion: z.number().int().positive(),
  question: z.string(),
  /** NULL = 未评（裁判失败/无 gold/超时）——绝不写 0（原型 §6）。顶层为**聚合值**（F5：非空均值）。 */
  faithfulness: score.nullable(),
  answerRelevancy: score.nullable(),
  contextPrecision: score.nullable(),
  correctness: score.nullable(),
  /** F4：Citation（仅记分卡/evidence，不进 verdict/综合分）。 */
  citation: score.nullable(),
  /** F2：检索层 gold-docs 指标（确定性排序真值，不进 verdict/综合分）。 */
  contextRecall: score.nullable(),
  ndcg5: score.nullable(),
  hitRate5: score.nullable(),
  minMetric: EvalMetricKeySchema.nullable(),
  minScore: score.nullable(),
  verdict: EvalVerdictSchema,
  /**
   * partialRecord（非 record）：evidence 只收**评出来的**指标——未评指标没有 evidence 键。
   * Zod 4 的 z.record(enum, v) 是穷尽式的（`{}` 解析失败），与「单指标失败记 NULL」语义冲突。
   */
  evidence: z.partialRecord(EvalMetricKeySchema, z.array(z.string())),
  /** 「trace」链接目标；编排失败时为空。 */
  previewTraceId: z.string().nullable(),
  answer: z.string(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
  /** F5：每题重复次数与逐次明细（repeatCount=1 时 repeats 长度 1）。 */
  repeatCount: z.number().int().min(1).max(5),
  repeats: z.array(EvalRunRepeatSchema),
  /**
   * B2b 屏3「标记忽略」：非空即已忽略（原型 `:322` 行尾快捷操作）。
   * **叠加标志**——分数与 verdict 一概保留，只影响列表默认筛选；记分卡/综合分不看它。
   */
  ignoredAt: z.string().nullable(),
});
export type EvalRunResult = z.infer<typeof EvalRunResultSchema>;

/** 未跑到的用例（stop/budget_stop 后剩余）——由 snapshot 减结果行推导，不写结果行。 */
export const EvalRunSkippedCaseSchema = z.object({
  seq: z.number().int().positive(),
  caseId: uuid,
  caseVersion: z.number().int().positive(),
  question: z.string(),
});
export type EvalRunSkippedCase = z.infer<typeof EvalRunSkippedCaseSchema>;

export const EvalRunReportSchema = z.object({
  run: EvalRunListItemSchema.extend({
    judgeModelId: uuid,
    offlineJudgeVersion: z.string(),
    tokenBudget: z.number().int().positive(),
    /** 决策 G：已知上报之和；provider 不回传 usage 时该项计 0 → 熔断偏松，不假装精确。 */
    tokensUsed: z.number().int().nonnegative(),
    startedAt: isoString.nullable(),
    finishedAt: isoString.nullable(),
    error: z.string().nullable(),
  }),
  scorecard: EvalRunScorecardSchema,
  results: z.array(EvalRunResultSchema),
  skipped: z.array(EvalRunSkippedCaseSchema),
});
export type EvalRunReport = z.infer<typeof EvalRunReportSchema>;

/** 1h 幂等：命中已有完成 run 时 409 body（前端弹「查看 / 仍重新运行」）。 */
export const RecentEvalRunConflictSchema = z.object({
  code: z.literal("recent_run_exists"),
  recentRunId: uuid,
});
export type RecentEvalRunConflict = z.infer<typeof RecentEvalRunConflictSchema>;

// —— F7 重放 replay ——

/** `POST /eval/replay` 请求体。question 1-500 trim；sourceTraceId 32-hex（用于限频键）。 */
export const ReplayRequestSchema = z.object({
  applicationId: uuid,
  configVersionId: uuid,
  question: z.string().trim().min(1).max(500),
  sourceTraceId: z.string().regex(/^[a-f0-9]{32}$/i),
});
export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;

/**
 * 重放即时判分帧（**不进 `ChatStreamEventSchema`**——C 端契约零改动）。分数只走 SSE、
 * 不落任何存储、不发任何 span（不变量 1）。裁判未配置/判分失败 → 不发该帧（前端显示「未评」）。
 */
export const ReplayScoresEventSchema = z.object({
  type: z.literal("replay_scores"),
  faithfulness: score.nullable(),
  answerRelevancy: score.nullable(),
  contextPrecision: score.nullable(),
  evidence: z.partialRecord(EvalMetricKeySchema, z.array(z.string())),
});
export type ReplayScoresEvent = z.infer<typeof ReplayScoresEventSchema>;

/** 重放流的帧类型：C 端 ChatStreamEvent + 重放专用 replay_scores。 */
export type ReplayStreamEvent = ChatStreamEvent | ReplayScoresEvent;
