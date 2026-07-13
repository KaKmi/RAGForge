import { Injectable, NotFoundException } from "@nestjs/common";
import type { Conversation, Message } from "@codecrush/contracts";
import {
  ConversationsRepository,
  type AppendMessageInput,
  type CreateConversationInput,
} from "./conversations.repository";

@Injectable()
export class ConversationsService {
  constructor(private readonly repo: ConversationsRepository) {}

  async list(agentId?: string, userId?: string): Promise<Conversation[]> {
    return await this.repo.list(agentId, userId);
  }

  async get(id: string, userId?: string): Promise<Conversation> {
    const conv = await this.repo.getById(id);
    if (!conv) throw new NotFoundException(`conversation ${id} not found`);
    // IDOR：会话有 userId 且与调用者不符 → 视作不存在（不泄漏存在性）。
    // userId 未传（编排层 resolveConvId/loadHistory）→ 跳过校验，行为不变。
    if (userId && conv.userId && conv.userId !== userId)
      throw new NotFoundException(`conversation ${id} not found`);
    return conv;
  }

  async listMessages(convId: string, userId?: string): Promise<Message[]> {
    await this.get(convId, userId); // 校验存在 + 归属
    return await this.repo.listMessages(convId);
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    return await this.repo.createConversation(input);
  }

  async appendMessage(input: AppendMessageInput): Promise<Message> {
    return await this.repo.appendMessage(input);
  }
}
