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
});
