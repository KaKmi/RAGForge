import { z } from "zod";

// ISO 8601 字符串（前端传范围）；用 datetime 校验，宽松 offset。
const isoString = z.string().datetime({ offset: true });

export const MetricsQuerySchema = z.object({
  from: isoString.optional(),
  to: isoString.optional(),
  agentId: z.string().optional(),
  model: z.string().optional(),
});
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;

// 窗口聚合值（率在后端由 count 计算后下发）。
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

// 趋势桶点（分钟粒度）。
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

// 单应用响应形状同 overview（限定 agentId）。
export const MetricsAppResponseSchema = MetricsOverviewResponseSchema;
export type MetricsAppResponse = z.infer<typeof MetricsAppResponseSchema>;
