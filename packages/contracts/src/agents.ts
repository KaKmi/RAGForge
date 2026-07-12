import { z } from "zod";
// M7b S8：FreedomSchema 迁至 node-contract（叶子共享），agents 内部消费但不再自己定义/导出——
// 切断 applications → agents 的反向契约依赖（agents 是待下线旧域）。
import { FreedomSchema } from "./node-contract";

export const AgentStatusSchema = z.enum(["draft", "active", "archived"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentConfigVersionStatusSchema = z.enum(["draft", "published", "archived"]);
export type AgentConfigVersionStatus = z.infer<typeof AgentConfigVersionStatusSchema>;

// M7 阶段不产生 failed/running（Eval 是硬编码 stub，008 决策 2）；M11 接入真实评测后扩展
export const EvalStatusSchema = z.enum(["not_run", "passed", "exempt"]);
export type EvalStatus = z.infer<typeof EvalStatusSchema>;

export const NodeConfigSchema = z.object({
  freedom: FreedomSchema,
  temperatureEnabled: z.boolean(),
  temperature: z.number().min(0).max(1),
  topPEnabled: z.boolean(),
  topP: z.number().min(0).max(1),
});
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

export const NodeParamsSchema = z.object({
  rewrite: NodeConfigSchema,
  intent: NodeConfigSchema,
  reply: NodeConfigSchema,
  fallback: NodeConfigSchema,
});
export type NodeParams = z.infer<typeof NodeParamsSchema>;

// 版本化配置字段：新建 Agent 的 v1 与「新建配置版本」共用同一形状（008 数据模型）
export const AgentConfigFieldsSchema = z.object({
  kbIds: z.array(z.string().min(1)).min(1),
  genModelId: z.string().min(1),
  lightModelId: z.string().min(1).optional(),
  rerankModelId: z.string().min(1).optional(),
  promptRewriteVerId: z.string().min(1),
  promptIntentVerId: z.string().min(1),
  promptReplyVerId: z.string().min(1),
  promptFallbackVerId: z.string().min(1),
  nodeParams: NodeParamsSchema,
  topK: z.number().int().positive(),
  topN: z.number().int().positive(),
  threshold: z.number().min(0).max(1),
  multiRecall: z.boolean(),
  vecWeight: z.number().min(0).max(1).optional(),
  fallbackHuman: z.boolean(),
});
export type AgentConfigFields = z.infer<typeof AgentConfigFieldsSchema>;

export const AgentConfigVersionSchema = AgentConfigFieldsSchema.extend({
  id: z.string().min(1),
  agentId: z.string().min(1),
  version: z.number().int().positive(),
  status: AgentConfigVersionStatusSchema,
  evalStatus: EvalStatusSchema,
  evalRunAt: z.string().datetime().nullable(),
  // M7 恒 null（stub 不编造数字，008 Trade-offs）；M11 写真实值
  evalPassRate: z.number().min(0).max(1).nullable(),
  note: z.string().optional(),
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
  publishedBy: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
});
export type AgentConfigVersion = z.infer<typeof AgentConfigVersionSchema>;

// Agent 身份 + 派生 status + 当前生产版本展开（列表/详情/检索测试「从 Agent 加载」复用同一形状）
export const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  desc: z.string(),
  enabled: z.boolean(),
  status: AgentStatusSchema,
  currentVersion: AgentConfigVersionSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentListResponseSchema = z.array(AgentSchema);
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

export const CreateAgentRequestSchema = AgentConfigFieldsSchema.extend({
  name: z.string().min(1),
  desc: z.string().default(""),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

// 编辑收窄：仅 name/desc/enabled；strictObject 拒绝其他键（008 决策 3）。
// service 层的显式检查作为纵深防御（对齐 UpdateKnowledgeBaseRequestSchema 模式）。
export const UpdateAgentRequestSchema = z.strictObject({
  name: z.string().min(1).optional(),
  desc: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const CreateAgentConfigVersionRequestSchema = AgentConfigFieldsSchema.extend({
  note: z.string().optional(),
});
export type CreateAgentConfigVersionRequest = z.infer<
  typeof CreateAgentConfigVersionRequestSchema
>;

export const AgentConfigVersionListResponseSchema = z.array(AgentConfigVersionSchema);
export type AgentConfigVersionListResponse = z.infer<
  typeof AgentConfigVersionListResponseSchema
>;
