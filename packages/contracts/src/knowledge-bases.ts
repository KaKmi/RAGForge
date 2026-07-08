import { z } from "zod";

export const ChunkTemplateSchema = z.enum(["general", "qa"]);
export type ChunkTemplate = z.infer<typeof ChunkTemplateSchema>;

export const KnowledgeBaseStatusSchema = z.enum(["ready", "building", "failed"]);
export type KnowledgeBaseStatus = z.infer<typeof KnowledgeBaseStatusSchema>;

export const KnowledgeBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  desc: z.string(),
  chunkTemplate: ChunkTemplateSchema,
  embeddingModelId: z.string().min(1),
  docsCount: z.number().int().nonnegative(),
  chunksCount: z.number().int().nonnegative(),
  status: KnowledgeBaseStatusSchema,
  activeVersion: z.number().int().positive(),
  buildingVersion: z.number().int().positive().nullable(),
  progress: z.number().min(0).max(100).optional(),
  updatedAt: z.string().datetime(),
});
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

export const KnowledgeBaseListResponseSchema = z.array(KnowledgeBaseSchema);
export type KnowledgeBaseListResponse = z.infer<typeof KnowledgeBaseListResponseSchema>;

export const CreateKnowledgeBaseRequestSchema = z.object({
  name: z.string().min(1),
  desc: z.string().default(""),
  chunkTemplate: ChunkTemplateSchema,
  embeddingModelId: z.string().min(1),
});
export type CreateKnowledgeBaseRequest = z.infer<typeof CreateKnowledgeBaseRequestSchema>;

// embeddingModelId 故意不在此契约出现：锁定规则在 service 层强制（传了也会被拒绝，见 007/spec）
export const UpdateKnowledgeBaseRequestSchema = z.object({
  name: z.string().min(1).optional(),
  desc: z.string().optional(),
  chunkTemplate: ChunkTemplateSchema.optional(),
});
export type UpdateKnowledgeBaseRequest = z.infer<typeof UpdateKnowledgeBaseRequestSchema>;
