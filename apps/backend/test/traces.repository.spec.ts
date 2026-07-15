import {
  ClickHouseTracesRepository,
  EMPTY_TRACE_META,
} from "../src/modules/traces/clickhouse-traces.repository";
import type { CodeCrushClickHouseClient } from "../src/platform/clickhouse/clickhouse.types";

type QueryCall = { query: string };

function buildClient(opts: { tableExists: boolean; rows?: unknown[] }) {
  const queries: QueryCall[] = [];
  const commands: QueryCall[] = [];
  const client = {
    query: jest.fn(async ({ query }: QueryCall) => {
      queries.push({ query });
      if (query.startsWith("EXISTS TABLE")) {
        return { json: async () => [{ result: opts.tableExists ? 1 : 0 }] };
      }
      return { json: async () => opts.rows ?? [] };
    }),
    command: jest.fn(async (call: QueryCall) => {
      commands.push(call);
    }),
  };
  return { client: client as unknown as CodeCrushClickHouseClient, queries, commands, raw: client };
}

describe("ClickHouseTracesRepository E-W1 quality list", () => {
  function setupQualityList() {
    const built = buildRoutingClient({
      tableExists: true,
      summaryRow: { total: 0, failCount: 0, p95Ms: 0, timeoutCount: 0 },
    });
    return { repo: new ClickHouseTracesRepository(built.client), raw: built.raw };
  }

  function qualityListSql(raw: ReturnType<typeof buildRoutingClient>["raw"]): string {
    return raw.query.mock.calls
      .map(([call]: [QueryCall]) => call.query)
      .find((sql: string) => sql.includes("LIMIT {limit:UInt32}"))!;
  }

  function qualityCountSql(raw: ReturnType<typeof buildRoutingClient>["raw"]): string {
    return raw.query.mock.calls
      .map(([call]: [QueryCall]) => call.query)
      .find((sql: string) => sql.includes("count() AS total"))!;
  }

  it("filters by precision and keeps stable ascending metric ordering", async () => {
    const { repo, raw } = setupQualityList();
    await repo.listTraces({ page: 1, pageSize: 20, evalMetric: "precision", evalMax: 70 });
    const sql = qualityListSql(raw);
    expect(sql).toContain("context_precision <= {evalMax:Float64}");
    expect(sql).toContain(
      "argMax(tuple(faithfulness, answer_relevancy, context_precision, judge_version, evaluated_at), evaluated_at)",
    );
    expect(sql).toContain(
      "ORDER BY context_precision ASC NULLS LAST, start_time DESC, trace_id DESC",
    );
  });

  it("uses any metric below 70 for the low verdict", async () => {
    const { repo, raw } = setupQualityList();
    await repo.listTraces({ page: 1, pageSize: 20, evalVerdict: "low" });
    expect(qualityListSql(raw)).toContain(
      "least(faithfulness, answer_relevancy, context_precision) < 70",
    );
  });

  it("joins one latest evaluation row in both list and count queries", async () => {
    const { repo, raw } = setupQualityList();
    await repo.listTraces({
      page: 2,
      pageSize: 20,
      evalMetric: "faithfulness",
      evalSort: "desc",
    });
    expect(qualityListSql(raw)).toContain(
      "ORDER BY faithfulness DESC NULLS LAST, start_time DESC, trace_id DESC",
    );
    expect(qualityCountSql(raw)).toContain("LEFT JOIN eval_latest USING (trace_id)");
    expect(qualityCountSql(raw)).toContain("GROUP BY target_trace_id");
  });

  it("ignores evalSort without a selected metric", async () => {
    const { repo, raw } = setupQualityList();
    await repo.listTraces({ page: 1, pageSize: 20, evalSort: "desc" });
    expect(qualityListSql(raw)).toContain("ORDER BY start_time DESC, trace_id DESC");
    expect(qualityListSql(raw)).not.toContain("NULLS LAST");
  });
});

