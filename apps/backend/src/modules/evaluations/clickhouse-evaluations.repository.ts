import { Inject, Injectable } from "@nestjs/common";
import { CLICKHOUSE } from "../../platform/clickhouse/clickhouse.constants";
import type { CodeCrushClickHouseClient } from "../../platform/clickhouse/clickhouse.types";
import {
  loadSqlStatements,
  otelTracesTableExists,
  toIsoUtc,
} from "../../platform/clickhouse/clickhouse-view.utils";

const TRACE_VIEW_SQL_RELPATH = "infra/clickhouse/views/001-trace-views.sql";
const EVAL_VIEW_SQL_RELPATH = "infra/clickhouse/views/003-eval-views.sql";

const EVAL_BACKFILL_SQL = `
  INSERT INTO codecrush_eval_targets
  SELECT
    SpanAttributes['rag.eval.target_trace_id'] AS target_trace_id,
    SpanAttributes['rag.eval.version'] AS judge_version,
    argMaxState(Timestamp, Timestamp) AS evaluated_at_state,
    argMaxState(SpanAttributes['gen_ai.agent.id'], Timestamp) AS agent_id_state,
    argMaxState(SpanAttributes['gen_ai.request.model'], Timestamp) AS generation_model_state,
    argMaxState(toFloat64OrZero(SpanAttributes['rag.eval.faithfulness']), Timestamp) AS faithfulness_state,
    argMaxState(toFloat64OrZero(SpanAttributes['rag.eval.answer_relevancy']), Timestamp) AS answer_relevancy_state,
    argMaxState(toFloat64OrZero(SpanAttributes['rag.eval.context_precision']), Timestamp) AS context_precision_state
  FROM otel_traces
  WHERE SpanName = 'rag.eval'
    AND SpanAttributes['rag.eval.status'] = 'success'
    AND SpanAttributes['rag.eval.target_trace_id'] != ''
    AND SpanAttributes['rag.eval.version'] != ''
  GROUP BY target_trace_id, judge_version
`;

const LATEST_EVAL_SQL = `
  SELECT
    target_trace_id,
    judge_version,
    argMaxMerge(evaluated_at_state) AS evaluated_at,
    argMaxMerge(agent_id_state) AS agent_id,
    argMaxMerge(generation_model_state) AS generation_model,
    argMaxMerge(faithfulness_state) AS faithfulness,
    argMaxMerge(answer_relevancy_state) AS answer_relevancy,
    argMaxMerge(context_precision_state) AS context_precision
  FROM codecrush_eval_targets
  GROUP BY target_trace_id, judge_version
`;

export interface EvaluationCursor {
  lastTs: Date;
  lastTraceId: string;
}

export interface EvaluationCandidate {
  traceId: string;
  startTime: Date;
  agentId: string;
  generationModel: string;
  status: "success" | "fallback" | "failed";
  noCitations: boolean;
  confidence: number | null;
  retrievalChunks: Array<{ chunkId: string; finalScore: number }>;
}

export interface EvaluationReadWindow {
  from: Date | string;
  to: Date | string;
  judgeVersion: string;
  agentId?: string;
}

export interface EvaluationAggregate {
  sampleCount: number;
  faithfulness: number | null;
  answerRelevancy: number | null;
  contextPrecision: number | null;
}

export interface EvaluationMinuteAggregate extends EvaluationAggregate {
  bucket: string;
}

export interface EvaluationAgentAggregate extends EvaluationAggregate {
  agentId: string;
  agentName: string;
}

export interface LatestEvaluationSuccess {
  targetTraceId: string;
  judgeVersion: string;
  evaluatedAt: string;
  judgeModel: string;
  faithfulness: number;
  answerRelevancy: number;
  contextPrecision: number;
  evidence: string;
}

export interface LatestEvaluationFailure {
  judgeVersion: string;
  failedAt: string;
  reason: string;
}

export interface EvaluationLowSample {
  targetTraceId: string;
  question: string;
  faithfulness: number;
  answerRelevancy: number;
  contextPrecision: number;
  evidence: string;
}

