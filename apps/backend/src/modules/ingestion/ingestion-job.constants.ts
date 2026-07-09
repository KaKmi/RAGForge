export const INGEST_DOCUMENT_JOB = "ingest-document";

export interface IngestDocumentJobData {
  documentId: string;
  targetVersion: number;
}
