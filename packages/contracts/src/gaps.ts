import { z } from "zod";

/**
 * 知识缺口 / 问题池（021 B2a）的前后端契约。
 * 契约包只依赖 zod（AGENTS.md 边界 3）——这里不得出现任何 Node-only 或 DOM 依赖。
 */

/** 缺口簇状态（B2a 可达三态；B2b 加四态时此处与 DB CHECK 同步扩）。 */
export const GAP_CLUSTER_STATUSES = ["pending", "routed_retrieval", "ignored"] as const;
export const GapClusterStatusSchema = z.enum(GAP_CLUSTER_STATUSES);
export type GapClusterStatus = z.infer<typeof GapClusterStatusSchema>;

/** 根因分诊（原型 `:371`）。 */
export const GAP_ROOT_CAUSES = ["missing", "retrieval", "generation"] as const;
export const GapRootCauseSchema = z.enum(GAP_ROOT_CAUSES);
export type GapRootCause = z.infer<typeof GapRootCauseSchema>;

/** 入池来源。`offline_run` 不计入 freq30d（021 决策 D）。 */
export const GAP_ITEM_SOURCES = ["online", "manual_trace", "offline_run"] as const;
export const GapItemSourceSchema = z.enum(GAP_ITEM_SOURCES);
export type GapItemSource = z.infer<typeof GapItemSourceSchema>;

/** 屏5 缺口表格的一行。 */
export const GapClusterSchema = z.object({
  id: z.string().uuid(),
  representativeQuestion: z.string(),
  /** 累计命中次数（原型 mock 的「×23」），trace 过期不减。 */
  freq: z.number().int().nonnegative(),
  /** 滚动 30 天命中次数（查询期聚合，不含 offline_run）。 */
  freq30d: z.number().int().nonnegative(),
  status: GapClusterStatusSchema,
  /** 生效根因 = COALESCE(manual, auto)；未分诊时为 null。 */
  rootCause: GapRootCauseSchema.nullable(),
  /** 人工是否改判过——UI 用它区分「人工判的」与「worker 判的」。 */
  rootCauseIsManual: z.boolean(),
  /** 簇内各 item 的 min(三个非空指标) 的均值；无可用分数时 null（**绝不用 0 冒充**）。 */
  avgQuality: z.number().min(0).max(100).nullable(),
  /** 疑似指代追问占比（分母只算 online item）；> 0.5 时 rootCauseAuto 被强制为 retrieval。 */
  followUpRatio: z.number().min(0).max(1),
  /** 「已进评测集」叠加标志（非排他状态，原型 `:634`）。 */
  enteredEvalSetAt: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});
export type GapCluster = z.infer<typeof GapClusterSchema>;

/** 簇内一条真实问题（行展开）。 */
export const GapItemSchema = z.object({
  id: z.string().uuid(),
  clusterId: z.string().uuid(),
  source: GapItemSourceSchema,
  sourceTraceId: z.string(),
  /** 用户原文。 */
  question: z.string(),
  /** 改写后的独立问题；rewriteResolved=false 时为 null。 */
  rewrittenQuestion: z.string().nullable(),
  /** false = 指代未被消解 ⇒ 入集前必须人工改写（021 §6.3 的守卫）。 */
  rewriteResolved: z.boolean(),
  followUpSuspected: z.boolean(),
  traceStartTime: z.string().nullable(),
  /** 源 trace 是否已过 TTL（过期只置灰链接，不删行、不减频次）。 */
  traceExpired: z.boolean(),
  faithfulness: z.number().int().min(0).max(100).nullable(),
  answerRelevancy: z.number().int().min(0).max(100).nullable(),
  contextPrecision: z.number().int().min(0).max(100).nullable(),
  confidence: z.number().int().min(0).max(100).nullable(),
});
export type GapItem = z.infer<typeof GapItemSchema>;

/** 屏5 概览卡 ×4（原型 `:629`）。 */
export const GapSummarySchema = z.object({
  pending: z.number().int().nonnegative(),
  routedRetrieval: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
  enteredEvalSet: z.number().int().nonnegative(),
});
export type GapSummary = z.infer<typeof GapSummarySchema>;

/** 屏5 列表查询（状态/根因两个 Select，走 URL 参数）。 */
export const GapListQuerySchema = z.object({
  status: GapClusterStatusSchema.optional(),
  rootCause: GapRootCauseSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type GapListQuery = z.infer<typeof GapListQuerySchema>;

export const GapListResponseSchema = z.object({
  items: z.array(GapClusterSchema),
  total: z.number().int().nonnegative(),
});
export type GapListResponse = z.infer<typeof GapListResponseSchema>;

/** 手动入池（Trace 详情 / 屏3 逐用例表；021 决策 B：前端组合，不产生后端反向边）。 */
export const CreateGapItemRequestSchema = z.object({
  question: z.string().min(1).max(500),
  source: z.enum(["manual_trace", "offline_run"]),
  sourceTraceId: z.string().min(1).max(32),
});
export type CreateGapItemRequest = z.infer<typeof CreateGapItemRequestSchema>;

export const CreateGapItemResponseSchema = z.object({
  clusterId: z.string().uuid(),
  /** true = 并入了既有簇（前端据此提示「已在缺口『…』(×N) 中 · 查看」，原型 `:648`）。 */
  joinedExisting: z.boolean(),
  representativeQuestion: z.string(),
  freq: z.number().int().nonnegative(),
});
export type CreateGapItemResponse = z.infer<typeof CreateGapItemResponseSchema>;

/** 人工改判根因（写 root_cause_manual，worker 永不覆盖）。 */
export const UpdateGapRootCauseRequestSchema = z.object({
  rootCause: GapRootCauseSchema,
});
export type UpdateGapRootCauseRequest = z.infer<typeof UpdateGapRootCauseRequestSchema>;

/** 拆分为新簇：把选中的 item 移出（原型 `:632`）。 */
export const SplitGapRequestSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1),
});
export type SplitGapRequest = z.infer<typeof SplitGapRequestSchema>;

/** 移入其他簇（纠正聚类错误）。 */
export const MergeGapRequestSchema = z.object({
  targetClusterId: z.string().uuid(),
  itemIds: z.array(z.string().uuid()).min(1),
});
export type MergeGapRequest = z.infer<typeof MergeGapRequestSchema>;
