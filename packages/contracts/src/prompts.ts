import { z } from "zod";
import { CompileIssueSchema, CompileStatusSchema, PromptNodeSchema } from "./node-contract";

// 012 重构：版本平权（无 status 三态、无 currentVersion 指针）+ 排他标签。
// Prompt 列表行的 tags/variables 均取自最新版本（列表「标识」「变量」列语义，012 §1）。

// PromptNodeSchema/PromptNode 由 node-contract.ts 经 barrel 导出（此处不再 re-export，
// 避免 export * 撞名被 TS 静默省略）。

// 标签名：仅字母/数字/./_/-，服务边界统一小写（大小写不敏感排他由 DB lower(name) 唯一索引兜底）。
// 保留字 v / production 的「禁止自定义创建」是前端自定义入口的校验（012 §3）；
// 后端通用写路径不拒绝 production——移动 production 走同一 PUT（drill Story 3 决议）。
export const PromptTagNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "标签名仅允许字母、数字、.、_、-")
  .transform((s) => s.toLowerCase());

export const PromptVersionSchema = z.object({
  id: z.string().min(1),
  promptId: z.string().min(1),
  version: z.number().int().positive(),
  // 012：允许空 body（新建 Prompt 自动生成空 v1；错误也允许保存）
  body: z.string(),
  variables: z.array(z.string()),
  note: z.string().optional(),
  author: z.string().min(1),
  contractVersion: z.number().int().positive(),
  compileStatus: CompileStatusSchema,
  compileErrors: z.array(CompileIssueSchema),
  tags: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

export const PromptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  node: PromptNodeSchema,
  /** 最新版本号（v1 随建随生，恒 ≥1） */
  latestVersion: z.number().int().positive(),
  versionCount: z.number().int().positive(),
  /** 最新版本携带的标签 */
  tags: z.array(z.string()),
  /** 最新版本的变量 */
  variables: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1),
});
export type Prompt = z.infer<typeof PromptSchema>;

// 详情 = 摘要 + 全部历史版本（降序，供历史抽屉一次拿全）
export const PromptDetailSchema = PromptSchema.extend({
  versions: z.array(PromptVersionSchema),
});
export type PromptDetail = z.infer<typeof PromptDetailSchema>;

export const PromptVersionListResponseSchema = z.array(PromptVersionSchema);
export type PromptVersionListResponse = z.infer<typeof PromptVersionListResponseSchema>;

export const PromptListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z
    .string()
    .optional()
    .transform((s) => (s && s.trim() ? s.trim() : undefined)),
  node: PromptNodeSchema.optional(),
});
export type PromptListQuery = z.infer<typeof PromptListQuerySchema>;

export const PromptListResponseSchema = z.object({
  items: z.array(PromptSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type PromptListResponse = z.infer<typeof PromptListResponseSchema>;

// 012：新建只填 name + node，事务内自动创建空 body 的 v1（无标签），返回详情供跳转
export const CreatePromptRequestSchema = z.object({
  name: z.string().min(1),
  node: PromptNodeSchema,
});
export type CreatePromptRequest = z.infer<typeof CreatePromptRequestSchema>;

// 保存新版本：body 允许空、错误允许保存（服务端重新编译并持久化结果）。
// sourceVersionId 仅用于「创建副本」沿用来源版本的 contractVersion，必须属于同一 Prompt。
export const CreatePromptVersionRequestSchema = z.object({
  body: z.string(),
  note: z.string().optional(),
  sourceVersionId: z.string().min(1).optional(),
});
export type CreatePromptVersionRequest = z.infer<typeof CreatePromptVersionRequestSchema>;

// 标签排他移动（PUT /api/prompts/:id/tags）：name 归一小写后 upsert 到 versionId
export const MovePromptTagRequestSchema = z.object({
  name: PromptTagNameSchema,
  versionId: z.string().min(1),
});
export type MovePromptTagRequest = z.infer<typeof MovePromptTagRequestSchema>;

export const PromptTagSchema = z.object({
  name: z.string().min(1),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
});
export type PromptTag = z.infer<typeof PromptTagSchema>;

export const PromptTagListResponseSchema = z.array(PromptTagSchema);
export type PromptTagListResponse = z.infer<typeof PromptTagListResponseSchema>;

// 节点全版本候选（GET /api/prompts/versions?node=）：应用/旧 Agent 表单选择任意具体版本，
// 不再按「已发布」过滤（012 版本平权）；标签仅作排序/高亮信号
export const PromptNodeVersionsQuerySchema = z.object({
  node: PromptNodeSchema,
});
export type PromptNodeVersionsQuery = z.infer<typeof PromptNodeVersionsQuerySchema>;

export const PromptNodeVersionCandidateSchema = z.object({
  promptId: z.string().min(1),
  promptName: z.string().min(1),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
  tags: z.array(z.string()),
  compileStatus: CompileStatusSchema,
  createdAt: z.string().datetime(),
});
export type PromptNodeVersionCandidate = z.infer<typeof PromptNodeVersionCandidateSchema>;

export const PromptNodeVersionListResponseSchema = z.array(PromptNodeVersionCandidateSchema);
export type PromptNodeVersionListResponse = z.infer<typeof PromptNodeVersionListResponseSchema>;
