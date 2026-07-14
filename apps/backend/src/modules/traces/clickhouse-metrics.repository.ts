import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type {
  MetricsAppResponse,
  MetricsBucket,
  MetricsOverviewResponse,
  MetricsQuery,
  MetricsWindow,
} from "@codecrush/contracts";
import { CLICKHOUSE } from "../../platform/clickhouse/clickhouse.constants";
import type { CodeCrushClickHouseClient } from "../../platform/clickhouse/clickhouse.types";
import { loadSqlStatements, otelTracesTableExists, toIsoUtc } from "./clickhouse-view.utils";

const METRICS_VIEW_SQL_RELPATH = "infra/clickhouse/views/002-metrics-views.sql";

const EMPTY_WINDOW: MetricsWindow = {
  qaCount: 0,
  failCount: 0,
  failRate: 0,
  fallbackCount: 0,
  fallbackRate: 0,
  lowRecallCount: 0,
  noCiteCount: 0,
  refusalCount: 0,
  timeoutCount: 0,
  p50Ms: 0,
  p95Ms: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
};

@Injectable()
export class ClickHouseMetricsRepository implements OnModuleInit {
  private ready = false;

  constructor(@Inject(CLICKHOUSE) private readonly clickhouse: CodeCrushClickHouseClient) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureMetricsViews();
    } catch {
      // 冷库或 ClickHouse 未就绪：不阻断启动，留给首次读 lazy 兜底。
    }
  }

  private async exporterTableExists(): Promise<boolean> {
    return otelTracesTableExists(this.clickhouse);
  }

  async ensureMetricsViews(): Promise<boolean> {
    if (this.ready) return true;
    if (!(await this.exporterTableExists())) return false;

    const statements = await loadSqlStatements(METRICS_VIEW_SQL_RELPATH);
    for (const stmt of statements) {
      await this.clickhouse.command({ query: stmt });
    }

    const cnt = await this.clickhouse.query({
      query: "SELECT count() AS c FROM codecrush_metrics_1m",
      format: "JSONEachRow",
    });
    const cRows = await cnt.json<{ c: number | string }>();
    if (Number(cRows[0]?.c ?? 0) === 0) {
      await this.clickhouse.command({ query: BACKFILL_SQL });
    }
    this.ready = true;
    return true;
  }

  async getOverview(q: MetricsQuery): Promise<MetricsOverviewResponse> {
    if (!(await this.ensureMetricsViews())) return { window: EMPTY_WINDOW, series: [] };
    const { where, params } = this.buildWhere(q);
    const [window, series] = await Promise.all([
      this.queryWindow(where, params),
      this.querySeries(where, params),
    ]);
    return { window, series };
  }

  async getAppMetrics(agentId: string, q: MetricsQuery): Promise<MetricsAppResponse> {
    return this.getOverview({ ...q, agentId });
  }

  private buildWhere(q: MetricsQuery): { where: string; params: Record<string, unknown> } {
    const conds: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.from) {
      conds.push("bucket >= parseDateTimeBestEffortOrNull({from:String})");
      params.from = q.from;
    } else {
      conds.push("bucket >= now() - INTERVAL 1 DAY");
    }
    if (q.to) {
      conds.push("bucket <= parseDateTimeBestEffortOrNull({to:String})");
      params.to = q.to;
    }
    if (q.agentId) {
      conds.push("agent_id = {agentId:String}");
      params.agentId = q.agentId;
    }
    if (q.model) {
      conds.push("gen_model = {model:String}");
      params.model = q.model;
    }
    return { where: `WHERE ${conds.join(" AND ")}`, params };
  }

  private async queryWindow(
    where: string,
    params: Record<string, unknown>,
  ): Promise<MetricsWindow> {
    const res = await this.clickhouse.query({
      query: `${WINDOW_SELECT} ${where}`,
      query_params: params,
      format: "JSONEachRow",
    });
    const [row] = await res.json<Record<string, number | string>>();
    if (!row) return EMPTY_WINDOW;
    const n = (v: unknown) => Number(v ?? 0);
    const qaCount = n(row.qaCount);
    const failCount = n(row.failCount);
    const fallbackCount = n(row.fallbackCount);
    return {
      qaCount,
      failCount,
      failRate: qaCount ? failCount / qaCount : 0,
      fallbackCount,
      fallbackRate: qaCount ? fallbackCount / qaCount : 0,
      lowRecallCount: n(row.lowRecallCount),
      noCiteCount: n(row.noCiteCount),
      refusalCount: n(row.refusalCount),
      timeoutCount: n(row.timeoutCount),
      p50Ms: n(row.p50Ms),
      p95Ms: n(row.p95Ms),
      inputTokens: n(row.inputTokens),
      outputTokens: n(row.outputTokens),
      costUsd: n(row.costUsd),
    };
  }

  private async querySeries(
    where: string,
    params: Record<string, unknown>,
  ): Promise<MetricsBucket[]> {
    const res = await this.clickhouse.query({
      query: `${SERIES_SELECT} ${where} GROUP BY bucket ORDER BY bucket`,
      query_params: params,
      format: "JSONEachRow",
    });
    const rows = await res.json<Record<string, number | string>>();
    const n = (v: unknown) => Number(v ?? 0);
    return rows.map((r) => ({
      bucket: toIsoUtc(String(r.bucketText)),
      qaCount: n(r.qaCount),
      failCount: n(r.failCount),
      fallbackCount: n(r.fallbackCount),
      p50Ms: n(r.p50Ms),
      p95Ms: n(r.p95Ms),
      inputTokens: n(r.inputTokens),
      outputTokens: n(r.outputTokens),
      costUsd: n(r.costUsd),
    }));
  }
}