export interface EvaluationThresholds {
  faithfulness: number;
  answerRelevancy: number;
  contextPrecision: number;
}

type CandidateRow = {
  trace_id: string;
  start_time: string;
  agent_id: string;
  status: EvaluationCandidate["status"];
  no_citations: number | boolean | string;
  generation_model: string;
  confidence: number | string | null;
  chunk_score_payloads: string[];
};

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseRetrievalChunks(payloads: string[]): EvaluationCandidate["retrievalChunks"] {
  const chunks: EvaluationCandidate["retrievalChunks"] = [];
  for (const payload of payloads ?? []) {
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const chunkId = (item as { chunkId?: unknown }).chunkId;
        const finalScore = (item as { final?: unknown }).final;
        if (typeof chunkId === "string" && Number.isFinite(Number(finalScore))) {
          chunks.push({ chunkId, finalScore: Number(finalScore) });
        }
      }
    } catch {
      // One malformed retrieval span must not discard other valid span references.
    }
  }
  return chunks;
}

@Injectable()
export class ClickHouseEvaluationsRepository {
  private traceViewsReady = false;
  private evalViewsReady = false;

  constructor(@Inject(CLICKHOUSE) private readonly clickhouse: CodeCrushClickHouseClient) {}

  private async ensureCandidateViews(): Promise<boolean> {
    if (this.traceViewsReady) return true;
    if (!(await otelTracesTableExists(this.clickhouse))) return false;
    const statements = await loadSqlStatements(TRACE_VIEW_SQL_RELPATH);
    for (const statement of statements) {
      await this.clickhouse.command({ query: statement });
    }
    this.traceViewsReady = true;
    return true;
  }

  private async ensureEvalViews(): Promise<boolean> {
    if (this.evalViewsReady) return true;
    if (!(await this.ensureCandidateViews())) return false;
    for (const statement of await loadSqlStatements(EVAL_VIEW_SQL_RELPATH)) {
      await this.clickhouse.command({ query: statement });
    }
    const result = await this.clickhouse.query({
      query: "SELECT count() AS count FROM codecrush_eval_targets",
      format: "JSONEachRow",
    });
    const [row] = await result.json<{ count: number | string }>();
    if (Number(row?.count ?? 0) === 0) await this.clickhouse.command({ query: EVAL_BACKFILL_SQL });
    this.evalViewsReady = true;
    return true;
  }

  async backfillForTest(): Promise<void> {
    if (!(await this.ensureEvalViews())) return;
    await this.clickhouse.command({ query: EVAL_BACKFILL_SQL });
  }

  async listCandidates(
    cursor: EvaluationCursor,
    upperBound: Date,
    limit: number,
  ): Promise<EvaluationCandidate[]> {
    if (!(await this.ensureCandidateViews())) return [];
    const result = await this.clickhouse.query({
      query: `
        SELECT
          t.trace_id,
          t.start_time,
          t.agent_id,
          t.status,
          t.no_citations,
          spans.generation_model,
          nullIf(spans.confidence_text, '') AS confidence,
          spans.chunk_score_payloads
        FROM codecrush_traces AS t
        LEFT JOIN (
          SELECT
            trace_id,
            argMaxIf(
              attributes['gen_ai.request.model'],
              start_time,
              kind = 'llm' AND attributes['rag.node.name'] IN ('reply', 'fallback')
            ) AS generation_model,
            argMaxIf(attributes['rag.quality.confidence'], start_time, kind = 'chain') AS confidence_text,
            groupArrayIf(
              attributes['rag.chunk.scores'],
              attributes['rag.chunk.scores'] != ''
            ) AS chunk_score_payloads
          FROM codecrush_trace_spans
          GROUP BY trace_id
        ) AS spans ON spans.trace_id = t.trace_id
        WHERE t.preview = 0
          AND (t.start_time, t.trace_id) > ({lastTs:DateTime64(9)}, {lastTraceId:String})
          AND t.start_time <= {upperBound:DateTime64(9)}
        ORDER BY t.start_time ASC, t.trace_id ASC
        LIMIT {limit:UInt32}
      `,
      query_params: {
        lastTs: toClickHouseDateTime(cursor.lastTs),
        lastTraceId: cursor.lastTraceId,
        upperBound: toClickHouseDateTime(upperBound),
        limit,
      },
      format: "JSONEachRow",
    });
    const rows = await result.json<CandidateRow>();
    return rows.map((row) => ({
      traceId: row.trace_id,
      startTime: new Date(toIsoUtc(row.start_time)),
      agentId: row.agent_id ?? "",
      generationModel: row.generation_model ?? "",
      status: row.status,
      noCitations: truthy(row.no_citations),
      confidence: row.confidence === null || row.confidence === "" ? null : Number(row.confidence),
      retrievalChunks: parseRetrievalChunks(row.chunk_score_payloads),
    }));
  }

