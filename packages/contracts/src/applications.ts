import { z } from "zod";
// M7b S8：FreedomSchema/PromptNodeSchema 均来自 node-contract 叶子——applications 不再依赖 agents 旧域。
import { FreedomSchema, PromptNodeSchema } from "./node-contract";

export const APPLICATION_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const ApplicationNodeConfigSchema = z.strictObject({
  promptVersionId: z.string().min(1),
  modelId: z.string().min(1),
  freedom: FreedomSchema,
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
});
export type ApplicationNodeConfig = z.infer<typeof ApplicationNodeConfigSchema>;

export const ApplicationRetrievalParamsSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    topK: z.number().int().positive().max(200),
    topN: z.number().int().positive().max(50),
    hybridEnabled: z.boolean(),
    vectorWeight: z.number().min(0).max(1),
    rerankEnabled: z.boolean(),
    rerankModelId: z.string().min(1).optional(),
    rerankThreshold: z.number().min(0).max(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.topN > value.topK) {
      ctx.addIssue({
        code: "custom",
        path: ["topN"],
        message: "最终保留数量不能大于初始召回数量",
      });
    }
    if (value.rerankEnabled && !value.rerankModelId) {
      ctx.addIssue({
        code: "custom",
        path: ["rerankModelId"],
        message: "启用模型精排后，请选择精排模型",
      });
    }
  });
export type ApplicationRetrievalParams = z.infer<typeof ApplicationRetrievalParamsSchema>;

export const ApplicationConfigFieldsSchema = z.strictObject({
  kbIds: z.array(z.string().min(1)).min(1),
  nodes: z.strictObject({
    rewrite: ApplicationNodeConfigSchema,
    intent: ApplicationNodeConfigSchema,
    reply: ApplicationNodeConfigSchema,
    fallback: ApplicationNodeConfigSchema,
  }),
  retrieval: ApplicationRetrievalParamsSchema,
  fallback: z.strictObject({ toHuman: z.boolean() }),
});
export type ApplicationConfigFields = z.infer<typeof ApplicationConfigFieldsSchema>;

export const ApplicationConfigVersionSchema = ApplicationConfigFieldsSchema.extend({
  id: z.string().min(1),
  applicationId: z.string().min(1),
  version: z.number().int().positive(),
  configSchemaVersion: z.literal(1),
  note: z.string().optional(),
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type ApplicationConfigVersion = z.infer<typeof ApplicationConfigVersionSchema>;

export const ApplicationSchema = z.strictObject({
  id: z.string().min(1),
  slug: z.string().regex(APPLICATION_SLUG_RE),
  name: z.string().min(1),
  description: z.string(),
  enabled: z.boolean(),
  productionVersion: z.number().int().positive().nullable(),
  productionConfigVersionId: z.string().min(1).nullable(),
  latestVersion: z.number().int().positive(),
  versionCount: z.number().int().positive(),
  // M7b：该应用携带的自定义命名锚点标签（列表「标识」列；不含 production 保留字）
  tags: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1),
  createdBy: z.string().min(1),
});
export type Application = z.infer<typeof ApplicationSchema>;

export const ApplicationDetailSchema = ApplicationSchema.extend({
  versions: z.array(ApplicationConfigVersionSchema),
});
export type ApplicationDetail = z.infer<typeof ApplicationDetailSchema>;

export const ApplicationListResponseSchema = z.array(ApplicationSchema);
export type ApplicationListResponse = z.infer<typeof ApplicationListResponseSchema>;
export const ApplicationConfigVersionListResponseSchema = z.array(ApplicationConfigVersionSchema);
export type ApplicationConfigVersionListResponse = z.infer<
  typeof ApplicationConfigVersionListResponseSchema
>;

export const CreateApplicationRequestSchema = z.strictObject({
  slug: z.string().regex(APPLICATION_SLUG_RE),
  name: z.string().min(1),
  description: z.string().default(""),
  config: ApplicationConfigFieldsSchema,
});
export type CreateApplicationRequest = z.infer<typeof CreateApplicationRequestSchema>;

export const CreateApplicationConfigVersionRequestSchema = z.strictObject({
  config: ApplicationConfigFieldsSchema,
  note: z.string().optional(),
});
export type CreateApplicationConfigVersionRequest = z.infer<
  typeof CreateApplicationConfigVersionRequestSchema
>;

export const UpdateApplicationRequestSchema = z.strictObject({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateApplicationRequest = z.infer<typeof UpdateApplicationRequestSchema>;

export const PromptUsageQuerySchema = z.strictObject({ promptId: z.string().min(1) });
export type PromptUsageQuery = z.infer<typeof PromptUsageQuerySchema>;
export const PromptUsageEntrySchema = z.strictObject({
  promptVersionId: z.string().min(1),
  promptVersion: z.number().int().positive(),
  applicationId: z.string().min(1),
  applicationName: z.string().min(1),
  node: PromptNodeSchema,
  configVersion: z.number().int().positive(),
});
export type PromptUsageEntry = z.infer<typeof PromptUsageEntrySchema>;
export const PromptUsageResponseSchema = z.array(PromptUsageEntrySchema);
export type PromptUsageResponse = z.infer<typeof PromptUsageResponseSchema>;

export const ApplicationChatResultSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("unavailable"),
    reason: z.literal("pending_orchestration"),
  }),
]);
export type ApplicationChatResult = z.infer<typeof ApplicationChatResultSchema>;

