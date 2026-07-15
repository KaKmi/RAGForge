import { Injectable } from "@nestjs/common";
import { forceFlushTelemetry, withSpan } from "@codecrush/otel";
import { CODECRUSH_IO, GEN_AI, RAG } from "@codecrush/otel-conventions";
import type { EvaluationInput, EvaluationScores } from "./evaluation.types";
import type { EvaluationCandidate } from "./clickhouse-evaluations.repository";
import { evalDedupeKey } from "./sampling";
import { normalizeEvaluationError } from "./evaluation-worker.errors";

export interface EvaluationEmissionSettings {
  judgeModelId: string;
  judgeVersion: string;
}

@Injectable()
export class EvaluationSpanEmitter {
  async emitSuccess(payload: {
    candidate: EvaluationCandidate;
    input: EvaluationInput;
    settings: EvaluationEmissionSettings;
    result: EvaluationScores;
  }): Promise<void> {
    const { candidate, input, settings, result } = payload;
    await withSpan(
      "rag.eval",
      {
        attributes: {
          [RAG.EVAL_STATUS]: "success",
          [RAG.EVAL_TARGET_TRACE_ID]: input.targetTraceId,
          [RAG.EVAL_DEDUPE_KEY]: evalDedupeKey(input.targetTraceId, settings.judgeVersion),
          [RAG.EVAL_FAITHFULNESS]: result.faithfulness,
          [RAG.EVAL_ANSWER_RELEVANCY]: result.answerRelevancy,
          [RAG.EVAL_CONTEXT_PRECISION]: result.contextPrecision,
          [RAG.EVAL_JUDGE_MODEL]: settings.judgeModelId,
          [RAG.EVAL_VERSION]: settings.judgeVersion,
          [GEN_AI.AGENT_ID]: candidate.agentId,
          [GEN_AI.REQUEST_MODEL]: candidate.generationModel,
          [CODECRUSH_IO.OUTPUT]: JSON.stringify(result.evidence),
        },
      },
      () => undefined,
    );
    await forceFlushTelemetry();
  }

  async emitFailure(payload: {
    input: EvaluationInput;
    settings: EvaluationEmissionSettings;
    error: unknown;
  }): Promise<void> {
    const { input, settings } = payload;
    const normalized = normalizeEvaluationError(payload.error);
    await withSpan(
      "rag.eval",
      {
        attributes: {
          [RAG.EVAL_STATUS]: "failed",
          [RAG.EVAL_TARGET_TRACE_ID]: input.targetTraceId,
          [RAG.EVAL_DEDUPE_KEY]: evalDedupeKey(input.targetTraceId, settings.judgeVersion),
          [RAG.EVAL_VERSION]: settings.judgeVersion,
          "error.type": normalized.errorClass,
          "error.message": normalized.message,
        },
      },
      () => undefined,
    );
    await forceFlushTelemetry();
  }
}
