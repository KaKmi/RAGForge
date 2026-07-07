import { z } from "zod";

export const RetrievalTestRequestSchema = z.object({
  query: z.string().min(1),
  kbId: z.string().min(1),
  embedModelId: z.string().min(1),
  topK: z.number().int().positive(),
  threshold: z.number().min(0).max(1),
  multi: z.boolean(),
  vecWeight: z.number().min(0).max(1).optional(),
  rerankModelId: z.string().optional(),
  topN: z.number().int().positive().optional(),
});
export type RetrievalTestRequest = z.infer<typeof RetrievalTestRequestSchema>;

export const RetrievalHitSchema = z.object({
  chunkId: z.string().min(1),
  docId: z.string().min(1),
  docName: z.string().min(1),
  text: z.string(),
  section: z.string(),
  vecScore: z.number().min(0).max(1),
  kwScore: z.number().min(0).max(1).optional(),
  rerankScore: z.number().min(0).max(1).optional(),
  finalScore: z.number().min(0).max(1),
});
export type RetrievalHit = z.infer<typeof RetrievalHitSchema>;

export const RetrievalTestResponseSchema = z.object({
  hits: z.array(RetrievalHitSchema),
});
export type RetrievalTestResponse = z.infer<typeof RetrievalTestResponseSchema>;
