import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { ModelsService } from "../models/models.service";
import type { EvaluationInput, EvaluationModelIds, MetricResult } from "./evaluation.types";
import {
  callJudgeProvider,
  invalidJudgeOutput,
  limitedEvidence,
  parseJudgeOutput,
  structuredOutput,
  withJudgeRetry,
} from "./evaluation-judge.utils";

const AnswerRelevancyOutputSchema = z.strictObject({
  questions: z.array(z.string().min(1).max(500)).min(1).max(3),
});

const ANSWER_RELEVANCY_OUTPUT = structuredOutput(
  "evaluation_answer_relevancy_v2",
  AnswerRelevancyOutputSchema,
);

@Injectable()
export class AnswerRelevancyEvaluator {
  constructor(private readonly models: ModelsService) {}

  async score(input: EvaluationInput, modelIds: EvaluationModelIds): Promise<MetricResult> {
    return withJudgeRetry("answer relevancy", async () => {
      const response = await callJudgeProvider(() =>
        this.models.chat(
          modelIds.judgeModelId,
          [
            {
              role: "system",
              content:
                "Generate one to three concise questions that the supplied answer directly answers. Return strict JSON only.",
            },
            { role: "user", content: JSON.stringify({ answer: input.answer }) },
          ],
          { temperature: 0, structuredOutput: ANSWER_RELEVANCY_OUTPUT },
        ),
      );
      const output = parseJudgeOutput(response.content, AnswerRelevancyOutputSchema);
      const texts = [input.question, ...output.questions];
      const vectors = await callJudgeProvider(() =>
        this.models.embedTexts(modelIds.embeddingModelId, texts),
      );
      validateEmbeddingBatch(vectors, texts.length);
      const similarities = vectors.slice(1).map((vector) => cosine(vectors[0], vector));
      const mean =
        similarities.reduce((sum, value) => sum + Math.max(0, value), 0) / similarities.length;
      return {
        score: Math.round(Math.max(0, Math.min(1, mean)) * 100),
        evidence: limitedEvidence(output.questions, "No reverse questions were returned."),
        // 018 决策 G：透传 chat 的 usage（embedTexts 不返回 usage → 该部分计 0，不猜）。
        usage: response.usage,
      };
    });
  }
}

function validateEmbeddingBatch(vectors: number[][], expectedCount: number): void {
  if (vectors.length !== expectedCount || vectors.length === 0) {
    invalidJudgeOutput("embedding provider returned an unexpected vector count");
  }
  const dimensions = vectors[0].length;
  if (
    dimensions === 0 ||
    vectors.some(
      (vector) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)),
    )
  ) {
    invalidJudgeOutput("embedding provider returned malformed vectors");
  }
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)));
}
