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

  it("GET /traces/sessions calls service.listSessions (not swallowed by :traceId)", async () => {
    const listSessions = jest.fn().mockResolvedValue([]);
    const ctrl = await build({ listSessions } as Partial<TracesService>);
    await expect(ctrl.sessions()).resolves.toEqual([]);
    expect(listSessions).toHaveBeenCalled();
  });
});
