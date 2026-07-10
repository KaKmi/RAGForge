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
  // 默认文档处理方案（M4.1）；迁移期 nullable（历史行由 chunkTemplate 反查兜底填充）。
  processingProfileId: z.string().nullable(),
  processingProfileVersion: z.number().int().positive().nullable(),
  progress: z.number().min(0).max(100).optional(),
  updatedAt: z.string().datetime(),
});
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

export const KnowledgeBaseListResponseSchema = z.array(KnowledgeBaseSchema);
export type KnowledgeBaseListResponse = z.infer<typeof KnowledgeBaseListResponseSchema>;

// 迁移窗口：旧前端送 chunkTemplate，新前端送 processingProfile*（二者至少其一，成对出现）。
// service 层据 profile 反写 chunkTemplate 双写（010 Rollout 3）。
export const CreateKnowledgeBaseRequestSchema = z
  .object({
    name: z.string().min(1),
    desc: z.string().default(""),
    chunkTemplate: ChunkTemplateSchema.optional(),
    processingProfileId: z.string().min(1).optional(),
    processingProfileVersion: z.number().int().positive().optional(),
    embeddingModelId: z.string().min(1),
  })
  .refine((v) => (v.processingProfileId === undefined) === (v.processingProfileVersion === undefined), {
    message: "processingProfileId 与 processingProfileVersion 必须成对出现",
  })
  .refine((v) => v.chunkTemplate !== undefined || v.processingProfileId !== undefined, {
    message: "chunkTemplate 与 processingProfile 至少提供其一",
  });
export type CreateKnowledgeBaseRequest = z.infer<typeof CreateKnowledgeBaseRequestSchema>;

// embeddingModelId 故意不在此契约出现：锁定规则见 007/spec（PATCH 携带 → 显式 400，而非静默丢弃）。
// strictObject：契约层直接拒绝未知键（HTTP 经全局 ZodValidationPipe 映射 400）；
// service 层的显式 400 检查保留作为纵深防御（非 HTTP 调用路径同样拒绝）。
// chunkTemplate 与 processingProfile 不可同提交（避免歧义，010 §迁移窗口矩阵）。
export const UpdateKnowledgeBaseRequestSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    desc: z.string().optional(),
    chunkTemplate: ChunkTemplateSchema.optional(),
    processingProfileId: z.string().min(1).optional(),
    processingProfileVersion: z.number().int().positive().optional(),
  })
  .refine((v) => (v.processingProfileId === undefined) === (v.processingProfileVersion === undefined), {
    message: "processingProfileId 与 processingProfileVersion 必须成对出现",
  })
  .refine((v) => !(v.chunkTemplate !== undefined && v.processingProfileId !== undefined), {
    message: "chunkTemplate 与 processingProfile 不可同时提交",
  });
export type UpdateKnowledgeBaseRequest = z.infer<typeof UpdateKnowledgeBaseRequestSchema>;
