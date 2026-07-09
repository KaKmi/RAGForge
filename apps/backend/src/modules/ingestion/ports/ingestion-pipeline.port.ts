import type { ChunkTemplate, DocumentType } from "@codecrush/contracts";

export interface IngestionContext {
  documentId: string;
  kbId: string;
  docType: DocumentType;
  chunkTemplate: ChunkTemplate;
  embeddingModelId: string;
  targetVersion: number;
  blob: Buffer;
  // 分块器上下文（CustomChunker 消费：从文件名解析课程元信息、用知识库名称拼上下文头）。
  docName: string;
  kbName: string;
}

export interface IngestionResult {
  chunkCount: number;
  parsedText: string;
}

export interface IngestionPipelinePort {
  run(ctx: IngestionContext): Promise<IngestionResult>;
}
