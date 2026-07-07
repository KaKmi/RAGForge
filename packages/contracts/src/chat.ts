import { z } from "zod";

export const ChatRequestSchema = z.object({
  convId: z.string().min(1).optional(),
  agentId: z.string().min(1),
  query: z.string().min(1),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatCitationSchema = z.object({
  n: z.number().int().positive(),
  doc: z.string(),
  kb: z.string(),
  section: z.string(),
  score: z.number().min(0).max(1),
});
export type ChatCitation = z.infer<typeof ChatCitationSchema>;

export const ChatTokenEventSchema = z.object({
  type: z.literal("token"),
  delta: z.string(),
});

export const ChatCitationEventSchema = z.object({
  type: z.literal("citation"),
  citation: ChatCitationSchema,
});

export const ChatDoneEventSchema = z.object({
  type: z.literal("done"),
  traceId: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

export const ChatErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const ChatStreamEventSchema = z.discriminatedUnion("type", [
  ChatTokenEventSchema,
  ChatCitationEventSchema,
  ChatDoneEventSchema,
  ChatErrorEventSchema,
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;
