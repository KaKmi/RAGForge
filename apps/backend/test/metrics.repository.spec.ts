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
      bucket: "2026-07-14 08:00:00",
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
    const sqls = query.mock.calls
      .map(([call]) => (call as { query: string }).query)
      .join("\n");
    expect(sqls).toContain("quantileTDigestMerge");
    expect(sqls).toContain("codecrush_metrics_1m");
    expect(sqls).not.toContain("codecrush_metrics ");
  });
});
