import { z } from "zod";

export const ModelTypeSchema = z.enum(["llm", "embedding", "rerank"]);
export type ModelType = z.infer<typeof ModelTypeSchema>;

export const ModelProviderSchema = z.object({
  id: z.string().min(1),
  type: ModelTypeSchema,
  provider: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKeyMasked: z.string().optional(),
  role: z.string().optional(),
  enabled: z.boolean(),
});
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelProviderListResponseSchema = z.array(ModelProviderSchema);
export type ModelProviderListResponse = z.infer<typeof ModelProviderListResponseSchema>;

export const CreateModelRequestSchema = ModelProviderSchema.omit({ id: true });
export type CreateModelRequest = z.infer<typeof CreateModelRequestSchema>;