  async findExisting(
    targetTraceId: string,
    judgeVersion: string,
  ): Promise<{ targetTraceId: string } | undefined> {
    const result = await this.clickhouse.query({
      query: `
        SELECT SpanAttributes['rag.eval.target_trace_id'] AS target_trace_id
        FROM otel_traces
        WHERE SpanName = 'rag.eval'
          AND SpanAttributes['rag.eval.status'] = 'success'
          AND SpanAttributes['rag.eval.target_trace_id'] = {targetTraceId:String}
          AND SpanAttributes['rag.eval.version'] = {judgeVersion:String}
        ORDER BY Timestamp DESC
        LIMIT 1
      `,
      query_params: { targetTraceId, judgeVersion },
      format: "JSONEachRow",
    });
    const [row] = await result.json<{ target_trace_id: string }>();
    return row ? { targetTraceId: row.target_trace_id } : undefined;
  }

  async getMinuteAggregates(window: EvaluationReadWindow): Promise<EvaluationMinuteAggregate[]> {
    if (!(await this.ensureEvalViews())) return [];
    const result = await this.clickhouse.query({
      query: `
        SELECT
          toStartOfMinute(evaluated_at) AS bucket,
          count() AS sample_count,
          avg(faithfulness) AS faithfulness,
          avg(answer_relevancy) AS answer_relevancy,
          avg(context_precision) AS context_precision
        FROM (${LATEST_EVAL_SQL})
        WHERE judge_version = {judgeVersion:String}
          AND evaluated_at >= {from:DateTime64(9)}
          AND evaluated_at < {to:DateTime64(9)}
          AND ({agentId:String} = '' OR agent_id = {agentId:String})
        GROUP BY bucket
        ORDER BY bucket
      `,
      query_params: this.windowParams(window),
      format: "JSONEachRow",
    });
    const rows = await result.json<AggregateRow & { bucket: string }>();
    return rows.map((row) => ({ bucket: toIsoUtc(row.bucket), ...toAggregate(row) }));
  }

  async getOverview(window: EvaluationReadWindow): Promise<EvaluationAggregate> {
    if (!(await this.ensureEvalViews())) return emptyAggregate();
    const result = await this.clickhouse.query({
      query: `
        SELECT
          count() AS sample_count,
          avg(faithfulness) AS faithfulness,
          avg(answer_relevancy) AS answer_relevancy,
          avg(context_precision) AS context_precision
        FROM (
          SELECT
            target_trace_id,
            judge_version,
            argMaxMerge(evaluated_at_state) AS evaluated_at,
            toStartOfMinute(argMaxMerge(evaluated_at_state)) AS bucket,
            argMaxMerge(agent_id_state) AS agent_id,
            argMaxMerge(faithfulness_state) AS faithfulness,
            argMaxMerge(answer_relevancy_state) AS answer_relevancy,
            argMaxMerge(context_precision_state) AS context_precision
          FROM codecrush_eval_targets
          GROUP BY target_trace_id, judge_version
        )
        WHERE judge_version = {judgeVersion:String}
          AND evaluated_at >= {from:DateTime64(9)}
          AND evaluated_at < {to:DateTime64(9)}
          AND ({agentId:String} = '' OR agent_id = {agentId:String})
      `,
      query_params: this.windowParams(window),
      format: "JSONEachRow",
    });
    const [row] = await result.json<AggregateRow>();
    return row ? toAggregate(row) : emptyAggregate();
  }

