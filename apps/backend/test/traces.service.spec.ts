import { ServiceUnavailableException } from "@nestjs/common";
import { TracesService } from "../src/modules/traces/traces.service";
import type { ClickHouseTracesRepository } from "../src/modules/traces/clickhouse-traces.repository";
import { emitManualHelloSpan } from "@codecrush/otel";

jest.mock("@codecrush/otel", () => ({
  emitManualHelloSpan: jest.fn(),
}));

const emitMock = emitManualHelloSpan as jest.MockedFunction<typeof emitManualHelloSpan>;

describe("TracesService.emitHello", () => {
  const service = new TracesService({} as ClickHouseTracesRepository);

  it("returns the span identity as a hello response", async () => {
    emitMock.mockResolvedValueOnce({
      traceId: "391dae938234560b16bb63f51501cb6f",
      spanId: "6bb63f51501cb6f1",
      name: "manual.hello",
    });
    await expect(service.emitHello()).resolves.toEqual({
      traceId: "391dae938234560b16bb63f51501cb6f",
      spanId: "6bb63f51501cb6f1",
      name: "manual.hello",
    });
  });

  it("rejects with 503 when tracing is disabled (noop tracer all-zero identity)", async () => {
    emitMock.mockResolvedValueOnce({
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      name: "manual.hello",
    });
    await expect(service.emitHello()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("TracesService.exportTraceCandidates", () => {
  const summary = { sampledTotal: 0, failRate: 0, failCount: 0, p95Ms: 0, timeoutCount: 0 };

  it("escapes CSV quotes/newlines and spreadsheet formulas", async () => {
    const listTraces = jest.fn().mockResolvedValue({
      total: 1, summary,
      items: [{
        traceId: "a".repeat(32), sessionId: "s1", agentId: "app1", agentName: " \t=cmd|'/C calc'!A0",
        userId: null, userInput: "hello, \"world\"\nnext", status: "success",
        startTime: "2026-07-14T00:00:00.000Z", durationMs: 12,
        inputTokens: 1, outputTokens: 1, qualitySignals: ["no_citations"], promptVersionId: null,
      }],
    });
    const service = new TracesService({ listTraces } as unknown as ClickHouseTracesRepository);
    const result = await service.exportTraceCandidates({ page: 1, pageSize: 20 });
    expect(result.truncated).toBe(false);
    expect(result.csv).toContain('"\' \t=cmd|\'/C calc\'!A0"');
    expect(result.csv).toContain('"hello, ""world""\nnext"');
    expect(result.csv).not.toContain("inputTokens");
  });

  it("marks exports truncated when the matching total exceeds 10,000", async () => {
    const item = {
      traceId: "a".repeat(32), sessionId: "s1", agentId: "app1", agentName: "app",
      userId: null, userInput: "q", status: "success" as const,
      startTime: "2026-07-14T00:00:00.000Z", durationMs: 12,
      inputTokens: 1, outputTokens: 1, qualitySignals: [], promptVersionId: null,
    };
    const listTraces = jest.fn().mockImplementation(async ({ page }: { page: number }) => ({
      total: 10_001, summary, items: page <= 100 ? Array.from({ length: 100 }, () => item) : [],
    }));
    const service = new TracesService({ listTraces } as unknown as ClickHouseTracesRepository);
    const result = await service.exportTraceCandidates({ page: 1, pageSize: 20, signal: "repair" });
    expect(result.truncated).toBe(true);
    expect(result.csv.split("\r\n")).toHaveLength(10_001);
    expect(listTraces).toHaveBeenCalledWith(expect.objectContaining({ signal: "repair", pageSize: 100 }));
  });

  it("returns only the header for an empty candidate set", async () => {
    const listTraces = jest.fn().mockResolvedValue({ total: 0, summary, items: [] });
    const service = new TracesService({ listTraces } as unknown as ClickHouseTracesRepository);
    const result = await service.exportTraceCandidates({ page: 1, pageSize: 20 });
    expect(result.csv).toBe("trace_id,start_time,application,question,status,duration_ms,quality_signals");
  });
});
