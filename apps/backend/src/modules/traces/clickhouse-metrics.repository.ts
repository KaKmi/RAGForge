import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type {
  MetricsAppResponse,
  MetricsBucket,
  MetricsOverviewResponse,
  MetricsQuery,
  MetricsStage,
  MetricsStageKey,
  MetricsSignals,
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

const STAGE_ORDER: MetricsStageKey[] = [
  "rewrite",
  "intent",
  "embedding",
  "retrieval",
  "rerank",
  "generation",
];

const EMPTY_SIGNALS: MetricsSignals = {
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
    const scoped = { ...q, agentId };
    const overview = await this.getOverview(scoped);
    if (!(await this.ensureMetricsViews())) {
      return { ...overview, stages: this.emptyStages(), signals: EMPTY_SIGNALS };
    }
    const [stages, signals] = await Promise.all([this.queryStages(scoped), this.querySignals(scoped)]);
    return { ...overview, stages, signals };
  }

  private async querySignals(q: MetricsQuery): Promise<MetricsSignals> {
    const conds = [
      "SpanAttributes['codecrush.span.kind'] = 'chain'",
      "SpanAttributes['rag.preview'] != 'true'",
      "SpanAttributes['gen_ai.agent.id'] = {agentId:String}",
    ];
    const params: Record<string, unknown> = { agentId: q.agentId };
    if (q.from) { conds.push("Timestamp >= parseDateTimeBestEffortOrNull({from:String})"); params.from = q.from; }
    else conds.push("Timestamp >= now() - INTERVAL 1 DAY");
    if (q.to) { conds.push("Timestamp <= parseDateTimeBestEffortOrNull({to:String})"); params.to = q.to; }
    if (q.model) { conds.push("SpanAttributes['gen_ai.request.model'] = {model:String}"); params.model = q.model; }
    const result = await this.clickhouse.query({
      query: `${SIGNALS_SELECT} WHERE ${conds.join(" AND ")}`,
      query_params: params,
      format: "JSONEachRow",
    });
    const [row] = await result.json<Record<string, number | string>>();
    if (!row) return EMPTY_SIGNALS;
    const n = (key: string) => Number(row[key] ?? 0);
    const nullable = (key: string, samples: number) => samples ? n(key) : null;
    const ttftSamples = n("ttftSamples");
    const rateSamples = n("rateSamples");
    const repairEligible = n("repairEligible");
    const keywordEligible = n("keywordEligible");
    const rerankEligible = n("rerankEligible");
    const confidenceSamples = n("confidenceSamples");
    const citationSamples = n("citationSamples");
    const repairAttempts = n("repairAttempts");
    const keywordCount = n("keywordCount");
    const rerankCount = n("rerankCount");
    return {
      ttft: { sampleCount: ttftSamples, p50Ms: nullable("ttftP50", ttftSamples), p95Ms: nullable("ttftP95", ttftSamples) },
      generationRate: { sampleCount: rateSamples, p50TokensPerSecond: nullable("rateP50", rateSamples), p95TokensPerSecond: nullable("rateP95", rateSamples) },
      repair: { attemptCount: repairAttempts, eligibleCount: repairEligible, rate: repairEligible ? repairAttempts / repairEligible : null },
      degradation: {
        keyword: { count: keywordCount, eligibleCount: keywordEligible, rate: keywordEligible ? keywordCount / keywordEligible : null },
        rerank: { count: rerankCount, eligibleCount: rerankEligible, rate: rerankEligible ? rerankCount / rerankEligible : null },
      },
      confidence: { sampleCount: confidenceSamples, p50: nullable("confidenceP50", confidenceSamples), buckets: [
        { key: "very_low", count: n("confidenceVeryLow") }, { key: "low", count: n("confidenceLow") },
        { key: "medium", count: n("confidenceMedium") }, { key: "high", count: n("confidenceHigh") },
      ] },
      citations: { sampleCount: citationSamples, averageCount: nullable("citationAverage", citationSamples), countBuckets: [
        { key: "none", count: n("citationsNone") }, { key: "one", count: n("citationsOne") },
        { key: "two_three", count: n("citationsTwoThree") }, { key: "four_plus", count: n("citationsFourPlus") },
      ], coverage: { full: n("coverageFull"), partial: n("coveragePartial"), unknown: n("coverageUnknown") } },
    };
  }

  private emptyStages(): MetricsStage[] {
    return STAGE_ORDER.map((stage) => ({ stage, sampleCount: 0, p50Ms: null, p95Ms: null }));
  }

  private async queryStages(q: MetricsQuery): Promise<MetricsStage[]> {
    const conds = [
      "root.kind = 'chain'",
      "root.attributes['rag.preview'] != 'true'",
      "root.attributes['gen_ai.agent.id'] = {agentId:String}",
    ];
    const params: Record<string, unknown> = { agentId: q.agentId };
    if (q.from) {
      conds.push("root.start_time >= parseDateTimeBestEffortOrNull({from:String})");
      params.from = q.from;
    } else {
      conds.push("root.start_time >= now() - INTERVAL 1 DAY");
    }
    if (q.to) {
      conds.push("root.start_time <= parseDateTimeBestEffortOrNull({to:String})");
      params.to = q.to;
    }
    if (q.model) {
      conds.push("root.attributes['gen_ai.request.model'] = {model:String}");
      params.model = q.model;
    }
    const result = await this.clickhouse.query({
      query: `${STAGE_SELECT} WHERE ${conds.join(" AND ")}
) AS stage_spans
WHERE stage != ''
GROUP BY stage`,
      query_params: params,
      format: "JSONEachRow",
    });
    const rows = await result.json<{
      stage: MetricsStageKey;
      sampleCount: number | string;
      p50Ms: number | string;
      p95Ms: number | string;
    }>();
    const byStage = new Map(rows.map((row) => [row.stage, row]));
    return STAGE_ORDER.map((stage) => {
      const row = byStage.get(stage);
      return row
        ? {
            stage,
            sampleCount: Number(row.sampleCount),
            p50Ms: Number(row.p50Ms),
            p95Ms: Number(row.p95Ms),
          }
        : { stage, sampleCount: 0, p50Ms: null, p95Ms: null };
    });
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

const SIGNALS_SELECT = `SELECT
  countIf(SpanAttributes['rag.ttft_ms'] != '') AS ttftSamples,
  quantileTDigestIf(0.5)(toFloat64OrZero(SpanAttributes['rag.ttft_ms']), SpanAttributes['rag.ttft_ms'] != '') AS ttftP50,
  quantileTDigestIf(0.95)(toFloat64OrZero(SpanAttributes['rag.ttft_ms']), SpanAttributes['rag.ttft_ms'] != '') AS ttftP95,
  countIf(SpanAttributes['rag.generation.tokens_per_second'] != '') AS rateSamples,
  quantileTDigestIf(0.5)(toFloat64OrZero(SpanAttributes['rag.generation.tokens_per_second']), SpanAttributes['rag.generation.tokens_per_second'] != '') AS rateP50,
  quantileTDigestIf(0.95)(toFloat64OrZero(SpanAttributes['rag.generation.tokens_per_second']), SpanAttributes['rag.generation.tokens_per_second'] != '') AS rateP95,
  sum(toUInt64OrZero(SpanAttributes['rag.repair.attempt_count'])) AS repairAttempts,
  sum(toUInt64OrZero(SpanAttributes['rag.repair.eligible_count'])) AS repairEligible,
  sum(toUInt64OrZero(SpanAttributes['rag.degraded.keyword_recall.count'])) AS keywordCount,
  sum(toUInt64OrZero(SpanAttributes['rag.keyword.requested_count'])) AS keywordEligible,
  sum(toUInt64OrZero(SpanAttributes['rag.degraded.rerank.count'])) AS rerankCount,
  sum(toUInt64OrZero(SpanAttributes['rag.rerank.requested_count'])) AS rerankEligible,
  countIf(SpanAttributes['rag.quality.confidence'] != '') AS confidenceSamples,
  quantileTDigestIf(0.5)(toFloat64OrZero(SpanAttributes['rag.quality.confidence']), SpanAttributes['rag.quality.confidence'] != '') AS confidenceP50,
  countIf(toFloat64OrZero(SpanAttributes['rag.quality.confidence']) < 0.4 AND SpanAttributes['rag.quality.confidence'] != '') AS confidenceVeryLow,
  countIf(toFloat64OrZero(SpanAttributes['rag.quality.confidence']) >= 0.4 AND toFloat64OrZero(SpanAttributes['rag.quality.confidence']) < 0.7) AS confidenceLow,
  countIf(toFloat64OrZero(SpanAttributes['rag.quality.confidence']) >= 0.7 AND toFloat64OrZero(SpanAttributes['rag.quality.confidence']) < 0.9) AS confidenceMedium,
  countIf(toFloat64OrZero(SpanAttributes['rag.quality.confidence']) >= 0.9) AS confidenceHigh,
  countIf(SpanAttributes['rag.citation.count'] != '') AS citationSamples,
  avgIf(toFloat64OrZero(SpanAttributes['rag.citation.count']), SpanAttributes['rag.citation.count'] != '') AS citationAverage,
  countIf(SpanAttributes['rag.citation.count'] = '0') AS citationsNone,
  countIf(SpanAttributes['rag.citation.count'] = '1') AS citationsOne,
  countIf(toUInt64OrZero(SpanAttributes['rag.citation.count']) BETWEEN 2 AND 3) AS citationsTwoThree,
  countIf(toUInt64OrZero(SpanAttributes['rag.citation.count']) >= 4) AS citationsFourPlus,
  countIf(SpanAttributes['rag.citation.coverage'] = 'full') AS coverageFull,
  countIf(SpanAttributes['rag.citation.coverage'] = 'partial') AS coveragePartial,
  countIf(SpanAttributes['rag.citation.count'] != '' AND SpanAttributes['rag.citation.coverage'] NOT IN ('full','partial')) AS coverageUnknown
FROM otel_traces`;

const STAGE_SELECT = `SELECT stage, count() AS sampleCount,
  quantileTDigest(0.5)(duration_ms) AS p50Ms,
  quantileTDigest(0.95)(duration_ms) AS p95Ms
FROM (
  SELECT
    multiIf(
      s.kind = 'llm' AND s.attributes['rag.node.name'] = 'rewrite', 'rewrite',
      s.kind = 'llm' AND s.attributes['rag.node.name'] = 'intent', 'intent',
      s.name = 'retrieval.embedding', 'embedding',
      s.name = 'retrieval.retrieve', 'retrieval',
      s.name = 'retrieval.rerank', 'rerank',
      s.kind = 'llm' AND s.attributes['rag.node.name'] IN ('reply', 'fallback'), 'generation',
      ''
    ) AS stage,
    s.duration_ms AS duration_ms
  FROM codecrush_trace_spans AS s
  INNER JOIN codecrush_trace_spans AS root ON root.trace_id = s.trace_id`;

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
