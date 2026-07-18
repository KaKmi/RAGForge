import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  EvalModelOption,
  OnlineEvalSettings,
  OnlineEvalSettingsResponse,
  QualityEvidence,
  QualityMetric,
  QualityOverviewQuery,
  QualityOverviewResponse,
  QualityScores,
  QualityThresholds,
  ManualScoreResponse,
  TraceQualityDetail,
  UpdateOnlineEvalSettingsRequest,
} from "@codecrush/contracts";
import {
  MANUAL_SCORE_JOB,
  MANUAL_SCORE_QUEUE,
  ONLINE_EVALUATION_WORKER,
} from "../../platform/queue/queue.constants";
import type { Queue } from "../../platform/queue/queue.port";
import { ModelsService } from "../models/models.service";
import {
  ClickHouseEvaluationsRepository,
  type EvaluationAggregate,
  type EvaluationReadWindow,
} from "./clickhouse-evaluations.repository";
import { EvaluationsRepository } from "./evaluations.repository";
import type { OnlineEvalSettingsRow } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;
const LAG_BUFFER_MS = 5 * 60 * 1000;
const LOW_SAMPLE_COUNT = 20;
// worker 的 cron 是 */15，每轮 tryAcquireLease 都会盖 lastRunAt。放两轮 + 5min 余量：
// 超过它没动过 = worker 没在跑（019 拆进程后这是屏1 唯一能拿到的活性证据——worker 无 HTTP、
// 无健康探针、compose 里也没有它的服务，「只起了 api」是安静的常态）。
const WORKER_STALE_MS = 35 * 60 * 1000;

@Injectable()
export class EvaluationsService {
  constructor(
    private readonly controlRepo: EvaluationsRepository,
    private readonly clickhouseRepo: ClickHouseEvaluationsRepository,
    private readonly models: ModelsService,
    @Inject(MANUAL_SCORE_QUEUE) private readonly manualQueue: Queue,
  ) {}

  /**
   * B1/F3 限频：同一 traceId 60s 内只受理一次。
   *
   * 单副本前提与 replay.service.ts:16 一致（019 Boundary 5）——多副本下各自计数，
   * 一致处理，不新增债。用它而**不是** dailyCap：dailyCap 是 worker 自动抽样的预算，
   * 人工点击若吃这个额度，一次排查就能把当天的自动抽样饿死；且 dailyCount 由
   * finishCycle 在租约内写，端点侧并发写会破坏租约不变量。
   */
  private static readonly MANUAL_SCORE_RATE_LIMIT_MS = 60_000;
  private readonly lastManualScoreAt = new Map<string, number>();

