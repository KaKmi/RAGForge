import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import type { Conversation, Message } from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { ConversationsService } from "./conversations.service";

type AuthedRequest = { user: AuthenticatedUser };

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  // M8 T4：C 端会话列表按 agentId（query）+ userId（JWT）归属过滤，避免跨 agent/跨用户串号。
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query("agentId") agentId?: string,
  ): Promise<Conversation[]> {
    return this.conversationsService.list(agentId, req.user.id);
  }

  @Get(":id")
  async get(@Param("id") id: string, @Req() req: AuthedRequest): Promise<Conversation> {
    return this.conversationsService.get(id, req.user.id);
  }

  @Get(":id/messages")
  async listMessages(@Param("id") id: string, @Req() req: AuthedRequest): Promise<Message[]> {
    return this.conversationsService.listMessages(id, req.user.id);
  }
}
