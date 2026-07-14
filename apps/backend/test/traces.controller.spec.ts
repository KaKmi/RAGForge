import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { HelloTraceResponse, TraceDetailResponse } from "@codecrush/contracts";
import { TracesController } from "../src/modules/traces/traces.controller";
import { TracesService } from "../src/modules/traces/traces.service";

describe("TracesController", () => {
  async function build(service: Partial<TracesService>) {
    const ref = await Test.createTestingModule({
      controllers: [TracesController],
      providers: [{ provide: TracesService, useValue: service }],
    }).compile();
    return ref.get(TracesController);
  }

  it("emits a manual hello span", async () => {
    const response: HelloTraceResponse = {
      traceId: "391dae938234560b16bb63f51501cb6f",
      spanId: "6bb63f51501cb6f1",
      name: "manual.hello",
    };
    const ctrl = await build({ emitHello: async () => response } as Partial<TracesService>);
    await expect(ctrl.emitHello()).resolves.toEqual(response);
  });

  it("reads normalized trace detail by trace id", async () => {
    const detail: TraceDetailResponse = {
      traceId: "391dae938234560b16bb63f51501cb6f",
      spans: [
        {
          traceId: "391dae938234560b16bb63f51501cb6f",
          spanId: "6bb63f51501cb6f1",
          parentSpanId: null,
          name: "manual.hello",
          kind: "custom",
          startTime: "2026-07-05T00:00:00.000Z",
          durationMs: 1,
          statusCode: "Ok",
          attributes: { "codecrush.test": "hello" },
        },
      ],
    };
    const ctrl = await build({ getTrace: async () => detail } as Partial<TracesService>);
    await expect(ctrl.getTrace("391dae938234560b16bb63f51501cb6f")).resolves.toEqual(detail);
  });

  it("rejects malformed trace ids with 400 before hitting the service", async () => {
    const getTrace = jest.fn();
    const ctrl = await build({ getTrace } as Partial<TracesService>);
    await expect(ctrl.getTrace("not-a-hex-id")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctrl.getTrace("391dae938234560b16bb63f51501cb6f".slice(0, 31))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getTrace).not.toHaveBeenCalled();
  });

  // M9 W1：list + sessions
  it("GET /traces passes parsed query to service.listTraces", async () => {
    const empty = { items: [], total: 0, summary: { sampledTotal: 0, failRate: 0, failCount: 0, p95Ms: 0, timeoutCount: 0 } };
    const listTraces = jest.fn().mockResolvedValue(empty);
    const ctrl = await build({ listTraces } as Partial<TracesService>);
    await expect(ctrl.list({ page: "2", pageSize: "10", status: "失败" })).resolves.toEqual(empty);
    // 手动 parse 后 coerce：page/pageSize 数字化
    expect(listTraces).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 10, status: "失败" }));
  });

  it("GET /traces rejects invalid query (page=0) with 400 before service", async () => {
    const listTraces = jest.fn();
    const ctrl = await build({ listTraces } as Partial<TracesService>);
    await expect(ctrl.list({ page: "0" })).rejects.toBeInstanceOf(BadRequestException);
    expect(listTraces).not.toHaveBeenCalled();
  });

  it("GET /traces/export validates typed filters and sets safe download headers", async () => {
    const exportTraceCandidates = jest.fn().mockResolvedValue({ csv: "trace_id\r\n", truncated: true });
    const ctrl = await build({ exportTraceCandidates } as Partial<TracesService>);
    const response = { setHeader: jest.fn() };
    const body = await ctrl.export({ signal: "repair", agentId: "app1" }, response);
    expect(exportTraceCandidates).toHaveBeenCalledWith(expect.objectContaining({
      signal: "repair", agentId: "app1", page: 1, pageSize: 20,
    }));
    expect(response.setHeader).toHaveBeenCalledWith("X-Export-Truncated", "true");
    expect(body.startsWith("\uFEFF")).toBe(true);
  });

  it("GET /traces/export rejects unknown signals before querying", async () => {
    const exportTraceCandidates = jest.fn();
    const ctrl = await build({ exportTraceCandidates } as Partial<TracesService>);
    await expect(ctrl.export({ signal: "unknown" }, { setHeader: jest.fn() })).rejects.toBeInstanceOf(BadRequestException);
    expect(exportTraceCandidates).not.toHaveBeenCalled();
  });

  it("GET /traces/sessions calls service.listSessions (not swallowed by :traceId)", async () => {
    const listSessions = jest.fn().mockResolvedValue([]);
    const ctrl = await build({ listSessions } as Partial<TracesService>);
    await expect(ctrl.sessions()).resolves.toEqual([]);
    expect(listSessions).toHaveBeenCalled();
  });

  // M9 W3：session 详情
  it("GET /traces/sessions/:sessionId calls service.getSession", async () => {
    const detail = { sessionId: "conv1", userId: "u1", agentId: "app1", agentName: "退款助手", rounds: [] };
    const getSession = jest.fn().mockResolvedValue(detail);
    const ctrl = await build({ getSession } as Partial<TracesService>);
    await expect(ctrl.session("conv1")).resolves.toEqual(detail);
    expect(getSession).toHaveBeenCalledWith("conv1");
  });
});
