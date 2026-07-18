/** 离线 run 引擎常量（018 §11 + 原型 §6/§18.A）。 */

// 单用例编排超时**不在本文件**——它是 env 可覆盖的配置项，见
// `platform/config/config.schema.ts` 的 `EVAL_RUN_CASE_TIMEOUT_MS`
// （默认 120s，刻意偏离原型 §6 的 30s；理由与实测见那里 + 018 §12 缺口 16）。
// worker 经 `AppConfigService.evalRunCaseTimeoutMs` 读取，勿在此重建一份常量。

/** run 租约 TTL：worker 崩溃后 5 分钟内不会被另一个 worker 抢跑同一条 run。 */
export const EVAL_RUN_LEASE_MS = 5 * 60_000;

/**
 * 回收僵尸 run 前的宽限期。
 *
 * **不变式：`EVAL_RUN_REAP_GRACE_MS + EVAL_RUN_LEASE_MS > pg-boss 的 expire_seconds`**
 * （v12 默认 900s=15min）。改动这两个常量中的任何一个都要重新验算此式，否则回收会和
 * 重试抢跑、静默架空 `retryLimit: 3`。当前 15min + 5min = 20min > 15min ✓。
 *
 * 两条路径的余量各自成立：
 *  · **进程被杀**：租约留在 acquire+TTL，回收还要再等 GRACE → 共 20min > 15min ✓
 *  · **未捕获异常**：`releaseLease` 留下 `lease_until = now`，pg-boss 以 retry_delay=0
 *    立刻重试 → 重试比回收早整整一个 GRACE ✓
 *
 * **两条回收臂现在同源于 `deadline`**（queued 臂的锚点曾是 `now`，见 018 §12 缺口 15(c)）。
 * 此前 queued 臂对「worker 被 SIGKILL」这条路径不成立：租约在 acquire+TTL(5min) 过期，
 * 回收器立刻可动手，而 pg-boss 要到 acquire+15min 才重投 ⇒ 回收早赢 10 分钟，
 * `retryLimit: 3` 被静默架空。改锚点后最早回收时刻是 acquire+TTL+GRACE = 20min > 15min ✓
 *
 * 为什么要大于 job 过期时间：
 *
 * 未捕获异常时 worker 的 `finally` 会 `releaseLease`，pg-boss 随即重试（默认
 * `retry_delay = 0`，几乎立刻）。若回收器在这个窗口里把 run 判成 `failed`，重试上来
 * 只会看到 `already_finished` 而空转 —— **等于把 `retryLimit: 3` 架空**（原型 §18.A
 * 明写要重试 3 次才 failed）。宽限期取 15 分钟保证重试**永远先于**回收。
 *
 * 代价：真·僵尸 run 会多占用全局串行位约 15 分钟。相对于「一次崩溃永久锁死整个功能」
 * 这是划算的；且这段时间里发起评测收到的是诚实的 409（有 run 在跑），不是错误结果。
 */
export const EVAL_RUN_REAP_GRACE_MS = 15 * 60_000;

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
