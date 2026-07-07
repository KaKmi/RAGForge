import type { TagKey } from "./agents";

/** M2 mock：Trace 追踪 / 详情页用。M9 接真实读模型（ClickHouse VIEW）。 */

// ---- 列表 ----

export type TrStatus = "成功" | "兜底" | "失败";

export interface TraceRow {
  id: string;
  time: string; // HH:MM:SS
  q: string;
  agent: string;
  st: TrStatus;
  tag: TagKey;
  dur: string; // "2.41s"
  tok: string; // "1,832" | "—"
}

export const TRACE_ROWS: TraceRow[] = [
  { id: "TR-0702-091233", time: "09:12:33", q: "我上周买的《Python 数据分析实战》还没开始学，可以退款吗？", agent: "售后支持", st: "成功", tag: "green", dur: "2.41s", tok: "1,832" },
  { id: "TR-0702-091108", time: "09:11:08", q: "前端就业班和 Java 就业班哪个好找工作？", agent: "课程顾问", st: "成功", tag: "green", dur: "3.02s", tok: "2,415" },
  { id: "TR-0702-090947", time: "09:09:47", q: "帮我把课退了", agent: "售后支持", st: "成功", tag: "green", dur: "1.98s", tok: "1,204" },
  { id: "TR-0702-090512", time: "09:05:12", q: "你们老板是谁", agent: "兜底", st: "兜底", tag: "gold", dur: "0.86s", tok: "312" },
  { id: "TR-0702-090230", time: "09:02:30", q: "证书编号在哪里查", agent: "学习助手", st: "成功", tag: "green", dur: "2.20s", tok: "1,566" },
  { id: "TR-0702-085901", time: "08:59:01", q: "优惠券叠加使用规则", agent: "课程顾问", st: "失败", tag: "red", dur: "30.0s", tok: "—" },
];

export const TR_AGENTS = ["全部", ...Array.from(new Set(TRACE_ROWS.map((t) => t.agent)))];
export const TR_STATUSES: ("全部" | TrStatus)[] = ["全部", "成功", "兜底", "失败"];
export const TR_RANGES = ["今日", "近 7 日", "近 30 日"];
export const TR_QUICK = ["全部", "失败", "慢请求", "低分召回"];

/** "2.41s" → 2.41 */
export function durNum(t: { dur: string }): number {
  return parseFloat(t.dur.replace("s", "")) || 0;
}

// ---- Span 模型（OTLP 风格：start/dur 为相对偏移 ms）----

export type SpanKind = "retriever" | "reranker" | "llm" | "embedding" | "tool" | "chain";
export type SpanStatus = "OK" | "WARN" | "ERROR" | "SKIP";

export const KIND_C: Record<SpanKind, string> = {
  retriever: "#13c2c2",
  reranker: "#faad14",
  llm: "#52c41a",
  embedding: "#722ed1",
  tool: "#8c8c8c",
  chain: "#1677ff",
};
export const KIND_LABEL: Record<SpanKind, string> = {
  retriever: "检索",
  reranker: "重排",
  llm: "LLM",
  embedding: "向量",
  tool: "工具",
  chain: "流程",
};
export const KIND_LEGEND: { label: string; c: string }[] = [
  { label: "检索", c: "#13c2c2" },
  { label: "向量", c: "#722ed1" },
  { label: "重排", c: "#faad14" },
  { label: "LLM", c: "#52c41a" },
  { label: "流程/工具", c: "#1677ff" },
];

export interface SpanDef {
  sid: string;
  pid: string | null;
  name: string;
  kind: SpanKind;
  start: number;
  dur: number;
  status: SpanStatus;
  tin?: number;
  tout?: number;
  cost?: number;
  errType?: string;
  errMsg?: string;
}

export type SpanSetName = "ok" | "fail" | "fallback";

