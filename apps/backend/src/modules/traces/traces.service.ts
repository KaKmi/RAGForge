import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { emitManualHelloSpan } from "@codecrush/otel";
import type {
  HelloTraceResponse,
  SessionListResponse,
  TraceDetailResponse,
  TraceListQuery,
  TraceListResponse,
} from "@codecrush/contracts";
import { ClickHouseTracesRepository } from "./clickhouse-traces.repository";

/** noop tracer（tracing 未启用）返回的 INVALID_SPAN_CONTEXT traceId */
const INVALID_TRACE_ID = "0".repeat(32);

@Injectable()
export class TracesService {
  constructor(private readonly tracesRepository: ClickHouseTracesRepository) {}

  async emitHello(): Promise<HelloTraceResponse> {
    // SpanIdentity.name 是 string，HelloTraceResponse.name 是字面量 "manual.hello"；显式构造以满足契约类型
    const { traceId, spanId } = await emitManualHelloSpan();
    if (traceId === INVALID_TRACE_ID) {
      // 全零 = noop tracer 的假身份，不能当真 trace 返回（review P3-1）
      throw new ServiceUnavailableException(
        "tracing is not enabled: OTEL_EXPORTER_OTLP_ENDPOINT is not set or the telemetry SDK failed to start",
      );
    }
    return { traceId, spanId, name: "manual.hello" };
  }

  async getTrace(traceId: string): Promise<TraceDetailResponse> {
    return await this.tracesRepository.findByTraceId(traceId);
  }

  async listTraces(query: TraceListQuery): Promise<TraceListResponse> {
    return await this.tracesRepository.listTraces(query);
  }

  async listSessions(): Promise<SessionListResponse> {
    return await this.tracesRepository.listSessions();
  }
}
