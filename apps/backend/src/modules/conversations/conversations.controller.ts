import { Controller, Get, Param } from "@nestjs/common";
import type { Conversation, Message } from "@codecrush/contracts";
import { ConversationsService } from "./conversations.service";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  list(): Conversation[] {
    return this.conversationsService.list();
  }

  @Get(":id")
  get(@Param("id") id: string): Conversation {
    return this.conversationsService.get(id);
  }

  @Get(":id/messages")
  listMessages(@Param("id") id: string): Message[] {
    return this.conversationsService.listMessages(id);
  }
}
