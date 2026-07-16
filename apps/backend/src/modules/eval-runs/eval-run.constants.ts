/** 离线 run 引擎常量（018 §11 + 原型 §6/§18.A）。 */

/**
 * 单用例编排超时（原型 §6「单用例编排超时 30s(同线上熔断)」）。
 *
 * ⚠️ 这是**判定阈值**，不是墙钟上限（018 已知缺口 9，peer review 实测）：
 * `runForEvaluation` 的 `timeoutMs` 只决定何时判 `timedOut=true`，实际返回时刻由在途
 * `next()` 自行结束决定（异步生成器 `return()` 无法抢占执行中的 `next()`）。
 * 勿据此常量假设一条用例最多耗时 30s —— 真正的硬中断要等 W2b 把 AbortSignal
 * plumb 进 `ModelProviderPort`。
 */
export const EVAL_RUN_CASE_TIMEOUT_MS = 30_000;

/** run 租约 TTL：worker 崩溃后 5 分钟内不会被另一个 worker 抢跑同一条 run。 */
export const EVAL_RUN_LEASE_MS = 5 * 60_000;

/** 幂等窗口（原型 §6「同评测集×同配置版本存在 1 小时内的完成 run → 提示复用」）。 */
export const EVAL_RUN_IDEMPOTENCY_MS = 60 * 60_000;

/** Judge 输入的上下文条数上限——与在线口径对齐（`evaluation-input.service.ts:17` MAX_CONTEXTS=20）。 */
export const EVAL_RUN_MAX_CONTEXTS = 20;

/**
 * 原型 §18.A「job 异常(重试 3 次仍败) → failed」。
 * **不可照抄 E-W1 的 `retryLimit: 1`**（`evaluation-worker.processor.ts:95`）——那是周期性
 * 抽样任务（下个 15 分钟窗口自然重来），run 是一次性事件，重试次数是产品规定。
 */
export const EVAL_RUN_JOB_RETRY_LIMIT = 3;

/**
 * 参与用例判定的三个 reference-free 基础指标（复用 E-W1）。
 * **三者全 NULL（裁判全挂）→ `verdict = unscored`**，不进 pass/weak/low 分母（018 §11）。
 */
export const EVAL_RUN_BASE_METRIC_KEYS = [
  "faithfulness",
  "answerRelevancy",
  "contextPrecision",
] as const;

/** 全部四个指标（基础三项 + gold 对照 Correctness）——记分卡与 argmin 的遍历序。 */
export const EVAL_RUN_METRIC_KEYS = [...EVAL_RUN_BASE_METRIC_KEYS, "correctness"] as const;

/** 原型 §7 判定档位：`<60` low、`60-79` weak、`≥80` pass。 */
export const EVAL_RUN_LOW_THRESHOLD = 60;
export const EVAL_RUN_PASS_THRESHOLD = 80;
