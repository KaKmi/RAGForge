import { randomUUID } from "node:crypto";
import { BadRequestException, type INestApplication } from "@nestjs/common";
import { APP_PIPE } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { TraceQualityDetail } from "@codecrush/contracts";
import { EVALUATION_UNSCORED_SCORE } from "@codecrush/otel-conventions";
import { ZodValidationPipe } from "nestjs-zod";
import request from "supertest";
import { applyGlobalConfig } from "../src/app/app-bootstrap";
import { ChunksRepository } from "../src/modules/chunks/chunks.repository";
import { ChunksService } from "../src/modules/chunks/chunks.service";
import { ConversationsRepository } from "../src/modules/conversations/conversations.repository";
import { ConversationsService } from "../src/modules/conversations/conversations.service";
import { DocumentsRepository } from "../src/modules/documents/documents.repository";
import { AnswerRelevancyEvaluator } from "../src/modules/evaluations/answer-relevancy.evaluator";
import { ClickHouseEvaluationsRepository } from "../src/modules/evaluations/clickhouse-evaluations.repository";
import { ContextPrecisionEvaluator } from "../src/modules/evaluations/context-precision.evaluator";
import { EvaluationInputService } from "../src/modules/evaluations/evaluation-input.service";
import { EvaluationJudgeService } from "../src/modules/evaluations/evaluation-judge.service";
import { EvaluationWorkerProcessor } from "../src/modules/evaluations/evaluation-worker.processor";
import { EvaluationsController } from "../src/modules/evaluations/evaluations.controller";
import { EvaluationsService } from "../src/modules/evaluations/evaluations.service";
import { EvaluationsRepository } from "../src/modules/evaluations/evaluations.repository";
import { FaithfulnessEvaluator } from "../src/modules/evaluations/faithfulness.evaluator";
import { evalDedupeKey } from "../src/modules/evaluations/sampling";
import { ClickHouseTracesRepository } from "../src/modules/traces/clickhouse-traces.repository";
import { TracesController } from "../src/modules/traces/traces.controller";
import { TracesService } from "../src/modules/traces/traces.service";
import {
  createEvaluationInfraHarness,
  E2E_EMBED_MODEL_ID,
  E2E_JUDGE_MODEL_ID,
} from "./helpers/evaluation-infra";
import { infraGate } from "./helpers/gated-suite";

