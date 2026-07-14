import { z } from "zod";

const isoString = z.string().datetime({ offset: true });

export const MetricsQuerySchema = z.object({
  from: isoString.optional(),
  to: isoString.optional(),
  agentId: z.string().optional(),
  model: z.string().optional(),
});
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;

export const MetricsWindowSchema = z.object({
  qaCount: z.number(),
  failCount: z.number(),
  failRate: z.number(),
  fallbackCount: z.number(),
  fallbackRate: z.number(),
  lowRecallCount: z.number(),
  noCiteCount: z.number(),
  refusalCount: z.number(),
  timeoutCount: z.number(),
  p50Ms: z.number(),
  p95Ms: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});
export type MetricsWindow = z.infer<typeof MetricsWindowSchema>;

export const MetricsBucketSchema = z.object({
  bucket: z.string(),
  qaCount: z.number(),
  failCount: z.number(),
  fallbackCount: z.number(),
  p50Ms: z.number(),
  p95Ms: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});
export type MetricsBucket = z.infer<typeof MetricsBucketSchema>;

export const MetricsOverviewResponseSchema = z.object({
  window: MetricsWindowSchema,
  series: z.array(MetricsBucketSchema),
});
export type MetricsOverviewResponse = z.infer<typeof MetricsOverviewResponseSchema>;

export const MetricsStageKeySchema = z.enum([
  "rewrite",
  "intent",
  "embedding",
  "retrieval",
  "rerank",
  "generation",
]);
export type MetricsStageKey = z.infer<typeof MetricsStageKeySchema>;

export const MetricsStageSchema = z.object({
  stage: MetricsStageKeySchema,
  sampleCount: z.number().int().nonnegative(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
});
export type MetricsStage = z.infer<typeof MetricsStageSchema>;

const nullableNonnegative = z.number().nonnegative().nullable();
const count = z.number().int().nonnegative();
const ratio = z.number().min(0).max(1).nullable();

export const MetricsSignalsSchema = z.object({
  ttft: z.object({ sampleCount: count, p50Ms: nullableNonnegative, p95Ms: nullableNonnegative }),
  generationRate: z.object({
    sampleCount: count,
    p50TokensPerSecond: nullableNonnegative,
    p95TokensPerSecond: nullableNonnegative,
  }),
  repair: z.object({ attemptCount: count, eligibleCount: count, rate: ratio }),
  degradation: z.object({
    keyword: z.object({ count, eligibleCount: count, rate: ratio }),
    rerank: z.object({ count, eligibleCount: count, rate: ratio }),
  }),
  confidence: z.object({
    sampleCount: count,
    p50: z.number().min(0).max(1).nullable(),
    buckets: z.array(z.object({ key: z.enum(["very_low", "low", "medium", "high"]), count })),
  }),
  citations: z.object({
    sampleCount: count,
    averageCount: nullableNonnegative,
    countBuckets: z.array(z.object({ key: z.enum(["none", "one", "two_three", "four_plus"]), count })),
    coverage: z.object({ full: count, partial: count, unknown: count }),
  }),
});
export type MetricsSignals = z.infer<typeof MetricsSignalsSchema>;

export const MetricsAppResponseSchema = MetricsOverviewResponseSchema.extend({
  stages: z.array(MetricsStageSchema),
  signals: MetricsSignalsSchema,
});
export type MetricsAppResponse = z.infer<typeof MetricsAppResponseSchema>;
