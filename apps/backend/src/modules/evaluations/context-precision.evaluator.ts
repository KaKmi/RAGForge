import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { ModelsService } from "../models/models.service";
import type { EvaluationInput, MetricResult } from "./evaluation.types";
import {
  callJudgeProvider,
  invalidJudgeOutput,
  limitedEvidence,
  parseJudgeOutput,
  structuredOutput,
  withJudgeRetry,
} from "./evaluation-judge.utils";

const JudgmentSchema = z.strictObject({
  chunkId: z.string().min(1).max(300),
  relevant: z.boolean(),
  reason: z.string().min(1).max(300),
});

@Injectable()
export class ContextPrecisionEvaluator {
  constructor(private readonly models: ModelsService) {}

  async score(input: EvaluationInput, judgeModelId: string): Promise<MetricResult> {
    if (input.contexts.length === 0) {
      return { score: 0, evidence: ["No retrieved contexts were available."] };
    }

    const OutputSchema = z.strictObject({
      judgments: z.array(JudgmentSchema).length(input.contexts.length),
    });
    const outputSpec = structuredOutput("evaluation_context_precision_v1", OutputSchema);
    const output = await withJudgeRetry("context precision", async () => {
      const response = await callJudgeProvider(() =>
        this.models.chat(
          judgeModelId,
          [
            {
              role: "system",
              content:
                "Judge whether each context is relevant to answering the question. Return exactly one judgment per context in the supplied ranking order and strict JSON only.",
            },
            {
              role: "user",
              content: JSON.stringify({ question: input.question, contexts: input.contexts }),
            },
          ],
          { temperature: 0, structuredOutput: outputSpec },
        ),
      );
      const parsed = parseJudgeOutput(response.content, OutputSchema);
      if (
        parsed.judgments.some(
          (judgment, index) => judgment.chunkId !== input.contexts[index].chunkId,
        )
      ) {
        invalidJudgeOutput("context judgments do not match the ranked input contexts");
      }
      return parsed;
    });

    let relevantSoFar = 0;
    let precisionSum = 0;
    output.judgments.forEach((judgment, index) => {
      if (!judgment.relevant) return;
      relevantSoFar += 1;
      precisionSum += relevantSoFar / (index + 1);
    });
    return {
      score: relevantSoFar === 0 ? 0 : Math.round((precisionSum / relevantSoFar) * 100),
      evidence: limitedEvidence(
        output.judgments.map((judgment) => judgment.reason),
        "No context judgments were returned.",
      ),
    };
  }
}
