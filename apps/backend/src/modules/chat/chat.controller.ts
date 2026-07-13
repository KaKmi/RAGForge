import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { ChatRequestSchema, type ChatStreamEvent } from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { OrchestrationService } from "./orchestration.service";

class ChatRequestDto extends createZodDto(ChatRequestSchema) {}

type AuthedRequest = { user: AuthenticatedUser };

/**
 * SSE 响应所需的最小结构类型——避免直接依赖 `@types/express`（结构兼容 Express Response）。
 * 005 Revisit 1：用 fetch + ReadableStream 而非 EventSource（后者不能带 Authorization 头）。
 */
interface SseResponse {
  setHeader(name: string, value: string): void;
  write(chunk: string): boolean;
  end(): void;
  /** 客户端断连侦听（Express Response 结构兼容）——用于 T2 abort 级联取消生成器。 */
  on?(event: "close", cb: () => void): void;
}

/** SSE 单帧：`data: ${JSON}\n\n`（前端 sse.ts 按此解析）。 */
function sse(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

@Controller("chat")
export class ChatController {
  constructor(private readonly orchestration: OrchestrationService) {}

  /**
   * M8 T2：消费 OrchestrationService.run() 的 AsyncGenerator，逐帧 flush SSE。
   * resolvePublic 在生成器体首行、首个 next() 触发——抛（未上线/停用）在写 event-stream 头之前
   * 冒泡给 Nest 异常过滤器翻 404/403（客户端收到干净的错误响应）。
   * 客户端断连（res close）→ gen.return() 级联取消（streamTextChunks → chatStream → reader.cancel）。
   * 带 JWT（不 @Public），userId 取自 req.user.id。
   */
  @Post()
  @HttpCode(200)
  async chat(
    @Body() body: ChatRequestDto,
    @Req() req: AuthedRequest,
    @Res() res: SseResponse,
  ): Promise<void> {
    const gen = this.orchestration.run(body.agentId, body.query, body.convId, req.user.id);
    // close 侦听须在首个 next() 之前注册：否则客户端在首帧到达前断连会漏掉。
    // gen.return() 对已抛错/已结束的 generator 是安全 no-op。
    res.on?.("close", () => {
      void gen.return(undefined);
    });
    // 首个 next() 触发 resolvePublic：抛（404/403）在写 event-stream 头之前冒泡给 Nest 过滤器。
    const first = await gen.next();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (!first.done) res.write(sse(first.value));
    for await (const ev of gen) res.write(sse(ev));
    res.end();
  }
}