const WINDOW_SELECT = `SELECT
  countMerge(qa_count) AS qaCount, sumMerge(fail_count) AS failCount,
  sumMerge(fallback_count) AS fallbackCount, sumMerge(low_recall_count) AS lowRecallCount,
  sumMerge(no_cite_count) AS noCiteCount, sumMerge(refusal_count) AS refusalCount,
  sumMerge(timeout_count) AS timeoutCount,
  quantileTDigestMerge(0.5)(dur_tdigest) AS p50Ms, quantileTDigestMerge(0.95)(dur_tdigest) AS p95Ms,
  sumMerge(input_tokens) AS inputTokens, sumMerge(output_tokens) AS outputTokens, sumMerge(cost_usd) AS costUsd
FROM codecrush_metrics_1m`;

const SERIES_SELECT = `SELECT toString(bucket) AS bucketText,
  countMerge(qa_count) AS qaCount, sumMerge(fail_count) AS failCount, sumMerge(fallback_count) AS fallbackCount,
  quantileTDigestMerge(0.5)(dur_tdigest) AS p50Ms, quantileTDigestMerge(0.95)(dur_tdigest) AS p95Ms,
  sumMerge(input_tokens) AS inputTokens, sumMerge(output_tokens) AS outputTokens, sumMerge(cost_usd) AS costUsd
FROM codecrush_metrics_1m`;

const BACKFILL_SQL = `INSERT INTO codecrush_metrics_1m
SELECT
  toStartOfMinute(root.Timestamp) AS bucket,
  root.SpanAttributes['gen_ai.agent.id'] AS agent_id,
  if(
    root.SpanAttributes['gen_ai.request.model'] != '',
    root.SpanAttributes['gen_ai.request.model'],
    child.reply_model
  ) AS gen_model,
  countState(),
  sumState(toUInt64(root.StatusCode IN ('Error','STATUS_CODE_ERROR'))),
  sumState(toUInt64(root.SpanAttributes['rag.fallback.used']='true')),
  sumState(toUInt64(root.SpanAttributes['rag.quality.low_recall']='true')),
  sumState(toUInt64(root.SpanAttributes['rag.quality.no_citations']='true')),
  sumState(toUInt64(root.SpanAttributes['rag.quality.refusal']='true')),
  sumState(toUInt64(root.SpanAttributes['rag.quality.timeout']='true')),
  quantileTDigestState(toFloat64(root.Duration)/1000000),
  sumState(if(
    root.SpanAttributes['gen_ai.usage.input_tokens'] != '',
    toUInt64OrZero(root.SpanAttributes['gen_ai.usage.input_tokens']),
    child.child_input_tokens
  )),
  sumState(if(
    root.SpanAttributes['gen_ai.usage.output_tokens'] != '',
    toUInt64OrZero(root.SpanAttributes['gen_ai.usage.output_tokens']),
    child.child_output_tokens
  )),
  sumState(toFloat64OrZero(root.SpanAttributes['rag.cost.usd']))
FROM otel_traces AS root
LEFT JOIN
(
  SELECT
    TraceId,
    sumIf(
      toUInt64OrZero(SpanAttributes['gen_ai.usage.input_tokens']),
      SpanAttributes['codecrush.span.kind'] = 'llm'
    ) AS child_input_tokens,
    sumIf(
      toUInt64OrZero(SpanAttributes['gen_ai.usage.output_tokens']),
      SpanAttributes['codecrush.span.kind'] = 'llm'
    ) AS child_output_tokens,
    argMaxIf(
      SpanAttributes['gen_ai.request.model'],
      Timestamp,
      SpanAttributes['rag.node.name'] = 'reply'
    ) AS reply_model
  FROM otel_traces
  GROUP BY TraceId
) AS child ON child.TraceId = root.TraceId
WHERE root.SpanAttributes['codecrush.span.kind']='chain'
  AND root.SpanAttributes['rag.preview']!='true'
GROUP BY bucket, agent_id, gen_model`;
