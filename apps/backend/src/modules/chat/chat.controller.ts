import { Body, Controller, HttpCode, Post, Res } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { ChatRequestSchema, type ChatStreamEvent } from "@codecrush/contracts";
import { ChatService } from "./chat.service";

class ChatRequestDto extends createZodDto(ChatRequestSchema) {}

/**
 * SSE 响应所需的最小结构类型——避免直接依赖 `@types/express`（结构兼容 Express Response）。
 * 005 Revisit 1：用 fetch + ReadableStream 而非 EventSource（后者不能带 Authorization 头）。
 */
interface SseResponse {
  setHeader(name: string, value: string): void;
  write(chunk: string): boolean;
  end(): void;
}

@Controller("chat")
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * M2 桩：返回 mock `text/event-stream`（假 token/citation/done 事件）。
   * 带 JWT（不 @Public），复用 M1 鉴权。M8 接真实 RAG 编排。
   */
  @Post()
  @HttpCode(200)
  async chat(@Body() body: ChatRequestDto, @Res() res: SseResponse): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const events: ChatStreamEvent[] = this.chatService.generateStream(body);
    for (const event of events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  }
}
