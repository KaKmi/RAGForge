import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import type { EvalMetricKey, EvalRunStatus, EvalVerdict } from "@codecrush/contracts";
import { EVAL_RUN_JOB, EVAL_RUN_QUEUE, EVAL_RUN_WORKER } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { ApplicationsService } from "../applications/applications.service";
import { OrchestrationService } from "../chat/orchestration.service";
import { EvaluationJudgeService } from "../evaluations/evaluation-judge.service";
import type {
  EvaluationModelIds,
  OfflineEvaluationScores,
} from "../evaluations/evaluation.types";
import {
  EVAL_RUN_BASE_METRIC_KEYS,
  EVAL_RUN_CASE_TIMEOUT_MS,
  EVAL_RUN_JOB_RETRY_LIMIT,
  EVAL_RUN_LEASE_MS,
  EVAL_RUN_LOW_THRESHOLD,
  EVAL_RUN_MAX_CONTEXTS,
  EVAL_RUN_METRIC_KEYS,
  EVAL_RUN_PASS_THRESHOLD,
} from "./eval-run.constants";
import { EvalRunsRepository } from "./eval-runs.repository";
import type { EvalRunSnapshotEntry } from "./schema";

const JobPayloadSchema = z.strictObject({ runId: z.string().uuid() });

export type EvalRunOutcomeKind =
  /** 另一个 worker 正持有该 run 的租约 → 已重新入队，run 保持 queued。 */
  | "lease_busy"
  | "not_found"
  /** run 已是终态（pg-boss 重投递到一条跑完的 run）→ 幂等空转。 */
  | "already_finished"
  | "finished";

export interface EvalRunOutcomeSummary {
  runId: string;
  kind: EvalRunOutcomeKind;
  /** 收尾态；`lease_busy`/`not_found` 时为 null。 */
  status: EvalRunStatus | null;
  doneCases: number;
}

/** 判定所需的最小分数形状——`scoreOffline` 的返回值与超时构造的全 NULL 行都满足它。 */
type MetricScores = Pick<OfflineEvaluationScores, (typeof EVAL_RUN_METRIC_KEYS)[number]>;

export interface VerdictDecision {
  verdict: EvalVerdict;
  minMetric: EvalMetricKey | null;
  minScore: number | null;
}

/**
 * 用例判定（原型 §7「用例判定 = 各指标最低档」+ 018 §11）：
 *  · 在**非 NULL** 指标里取最低值（argmin）→ `<60` low、`60-79` weak、`≥80` pass；
 *  · `correctness` 为 NULL（无 gold / 裁判挂）时不参与——它只是没测，不是「差」；
 *  · **三个基础指标全 NULL** → `unscored`：量具全挂时给不出档位，硬给一个会把
 *    「裁判坏了」伪装成「配置很差」。它不进 pass/weak/low 分母（原型未写全，018 §11 补全）。
 *
 * `minMetric`/`minScore` 恒取非 NULL 指标的 argmin（含 correctness）——它是报告默认排序键
 * （§7「按最差指标升序，坏的浮顶」），unscored 行若 correctness 有分也据实回填，全 NULL 才给 null。
 */
export function decideVerdict(scores: MetricScores): VerdictDecision {
  const scored = EVAL_RUN_METRIC_KEYS.map((metric) => ({ metric, value: scores[metric] })).filter(
    (entry): entry is { metric: EvalMetricKey; value: number } => entry.value !== null,
  );
  if (scored.length === 0) return { verdict: "unscored", minMetric: null, minScore: null };

  const worst = scored.reduce((min, entry) => (entry.value < min.value ? entry : min));
  const baseScored = EVAL_RUN_BASE_METRIC_KEYS.some((metric) => scores[metric] !== null);
  const verdict: EvalVerdict = !baseScored
    ? "unscored"
    : worst.value < EVAL_RUN_LOW_THRESHOLD
      ? "low"
      : worst.value < EVAL_RUN_PASS_THRESHOLD
        ? "weak"
        : "pass";
  return { verdict, minMetric: worst.metric, minScore: worst.value };
}

/**
 * 离线 run 执行器（018 决策 A/B）。
 *
 * **绝不发 `rag.eval` span、绝不写 ClickHouse**——MV 只按 `SpanName='rag.eval'` 过滤、
 * 不看 preview，发了就污染屏1 的在线三指标（018 决策 B）。分数只落 Postgres。
 * 每条用例的 preview trace 照常进 ClickHouse（`rag.pipeline`，由编排负责），结果行只存其 traceId。
 */
@Injectable()
export class EvalRunWorkerProcessor implements OnModuleInit {
  private readonly logger = new Logger(EvalRunWorkerProcessor.name);