export const SPANSETS: Record<SpanSetName, SpanDef[]> = {
  ok: [
    { sid: "rw", pid: null, name: "问题改写", kind: "llm", start: 0, dur: 45, status: "OK", tin: 120, tout: 60, cost: 0.0004 },
    { sid: "intent", pid: null, name: "意图识别", kind: "llm", start: 45, dur: 38, status: "OK", tin: 180, tout: 20, cost: 0.0003 },
    { sid: "recall", pid: null, name: "多路召回", kind: "retriever", start: 83, dur: 352, status: "OK" },
    { sid: "recall-vec", pid: "recall", name: "向量召回", kind: "embedding", start: 83, dur: 320, status: "OK" },
    { sid: "recall-kw", pid: "recall", name: "关键词召回", kind: "retriever", start: 83, dur: 85, status: "OK" },
    { sid: "rerank", pid: null, name: "重排", kind: "reranker", start: 435, dur: 210, status: "OK" },
    { sid: "hits", pid: null, name: "命中知识", kind: "chain", start: 645, dur: 3, status: "OK" },
    { sid: "llm", pid: null, name: "大模型生成", kind: "llm", start: 648, dur: 1740, status: "OK", tin: 1412, tout: 420, cost: 0.021 },
    { sid: "post", pid: null, name: "回复后处理", kind: "tool", start: 2388, dur: 22, status: "OK" },
  ],
  fail: [
    { sid: "rw", pid: null, name: "问题改写", kind: "llm", start: 0, dur: 52, status: "OK", tin: 130, tout: 55, cost: 0.0004 },
    { sid: "intent", pid: null, name: "意图识别", kind: "llm", start: 52, dur: 41, status: "OK", tin: 190, tout: 18, cost: 0.0003 },
    { sid: "recall", pid: null, name: "多路召回", kind: "retriever", start: 93, dur: 410, status: "OK" },
    { sid: "recall-vec", pid: "recall", name: "向量召回", kind: "embedding", start: 93, dur: 380, status: "OK" },
    { sid: "recall-kw", pid: "recall", name: "关键词召回", kind: "retriever", start: 93, dur: 92, status: "OK" },
    { sid: "rerank", pid: null, name: "重排", kind: "reranker", start: 503, dur: 198, status: "OK" },
    { sid: "hits", pid: null, name: "命中知识", kind: "chain", start: 701, dur: 3, status: "OK" },
    {
      sid: "llm",
      pid: null,
      name: "大模型生成",
      kind: "llm",
      start: 704,
      dur: 29296,
      status: "ERROR",
      errType: "DeadlineExceeded",
      errMsg: "上游模型网关 30,000ms 未返回，请求被熔断。疑似大促流量导致 DeepSeek-V3 排队；建议为该 Agent 配置备用模型或降级兜底。",
    },
    { sid: "post", pid: null, name: "回复后处理", kind: "tool", start: 30000, dur: 0, status: "SKIP" },
  ],
  fallback: [
    { sid: "rw", pid: null, name: "问题改写", kind: "llm", start: 0, dur: 40, status: "OK", tin: 110, tout: 48, cost: 0.0004 },
    { sid: "intent", pid: null, name: "意图识别", kind: "llm", start: 40, dur: 35, status: "OK", tin: 170, tout: 16, cost: 0.0003 },
    { sid: "recall", pid: null, name: "多路召回", kind: "retriever", start: 75, dur: 310, status: "OK" },
    { sid: "recall-vec", pid: "recall", name: "向量召回", kind: "embedding", start: 75, dur: 288, status: "OK" },
    { sid: "recall-kw", pid: "recall", name: "关键词召回", kind: "retriever", start: 75, dur: 70, status: "OK" },
    { sid: "rerank", pid: null, name: "重排", kind: "reranker", start: 385, dur: 180, status: "OK" },
    { sid: "hits", pid: null, name: "命中知识", kind: "chain", start: 565, dur: 2, status: "WARN" },
    { sid: "fallback", pid: null, name: "兜底应答", kind: "chain", start: 567, dur: 293, status: "OK", tin: 60, tout: 40, cost: 0.0006 },
  ],
};

export function spanSetOf(st: TrStatus): SpanDef[] {
  return SPANSETS[st === "失败" ? "fail" : st === "兜底" ? "fallback" : "ok"];
}

// ---- Span 详情（按 sid 索引）----

export interface ScoreRow {
  doc: string;
  vec: string;
  kw: string;
  rr: string;
  pass: boolean;
}

export interface SpanDetailDef {
  title: string;
  meta?: { k: string; v: string }[];
  scoresTitle?: string;
  scores?: ScoreRow[];
  input: string;
  output: string;
}

