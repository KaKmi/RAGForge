import { describe, expect, it } from "vitest";
import {
  CreateEvalRunRequestSchema,
  EvalRunStatusSchema,
  EvalRunResultSchema,
  EvalMetricKeySchema,
} from "./eval-runs";

const uuid = "11111111-1111-4111-8111-111111111111";

const repeat = (over: Record<string, unknown> = {}) => ({
  repeatIndex: 1,
  faithfulness: null,
  answerRelevancy: null,
  contextPrecision: null,
  correctness: null,
  citation: null,
  contextRecall: null,
  ndcg5: null,
  hitRate5: null,
  verdict: "unscored" as const,
  previewTraceId: null,
  answer: "",
  durationMs: 0,
  error: null,
  evidence: {},
  ...over,
});

describe("CreateEvalRunRequestSchema", () => {
  it("defaults force to false", () => {
    const parsed = CreateEvalRunRequestSchema.parse({
      setId: uuid,
      applicationId: uuid,
      configVersionId: uuid,
      judgeModelId: uuid,
      embeddingModelId: uuid,
    });
    expect(parsed.force).toBe(false);
  });
  it("defaults repeatCount to 1 and accepts 1-5 (F5)", () => {
    const base = {
      setId: uuid,
      applicationId: uuid,
      configVersionId: uuid,
      judgeModelId: uuid,
      embeddingModelId: uuid,
    };
    expect(CreateEvalRunRequestSchema.parse(base).repeatCount).toBe(1);
    expect(CreateEvalRunRequestSchema.parse({ ...base, repeatCount: 3 }).repeatCount).toBe(3);
    expect(CreateEvalRunRequestSchema.safeParse({ ...base, repeatCount: 0 }).success).toBe(false);
    expect(CreateEvalRunRequestSchema.safeParse({ ...base, repeatCount: 6 }).success).toBe(false);
  });
});

describe("EvalRunStatusSchema", () => {
  it("matches the prototype state machine exactly", () => {
    expect(EvalRunStatusSchema.options).toEqual([
      "queued",
      "running",
      "done",
      "partial",
      "budget_stop",
      "failed",
    ]);
  });
});

describe("EvalRunResultSchema", () => {
  it("allows null scores (未评 must never be 0)", () => {
    const parsed = EvalRunResultSchema.parse({
      seq: 1,
      caseId: uuid,
      caseVersion: 1,
      question: "q",
      faithfulness: null,
      answerRelevancy: null,
      contextPrecision: null,
      correctness: null,
      citation: null,
      contextRecall: null,
      ndcg5: null,
      hitRate5: null,
      minMetric: null,
      minScore: null,
      verdict: "unscored",
      evidence: {},
      previewTraceId: null,
      answer: "",
      durationMs: 0,
      error: "judge failed",
      repeatCount: 1,
      repeats: [repeat({ error: "judge failed" })],
      ignoredAt: null,
    });
    expect(parsed.faithfulness).toBeNull();
  });

  it("EvalMetricKeySchema includes citation (evidence key only)", () => {
    expect(EvalMetricKeySchema.options).toContain("citation");
  });

  it("accepts partial evidence (只有评出来的指标才有 evidence)", () => {
    const parsed = EvalRunResultSchema.parse({
      seq: 1,
      caseId: uuid,
      caseVersion: 1,
      question: "q",
      faithfulness: 91,
      answerRelevancy: null,
      contextPrecision: 78,
      correctness: null,
      citation: null,
      contextRecall: null,
      ndcg5: null,
      hitRate5: null,
      minMetric: "contextPrecision",
      minScore: 78,
      verdict: "weak",
      evidence: { faithfulness: ["ok"], contextPrecision: ["ok"] },
      previewTraceId: "a".repeat(32),
      answer: "ans",
      durationMs: 120,
      error: null,
      repeatCount: 1,
      repeats: [
        repeat({ faithfulness: 91, contextPrecision: 78, verdict: "weak", answer: "ans" }),
      ],
      ignoredAt: null,
    });
    expect(parsed.evidence.answerRelevancy).toBeUndefined();
    expect(parsed.evidence.faithfulness).toEqual(["ok"]);
  });

  it("ignoredAt 是叠加标志：非空表示已忽略，分数与 verdict 一概保留", () => {
    const parsed = EvalRunResultSchema.parse({
      seq: 1,
      caseId: uuid,
      caseVersion: 1,
      question: "q",
      faithfulness: 41,
      answerRelevancy: 79,
      contextPrecision: 38,
      correctness: null,
      citation: null,
      contextRecall: null,
      ndcg5: null,
      hitRate5: null,
      minMetric: "contextPrecision",
      minScore: 38,
      verdict: "low",
      evidence: {},
      previewTraceId: null,
      answer: "ans",
      durationMs: 10,
      error: null,
      repeatCount: 1,
      repeats: [repeat({ faithfulness: 41, contextPrecision: 38, verdict: "low", answer: "ans" })],
      ignoredAt: "2026-07-20T00:00:00.000Z",
    });
    expect(parsed.ignoredAt).toBe("2026-07-20T00:00:00.000Z");
    // 忽略**不改判定也不抹分数**——它只影响列表默认筛选。
    expect(parsed.verdict).toBe("low");
    expect(parsed.minScore).toBe(38);
  });
});
