import type { DocumentType } from "@codecrush/contracts";
import type { CanonicalDocument } from "../canonical/canonical-document";
import type { ProcessingProfileSnapshot } from "../profiles/processing-profile";

export interface IngestionContext {
  documentId: string;
  kbId: string;
  docType: DocumentType;
  snapshot: ProcessingProfileSnapshot;
  embeddingModelId: string;
  targetVersion: number;
  processingRunId?: string;
  blob: Buffer;
  // 分块器上下文（CustomChunker 消费：从文件名解析课程元信息、用知识库名称拼上下文头）。
  docName: string;
  kbName: string;
}

export interface IngestionResult {
  chunkCount: number;
  markdown: string;
  /** 旧 worker 迁移窗口别名；与 markdown 始终同值。 */
  parsedText: string;
  canonical: CanonicalDocument;
  parserEngine: string;
  parserVersion: string;
  warnings: string[];
  metrics: Record<string, number>;
}

export interface IngestionPipelinePort {
  run(ctx: IngestionContext): Promise<IngestionResult>;
}