export const NODE_DETAIL: Record<string, SpanDetailDef> = {
  rw: {
    title: "问题改写",
    meta: [{ k: "模型", v: "DeepSeek-V3 · temperature 0.1" }, { k: "Prompt", v: "问题改写-通用 v7" }],
    input: "原始问题：我上周买的《Python 数据分析实战》还没开始学，可以退款吗？\n会话历史：（空）",
    output: "改写问题：用户购买《Python 数据分析实战》7 天内且未学习，咨询全额退款条件与流程\n扩展查询词：退款政策 / 未学习 / 全额退款 / 退款流程",
  },
  intent: {
    title: "意图识别",
    meta: [{ k: "模型", v: "DeepSeek-V3 · temperature 0.0" }, { k: "Prompt", v: "意图识别-三分类 v4" }],
    input: "改写问题：用户购买《Python 数据分析实战》7 天内且未学习，咨询全额退款条件与流程",
    output: "意图：售后 / 退款咨询（置信度 0.96）\n路由知识库：售后服务知识库、订单FAQ\n情绪：中性 · 转人工：否",
  },
  recall: {
    title: "多路召回",
    meta: [{ k: "策略", v: "向量 + 关键词（BM25）双路并行" }, { k: "范围", v: "售后服务知识库 · 订单FAQ" }],
    input: "查询向量：bge-m3 · 1024 维\n关键词：[退款, 未学习, 全额退款, 流程]",
    output: "向量召回：Top 20（320ms）\n关键词召回：Top 10（85ms）\n合并去重后：26 条候选分块",
  },
  "recall-vec": {
    title: "向量召回",
    meta: [{ k: "索引", v: "HNSW · 售后服务知识库 + 订单FAQ" }, { k: "模型", v: "bge-m3 (1024 维)" }],
    input: "改写问题向量（1024 维）· Top K = 20",
    output: "#1  0.912  《课程退款与换课政策 V3.2》第二条 · 七天无理由退款\n#2  0.887  《课程退款与换课政策 V3.2》第三条 · 部分学习退款\n#3  0.871  《帮助中心 · 订单与退款操作指南》如何申请退款\n#4  0.846  《课程退款与换课政策 V3.2》第五条 · 换课规则\n#5  0.812  《订单FAQ》退款到账时间\n… 共 20 条",
  },
  "recall-kw": {
    title: "关键词召回",
    meta: [{ k: "算法", v: "BM25" }, { k: "关键词", v: "退款 / 未学习 / 全额退款 / 流程" }],
    input: "关键词：[退款, 未学习, 全额退款, 流程] · Top K = 10",
    output: "#1  12.4  《订单FAQ》退款到账时间\n#2  11.8  《课程退款与换课政策 V3.2》第二条 · 七天无理由退款\n#3  10.2  《帮助中心 · 订单与退款操作指南》如何申请退款\n… 共 10 条",
  },
  rerank: {
    title: "重排",
    meta: [{ k: "模型", v: "bge-reranker-v2-m3" }, { k: "输入 / 输出", v: "26 条候选 → Top 5" }],
    scoresTitle: "重排打分 · Top 5",
    scores: [
      { doc: "退款政策 V3.2 · 第二条 七天无理由", vec: "0.912", kw: "11.8", rr: "0.94", pass: true },
      { doc: "退款政策 V3.2 · 第三条 部分退款", vec: "0.887", kw: "9.6", rr: "0.91", pass: true },
      { doc: "订单与退款操作指南 · 如何申请退款", vec: "0.871", kw: "10.2", rr: "0.87", pass: true },
      { doc: "退款政策 V3.2 · 第五条 换课规则", vec: "0.846", kw: "6.1", rr: "0.83", pass: true },
      { doc: "订单FAQ · 退款到账时间", vec: "0.812", kw: "12.4", rr: "0.71", pass: true },
      { doc: "服务条款 · 账户注销", vec: "0.643", kw: "2.1", rr: "0.38", pass: false },
    ],
    input: "26 条候选分块 + 改写问题（两两打分）",
    output: "#1  0.94  《课程退款与换课政策 V3.2》第二条 · 七天无理由退款\n#2  0.91  《课程退款与换课政策 V3.2》第三条 · 部分学习退款\n#3  0.87  《帮助中心 · 订单与退款操作指南》如何申请退款\n#4  0.83  《课程退款与换课政策 V3.2》第五条 · 换课规则\n#5  0.71  《订单FAQ》退款到账时间",
  },
  hits: {
    title: "命中知识",
    meta: [{ k: "阈值", v: "Rerank ≥ 0.65 · 通过 5 条" }, { k: "注入 tokens", v: "1,102" }],
    input: "重排 Top 5 分块",
    output: "[1] 0.94 · 第二条 七天无理由退款：学员自购买课程之日起 7 个自然日内，未学习任何课时的，可申请全额退款…\n[2] 0.91 · 第三条 部分学习退款：已学习课时不超过 10% 且不超过 2 节的，可申请退款…\n[3] 0.87 · 如何申请退款：进入「我的订单」→「申请退款」，1-3 个工作日审核…\n[4] 0.83 · 第五条 换课规则：开课后 30 日内可免费换课一次…\n[5] 0.71 · 退款到账时间：微信/支付宝 1-3 个工作日…",
  },
  llm: {
    title: "大模型生成",
    meta: [
      { k: "模型", v: "DeepSeek-V3 · temperature 0.3" },
      { k: "Prompt", v: "售后回复生成 v12" },
      { k: "Tokens", v: "输入 1,412 / 输出 420" },
    ],
    input: "System：你是 CodeCrush 平台售后客服，仅基于给定知识回答，并为每条引用标注角标…（售后回复生成 v12）\nContext：命中知识 5 段（1,102 tokens）\nQuestion：用户购买 7 天内未学习，能否全额退款及流程",
    output: "可以的。根据平台退款政策，您购买后 7 个自然日内且未学习任何课时，可以申请全额退款 [1]。您是 6 月 25 日下的单，今天申请仍在期限内。\n\n退款操作路径：进入「我的订单」→ 选择该课程订单 → 点击「申请退款」，审核一般 1-3 个工作日完成 [3]，款项将原路退回您的支付账户。",
  },
  post: {
    title: "回复后处理",
    meta: [{ k: "检查项", v: "引用对齐 / 敏感词 / PII" }],
    input: "模型回复全文 + 命中知识列表",
    output: "引用对齐：2 处角标均命中知识，通过\n敏感词检查：通过\nPII 检测：未检出\n最终回复：已下发用户",
  },
};

