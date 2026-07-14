import { describe, expect, it } from "vitest";
import { MetricsOverviewResponseSchema, MetricsQuerySchema } from "./metrics";

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
