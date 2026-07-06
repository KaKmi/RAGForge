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
    // M2 已引入全局 ZodValidationPipe，但 param 校验仍在此保留作防御性双保险：
    // HTTP 层 pipe 拦 + controller 内 regex 双校验，且使 traces.controller.spec.ts 直调断言不失效。
    if (!TRACE_ID_RE.test(traceId)) {
      throw new BadRequestException("traceId must be a 32-character hex string");
    }
    return await this.tracesService.getTrace(traceId);
  }
}