export const FAIL_DETAIL: Record<string, SpanDetailDef> = {
  rw: {
    title: "问题改写",
    meta: [{ k: "模型", v: "DeepSeek-V3 · temp 0.1" }, { k: "Prompt", v: "问题改写-通用 v7" }],
    input: "原始问题：优惠券叠加使用规则\n会话历史：（空）",
    output: "改写问题：多张优惠券能否叠加使用的规则与限制\n扩展查询词：优惠券 / 叠加 / 使用规则 / 限制",
  },
  intent: {
    title: "意图识别",
    meta: [{ k: "模型", v: "DeepSeek-V3 · temp 0.0" }, { k: "Prompt", v: "意图识别-三分类 v4" }],
    input: "改写问题：多张优惠券能否叠加使用的规则与限制",
    output: "意图：售后 / 优惠券咨询（置信度 0.88）\n路由知识库：价格政策、活动物料库",
  },
  recall: {
    title: "多路召回",
    meta: [{ k: "策略", v: "向量 + 关键词双路并行" }, { k: "范围", v: "价格政策 · 活动物料库" }],
    input: "查询向量：bge-m3 · 1024 维\n关键词：[优惠券, 叠加, 使用规则]",
    output: "向量召回 Top 20（380ms）\n关键词召回 Top 10（92ms）\n合并去重后：22 条候选",
  },
  "recall-vec": {
    title: "向量召回",
    meta: [{ k: "索引", v: "HNSW · 价格政策 + 活动物料库" }, { k: "模型", v: "bge-m3 (1024 维)" }],
    input: "改写问题向量（1024 维）· Top K = 20",
    output: "最高相似度 0.71 · 候选整体偏弱",
  },
  "recall-kw": {
    title: "关键词召回",
    meta: [{ k: "算法", v: "BM25" }, { k: "关键词", v: "优惠券 / 叠加 / 使用规则" }],
    input: "关键词 · Top K = 10",
    output: "命中 8 条 · 「叠加」一词覆盖不足",
  },
  rerank: {
    title: "重排",
    meta: [{ k: "模型", v: "bge-reranker-v2-m3" }, { k: "输入 / 输出", v: "22 条候选 → Top 5" }],
    input: "22 条候选 + 改写问题（两两打分）",
    output: "#1  0.62  《活动物料库》双十一优惠券叠加说明\n#2  0.55  《价格政策》优惠券使用须知\n#3  0.49  《活动物料库》满减规则\n… 最高分 0.62，低于阈值 0.65",
  },
  hits: {
    title: "命中知识",
    meta: [{ k: "阈值", v: "Rerank ≥ 0.65 · 通过 0 条" }, { k: "降级", v: "放宽注入 Top 3" }],
    input: "重排 Top 5",
    output: "⚠ 无分块达到阈值 0.65（最高 0.62），已放宽注入 Top 3 供生成参考",
  },
  llm: {
    title: "大模型生成",
    meta: [
      { k: "模型", v: "DeepSeek-V3 · temp 0.3" },
      { k: "Prompt", v: "课程推荐生成 v9" },
      { k: "超时设置", v: "30,000ms" },
    ],
    input: "System：CodeCrush 客服，仅基于给定知识回答…\nContext：3 段低置信知识（放宽注入）\nQuestion：优惠券叠加使用规则",
    output: "（无输出 · 请求在 30s 处超时被熔断）",
  },
  post: {
    title: "回复后处理",
    meta: [{ k: "状态", v: "未执行（上游 span 失败）" }],
    input: "—",
    output: "因大模型生成失败，后处理未触发。",
  },
};

