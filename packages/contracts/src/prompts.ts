import { z } from "zod";

export const PromptNodeSchema = z.enum(["rewrite", "intent", "reply", "fallback"]);
export type PromptNode = z.infer<typeof PromptNodeSchema>;

export const PromptVersionStatusSchema = z.enum(["draft", "prod", "archived"]);
export type PromptVersionStatus = z.infer<typeof PromptVersionStatusSchema>;

export const PromptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  node: PromptNodeSchema,
  currentVersionId: z.string().min(1),
});
export type Prompt = z.infer<typeof PromptSchema>;

export const PromptVersionSchema = z.object({
  id: z.string().min(1),
  promptId: z.string().min(1),
  version: z.number().int().positive(),
  body: z.string(),
  variables: z.array(z.string()),
  note: z.string().optional(),
  author: z.string().optional(),
  status: PromptVersionStatusSchema,
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

export const PromptVersionListResponseSchema = z.array(PromptVersionSchema);
export type PromptVersionListResponse = z.infer<typeof PromptVersionListResponseSchema>;

export const CreatePromptVersionRequestSchema = PromptVersionSchema.omit({
  id: true,
  promptId: true,
  version: true,
  status: true,
});
export type CreatePromptVersionRequest = z.infer<typeof CreatePromptVersionRequestSchema>;

export const PromptListResponseSchema = z.array(PromptSchema);
export type PromptListResponse = z.infer<typeof PromptListResponseSchema>;
