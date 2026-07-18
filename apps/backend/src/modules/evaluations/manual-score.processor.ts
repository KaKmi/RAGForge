import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { MANUAL_SCORE_JOB, MANUAL_SCORE_QUEUE } from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { ClickHouseEvaluationsRepository } from "./clickhouse-evaluations.repository";
import { EvaluationInputService } from "./evaluation-input.service";
import { EvaluationJudgeService } from "./evaluation-judge.service";
import { EvaluationSpanEmitter } from "./evaluation-span.emitter";
import { normalizeEvaluationError } from "./evaluation-worker.errors";
import { isFaithfulnessEligible } from "./sampling";
import { EvaluationsRepository } from "./evaluations.repository";

/**
 * B1/F3：人工「立即评测」的消费者（原型 §18.D 状态机的 `scoring` 阶段）。
 *
 * **调用序列刻意与 evaluation-worker.processor.ts:186-228 保持一致**——
 * assemble → judge.score → emitSuccess/emitFailure。判分逻辑一行都不复制：
 * 两条路径评的必须是同一个东西，否则「人工评分」与「worker 评分」会悄悄分叉。
 *
 * ⚠️ **绝不**调用 finishCycle / appendLedger / 任何写 eval_watermarks 或
 * eval_candidate_ledger 的方法。人工触发不推进游标：
 *  · 写账本会与 worker 未来那行主键冲突，并把人工点击伪装成一次游标扫描；
 *  · 吃 dailyCap 会让一次排查把当天的自动抽样饿死。
 * 该 trace 照常会被周期 worker 扫到，届时走既有的 already_scored 分支——
 * 那个分支本就是为「这条已经评过了」准备的，无需任何新机制。
 *
 * 队列 token 是 MANUAL_SCORE_QUEUE（api 角色），**不是** EVALUATION_QUEUE（worker 角色）：
 * 后者在只起 api 的部署里会静默 no-op，任务永不被消费。
 */
@Injectable()
export class ManualScoreProcessor implements OnModuleInit {
  private readonly logger = new Logger(ManualScoreProcessor.name);

  constructor(
    @Inject(MANUAL_SCORE_QUEUE) private readonly queue: Queue,
    private readonly repo: EvaluationsRepository,
    private readonly clickhouse: ClickHouseEvaluationsRepository,
    private readonly input: EvaluationInputService,
    private readonly judge: EvaluationJudgeService,
    private readonly emitter: EvaluationSpanEmitter,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.subscribe(MANUAL_SCORE_JOB, async (data) => {
      const { targetTraceId, judgeVersion } = data as {
        targetTraceId: string;
        judgeVersion: string;
      };
      await this.process(targetTraceId, judgeVersion);
    });
  }

  async process(targetTraceId: string, judgeVersion: string): Promise<void> {
    const settings = await this.repo.getSettings();
    if (!settings.judgeModelId || !settings.embeddingModelId) {
      await this.fail(targetTraceId, judgeVersion, "裁判或向量模型未配置");
      return;
    }
    await this.repo.markManualJob(targetTraceId, judgeVersion, {
      status: "running",
      bumpAttempt: true,
    });

    const candidate = await this.clickhouse.findCandidateByTraceId(targetTraceId);
    if (!candidate) {
      await this.fail(targetTraceId, judgeVersion, "trace 不存在或不可评");
      return;
    }
    const assembled = await this.input.assemble(candidate);
    if (assembled.status === "incomplete") {
      await this.fail(targetTraceId, judgeVersion, "trace 数据不完整，无法评分");
      return;
    }

    try {
      const result = await this.judge.score(
        assembled.input,
        { judgeModelId: settings.judgeModelId, embeddingModelId: settings.embeddingModelId },
        { skipFaithfulness: !isFaithfulnessEligible(candidate) },
      );
      await this.emitter.emitSuccess({
        candidate,
        input: assembled.input,
        settings: { judgeModelId: settings.judgeModelId, judgeVersion, trigger: "manual" },
        result,
      });
      await this.repo.markManualJob(targetTraceId, judgeVersion, { status: "scored" });
      this.logger.log(`manual score ${targetTraceId} → scored`);
    } catch (error) {
      const normalized = normalizeEvaluationError(error);
      // 失败也发 span：与 worker 同构，getTraceQuality 才能读到 failed 三态。
      await this.emitter.emitFailure({
        input: assembled.input,
        settings: { judgeModelId: settings.judgeModelId, judgeVersion, trigger: "manual" },
        error,
      });
      await this.fail(targetTraceId, judgeVersion, normalized.message);
    }
  }

  private async fail(traceId: string, judgeVersion: string, message: string): Promise<void> {
    this.logger.warn(`manual score ${traceId} → failed：${message}`);
    await this.repo.markManualJob(traceId, judgeVersion, {
      status: "failed",
      lastError: message.slice(0, 200),
    });
  }
}