export const FB_DETAIL: Record<string, SpanDetailDef> = {
  rw: {
    title: "问题改写",
    meta: [{ k: "模型", v: "DeepSeek-V3 · temp 0.1" }, { k: "Prompt", v: "问题改写-通用 v7" }],
    input: "原始问题：你们老板是谁\n会话历史：（空）",
    output: "改写问题：咨询公司创始人 / 负责人信息\n扩展查询词：老板 / 创始人 / 负责人",
  },
  intent: {
    title: "意图识别",
    meta: [{ k: "模型", v: "DeepSeek-V3 · temp 0.0" }, { k: "Prompt", v: "意图识别-三分类 v4" }],
    input: "改写问题：咨询公司创始人 / 负责人信息",
    output: "意图：闲聊 / 无关业务（置信度 0.41）\n路由知识库：无匹配",
  },
  recall: {
    title: "多路召回",
    meta: [{ k: "策略", v: "向量 + 关键词双路并行" }, { k: "范围", v: "全部知识库" }],
    input: "查询向量：bge-m3 · 1024 维\n关键词：[老板, 创始人, 负责人]",
    output: "向量召回 Top 20 · 最高相似度 0.31\n关键词召回：0 命中\n候选整体低相关",
  },
  "recall-vec": {
    title: "向量召回",
    meta: [{ k: "模型", v: "bge-m3 (1024 维)" }],
    input: "Top K = 20",
    output: "最高相似度 0.31 · 无强相关分块",
  },
  "recall-kw": {
    title: "关键词召回",
    meta: [{ k: "算法", v: "BM25" }],
    input: "[老板, 创始人, 负责人]",
    output: "0 命中",
  },
  rerank: {
    title: "重排",
    meta: [{ k: "模型", v: "bge-reranker-v2-m3" }],
    input: "候选分块 + 改写问题",
    output: "最高 Rerank 分 0.29 · 全部低于阈值 0.65",
  },
  hits: {
    title: "命中知识",
    meta: [{ k: "阈值", v: "Rerank ≥ 0.65 · 通过 0 条" }],
    input: "重排结果",
    output: "⚠ 命中 0 条 · 触发兜底策略",
  },
  fallback: {
    title: "兜底应答",
    meta: [{ k: "策略", v: "无命中知识 → 兜底话术" }, { k: "Prompt", v: "兜底话术 v3" }],
    input: "用户问题：你们老板是谁",
    output: "这个问题我暂时无法从知识库中找到答案～您可以咨询课程、订单、学习相关的问题，或输入「转人工」联系客服。",
  },
};

export const LLM_CITES: { n: string; doc: string; rr: string }[] = [
  { n: "[1]", doc: "退款政策 V3.2 · 第二条 七天无理由退款", rr: "0.94" },
  { n: "[3]", doc: "订单与退款操作指南 · 如何申请退款", rr: "0.87" },
];

