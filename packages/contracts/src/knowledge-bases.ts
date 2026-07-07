import { z } from "zod";

export const KnowledgeBaseStatusSchema = z.enum(["ready", "building", "failed"]);
export type KnowledgeBaseStatus = z.infer<typeof KnowledgeBaseStatusSchema>;

export const KnowledgeBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  desc: z.string(),
  embeddingModelId: z.string().min(1),
  docsCount: z.number().int().nonnegative(),
  chunksCount: z.number().int().nonnegative(),
  status: KnowledgeBaseStatusSchema,
  progress: z.number().min(0).max(100).optional(),
  updatedAt: z.string().datetime(),
});
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

export const KnowledgeBaseListResponseSchema = z.array(KnowledgeBaseSchema);
export type KnowledgeBaseListResponse = z.infer<typeof KnowledgeBaseListResponseSchema>;

export const CreateKnowledgeBaseRequestSchema = KnowledgeBaseSchema.omit({
  id: true,
  docsCount: true,
  chunksCount: true,
  status: true,
  progress: true,
  updatedAt: true,
});
export type CreateKnowledgeBaseRequest = z.infer<typeof CreateKnowledgeBaseRequestSchema>;