describe("EvaluationsService", () => {
  const settings = {
    id: "default",
    enabled: false,
    sampleRate: 0.1,
    judgeModelId: null,
    embeddingModelId: null,
    faithfulnessThreshold: 85,
    answerRelevancyThreshold: 80,
    contextPrecisionThreshold: 80,
    dailyCap: 500,
    judgeVersion: "online-v1",
    updatedAt: new Date("2026-07-15T02:00:00.000Z"),
  };

  function setup() {
    const control = {
      getSettings: jest.fn().mockResolvedValue(settings),
      updateSettings: jest.fn().mockResolvedValue(settings),
      countLedgerByOutcome: jest.fn().mockResolvedValue({}),
      findWatermark: jest.fn().mockResolvedValue({
        lastTs: new Date("2026-07-15T01:55:00.000Z"),
        lastTraceId: "",
        dailyCount: 0,
        lastRunAt: new Date("2026-07-15T01:58:00.000Z"),
      }),
      // B1/F3：人工评测作业表
      findManualJob: jest.fn().mockResolvedValue(undefined),
      claimManualJob: jest.fn().mockResolvedValue(true),
    };
    const clickhouse = {
      getOverview: jest.fn().mockResolvedValue({
        sampleCount: 0,
        faithfulnessSampleCount: 0,
        faithfulness: null,
        answerRelevancy: null,
        contextPrecision: null,
      }),
      getMinuteAggregates: jest.fn().mockResolvedValue([]),
      getByAgent: jest.fn().mockResolvedValue([]),
      getLowSamples: jest.fn().mockResolvedValue([]),
      countEligible: jest.fn().mockResolvedValue(0),
      countEvaluable: jest.fn().mockResolvedValue(0),
      countBacklog: jest.fn().mockResolvedValue(0),
      countScoredInWindow: jest.fn().mockResolvedValue(0),
      getLatestSuccess: jest.fn().mockResolvedValue(undefined),
      getLatestFailure: jest.fn().mockResolvedValue(undefined),
      findExisting: jest.fn().mockResolvedValue(undefined),
    };
    const models = { get: jest.fn(), list: jest.fn().mockResolvedValue([]) };
    // B1/F3：人工评测队列。此前这里只传 3 个参数，而 EvaluationsService 早已是 4 参构造——
    // backend test/ 不做类型检查（tsconfig include 只有 src），于是 manualQueue 一直是
    // undefined，任何触到人工路径的断言都会 TypeError。
    const manualQueue = { publish: jest.fn(), subscribe: jest.fn(), schedule: jest.fn() };
    const service = new EvaluationsService(
      control as never,
      clickhouse as never,
      models as never,
      manualQueue as never,
    );
    return { service, control, clickhouse, models, manualQueue };
  }

  it("rejects enabling settings with a disabled or wrong-type model", async () => {
    const { service, models } = setup();
    models.get.mockResolvedValueOnce({ id: "m1", type: "embedding", enabled: true });
    await expect(
      service.updateSettings({ enabled: true, judgeModelId: "m1", embeddingModelId: "m2" }),
    ).rejects.toThrow(new BadRequestException("judgeModelId must reference an enabled llm model"));
  });

  it("returns the newest successful version before considering a later failure", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getLatestSuccess.mockResolvedValue({
      targetTraceId: "a".repeat(32),
      judgeVersion: "online-v2",
      evaluatedAt: "2026-07-15T02:00:00.000Z",
      judgeModel: "judge-1",
      faithfulness: 90,
      answerRelevancy: 80,
      contextPrecision: 70,
      evidence: JSON.stringify({
        faithfulness: ["grounded"],
        answerRelevancy: ["relevant"],
        contextPrecision: ["one noisy chunk"],
      }),
    });
    clickhouse.getLatestFailure.mockResolvedValue({
      judgeVersion: "online-v1",
      failedAt: "2026-07-15T03:00:00.000Z",
      reason: "JudgeUnavailable: down",
    });

    await expect(service.getTraceQuality("a".repeat(32))).resolves.toMatchObject({
      status: "scored",
      judgeVersion: "online-v2",
      scores: { faithfulness: 90 },
      currentVersion: false,
    });
    expect(clickhouse.getLatestFailure).not.toHaveBeenCalled();
  });

  // —— B1/F3：人工评测的读写守卫（peer review 抓出的两处）——

  /**
   * `getLatestFailure` 既不按判分版本过滤、也不带时间下界：一条失败 span 会被**永远**读回来。
   * 若让它无条件压过作业行，「重试」就永远走不通——用户点重试、POST 返回 scoring，
   * 面板每次轮询却仍读到 failed，当场被打回「裁判调用失败」，而作业其实正在跑。
   * F3 存在的理由就是重试，故按时间取新。
   */
  it("重试期间：作业比失败 span 新 → 返回 scoring 而非 failed", async () => {
    const { service, control, clickhouse } = setup();
    clickhouse.getLatestFailure.mockResolvedValue({
      judgeVersion: "online-v1",
      failedAt: "2026-07-15T02:00:00.000Z",
      reason: "JudgeUnavailable: down",
    });
    control.findManualJob.mockResolvedValue({
      status: "running",
      createdAt: new Date("2026-07-15T03:00:00.000Z"),
      updatedAt: new Date("2026-07-15T03:00:05.000Z"),
    });

    await expect(service.getTraceQuality("a".repeat(32))).resolves.toMatchObject({
      status: "scoring",
      startedAt: "2026-07-15T03:00:00.000Z",
    });
  });

  /** 反向：陈旧的作业行不得盖住一条更新的失败 span。 */
  it("作业比失败 span 旧 → 仍返回 failed", async () => {
    const { service, control, clickhouse } = setup();
    clickhouse.getLatestFailure.mockResolvedValue({
      judgeVersion: "online-v1",
      failedAt: "2026-07-15T04:00:00.000Z",
      reason: "JudgeUnavailable: down",
    });
    control.findManualJob.mockResolvedValue({
      status: "running",
      createdAt: new Date("2026-07-15T03:00:00.000Z"),
      updatedAt: new Date("2026-07-15T03:00:05.000Z"),
    });

    await expect(service.getTraceQuality("a".repeat(32))).resolves.toMatchObject({
      status: "failed",
      reason: "JudgeUnavailable: down",
    });
  });

  /**
   * 占位失败（已有 queued/running 的同名作业）时**绝不能**再入队。
   * 进程内限频挡不住多副本，pg-boss 的 singletonKey 在 standard 策略下是惰性的，
   * 这一跳是「一次点击只调一次裁判」在跨副本下唯一成立的守卫。
   */
  it("抢不到作业占位 → 返回 scoring 但不入队（不重复计费）", async () => {
    const { service, control, models, manualQueue } = setup();
    control.getSettings.mockResolvedValue({ ...settings, enabled: true, judgeModelId: "m1", embeddingModelId: "m2" });
    models.get.mockImplementation(async (id: string) => ({
      id,
      type: id === "m2" ? "embedding" : "llm",
      enabled: true,
    }));
    control.claimManualJob.mockResolvedValue(false);

    await expect(service.requestManualScore("a".repeat(32), "t@example.com")).resolves.toEqual({
      status: "scoring",
    });
    expect(manualQueue.publish).not.toHaveBeenCalled();
  });

  it("抢到作业占位 → 入队一次", async () => {
    const { service, control, models, manualQueue } = setup();
    control.getSettings.mockResolvedValue({ ...settings, enabled: true, judgeModelId: "m1", embeddingModelId: "m2" });
    models.get.mockImplementation(async (id: string) => ({
      id,
      type: id === "m2" ? "embedding" : "llm",
      enabled: true,
    }));

    await expect(service.requestManualScore("b".repeat(32), "t@example.com")).resolves.toEqual({
      status: "scoring",
    });
    expect(manualQueue.publish).toHaveBeenCalledTimes(1);
  });

  // —— 限频 vs 轮询窗口的跨层时序契约（review P2）——

  function enabledSetup() {
    const ctx = setup();
    ctx.control.getSettings.mockResolvedValue({
      ...settings,
      enabled: true,
      judgeModelId: "m1",
      embeddingModelId: "m2",
    });
    ctx.models.get.mockImplementation(async (id: string) => ({
      id,
      type: id === "m2" ? "embedding" : "llm",
      enabled: true,
    }));
    return ctx;
  }

  /**
   * 前端轮询窗口是 5s×6 = 30s（TraceDetailPage 的 QUALITY_POLL_*），到顶就渲染「重试」。
   * 若限频（60s）整段盖住它，重试第一次点击必撞 429，原型 §18.D 的
   * `failed --[重试]--> scoring` 结构上不可达。此处钉住：失败态重试不受限频约束。
   */
  it("失败态重试不被限频挡下：60s 内连续两次都受理", async () => {
    const { service, control, manualQueue } = enabledSetup();
    const traceId = "c".repeat(32);

    await expect(service.requestManualScore(traceId, "t@example.com")).resolves.toEqual({
      status: "scoring",
    });
    // 裁判失败 → 作业落 failed；紧接着（远不到 60s）点重试。
    control.findManualJob.mockResolvedValue({ status: "failed" });

    await expect(service.requestManualScore(traceId, "t@example.com")).resolves.toEqual({
      status: "scoring",
    });
    expect(manualQueue.publish).toHaveBeenCalledTimes(2);
  });

  /** 轮询到顶但作业其实还在跑：回权威的 scoring，既不 429 也不重复入队。 */
  it("作业 queued/running 时再次请求 → scoring 且不入队", async () => {
    const { service, control, manualQueue } = enabledSetup();
    const traceId = "d".repeat(32);

    await service.requestManualScore(traceId, "t@example.com");
    control.findManualJob.mockResolvedValue({ status: "running" });

    await expect(service.requestManualScore(traceId, "t@example.com")).resolves.toEqual({
      status: "scoring",
    });
    expect(manualQueue.publish).toHaveBeenCalledTimes(1);
    expect(control.claimManualJob).toHaveBeenCalledTimes(1);
  });

  /**
   * 限频剩下的唯一实职：作业已 `scored`、但 rag.eval span 因 ClickHouse 写入延迟还查不到的
   * 那个窗口——此时放行就是实打实的重复计费。放宽第 ③ 步**不能**把这道门也拆了。
   */
  it("作业已 scored 但 span 尚不可见时，60s 内二次请求仍 429", async () => {
    const { service, control } = enabledSetup();
    const traceId = "e".repeat(32);

    await service.requestManualScore(traceId, "t@example.com");
    control.findManualJob.mockResolvedValue({ status: "scored" });

    await expect(service.requestManualScore(traceId, "t@example.com")).rejects.toMatchObject({
      status: 429,
    });
  });

  /** 已评过的 trace：限频**之前**就早退成 scored——不能把一个现成的分数报成 429。 */
  it("已评过 → scored，且不占用限频配额", async () => {
    const { service, clickhouse, manualQueue } = enabledSetup();
    const traceId = "f".repeat(32);
    clickhouse.findExisting.mockResolvedValue(true);

    await expect(service.requestManualScore(traceId, "t@example.com")).resolves.toEqual({
      status: "scored",
    });
    await expect(service.requestManualScore(traceId, "t@example.com")).resolves.toEqual({
      status: "scored",
    });
    expect(manualQueue.publish).not.toHaveBeenCalled();
  });

  it("suppresses previous deltas below twenty samples", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getOverview
      .mockResolvedValueOnce({
        sampleCount: 19,
        faithfulnessSampleCount: 19,
        faithfulness: 90,
        answerRelevancy: 85,
        contextPrecision: 80,
      })
      .mockResolvedValueOnce({
        sampleCount: 100,
        faithfulnessSampleCount: 100,
        faithfulness: 80,
        answerRelevancy: 80,
        contextPrecision: 80,
      });
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.metrics.faithfulness).toMatchObject({ value: 90, previousDelta: null });
  });

  it("does not label fully passing rows as low samples", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getLowSamples.mockResolvedValue([
      {
        targetTraceId: "b".repeat(32),
        question: "high quality answer",
        faithfulness: 100,
        answerRelevancy: 100,
        contextPrecision: 100,
        evidence: "{}",
      },
    ]);

    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.lowSamples).toEqual([]);
  });

  it("maps a zero-sample agent to null scores even if ClickHouse supplies zero defaults", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getByAgent.mockResolvedValue([
      {
        agentId: "agent-empty",
        agentName: "Empty Agent",
        sampleCount: 0,
        faithfulnessSampleCount: 0,
        faithfulness: 0,
        answerRelevancy: 0,
        contextPrecision: 0,
      },
    ]);
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.byAgent).toEqual([
      { agentId: "agent-empty", agentName: "Empty Agent", sampleCount: 0, scores: null },
    ]);
  });

  it("uses faithfulness coverage for its card and trend only", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getOverview
      .mockResolvedValueOnce({
        sampleCount: 12,
        faithfulnessSampleCount: 3,
        faithfulness: 90,
        answerRelevancy: 85,
        contextPrecision: 80,
      })
      .mockResolvedValueOnce({
        sampleCount: 12,
        faithfulnessSampleCount: 2,
        faithfulness: 80,
        answerRelevancy: 75,
        contextPrecision: 70,
      });
    clickhouse.getMinuteAggregates.mockResolvedValue([
      {
        bucket: "2026-07-15T01:00:00.000Z",
        sampleCount: 12,
        faithfulnessSampleCount: 3,
        faithfulness: 90,
        answerRelevancy: 85,
        contextPrecision: 80,
      },
    ]);

    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.metrics.faithfulness).toMatchObject({ sampleCount: 3, previousDelta: null });
    expect(result.metrics.answerRelevancy.sampleCount).toBe(12);
    expect(result.trend[0]).toMatchObject({ faithfulnessSampleCount: 3, sampleCount: 12 });
  });

  it("preserves a partial agent score and chooses a scored minimum", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getByAgent.mockResolvedValue([
      {
        agentId: "app-1",
        agentName: "Refund Bot",
        sampleCount: 12,
        faithfulnessSampleCount: 0,
        faithfulness: null,
        answerRelevancy: 72,
        contextPrecision: 88,
      },
    ]);
    clickhouse.getLowSamples.mockResolvedValue([
      {
        targetTraceId: "b".repeat(32),
        question: "refund",
        faithfulness: null,
        answerRelevancy: 72,
        contextPrecision: 88,
        evidence: "{}",
      },
    ]);

    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.byAgent[0]?.scores).toEqual({
      faithfulness: null,
      answerRelevancy: 72,
      contextPrecision: 88,
    });
    expect(result.lowSamples[0]).toMatchObject({
      minMetric: "answerRelevancy",
      minScore: 72,
    });
  });

  it("rejects a leaked sentinel at the service boundary", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getOverview.mockResolvedValue({
      sampleCount: 1,
      faithfulnessSampleCount: 1,
      faithfulness: -1,
      answerRelevancy: 80,
      contextPrecision: 80,
    });
    await expect(service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"))).rejects.toThrow(
      new RangeError("evaluation score out of range: expected 0..100"),
    );
  });

  it("preserves nullable faithfulness and optional evidence in trace quality", async () => {
    const { service, clickhouse } = setup();
    clickhouse.getLatestSuccess.mockResolvedValue({
      targetTraceId: "a".repeat(32),
      judgeVersion: "online-v2",
      evaluatedAt: "2026-07-15T02:00:00.000Z",
      judgeModel: "judge-1",
      faithfulness: null,
      answerRelevancy: 80,
      contextPrecision: 70,
      evidence: JSON.stringify({
        answerRelevancy: ["relevant"],
        contextPrecision: ["one noisy chunk"],
      }),
    });

    await expect(service.getTraceQuality("a".repeat(32))).resolves.toMatchObject({
      status: "scored",
      scores: { faithfulness: null, answerRelevancy: 80, contextPrecision: 70 },
      evidence: {
        answerRelevancy: ["relevant"],
        contextPrecision: ["one noisy chunk"],
      },
    });
  });

  // 一个 GET 绝不能推进/播种游标：getOrCreateWatermark 会把它钉在 now-24h，
  // 于是「打开一次屏1」就把更早的历史永久排除出候选集。
  // control fixture 上**故意没有** getOrCreateWatermark：service 若去调它会直接 TypeError，
  // 这比断言「没被调用」更硬——加回那一行的人会立刻看到红。
  it("never creates the watermark from the read path", async () => {
    const { service, control } = setup();
    await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(control.findWatermark).toHaveBeenCalledWith("online-quality-v1");
  });

  // status 是一条优先级链（disabled → model_unavailable → …），要测后面的档必须先把前面的让开。
  function setupRunning() {
    const harness = setup();
    harness.control.getSettings.mockResolvedValue({
      ...settings,
      enabled: true,
      judgeModelId: "judge-1",
      embeddingModelId: "embed-1",
    });
    harness.models.get.mockImplementation(async (id: string) => ({
      id,
      name: id,
      enabled: true,
      type: id === "judge-1" ? "llm" : "embedding",
    }));
    return harness;
  }

  it.each([
    ["水位线行还不存在（worker 一轮都没跑过）", undefined],
    [
      "lastRunAt 为空",
      {
        lastTs: new Date("2026-07-15T01:55:00.000Z"),
        lastTraceId: "",
        dailyCount: 0,
        lastRunAt: null,
      },
    ],
    [
      "lastRunAt 超过两轮 cron 没动",
      {
        lastTs: new Date("2026-07-15T01:00:00.000Z"),
        lastTraceId: "",
        dailyCount: 0,
        lastRunAt: new Date("2026-07-15T01:20:00.000Z"),
      },
    ],
  ])("reports worker_stalled when %s", async (_label, watermark) => {
    const { service, control } = setupRunning();
    control.findWatermark.mockResolvedValue(watermark);
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    // 没流量时 backlog=0，旧口径会把「worker 死了」报成 healthy——这正是要分开的两件事。
    expect(result.meta.backlog).toBe(0);
    expect(result.meta.status).toBe("worker_stalled");
  });

  it("keeps a freshly reporting worker healthy", async () => {
    const { service } = setupRunning();
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.meta.status).toBe("healthy");
  });

  // 账本只覆盖「worker 看过的」。冷启动播种孤儿化的 trace 从没进过候选集、没有账本行——
  // 它们是「已错过」减去账本之后剩下的那部分。把「已错过」直接换成查账本会让它显示 0
  // 而不是真实的数（018 §12 缺口 20 的那 31 条正是 neverSeen，账本一行都没有）。
  it("attributes cursor-passed traces the ledger never saw to neverSeen", async () => {
    const { service, control, clickhouse } = setupRunning();
    clickhouse.countEligible.mockResolvedValue(32);
    clickhouse.countEvaluable.mockResolvedValue(0);
    control.countLedgerByOutcome.mockResolvedValue({}); // worker 一条都没看过
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.meta.missed).toEqual({
      total: 32,
      sampledOut: 0,
      quotaSkipped: 0,
      incomplete: 0,
      judgeFailed: 0,
      neverSeen: 32,
    });
  });

  it("splits missed traces by what the ledger recorded", async () => {
    const { service, control, clickhouse } = setupRunning();
    clickhouse.countEligible.mockResolvedValue(20);
    clickhouse.countEvaluable.mockResolvedValue(2);
    control.countLedgerByOutcome.mockResolvedValue({
      success: 3,
      already_scored: 1,
      sampled_out: 6,
      quota_skipped_normal: 1,
      incomplete: 2,
      processed_failed: 1,
    });
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    // 20 窗口内 − 2 仍可评 − (3 success + 1 already_scored) = 14 已错过
    // 账本认领 6+1+2+1 = 10 ⇒ 剩 4 条从没被看过
    expect(result.meta.missed).toEqual({
      total: 14,
      sampledOut: 6,
      quotaSkipped: 1,
      incomplete: 2,
      judgeFailed: 1,
      neverSeen: 4,
    });
  });

  // 账本说评过、CH 查不到 ⇒ span 丢了。forceFlushTelemetry 吞掉导出失败，故
  // 「worker 认为评了」不蕴含「分数可查」——账本是唯一不依赖 span 投递的证据。
  it("reports scores the ledger claims but ClickHouse cannot show", async () => {
    const { service, control, clickhouse } = setupRunning();
    control.countLedgerByOutcome.mockResolvedValue({ success: 5, already_scored: 2 });
    clickhouse.countScoredInWindow.mockResolvedValue(4);
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.meta.scoresNotPersisted).toBe(3);
  });

  it("never reports negative loss when ClickHouse leads the ledger", async () => {
    const { service, control, clickhouse } = setupRunning();
    // 账本被保留期清理过、CH 还留着旧分数 ⇒ CH 多于账本，这不是丢包
    control.countLedgerByOutcome.mockResolvedValue({ success: 1 });
    clickhouse.countScoredInWindow.mockResolvedValue(9);
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(result.meta.scoresNotPersisted).toBe(0);
  });

  // 游标不存在 ⇒ 此刻还没有任何 trace 被越过 ⇒ 全窗口都仍可评，「已错过」为 0。
  it("counts everything as still evaluable before the first cycle", async () => {
    const { service, control, clickhouse } = setup();
    control.findWatermark.mockResolvedValue(undefined);
    clickhouse.countEligible.mockResolvedValue(32);
    const result = await service.getOverview({}, new Date("2026-07-15T02:00:00.000Z"));
    expect(clickhouse.countEvaluable).not.toHaveBeenCalled();
    expect(result.meta).toMatchObject({ eligibleCount: 32, evaluableCount: 32 });
  });
});

