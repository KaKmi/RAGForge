import { z } from "zod";

const isoString = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();

export const QualityMetricSchema = z.enum(["faithfulness", "answerRelevancy", "contextPrecision"]);
export type QualityMetric = z.infer<typeof QualityMetricSchema>;

export const QualityScoreSchema = z.number().int().min(0).max(100);
export type QualityScore = z.infer<typeof QualityScoreSchema>;

export const QualityScoresSchema = z.object({
  faithfulness: QualityScoreSchema.nullable(),
  answerRelevancy: QualityScoreSchema,
  contextPrecision: QualityScoreSchema,
});
export type QualityScores = z.infer<typeof QualityScoresSchema>;

export const QualityEvidenceSchema = z.object({
  faithfulness: z.array(z.string().max(300)).min(1).max(5).optional(),
  answerRelevancy: z.array(z.string().max(300)).min(1).max(5),
  contextPrecision: z.array(z.string().max(300)).min(1).max(5),
});
export type QualityEvidence = z.infer<typeof QualityEvidenceSchema>;

export const QualityThresholdsSchema = z.object({
  faithfulness: QualityScoreSchema,
  answerRelevancy: QualityScoreSchema,
  contextPrecision: QualityScoreSchema,
});
export type QualityThresholds = z.infer<typeof QualityThresholdsSchema>;

export const TraceQualityDetailSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unscored") }),
  /** B1/F3：人工「立即评测」已入队/运行中。原型 §18.D：面板「评分中」，轮询 5s×6。 */
  z.object({ status: z.literal("scoring"), startedAt: isoString.nullable() }),
  z.object({
    status: z.literal("scored"),
    scores: QualityScoresSchema,
    thresholds: QualityThresholdsSchema,
    judgeModel: z.string().min(1),
    judgeVersion: z.string().min(1),
    scoredAt: isoString,
    currentVersion: z.boolean(),
    evidence: QualityEvidenceSchema,
  }),
  z.object({
    status: z.literal("failed"),
    judgeVersion: z.string().min(1),
    failedAt: isoString,
    reason: z.string().min(1).max(200),
    currentVersion: z.boolean(),
  }),
]);
export type TraceQualityDetail = z.infer<typeof TraceQualityDetailSchema>;

/**
 * B1/F3：「立即评测」的受理结果。
 * `scoring` = 已入队（前端转轮询）；`scored` = 该 trace 已有当前判分版本的分数，
 * 直接可见，**不入队、不调裁判、不计费**。
 */
export const ManualScoreResponseSchema = z.strictObject({
  status: z.enum(["scoring", "scored"]),
});
export type ManualScoreResponse = z.infer<typeof ManualScoreResponseSchema>;

export const TraceEvaluationSummarySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unscored") }),
  z.object({
    status: z.literal("scored"),
    scores: QualityScoresSchema,
    minMetric: QualityMetricSchema,
    minScore: QualityScoreSchema,
    judgeVersion: z.string().min(1),
    evaluatedAt: isoString,
  }),
]);
export type TraceEvaluationSummary = z.infer<typeof TraceEvaluationSummarySchema>;

export const QualityOverviewQuerySchema = z
  .object({
    from: isoString.optional(),
    to: isoString.optional(),
    agentId: z.string().min(1).optional(),
  })
  .superRefine(({ from, to }, ctx) => {
    if (!from || !to) return;
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (end <= start) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
    }
    if (end - start > 30 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "window must not exceed 30 days" });
    }
  });
export type QualityOverviewQuery = z.infer<typeof QualityOverviewQuerySchema>;

const qualityMetricValue = z.object({
  value: QualityScoreSchema.nullable(),
  previousDelta: z.number().min(-100).max(100).nullable(),
  sampleCount: count,
  threshold: QualityScoreSchema,
  low: z.boolean(),
});

const qualityPoint = z.object({
  bucket: isoString,
  faithfulness: QualityScoreSchema.nullable(),
  answerRelevancy: QualityScoreSchema.nullable(),
  contextPrecision: QualityScoreSchema.nullable(),
  faithfulnessSampleCount: count,
  sampleCount: count,
  insufficientSample: z.boolean(),
});

const qualityAgent = z.object({
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  scores: QualityScoresSchema.nullable(),
  sampleCount: count,
});

const qualityLowSample = z.object({
  targetTraceId: z.string().regex(/^[a-f0-9]{32}$/i),
  question: z.string(),
  minMetric: QualityMetricSchema,
  minScore: QualityScoreSchema,
  evidenceSummary: z.string().max(300),
});