  async getOverview(
    query: QualityOverviewQuery,
    now = new Date(),
  ): Promise<QualityOverviewResponse> {
    const settings = await this.controlRepo.getSettings();
    const to = query.to ? new Date(query.to) : now;
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 7 * DAY_MS);
    const duration = to.getTime() - from.getTime();
    const current: EvaluationReadWindow = {
      from,
      to,
      judgeVersion: settings.judgeVersion,
      agentId: query.agentId,
    };
    const previous: EvaluationReadWindow = {
      ...current,
      from: new Date(from.getTime() - duration),
      to: from,
    };
    // 只读——绝不 getOrCreate：那会把游标播种在 now-24h，让一次页面刷新永久吞掉更早的历史。
    const watermark = await this.controlRepo.findWatermark(ONLINE_EVALUATION_WORKER);
    const backlogTo = new Date(now.getTime() - LAG_BUFFER_MS);
    // 水位线行还不存在 = worker 一轮都没跑过 ⇒ 游标不存在，此刻还没有任何 trace 被越过。
    const cursor = watermark
      ? { lastTs: watermark.lastTs, lastTraceId: watermark.lastTraceId }
      : null;
    const [
      aggregate,
      previousAggregate,
      trend,
      byAgent,
      lowSamples,
      eligibleCount,
      evaluableCount,
      backlog,
      ledger,
      scoredInWindow,
    ] = await Promise.all([
      this.clickhouseRepo.getOverview(current),
      this.clickhouseRepo.getOverview(previous),
      this.clickhouseRepo.getMinuteAggregates(current),
      this.clickhouseRepo.getByAgent(current),
      this.clickhouseRepo.getLowSamples(current, thresholds(settings)),
      this.clickhouseRepo.countEligible(from, to, query.agentId),
      cursor
        ? this.clickhouseRepo.countEvaluable(from, to, cursor, query.agentId)
        : this.clickhouseRepo.countEligible(from, to, query.agentId),
      cursor && cursor.lastTs < backlogTo
        ? this.clickhouseRepo.countBacklog(cursor, backlogTo)
        : Promise.resolve(0),
      this.controlRepo.countLedgerByOutcome(settings.judgeVersion, from, to, query.agentId),
      this.clickhouseRepo.countScoredInWindow(from, to, settings.judgeVersion, query.agentId),
    ]);
    const judge = await this.resolveSelectedModel(settings.judgeModelId, "llm");
    const embedding = await this.resolveSelectedModel(settings.embeddingModelId, "embedding");
    const status = !settings.enabled
      ? "disabled"
      : !judge || !embedding
        ? "model_unavailable"
        : workerStalled(watermark?.lastRunAt, now)
          ? "worker_stalled"
          : (watermark?.dailyCount ?? 0) >= Math.floor(settings.dailyCap * 0.8)
            ? "budget_reduced"
            : backlog > 0
              ? "lagging"
              : "healthy";

