import { z } from "zod";

export const EvalMetricSchema = z.object({
  label: z.string().min(1),
  value: z.string(),
  pct: z.string().optional(),
  color: z.string().optional(),
});
export type EvalMetric = z.infer<typeof EvalMetricSchema>;

export const EvalCaseResultSchema = z.object({
  q: z.string().min(1),
  recall: z.string(),
  acc: z.string(),
  cite: z.string(),
  st: z.string(),
  tag: z.string().optional(),
});
export type EvalCaseResult = z.infer<typeof EvalCaseResultSchema>;

export const EvalRunSchema = z.object({
  id: z.string().min(1),
  setId: z.string().min(1),
  agentId: z.string().min(1),
  total: z.number().int().nonnegative(),
  time: z.string(),
  metrics: z.array(EvalMetricSchema),
  cases: z.array(EvalCaseResultSchema),
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

export const EvalRunListResponseSchema = z.array(EvalRunSchema);
export type EvalRunListResponse = z.infer<typeof EvalRunListResponseSchema>;
