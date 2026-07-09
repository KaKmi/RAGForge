import { z } from "zod";

export const DocumentStatusSchema = z.enum(["pending", "queued", "processing", "failed", "ready"]);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentTypeSchema = z.enum(["pdf", "word", "markdown", "text"]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const DocumentLifecycleStageSchema = z.object({
  stage: z.enum(["upload", "ingest", "ready"]),
  status: z.enum(["pending", "running", "done", "failed"]),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  error: z.string().nullable().optional(),
});
export type DocumentLifecycleStage = z.infer<typeof DocumentLifecycleStageSchema>;

export const DocumentSchema = z.object({
  id: z.string().min(1),
  kbId: z.string().min(1),
  name: z.string().min(1),
  type: DocumentTypeSchema,
  size: z.number().int().nonnegative(),
  chunksCount: z.number().int().nonnegative(),
  chunkVersion: z.number().int().positive().nullable(),
  status: DocumentStatusSchema,
  metadata: z.record(z.string(), z.string()).default({}),
  error: z.string().nullable().optional(),
  uploadedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const DocumentListResponseSchema = z.array(DocumentSchema);
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

export const DocumentLifecycleResponseSchema = z.object({
  documentId: z.string().min(1),
  stages: z.array(DocumentLifecycleStageSchema),
});
export type DocumentLifecycleResponse = z.infer<typeof DocumentLifecycleResponseSchema>;

export const UpdateDocumentMetadataRequestSchema = z.object({
  metadata: z.record(z.string(), z.string()),
});
export type UpdateDocumentMetadataRequest = z.infer<typeof UpdateDocumentMetadataRequestSchema>;

export const DocumentContentResponseSchema = z.object({
  documentId: z.string().min(1),
  text: z.string(),
});
export type DocumentContentResponse = z.infer<typeof DocumentContentResponseSchema>;

// multipart 上传响应：受理即返回已创建的文档行（201），autoParse=false 时 status=pending
export const UploadDocumentsResponseSchema = z.array(DocumentSchema);
export type UploadDocumentsResponse = z.infer<typeof UploadDocumentsResponseSchema>;
