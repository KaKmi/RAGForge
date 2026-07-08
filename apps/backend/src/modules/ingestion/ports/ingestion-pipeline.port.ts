import type { ChunkTemplate, DocumentType } from "@codecrush/contracts";

export interface IngestionContext {
  documentId: string;
  kbId: string;
  docType: DocumentType;
  chunkTemplate: ChunkTemplate;
  embeddingModelId: string;
  targetVersion: number;
  blob: Buffer;
}

export interface IngestionResult {
  chunkCount: number;
  parsedText: string;
}

export interface IngestionPipelinePort {
  run(ctx: IngestionContext): Promise<IngestionResult>;
}