export const QualityOverviewResponseSchema = z.object({
  meta: z.object({
    enabled: z.boolean(),
    sampleRate: z.number().min(0).max(1),
    evaluatedCount: count,
    // 窗口内非 preview trace 总数。与 evaluatedCount 同窗口，故「已评测/窗口内」是可比的覆盖率。
    eligibleCount: count,
    // 窗口内且仍在游标之后的 trace 数 —— 只有这些还有机会被评。
    // 游标已越过的 trace 永不回头（listCandidates 用严格元组游标）。
    evaluableCount: count,
    /**
     * 游标已越过、却没有分数的那些——按原因拆开。
     *
     * `total` 是**算术**得来（窗口内 − 已评 − 仍可评），前四项来自 **PG 账本**（worker 真的
     * 看过并做了判定的）。两者的差就是 `neverSeen`：**从没进过候选集**的——冷启动播种把
     * 游标钉在 `now-N 小时`，更早的 trace 一眼都没被看过，故账本里没有它们的行。
     * 这一类通常是最大的一类，也是最容易被误读成「抽样刷掉」的一类（018 §12 缺口 20 正是
     * 这么误判的）。
     */
    missed: z.object({
      total: count,
      sampledOut: count,
      quotaSkipped: count,
      incomplete: count,
      judgeFailed: count,
      neverSeen: count,
    }),
    /**
     * 账本说评过、ClickHouse 里却查不到分数的条数（同窗口、同 judgeVersion）。
     * 恒 0 才正常；> 0 = span 投递丢包 —— `forceFlushTelemetry` 吞掉导出失败，故
     * 「worker 认为评了」不蕴含「分数可查」。这个数是账本存在的核心理由之一。
     */
    scoresNotPersisted: count,
    judgeModel: z.string().nullable(),
    judgeVersion: z.string().min(1),
    // worker_stalled 排在 backlog 判定之前：worker 没在跑时，backlog 是多少都不重要，
    // 且没流量时 backlog=0 会把「worker 死了」伪装成 healthy。
    status: z.enum([
      "disabled",
      "healthy",
      "lagging",
      "budget_reduced",
      "model_unavailable",
      "worker_stalled",
    ]),
    backlog: count,
  }),
  metrics: z.object({
    faithfulness: qualityMetricValue,
    answerRelevancy: qualityMetricValue,
    contextPrecision: qualityMetricValue,
  }),
  trend: z.array(qualityPoint),
  byAgent: z.array(qualityAgent),
  lowSamples: z.array(qualityLowSample),
});
export type QualityOverviewResponse = z.infer<typeof QualityOverviewResponseSchema>;

export const OnlineEvalSettingsSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  sampleRate: z.number().min(0).max(1),
  judgeModelId: z.string().min(1).nullable(),
  embeddingModelId: z.string().min(1).nullable(),
  faithfulnessThreshold: QualityScoreSchema,
  answerRelevancyThreshold: QualityScoreSchema,
  contextPrecisionThreshold: QualityScoreSchema,
  dailyCap: z.number().int().min(1).max(10_000),
  judgeVersion: z.string().min(1),
  updatedAt: isoString,
});
export type OnlineEvalSettings = z.infer<typeof OnlineEvalSettingsSchema>;

export const UpdateOnlineEvalSettingsRequestSchema = OnlineEvalSettingsSchema.pick({
  enabled: true,
  sampleRate: true,
  judgeModelId: true,
  embeddingModelId: true,
  faithfulnessThreshold: true,
  answerRelevancyThreshold: true,
  contextPrecisionThreshold: true,
  dailyCap: true,
})
  .partial()
  .superRefine((value, ctx) => {
    if (value.enabled && (!value.judgeModelId || !value.embeddingModelId)) {
      ctx.addIssue({
        code: "custom",
        path: ["enabled"],
        message: "judgeModelId and embeddingModelId are required when enabling",
      });
    }
  });
export type UpdateOnlineEvalSettingsRequest = z.infer<typeof UpdateOnlineEvalSettingsRequestSchema>;

export const EvalModelOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  available: z.boolean(),
});
export type EvalModelOption = z.infer<typeof EvalModelOptionSchema>;

export const OnlineEvalSettingsResponseSchema = z.object({
  settings: OnlineEvalSettingsSchema,
  models: z.object({
    judges: z.array(EvalModelOptionSchema),
    embeddings: z.array(EvalModelOptionSchema),
  }),
});
export type OnlineEvalSettingsResponse = z.infer<typeof OnlineEvalSettingsResponseSchema>;
