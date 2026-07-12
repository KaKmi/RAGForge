export const INGESTION_QUEUE = Symbol("INGESTION_QUEUE");
// M7b：应用发布 ReleaseCheck 异步预演队列（与 ingestion 分开的第二个泛型 Queue 端口）
export const RELEASE_CHECK_QUEUE = Symbol("RELEASE_CHECK_QUEUE");
export const RELEASE_CHECK_JOB = "application.release_check";
