import { BadRequestException, Injectable } from "@nestjs/common";
import type {
  EvalModelOption,
  OnlineEvalSettings,
  OnlineEvalSettingsResponse,
  QualityEvidence,
  QualityMetric,
  QualityOverviewQuery,
  QualityOverviewResponse,
  QualityScores,
  TraceQualityDetail,
  UpdateOnlineEvalSettingsRequest,
} from "@codecrush/contracts";
import { ONLINE_EVALUATION_WORKER } from "../../platform/queue/queue.constants";
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
  ) {}

  async getOverview(query: QualityOverviewQuery, now = new Date()): Promise<QualityOverviewResponse> {
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
        judgeModel: judge?.name ?? null,
        judgeVersion: settings.judgeVersion,
        status,
        backlog,
      },
      metrics: {
        faithfulness: metricValue("faithfulness", aggregate, previousAggregate, settings.faithfulnessThreshold),
        answerRelevancy: metricValue(
          "answerRelevancy",
          aggregate,
          previousAggregate,
          settings.answerRelevancyThreshold,
        ),
        contextPrecision: metricValue(
          "contextPrecision",
          aggregate,
          previousAggregate,
          settings.contextPrecisionThreshold,
        ),
      },
      trend: trend.map((point) => ({
        bucket: point.bucket,
        faithfulness: score(point.faithfulness),
        answerRelevancy: score(point.answerRelevancy),
        contextPrecision: score(point.contextPrecision),
        sampleCount: point.sampleCount,
        insufficientSample: point.sampleCount < LOW_SAMPLE_COUNT,
      })),
      byAgent: byAgent.map((item) => ({
        agentId: item.agentId,
        agentName: item.agentName,
        scores: aggregateScores(item),
        sampleCount: item.sampleCount,
      })),
      lowSamples: lowSamples.filter((item) =>
        item.faithfulness < settings.faithfulnessThreshold ||
        item.answerRelevancy < settings.answerRelevancyThreshold ||
        item.contextPrecision < settings.contextPrecisionThreshold,
      ).map((item) => {
        const scores = {
          faithfulness: score(item.faithfulness) ?? 0,
          answerRelevancy: score(item.answerRelevancy) ?? 0,
          contextPrecision: score(item.contextPrecision) ?? 0,
        };
        const minMetric = minimumMetric(scores);
        return {
          targetTraceId: item.targetTraceId,
          question: item.question,
          minMetric,
          minScore: scores[minMetric],
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
        scores: {
          faithfulness: score(success.faithfulness) ?? 0,
          answerRelevancy: score(success.answerRelevancy) ?? 0,
          contextPrecision: score(success.contextPrecision) ?? 0,
        },
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
    return { status: "unscored" };
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

  async updateSettings(update: UpdateOnlineEvalSettingsRequest): Promise<OnlineEvalSettingsResponse> {
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
 * 「worker 没在跑」与「worker 在跑但落后」是两件事，此前在屏1 上同形（都显示评测滞后）。
 * lastRunAt 由 tryAcquireLease 每轮盖一次——它断言的是「worker 醒过来了」，
 * 与 backlog（有没有活儿）正交：没流量时 backlog=0 但 worker 照样该每 15 分钟报到一次。
 * 空值 = 一轮都没跑过（水位线行可能刚被 worker 建出来还没跑完第一轮）。
 */
function workerStalled(lastRunAt: Date | null | undefined, now: Date): boolean {
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt.getTime() > WORKER_STALE_MS;
}

function score(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(100, Math.round(value)));
}

function metricValue(
  metric: keyof Pick<EvaluationAggregate, "faithfulness" | "answerRelevancy" | "contextPrecision">,
  current: EvaluationAggregate,
  previous: EvaluationAggregate,
  threshold: number,
) {
  const value = score(current[metric]);
  const previousValue = score(previous[metric]);
  return {
    value,
    previousDelta:
      current.sampleCount < LOW_SAMPLE_COUNT || previous.sampleCount < LOW_SAMPLE_COUNT || value === null || previousValue === null
        ? null
        : value - previousValue,
    sampleCount: current.sampleCount,
    threshold,
    low: value !== null && value < threshold,
  };
}

function aggregateScores(aggregate: EvaluationAggregate): QualityScores | null {
  if (aggregate.sampleCount === 0) return null;
  const faithfulness = score(aggregate.faithfulness);
  const answerRelevancy = score(aggregate.answerRelevancy);
  const contextPrecision = score(aggregate.contextPrecision);
  return faithfulness === null || answerRelevancy === null || contextPrecision === null
    ? null
    : { faithfulness, answerRelevancy, contextPrecision };
}

function thresholds(settings: OnlineEvalSettingsRow): QualityScores {
  return {
    faithfulness: settings.faithfulnessThreshold,
    answerRelevancy: settings.answerRelevancyThreshold,
    contextPrecision: settings.contextPrecisionThreshold,
  };
}

function minimumMetric(scores: QualityScores): QualityMetric {
  return (Object.entries(scores) as Array<[QualityMetric, number]>).reduce((lowest, current) =>
    current[1] < lowest[1] ? current : lowest,
  )[0];
}

function parseEvidence(raw: string): QualityEvidence {
  try {
    const value = JSON.parse(raw) as Partial<Record<QualityMetric, unknown>>;
    return {
      faithfulness: evidenceList(value.faithfulness),
      answerRelevancy: evidenceList(value.answerRelevancy),
      contextPrecision: evidenceList(value.contextPrecision),
    };
  } catch {
    return emptyEvidence();
  }
}

function evidenceList(value: unknown): string[] {
  if (!Array.isArray(value)) return ["No evidence returned"];
  const items = value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 300)).slice(0, 5);
  return items.length ? items : ["No evidence returned"];
}

function emptyEvidence(): QualityEvidence {
  return {
    faithfulness: ["No evidence returned"],
    answerRelevancy: ["No evidence returned"],
    contextPrecision: ["No evidence returned"],
  };
}

function evidenceSummary(raw: string): string {
  const evidence = parseEvidence(raw);
  return [...evidence.faithfulness, ...evidence.answerRelevancy, ...evidence.contextPrecision][0].slice(0, 300);
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
