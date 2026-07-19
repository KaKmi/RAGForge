import { EvalGateProviderRegistrar } from "../src/modules/eval-runs/eval-gate.provider";

/**
 * B1/F5：门禁**解析器**的钉（`buildGateIssues` 的纯函数钉在 eval-gate.rules.spec.ts）。
 *
 * 本文件存在的首要理由是 **anti-swap**：`resolve()` 里
 * `aRow = 基线(production)`、`bRow = 候选` 的取值顺序决定了所有结论的**符号**——
 * `classifyCase` 算的是 `bv - av`（eval-compare.ts:56-57）、
 * `overallDelta = b - a`（eval-compare.ts:135）。一旦两侧写反，
 * 「改进」会被报成「回退」、真回退反而显示干净，而**没有任何既有测试会红**。
 */

const NOW_ISH = new Date("2026-07-18T12:00:00Z");

type Row = {
  id: string;
  setId: string;
  finishedAt: Date | null;
  createdAt: Date;
};

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  setId: "set-1",
  finishedAt: NOW_ISH,
  createdAt: NOW_ISH,
  ...over,
});

/**
 * 造一条评测结果。
 * · verdict 只有 pass/weak/low 三档进 VERDICT_RANK（eval-compare.ts:22），
 *   其余值（如 "fail"）会被判 excluded —— 那样回退数恒为 0，测试会假绿。
 * · 配对键是 **caseId**（eval-compare.ts:109 `bByCase`），不是 caseVersionId。
 */
const result = (caseVersionId: string, verdict: string, score: number) => ({
  id: `r-${caseVersionId}-${verdict}-${score}`,
  runId: "run",
  caseVersionId,
  seq: 1,
  repeatIndex: 0,
  verdict,
  faithfulness: score,
  answerRelevancy: score,
  contextPrecision: score,
  correctness: score,
  citation: score,
  // 其余 COMPARE_METRIC_KEYS 必须显式给 null：classifyCase 的守卫是
  // `av !== null && bv !== null`，undefined 会穿过守卫算出 NaN，
  // 于是这几个指标在夹具里静默失效（test/ 不过 tsc，永远不会有人提醒）。
  contextRecall: null,
  ndcg5: null,
  hitRate5: null,
  latencyMs: 100,
  tokensUsed: 10,
  errorMessage: null,
  caseId: caseVersionId,
  caseVersion: 1,
  question: "q",
});

function make(opts: {
  candidate?: Row | undefined;
  baseline?: Row | undefined;
  productionVersionId?: string | null;
  baselineResults?: ReturnType<typeof result>[];
  candidateResults?: ReturnType<typeof result>[];
  baselineOverall?: number | null;
  candidateOverall?: number | null;
  sameCaseSet?: boolean;
}) {
  const captured: { registered?: (a: string, c: string) => Promise<unknown> } = {};
  const applications = {
    registerEvalGateProvider: (fn: (a: string, c: string) => Promise<unknown>) => {
      captured.registered = fn;
    },
    getProductionConfigVersionId: jest.fn(async () =>
      opts.productionVersionId === undefined ? "cv-production" : opts.productionVersionId,
    ),
  };
  const snapshot = (opts.sameCaseSet ?? true)
    ? [{ caseVersionId: "c1" }, { caseVersionId: "c2" }]
    : [{ caseVersionId: "zzz" }];
  const repo = {
    findLatestFinishedRun: jest.fn(async () =>
      opts.candidate === undefined ? row("run-candidate") : opts.candidate,
    ),
    findLatestFinishedRunInSet: jest.fn(async () =>
      opts.baseline === undefined ? row("run-baseline") : opts.baseline,
    ),
    findAggregateById: jest.fn(async (id: string) => ({
      id,
      setId: "set-1",
      configVersionId: id === "run-baseline" ? "cv-production" : "cv-candidate",
      caseVersionSnapshot: id === "run-baseline" ? [{ caseVersionId: "c1" }, { caseVersionId: "c2" }] : snapshot,
      status: "done",
      judgeModelId: "judge",
      offlineJudgeVersion: "offline-v2",
      tokensUsed: 1,
      overallScore: 80,
      setName: "set",
      createdAt: NOW_ISH,
      finishedAt: NOW_ISH,
    })),
  };
  /**
   * ⚠️ 这个假实现必须**按行身份**派发，不能按位置返回固定常量。
   * 若写成「第一个返回基线数据、第二个返回候选数据」，那么把实参顺序写反时
   * 假实现照样吐出同样的东西，anti-swap 钉就形同虚设（review 实测：三处 swap 中
   * 只有一处会红）。按 id 派发后，任一处写反都会让基线/候选数据错位而变红。
   */
  const inputFor = (r: { id: string }) =>
    r.id === "run-baseline"
      ? {
          // overallScore 必须显式给值：buildCompareResponse 用 `!== null` 判定，
          // undefined 会算出 NaN，测试就会为了错误的理由变绿。
          summary: { id: r.id, overallScore: opts.baselineOverall ?? 80 },
          results: opts.baselineResults ?? [],
        }
      : {
          summary: { id: r.id, overallScore: opts.candidateOverall ?? 80 },
          results: opts.candidateResults ?? [],
        };
  const runs = {
    loadCompareInputs: jest.fn(async (aRow: { id: string }, bRow: { id: string }) => [
      inputFor(aRow),
      inputFor(bRow),
    ]),
  };
  const registrar = new EvalGateProviderRegistrar(
    applications as never,
    repo as never,
    runs as never,
  );
  registrar.onModuleInit();
  return {
    call: () => captured.registered!("app-1", "cv-candidate"),
    repo,
    runs,
    applications,
  };
}

