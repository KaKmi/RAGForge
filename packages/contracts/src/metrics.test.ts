import { describe, expect, it } from "vitest";
import { MetricsAppResponseSchema, MetricsOverviewResponseSchema, MetricsQuerySchema } from "./metrics";

describe("MetricsQuerySchema", () => {
  it("接受可选 from/to/agentId/model", () => {
    const q = MetricsQuerySchema.parse({
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-14T00:00:00Z",
    });
    expect(q.from).toBe("2026-07-01T00:00:00Z");
    expect(q.agentId).toBeUndefined();
  });

  it("拒绝非 ISO from", () => {
    expect(() => MetricsQuerySchema.parse({ from: "not-a-date" })).toThrow();
  });
});

it("parses application stage latency and preserves unavailable stages as null", () => {
  const overview = MetricsOverviewResponseSchema.parse({
    window: {
      qaCount: 0, failCount: 0, failRate: 0, fallbackCount: 0, fallbackRate: 0,
      lowRecallCount: 0, noCiteCount: 0, refusalCount: 0, timeoutCount: 0,
      p50Ms: 0, p95Ms: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    },
    series: [],
  });
  const parsed = MetricsAppResponseSchema.parse({
    ...overview,
    stages: [{ stage: "rerank", sampleCount: 0, p50Ms: null, p95Ms: null }],
    signals: {
      ttft: { sampleCount: 0, p50Ms: null, p95Ms: null },
      generationRate: { sampleCount: 0, p50TokensPerSecond: null, p95TokensPerSecond: null },
      repair: { attemptCount: 0, eligibleCount: 0, rate: null },
      degradation: {
        keyword: { count: 0, eligibleCount: 0, rate: null },
        rerank: { count: 0, eligibleCount: 0, rate: null },
      },
      confidence: { sampleCount: 0, p50: null, buckets: [
        { key: "very_low", count: 0 }, { key: "low", count: 0 },
        { key: "medium", count: 0 }, { key: "high", count: 0 },
      ] },
      citations: { sampleCount: 0, averageCount: null, countBuckets: [
        { key: "none", count: 0 }, { key: "one", count: 0 },
        { key: "two_three", count: 0 }, { key: "four_plus", count: 0 },
      ], coverage: { full: 0, partial: 0, unknown: 0 } },
    },
  });
  expect(parsed.stages[0]).toEqual({ stage: "rerank", sampleCount: 0, p50Ms: null, p95Ms: null });
});

describe("MetricsOverviewResponseSchema", () => {
  it("校验 window + series 形状", () => {
    const r = MetricsOverviewResponseSchema.parse({
      window: {
        qaCount: 10,
        failCount: 1,
        failRate: 0.1,
        fallbackCount: 2,
        fallbackRate: 0.2,
        lowRecallCount: 1,
        noCiteCount: 1,
        refusalCount: 1,
        timeoutCount: 0,
        p50Ms: 1200,
        p95Ms: 3400,
        inputTokens: 500,
        outputTokens: 300,
        costUsd: 0,
      },
      series: [
        {
          bucket: "2026-07-14T08:00:00.000Z",
          qaCount: 5,
          failCount: 0,
          fallbackCount: 1,
          p50Ms: 1000,
          p95Ms: 3000,
          inputTokens: 200,
          outputTokens: 100,
          costUsd: 0,
        },
      ],
    });
    expect(r.series).toHaveLength(1);
  });
});
