import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { CreateEvalRunRequest } from "@codecrush/contracts";
import { EVAL_RUN_JOB } from "../src/platform/queue/queue.constants";
import { EvalRunsService } from "../src/modules/eval-runs/eval-runs.service";
import type {
  EvalRunAggregate,
  EvalRunResultWithCase,
  NewEvalRunInput,
} from "../src/modules/eval-runs/eval-runs.repository";
import type { ReviewedCaseVersion } from "../src/modules/eval-runs/eval-sets.repository";
import type { EvalRunRow, EvalRunSnapshotEntry } from "../src/modules/eval-runs/schema";

// fake-repo 风格同 eval-sets.service.spec.ts：手写内存实现，不引 DB。
const now = new Date("2026-07-16T00:00:00.000Z");
const SET_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const JUDGE_ID = "44444444-4444-4444-8444-444444444444";
const EMBED_ID = "55555555-5555-4555-8555-555555555555";

function req(overrides: Partial<CreateEvalRunRequest> = {}): CreateEvalRunRequest {
  return {
    setId: SET_ID,
    applicationId: APP_ID,
    configVersionId: VERSION_ID,
    judgeModelId: JUDGE_ID,
    embeddingModelId: EMBED_ID,
    force: false,
    ...overrides,
  };
}

function reviewed(seq: number): ReviewedCaseVersion {
  return {
    caseId: `case-${seq}`,
    caseVersionId: `cv-${seq}`,
    question: `问题 ${seq}`,
    goldPoints: ["要点"],
    seq,
  };
}

function makeRun(overrides: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: "run-1",
    setId: SET_ID,
    applicationId: APP_ID,
    configVersionId: VERSION_ID,
    judgeModelId: JUDGE_ID,
    embeddingModelId: EMBED_ID,
    offlineJudgeVersion: "offline-v1",
    status: "queued",
    scope: "all",
    caseVersionSnapshot: [],
    totalCases: 0,
    doneCases: 0,
    tokenBudget: 500000,
    tokensUsed: 0,
    stopRequestedAt: null,
    leaseOwner: null,
    leaseUntil: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    createdBy: "admin",
    createdAt: now,
    ...overrides,
  };
}

interface SetupOptions {
  setDeleted?: boolean;
  reviewedCases?: ReviewedCaseVersion[];
  activeRun?: Partial<EvalRunRow>;
  recentDoneRun?: Partial<EvalRunRow>;
  runs?: Partial<EvalRunRow>[];
  results?: Partial<EvalRunResultWithCase>[];
  resolveThrows?: boolean;
  versionsThrow?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const runs = new Map<string, EvalRunRow>();
  for (const row of opts.runs ?? []) runs.set(row.id ?? "run-1", makeRun(row));
  if (opts.activeRun) runs.set(opts.activeRun.id ?? "r-active", makeRun(opts.activeRun));
  const recentDone = opts.recentDoneRun
    ? makeRun({ status: "done", finishedAt: now, ...opts.recentDoneRun })
    : undefined;
  if (recentDone) runs.set(recentDone.id, recentDone);

  let nextId = 0;
  const publish = jest.fn(async () => undefined);
  const queue = { publish, subscribe: jest.fn(), schedule: jest.fn() };

  const aggregate = (row: EvalRunRow): EvalRunAggregate => ({
    ...row,
    setName: "售后核心 50 题",
    overallScore: null,
  });

  const repo = {
    async listAggregates() {
      return [...runs.values()].map(aggregate);
    },
    async findAggregateById(id: string) {
      const row = runs.get(id);
      return row ? aggregate(row) : undefined;
    },
    async findRunById(id: string) {
      return runs.get(id);
    },
    async findActiveRun() {
      return [...runs.values()].find((r) => r.status === "queued" || r.status === "running");
    },
    async findRecentDoneRun(setId: string, configVersionId: string) {
      if (!recentDone) return undefined;
      return recentDone.setId === setId && recentDone.configVersionId === configVersionId
        ? recentDone
        : undefined;
    },
    async insertRun(input: NewEvalRunInput) {
      const row = makeRun({ ...input, id: `new-run-${++nextId}`, status: "queued" });
      runs.set(row.id, row);
      return row;
    },
    async requestStop(id: string, at: Date) {
      const row = runs.get(id);
      if (!row || (row.status !== "queued" && row.status !== "running")) return false;
      row.stopRequestedAt = at;
      return true;
    },
    async listResults(runId: string): Promise<EvalRunResultWithCase[]> {
      return (opts.results ?? []).map(
        (r, index) =>
          ({
            id: `res-${index}`,
            runId,
            caseVersionId: r.caseVersionId ?? `cv-${index + 1}`,
            seq: r.seq ?? index + 1,
            verdict: r.verdict ?? "pass",
            faithfulness: r.faithfulness ?? null,
            answerRelevancy: r.answerRelevancy ?? null,
            contextPrecision: r.contextPrecision ?? null,
            correctness: r.correctness ?? null,
            minMetric: r.minMetric ?? null,
            minScore: r.minScore ?? null,
            evidence: r.evidence ?? {},
            previewTraceId: r.previewTraceId ?? null,
            answer: r.answer ?? "",
            tokensUsed: 0,
            durationMs: 0,
            error: null,
            createdAt: now,
            caseId: r.caseId ?? `case-${index + 1}`,
            caseVersion: r.caseVersion ?? 1,
            question: r.question ?? `问题 ${index + 1}`,
          }) as EvalRunResultWithCase,
      );
    },
    async listRecordedCaseVersionIds() {
      return [];
    },
    async findCaseVersionsByIds(ids: string[]) {
      return ids.map((id) => ({
        id,
        caseId: id.replace("cv-", "case-"),
        version: 1,
        question: `问题 ${id.replace("cv-", "")}`,
        goldPoints: ["要点"],
      }));
    },
  };

