import { describe, expect, it } from "vitest";
import {
  HelloTraceResponseSchema,
  QualitySignalSchema,
  SessionListRowSchema,
  TraceDetailMetaSchema,
  TraceDetailResponseSchema,
  TraceListQuerySchema,
  TraceListResponseSchema,
  TraceListRowSchema,
  TraceSpanSchema,
  TraceStatusSchema,
} from "./traces";

describe("trace contracts", () => {
  it("accepts a hello trace response", () => {
    expect(
      HelloTraceResponseSchema.parse({
        traceId: "391dae938234560b16bb63f51501cb6f",
        spanId: "6bb63f51501cb6f1",
        name: "manual.hello",
      }),
    ).toEqual({
      traceId: "391dae938234560b16bb63f51501cb6f",
      spanId: "6bb63f51501cb6f1",
      name: "manual.hello",
    });
  });

  it("accepts a normalized trace detail response", () => {
    const result = TraceDetailResponseSchema.safeParse({
      traceId: "391dae938234560b16bb63f51501cb6f",
      // M9 W2：meta 变必填、span 加 statusMessage
      meta: {
        userInput: "",
        agentName: null,
        genModel: null,
        genModelVersion: null,
        promptVersionId: null,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: null,
        status: "success",
        qualitySignals: [],
      },
      spans: [
        {
          traceId: "391dae938234560b16bb63f51501cb6f",
          spanId: "6bb63f51501cb6f1",
          parentSpanId: null,
          name: "manual.hello",
          kind: "custom",
          startTime: "2026-07-05T00:00:00.000Z",
          durationMs: 12.5,
          statusCode: "Ok",
          statusMessage: null,
          attributes: { "codecrush.test": "hello" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed trace identifiers", () => {
    expect(
      HelloTraceResponseSchema.safeParse({
        traceId: "short",
        spanId: "also-short",
        name: "manual.hello",
      }).success,
    ).toBe(false);
  });
});

describe("M9 W2 详情契约", () => {
  const span = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: null,
    name: "rag.pipeline",
    kind: "chain",
    startTime: "2026-07-13T09:11:00.000Z",
    durationMs: 2410,
    statusCode: "Error",
    statusMessage: "first token timeout",
    attributes: { "codecrush.io.input": "怎么退款" },
  };
  const meta = {
    userInput: "怎么退款",
    agentName: "退款助手",
    genModel: "deepseek-v3",
    genModelVersion: null,
    promptVersionId: "cv1",
    durationMs: 2410,
    inputTokens: 1200,
    outputTokens: 200,
    cost: null,
    status: "success",
    qualitySignals: [],
  };

  it("TraceSpan 带 statusMessage(可空)", () => {
    expect(TraceSpanSchema.safeParse(span).success).toBe(true);
    expect(TraceSpanSchema.safeParse({ ...span, statusMessage: null }).success).toBe(true);
  });

  it("TraceDetailMeta 合法(含 null 字段)", () => {
    expect(TraceDetailMetaSchema.safeParse(meta).success).toBe(true);
  });

  it("TraceDetailResponse 带 meta + spans", () => {
    expect(TraceDetailResponseSchema.safeParse({ traceId: "a".repeat(32), meta, spans: [span] }).success).toBe(true);
  });

  it("缺 meta 拒绝", () => {
    expect(TraceDetailResponseSchema.safeParse({ traceId: "a".repeat(32), spans: [span] }).success).toBe(false);
  });
});

describe("M9 W1 trace 列表契约", () => {
  const row = {
    traceId: "a".repeat(32),
    sessionId: "conv1",
    agentId: "app1",
    agentName: "退款助手",
    userId: null,
    userInput: "怎么退款",
    status: "success",
    startTime: "2026-07-13T09:11:00.000Z",
    durationMs: 2410,
    inputTokens: 1200,
    outputTokens: 200,
    qualitySignals: ["no_citations"],
    promptVersionId: null,
  };

  it("accepts a valid TraceListRow", () => {
    expect(TraceListRowSchema.safeParse(row).success).toBe(true);
  });

  it("rejects out-of-enum qualitySignals", () => {
    expect(TraceListRowSchema.safeParse({ ...row, qualitySignals: ["nope"] }).success).toBe(false);
  });

  it("response status uses english tokens, not chinese", () => {
    expect(TraceStatusSchema.safeParse("兜底").success).toBe(false);
    expect(TraceStatusSchema.safeParse("fallback").success).toBe(true);
  });

  it("TraceListResponse = items + total + summary", () => {
    const res = {
      items: [row],
      total: 1,
      summary: { sampledTotal: 1, failRate: 0, failCount: 0, p95Ms: 2410, timeoutCount: 0 },
    };
    expect(TraceListResponseSchema.safeParse(res).success).toBe(true);
  });

  it("query uses chinese enums and coerces pagination", () => {
    const p = TraceListQuerySchema.safeParse({ status: "失败", quick: "慢请求", page: "2", pageSize: "50" });
    expect(p.success).toBe(true);
    if (p.success) {
      expect(p.data.page).toBe(2);
      expect(p.data.pageSize).toBe(50);
    }
  });

  it("query rejects pageSize over 100", () => {
    expect(TraceListQuerySchema.safeParse({ pageSize: "500" }).success).toBe(false);
  });

  it("accepts a valid SessionListRow", () => {
    const s = {
      sessionId: "conv1",
      userId: "u1",
      agentId: "app1",
      agentName: "退款助手",
      roundCount: 3,
      firstQuestion: "怎么退款",
      firstTs: "2026-07-13T09:11:00.000Z",
      lastTs: "2026-07-13T09:20:00.000Z",
      status: "has_fallback",
    };
    expect(SessionListRowSchema.safeParse(s).success).toBe(true);
  });

  it("QualitySignal has the four auto signals", () => {
    for (const v of ["low_recall", "no_citations", "refusal", "timeout"]) {
      expect(QualitySignalSchema.safeParse(v).success).toBe(true);
    }
  });
});
