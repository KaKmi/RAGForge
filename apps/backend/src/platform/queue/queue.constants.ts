import type { ProcessRole } from "../config/process-role";

export const INGESTION_QUEUE = Symbol("INGESTION_QUEUE");
// M7b：应用发布 ReleaseCheck 异步预演队列（与 ingestion 分开的第二个泛型 Queue 端口）
export const RELEASE_CHECK_QUEUE = Symbol("RELEASE_CHECK_QUEUE");
export const RELEASE_CHECK_JOB = "application.release_check";
export const EVALUATION_QUEUE = Symbol("EVALUATION_QUEUE");
export const ONLINE_EVALUATION_JOB = "online-quality-evaluation";
export const ONLINE_EVALUATION_WORKER = "online-quality-v1";
// E-W2a：离线评测 run（事件驱动，非周期任务 → 只 subscribe 不 schedule）
// B1/F3：人工「立即评测」。**刻意不复用 EVALUATION_QUEUE**——那个 token 登记的是 worker 角色，
// 而 RoleGatedQueueAdapter.subscribe 在角色不匹配时静默 no-op，只起 api 的部署里任务会永远
// 无人消费：前端一直「评分中」直到轮询超时报「裁判调用失败」，一个查不出来的假错误。
// 与 releaseCheck 同形（POST 201 + 异步 + GET 轮询），故同样登记 api 角色。
export const MANUAL_SCORE_QUEUE = Symbol("MANUAL_SCORE_QUEUE");
export const MANUAL_SCORE_JOB = "manual-trace-score";
export const EVAL_RUN_QUEUE = Symbol("EVAL_RUN_QUEUE");
export const EVAL_RUN_JOB = "offline-eval-run";
export const EVAL_RUN_WORKER = "offline-run-worker";

/**
 * 019 Boundary 1：token → 消费角色 的唯一登记处（QueueModule 工厂据此包 RoleGatedQueueAdapter）。
 * all 恒消费一切。粒度是 token 不是 job：若日后在既有 token 上挂第二个 job，它继承该 token
 * 的消费角色——新消费者域一律开新 token（现状 1 token = 1 job = 1 消费者域）。
 */
export const QUEUE_CONSUMER_ROLES = {
  ingestion: ["api", "all"],
  releaseCheck: ["api", "all"],
  evaluation: ["worker", "all"],
  manualScore: ["api", "all"],
  evalRun: ["worker", "all"],
} as const satisfies Record<string, readonly ProcessRole[]>;