describe("ClickHouseTracesRepository", () => {
  it("returns empty spans without DDL when exporter table does not exist (cold DB)", async () => {
    const { client, raw } = buildClient({ tableExists: false });
    const repo = new ClickHouseTracesRepository(client);
    // M9 W2：冷库返回零值 meta（仍满足契约）
    await expect(repo.findByTraceId("391dae938234560b16bb63f51501cb6f")).resolves.toEqual({
      traceId: "391dae938234560b16bb63f51501cb6f",
      meta: EMPTY_TRACE_META,
      spans: [],
    });
    expect(raw.command).not.toHaveBeenCalled();
  });

  it("assembles detail meta from spans (M9 W2)", async () => {
    const { client } = buildClient({
      tableExists: true,
      rows: [
        {
          trace_id: "a".repeat(32),
          span_id: "root".padEnd(16, "0"),
          parent_span_id: null,
          name: "rag.pipeline",
          kind: "chain",
          start_time: "2026-07-13 09:11:00.000",
          duration_ms: 2410,
          status_code: "Ok",
          status_message: "",
          attributes: {
            "codecrush.io.input": "怎么退款",
            "gen_ai.agent.name": "退款助手",
            "gen_ai.usage.input_tokens": "1200",
            "gen_ai.usage.output_tokens": "200",
            "rag.prompt.version_id": "cv1",
            "rag.fallback.used": "false",
            "rag.quality.low_recall": "false",
            "rag.quality.no_citations": "false",
            "rag.quality.refusal": "false",
            "rag.quality.timeout": "false",
          },
        },
        {
          trace_id: "a".repeat(32),
          span_id: "reply".padEnd(16, "0"),
          parent_span_id: "root".padEnd(16, "0"),
          name: "node.reply",
          kind: "llm",
          start_time: "2026-07-13 09:11:01.000",
          duration_ms: 1700,
          status_code: "Ok",
          status_message: "",
          attributes: {
            "rag.node.name": "reply",
            "gen_ai.request.model": "deepseek-v3",
            "gen_ai.usage.input_tokens": "1200",
            "gen_ai.usage.output_tokens": "200",
          },
        },
      ],
    });
    const repo = new ClickHouseTracesRepository(client);
    const res = await repo.findByTraceId("a".repeat(32));
    expect(res.meta).toMatchObject({
      userInput: "怎么退款",
      agentName: "退款助手",
      genModel: "deepseek-v3",
      genModelVersion: null,
      promptVersionId: "cv1",
      inputTokens: 1200,
      outputTokens: 200,
      cost: null,
      status: "success",
    });
    expect(res.spans[0].statusMessage).toBeNull();
  });

  it("reads the generation model from the D-metrics chain root without an LLM child", async () => {
    const { client } = buildClient({
      tableExists: true,
      rows: [
        {
          trace_id: "a".repeat(32),
          span_id: "root".padEnd(16, "0"),
          parent_span_id: null,
          name: "rag.pipeline",
          kind: "chain",
          start_time: "2026-07-13 09:11:00.000",
          duration_ms: 2410,
          status_code: "Ok",
          status_message: "",
          attributes: {
            "gen_ai.request.model": "root-model",
          },
        },
      ],
    });
    const repo = new ClickHouseTracesRepository(client);

    const res = await repo.findByTraceId("a".repeat(32));

    expect(res.meta.genModel).toBe("root-model");
  });

  it("finds chain root via kind even when it has an HTTP-server parent (M9 fix)", async () => {
    const { client } = buildClient({
      tableExists: true,
      rows: [
        // HTTP 自动埋点根 span（真实场景：POST server span 是 trace 根）
        {
          trace_id: "a".repeat(32),
          span_id: "http".padEnd(16, "0"),
          parent_span_id: null,
          name: "POST /api/chat",
          kind: "Server",
          start_time: "2026-07-13 09:11:00.000",
          duration_ms: 2600,
          status_code: "Ok",
          status_message: "",
          attributes: {},
        },
        {
          trace_id: "a".repeat(32),
          span_id: "chain".padEnd(16, "0"),
          parent_span_id: "http".padEnd(16, "0"), // chain 挂在 HTTP span 下
          name: "rag.pipeline",
          kind: "chain",
          start_time: "2026-07-13 09:11:00.050",
          duration_ms: 2400,
          status_code: "Ok",
          status_message: "",
          attributes: {
            "codecrush.io.input": "怎么退款",
            "gen_ai.agent.name": "退款助手",
            "rag.prompt.version_id": "cv1",
          },
        },
      ],
    });
    const repo = new ClickHouseTracesRepository(client);
    const res = await repo.findByTraceId("a".repeat(32));
    // 根按 kind='chain' 认出（非 parentSpanId===null 的 HTTP span）→ meta 非空
    expect(res.meta.userInput).toBe("怎么退款");
    expect(res.meta.agentName).toBe("退款助手");
    expect(res.meta.durationMs).toBe(2400); // chain span 耗时，非 HTTP 的 2600
  });

  it("creates the view once and caches readiness across reads", async () => {
    const { client, raw } = buildClient({
      tableExists: true,
      rows: [
        {
          trace_id: "391dae938234560b16bb63f51501cb6f",
          span_id: "6bb63f51501cb6f1",
          parent_span_id: null,
          name: "manual.hello",
          kind: "custom",
          start_time: "2026-07-05 08:00:00.123456789",
          duration_ms: 1.5,
          status_code: "Ok",
          attributes: { "codecrush.test": "hello" },
        },
      ],
    });
    const repo = new ClickHouseTracesRepository(client);

    const first = await repo.findByTraceId("391dae938234560b16bb63f51501cb6f");
    expect(first.spans[0]).toMatchObject({
      name: "manual.hello",
      parentSpanId: null,
      startTime: "2026-07-05T08:00:00.123Z", // UTC 毫秒 ISO（无本地时区偏移）
    });
    // M9 W1：VIEW 文件含 3 个 CREATE VIEW（spans/traces/sessions），逐条执行 → 3 次 command
    expect(raw.command).toHaveBeenCalledTimes(3);

    await repo.findByTraceId("391dae938234560b16bb63f51501cb6f");
    // 第二次读：viewsReady 缓存生效，不再 EXISTS 探测、不再执行 VIEW DDL
    expect(raw.command).toHaveBeenCalledTimes(3);
    const existsProbes = raw.query.mock.calls.filter(([arg]: [QueryCall]) =>
      arg.query.startsWith("EXISTS TABLE"),
    );
    expect(existsProbes).toHaveLength(1);
  });
});

