import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { emitManualHelloSpan } from "@codecrush/otel";
import type {
  HelloTraceResponse,
  SessionDetailResponse,
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

  async exportTraceCandidates(query: TraceListQuery): Promise<{ csv: string; truncated: boolean }> {
    const cap = 10_000;
    const items: TraceListResponse["items"] = [];
    let total = 0;
    for (let page = 1; items.length < cap; page += 1) {
      const batch = await this.tracesRepository.listTraces({ ...query, page, pageSize: 100 });
      total = batch.total;
      items.push(...batch.items);
      if (items.length >= batch.total || batch.items.length === 0) break;
    }
    const truncated = total > cap;
    const safe = (value: unknown): string => {
      let text = String(value ?? "");
      if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = items.slice(0, cap).map((item) => [
      item.traceId, item.startTime, item.agentName ?? item.agentId, item.userInput,
      item.status, item.durationMs, item.qualitySignals.join("|"),
    ]);
    return {
      csv: ["trace_id,start_time,application,question,status,duration_ms,quality_signals", ...rows.map((row) => row.map(safe).join(","))].join("\r\n"),
      truncated,
    };
  }

  async listSessions(): Promise<SessionListResponse> {
    return await this.tracesRepository.listSessions();
  }

  async getSession(sessionId: string): Promise<SessionDetailResponse> {
    return await this.tracesRepository.findSessionById(sessionId);
  }
}
