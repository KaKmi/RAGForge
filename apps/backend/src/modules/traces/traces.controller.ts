import { BadRequestException, Controller, Get, Header, Param, Post, Query, Res } from "@nestjs/common";
import {
  type HelloTraceResponse,
  type SessionDetailResponse,
  type SessionListResponse,
  type TraceDetailResponse,
  type TraceListResponse,
  TraceListQuerySchema,
} from "@codecrush/contracts";
import { TracesService } from "./traces.service";

const TRACE_ID_RE = /^[a-f0-9]{32}$/i;

@Controller("traces")
export class TracesController {
  constructor(private readonly tracesService: TracesService) {}

  @Post("hello")
  async emitHello(): Promise<HelloTraceResponse> {
    return await this.tracesService.emitHello();
  }

  // 静态路由须声明在 :traceId 之前（Nest 按声明序匹配）：否则 /traces、/traces/sessions 被参数路由吞掉。
  @Get()
  async list(@Query() raw: unknown): Promise<TraceListResponse> {
    // 全局 ZodValidationPipe 对非 createZodDto 的 @Query 跳过校验（同 :traceId 手动校验风格），故此处手动 parse。
    const parsed = TraceListQuerySchema.safeParse(raw ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    return await this.tracesService.listTraces(parsed.data);
  }

  @Get("export")
  @Header("Content-Type", "text/csv; charset=utf-8")
  async export(
    @Query() raw: unknown,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ): Promise<string> {
    const parsed = TraceListQuerySchema.safeParse(raw ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const result = await this.tracesService.exportTraceCandidates(parsed.data);
    response.setHeader("Content-Disposition", 'attachment; filename="trace-candidates.csv"');
    response.setHeader("X-Export-Truncated", String(result.truncated));
    return `\uFEFF${result.csv}`;
  }

  @Get("sessions")
  async sessions(): Promise<SessionListResponse> {
    return await this.tracesService.listSessions();
  }

  // 两段路径，不与单段 :traceId 冲突；仍置于 :traceId 之前保持静态优先声明习惯。
  @Get("sessions/:sessionId")
  async session(@Param("sessionId") sessionId: string): Promise<SessionDetailResponse> {
    return await this.tracesService.getSession(sessionId);
  }

  @Get(":traceId")
  async getTrace(@Param("traceId") traceId: string): Promise<TraceDetailResponse> {
    // 契约 TraceDetailResponse.traceId 要求 32-hex；不校验会返回违反自家契约的 200（review P3-2）。
    // 全局 ZodValidationPipe 默认对非 createZodDto 的 @Param（此处为 string）跳过校验
    // （strictSchemaDeclaration 关），故此处 regex 是 traceId 的实际校验点，并非冗余双保险。
    // 保留在 controller 内而非迁到 pipe：使 traces.controller.spec.ts 直调断言 400 仍成立。
    if (!TRACE_ID_RE.test(traceId)) {
      throw new BadRequestException("traceId must be a 32-character hex string");
    }
    return await this.tracesService.getTrace(traceId);
  }
}