  const sets = {
    async findSetById(id: string) {
      if (opts.setDeleted || id !== SET_ID) return undefined;
      return { id, name: "售后核心 50 题" };
    },
    async listReviewedCaseVersions() {
      if (opts.setDeleted) return [];
      return opts.reviewedCases ?? [reviewed(1)];
    },
  };

  const applications = {
    resolveForTest: jest.fn(async () => {
      if (opts.resolveThrows) throw new NotFoundException("版本不存在");
      return { applicationId: APP_ID, configVersionId: VERSION_ID, version: 7 };
    }),
    listVersions: jest.fn(async () => {
      if (opts.versionsThrow) throw new NotFoundException("应用不存在");
      return [{ id: VERSION_ID, version: 7 }];
    }),
  };

  const service = new EvalRunsService(
    repo as never,
    sets as never,
    applications as never,
    queue as never,
  );
  return { service, runs, queue, repo, applications };
}

describe("EvalRunsService", () => {
  it("create：0 条 reviewed 用例 → 422「所选范围没有已审核用例」", async () => {
    const { service } = setup({ reviewedCases: [] });
    await expect(service.create(req(), "admin")).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(service.create(req(), "admin")).rejects.toThrow("所选范围没有已审核用例");
  });

  it("create：评测集已软删 → 404（不是「没有已审核用例」这个误导文案）", async () => {
    // 集软删不可跑（listReviewedCaseVersions 已 join 过滤集），但错因是「集没了」而非「没审用例」。
    const { service, queue } = setup({ setDeleted: true });
    await expect(service.create(req(), "admin")).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it("create：1h 内同 set×version 已有 done run 且 force=false → 409 recent_run_exists", async () => {
    const { service } = setup({ recentDoneRun: { id: "r-old", status: "done" } });
    await expect(service.create(req({ force: false }), "admin")).rejects.toMatchObject({
      response: { code: "recent_run_exists", recentRunId: "r-old" },
    });
  });

  it("create：force=true 跳过幂等复用，照常入队（retryLimit=3，原型 §18.A）", async () => {
    const { service, queue } = setup({ recentDoneRun: { id: "r-old", status: "done" } });
    const run = await service.create(req({ force: true }), "admin");
    expect(run.status).toBe("queued");
    expect(queue.publish).toHaveBeenCalledWith(EVAL_RUN_JOB, { runId: run.id }, { retryLimit: 3 });
  });

  it("create：已有 queued/running 的 run → 409（全局串行）", async () => {
    const { service } = setup({ activeRun: { id: "r-active", status: "running" } });
    await expect(service.create(req(), "admin")).rejects.toBeInstanceOf(ConflictException);
  });

  it("create：快照发起时的 case 版本（之后改用例不影响本 run）", async () => {
    const { service, runs } = setup({ reviewedCases: [reviewed(1)] });
    const run = await service.create(req(), "admin");
    expect(runs.get(run.id)!.caseVersionSnapshot).toEqual([
      { caseId: "case-1", caseVersionId: "cv-1", seq: 1 },
    ]);
    expect(runs.get(run.id)!.totalCases).toBe(1);
  });

  it("create：配置版本不可解析 → 422「该版本已不可用」且不落 run 行、不入队", async () => {
    // 校验必须先于写库：否则留一条必然 failed 的 run 还占着全局串行位。
    const { service, runs, queue } = setup({ resolveThrows: true });
    await expect(service.create(req(), "admin")).rejects.toThrow("该版本已不可用");
    expect(runs.size).toBe(0);
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it("create：配置版本标签取自 resolveForTest 的版本号（原型 §7 的「v7」）", async () => {
    const { service, applications } = setup();
    const run = await service.create(req(), "admin");
    expect(run.configVersionLabel).toBe("v7");
    expect(applications.resolveForTest).toHaveBeenCalledWith(APP_ID, VERSION_ID, "admin");
  });

  it("stop：仅 queued/running 可停；终态 → 409", async () => {
    const { service } = setup({ runs: [{ id: "r1", status: "done" }] });
    await expect(service.stop("r1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("stop：running → 置 stopRequestedAt（worker 逐条检查后收 partial）", async () => {
    const { service, runs } = setup({ runs: [{ id: "r1", status: "running" }] });
    await service.stop("r1");
    expect(runs.get("r1")!.stopRequestedAt).toBeInstanceOf(Date);
    expect(runs.get("r1")!.status).toBe("running"); // 状态由 worker 收尾，不在此处改
  });

  it("stop：run 不存在 → 404", async () => {
    const { service } = setup();
    await expect(service.stop("nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getReport：记分卡各指标只对非 NULL 求 avg，并回传覆盖率", async () => {
    // 未评（NULL）绝不按 0 计入 —— 原型 §6「不拉低均值」。
    const { service } = setup({
      runs: [{ id: "r1", status: "done", caseVersionSnapshot: [] }],
      results: [
        { seq: 1, verdict: "pass", faithfulness: 90, answerRelevancy: 80, contextPrecision: 80 },
        { seq: 2, verdict: "weak", faithfulness: 70, answerRelevancy: null, contextPrecision: 60 },
      ],
    });
    const report = await service.getReport("r1");
    expect(report.scorecard.generation.faithfulness).toEqual({
      value: 80, // (90+70)/2 —— 不是 (90+70+0)/3
      scoredCount: 2,
      total: 2,
    });
    expect(report.scorecard.generation.answerRelevancy).toEqual({
      value: 80, // 只有一个非 NULL 样本
      scoredCount: 1,
      total: 2,
    });
    expect(report.scorecard.generation.correctness).toEqual({
      value: null, // 全 NULL → null，**绝不退化成 0**
      scoredCount: 0,
      total: 2,
    });
    expect(report.scorecard.passCount).toBe(1);
    expect(report.scorecard.weakCount).toBe(1);
  });

  it("getReport：skipped 由 snapshot − 结果行推导（未跑用例不写结果行）", async () => {
    const snapshot: EvalRunSnapshotEntry[] = [
      { caseId: "case-1", caseVersionId: "cv-1", seq: 1 },
      { caseId: "case-2", caseVersionId: "cv-2", seq: 2 },
      { caseId: "case-3", caseVersionId: "cv-3", seq: 3 },
    ];
    const { service } = setup({
      runs: [{ id: "r1", status: "partial", caseVersionSnapshot: snapshot, totalCases: 3 }],
      results: [{ seq: 1, caseVersionId: "cv-1", verdict: "pass", faithfulness: 90 }],
    });
    const report = await service.getReport("r1");
    expect(report.skipped.map((row) => row.seq)).toEqual([2, 3]);
    expect(report.scorecard.skippedCount).toBe(2);
    expect(report.results).toHaveLength(1);
  });

  it("getReport：timeout/unscored 计数显性可见，且不进 pass/weak/low 分母", async () => {
    // 018 已知取舍 2 的代价缓解：每条都超时的 run 表现为覆盖率 0% 而非低分 → 计数必须显眼。
    const { service } = setup({
      runs: [{ id: "r1", status: "done", caseVersionSnapshot: [] }],
      results: [
        { seq: 1, verdict: "timeout" },
        { seq: 2, verdict: "unscored" },
      ],
    });
    const report = await service.getReport("r1");
    expect(report.scorecard.timeoutCount).toBe(1);
    expect(report.scorecard.unscoredCount).toBe(1);
    expect(report.scorecard.passCount + report.scorecard.weakCount + report.scorecard.lowCount).toBe(
      0,
    );
  });

  it("getReport：run 不存在 → 404", async () => {
    const { service } = setup();
    await expect(service.getReport("nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("list：应用被软删导致版本查不到 → 标签退化为「—」，报告仍可列出", async () => {
    const { service } = setup({ runs: [{ id: "r1", status: "done" }], versionsThrow: true });
    const [item] = await service.list();
    expect(item.configVersionLabel).toBe("—");
    expect(item.id).toBe("r1");
  });

  it("list：耗时只在 started+finished 齐全时给值，运行中为 null", async () => {
    const { service } = setup({
      runs: [
        {
          id: "r1",
          status: "done",
          startedAt: now,
          finishedAt: new Date(now.getTime() + 3000),
        },
        { id: "r2", status: "running", startedAt: now },
      ],
    });
    const items = await service.list();
    expect(items.find((i) => i.id === "r1")!.durationMs).toBe(3000);
    expect(items.find((i) => i.id === "r2")!.durationMs).toBeNull();
  });
});
