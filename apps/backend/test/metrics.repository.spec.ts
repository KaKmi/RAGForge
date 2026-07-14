import { ClickHouseMetricsRepository } from "../src/modules/traces/clickhouse-metrics.repository";

function buildClient(rows: unknown[] = [], existsResult = 1, countResult = 0) {
  const command = jest.fn().mockResolvedValue(undefined);
  const query = jest.fn().mockImplementation(({ query: q }: { query: string }) => {
    if (q.includes("EXISTS TABLE")) return { json: async () => [{ result: existsResult }] };
    if (q.includes("count()")) return { json: async () => [{ c: countResult }] };
    return { json: async () => rows };
  });
  const client = { command, query } as unknown as ConstructorParameters<
    typeof ClickHouseMetricsRepository
  >[0];
  return { client, command, query };
}

describe("ClickHouseMetricsRepository.ensureMetricsViews", () => {
  it("冷库（otel_traces 不存在）不建 DDL", async () => {
    const { client, command } = buildClient([], 0);
    const repo = new ClickHouseMetricsRepository(client);
    expect(await repo.ensureMetricsViews()).toBe(false);
    expect(command).not.toHaveBeenCalled();
  });

  it("空表：建 DDL 两条 + backfill 一条（共 3 次 command）", async () => {
    const { client, command } = buildClient([], 1, 0);
    const repo = new ClickHouseMetricsRepository(client);
    expect(await repo.ensureMetricsViews()).toBe(true);
    expect(command).toHaveBeenCalledTimes(3);
    const backfill = (command.mock.calls[2]?.[0] as { query: string }).query;
    expect(backfill).toContain("LEFT JOIN");
    expect(backfill).toContain("child_input_tokens");
    expect(backfill).toContain("root.SpanAttributes['gen_ai.usage.input_tokens'] != ''");
    expect(backfill).toContain("rag.node.name'] = 'reply'");
  });

  it("非空表：只建 DDL 两条，跳过 backfill", async () => {
    const { client, command } = buildClient([], 1, 42);
    const repo = new ClickHouseMetricsRepository(client);
    await repo.ensureMetricsViews();
    expect(command).toHaveBeenCalledTimes(2);
  });
});

describe("getOverview", () => {
  it("窗口用 xxxMerge、series GROUP BY bucket；率由 count 计算", async () => {
    const windowRow = {
      bucketText: "2026-07-14 08:00:00",
      qaCount: 10,
      failCount: 2,
      fallbackCount: 3,
      lowRecallCount: 1,
      noCiteCount: 1,
      refusalCount: 1,
      timeoutCount: 0,
      p50Ms: 1000,
      p95Ms: 3000,
      inputTokens: 500,
      outputTokens: 300,
      costUsd: 0,
    };
    const { client, query } = buildClient([windowRow]);
    const repo = new ClickHouseMetricsRepository(client);
    const r = await repo.getOverview({});
    expect(r.window.failRate).toBeCloseTo(0.2);
    expect(r.window.fallbackRate).toBeCloseTo(0.3);
    expect(r.series[0]?.bucket).toBe("2026-07-14T08:00:00.000Z");
    const sqls = query.mock.calls
      .map(([call]) => (call as { query: string }).query)
      .join("\n");
    expect(sqls).toContain("quantileTDigestMerge");
    expect(sqls).toContain("codecrush_metrics_1m");
    expect(sqls).not.toContain("codecrush_metrics ");
    expect(sqls).toContain("toString(bucket) AS bucketText");
  });
});

describe("getAppMetrics", () => {
  it("按 chain 身份和时间/模型筛选阶段，并固定补齐无样本阶段", async () => {
    const query = jest.fn().mockImplementation(({ query: sql }: { query: string }) => {
      if (sql.includes("EXISTS TABLE")) return { json: async () => [{ result: 1 }] };
      if (sql.includes("SELECT count() AS c")) return { json: async () => [{ c: 1 }] };
      if (sql.includes("GROUP BY stage")) {
        return {
          json: async () => [
            { stage: "generation", sampleCount: 10, p50Ms: 900, p95Ms: 1800 },
            { stage: "retrieval", sampleCount: 8, p50Ms: 300, p95Ms: 700 },
          ],
        };
      }
      if (sql.includes("ttftSamples")) {
        return { json: async () => [{
          ttftSamples: 10, ttftP50: 200, ttftP95: 500,
          rateSamples: 8, rateP50: 24, rateP95: 40,
          repairAttempts: 2, repairEligible: 20,
          keywordCount: 1, keywordEligible: 8, rerankCount: 1, rerankEligible: 5,
          confidenceSamples: 8, confidenceP50: 0.75,
          confidenceVeryLow: 1, confidenceLow: 2, confidenceMedium: 3, confidenceHigh: 2,
          citationSamples: 10, citationAverage: 1.8,
          citationsNone: 2, citationsOne: 3, citationsTwoThree: 4, citationsFourPlus: 1,
          coverageFull: 6, coveragePartial: 3, coverageUnknown: 1,
        }] };
      }
      if (sql.includes("GROUP BY bucket")) return { json: async () => [] };
      return {
        json: async () => [{
          qaCount: 10, failCount: 0, fallbackCount: 0, lowRecallCount: 0,
          noCiteCount: 0, refusalCount: 0, timeoutCount: 0, p50Ms: 1000,
          p95Ms: 2000, inputTokens: 100, outputTokens: 50, costUsd: 0,
        }],
      };
    });
    const command = jest.fn().mockResolvedValue(undefined);
    const repo = new ClickHouseMetricsRepository({ command, query } as never);

    const result = await repo.getAppMetrics("app-1", {
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-08T00:00:00Z",
      model: "qwen-plus",
    });

    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "rewrite", "intent", "embedding", "retrieval", "rerank", "generation",
    ]);
    expect(result.stages.find((stage) => stage.stage === "rerank")).toEqual({
      stage: "rerank", sampleCount: 0, p50Ms: null, p95Ms: null,
    });
    expect(result.stages.find((stage) => stage.stage === "generation")?.p95Ms).toBe(1800);
    expect(result.signals.ttft).toEqual({ sampleCount: 10, p50Ms: 200, p95Ms: 500 });
    expect(result.signals.generationRate.p50TokensPerSecond).toBe(24);
    const signalCall = query.mock.calls.find(([call]) =>
      (call as { query: string }).query.includes("ttftSamples"),
    )?.[0] as { query: string };
    expect(signalCall.query).toContain("rag.keyword.requested_count");
    expect(signalCall.query).toContain("rag.citation.count'] != '' AND");

    const stageCall = query.mock.calls.find(([call]) =>
      (call as { query: string }).query.includes("GROUP BY stage"),
    )?.[0] as { query: string; query_params: Record<string, unknown> };
    expect(stageCall.query).toContain("root.kind = 'chain'");
    expect(stageCall.query).toContain("rag.preview");
    expect(stageCall.query).toContain("quantileTDigest(0.95)");
    expect(stageCall.query_params).toEqual({
      agentId: "app-1",
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-08T00:00:00Z",
      model: "qwen-plus",
    });
  });
});
