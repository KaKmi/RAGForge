import { BadRequestException, Controller, Get, Param, Post } from "@nestjs/common";
import type { HelloTraceResponse, TraceDetailResponse } from "@codecrush/contracts";
import { TracesService } from "./traces.service";

const TRACE_ID_RE = /^[a-f0-9]{32}$/i;

@Controller("traces")
export class TracesController {
  constructor(private readonly tracesService: TracesService) {}

  @Post("hello")
  async emitHello(): Promise<HelloTraceResponse> {
    return await this.tracesService.emitHello();
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