// —— M7b 版本命名标签（自定义访问锚点，混合模型 B+：production 不入此表）——
// 复制 PromptTagNameSchema（prompts.ts）正则 + lowercase 归一，但**关键分叉**：应用侧
// 后端强制拒绝保留字 production（走受门禁 PUT /production）与 v（版本号前缀混淆）。
export const APPLICATION_TAG_RESERVED = ["production", "v"] as const;
export const ApplicationTagNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "标签名仅允许字母、数字、.、_、-")
  .transform((s) => s.toLowerCase())
  .refine(
    (n) => !(APPLICATION_TAG_RESERVED as readonly string[]).includes(n),
    "production/v 是保留字，不能作自定义标签",
  );

export const MoveApplicationTagRequestSchema = z.strictObject({
  name: ApplicationTagNameSchema,
  versionId: z.string().min(1),
});
export type MoveApplicationTagRequest = z.infer<typeof MoveApplicationTagRequestSchema>;

export const ApplicationTagSchema = z.strictObject({
  name: z.string().min(1),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
});
export type ApplicationTag = z.infer<typeof ApplicationTagSchema>;
export const ApplicationTagListResponseSchema = z.array(ApplicationTagSchema);
export type ApplicationTagListResponse = z.infer<typeof ApplicationTagListResponseSchema>;

// —— M7b ReleaseCheck（异步真实 NodeRuntime 预演结果）——
export const ReleaseCheckIssueSchema = z.strictObject({
  code: z.string(),
  node: PromptNodeSchema.optional(),
  promptVersionId: z.string().optional(),
  sampleIndex: z.number().int().optional(),
  traceId: z.string().optional(),
  action: z.literal("OPEN_PROMPT_TRY_RUN").optional(),
  message: z.string(),
});
export type ReleaseCheckIssue = z.infer<typeof ReleaseCheckIssueSchema>;

export const ReleaseCheckStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "expired",
]);
export type ReleaseCheckStatus = z.infer<typeof ReleaseCheckStatusSchema>;

export const ReleaseCheckSchema = z.strictObject({
  id: z.string().min(1),
  applicationId: z.string().min(1),
  configVersionId: z.string().min(1),
  configFingerprint: z.string(),
  status: ReleaseCheckStatusSchema,
  issues: z.array(ReleaseCheckIssueSchema),
  sampleSummary: z.record(z.string(), z.unknown()),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type ReleaseCheck = z.infer<typeof ReleaseCheckSchema>;

// —— M7b 运行时解析（resolveByTag 管理员预览 / resolvePublic 仅 production；M8 chat 消费同一形状）——
export const ResolvedNodeConfigSchema = z.strictObject({
  promptVersionId: z.string().min(1),
  promptBody: z.string(),
  contractVersion: z.number().int().positive(),
  modelId: z.string().min(1),
  freedom: FreedomSchema,
  temperature: z.number(),
  topP: z.number(),
});
export type ResolvedNodeConfig = z.infer<typeof ResolvedNodeConfigSchema>;

export const ResolvedApplicationConfigSchema = z.strictObject({
  applicationId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1), // M9 W1：agent 名快照来源（写侧落 gen_ai.agent.name）
  configVersionId: z.string().min(1),
  version: z.number().int().positive(),
  kbIds: z.array(z.string()),
  nodes: z.strictObject({
    rewrite: ResolvedNodeConfigSchema,
    intent: ResolvedNodeConfigSchema,
    reply: ResolvedNodeConfigSchema,
    fallback: ResolvedNodeConfigSchema,
  }),
  retrieval: ApplicationRetrievalParamsSchema,
  fallback: z.strictObject({ toHuman: z.boolean() }),
  /** resolveByTag/resolveForTest=true（rag.preview 打标）；resolvePublic=false */
  preview: z.boolean(),
});
export type ResolvedApplicationConfig = z.infer<typeof ResolvedApplicationConfigSchema>;

// —— M7b production 受门禁 CAS 上线/下线 ——
export const PublishProductionRequestSchema = z.strictObject({
  versionId: z.string().min(1),
  releaseCheckId: z.string().min(1),
  expectedProductionVersionId: z.string().min(1).nullable(),
});
export type PublishProductionRequest = z.infer<typeof PublishProductionRequestSchema>;

export const UnpublishProductionRequestSchema = z.strictObject({
  expectedProductionVersionId: z.string().min(1).nullable(),
});
export type UnpublishProductionRequest = z.infer<typeof UnpublishProductionRequestSchema>;
