import { CorrectnessEvaluator } from "../src/modules/evaluations/correctness.evaluator";
import type { ModelsService } from "../src/modules/models/models.service";

/**
 * 018 决策 D：gold 要点比对（原型 §7「正确率显示 gold 要点比对(一致/缺失/矛盾)」）。
 * score = 一致数 / gold 要点数；矛盾与缺失都不计入一致数。
 *
 * 本文件的核心资产是「**裁判不合规响应绝不能变成分数**」那几组断言——
 * Global Constraints：裁判失败必须记 NULL（由 scoreOffline 的 allSettled 收敛），绝不写 0/100。
 */

const base = {
  targetTraceId: "a".repeat(32),
  question: "课程可以退款吗",
  answer: "7 天内无理由退，已开课按比例",
  contexts: [],
};

/** 只桩 chat()，返回结构化 JSON —— 与 faithfulness.evaluator.spec 同款。 */
function models(content: string, usage?: { inputTokens: number; outputTokens: number }) {
  return {
    chat: jest.fn(async () => ({ content, ...(usage ? { usage } : {}) })),
  } as unknown as ModelsService;
}

/** 判定按 index 指回 gold 要点（模型不回显原文——见 evaluator docstring）。 */
const judged = (...rows: Array<[number, "hit" | "missing" | "contradicted"]>) =>
  JSON.stringify({
    points: rows.map(([index, status]) => ({ index, status, reason: `r${index}` })),
  });

/** 全部 hit 的合规响应。 */
const allHit = (n: number) =>
  judged(...Array.from({ length: n }, (_, i) => [i, "hit"] as [number, "hit"]));