  async getByAgent(window: EvaluationReadWindow): Promise<EvaluationAgentAggregate[]> {
    if (!(await this.ensureEvalViews())) return [];
    const result = await this.clickhouse.query({
      query: `
        SELECT eligible.agent_id, eligible.agent_name,
          coalesce(evaluated.sample_count, 0) AS sample_count,
          if(coalesce(evaluated.sample_count, 0) = 0, NULL, evaluated.faithfulness) AS faithfulness,
          if(coalesce(evaluated.sample_count, 0) = 0, NULL, evaluated.answer_relevancy) AS answer_relevancy,
          if(coalesce(evaluated.sample_count, 0) = 0, NULL, evaluated.context_precision) AS context_precision
        FROM (
          SELECT agent_id, argMax(agent_name, start_time) AS agent_name
          FROM codecrush_traces
          WHERE preview = 0 AND agent_id != ''
            AND start_time >= {from:DateTime64(9)} AND start_time < {to:DateTime64(9)}
            AND ({agentId:String} = '' OR agent_id = {agentId:String})
          GROUP BY agent_id
        ) AS eligible
        LEFT JOIN (
          SELECT agent_id, count() AS sample_count,
            avg(faithfulness) AS faithfulness,
            avg(answer_relevancy) AS answer_relevancy,
            avg(context_precision) AS context_precision
          FROM (${LATEST_EVAL_SQL})
          WHERE judge_version = {judgeVersion:String}
            AND evaluated_at >= {from:DateTime64(9)} AND evaluated_at < {to:DateTime64(9)}
            AND ({agentId:String} = '' OR agent_id = {agentId:String})
          GROUP BY agent_id
        ) AS evaluated USING (agent_id)
        ORDER BY sample_count DESC, agent_id
      `,
      query_params: this.windowParams(window),
      format: "JSONEachRow",
    });
    const rows = await result.json<AggregateRow & { agent_id: string; agent_name: string }>();
    return rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name || row.agent_id,
      ...toAggregate(row),
    }));
  }

  async countEligible(from: Date, to: Date, agentId?: string): Promise<number> {
    if (!(await this.ensureCandidateViews())) return 0;
    const result = await this.clickhouse.query({
      query: `SELECT count() AS count FROM codecrush_traces
        WHERE preview = 0 AND start_time >= {from:DateTime64(9)} AND start_time < {to:DateTime64(9)}
          AND ({agentId:String} = '' OR agent_id = {agentId:String})`,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
        agentId: agentId ?? "",
      },
      format: "JSONEachRow",
    });
    const [row] = await result.json<{ count: number | string }>();
    return Number(row?.count ?? 0);
  }

  // 窗口内且仍在游标之后 —— 只有这些还有机会被评。游标已越过的 trace 永不回头。
  async countEvaluable(
    from: Date,
    to: Date,
    cursor: EvaluationCursor,
    agentId?: string,
  ): Promise<number> {
    if (!(await this.ensureCandidateViews())) return 0;
    const result = await this.clickhouse.query({
      query: `SELECT count() AS count FROM codecrush_traces
        WHERE preview = 0
          AND (start_time, trace_id) > ({lastTs:DateTime64(9)}, {lastTraceId:String})
          AND start_time >= {from:DateTime64(9)} AND start_time < {to:DateTime64(9)}
          AND ({agentId:String} = '' OR agent_id = {agentId:String})`,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
        lastTs: toClickHouseDateTime(cursor.lastTs),
        lastTraceId: cursor.lastTraceId,
        agentId: agentId ?? "",
      },
      format: "JSONEachRow",
    });
    const [row] = await result.json<{ count: number | string }>();
    return Number(row?.count ?? 0);
  }

  // 谓词必须与 listCandidates 同源（严格元组游标 + start_time <= 上界），否则数出的不是 worker
  // 实际会取的候选集。曾用 countEligible 的 `start_time >= lastTs` 代替：finishCycle 把水位线
  // 压在最后一条处理过的 trace 上，含端比较把那条已处理的 trace 永远算作待处理 ⇒ 静默超过
  // LAG_BUFFER 即恒 backlog=1 ⇒ 页面永久「评测滞后」。
  async countBacklog(cursor: EvaluationCursor, before: Date): Promise<number> {
    if (!(await this.ensureCandidateViews())) return 0;
    const result = await this.clickhouse.query({
      query: `SELECT count() AS count FROM codecrush_traces
        WHERE preview = 0
          AND (start_time, trace_id) > ({lastTs:DateTime64(9)}, {lastTraceId:String})
          AND start_time <= {before:DateTime64(9)}`,
      query_params: {
        lastTs: toClickHouseDateTime(cursor.lastTs),
        lastTraceId: cursor.lastTraceId,
        before: toClickHouseDateTime(before),
      },
      format: "JSONEachRow",
    });
    const [row] = await result.json<{ count: number | string }>();
    return Number(row?.count ?? 0);
  }

  async getLatestSuccess(targetTraceId: string): Promise<LatestEvaluationSuccess | undefined> {
    if (!(await this.ensureEvalViews())) return undefined;
    const result = await this.clickhouse.query({
      query: `
        SELECT latest.*, raw.judge_model, raw.evidence
        FROM (${LATEST_EVAL_SQL}) AS latest
        LEFT JOIN (
          SELECT
            SpanAttributes['rag.eval.target_trace_id'] AS target_trace_id,
            SpanAttributes['rag.eval.version'] AS judge_version,
            argMax(SpanAttributes['rag.eval.judge_model'], Timestamp) AS judge_model,
            argMax(SpanAttributes['codecrush.io.output'], Timestamp) AS evidence
          FROM otel_traces
          WHERE SpanName = 'rag.eval' AND SpanAttributes['rag.eval.status'] = 'success'
          GROUP BY target_trace_id, judge_version
        ) AS raw USING (target_trace_id, judge_version)
        WHERE target_trace_id = {targetTraceId:String}
        ORDER BY evaluated_at DESC
        LIMIT 1
      `,
      query_params: { targetTraceId },
      format: "JSONEachRow",
    });
    const [row] = await result.json<LatestSuccessRow>();
    if (!row) return undefined;
    return {
      targetTraceId: row.target_trace_id,
      judgeVersion: row.judge_version,
      evaluatedAt: toIsoUtc(row.evaluated_at),
      judgeModel: row.judge_model,
      faithfulness: Number(row.faithfulness),
      answerRelevancy: Number(row.answer_relevancy),
      contextPrecision: Number(row.context_precision),
      evidence: row.evidence ?? "",
    };
  }

  async getLatestFailure(targetTraceId: string): Promise<LatestEvaluationFailure | undefined> {
    if (!(await this.ensureCandidateViews())) return undefined;
    const result = await this.clickhouse.query({
      query: `SELECT Timestamp AS failed_at,
          SpanAttributes['rag.eval.version'] AS judge_version,
          SpanAttributes['error.type'] AS error_type,
          SpanAttributes['error.message'] AS error_message
        FROM otel_traces
        WHERE SpanName = 'rag.eval' AND SpanAttributes['rag.eval.status'] = 'failed'
          AND SpanAttributes['rag.eval.target_trace_id'] = {targetTraceId:String}
        ORDER BY Timestamp DESC LIMIT 1`,
      query_params: { targetTraceId },
      format: "JSONEachRow",
    });
    const [row] = await result.json<FailureRow>();
    if (!row) return undefined;
    const reason = `${row.error_type.trim()}: ${row.error_message.trim()}`.slice(0, 200);
    return { judgeVersion: row.judge_version, failedAt: toIsoUtc(row.failed_at), reason };
  }

  async getLowSamples(
    window: EvaluationReadWindow,
    thresholds: EvaluationThresholds,
    limit = 10,
  ): Promise<EvaluationLowSample[]> {
    if (!(await this.ensureEvalViews())) return [];
    const result = await this.clickhouse.query({
      query: `
        SELECT latest.target_trace_id AS target_trace_id, traces.user_input AS question,
          latest.faithfulness AS faithfulness, latest.answer_relevancy AS answer_relevancy,
          latest.context_precision AS context_precision, raw.evidence AS evidence
        FROM (${LATEST_EVAL_SQL}) AS latest
        LEFT JOIN codecrush_traces AS traces ON traces.trace_id = latest.target_trace_id
        LEFT JOIN (
          SELECT SpanAttributes['rag.eval.target_trace_id'] AS target_trace_id,
            SpanAttributes['rag.eval.version'] AS judge_version,
            argMax(SpanAttributes['codecrush.io.output'], Timestamp) AS evidence
          FROM otel_traces
          WHERE SpanName = 'rag.eval' AND SpanAttributes['rag.eval.status'] = 'success'
          GROUP BY target_trace_id, judge_version
        ) AS raw USING (target_trace_id, judge_version)
        WHERE latest.judge_version = {judgeVersion:String}
          AND latest.evaluated_at >= {from:DateTime64(9)} AND latest.evaluated_at < {to:DateTime64(9)}
          AND ({agentId:String} = '' OR latest.agent_id = {agentId:String})
          AND (
            latest.faithfulness < {faithfulnessThreshold:Float64}
            OR latest.answer_relevancy < {answerRelevancyThreshold:Float64}
            OR latest.context_precision < {contextPrecisionThreshold:Float64}
          )
        ORDER BY least(latest.faithfulness, latest.answer_relevancy, latest.context_precision), latest.evaluated_at DESC
        LIMIT {limit:UInt32}
      `,
      query_params: {
        ...this.windowParams(window),
        faithfulnessThreshold: thresholds.faithfulness,
        answerRelevancyThreshold: thresholds.answerRelevancy,
        contextPrecisionThreshold: thresholds.contextPrecision,
        limit,
      },
      format: "JSONEachRow",
    });
    const rows = await result.json<LowSampleRow>();
    return rows.map((row) => ({
      targetTraceId: row.target_trace_id,
      question: row.question ?? "",
      faithfulness: Number(row.faithfulness),
      answerRelevancy: Number(row.answer_relevancy),
      contextPrecision: Number(row.context_precision),
      evidence: row.evidence ?? "",
    }));
  }

  private windowParams(window: EvaluationReadWindow): Record<string, string> {
    return {
      from: toClickHouseDateTime(window.from),
      to: toClickHouseDateTime(window.to),
      judgeVersion: window.judgeVersion,
      agentId: window.agentId ?? "",
    };
  }
}

