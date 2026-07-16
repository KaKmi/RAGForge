import { NotFoundException } from "@nestjs/common";
import { EVAL_RUN_JOB } from "../src/platform/queue/queue.constants";
import {
  EvalRunWorkerProcessor,
  decideVerdict,
} from "../src/modules/eval-runs/eval-run-worker.processor";
import type { NewEvalRunResultInput } from "../src/modules/eval-runs/eval-runs.repository";
import type { EvalRunRow, EvalRunSnapshotEntry } from "../src/modules/eval-runs/schema";
import type { OfflineEvaluationScores } from "../src/modules/evaluations/evaluation.types";

const now = new Date("2026-07-16T00:00:00.000Z");
const APP_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

function c(seq: number): EvalRunSnapshotEntry {
  return { caseId: `case-${seq}`, caseVersionId: `cv-${seq}`, seq };
}

function scores(overrides: Partial<OfflineEvaluationScores> = {}): OfflineEvaluationScores {
  return {
    faithfulness: 90,
    answerRelevancy: 90,
    contextPrecision: 90,
    correctness: null,
    evidence: { faithfulness: ["ok"] },
    usage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

interface SetupOptions {
  snapshot?: EvalRunSnapshotEntry[];
  /** 跑完第 N 条后置停止信号（模拟用户中途点停止）。 */
  stopAfter?: number;
  tokenBudget?: number;
  usagePerCase?: number;
  /** 这些 seq 的用例编排超时。 */
  timeoutOn?: number[];
  resolveThrows?: boolean;
  leaseBusy?: boolean;
  scores?: Partial<OfflineEvaluationScores>;
  runStatus?: EvalRunRow["status"];
  recorded?: string[];
}

function setup(opts: SetupOptions = {}) {
  const snapshot = opts.snapshot ?? [c(1)];
  const run: EvalRunRow = {
    id: "r1",
    setId: "11111111-1111-4111-8111-111111111111",
    applicationId: APP_ID,
    configVersionId: VERSION_ID,
    judgeModelId: "44444444-4444-4444-8444-444444444444",
    embeddingModelId: "55555555-5555-4555-8555-555555555555",
    offlineJudgeVersion: "offline-v1",
    status: opts.runStatus ?? "queued",
    scope: "all",
    caseVersionSnapshot: snapshot,
    totalCases: snapshot.length,
    doneCases: 0,
    tokenBudget: opts.tokenBudget ?? 500000,
    tokensUsed: 0,
    stopRequestedAt: null,
    leaseOwner: null,
    leaseUntil: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    createdBy: "admin",
    createdAt: now,
  };
  const runs = new Map<string, EvalRunRow>([[run.id, run]]);
  const results: NewEvalRunResultInput[] = [];

  const repo = {
    async tryAcquireLease() {
      return !opts.leaseBusy;
    },
    async releaseLease() {},
    async findRunById(id: string) {
      return runs.get(id);
    },
    async markRunning(id: string, at: Date) {
      const row = runs.get(id)!;
      row.status = "running";
      row.startedAt = at;
    },
    async finishRun(id: string, status: string, at: Date, error: string | null) {
      const row = runs.get(id)!;
      row.status = status as EvalRunRow["status"];
      row.finishedAt = at;
      row.error = error;
    },
    async recordResult(input: NewEvalRunResultInput) {
      results.push(input);
      const row = runs.get(input.runId)!;
      row.doneCases += 1;
      row.tokensUsed += input.tokensUsed;
      // 跑完第 N 条后模拟用户点停止（service 只置信号，不改状态）。
      if (opts.stopAfter !== undefined && results.length === opts.stopAfter) {
        row.stopRequestedAt = now;
      }
    },
    async listRecordedCaseVersionIds() {
      return opts.recorded ?? [];
    },
    async findCaseVersionsByIds(ids: string[]) {
      return ids.map((id) => ({
        id,
        caseId: id.replace("cv-", "case-"),
        version: 1,
        question: `问题 ${id.replace("cv-", "")}`,
        goldPoints: [] as string[],
      }));
    },
  };

  const orchestration = {
    runForEvaluation: jest.fn(async (_cfg: unknown, question: string) => {
      const seq = Number(question.replace("问题 ", ""));
      const timedOut = (opts.timeoutOn ?? []).includes(seq);
      return {
        traceId: `trace-${seq}`,
        replyText: `回答 ${seq}`,
        // 真实 chunkId —— 绝不合成 c1/c2（Global Constraints）。
        hits: [{ chunkId: `chunk-${seq}`, text: `片段 ${seq}`, finalScore: 0.9 }],
        usage: { inputTokens: opts.usagePerCase ?? 0, outputTokens: 0 },
        isFallback: false,
        timedOut,
      };
    }),
  };

  const judge = { scoreOffline: jest.fn(async () => scores(opts.scores)) };
  const applications = {
    resolveForTest: jest.fn(async () => {
      if (opts.resolveThrows) throw new NotFoundException("版本不存在");
      return { applicationId: APP_ID, configVersionId: VERSION_ID, version: 7 };
    }),
  };
  const queue = { publish: jest.fn(async () => undefined), subscribe: jest.fn(), schedule: jest.fn() };

  const processor = new EvalRunWorkerProcessor(
    queue as never,
    repo as never,
    orchestration as never,
    judge as never,
    applications as never,
  );
  return { processor, runs, results, queue, orchestration, judge, applications };
}

describe("decideVerdict", () => {
  it("取非 null 指标最低档；correctness=null（无 gold）不参与", () => {
    expect(decideVerdict({ faithfulness: 91, answerRelevancy: 55, contextPrecision: 78, correctness: null })).toEqual(
      { verdict: "low", minMetric: "answerRelevancy", minScore: 55 },
    );
  });

  it("60-79 → weak；≥80 → pass（原型 §7 档位）", () => {
    expect(
      decideVerdict({ faithfulness: 90, answerRelevancy: 79, contextPrecision: 88, correctness: null })
        .verdict,
    ).toBe("weak");
    expect(
      decideVerdict({ faithfulness: 80, answerRelevancy: 95, contextPrecision: 88, correctness: 99 })
        .verdict,
    ).toBe("pass");
  });

  it("三基础指标全 null → unscored（裁判全挂 ≠ 配置很差，不给档位）", () => {
    expect(
      decideVerdict({
        faithfulness: null,
        answerRelevancy: null,
        contextPrecision: null,
        correctness: null,
      }),
    ).toEqual({ verdict: "unscored", minMetric: null, minScore: null });
  });
});

describe("EvalRunWorkerProcessor", () => {
  it("逐条跑：用 resolveForTest（preview=true）解析一次，按 snapshot 顺序跑", async () => {
    const { processor, applications, orchestration } = setup({ snapshot: [c(1), c(2)] });
    await processor.processRun("r1");
    expect(applications.resolveForTest).toHaveBeenCalledTimes(1); // 每 run 一次，不逐条
    expect(orchestration.runForEvaluation.mock.calls.map((call) => call[1])).toEqual([
      "问题 1",
      "问题 2",
    ]);
  });

  it("stop_requested → 收尾 partial，已完成结果保留，未跑用例不写行", async () => {
    const { processor, runs, results } = setup({ snapshot: [c(1), c(2), c(3)], stopAfter: 1 });
    await processor.processRun("r1");
    expect(runs.get("r1")!.status).toBe("partial");
    expect(results.filter((r) => r.runId === "r1")).toHaveLength(1);
    expect(runs.get("r1")!.doneCases).toBe(1);
  });

  it("token 超预算 → budget_stop", async () => {
    const { processor, runs, results } = setup({
      snapshot: [c(1), c(2)],
      tokenBudget: 10,
      usagePerCase: 100,
    });
    await processor.processRun("r1");
    expect(runs.get("r1")!.status).toBe("budget_stop");
    expect(results).toHaveLength(1); // 第 2 条开跑前就熔断
  });

  it("单用例编排超时 → verdict=timeout，分数全 null，run 继续跑下一条", async () => {
    const { processor, results, runs, judge } = setup({ snapshot: [c(1), c(2)], timeoutOn: [1] });
    await processor.processRun("r1");
    const first = results.find((r) => r.seq === 1)!;
    expect(first.verdict).toBe("timeout");
    expect(first.faithfulness).toBeNull();
    expect(first.answerRelevancy).toBeNull();
    expect(first.contextPrecision).toBeNull();
    expect(first.correctness).toBeNull();
    expect(first.minScore).toBeNull();
    expect(judge.scoreOffline).toHaveBeenCalledTimes(1); // 超时条不判分
    expect(runs.get("r1")!.status).toBe("done");
  });

  it("超时也写 previewTraceId —— traceId 恒有值，「trace」链接必须能跳", async () => {
    const { processor, results } = setup({ snapshot: [c(1)], timeoutOn: [1] });
    await processor.processRun("r1");
    expect(results[0].previewTraceId).toBe("trace-1");
  });

  it("配置版本不可用 → run failed", async () => {
    const { processor, runs } = setup({ resolveThrows: true });
    await processor.processRun("r1");
    expect(runs.get("r1")!.status).toBe("failed");
    expect(runs.get("r1")!.error).toContain("配置版本不可用");
  });

  it("抢不到租约 → run 保持 queued 并重新入队", async () => {
    const { processor, runs, queue } = setup({ leaseBusy: true });
    await processor.processRun("r1");
    expect(runs.get("r1")!.status).toBe("queued");
    expect(queue.publish).toHaveBeenCalledWith(EVAL_RUN_JOB, { runId: "r1" }, { retryLimit: 3 });
  });

  it("判定：取非 null 指标最低档；写入结果行的 minMetric/minScore 即 argmin", async () => {
    const { processor, results } = setup({
      snapshot: [c(1)],
      scores: { faithfulness: 91, answerRelevancy: 55, contextPrecision: 78, correctness: null },
    });
    await processor.processRun("r1");
    expect(results[0].verdict).toBe("low"); // 55 < 60
    expect(results[0].minMetric).toBe("answerRelevancy");
    expect(results[0].minScore).toBe(55);
  });

  it("Judge 输入用编排暴露的**真实** chunkId，不合成", async () => {
    const { processor, judge } = setup({ snapshot: [c(1)] });
    await processor.processRun("r1");
    expect(judge.scoreOffline.mock.calls[0][0]).toMatchObject({
      targetTraceId: "trace-1",
      question: "问题 1",
      answer: "回答 1",
      contexts: [{ chunkId: "chunk-1", text: "片段 1", finalScore: 0.9 }],
    });
  });

  it("裁判模型取 run 行上的发起时快照，不读全局在线设置", async () => {
    const { processor, judge } = setup({ snapshot: [c(1)] });
    await processor.processRun("r1");
    expect(judge.scoreOffline.mock.calls[0][1]).toEqual({
      judgeModelId: "44444444-4444-4444-8444-444444444444",
      embeddingModelId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("tokensUsed = 编排 usage + 裁判 usage（决策 G：只累加已上报部分）", async () => {
    const { processor, runs } = setup({
      snapshot: [c(1)],
      usagePerCase: 30,
      scores: { usage: { inputTokens: 12, outputTokens: 8 } },
    });
    await processor.processRun("r1");
    expect(runs.get("r1")!.tokensUsed).toBe(50);
  });

  it("重试续跑：已落结果行的用例跳过（否则撞唯一索引，3 次重试全白给）", async () => {
    const { processor, orchestration, results } = setup({
      snapshot: [c(1), c(2)],
      runStatus: "running",
      recorded: ["cv-1"],
    });
    await processor.processRun("r1");
    expect(orchestration.runForEvaluation).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.seq)).toEqual([2]);
  });

  it("run 已是终态 → 幂等空转（pg-boss 重投递不该重跑一条跑完的 run）", async () => {
    const { processor, orchestration } = setup({ runStatus: "done" });
    const summary = await processor.processRun("r1");
    expect(summary.kind).toBe("already_finished");
    expect(orchestration.runForEvaluation).not.toHaveBeenCalled();
  });
});
