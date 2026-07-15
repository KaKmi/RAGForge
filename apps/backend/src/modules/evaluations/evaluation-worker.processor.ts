import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  EVALUATION_QUEUE,
  ONLINE_EVALUATION_JOB,
  ONLINE_EVALUATION_WORKER,
} from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { ModelsService } from "../models/models.service";
import {
  ClickHouseEvaluationsRepository,
  type EvaluationCandidate,
} from "./clickhouse-evaluations.repository";
import {
  EVALUATION_CANDIDATE_LIMIT,
  EVALUATION_FAILURE_CIRCUIT_LIMIT,
  EVALUATION_LAG_BUFFER_MS,
  EVALUATION_LEASE_MS,
} from "./evaluation.constants";
import { EvaluationInputService } from "./evaluation-input.service";
import { EvaluationJudgeService } from "./evaluation-judge.service";
import { EvaluationSpanEmitter } from "./evaluation-span.emitter";
import { normalizeEvaluationError } from "./evaluation-worker.errors";
import { EvaluationsRepository } from "./evaluations.repository";
import { classifyRisk, effectiveNormalRate, stableSample } from "./sampling";

const WorkerPayloadSchema = z.strictObject({ workerName: z.string().min(1).max(100) });

export type CandidateOutcomeKind =
  | "success"
  | "already_scored"
  | "sampled_out"
  | "quota_skipped_normal"
  | "incomplete"
  | "processed_failed"
  | "cap_deferred"
  | "circuit_deferred";

export interface CandidateOutcome {
  traceId: string;
  startTime: Date;
  kind: CandidateOutcomeKind;
  advancesCursor: boolean;
}

export interface CycleResult {
  status: "disabled" | "lease_busy" | "model_unavailable" | "healthy" | "budget_reduced";
  outcomes: CandidateOutcome[];
  cursor?: { lastTs: Date; lastTraceId: string };
  evaluatedCount: number;
  skippedCount: number;
  failedCount: number;
}

function outcome(
  candidate: EvaluationCandidate,
  kind: CandidateOutcomeKind,
  advancesCursor = true,
): CandidateOutcome {
  return { traceId: candidate.traceId, startTime: candidate.startTime, kind, advancesCursor };
}

@Injectable()
export class EvaluationWorkerProcessor implements OnModuleInit {
  constructor(
    @Inject(EVALUATION_QUEUE) private readonly queue: Queue,
    private readonly repo: EvaluationsRepository,
    private readonly clickhouse: ClickHouseEvaluationsRepository,
    private readonly input: EvaluationInputService,
    private readonly judge: EvaluationJudgeService,
    private readonly emitter: EvaluationSpanEmitter,
    private readonly models: ModelsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.subscribe(ONLINE_EVALUATION_JOB, async (data) => {
      const payload = WorkerPayloadSchema.parse(data);
      try {
        await this.processCycle(payload.workerName);
      } catch (error) {
        const normalized = normalizeEvaluationError(error);
        await this.repo.recordFailure(
          payload.workerName,
          normalized.errorClass,
          normalized.message,
        );
        throw error;
      }
    });
    await this.queue.schedule(
      ONLINE_EVALUATION_JOB,
      "*/15 * * * *",
      { workerName: ONLINE_EVALUATION_WORKER },
      { tz: "UTC", key: ONLINE_EVALUATION_WORKER, retryLimit: 1 },
    );
  }

