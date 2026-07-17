import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { ModelsService } from "../models/models.service";
import type { CorrectnessInput, MetricResult } from "./evaluation.types";
import {
  callJudgeProvider,
  invalidJudgeOutput,
  limitedEvidence,
  parseJudgeOutput,
  repairInstruction,
  structuredOutput,
  withJudgeRetry,
  type PriorJudgeFailure,
} from "./evaluation-judge.utils";

/**
 * 018 决策 D：gold 对照指标（离线专用，在线三指标不含它）。
 * 原型 §7：「正确率显示 gold 要点比对(一致/缺失/矛盾)」——逐要点判定，score = 一致数/要点数。
 * 结构与 faithfulness/context-precision 同款：structuredOutput + Zod strict + withJudgeRetry。
 */

/**
 * 判定用 **index 指回 gold 要点**，而不是让模型回显要点原文（peer review round 2 修订）。
 *
 * 为什么不回显原文：`context-precision` 用 `chunkId !== 输入` 做回显对齐校验（`:52-58`），
 * 那是**精确机器 token**，比对可靠。而 gold 要点是**自然语言**——模型合理地改写/归一化后，
 * 严格 `!==` 会误判成裁判失败，产生大量假 NULL。
 * 用 index 则两全：对应关系**机器可验**（下面校验必须恰好是 0..n-1 的排列），
 * 且 evidence 用**我方**的 gold 原文拼装，模型无法伪造依据。
 */
const PointJudgmentSchema = z.strictObject({
  index: z.number().int().min(0),
  status: z.enum(["hit", "missing", "contradicted"]),
  reason: z.string().min(1).max(500),
});

@Injectable()
export class CorrectnessEvaluator {
  constructor(private readonly models: ModelsService) {}

  async score(input: CorrectnessInput, judgeModelId: string): Promise<MetricResult> {
    // 无 gold 无从比对 = **未评**，不是「一个要点都没中」。
    // 抛而非返回 0：0 会被 scoreOffline 当作真实分数写进记分卡拉低均值（Global Constraints
    // 明令禁止）；抛出则被 allSettled 收敛为 null（未评），语义才对。
    // 调用方（scoreOffline）已 gate `goldPoints.length > 0`，此处是防御性不可达分支。
    if (input.goldPoints.length === 0) {
      throw new Error("correctness requires at least one gold point");
    }

    // 分母**钉死为 gold 要点数**，不受模型摆布——同 context-precision 的 `.length(input.contexts.length)`。
    // 条数不符 = 解析失败 → withJudgeRetry 重试一次 → 仍败则抛 → allSettled 记 null（未评）。
    // 这同时解决了三个缺陷（peer review round 1）：
    //  ① 模型回 `{points: []}` 曾是合法响应 → 落到「score: 0」= 把裁判失败写成 0 分；
    //  ② 分母取模型返回条数 → 少回几条就能把 1 hit/1 returned 算成 100（系统性虚高）；
    //  ③ 固定 `.max(20)` 上限 → >20 条 gold 的用例永久无法评分。
    const OutputSchema = z.strictObject({
      points: z.array(PointJudgmentSchema).length(input.goldPoints.length),
    });
    const outputSpec = structuredOutput("evaluation_correctness_v2", OutputSchema);

    const { output, usage } = await withJudgeRetry(
      "correctness",
      async (priorFailure?: PriorJudgeFailure) => {
      const response = await callJudgeProvider(() =>
        this.models.chat(
          judgeModelId,
          [
            {
              role: "system",
              content:
                "Compare the answer against each supplied gold point. The gold points are given as a " +
                "zero-indexed array. Return exactly one judgment per gold point, each carrying the " +
                '"index" of the gold point it judges. For every gold point decide: "hit" if the answer ' +
                'conveys it, "missing" if the answer does not mention it, "contradicted" if the answer ' +
                "states something incompatible with it. Return JSON only, no markdown code fences.",
            },
            {
              role: "user",
              content: JSON.stringify({
                question: input.question,
                answer: input.answer,
                goldPoints: input.goldPoints.map((point, index) => ({ index, point })),
              }),
            },
            ...(priorFailure
              ? [{ role: "user" as const, content: repairInstruction(priorFailure) }]
              : []),
          ],
          { temperature: 0, structuredOutput: outputSpec },
        ),
      );
      const parsed = parseJudgeOutput(response.content, OutputSchema);
      // 分子的对应关系也要机器可验：判定必须恰好覆盖 0..n-1 各一次。
      // 否则模型可以回 n 条**全指向同一个要点**且 hit（条数合法）→ 把 5 选 1 中算成 100 分。
      // 这是 round 1 那个虚高缺陷的残余向量，round 2 一并堵死。
      const seen = new Set(parsed.points.map((p) => p.index));
      if (
        seen.size !== input.goldPoints.length ||
        [...seen].some((i) => i >= input.goldPoints.length)
      ) {
        invalidJudgeOutput("correctness judgments must cover each gold point exactly once");
      }
      return { output: parsed, usage: response.usage };
    });

    // 只有 hit 计入一致数——missing 与 contradicted 都不算（原型 §7 三态）。
    // 分母恒为 input.goldPoints.length（schema + 上面的排列校验共同保证）。
    const hits = output.points.filter((p) => p.status === "hit").length;
    // evidence 按 gold 原文顺序拼，正文取**我方**的 input.goldPoints[index]（非模型回显）。
    const ordered = [...output.points].sort((a, b) => a.index - b.index);
    return {
      score: Math.round((hits / input.goldPoints.length) * 100),
      evidence: limitedEvidence(
        ordered.map((p) => `[${p.status}] ${input.goldPoints[p.index]} —— ${p.reason}`),
        "No point evidence was returned.",
      ),
      usage,
    };
  }
}
