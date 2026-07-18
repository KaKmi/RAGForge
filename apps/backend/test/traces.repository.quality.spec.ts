import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { ClickHouseTracesRepository } from "../src/modules/traces/clickhouse-traces.repository";
import { ClickHouseEvaluationsRepository } from "../src/modules/evaluations/clickhouse-evaluations.repository";
import { clickHouseGate } from "./helpers/gated-suite";

const describeClickHouse = clickHouseGate();
const marker = "ew1-task7-pagination";
const targetIds = Array.from(
  { length: 45 },
  (_, index) => `c0de${index.toString(16).padStart(28, "0")}`,
);
const unscoredTraceId = "cafe" + "0".repeat(28);

function rawSpan(
  traceId: string,
  spanId: string,
  at: string,
  name: string,
  attributes: Record<string, string>,
) {
  return {
    Timestamp: at,
    TraceId: traceId,
    SpanId: spanId,
    ParentSpanId: "",
    TraceState: "",
    SpanName: name,
    SpanKind: "SPAN_KIND_INTERNAL",
    ServiceName: "codecrush-backend",
    ResourceAttributes: {},
    ScopeName: "ew1-test",
    ScopeVersion: "1",
    SpanAttributes: { ...attributes, "codecrush.test.run": marker },
    Duration: 1_000_000,
    StatusCode: "STATUS_CODE_OK",
    StatusMessage: "",
    Events: [],
    Links: [],
  };
}

describeClickHouse("Trace quality pagination", () => {
  let client: ClickHouseClient;
  let repository: ClickHouseTracesRepository;
  let evaluations: ClickHouseEvaluationsRepository;

  beforeAll(async () => {
    client = createClient({ url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123" });
    repository = new ClickHouseTracesRepository(client as never);
    evaluations = new ClickHouseEvaluationsRepository(client as never);
    await repository.listTraces({ page: 1, pageSize: 1, agentId: "ew1-task7-agent" });

    const roots = targetIds.map((traceId, index) =>
      rawSpan(traceId, traceId.slice(0, 16), "2026-07-15 01:00:00.000000000", "rag.pipeline", {
        "codecrush.span.kind": "chain",
        "gen_ai.agent.id": "ew1-task7-agent",
        "gen_ai.agent.name": "E-W1 Task 7 Agent",
        "codecrush.io.input": `question-${index}`,
      }),
    );
    roots.push(
      rawSpan(
        unscoredTraceId,
        unscoredTraceId.slice(0, 16),
        "2026-07-15 01:00:00.000000000",
        "rag.pipeline",
        {
          "codecrush.span.kind": "chain",
          "gen_ai.agent.id": "ew1-task7-agent",
          "gen_ai.agent.name": "E-W1 Task 7 Agent",
          "codecrush.io.input": "unscored question",
        },
      ),
    );
    const evaluationSpans = targetIds.flatMap((targetTraceId, index) => {
      const score = index % 5;
      const base = [
        rawSpan(
          `d0de${index.toString(16).padStart(28, "0")}`,
          `d0de${index.toString(16).padStart(12, "0")}`,
          "2026-07-15 01:30:00.000000000",
          "rag.eval",
          {
            "rag.eval.target_trace_id": targetTraceId,
            "rag.eval.version": "online-v1",
            "rag.eval.status": "success",
            "rag.eval.faithfulness": String(index === 0 ? 40 : score),
            "rag.eval.answer_relevancy": "80",
            "rag.eval.context_precision": "80",
            "gen_ai.agent.id": "ew1-task7-agent",
            "gen_ai.request.model": "generation-1",
          },
        ),
      ];
      if (index === 0) {
        base.push(
          rawSpan(
            "e0de" + "0".repeat(28),
            "e0de" + "0".repeat(12),
            "2026-07-15 02:00:00.000000000",
            "rag.eval",
            {
              "rag.eval.target_trace_id": targetTraceId,
              "rag.eval.version": "online-v2",
              "rag.eval.status": "success",
              "rag.eval.faithfulness": "-1",
              "rag.eval.answer_relevancy": "90",
              "rag.eval.context_precision": "90",
              "gen_ai.agent.id": "ew1-task7-agent",
              "gen_ai.request.model": "generation-1",
            },
          ),
        );
      }
      return base;
    });
    await client.insert({
      table: "otel_traces",
      format: "JSONEachRow",
      values: [...roots, ...evaluationSpans],
      clickhouse_settings: { input_format_defaults_for_omitted_fields: 1 },
    });
  });

  afterAll(async () => {
    await client.command({
      query:
        "ALTER TABLE otel_traces DELETE WHERE SpanAttributes['codecrush.test.run'] = {marker:String}",
      query_params: { marker },
      clickhouse_settings: { mutations_sync: 2 },
    });
    await client.command({
      query: "ALTER TABLE codecrush_eval_targets DELETE WHERE startsWith(target_trace_id, 'c0de')",
      clickhouse_settings: { mutations_sync: 2 },
    });
    await client.close();
  });

  it("keeps scored rows stable and excludes null faithfulness from metric filtering", async () => {
    const query = {
      pageSize: 20,
      agentId: "ew1-task7-agent",
      evalMetric: "faithfulness" as const,
      evalSort: "asc" as const,
    };
    const pages = await Promise.all(
      [1, 2, 3].map((page) => repository.listTraces({ ...query, page })),
    );
    const rows = pages.flatMap((page) => page.items);
    expect(pages.map((page) => page.items.length)).toEqual([20, 20, 4]);
    expect(pages.every((page) => page.total === 44)).toBe(true);
    expect(new Set(rows.map((row) => row.traceId)).size).toBe(44);
    expect(rows.some((row) => row.traceId === unscoredTraceId)).toBe(false);
    expect(rows.some((row) => row.traceId === targetIds[0])).toBe(false);
    await expect(evaluations.getLatestSuccess(targetIds[0])).resolves.toMatchObject({
      judgeVersion: "online-v2",
      faithfulness: null,
    });
  });

  it("maps the v2 faithfulness sentinel to null without hiding other scores", async () => {
    const page = await repository.listTraces({
      page: 1,
      pageSize: 100,
      agentId: "ew1-task7-agent",
    });
    expect(page.items.find((row) => row.traceId === targetIds[0])?.evaluation).toMatchObject({
      status: "scored",
      judgeVersion: "online-v2",
      scores: { faithfulness: null, answerRelevancy: 90, contextPrecision: 90 },
      minMetric: "answerRelevancy",
      minScore: 90,
    });
  });
});