    return {
      meta: {
        enabled: settings.enabled,
        sampleRate: settings.sampleRate,
        evaluatedCount: aggregate.sampleCount,
        eligibleCount,
        evaluableCount,
        missed: missedBreakdown(eligibleCount, evaluableCount, ledger),
        // 账本说评过（含之前评过的）、CH 里却查不到 ⇒ span 丢了。恒 0 才正常。
        scoresNotPersisted: Math.max(
          0,
          (ledger.success ?? 0) + (ledger.already_scored ?? 0) - scoredInWindow,
        ),
        judgeModel: judge?.name ?? null,
        judgeVersion: settings.judgeVersion,
        status,
        backlog,
      },
      metrics: {
        faithfulness: metricValue(
          "faithfulness",
          aggregate,
          previousAggregate,
          settings.faithfulnessThreshold,
          aggregate.faithfulnessSampleCount,
          previousAggregate.faithfulnessSampleCount,
        ),
        answerRelevancy: metricValue(
          "answerRelevancy",
          aggregate,
          previousAggregate,
          settings.answerRelevancyThreshold,
          aggregate.sampleCount,
          previousAggregate.sampleCount,
        ),
        contextPrecision: metricValue(
          "contextPrecision",
          aggregate,
          previousAggregate,
          settings.contextPrecisionThreshold,
          aggregate.sampleCount,
          previousAggregate.sampleCount,
        ),
      },
      trend: trend.map((point) => ({
        bucket: point.bucket,
        faithfulness: normalizeScore(point.faithfulness),
        answerRelevancy: normalizeScore(point.answerRelevancy),
        contextPrecision: normalizeScore(point.contextPrecision),
        faithfulnessSampleCount: point.faithfulnessSampleCount,
        sampleCount: point.sampleCount,
        insufficientSample: point.sampleCount < LOW_SAMPLE_COUNT,
      })),
      byAgent: byAgent.map((item) => ({
        agentId: item.agentId,
        agentName: item.agentName,
        scores: aggregateScores(item),
        sampleCount: item.sampleCount,
      })),
      lowSamples: lowSamples
        .filter(
          (item) =>
            (item.faithfulness !== null && item.faithfulness < settings.faithfulnessThreshold) ||
            item.answerRelevancy < settings.answerRelevancyThreshold ||
            item.contextPrecision < settings.contextPrecisionThreshold,
        )
        .map((item) => {
          const scores = {
            faithfulness: normalizeScore(item.faithfulness),
            answerRelevancy: normalizeScore(item.answerRelevancy),
            contextPrecision: normalizeScore(item.contextPrecision),
          };
          const minMetric = minimumMetric(scores);
          const minScore = scores[minMetric];
          if (typeof minScore !== "number") {
            throw new RangeError("evaluation score out of range: expected 0..100");
          }
          return {
            targetTraceId: item.targetTraceId,
            question: item.question,
            minMetric,
            minScore,
            evidenceSummary: evidenceSummary(item.evidence),
          };
        }),
    };
  }

  async getTraceQuality(targetTraceId: string): Promise<TraceQualityDetail> {
    const settings = await this.controlRepo.getSettings();
    const success = await this.clickhouseRepo.getLatestSuccess(targetTraceId);
    if (success) {
      return {
        status: "scored",
        scores: requiredScores(success),
        thresholds: thresholds(settings),
        judgeModel: success.judgeModel || "unknown",
        judgeVersion: success.judgeVersion,
        scoredAt: success.evaluatedAt,
        currentVersion: success.judgeVersion === settings.judgeVersion,
        evidence: parseEvidence(success.evidence),
      };
    }
    const failure = await this.clickhouseRepo.getLatestFailure(targetTraceId);
    if (failure) {
      return {
        status: "failed",
        judgeVersion: failure.judgeVersion,
        failedAt: failure.failedAt,
        reason: failure.reason,
        currentVersion: failure.judgeVersion === settings.judgeVersion,
      };
    }
    // B1/F3：ClickHouse 三态都没命中时，才看有没有在跑的人工作业。
    // 顺序不可颠倒——已有分数必须立即可见，不能被一条陈旧的 job 行盖住。
    const job = await this.controlRepo.findManualJob(targetTraceId, settings.judgeVersion);
    if (job && (job.status === "queued" || job.status === "running")) {
      // startedAt 取作业创建时间：表里没有独立的 started_at 列，
      // created_at 就是「用户点下立即评测」的时刻，正是面板要显示的起点。
      return { status: "scoring", startedAt: job.createdAt.toISOString() };
    }
    return { status: "unscored" };
  }

  /**
   * B1/F3：手动触发单条评测（原型 §12.3 `POST /eval/quality/traces/:traceId/score`）。
   *
   * 步骤顺序**不可调换**：先校验可用性与限频，再查「是否已评」，最后才入队。
   * 把 findExisting 放在限频之后是有意的——已评过的 trace 直接返回 scored，
   * 不入队、不调裁判、不计费。
   */
  async requestManualScore(targetTraceId: string, actor: string): Promise<ManualScoreResponse> {
    const settings = await this.controlRepo.getSettings();
    if (!settings.enabled) {
      throw new UnprocessableEntityException("在线评测未启用");
    }
    await this.requireModel(settings.judgeModelId, "llm", "judgeModelId");
    await this.requireModel(settings.embeddingModelId, "embedding", "embeddingModelId");

    const now = Date.now();
    const last = this.lastManualScoreAt.get(targetTraceId);
    if (last !== undefined && now - last < EvaluationsService.MANUAL_SCORE_RATE_LIMIT_MS) {
      throw new HttpException("操作过于频繁，请 1 分钟后再试", 429);
    }

    // 已评过 → 直接返回，绝不重复计费（worker 侧的 already_scored 是同一道守卫）。
    if (await this.clickhouseRepo.findExisting(targetTraceId, settings.judgeVersion)) {
      return { status: "scored" };
    }

    // 置位限频只在真正受理之后——上面的早退路径不该占用配额。
    this.lastManualScoreAt.set(targetTraceId, now);
    await this.controlRepo.upsertManualJob(targetTraceId, settings.judgeVersion, actor);
    await this.manualQueue.publish(
      MANUAL_SCORE_JOB,
      { targetTraceId, judgeVersion: settings.judgeVersion },
      { singletonKey: `${targetTraceId}:${settings.judgeVersion}` },
    );
    return { status: "scoring" };
  }

  async getSettings(): Promise<OnlineEvalSettingsResponse> {
    const settings = await this.controlRepo.getSettings();
    const all = await this.models.list();
    return {
      settings: toSettings(settings),
      models: {
        judges: retainSelection(
          all.filter((model) => model.type === "llm").map(toOption),
          settings.judgeModelId,
        ),
        embeddings: retainSelection(
          all.filter((model) => model.type === "embedding").map(toOption),
          settings.embeddingModelId,
        ),
      },
    };
  }

  async updateSettings(
    update: UpdateOnlineEvalSettingsRequest,
  ): Promise<OnlineEvalSettingsResponse> {
    const current = await this.controlRepo.getSettings();
    const merged = { ...current, ...update };
    if (merged.enabled) {
      await this.requireModel(merged.judgeModelId, "llm", "judgeModelId");
      await this.requireModel(merged.embeddingModelId, "embedding", "embeddingModelId");
    }
    await this.controlRepo.updateSettings(update);
    return this.getSettings();
  }

  private async requireModel(
    id: string | null,
    type: "llm" | "embedding",
    field: "judgeModelId" | "embeddingModelId",
  ): Promise<void> {
    if (!id) throw new BadRequestException(`${field} must reference an enabled ${type} model`);
    try {
      const model = await this.models.get(id);
      if (model.type !== type || !model.enabled) throw new Error("unavailable");
    } catch {
      throw new BadRequestException(`${field} must reference an enabled ${type} model`);
    }
  }

  private async resolveSelectedModel(id: string | null, type: "llm" | "embedding") {
    if (!id) return undefined;
    try {
      const model = await this.models.get(id);
      return model.type === type && model.enabled ? model : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * 「已错过」= 游标已越过、却没有分数的。`total` 只能靠**算术**（窗口内 − 已评 − 仍可评），
 * 因为最大的一类——**从没进过候选集的**——在账本里根本没有行：冷启动播种把游标钉在
 * `now-N 小时`，更早的 trace 一眼都没被看过。
 *
 * 故 `neverSeen = total − 账本里的四类`，而不是反过来。把「已错过」直接换成查账本会让它
 * 显示 0 而不是真实的数（018 §12 缺口 20 的那 31 条正是 neverSeen，账本一行都没有）。
 */
function missedBreakdown(
  eligibleCount: number,
  evaluableCount: number,
  ledger: Record<string, number>,
) {
  const evaluatedOrPending = evaluableCount + (ledger.success ?? 0) + (ledger.already_scored ?? 0);
  const total = Math.max(0, eligibleCount - evaluatedOrPending);
  const sampledOut = ledger.sampled_out ?? 0;
  const quotaSkipped = ledger.quota_skipped_normal ?? 0;
  const incomplete = ledger.incomplete ?? 0;
  const judgeFailed = ledger.processed_failed ?? 0;
  return {
    total,
    sampledOut,
    quotaSkipped,
    incomplete,
    judgeFailed,
    neverSeen: Math.max(0, total - sampledOut - quotaSkipped - incomplete - judgeFailed),
  };
}

/**
 * 「worker 没在跑」与「worker 在跑但落后」是两件事，此前在屏1 上同形（都显示评测滞后）。
 * lastRunAt 由 tryAcquireLease 每轮盖一次——它断言的是「worker 醒过来了」，
 * 与 backlog（有没有活儿）正交：没流量时 backlog=0 但 worker 照样该每 15 分钟报到一次。
 * 空值 = 一轮都没跑过（水位线行可能刚被 worker 建出来还没跑完第一轮）。
 */
function workerStalled(lastRunAt: Date | null | undefined, now: Date): boolean {
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt.getTime() > WORKER_STALE_MS;
}

function normalizeScore(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) {
    throw new RangeError("evaluation score out of range: expected 0..100");
  }
  return Math.round(value);
}

function requiredScores(values: {
  faithfulness: number | null;
  answerRelevancy: number;
  contextPrecision: number;
}): QualityScores {
  const faithfulness = normalizeScore(values.faithfulness);
  const answerRelevancy = normalizeScore(values.answerRelevancy);
  const contextPrecision = normalizeScore(values.contextPrecision);
  if (answerRelevancy === null || contextPrecision === null) {
    throw new RangeError("evaluation score out of range: expected 0..100");
  }
  return { faithfulness, answerRelevancy, contextPrecision };
}

function metricValue(
  metric: keyof Pick<EvaluationAggregate, "faithfulness" | "answerRelevancy" | "contextPrecision">,
  current: EvaluationAggregate,
  previous: EvaluationAggregate,
  threshold: number,
  currentCount: number,
  previousCount: number,
) {
  const value = normalizeScore(current[metric]);
  const previousValue = normalizeScore(previous[metric]);
  return {
    value,
    previousDelta:
      currentCount < LOW_SAMPLE_COUNT ||
      previousCount < LOW_SAMPLE_COUNT ||
      value === null ||
      previousValue === null
        ? null
        : value - previousValue,
    sampleCount: currentCount,
    threshold,
    low: value !== null && value < threshold,
  };
}

function aggregateScores(aggregate: EvaluationAggregate): QualityScores | null {
  if (aggregate.sampleCount === 0) return null;
  const faithfulness = normalizeScore(aggregate.faithfulness);
  const answerRelevancy = normalizeScore(aggregate.answerRelevancy);
  const contextPrecision = normalizeScore(aggregate.contextPrecision);
  return answerRelevancy === null || contextPrecision === null
    ? null
    : { faithfulness, answerRelevancy, contextPrecision };
}

function thresholds(settings: OnlineEvalSettingsRow): QualityThresholds {
  return {
    faithfulness: settings.faithfulnessThreshold,
    answerRelevancy: settings.answerRelevancyThreshold,
    contextPrecision: settings.contextPrecisionThreshold,
  };
}

function minimumMetric(scores: Record<QualityMetric, number | null>): QualityMetric {
  return (Object.entries(scores) as Array<[QualityMetric, number | null]>)
    .filter((entry): entry is [QualityMetric, number] => typeof entry[1] === "number")
    .reduce((lowest, current) => (current[1] < lowest[1] ? current : lowest))[0];
}

function parseEvidence(raw: string): QualityEvidence {
  try {
    const value = JSON.parse(raw) as Partial<Record<QualityMetric, unknown>>;
    const faithfulness = evidenceItems(value.faithfulness);
    return {
      ...(faithfulness.length > 0 ? { faithfulness } : {}),
      answerRelevancy: evidenceList(value.answerRelevancy),
      contextPrecision: evidenceList(value.contextPrecision),
    };
  } catch {
    return emptyEvidence();
  }
}

function evidenceList(value: unknown): string[] {
  const items = evidenceItems(value);
  return items.length ? items : ["No evidence returned"];
}

function evidenceItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map((item) => item.slice(0, 300))
    .slice(0, 5);
}

function emptyEvidence(): QualityEvidence {
  return {
    answerRelevancy: ["No evidence returned"],
    contextPrecision: ["No evidence returned"],
  };
}

function evidenceSummary(raw: string): string {
  const evidence = parseEvidence(raw);
  return [
    ...(evidence.faithfulness ?? []),
    ...evidence.answerRelevancy,
    ...evidence.contextPrecision,
  ][0].slice(0, 300);
}

function toSettings(row: OnlineEvalSettingsRow): OnlineEvalSettings {
  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

function toOption(model: { id: string; name: string; enabled: boolean }): EvalModelOption {
  return { id: model.id, name: model.name, enabled: model.enabled, available: model.enabled };
}

function retainSelection(options: EvalModelOption[], selected: string | null): EvalModelOption[] {
  if (!selected || options.some((option) => option.id === selected)) return options;
  return [{ id: selected, name: selected, enabled: false, available: false }, ...options];
}
