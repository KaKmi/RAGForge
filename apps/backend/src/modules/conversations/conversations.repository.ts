import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Conversation, Message, MessageRole } from "@codecrush/contracts";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import { conversations, messages, type ConversationRow, type MessageRow } from "./schema";

export interface CreateConversationInput {
  agentId: string;
  userId?: string;
  title: string;
}

export interface AppendMessageInput {
  convId: string;
  role: MessageRole;
  content: string;
  traceId?: string;
  confidence?: number;
  coverage?: "full" | "partial";
  isFallback?: boolean;
  fallbackInfo?: Message["fallbackInfo"];
  citations?: string[];
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    agentId: row.agentId,
    userId: row.userId ?? undefined,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    convId: row.convId,
    role: row.role as MessageRole,
    content: row.content,
    traceId: row.traceId ?? undefined,
    confidence: row.confidence ?? undefined,
    coverage: (row.coverage as "full" | "partial" | null) ?? undefined,
    isFallback: row.isFallback ?? undefined,
    fallbackInfo: row.fallbackInfo ?? undefined,
    citations: row.citations ?? undefined,
  };
}

@Injectable()
export class ConversationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const rows = await this.db
      .insert(conversations)
      .values({ agentId: input.agentId, userId: input.userId, title: input.title })
      .returning();
    return toConversation(rows[0]);
  }

  /** 追加消息 + 同事务回写会话 updatedAt（list 按活跃时间排序依赖此语义） */
  async appendMessage(input: AppendMessageInput): Promise<Message> {
    return await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(messages)
        .values({
          convId: input.convId,
          role: input.role,
          content: input.content,
          traceId: input.traceId,
          confidence: input.confidence,
          coverage: input.coverage,
          isFallback: input.isFallback,
          fallbackInfo: input.fallbackInfo,
          citations: input.citations,
        })
        .returning();
      await tx
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, input.convId));
      return toMessage(rows[0]);
    });
  }

  async list(agentId?: string, userId?: string): Promise<Conversation[]> {
    const conds = [];
    if (agentId) conds.push(eq(conversations.agentId, agentId));
    if (userId) conds.push(eq(conversations.userId, userId));
    const rows = await this.db
      .select()
      .from(conversations)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(conversations.updatedAt));
    return rows.map(toConversation);
  }

  async getById(id: string): Promise<Conversation | undefined> {
    const rows = await this.db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    return rows[0] ? toConversation(rows[0]) : undefined;
  }

  async listMessages(convId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.convId, convId))
      .orderBy(asc(messages.createdAt));
    return rows.map(toMessage);
  }
}