  constructor(
    @Inject(EVAL_RUN_QUEUE) private readonly queue: Queue,
    private readonly repo: EvalRunsRepository,
    private readonly orchestration: OrchestrationService,
    private readonly judge: EvaluationJudgeService,
    private readonly applications: ApplicationsService,
  ) {}

  /**
   * 只 `subscribe` 不 `schedule`：run 是**事件驱动**的一次性任务，不是 E-W1 那种每 15 分钟
   * 的抽样周期。异常一路冒泡交给 pg-boss（`retryLimit: 3`，原型 §18.A）。
   */
  async onModuleInit(): Promise<void> {
    await this.queue.subscribe(EVAL_RUN_JOB, async (data) => {
      const payload = JobPayloadSchema.parse(data);
      await this.processRun(payload.runId);
    });
  }

  async processRun(runId: string, now = new Date()): Promise<EvalRunOutcomeSummary> {
    const owner = randomUUID();
    if (!(await this.repo.tryAcquireLease(runId, owner, now, EVAL_RUN_LEASE_MS))) {
      // 抢不到 = 别的 worker 在跑同一条 → 重新入队延后重试，run 保持 queued（不改状态、不报错）。
      await this.queue.publish(
        EVAL_RUN_JOB,
        { runId },
        { retryLimit: EVAL_RUN_JOB_RETRY_LIMIT },
      );
      return { runId, kind: "lease_busy", status: null, doneCases: 0 };
    }

    try {
      const run = await this.repo.findRunById(runId);
      if (!run) return { runId, kind: "not_found", status: null, doneCases: 0 };
      if (run.status !== "queued" && run.status !== "running") {
        return {
          runId,
          kind: "already_finished",
          status: run.status as EvalRunStatus,
          doneCases: run.doneCases,
        };
      }

      let cfg;
      try {
        cfg = await this.applications.resolveForTest(
          run.applicationId,
          run.configVersionId,
          EVAL_RUN_WORKER,
        );
      } catch {
        // 原型 §18.A：「queued/running + 配置版本被停用 → failed，横幅『配置版本不可用』」。
        await this.repo.finishRun(runId, "failed", new Date(), "配置版本不可用");
        return { runId, kind: "finished", status: "failed", doneCases: run.doneCases };
      }

      // 条件更新：`tryAcquireLease` 与此处之间隔着 findRunById + resolveForTest 两次 DB
      // 往返，这个窗口里回收器可能已把该 run 判死并清空租约（`create()` 的回收器跑在
      // `findActiveRun` 守卫之前，任一 POST /eval/runs 都会触发它）。无条件写会把一条
      // failed run 复活成 `running` + NULL 租约 —— 两条回收臂都够不着的永久死锁。
      // 返回 false = 我已不是所有者 → 立刻让位，与下方续租失败同一处置。
      if (!(await this.repo.markRunning(runId, owner, now))) {
        this.logger.warn(`run ${runId} 租约已失去（markRunning 前被回收或被接管），本 worker 让位`);
        return { runId, kind: "lease_busy", status: null, doneCases: 0 };
      }

      const snapshot = run.caseVersionSnapshot as EvalRunSnapshotEntry[];
      const contents = new Map(
        (await this.repo.findCaseVersionsByIds(snapshot.map((e) => e.caseVersionId))).map((v) => [
          v.id,
          v,
        ]),
      );
      // pg-boss 重试会从头重投同一个 runId：已落结果行的用例必须跳过，否则撞
      // `eval_run_results_run_case_unique` → 每次重试都在第一条就炸，3 次重试等于白给。
      const recorded = new Set(await this.repo.listRecordedCaseVersionIds(runId));

      let status: EvalRunStatus = "done";
      for (const entry of snapshot) {
        if (recorded.has(entry.caseVersionId)) continue;

        // 逐条回读 run 行：停止信号与 token 用量都是**别处**在改（service 置停止、
        // recordResult 累加用量），本地缓存必然读到旧值。一条用例耗时以秒计，这一次
        // SELECT 的代价可忽略。
        // 续租（心跳）：租约 5 分钟，而 run 轻易跑更久 —— 不逐条续期的话，健康的长 run
        // 会把自己的租约跑过期，进而被 reapAbandonedRuns 误杀成 failed，也可能被另一个
        // worker 抢去并发跑。续租失败 = 租约已被别人接管（我方已被回收器判死）→ 立刻让位，
        // 不再写任何结果，避免两个 worker 同时往一条 run 里写。
        if (!(await this.repo.renewLease(runId, owner, new Date(), EVAL_RUN_LEASE_MS))) {
          this.logger.warn(`run ${runId} 租约已失去（被回收或被接管），本 worker 让位`);
          return { runId, kind: "lease_busy", status: null, doneCases: 0 };
        }

        const current = await this.repo.findRunById(runId);
        if (!current) return { runId, kind: "not_found", status: null, doneCases: 0 };
        if (current.stopRequestedAt) {
          // 018 §11：0 条完成时点停止也收 partial + done_cases=0（不新造状态）。
          status = "partial";
          break;
        }
        if (current.tokensUsed >= current.tokenBudget) {
          status = "budget_stop";
          break;
        }

        const content = contents.get(entry.caseVersionId);
        if (!content) continue; // 版本行不可变且永不删；真缺了就跳过，留给 skipped 推导。
        // 裁判模型取**发起时快照在 run 行上**的值，不读全局在线设置：离线 run 的裁判是发起
        // 参数（原型 §6 的「裁判模型」下拉），改了在线设置不该改变已发起 run 的判分口径。
        await this.runCase(runId, cfg, entry, content, {
          judgeModelId: run.judgeModelId,
          embeddingModelId: run.embeddingModelId,
        });
      }

      await this.repo.finishRun(runId, status, new Date(), null);
      const finished = await this.repo.findRunById(runId);
      return { runId, kind: "finished", status, doneCases: finished?.doneCases ?? 0 };
    } finally {
      await this.repo.releaseLease(runId, owner);
    }
  }

