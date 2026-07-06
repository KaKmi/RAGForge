import { z } from "zod";

export const MessageRoleSchema = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ConversationSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  userId: z.string().min(1).optional(),
  title: z.string().min(1),
  updatedAt: z.string().datetime().optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationListResponseSchema = z.array(ConversationSchema);
export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  convId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  traceId: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  citations: z.array(z.string().min(1)).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const MessageListResponseSchema = z.array(MessageSchema);
export type MessageListResponse = z.infer<typeof MessageListResponseSchema>;
