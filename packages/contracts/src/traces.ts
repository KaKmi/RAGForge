import { z } from "zod";

const traceIdSchema = z.string().regex(/^[a-f0-9]{32}$/i);
const spanIdSchema = z.string().regex(/^[a-f0-9]{16}$/i);

export const HelloTraceResponseSchema = z.object({
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  name: z.literal("manual.hello"),
});
export type HelloTraceResponse = z.infer<typeof HelloTraceResponseSchema>;

export const TraceSpanSchema = z.object({
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  parentSpanId: spanIdSchema.nullable(),
  name: z.string().min(1),
  kind: z.string().min(1),
  startTime: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  statusCode: z.string(),
  attributes: z.record(z.string(), z.unknown()),
});
export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export const TraceDetailResponseSchema = z.object({
  traceId: traceIdSchema,
  spans: z.array(TraceSpanSchema),
});
export type TraceDetailResponse = z.infer<typeof TraceDetailResponseSchema>;

// —— M9 W1：Trace 列表 / 概览 / Session 列表读模型 DTO ——
// 响应 status 用英文 token（契约稳定）；query 的 status/quick 用中文 enum（前端筛选值零映射）。

export const TraceStatusSchema = z.enum(["success", "fallback", "failed"]);
export type TraceStatus = z.infer<typeof TraceStatusSchema>;

export const SessionStatusSchema = z.enum(["normal", "has_fallback", "has_failure"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const QualitySignalSchema = z.enum(["low_recall", "no_citations", "refusal", "timeout"]);
export type QualitySignal = z.infer<typeof QualitySignalSchema>;

export const TraceListRowSchema = z.object({
  traceId: traceIdSchema,
  sessionId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  userId: z.string().nullable(),
  userInput: z.string(),
  status: TraceStatusSchema,
  startTime: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  qualitySignals: z.array(QualitySignalSchema),
  promptVersionId: z.string().nullable(),
});
export type TraceListRow = z.infer<typeof TraceListRowSchema>;

export const TraceListSummarySchema = z.object({
  sampledTotal: z.number().int().nonnegative(),
  failRate: z.number(),
  failCount: z.number().int().nonnegative(),
  p95Ms: z.number().nonnegative(),
  timeoutCount: z.number().int().nonnegative(),
});
export type TraceListSummary = z.infer<typeof TraceListSummarySchema>;

export const TraceListResponseSchema = z.object({
  items: z.array(TraceListRowSchema),
  total: z.number().int().nonnegative(),
  summary: TraceListSummarySchema,
});
export type TraceListResponse = z.infer<typeof TraceListResponseSchema>;

export const SessionListRowSchema = z.object({
  sessionId: z.string(),
  userId: z.string().nullable(),
  agentId: z.string(),
  agentName: z.string(),
  roundCount: z.number().int().nonnegative(),
  firstQuestion: z.string(),
  firstTs: z.string().datetime(),
  lastTs: z.string().datetime(),
  status: SessionStatusSchema,
});
export type SessionListRow = z.infer<typeof SessionListRowSchema>;

export const SessionListResponseSchema = z.array(SessionListRowSchema);
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

// query：status/quick 用中文 enum 直传（repository 内翻 CH 值）；page/pageSize coerce（query 全字符串）
export const TraceListQuerySchema = z.object({
  q: z.string().optional(),
  agentId: z.string().optional(),
  status: z.enum(["全部", "成功", "兜底", "失败"]).optional(),
  quick: z.enum(["全部", "失败", "慢请求", "低分召回"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type TraceListQuery = z.infer<typeof TraceListQuerySchema>;