describe("CorrectnessEvaluator · 计分", () => {
  it("按 gold 要点比对计分：2/3 一致 → 67", async () => {
    const m = models(judged([0, "hit"], [1, "hit"], [2, "missing"]));
    const result = await new CorrectnessEvaluator(m).score(
      { ...base, goldPoints: ["7 天内无理由退", "已开课按比例", "赠品课不退"] },
      "m-judge",
    );
    expect(result.score).toBe(67);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("矛盾要点不计入一致数", async () => {
    const m = models(judged([0, "contradicted"]));
    const result = await new CorrectnessEvaluator(m).score(
      { ...base, goldPoints: ["赠品课不退"] },
      "m-judge",
    );
    expect(result.score).toBe(0);
  });

  it("要点全中 → 100", async () => {
    const m = models(allHit(2));
    const result = await new CorrectnessEvaluator(m).score(
      { ...base, goldPoints: ["a", "b"] },
      "m-judge",
    );
    expect(result.score).toBe(100);
  });

  it("透传 usage（决策 G）", async () => {
    const m = models(allHit(1), { inputTokens: 12, outputTokens: 4 });
    const result = await new CorrectnessEvaluator(m).score(
      { ...base, goldPoints: ["a"] },
      "m-judge",
    );
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
  });

  it("temperature=0 且走结构化输出（与三个既有 evaluator 同款）", async () => {
    const m = models(allHit(1));
    await new CorrectnessEvaluator(m).score({ ...base, goldPoints: ["a"] }, "m-judge");
    const opts = (m.chat as jest.Mock).mock.calls[0][2];
    expect(opts.temperature).toBe(0);
    expect(opts.structuredOutput).toMatchObject({
      name: "evaluation_correctness_v2",
      schema: {
        properties: {
          points: {
            items: { properties: { reason: { maxLength: 500 } } },
          },
        },
      },
    });
  });

  it("gold 要点 >20 条仍可评（分母随 gold 数动态，无固定上限）", async () => {
    const gold = Array.from({ length: 21 }, (_, i) => `p${i}`);
    const m = models(allHit(21));
    const result = await new CorrectnessEvaluator(m).score(
      { ...base, goldPoints: gold },
      "m-judge",
    );
    expect(result.score).toBe(100);
  });

  it("reason 接受 500 字，501 字耗尽重试后拒绝", async () => {
    const accepted = models(
      JSON.stringify({ points: [{ index: 0, status: "hit", reason: "r".repeat(500) }] }),
    );
    await expect(
      new CorrectnessEvaluator(accepted).score({ ...base, goldPoints: ["a"] }, "m-judge"),
    ).resolves.toMatchObject({ score: 100 });

    const rejected = models(
      JSON.stringify({ points: [{ index: 0, status: "hit", reason: "r".repeat(501) }] }),
    );
    await expect(
      new CorrectnessEvaluator(rejected).score({ ...base, goldPoints: ["a"] }, "m-judge"),
    ).rejects.toThrow(/correctness/);
    expect(rejected.chat).toHaveBeenCalledTimes(3);
  });
});

/**
 * 回归护栏（peer review round 1 + 2）：分母与分子都不可被模型摆布，
 * 且任何不合规响应都必须成为「未评」（抛 → allSettled → null），绝不落成分数。
 */
describe("CorrectnessEvaluator · 不合规裁判响应必须成为「未评」而非分数", () => {
  it("模型返回空 points → 抛（重试过），绝不返回 0", async () => {
    const m = models(JSON.stringify({ points: [] }));
    await expect(
      new CorrectnessEvaluator(m).score({ ...base, goldPoints: ["p1", "p2"] }, "m-judge"),
    ).rejects.toThrow(/correctness/);
    expect((m.chat as jest.Mock).mock.calls).toHaveLength(3); // 首次 + 修复重试 2 次（MAX_ATTEMPTS=3）
  });

  it("模型少返回要点（5 个 gold 只回 1 条）→ 抛，不得按 1/1=100 虚高", async () => {
    const m = models(judged([0, "hit"]));
    await expect(
      new CorrectnessEvaluator(m).score(
        { ...base, goldPoints: ["p1", "p2", "p3", "p4", "p5"] },
        "m-judge",
      ),
    ).rejects.toThrow(/correctness/);
  });

  it("模型多返回要点 → 抛（分母不受模型摆布）", async () => {
    const m = models(judged([0, "hit"], [1, "hit"]));
    await expect(
      new CorrectnessEvaluator(m).score({ ...base, goldPoints: ["p1"] }, "m-judge"),
    ).rejects.toThrow(/correctness/);
  });

  it("条数合法但全指向同一要点（5 条全是 index 0 且 hit）→ 抛，不得算 100", async () => {
    const m = models(judged([0, "hit"], [0, "hit"], [0, "hit"], [0, "hit"], [0, "hit"]));
    await expect(
      new CorrectnessEvaluator(m).score(
        { ...base, goldPoints: ["p1", "p2", "p3", "p4", "p5"] },
        "m-judge",
      ),
    ).rejects.toThrow(/correctness/);
  });

  it("索引越界 → 抛", async () => {
    const m = models(judged([0, "hit"], [9, "hit"]));
    await expect(
      new CorrectnessEvaluator(m).score({ ...base, goldPoints: ["p1", "p2"] }, "m-judge"),
    ).rejects.toThrow(/correctness/);
  });

  it("模型吐非法 JSON → 耗尽重试后仍败则抛（withJudgeRetry，MAX_ATTEMPTS=3）", async () => {
    const m = models("not json at all");
    await expect(
      new CorrectnessEvaluator(m).score({ ...base, goldPoints: ["a"] }, "m-judge"),
    ).rejects.toThrow(/correctness/);
    expect((m.chat as jest.Mock).mock.calls).toHaveLength(3);
  });

  it("空 gold（scoreOffline 已 gate，防御性不可达）→ 抛而非返回 0", async () => {
    const m = models(allHit(1));
    await expect(
      new CorrectnessEvaluator(m).score({ ...base, goldPoints: [] }, "m-judge"),
    ).rejects.toThrow();
    expect(m.chat).not.toHaveBeenCalled();
  });
});

describe("CorrectnessEvaluator · 对应关系与 evidence", () => {
  it("乱序但完整 → 接受（按 index 对齐，不依赖模型保持顺序）", async () => {
    const m = models(judged([1, "hit"], [0, "missing"]));
    const r = await new CorrectnessEvaluator(m).score(
      { ...base, goldPoints: ["p1", "p2"] },
      "m-judge",
    );
    expect(r.score).toBe(50);
  });

  it("evidence 用**我方**的 gold 原文，不用模型回显（模型无法伪造依据）", async () => {
    const m = models(judged([0, "missing"]));
    const r = await new CorrectnessEvaluator(m).score(
      { ...base, goldPoints: ["赠品课不退"] },
      "m-judge",
    );
    expect(r.evidence[0]).toContain("赠品课不退");
    expect(r.evidence[0]).toContain("missing");
  });
});
