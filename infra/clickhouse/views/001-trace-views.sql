-- M9 W2：改 CREATE OR REPLACE 使新增列（status_message）对既有 VIEW 生效；补投影 StatusMessage 供错误框 errMsg。
CREATE OR REPLACE VIEW codecrush_trace_spans AS
SELECT
  TraceId AS trace_id,
  SpanId AS span_id,
  nullIf(ParentSpanId, '') AS parent_span_id,
  SpanName AS name,
  if(SpanAttributes['codecrush.span.kind'] = '', toString(SpanKind), SpanAttributes['codecrush.span.kind']) AS kind,
  Timestamp AS start_time,
  toFloat64(Duration) / 1000000 AS duration_ms,
  toString(StatusCode) AS status_code,
  StatusMessage AS status_message,
  SpanAttributes AS attributes
FROM otel_traces;

-- M9 W1：每 trace 一行——从 chain 根 span 取身份/IO/状态/质量；token 根值优先，旧 trace 回退子 span 求和。
-- SpanAttributes = Map(String,String)：布尔读 = 'true'，数字读 toUInt64OrZero。
-- root 过滤 = kind='chain' 单条件：HTTP 自动埋点（HttpInstrumentation）给每请求加 POST server 根 span，
-- rag.pipeline chain span 是其子（ParentSpanId≠''），故不能用 ParentSpanId='' 认根——chain 才是 RAG 一轮的语义根。
-- StatusCode 字面量真库校验为 Ok/Error（此处 IN 防御另一常见写法）。
CREATE OR REPLACE VIEW codecrush_traces AS
SELECT
  root.TraceId AS trace_id,
  root.SpanAttributes['session.id'] AS session_id,
  root.SpanAttributes['gen_ai.agent.id'] AS agent_id,
  root.SpanAttributes['gen_ai.agent.name'] AS agent_name,
  root.SpanAttributes['enduser.id'] AS user_id,
  root.SpanAttributes['codecrush.io.input'] AS user_input,
  root.SpanAttributes['codecrush.io.output'] AS output,
  root.Timestamp AS start_time,
  toFloat64(root.Duration) / 1000000 AS total_duration_ms,
  if(
    root.SpanAttributes['gen_ai.usage.input_tokens'] != '',
    toUInt64OrZero(root.SpanAttributes['gen_ai.usage.input_tokens']),
    agg.child_input_tokens
  ) AS total_input_tokens,
  if(
    root.SpanAttributes['gen_ai.usage.output_tokens'] != '',
    toUInt64OrZero(root.SpanAttributes['gen_ai.usage.output_tokens']),
    agg.child_output_tokens
  ) AS total_output_tokens,
  multiIf(
    root.StatusCode IN ('Error', 'STATUS_CODE_ERROR'), 'failed',
    root.SpanAttributes['rag.fallback.used'] = 'true', 'fallback',
    'success') AS status,
  root.SpanAttributes['rag.quality.low_recall'] = 'true' AS low_recall,
  root.SpanAttributes['rag.quality.no_citations'] = 'true' AS no_citations,
  root.SpanAttributes['rag.quality.refusal'] = 'true' AS refusal,
  root.SpanAttributes['rag.quality.timeout'] = 'true' AS timeout,
  root.SpanAttributes['rag.prompt.version_id'] AS prompt_version_id,
  root.SpanAttributes['rag.preview'] = 'true' AS preview
FROM otel_traces AS root
LEFT JOIN (
  SELECT TraceId,
    sumIf(
      toUInt64OrZero(SpanAttributes['gen_ai.usage.input_tokens']),
      SpanAttributes['codecrush.span.kind'] = 'llm'
    ) AS child_input_tokens,
    sumIf(
      toUInt64OrZero(SpanAttributes['gen_ai.usage.output_tokens']),
      SpanAttributes['codecrush.span.kind'] = 'llm'
    ) AS child_output_tokens
  FROM otel_traces GROUP BY TraceId
) AS agg ON root.TraceId = agg.TraceId
WHERE root.SpanAttributes['codecrush.span.kind'] = 'chain';

-- M9 W1：每 session 一行——over codecrush_traces，按 session_id 聚合；排除 preview（试运行不入正式统计）。
CREATE VIEW IF NOT EXISTS codecrush_sessions AS
SELECT
  session_id,
  argMax(user_id, start_time) AS user_id,
  argMax(agent_id, start_time) AS agent_id,
  argMax(agent_name, start_time) AS agent_name,
  count() AS round_count,
  argMin(user_input, start_time) AS first_question,
  min(start_time) AS first_ts,
  max(start_time) AS last_ts,
  multiIf(
    countIf(status = 'failed') > 0, 'has_failure',
    countIf(status = 'fallback') > 0, 'has_fallback',
    'normal') AS status
FROM codecrush_traces
WHERE preview = 0 AND session_id != ''
GROUP BY session_id;