type AggregateRow = {
  sample_count: number | string;
  faithfulness: number | string | null;
  answer_relevancy: number | string | null;
  context_precision: number | string | null;
};

type LatestSuccessRow = {
  target_trace_id: string;
  judge_version: string;
  evaluated_at: string;
  generation_model: string;
  judge_model: string;
  faithfulness: number | string;
  answer_relevancy: number | string;
  context_precision: number | string;
  evidence: string;
};

type FailureRow = { failed_at: string; judge_version: string; error_type: string; error_message: string };
type LowSampleRow = {
  target_trace_id: string;
  question: string;
  faithfulness: number | string;
  answer_relevancy: number | string;
  context_precision: number | string;
  evidence: string;
};

function nullableNumber(value: number | string | null): number | null {
  return value === null || value === "" ? null : Number(value);
}

function toAggregate(row: AggregateRow): EvaluationAggregate {
  return {
    sampleCount: Number(row.sample_count),
    faithfulness: nullableNumber(row.faithfulness),
    answerRelevancy: nullableNumber(row.answer_relevancy),
    contextPrecision: nullableNumber(row.context_precision),
  };
}

function emptyAggregate(): EvaluationAggregate {
  return { sampleCount: 0, faithfulness: null, answerRelevancy: null, contextPrecision: null };
}

function toClickHouseDateTime(value: Date | string): string {
  const iso = (typeof value === "string" ? new Date(value) : value).toISOString();
  return iso.replace("T", " ").replace("Z", "");
}
