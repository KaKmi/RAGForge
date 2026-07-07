import { z } from "zod";

export const PromptNodeSchema = z.enum(["rewrite", "intent", "reply", "fallback"]);
export type PromptNode = z.infer<typeof PromptNodeSchema>;

export const PromptVersionStatusSchema = z.enum(["draft", "prod", "archived"]);
export type PromptVersionStatus = z.infer<typeof PromptVersionStatusSchema>;

// M6: currentVersionId 改 nullable（未发布时为 null）；读侧补 updatedAt/updatedBy（发布/回滚时刷新）
// M6 fix: 加 currentVersionNumber + versionCount（后端 list join，前端列表一次拿全，避免 N+1）
export const PromptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  node: PromptNodeSchema,
  currentVersionId: z.string().min(1).nullable(),
  currentVersionNumber: z.number().int().positive().nullable(),
  versionCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1),
});
export type Prompt = z.infer<typeof PromptSchema>;

// M6: body 改 min(1)（空 prompt 无意义）；author 改必填（来自 JWT，不再 optional）；补 createdAt
export const PromptVersionSchema = z.object({
  id: z.string().min(1),
  promptId: z.string().min(1),
  version: z.number().int().positive(),
  body: z.string().min(1),
  variables: z.array(z.string()),
  note: z.string().optional(),
  author: z.string().min(1),
  status: PromptVersionStatusSchema,
  createdAt: z.string().datetime(),
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

export const PromptVersionListResponseSchema = z.array(PromptVersionSchema);
export type PromptVersionListResponse = z.infer<typeof PromptVersionListResponseSchema>;

// M6: list 端点查询参数（分页 + 条件）。query param 均为 string，经 z.coerce.number() 转 number。
// status 为列表筛选语义（草稿/生产中，按 currentVersionId 是否 null 判断），不同于 PromptVersionStatus。
export const PromptListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z
    .string()
    .optional()
    .transform(s => (s && s.trim() ? s.trim() : undefined)),
  node: PromptNodeSchema.optional(),
  status: z.enum(["prod", "draft"]).optional(),
});
export type PromptListQuery = z.infer<typeof PromptListQuerySchema>;

// M6: list 响应改分页结构 { items, total, page, pageSize }（前端受控分页，后端真分页+条件查询）
export const PromptListResponseSchema = z.object({
  items: z.array(PromptSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type PromptListResponse = z.infer<typeof PromptListResponseSchema>;

// M6: 建 Prompt（自动起 v1 draft）。body 用于首版本，note 可选
export const CreatePromptRequestSchema = z.object({
  name: z.string().min(1),
  node: PromptNodeSchema,
  body: z.string().min(1),
  note: z.string().optional(),
});
export type CreatePromptRequest = z.infer<typeof CreatePromptRequestSchema>;

// M6: 出新版本。variables 由后端 extractVars 计算、author 来自 JWT，故 DTO 仅 { body, note? }
export const CreatePromptVersionRequestSchema = z.object({
  body: z.string().min(1),
  note: z.string().optional(),
});
export type CreatePromptVersionRequest = z.infer<typeof CreatePromptVersionRequestSchema>;

// M6: 发布/回滚响应（draft→prod / archived→prod）
export const PublishPromptVersionResponseSchema = z.object({
  promptId: z.string().min(1),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
  status: PromptVersionStatusSchema,
});
export type PublishPromptVersionResponse = z.infer<typeof PublishPromptVersionResponseSchema>;
