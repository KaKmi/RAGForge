import { z } from "zod";

export const ChunkSchema = z.object({
  id: z.string().min(1),
  docId: z.string().min(1),
  kbId: z.string().min(1),
  version: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  text: z.string(),
  tokenCount: z.number().int().nonnegative(),
  section: z.string(),
});
export type Chunk = z.infer<typeof ChunkSchema>;

export const ChunkPageResponseSchema = z.object({
  items: z.array(ChunkSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
});
export type ChunkPageResponse = z.infer<typeof ChunkPageResponseSchema>;

export const ChunkListQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(100).default(20),
  q: z.string().optional(),
});
export type ChunkListQuery = z.infer<typeof ChunkListQuerySchema>;

export const ChunkBatchDeleteRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});
export type ChunkBatchDeleteRequest = z.infer<typeof ChunkBatchDeleteRequestSchema>;

export const ChunkBatchDeleteResponseSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
});
export type ChunkBatchDeleteResponse = z.infer<typeof ChunkBatchDeleteResponseSchema>;
