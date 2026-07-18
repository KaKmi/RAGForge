import type { EvalRunListItem, EvalRunResult } from "@codecrush/contracts";
import { buildCompareResponse, classifyCase, type CompareRunInput } from "./eval-compare";

const result = (over: Partial<EvalRunResult>): EvalRunResult =>
  ({
    seq: 1,
    caseId: "case-1",
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
    verdict: "pass",
    evidence: {},
    previewTraceId: null,
    answer: "",
    durationMs: 0,
    error: null,
    repeatCount: 1,
    repeats: [],
    ...over,
  }) as EvalRunResult;

const summary = (over: Partial<CompareRunInput["summary"]> = {}): CompareRunInput["summary"] => ({
  id: "run-1",
  setId: "set-1",
  setName: "售后核心",
  applicationId: "app-1",
  configVersionId: "cv-1",
  configVersionLabel: "v1",
  status: "done",
  overallScore: 80,
  totalCases: 1,
  doneCases: 1,
  repeatCount: 1,
  durationMs: 1000,
  createdAt: "2026-07-13T09:00:00.000Z",
  judgeModelId: "judge-1",
  offlineJudgeVersion: "offline-v2",
  tokensUsed: 1000,
  ...(over as Partial<EvalRunListItem>),
});

describe("classifyCase（F8 变差/变好定义）", () => {
  it("verdict 降档 pass→weak → regressed", () => {
    expect(
      classifyCase(result({ verdict: "pass" }), result({ verdict: "weak" })),
    ).toMatchObject({ regressed: true, improved: false, excluded: false });
  });

  it("单指标降≥10（82→61）→ regressed", () => {
    expect(
      classifyCase(
        result({ verdict: "pass", faithfulness: 82 }),
        result({ verdict: "pass", faithfulness: 61 }),
      ).regressed,
    ).toBe(true);
  });

  it("任一侧 timeout → excluded（不算变好也不算变差）", () => {
    expect(classifyCase(result({ verdict: "timeout" }), result({ verdict: "pass" }))).toEqual({
      regressed: false,
      improved: false,
      excluded: true,
    });
  });

  it("升档 weak→pass 且无回退 → improved", () => {
    expect(
      classifyCase(result({ verdict: "weak" }), result({ verdict: "pass" })),
    ).toMatchObject({ improved: true, regressed: false });
  });
});

describe("buildCompareResponse", () => {
  const mkRun = (results: EvalRunResult[], s: Partial<CompareRunInput["summary"]> = {}): CompareRunInput => ({
    summary: summary(s),
    results,
  });

  it("|delta|<3 → significant:false（无显著差异，不给箭头）", () => {
    const a = mkRun([result({ faithfulness: 80 })]);
    const b = mkRun([result({ faithfulness: 82 })]);
    const res = buildCompareResponse(a, b);
    const f = res.metrics.find((m) => m.key === "faithfulness")!;
    expect(f.delta).toBe(2);
    expect(f.significant).toBe(false);
  });

  it("|delta|≥3 但样本<30 → significant:false", () => {
    const a = mkRun([result({ faithfulness: 70 })]);
    const b = mkRun([result({ faithfulness: 80 })]);
    const f = buildCompareResponse(a, b).metrics.find((m) => m.key === "faithfulness")!;
    expect(f.delta).toBe(10);
    expect(f.significant).toBe(false); // 仅 1 个样本
  });

  it("|delta|≥3 且两侧样本≥30 → significant:true", () => {
    const rows = (v: number) => Array.from({ length: 30 }, (_, i) => result({ caseId: `c${i}`, seq: i + 1, faithfulness: v }));
    const f = buildCompareResponse(mkRun(rows(70)), mkRun(rows(80))).metrics.find(
      (m) => m.key === "faithfulness",
    )!;
    expect(f.significant).toBe(true);
  });

  it("summary：overallDelta、judgeMismatch、变差计数", () => {
    const a = mkRun([result({ caseId: "c1", verdict: "pass", faithfulness: 90 })], {
      overallScore: 80,
      judgeModelId: "j1",
    });
    const b = mkRun([result({ caseId: "c1", verdict: "weak", faithfulness: 70 })], {
      overallScore: 84,
      judgeModelId: "j2",
    });
    const res = buildCompareResponse(a, b);
    expect(res.summary.overallDelta).toBe(4);
    expect(res.summary.judgeMismatch).toBe(true);
    expect(res.summary.regressedCount).toBe(1);
  });

  it("latency P95 与 tokens 均值", () => {
    const rows = [10, 20, 30, 40, 50].map((d, i) =>
      result({ caseId: `c${i}`, seq: i + 1, durationMs: d }),
    );
    const res = buildCompareResponse(mkRun(rows, { tokensUsed: 500 }), mkRun(rows, { tokensUsed: 500 }));
    expect(res.latency.aP95Ms).toBe(50); // ceil(0.95*5)-1 = 4 → sorted[4]=50
    expect(res.tokens.aAvgPerCase).toBe(100); // 500/5
  });
});