  async processCycle(workerName: string, now = new Date()): Promise<CycleResult> {
    const settings = await this.repo.getSettings();
    if (!settings.enabled || settings.sampleRate === 0) return this.emptyResult("disabled");
    if (
      !(await this.modelsAvailable(workerName, settings.judgeModelId, settings.embeddingModelId))
    ) {
      return this.emptyResult("model_unavailable");
    }

    const owner = randomUUID();
    if (!(await this.repo.tryAcquireLease(workerName, owner, now, EVALUATION_LEASE_MS))) {
      return this.emptyResult("lease_busy");
    }

    try {
      const watermark = await this.repo.getOrCreateWatermark(workerName, now);
      const candidates = await this.clickhouse.listCandidates(
        watermark,
        new Date(now.getTime() - EVALUATION_LAG_BUFFER_MS),
        EVALUATION_CANDIDATE_LIMIT,
      );
      const outcomes: CandidateOutcome[] = [];
      const riskSuffix = this.riskSuffix(candidates);
      let dailyCount = watermark.dailyCount;
      let consecutiveJudgeFailures = 0;
      let lastError: string | null = null;

      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (consecutiveJudgeFailures >= EVALUATION_FAILURE_CIRCUIT_LIMIT) {
          outcomes.push(outcome(candidate, "circuit_deferred", false));
          continue;
        }
        const risk = classifyRisk(candidate);
        const remainingCapacity = Math.max(0, settings.dailyCap - dailyCount);
        if (risk && remainingCapacity === 0) {
          outcomes.push(outcome(candidate, "cap_deferred", false));
          continue;
        }
        if (!risk) {
          const rate = effectiveNormalRate(settings.sampleRate, dailyCount, settings.dailyCap);
          if (!stableSample(candidate.traceId, settings.judgeVersion, rate)) {
            outcomes.push(outcome(candidate, "sampled_out"));
            continue;
          }
          if (remainingCapacity <= riskSuffix[index]) {
            outcomes.push(outcome(candidate, "quota_skipped_normal"));
            continue;
          }
        }

        if (await this.clickhouse.findExisting(candidate.traceId, settings.judgeVersion)) {
          outcomes.push(outcome(candidate, "already_scored"));
          continue;
        }
        const assembled = await this.input.assemble(candidate);
        if (assembled.status === "incomplete") {
          outcomes.push(outcome(candidate, "incomplete"));
          continue;
        }
        try {
          const result = await this.judge.score(assembled.input, {
            judgeModelId: settings.judgeModelId!,
            embeddingModelId: settings.embeddingModelId!,
          });
          await this.emitter.emitSuccess({
            candidate,
            input: assembled.input,
            settings: {
              judgeModelId: settings.judgeModelId!,
              judgeVersion: settings.judgeVersion,
            },
            result,
          });
          dailyCount += 1;
          consecutiveJudgeFailures = 0;
          lastError = null;
          outcomes.push(outcome(candidate, "success"));
        } catch (error) {
          const normalized = normalizeEvaluationError(error);
          await this.emitter.emitFailure({
            input: assembled.input,
            settings: {
              judgeModelId: settings.judgeModelId!,
              judgeVersion: settings.judgeVersion,
            },
            error,
          });
          consecutiveJudgeFailures += 1;
          lastError = normalized.message;
          outcomes.push(outcome(candidate, "processed_failed"));
        }
      }

      let cursor = { lastTs: watermark.lastTs, lastTraceId: watermark.lastTraceId };
      for (const item of outcomes) {
        if (!item.advancesCursor) break;
        cursor = { lastTs: item.startTime, lastTraceId: item.traceId };
      }
      const evaluatedCount = outcomes.filter((item) => item.kind === "success").length;
      await this.repo.finishCycle(workerName, owner, {
        ...cursor,
        evaluatedIncrement: evaluatedCount,
        now,
        consecutiveFailures: consecutiveJudgeFailures,
        lastError,
      });
      const status =
        dailyCount >= Math.floor(settings.dailyCap * 0.8) ? "budget_reduced" : "healthy";
      return {
        status,
        outcomes,
        cursor,
        evaluatedCount,
        skippedCount: outcomes.filter((item) =>
          ["already_scored", "sampled_out", "quota_skipped_normal", "incomplete"].includes(
            item.kind,
          ),
        ).length,
        failedCount: outcomes.filter((item) => item.kind === "processed_failed").length,
      };
    } finally {
      await this.repo.releaseLease(workerName, owner, now);
    }
  }

  private riskSuffix(candidates: EvaluationCandidate[]): number[] {
    const result = new Array<number>(candidates.length).fill(0);
    let count = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (classifyRisk(candidates[index])) count += 1;
      result[index] = count;
    }
    return result;
  }

  private async modelsAvailable(
    workerName: string,
    judgeModelId: string | null,
    embeddingModelId: string | null,
  ): Promise<boolean> {
    try {
      if (!judgeModelId || !embeddingModelId) throw new Error("required model id is missing");
      const judge = await this.models.get(judgeModelId);
      if (judge.type !== "llm" || !judge.enabled) throw new Error(`${judgeModelId} is unavailable`);
      const embedding = await this.models.get(embeddingModelId);
      if (embedding.type !== "embedding" || !embedding.enabled) {
        throw new Error(`${embeddingModelId} is unavailable`);
      }
      return true;
    } catch (error) {
      const normalized = normalizeEvaluationError(error);
      const modelIds = [judgeModelId, embeddingModelId].filter(Boolean).join(",") || "missing";
      await this.repo.recordFailure(
        workerName,
        "ModelUnavailable",
        `${modelIds}: ${normalized.message}`.slice(0, 200),
      );
      return false;
    }
  }

  private emptyResult(status: CycleResult["status"]): CycleResult {
    return { status, outcomes: [], evaluatedCount: 0, skippedCount: 0, failedCount: 0 };
  }
}
