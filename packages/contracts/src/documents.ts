import { z } from "zod";

export const DocumentStatusSchema = z.enum(["upload", "ingest", "ready", "failed"]);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentTypeSchema = z.enum(["pdf", "word", "markdown", "text"]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const DocumentSchema = z.object({
  id: z.string().min(1),
  kbId: z.string().min(1),
  name: z.string().min(1),
  type: DocumentTypeSchema,
  size: z.number().int().nonnegative(),
  chunksCount: z.number().int().nonnegative(),
  status: DocumentStatusSchema,
  stage: z.string().optional(),
  error: z.string().nullable().optional(),
  blobKey: z.string().optional(),
  updatedAt: z.string().datetime(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const DocumentListResponseSchema = z.array(DocumentSchema);
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

export const CreateDocumentRequestSchema = DocumentSchema.omit({
  id: true,
  chunksCount: true,
  status: true,
  stage: true,
  error: true,
  updatedAt: true,
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;

export const IngestionStatusSchema = z.object({
  documentId: z.string().min(1),
  status: z.enum(["idle", "processing", "done", "failed"]),
  progress: z.number().min(0).max(100),
  stage: z.string(),
  error: z.string().nullable().optional(),
});
export type IngestionStatus = z.infer<typeof IngestionStatusSchema>;
