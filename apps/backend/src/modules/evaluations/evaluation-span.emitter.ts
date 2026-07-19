import { Injectable } from "@nestjs/common";
import { forceFlushTelemetry, withSpan } from "@codecrush/otel";
import { CODECRUSH_IO, EVALUATION_UNSCORED_SCORE, GEN_AI, RAG } from "@codecrush/otel-conventions";
import type { EvaluationInput, EvaluationScores } from "./evaluation.types";
import type { EvaluationCandidate } from "./clickhouse-evaluations.repository";
import { evalDedupeKey } from "./sampling";
import { normalizeEvaluationError } from "./evaluation-worker.errors";

export interface EvaluationEmissionSettings {
  judgeModelId: string;
  judgeVersion: string;
  /**
   * B1/F3：触发源。默认 `worker` ⇒ 既有 worker 调用点**零改动**、既有读路径零感知。
   * 只有人工「立即评测」显式传 `manual`。加属性不改口径 ⇒ online-v2 不升号。
   */
  trigger?: "worker" | "manual";
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
          [RAG.EVAL_FAITHFULNESS]: result.faithfulness ?? EVALUATION_UNSCORED_SCORE,
          [RAG.EVAL_ANSWER_RELEVANCY]: result.answerRelevancy,
          [RAG.EVAL_CONTEXT_PRECISION]: result.contextPrecision,
          [RAG.EVAL_JUDGE_MODEL]: settings.judgeModelId,
          [RAG.EVAL_VERSION]: settings.judgeVersion,
          [RAG.EVAL_TRIGGER]: settings.trigger ?? "worker",
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
          [RAG.EVAL_TRIGGER]: settings.trigger ?? "worker",
          "error.type": normalized.errorClass,
          "error.message": normalized.message,
        },
      },
      () => undefined,
    );
    await forceFlushTelemetry();
  }
}