const describeInfra = infraGate();

describeInfra("E-W1 infrastructure flow", () => {
  let app: INestApplication;
  let harness: Awaited<ReturnType<typeof createEvaluationInfraHarness>>;
  let evaluationsRepo: EvaluationsRepository;
  let clickhouseEvaluations: ClickHouseEvaluationsRepository;
  let processor: EvaluationWorkerProcessor;
  let service: EvaluationsService;
  let traces: TracesService;

  const fixedNow = new Date("2026-07-15T02:00:00.000Z");
  const onlineJudgeVersion = "online-v2";
  const targetTraceId = randomUUID().replaceAll("-", "");
  const previewTraceId = randomUUID().replaceAll("-", "");
  const evaluationTraceId = randomUUID().replaceAll("-", "");
  const agentId = `agent-e2e-${targetTraceId.slice(0, 12)}`;
  const from = "2026-07-15T01:00:00.000Z";
  const to = "2026-07-15T03:00:00.000Z";
  const fakeModels = {
    get: jest.fn(async (id: string) => ({
      id,
      name: id === E2E_JUDGE_MODEL_ID ? "e2e-judge" : "e2e-embed",
      type: id === E2E_JUDGE_MODEL_ID ? "llm" : "embedding",
      enabled: true,
    })),
    list: jest.fn(async () => [
      { id: E2E_JUDGE_MODEL_ID, name: "e2e-judge", type: "llm", enabled: true },
      { id: E2E_EMBED_MODEL_ID, name: "e2e-embed", type: "embedding", enabled: true },
    ]),
    chat: jest.fn(async (_id: string, messages: Array<{ role: string; content: string }>) => {
      const system = messages[0]?.content ?? "";
      if (system.includes("factual claim")) {
        return {
          content: JSON.stringify({
            claims: [{ claim: "七天内可以退款", supported: true, reason: "知识片段明确支持" }],
          }),
        };
      }
      if (system.includes("one to three concise questions")) {
        return { content: JSON.stringify({ questions: ["退款期限多久"] }) };
      }
      const input = JSON.parse(messages[1]?.content ?? "{}") as {
        contexts?: Array<{ chunkId: string }>;
      };
      return {
        content: JSON.stringify({
          judgments: (input.contexts ?? []).map((context) => ({
            chunkId: context.chunkId,
            relevant: false,
            reason: "测试夹具将该片段标记为低分，以覆盖低质量筛选链路",
          })),
        }),
      };
    }),
    embedTexts: jest.fn(async (_id: string, texts: string[]) => texts.map(() => [1, 0, 0])),
  };

  const settingsUpdate = {
    enabled: true,
    sampleRate: 1,
    judgeModelId: E2E_JUDGE_MODEL_ID,
    embeddingModelId: E2E_EMBED_MODEL_ID,
    faithfulnessThreshold: 85,
    answerRelevancyThreshold: 80,
    contextPrecisionThreshold: 80,
    dailyCap: 500,
  };

  const evalAttributes = (traceId: string, version: string, score: number | null) => ({
    "rag.eval.status": "success",
    "rag.eval.target_trace_id": traceId,
    "rag.eval.dedupe_key": evalDedupeKey(traceId, version),
    "rag.eval.version": version,
    "rag.eval.faithfulness": String(score ?? EVALUATION_UNSCORED_SCORE),
    "rag.eval.answer_relevancy": String(score),
    "rag.eval.context_precision": String(score),
    "rag.eval.judge_model": "judge-1",
    "gen_ai.agent.id": agentId,
    "gen_ai.request.model": "generation-1",
  });

  beforeAll(async () => {
    harness = await createEvaluationInfraHarness();
    await harness.resetAndMigrate();
    evaluationsRepo = new EvaluationsRepository(harness.db as never);
    clickhouseEvaluations = new ClickHouseEvaluationsRepository(harness.clickhouse);
    const conversations = new ConversationsService(
      new ConversationsRepository(harness.db as never),
    );
    const chunks = new ChunksService(
      new ChunksRepository(harness.db as never),
      new DocumentsRepository(harness.db as never),
    );
    const input = new EvaluationInputService(conversations, chunks);
    const judge = new EvaluationJudgeService(
      new FaithfulnessEvaluator(fakeModels as never),
      new AnswerRelevancyEvaluator(fakeModels as never),
      new ContextPrecisionEvaluator(fakeModels as never),
    );
    const emitter = {
      emitSuccess: jest.fn(
        async (payload: {
          candidate: { agentId: string; generationModel: string };
          input: { targetTraceId: string };
          settings: { judgeModelId: string; judgeVersion: string };
          result: {
            faithfulness: number | null;
            answerRelevancy: number;
            contextPrecision: number;
            evidence: unknown;
          };
        }) => {
          await harness.insertSpan({
            traceId: evaluationTraceId,
            spanId: evaluationTraceId.slice(0, 16),
            at: "2026-07-15T01:45:00.000Z",
            name: "rag.eval",
            attributes: {
              ...evalAttributes(
                payload.input.targetTraceId,
                payload.settings.judgeVersion,
                payload.result.faithfulness,
              ),
              "rag.eval.answer_relevancy": String(payload.result.answerRelevancy),
              "rag.eval.context_precision": String(payload.result.contextPrecision),
              "rag.eval.judge_model": payload.settings.judgeModelId,
              "gen_ai.agent.id": payload.candidate.agentId,
              "gen_ai.request.model": payload.candidate.generationModel,
              "codecrush.io.output": JSON.stringify(payload.result.evidence),
            },
          });
        },
      ),
      emitFailure: jest.fn(),
    };
    processor = new EvaluationWorkerProcessor(
      { subscribe: jest.fn(), schedule: jest.fn() } as never,
      evaluationsRepo,
      clickhouseEvaluations,
      input,
      judge,
      emitter as never,
      fakeModels as never,
      { onlineEvalBackfillWindowHours: 24 } as never,
    );
    service = new EvaluationsService(evaluationsRepo, clickhouseEvaluations, fakeModels as never);
    traces = new TracesService(new ClickHouseTracesRepository(harness.clickhouse));
    const ref = await Test.createTestingModule({
      controllers: [EvaluationsController, TracesController],
      providers: [
        { provide: EvaluationsService, useValue: service },
        { provide: TracesService, useValue: traces },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    }).compile();
    app = ref.createNestApplication();
    applyGlobalConfig(app);
    await app.init();
  });

  afterEach(async () => harness.cleanup([targetTraceId, previewTraceId]));
  afterAll(async () => {
    await app.close();
    await harness.close();
  });

  it("runs worker to quality and Trace APIs without external model calls", async () => {
    await evaluationsRepo.updateSettings(settingsUpdate);
    await evaluationsRepo.getOrCreateWatermark("online-quality-v1", fixedNow);
    await harness.pool.query(
      "UPDATE eval_watermarks SET last_ts=$1,last_trace_id='' WHERE worker_name=$2",
      ["2026-07-15T01:00:00.000Z", "online-quality-v1"],
    );
    const { chunkId } = await harness.seedPgInput(targetTraceId, agentId);
    await harness.insertSpan({
      traceId: targetTraceId,
      spanId: "1".repeat(16),
      at: "2026-07-15T01:30:00.000Z",
      name: "rag.pipeline",
      attributes: {
        "codecrush.span.kind": "chain",
        "rag.preview": "false",
        "codecrush.io.input": "退款期限多久",
        "codecrush.io.output": "七天内可以退款",
        "gen_ai.agent.id": agentId,
        "gen_ai.agent.name": "退款助手",
        "gen_ai.request.model": "generation-1",
        "rag.fallback.used": "true",
        "rag.quality.no_citations": "true",
      },
    });
    await harness.insertSpan({
      traceId: targetTraceId,
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      at: "2026-07-15T01:30:01.000Z",
      name: "rag.retrieve",
      attributes: {
        "codecrush.span.kind": "retrieval",
        "rag.chunk.scores": JSON.stringify([{ chunkId, final: 0.9 }]),
      },
    });
    await harness.insertSpan({
      traceId: previewTraceId,
      spanId: "3".repeat(16),
      at: "2026-07-15T01:31:00.000Z",
      name: "rag.pipeline",
      attributes: {
        "codecrush.span.kind": "chain",
        "rag.preview": "true",
        "gen_ai.agent.id": agentId,
      },
    });

    const result = await processor.processCycle("online-quality-v1", fixedNow);
    expect(result.evaluatedCount).toBe(1);
    let detail: TraceQualityDetail = { status: "unscored" };
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      detail = await service.getTraceQuality(targetTraceId);
      if (detail.status === "scored") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(detail).toMatchObject({
      status: "scored",
      judgeVersion: onlineJudgeVersion,
      currentVersion: true,
      scores: { faithfulness: null, answerRelevancy: 100, contextPrecision: 0 },
      thresholds: { faithfulness: 85, answerRelevancy: 80, contextPrecision: 80 },
    });
    const overview = await service.getOverview({ from, to, agentId });
    const list = await traces.listTraces({
      page: 1,
      pageSize: 20,
      agentId,
      evalVerdict: "low",
    });
    expect(overview.meta.evaluatedCount).toBe(1);
    expect(overview.metrics).toMatchObject({
      faithfulness: { value: null, threshold: 85, low: false, sampleCount: 0 },
      answerRelevancy: { value: 100, threshold: 80, low: false },
      contextPrecision: { value: 0, threshold: 80, low: true },
    });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      traceId: targetTraceId,
      evaluation: {
        status: "scored",
        scores: { faithfulness: null, answerRelevancy: 100, contextPrecision: 0 },
        minMetric: "contextPrecision",
        minScore: 0,
        judgeVersion: onlineJudgeVersion,
      },
    });

    await request(app.getHttpServer())
      .get("/api/eval/quality/overview")
      .query({ from, to, agentId })
      .expect(200)
      .expect((response) => expect(response.body.meta.evaluatedCount).toBe(1));
    await request(app.getHttpServer())
      .get(`/api/eval/quality/traces/${targetTraceId}`)
      .expect(200)
      .expect((response) =>
        expect(response.body).toMatchObject({
          status: "scored",
          currentVersion: true,
          judgeVersion: onlineJudgeVersion,
          scores: { faithfulness: null, answerRelevancy: 100, contextPrecision: 0 },
          thresholds: { faithfulness: 85, answerRelevancy: 80, contextPrecision: 80 },
        }),
      );
    await request(app.getHttpServer())
      .get("/api/eval/quality/settings")
      .expect(200)
      .expect((response) =>
        expect(response.body.models).toEqual(
          expect.objectContaining({ judges: expect.any(Array), embeddings: expect.any(Array) }),
        ),
      );
    await request(app.getHttpServer())
      .put("/api/eval/quality/settings")
      .send({
        enabled: true,
        judgeModelId: E2E_JUDGE_MODEL_ID,
        embeddingModelId: E2E_EMBED_MODEL_ID,
      })
      .expect(200);
    await request(app.getHttpServer())
      .get("/api/traces")
      .query({ evalVerdict: "low", agentId, page: 1, pageSize: 20 })
      .expect(200)
      .expect((response) =>
        expect(response.body.items).toEqual([
          expect.objectContaining({
            traceId: targetTraceId,
            evaluation: expect.objectContaining({
              status: "scored",
              scores: { faithfulness: null, answerRelevancy: 100, contextPrecision: 0 },
              minMetric: "contextPrecision",
              minScore: 0,
            }),
          }),
        ]),
      );
    await expect(
      clickhouseEvaluations.findExisting(previewTraceId, onlineJudgeVersion),
    ).resolves.toBeUndefined();
  });

  it("deduplicates cross-minute retry spans in the API", async () => {
    await harness.seedPgInput(targetTraceId, agentId);
    await evaluationsRepo.updateSettings(settingsUpdate);
    await harness.insertSpan({
      traceId: evaluationTraceId,
      spanId: "4".repeat(16),
      at: "2026-07-15T01:59:59.000Z",
      name: "rag.eval",
      attributes: evalAttributes(targetTraceId, onlineJudgeVersion, 40),
    });
    await harness.insertSpan({
      traceId: evaluationTraceId,
      spanId: "5".repeat(16),
      at: "2026-07-15T02:00:01.000Z",
      name: "rag.eval",
      attributes: evalAttributes(targetTraceId, onlineJudgeVersion, 90),
    });
    const overview = await service.getOverview({ from, to, agentId });
    expect(overview.meta.evaluatedCount).toBe(1);
    expect(overview.metrics.faithfulness.value).toBe(90);
  });

  it("never evaluates a preview-only trace", async () => {
    await harness.seedPgInput(targetTraceId, agentId);
    await evaluationsRepo.updateSettings(settingsUpdate);
    await evaluationsRepo.getOrCreateWatermark("online-quality-v1", fixedNow);
    await harness.pool.query(
      "UPDATE eval_watermarks SET last_ts=$1,last_trace_id='' WHERE worker_name=$2",
      ["2026-07-15T01:00:00.000Z", "online-quality-v1"],
    );
    await harness.insertSpan({
      traceId: previewTraceId,
      spanId: "6".repeat(16),
      at: "2026-07-15T01:30:00.000Z",
      name: "rag.pipeline",
      attributes: {
        "codecrush.span.kind": "chain",
        "rag.preview": "true",
        "gen_ai.agent.id": agentId,
      },
    });
    const result = await processor.processCycle("online-quality-v1", fixedNow);
    expect(result.evaluatedCount).toBe(0);
    await expect(service.getTraceQuality(previewTraceId)).resolves.toEqual({
      status: "unscored",
    });
  });

  it("falls back to an older successful version and marks it non-current", async () => {
    await harness.seedPgInput(targetTraceId, agentId);
    await evaluationsRepo.updateSettings(settingsUpdate);
    await harness.insertSpan({
      traceId: evaluationTraceId,
      spanId: "7".repeat(16),
      at: "2026-07-15T01:30:00.000Z",
      name: "rag.eval",
      attributes: evalAttributes(targetTraceId, "online-v0", 70),
    });
    await expect(service.getTraceQuality(targetTraceId)).resolves.toMatchObject({
      status: "scored",
      judgeVersion: "online-v0",
      currentVersion: false,
    });
  });
});