// M9 W1：listTraces / summarize / listSessions —— 路由式 fake client 按查询内容分派预置行
function buildRoutingClient(opts: {
  tableExists: boolean;
  tracesRows?: unknown[];
  summaryRow?: unknown;
  sessionRows?: unknown[];
}) {
  const commands: QueryCall[] = [];
  const client = {
    query: jest.fn(async ({ query }: QueryCall) => {
      if (query.startsWith("EXISTS TABLE"))
        return { json: async () => [{ result: opts.tableExists ? 1 : 0 }] };
      if (query.includes("codecrush_sessions")) return { json: async () => opts.sessionRows ?? [] };
      if (query.includes("quantile(0.95)")) return { json: async () => (opts.summaryRow ? [opts.summaryRow] : []) };
      if (query.includes("codecrush_traces")) return { json: async () => opts.tracesRows ?? [] };
      return { json: async () => [] };
    }),
    command: jest.fn(async (call: QueryCall) => {
      commands.push(call);
    }),
  };
  return { client: client as unknown as CodeCrushClickHouseClient, commands, raw: client };
}

const emptySummary = { sampledTotal: 0, failRate: 0, failCount: 0, p95Ms: 0, timeoutCount: 0 };

describe("ClickHouseTracesRepository · M9 W1 list/session", () => {
  it("cold DB → empty list/sessions, no DDL", async () => {
    const { client, raw } = buildRoutingClient({ tableExists: false });
    const repo = new ClickHouseTracesRepository(client);
    expect(await repo.listTraces({ page: 1, pageSize: 20 })).toEqual({ items: [], total: 0, summary: emptySummary });
    expect(await repo.listSessions()).toEqual([]);
    expect(raw.command).not.toHaveBeenCalled();
  });

  it("ensureTraceViews runs each CREATE VIEW separately (3 statements)", async () => {
    const { client, raw } = buildRoutingClient({ tableExists: true });
    const repo = new ClickHouseTracesRepository(client);
    await repo.listSessions();
    // M9 W2：spans VIEW 改 CREATE OR REPLACE，故匹配两种形式
    const createViewCmds = raw.command.mock.calls.filter(([c]: [QueryCall]) =>
      /CREATE (OR REPLACE )?VIEW/i.test(c.query),
    );
    expect(createViewCmds).toHaveLength(3);
    const tracesView = createViewCmds
      .map(([c]: [QueryCall]) => c.query)
      .find((query: string) => query.includes("codecrush_traces AS"));
    expect(tracesView).toContain("root.SpanAttributes['gen_ai.usage.input_tokens'] != ''");
    expect(tracesView).toContain("agg.child_input_tokens");
  });

  it("listTraces maps status/tokens/qualitySignals/startTime + summary", async () => {
    const { client } = buildRoutingClient({
      tableExists: true,
      tracesRows: [
        {
          trace_id: "a".repeat(32),
          session_id: "conv1",
          agent_id: "app1",
          agent_name: "退款助手",
          user_id: "u1",
          user_input: "怎么退款",
          output: "…",
          start_time: "2026-07-13 09:11:00.000",
          total_duration_ms: 2410,
          total_input_tokens: "1200",
          total_output_tokens: "200",
          status: "success",
          low_recall: 0,
          no_citations: 1,
          refusal: 0,
          timeout: 0,
          prompt_version_id: "pv1",
          preview: 0,
        },
      ],
      summaryRow: { total: "1", failCount: "0", p95Ms: "2410", timeoutCount: "0" },
    });
    const repo = new ClickHouseTracesRepository(client);
    const res = await repo.listTraces({ page: 1, pageSize: 20 });
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({
      status: "success",
      inputTokens: 1200,
      outputTokens: 200,
      qualitySignals: ["no_citations"],
      startTime: "2026-07-13T09:11:00.000Z",
      userId: "u1",
      promptVersionId: "pv1",
    });
    expect(res.summary).toEqual({ sampledTotal: 1, failRate: 0, failCount: 0, p95Ms: 2410, timeoutCount: 0 });
  });

  it("listTraces empty user_id → null; failRate computed", async () => {
    const { client } = buildRoutingClient({
      tableExists: true,
      tracesRows: [
        {
          trace_id: "b".repeat(32), session_id: "conv2", agent_id: "app1", agent_name: "退款助手",
          user_id: "", user_input: "x", output: "y", start_time: "2026-07-13 10:00:00.000",
          total_duration_ms: 6000, total_input_tokens: null, total_output_tokens: null,
          status: "failed", low_recall: 1, no_citations: 1, refusal: 1, timeout: 1,
          prompt_version_id: "", preview: 0,
        },
      ],
      summaryRow: { total: "4", failCount: "1", p95Ms: "6000", timeoutCount: "1" },
    });
    const repo = new ClickHouseTracesRepository(client);
    const res = await repo.listTraces({ page: 1, pageSize: 20 });
    expect(res.items[0].userId).toBeNull();
    expect(res.items[0].promptVersionId).toBeNull();
    expect(res.items[0].inputTokens).toBe(0);
    expect(res.items[0].qualitySignals).toEqual(["low_recall", "no_citations", "refusal", "timeout"]);
    expect(res.summary.failRate).toBeCloseTo(0.25);
  });

  it("stage uses a spans semi-join and composes with application/time filters", async () => {
    const { client, raw } = buildRoutingClient({ tableExists: true });
    const repo = new ClickHouseTracesRepository(client);
    await repo.listTraces({
      stage: "rerank", agentId: "app1",
      from: "2026-07-01T00:00:00Z", to: "2026-07-08T00:00:00Z",
      page: 1, pageSize: 20,
    });
    const sql = raw.query.mock.calls
      .map(([call]: [{ query: string }]) => call.query)
      .filter((query: string) => query.includes("codecrush_traces"))
      .join("\n");
    expect(sql).toContain("trace_id IN (SELECT trace_id FROM codecrush_trace_spans");
    expect(sql).toContain("name = 'retrieval.rerank'");
    expect(sql).toContain("agent_id = {agentId:String}");
    expect(sql).toContain("start_time >= parseDateTimeBestEffortOrNull");
  });

  it.each([
    ["repair", "rag.repair.attempt_count"],
    ["keyword_degraded", "rag.degraded.keyword_recall.count"],
    ["rerank_degraded", "rag.degraded.rerank.count"],
    ["confidence_very_low", "rag.quality.confidence"],
    ["confidence_low", "rag.quality.confidence"],
    ["confidence_medium", "rag.quality.confidence"],
    ["confidence_high", "rag.quality.confidence"],
    ["citations_none", "rag.citation.count"],
    ["citations_one", "rag.citation.count"],
    ["citations_two_three", "rag.citation.count"],
    ["citations_four_plus", "rag.citation.count"],
    ["coverage_full", "rag.citation.coverage"],
    ["coverage_partial", "rag.citation.coverage"],
  ] as const)("signal %s uses the typed root-span predicate %s", async (signal, attribute) => {
    const { client, raw } = buildRoutingClient({ tableExists: true });
    const repo = new ClickHouseTracesRepository(client);
    await repo.listTraces({ signal, model: "deepseek-chat", page: 1, pageSize: 20 });
    const calls = raw.query.mock.calls
      .map(([call]: [{ query: string; query_params?: Record<string, unknown> }]) => call)
      .filter((call: { query: string }) => call.query.includes("codecrush_traces"));
    expect(calls.every((call: { query: string }) => call.query.includes(attribute))).toBe(true);
    expect(calls.every((call: { query: string }) => call.query.includes("attributes['gen_ai.request.model'] = {model:String}"))).toBe(true);
    expect(calls.every((call: { query_params?: Record<string, unknown> }) => call.query_params?.model === "deepseek-chat")).toBe(true);
  });

  it("uses stable ordering for candidate pagination", async () => {
    const { client, raw } = buildRoutingClient({ tableExists: true });
    await new ClickHouseTracesRepository(client).listTraces({ page: 1, pageSize: 20 });
    const itemSql = raw.query.mock.calls
      .map(([call]: [{ query: string }]) => call.query)
      .find((sql: string) => sql.includes("LIMIT {limit:UInt32}"));
    expect(itemSql).toContain("ORDER BY start_time DESC, trace_id DESC");
  });

  it("listSessions maps rows", async () => {
    const { client } = buildRoutingClient({
      tableExists: true,
      sessionRows: [
        {
          session_id: "conv1", user_id: "u1", agent_id: "app1", agent_name: "退款助手",
          round_count: "3", first_question: "怎么退款", first_ts: "2026-07-13 09:11:00.000",
          last_ts: "2026-07-13 09:20:00.000", status: "has_fallback",
        },
      ],
    });
    const repo = new ClickHouseTracesRepository(client);
    const rows = await repo.listSessions();
    expect(rows[0]).toEqual({
      sessionId: "conv1", userId: "u1", agentId: "app1", agentName: "退款助手",
      roundCount: 3, firstQuestion: "怎么退款",
      firstTs: "2026-07-13T09:11:00.000Z", lastTs: "2026-07-13T09:20:00.000Z", status: "has_fallback",
    });
  });

  // M9 W3：Session 详情——从 codecrush_traces 按 session_id 聚多轮，每行一轮
  it("findSessionById maps rounds + derives meta (user_input/output/status/duration)", async () => {
    const { client } = buildClient({
      tableExists: true,
      rows: [
        { trace_id: "a".repeat(32), session_id: "conv1", agent_id: "app1", agent_name: "退款助手", user_id: "u1", user_input: "怎么退款", output: "答案A[1]", start_time: "2026-07-13 09:11:00.000", total_duration_ms: "2410", status: "success" },
        { trace_id: "b".repeat(32), session_id: "conv1", agent_id: "app1", agent_name: "退款助手", user_id: "u1", user_input: "多久到账", output: "很抱歉，暂时无法回答。", start_time: "2026-07-13 09:12:00.000", total_duration_ms: "1500", status: "fallback" },
      ],
    });
    const repo = new ClickHouseTracesRepository(client);
    const res = await repo.findSessionById("conv1");
    expect(res).toMatchObject({ sessionId: "conv1", userId: "u1", agentId: "app1", agentName: "退款助手" });
    expect(res.rounds).toHaveLength(2);
    expect(res.rounds[0]).toEqual({ traceId: "a".repeat(32), userInput: "怎么退款", output: "答案A[1]", status: "success", durationMs: 2410, startTime: "2026-07-13T09:11:00.000Z" });
    expect(res.rounds[1].status).toBe("fallback");
  });

  it("findSessionById 冷库（exporter 表未建）→ 空 rounds、不建 VIEW", async () => {
    const { client, raw } = buildClient({ tableExists: false });
    const repo = new ClickHouseTracesRepository(client);
    await expect(repo.findSessionById("conv1")).resolves.toEqual({
      sessionId: "conv1", userId: null, agentId: "", agentName: "", rounds: [],
    });
    expect(raw.command).not.toHaveBeenCalled();
  });
});