describe("EvalGateProviderRegistrar.resolve（B1/F5 门禁解析器）", () => {
  it("onModuleInit 把回调注册进 ApplicationsService", () => {
    const { call } = make({});
    expect(typeof call).toBe("function");
  });

  /**
   * 【anti-swap 钉，勿删——本文件的首要理由】
   * 候选**优于**基线时，绝不能报出 REGRESSION / OVERALL_DROP。
   * 若把 loadCompareInputs 的两个实参写反（或 findAggregateById 的取值顺序写反），
   * 本用例是唯一会红的地方。
   */
  it("候选优于基线 → 零 issue（两侧顺序写反时本条必红）", async () => {
    const { call } = make({
      baselineResults: [result("c1", "low", 50), result("c2", "low", 50)],
      candidateResults: [result("c1", "pass", 90), result("c2", "pass", 90)],
    });
    await expect(call()).resolves.toEqual([]);
  });

  it("候选劣于基线 → REGRESSION（warning）", async () => {
    const { call, runs } = make({
      baselineResults: [result("c1", "pass", 90), result("c2", "pass", 90)],
      candidateResults: [result("c1", "low", 50), result("c2", "low", 50)],
    });
    const issues = (await call()) as { code: string; severity: string; message: string }[];
    expect(issues.map((i) => i.code)).toContain("EVAL_GATE_REGRESSION");
    // 直接钉住实参位置：a=基线(production)、b=候选。符号全靠这个顺序。
    expect(runs.loadCompareInputs).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-baseline" }),
      expect.objectContaining({ id: "run-candidate" }),
    );
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(issues.find((i) => i.code === "EVAL_GATE_REGRESSION")!.message).toBe("存在 2 条回退用例");
  });

  it("候选侧无终态 run → NO_RUN（fail-open）", async () => {
    const built = make({});
    built.repo.findLatestFinishedRun = jest.fn(async () => undefined) as never;
    const issues = (await built.call()) as { code: string }[];
    expect(issues.map((i) => i.code)).toEqual(["EVAL_GATE_NO_RUN"]);
  });

  it("应用尚无 production → NO_RUN（无基线可比）", async () => {
    const { call } = make({ productionVersionId: null });
    const issues = (await call()) as { code: string }[];
    expect(issues.map((i) => i.code)).toEqual(["EVAL_GATE_NO_RUN"]);
  });

  /**
   * 候选就是当前 production 时，自己跟自己比恒无回退——那是个看似干净、
   * 实则零信息量的结论。降级成 NO_RUN（fail-open），绝不给假绿。
   */
  it("候选版本就是当前 production → NO_RUN，不给自比的假绿", async () => {
    const { call, runs } = make({ productionVersionId: "cv-candidate" });
    const issues = (await call()) as { code: string }[];
    expect(issues.map((i) => i.code)).toEqual(["EVAL_GATE_NO_RUN"]);
    // 不该白跑一次对比取数
    expect(runs.loadCompareInputs).not.toHaveBeenCalled();
  });

  it("基线侧无终态 run → NO_RUN", async () => {
    const built = make({});
    built.repo.findLatestFinishedRunInSet = jest.fn(async () => undefined) as never;
    const issues = (await built.call()) as { code: string }[];
    expect(issues.map((i) => i.code)).toEqual(["EVAL_GATE_NO_RUN"]);
  });

  /**
   * 用例版本集合不一致 ⇒ 与对比页同一判据（isSameCaseSet）判为不可比。
   * 门禁对不可比的反应是降级放行（NO_RUN），**不是**抛 409——那是对比页的语义。
   */
  it("用例集不可比 → NO_RUN（降级放行，不抛）", async () => {
    const { call, runs } = make({ sameCaseSet: false });
    const issues = (await call()) as { code: string }[];
    expect(issues.map((i) => i.code)).toEqual(["EVAL_GATE_NO_RUN"]);
    expect(runs.loadCompareInputs).not.toHaveBeenCalled();
  });

  /** 新鲜度基准取 finishedAt；超 24h 必须报 STALE_RUN。 */
  it("候选 run 超 24h → STALE_RUN", async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { call } = make({ candidate: row("run-candidate", { finishedAt: stale, createdAt: stale }) });
    const issues = (await call()) as { code: string }[];
    expect(issues.map((i) => i.code)).toContain("EVAL_GATE_STALE_RUN");
  });

  /**
   * finishedAt 为 null 时回落 createdAt。方向必须是「更老」（更容易判 STALE），
   * 绝不能让一个过期 run 看起来新鲜。
   */
  it("finishedAt 为 null → 回落 createdAt，且方向偏保守", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { call } = make({ candidate: row("run-candidate", { finishedAt: null, createdAt: old }) });
    const issues = (await call()) as { code: string }[];
    expect(issues.map((i) => i.code)).toContain("EVAL_GATE_STALE_RUN");
  });

  /** provider 本身不 catch——异常上抛给 collectEvalGateIssues 统一降级（fail-open 单一落点）。 */
  it("取数异常直接上抛（由 collectEvalGateIssues 统一降级为 UNAVAILABLE）", async () => {
    const built = make({});
    built.repo.findLatestFinishedRun = jest.fn(async () => {
      throw new Error("pg down");
    }) as never;
    await expect(built.call()).rejects.toThrow("pg down");
  });
});