  private async runCase(
    runId: string,
    cfg: Awaited<ReturnType<ApplicationsService["resolveForTest"]>>,
    entry: EvalRunSnapshotEntry,
    content: { question: string; goldPoints: string[] },
    modelIds: EvaluationModelIds,
  ): Promise<void> {
    const startedAt = Date.now();
    // 与线上**同一段编排代码**（persist=false + rag.eval.run_id 标在 rag.pipeline 根 span 上）。
    // 绝不在此复制一份编排逻辑（Global Constraints）。超时不抛，返回 timedOut=true。
    const outcome = await this.orchestration.runForEvaluation(cfg, content.question, {
      runId,
      timeoutMs: EVAL_RUN_CASE_TIMEOUT_MS,
    });
    const orchestrationTokens = outcome.usage.inputTokens + outcome.usage.outputTokens;

    if (outcome.timedOut) {
      // 018 已知取舍 2：超时**记 NULL + verdict=timeout**，不记 0 分（原型 §6 说记 0——
      // 本波唯一一处主动偏离产品权威：同一列里混「0=真的很差」与「未测出」会让记分卡 avg
      // 不可解释。超时信息不丢：verdict 列显性表达，覆盖率 scoredCount/total 显性表达占比）。
      await this.repo.recordResult({
        runId,
        caseVersionId: entry.caseVersionId,
        seq: entry.seq,
        verdict: "timeout" satisfies EvalVerdict,
        faithfulness: null,
        answerRelevancy: null,
        contextPrecision: null,
        correctness: null,
        minMetric: null,
        minScore: null,
        evidence: {},
        previewTraceId: outcome.traceId || null,
        answer: outcome.replyText,
        tokensUsed: orchestrationTokens,
        durationMs: Date.now() - startedAt,
        error: `编排超时（判定阈值 ${EVAL_RUN_CASE_TIMEOUT_MS}ms）`,
      });
      return;
    }

    // 真实 chunkId/text/finalScore 直接来自编排的 TaggedHit —— 绝不合成 c1/c2
    // （Global Constraints；假 chunkId 会让 Context Precision 评的是不存在的上下文）。
    const scores = await this.judge.scoreOffline(
      {
        targetTraceId: outcome.traceId,
        question: content.question,
        answer: outcome.replyText,
        contexts: outcome.hits.slice(0, EVAL_RUN_MAX_CONTEXTS),
      },
      modelIds,
      content.goldPoints,
    );
    const decision = decideVerdict(scores);

    await this.repo.recordResult({
      runId,
      caseVersionId: entry.caseVersionId,
      seq: entry.seq,
      verdict: decision.verdict,
      faithfulness: scores.faithfulness,
      answerRelevancy: scores.answerRelevancy,
      contextPrecision: scores.contextPrecision,
      correctness: scores.correctness,
      minMetric: decision.minMetric,
      minScore: decision.minScore,
      evidence: scores.evidence,
      previewTraceId: outcome.traceId || null,
      answer: outcome.replyText,
      // 决策 G：编排 + 裁判的**已上报** usage 之和；provider 不回传时计 0（熔断偏松，不假装精确）。
      tokensUsed: orchestrationTokens + scores.usage.inputTokens + scores.usage.outputTokens,
      durationMs: Date.now() - startedAt,
      error: null,
    });
  }
}
