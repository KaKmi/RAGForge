import { z } from "zod";

export const AgentStatusSchema = z.enum(["active", "draft", "archived"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  desc: z.string(),
  status: AgentStatusSchema,
  kbs: z.array(z.string().min(1)),
  genModelId: z.string().min(1),
  lightModelId: z.string().optional(),
  rerankModelId: z.string().optional(),
  promptRewriteVerId: z.string().min(1),
  promptIntentVerId: z.string().min(1),
  promptReplyVerId: z.string().min(1),
  promptFallbackVerId: z.string().min(1),
  topK: z.number().int().positive(),
  topN: z.number().int().positive(),
  threshold: z.number().min(0).max(1),
  multi: z.boolean(),
  vecWeight: z.number().min(0).max(1).optional(),
  fallbackHuman: z.boolean(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentListResponseSchema = z.array(AgentSchema);
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

export const CreateAgentRequestSchema = AgentSchema.omit({ id: true });
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = CreateAgentRequestSchema.partial();
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
