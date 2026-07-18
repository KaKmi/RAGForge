import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  ReplayRequestSchema,
  type ChatStreamEvent,
  type ReplayScoresEvent,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { ReplayService } from "./replay.service";

class ReplayRequestDto extends createZodDto(ReplayRequestSchema) {}

type AuthedRequest = { user: AuthenticatedUser };

/** SSE 响应最小结构（结构兼容 Express Response，避免直接依赖 @types/express；同 chat.controller）。 */
interface SseResponse {
  setHeader(name: string, value: string): void;
  write(chunk: string): boolean;
  end(): void;
  on?(event: "close", cb: () => void): void;
}

function sse(event: ChatStreamEvent | ReplayScoresEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * E-W2b F7：`POST /eval/replay`——重放同编排（preview）→ SSE →（可选）末尾 replay_scores。
 * 客户端断连 → gen.return() + abort.abort() 级联取消（同 chat.controller.ts:49-51）。
 */
@Controller("eval")
export class ReplayController {
  constructor(private readonly replay: ReplayService) {}

  @Post("replay")
  @HttpCode(200)
  async stream(
    @Body() body: ReplayRequestDto,
    @Req() req: AuthedRequest,
    @Res() res: SseResponse,
  ): Promise<void> {
    const abort = new AbortController();
    const gen = this.replay.stream(body, req.user.id, abort.signal);
    res.on?.("close", () => {
      abort.abort();
      void gen.return(undefined);
    });
    // 首个 next() 触发限频/resolveForTest：抛（429/422）在写 event-stream 头之前冒泡给 Nest 过滤器。
    const first = await gen.next();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (!first.done) res.write(sse(first.value));
    for await (const ev of gen) res.write(sse(ev));
    res.end();
  }
}
