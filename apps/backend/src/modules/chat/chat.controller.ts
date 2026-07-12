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
}

/** SSE 单帧：`data: ${JSON}\n\n`（前端 sse.ts 按此解析）。 */
function sse(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

@Controller("chat")
export class ChatController {
  constructor(private readonly orchestration: OrchestrationService) {}

  /**
   * M8 T1：接真实 RAG 编排。resolvePublic 在 run() 最前、写响应头之前——未上线/停用
   * 异常冒泡给 Nest 异常过滤器翻 404/403（此时尚未写 event-stream 头，客户端收到干净的错误响应）。
   * 带 JWT（不 @Public），userId 取自 req.user.id。
   * T1 非流式：整段 replyText 作单个 token 事件；逐 token 流式留 T2。
   */
  @Post()
  @HttpCode(200)
  async chat(
    @Body() body: ChatRequestDto,
    @Req() req: AuthedRequest,
    @Res() res: SseResponse,
  ): Promise<void> {
    // 抛错在写头之前：让 Nest 异常过滤器接管（404/403），不进 event-stream。
    const result = await this.orchestration.run(body.agentId, body.query, body.convId, req.user.id);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    for (const c of result.citations) {
      res.write(sse({ type: "citation", citation: c }));
    }
    res.write(sse({ type: "token", delta: result.replyText }));
    res.write(
      sse({
        type: "done",
        traceId: result.traceId,
        confidence: result.confidence,
        coverage: result.coverage,
        isFallback: result.isFallback,
        fallbackReasons: result.fallbackReasons,
      }),
    );
    res.end();
  }
}
