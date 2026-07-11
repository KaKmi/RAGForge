export const INGEST_DOCUMENT_JOB = "ingest-document";

export interface IngestDocumentJobData {
  documentId: string;
  targetVersion: number;
  // M4.1 新路径填写：processor 见此字段 → processRun（快照唯一行为源）；
  // 旧镜像 worker 无此字段亦可消费（超集 payload，双向回滚兼容，diff #1）。
  processingRunId?: string;
}
