import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { ModelsService } from "../models/models.service";
import type { EvaluationInput, MetricResult } from "./evaluation.types";
import {
  callJudgeProvider,
  limitedEvidence,
  parseJudgeOutput,
  repairInstruction,
  structuredOutput,
  withJudgeRetry,
  type PriorJudgeFailure,
} from "./evaluation-judge.utils";

// 校验前先归一化，只吃真正歧义的输入——不吞掉本该报错的缺陷（如 claim/supported 双双
// 缺失才判定不可修复）。三类归一对应本次诊断（12 次真实调用）实测到的多数失败：
//   · 顶层裸数组（3/12）：模型省了 `{claims: ...}` 外层包装，直接吐数组。
//   · 字段名近义词（2/12）：`supported` 被写成 `support`/`supporting`。
//   · `reason` 缺失（4/12）：分数只看 `supported`，`reason` 只喂 evidence 展示，
//     缺了给兜底文案不影响分数正确性，比让整条记录作废划算得多。
function normalizeFaithfulnessOutput(parsed: unknown): unknown {
  const root = Array.isArray(parsed) ? { claims: parsed } : parsed;
  if (!root || typeof root !== "object" || !("claims" in root) || !Array.isArray((root as { claims: unknown }).claims)) {
    return root;
  }
  const claims = (root as { claims: unknown[] }).claims.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const item = entry as Record<string, unknown>;
    const supported = "supported" in item ? item.supported : (item.support ?? item.supporting);
    const reason = typeof item.reason === "string" && item.reason.length > 0 ? item.reason : "(judge did not provide a reason)";
    return { claim: item.claim, supported, reason };
  });
  return { claims };
}

// 不用 z.strictObject：额外/近义字段名交给上面的归一化处理，这里只校验归一化后
// 应该齐全的三个字段本身对不对。仍要求 supported 是布尔——归一化只管改名，
// 改不出一个本来就没给的判断，这种情况理应触发修复重试，不该悄悄猜一个值。
const FaithfulnessOutputSchema = z.object({
  claims: z
    .array(
      z.object({
        claim: z.string().min(1).max(500),
        supported: z.boolean(),
        reason: z.string().min(1).max(500),
      }),
    )
    .max(100),
});

const FAITHFULNESS_OUTPUT = structuredOutput(
  "evaluation_faithfulness_v2",
  FaithfulnessOutputSchema,
);

const SYSTEM_PROMPT =
  "Extract every factual claim in the answer and decide whether the supplied contexts support it. " +
  'Return at most 100 claims; merge minor claims when needed. Return JSON only, no markdown code fences. ' +
  'Each claim object must have exactly these three keys: "claim" (string), "supported" (boolean), ' +
  '"reason" (string, one sentence explaining the verdict). If there are no factual claims, return an empty claims array.';

@Injectable()
export class FaithfulnessEvaluator {
  constructor(private readonly models: ModelsService) {}

  async score(input: EvaluationInput, judgeModelId: string): Promise<MetricResult | null> {
    // 018 决策 G：透传 response.usage（原先丢弃）。在线路径不读它（score() 与
    // EvaluationScores 结构不变 → E-W1 零影响）；离线用于预算熔断。
    const { output, usage } = await withJudgeRetry(
      "faithfulness",
      async (priorFailure?: PriorJudgeFailure) => {
        const userContent = JSON.stringify({ answer: input.answer, contexts: input.contexts });
        const response = await callJudgeProvider(() =>
          this.models.chat(
            judgeModelId,
            [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userContent },
              ...(priorFailure
                ? [{ role: "user" as const, content: repairInstruction(priorFailure) }]
                : []),
            ],
            { temperature: 0, structuredOutput: FAITHFULNESS_OUTPUT },
          ),
        );
        const parsed = parseJudgeOutput(
          response.content,
          z.preprocess(normalizeFaithfulnessOutput, FaithfulnessOutputSchema),
        );
        return { output: parsed, usage: response.usage };
      },
    );

    if (output.claims.length === 0) {
      return null;
    }

    const supported =
      input.contexts.length === 0 ? 0 : output.claims.filter((claim) => claim.supported).length;
    return {
      score: Math.round((supported / output.claims.length) * 100),
      evidence: limitedEvidence(
        output.claims.map((claim) => claim.reason),
        "No claim evidence was returned.",
      ),
      usage,
    };
  }
}
