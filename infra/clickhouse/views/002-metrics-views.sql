-- 016 W-a：指标汇总层。表存可合并聚合态；MV 只读根 chain span（每行一 trace，依赖 D-metrics）增量卷积；
-- 不建 finalize 读 VIEW（D2′：跨应用/跨桶分位须合并 state，读侧对本表直接 xxxMerge）。
CREATE TABLE IF NOT EXISTS codecrush_metrics_1m
(
  bucket           DateTime,
  agent_id         LowCardinality(String),
  gen_model        LowCardinality(String),
  qa_count         AggregateFunction(count),
  fail_count       AggregateFunction(sum, UInt64),
  fallback_count   AggregateFunction(sum, UInt64),
  low_recall_count AggregateFunction(sum, UInt64),
  no_cite_count    AggregateFunction(sum, UInt64),
  refusal_count    AggregateFunction(sum, UInt64),
  timeout_count    AggregateFunction(sum, UInt64),
  dur_tdigest      AggregateFunction(quantileTDigest, Float64),
  input_tokens     AggregateFunction(sum, UInt64),
  output_tokens    AggregateFunction(sum, UInt64),
  cost_usd         AggregateFunction(sum, Float64)
)
ENGINE = AggregatingMergeTree
ORDER BY (bucket, agent_id, gen_model);

-- 只读根 chain span（每行一 trace），排除 preview；bucket=分钟桶；耗时纳秒→毫秒（对齐 001:10）。
CREATE MATERIALIZED VIEW IF NOT EXISTS codecrush_metrics_1m_mv TO codecrush_metrics_1m AS
SELECT
  toStartOfMinute(Timestamp) AS bucket,
  SpanAttributes['gen_ai.agent.id'] AS agent_id,
  SpanAttributes['gen_ai.request.model'] AS gen_model,
  countState() AS qa_count,
  sumState(toUInt64(StatusCode IN ('Error', 'STATUS_CODE_ERROR'))) AS fail_count,
  sumState(toUInt64(SpanAttributes['rag.fallback.used'] = 'true')) AS fallback_count,
  sumState(toUInt64(SpanAttributes['rag.quality.low_recall'] = 'true')) AS low_recall_count,
  sumState(toUInt64(SpanAttributes['rag.quality.no_citations'] = 'true')) AS no_cite_count,
  sumState(toUInt64(SpanAttributes['rag.quality.refusal'] = 'true')) AS refusal_count,
  sumState(toUInt64(SpanAttributes['rag.quality.timeout'] = 'true')) AS timeout_count,
  quantileTDigestState(toFloat64(Duration) / 1000000) AS dur_tdigest,
  sumState(toUInt64OrZero(SpanAttributes['gen_ai.usage.input_tokens'])) AS input_tokens,
  sumState(toUInt64OrZero(SpanAttributes['gen_ai.usage.output_tokens'])) AS output_tokens,
  sumState(toFloat64OrZero(SpanAttributes['rag.cost.usd'])) AS cost_usd
FROM otel_traces
WHERE SpanAttributes['codecrush.span.kind'] = 'chain'
  AND SpanAttributes['rag.preview'] != 'true'
GROUP BY bucket, agent_id, gen_model;
