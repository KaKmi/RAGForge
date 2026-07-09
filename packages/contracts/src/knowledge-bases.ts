import { z } from "zod";

export const ChunkTemplateSchema = z.enum(["general", "qa", "custom"]);
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

// embeddingModelId 故意不在此契约出现：锁定规则见 007/spec（PATCH 携带 → 显式 400，而非静默丢弃）。
// strictObject：契约层直接拒绝未知键（HTTP 经全局 ZodValidationPipe 映射 400）；
// service 层的显式 400 检查保留作为纵深防御（非 HTTP 调用路径同样拒绝）。
export const UpdateKnowledgeBaseRequestSchema = z.strictObject({
  name: z.string().min(1).optional(),
  desc: z.string().optional(),
  chunkTemplate: ChunkTemplateSchema.optional(),
});
export type UpdateKnowledgeBaseRequest = z.infer<typeof UpdateKnowledgeBaseRequestSchema>;