export function detailSetOf(st: TrStatus): Record<string, SpanDetailDef> {
  return st === "失败" ? FAIL_DETAIL : st === "兜底" ? FB_DETAIL : NODE_DETAIL;
}

// ---- 计算助手 ----

export function fmtMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms";
}

export function statusColor(st: SpanStatus): string | null {
  return st === "ERROR" ? "#ff4d4f" : st === "WARN" ? "#faad14" : st === "SKIP" ? "#bfbfbf" : null;
}

export interface TrSummary {
  total: number;
  failRate: string;
  failN: number;
  failC: string;
  p95: string;
  p95C: string;
}

export function computeTrSummary(rows: TraceRow[]): TrSummary {
  const allDur = rows.map(durNum).sort((a, b) => a - b);
  const p95 = allDur.length ? allDur[Math.min(allDur.length - 1, Math.ceil(0.95 * allDur.length) - 1)] : 0;
  const failN = rows.filter((t) => t.st === "失败").length;
  return {
    total: rows.length,
    failRate: (failN / rows.length * 100).toFixed(1) + "%",
    failN,
    failC: failN > 0 ? "#ff4d4f" : "#52c41a",
    p95: p95 >= 10 ? p95.toFixed(1) + "s" : p95.toFixed(2) + "s",
    p95C: p95 >= 5 ? "#ff4d4f" : "#52c41a",
  };
}

export interface WaterfallRow {
  sid: string;
  name: string;
  kindLabel: string;
  kindC: string;
  indent: number;
  leftPct: string;
  widthPct: string;
  barC: string;
  barOpacity: string;
  durLabel: string;
  badge: string;
  rowBg: string;
  nameC: string;
  nameFw: number;
  sel: boolean;
}

export function computeWaterfall(spanSet: SpanDef[], selSid: string, spanTotal: number): WaterfallRow[] {
  return spanSet.map((s) => {
    const sc = statusColor(s.status);
    const sel = s.sid === selSid;
    const skip = s.status === "SKIP";
    const wPct = s.dur <= 0 ? 0.6 : Math.max((s.dur / spanTotal) * 100, 1.2);
    return {
      sid: s.sid,
      name: s.name,
      kindLabel: KIND_LABEL[s.kind],
      kindC: KIND_C[s.kind],
      indent: s.pid ? 20 : 0,
      leftPct: ((s.start / spanTotal) * 100).toFixed(2) + "%",
      widthPct: wPct.toFixed(2) + "%",
      barC: sc || KIND_C[s.kind],
      barOpacity: skip ? "0.35" : sel ? "1" : "0.85",
      durLabel: skip ? "未执行" : fmtMs(s.dur),
      badge: s.status === "ERROR" ? "✕" : s.status === "WARN" ? "!" : "",
      rowBg: sel ? "#e6f4ff" : "transparent",
      nameC: sel ? "#1677ff" : sc === "#ff4d4f" ? "#ff4d4f" : "rgba(0,0,0,.85)",
      nameFw: sel ? 600 : s.pid ? 400 : 500,
      sel,
    };
  });
}

export interface AxisTick {
  label: string;
  leftPct: string;
}

export function axisTicksOf(spanTotal: number): AxisTick[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    label: fmtMs(Math.round(spanTotal * f)),
    leftPct: f * 100 + "%",
  }));
}

export interface SpanDetailView {
  title: string;
  kindLabel: string;
  dur: string;
  statusLabel: string;
  stBg: string;
  stC: string;
  stBd: string;
  hasTok: boolean;
  attrTok: string | null;
  hasCost: boolean;
  attrCost: string;
  isErr: boolean;
  errType: string;
  errMsg: string;
  meta: { k: string; v: string }[];
  hasScores: boolean;
  scoresTitle: string;
  scores: (ScoreRow & { rrColor: string; passLabel: string; passBg: string; passC: string; passBd: string })[];
  input: string;
  output: string;
  hasCites: boolean;
  cites: typeof LLM_CITES;
}

