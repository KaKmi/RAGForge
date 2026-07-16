export const INGESTION_QUEUE = Symbol("INGESTION_QUEUE");
// M7b：应用发布 ReleaseCheck 异步预演队列（与 ingestion 分开的第二个泛型 Queue 端口）
export const RELEASE_CHECK_QUEUE = Symbol("RELEASE_CHECK_QUEUE");
export const RELEASE_CHECK_JOB = "application.release_check";
export const EVALUATION_QUEUE = Symbol("EVALUATION_QUEUE");
export const ONLINE_EVALUATION_JOB = "online-quality-evaluation";
export const ONLINE_EVALUATION_WORKER = "online-quality-v1";
// E-W2a：离线评测 run（事件驱动，非周期任务 → 只 subscribe 不 schedule）
export const EVAL_RUN_QUEUE = Symbol("EVAL_RUN_QUEUE");
export const EVAL_RUN_JOB = "offline-eval-run";
export const EVAL_RUN_WORKER = "offline-run-worker";
