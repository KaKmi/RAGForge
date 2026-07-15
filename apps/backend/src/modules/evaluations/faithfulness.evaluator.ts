import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { ModelsService } from "../models/models.service";
import type { EvaluationInput, MetricResult } from "./evaluation.types";
import {
  callJudgeProvider,
  limitedEvidence,
  parseJudgeOutput,
  structuredOutput,
  withJudgeRetry,
} from "./evaluation-judge.utils";

const FaithfulnessOutputSchema = z.strictObject({
  claims: z
    .array(
      z.strictObject({
        claim: z.string().min(1).max(300),
        supported: z.boolean(),
        reason: z.string().min(1).max(300),
      }),
    )
    .max(20),
});

const FAITHFULNESS_OUTPUT = structuredOutput(
  "evaluation_faithfulness_v1",
  FaithfulnessOutputSchema,
);

@Injectable()
export class FaithfulnessEvaluator {
  constructor(private readonly models: ModelsService) {}

  async score(input: EvaluationInput, judgeModelId: string): Promise<MetricResult> {
    const output = await withJudgeRetry("faithfulness", async () => {
      const response = await callJudgeProvider(() =>
        this.models.chat(
          judgeModelId,
          [
            {
              role: "system",
              content:
                "Extract every factual claim in the answer and decide whether the supplied contexts support it. Return strict JSON only. If there are no factual claims, return an empty claims array.",
            },
            {
              role: "user",
              content: JSON.stringify({ answer: input.answer, contexts: input.contexts }),
            },
          ],
          { temperature: 0, structuredOutput: FAITHFULNESS_OUTPUT },
        ),
      );
      return parseJudgeOutput(response.content, FaithfulnessOutputSchema);
    });

    if (output.claims.length === 0) {
      return { score: 100, evidence: ["No factual claims were identified."] };
    }

    const supported =
      input.contexts.length === 0 ? 0 : output.claims.filter((claim) => claim.supported).length;
    return {
      score: Math.round((supported / output.claims.length) * 100),
      evidence: limitedEvidence(
        output.claims.map((claim) => claim.reason),
        "No claim evidence was returned.",
      ),
    };
  }
}
