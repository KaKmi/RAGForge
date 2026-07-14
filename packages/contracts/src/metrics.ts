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

export const MetricsAppResponseSchema = MetricsOverviewResponseSchema;
export type MetricsAppResponse = z.infer<typeof MetricsAppResponseSchema>;