export function computeSpanDetail(
  spanSet: SpanDef[],
  detailSet: Record<string, SpanDetailDef>,
  selSid: string,
  setName: SpanSetName,
): SpanDetailView {
  const selSpan = spanSet.find((s) => s.sid === selSid) || spanSet[0];
  const dRaw = detailSet[selSid] || ({} as SpanDetailDef);
  const spanIsErr = selSpan.status === "ERROR";
  const attrTok =
    selSpan.tin != null || selSpan.tout != null
      ? "入 " + (selSpan.tin || 0).toLocaleString() + " · 出 " + (selSpan.tout || 0).toLocaleString()
      : null;
  return {
    title: dRaw.title || selSpan.name,
    kindLabel: KIND_LABEL[selSpan.kind],
    dur: selSpan.status === "SKIP" ? "未执行" : fmtMs(selSpan.dur),
    statusLabel: spanIsErr
      ? "失败"
      : selSpan.status === "WARN"
        ? "告警"
        : selSpan.status === "SKIP"
          ? "跳过"
          : "成功",
    stBg: spanIsErr ? "#fff2f0" : selSpan.status === "WARN" ? "#fffbe6" : "#f6ffed",
    stC: spanIsErr ? "#ff4d4f" : selSpan.status === "WARN" ? "#d48806" : "#52c41a",
    stBd: spanIsErr ? "#ffccc7" : selSpan.status === "WARN" ? "#ffe58f" : "#b7eb8f",
    hasTok: !!attrTok,
    attrTok,
    hasCost: selSpan.cost != null,
    attrCost: selSpan.cost != null ? "¥" + selSpan.cost.toFixed(4) : "",
    isErr: spanIsErr,
    errType: selSpan.errType || "",
    errMsg: selSpan.errMsg || "",
    meta: dRaw.meta || [],
    hasScores: !!dRaw.scores,
    scoresTitle: dRaw.scoresTitle || "",
    scores: (dRaw.scores || []).map((s) => ({
      ...s,
      rrColor: parseFloat(s.rr) >= 0.65 ? "#52c41a" : "#ff4d4f",
      passLabel: s.pass ? "命中" : "已过滤",
      passBg: s.pass ? "#f6ffed" : "#fff2f0",
      passC: s.pass ? "#52c41a" : "#ff4d4f",
      passBd: s.pass ? "#b7eb8f" : "#ffccc7",
    })),
    input: dRaw.input || "—",
    output: dRaw.output || "—",
    hasCites: setName === "ok" && selSid === "llm",
    cites: LLM_CITES,
  };
}

export interface TraceMeta {
  model: string;
  modelVer: string;
  promptVer: string;
  cost: string;
  promptTok: string;
  compTok: string;
  totalTok: string;
  latTotal: string;
}

export function computeTraceMeta(spanSet: SpanDef[], traceSel: TraceRow, spanTotal: number): TraceMeta {
  const sumIn = spanSet.reduce((a, s) => a + (s.tin || 0), 0);
  const sumOut = spanSet.reduce((a, s) => a + (s.tout || 0), 0);
  const sumCost = spanSet.reduce((a, s) => a + (s.cost || 0), 0);
  const setName = traceSel.st === "失败" ? "fail" : traceSel.st === "兜底" ? "fallback" : "ok";
  const promptVer =
    setName === "fallback"
      ? "兜底话术 v3"
      : traceSel.agent === "课程顾问"
        ? "课程推荐生成 v9"
        : "售后回复生成 v12";
  return {
    model: "DeepSeek-V3",
    modelVer: "ver 2026-05-28",
    promptVer,
    cost: "¥" + sumCost.toFixed(4),
    promptTok: sumIn.toLocaleString(),
    compTok: sumOut.toLocaleString(),
    totalTok: (sumIn + sumOut).toLocaleString(),
    latTotal: fmtMs(spanTotal),
  };
}

export function buildTraceJson(traceSel: TraceRow, spanSet: SpanDef[]): string {
  return JSON.stringify(
    {
      traceId: traceSel.id,
      question: traceSel.q,
      agent: traceSel.agent,
      status: traceSel.st,
      spans: spanSet.map((s) => ({
        spanId: s.sid,
        parentSpanId: s.pid,
        name: s.name,
        spanKind: s.kind,
        startOffsetMs: s.start,
        durationMs: s.dur,
        status: { code: s.status, message: s.errMsg || "" },
        attributes: Object.assign(
          {},
          s.tin != null ? { "gen_ai.usage.input_tokens": s.tin, "gen_ai.usage.output_tokens": s.tout } : {},
          s.cost != null ? { "gen_ai.cost.cny": s.cost } : {},
        ),
      })),
    },
    null,
    2,
  );
}
