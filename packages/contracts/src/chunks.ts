import { z } from "zod";

export const ChunkSchema = z.object({
  id: z.string().min(1),
  docId: z.string().min(1),
  kbId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  text: z.string(),
  tokenCount: z.number().int().nonnegative(),
  section: z.string(),
  enabled: z.boolean(),
});
export type Chunk = z.infer<typeof ChunkSchema>;

export const UpdateChunkEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});
export type UpdateChunkEnabledRequest = z.infer<typeof UpdateChunkEnabledRequestSchema>;
