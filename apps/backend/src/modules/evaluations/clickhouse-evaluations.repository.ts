import { Inject, Injectable } from "@nestjs/common";
import { CLICKHOUSE } from "../../platform/clickhouse/clickhouse.constants";
import type { CodeCrushClickHouseClient } from "../../platform/clickhouse/clickhouse.types";

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
  constructor(@Inject(CLICKHOUSE) private readonly clickhouse: CodeCrushClickHouseClient) {}

  async listCandidates(
    cursor: EvaluationCursor,
    upperBound: Date,
    limit: number,
  ): Promise<EvaluationCandidate[]> {
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
        lastTs: cursor.lastTs.toISOString(),
        lastTraceId: cursor.lastTraceId,
        upperBound: upperBound.toISOString(),
        limit,
      },
      format: "JSONEachRow",
    });
    const rows = await result.json<CandidateRow>();
    return rows.map((row) => ({
      traceId: row.trace_id,
      startTime: new Date(row.start_time.endsWith("Z") ? row.start_time : `${row.start_time}Z`),
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
}
