import { z } from "zod";
import { FreedomSchema } from "./agents";
import { PromptNodeSchema } from "./node-contract";

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
      ctx.addIssue({ code: "custom", path: ["topN"], message: "topN must not exceed topK" });
    }
    if (value.rerankEnabled && !value.rerankModelId) {
      ctx.addIssue({
        code: "custom",
        path: ["rerankModelId"],
        message: "rerankModelId is required when rerank is enabled",
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
