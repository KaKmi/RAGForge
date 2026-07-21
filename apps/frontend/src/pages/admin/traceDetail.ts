import type { TraceDetailMeta, TraceSpan } from "@codecrush/contracts";

/** M9 W2：Trace 详情纯函数——真实 span → 瀑布/树/面板视图（可单测）。 */

const KIND_MAP: Record<string, { label: string; c: string }> = {
  retrieval: { label: "检索", c: "#13c2c2" },
  embeddings: { label: "向量", c: "#722ed1" },
  rerank: { label: "重排", c: "#faad14" },
  llm: { label: "LLM", c: "#52c41a" },
  chain: { label: "流程", c: "#1677ff" },
  tool: { label: "工具", c: "#8c8c8c" },
};

export const KIND_LEGEND = [
  { label: "检索", c: "#13c2c2" },
  { label: "向量", c: "#722ed1" },
  { label: "重排", c: "#faad14" },
  { label: "LLM", c: "#52c41a" },
  { label: "流程/工具", c: "#1677ff" },
];

export function spanKindColor(kind: string): { label: string; c: string } {
  return KIND_MAP[kind] ?? { label: kind, c: "#8c8c8c" };
}

// RAG 节点 → 中文友好名（span 原始名如 node_runtime.execute_structured / retrieval.retrieve 对用户无意义）。
const NODE_LABEL: Record<string, string> = {
  rewrite: "问题改写",
  intent: "意图识别",
  reply: "大模型生成",
  fallback: "兜底应答",
};
export function spanDisplayName(span: TraceSpan): string {
  const node = (span.attributes as Record<string, unknown>)["rag.node.name"] as string | undefined;
  if (node && NODE_LABEL[node]) return NODE_LABEL[node];
  if (span.kind === "retrieval") return "多路召回";
  if (span.kind === "embeddings") return "向量召回";
  if (span.kind === "rerank") return "重排";
  const n = span.name.toLowerCase();
  if (n.includes("keyword")) return "关键词召回";
  if (n.includes("hits")) return "命中知识";
  return span.name; // 未知 span 保留原名
}

const isErrorCode = (code: string): boolean => code === "Error" || code === "STATUS_CODE_ERROR";

// 属性值都来自 ClickHouse Map(String,String)（全字符串）。
const attrStr = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const attrTruthy = (v: unknown): boolean => v === true || v === "true" || v === 1 || v === "1";
const fmtNum = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
};

// HTTP 自动埋点使 rag.pipeline chain span 挂在 POST server span 下（ParentSpanId≠''），
// 故 RAG 根按 kind='chain' 认，而非 parentSpanId===null（那是 HTTP 传输根）。
export function rootSpanOf(spans: TraceSpan[]): TraceSpan | undefined {
  return spans.find((s) => s.kind === "chain") ?? spans.find((s) => s.parentSpanId === null);
}

/** span 是否在 chain 根的子树内（含 chain 自身）——用于把 HTTP/PG 传输 span 排除出调用链。 */
function inSubtree(span: TraceSpan, rootId: string, byId: Map<string, TraceSpan>): boolean {
  let cur: TraceSpan | undefined = span;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.spanId)) {
    if (cur.spanId === rootId) return true;
    seen.add(cur.spanId);
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
  }
  return false;
}

export function autoSelectSpan(spans: TraceSpan[], sel: string | null): string {
  if (sel && spans.some((s) => s.spanId === sel)) return sel;
  const errs = spans.filter((s) => isErrorCode(s.statusCode));
  // 失败时优先定位到具体报错的子节点（非根）；仅根 Error 时退回根——避免总是选中根 chain span。
  const err = errs.find((s) => s.parentSpanId !== null) ?? errs[0];
  return (err ?? rootSpanOf(spans) ?? spans[0])?.spanId ?? "";
}

/** span 相对 chain 根的层级深度（root 直接子=1，孙节点=2…）。到 rootId 即停，不算 HTTP 祖先。 */
function depthFromRoot(span: TraceSpan, rootId: string, byId: Map<string, TraceSpan>): number {
  let d = 0;
  let cur: TraceSpan | undefined = span;
  const seen = new Set<string>();
  while (cur && cur.spanId !== rootId && cur.parentSpanId && !seen.has(cur.spanId)) {
    seen.add(cur.spanId);
    d += 1;
    cur = byId.get(cur.parentSpanId);
  }
  return d;
}

export interface WfRow {
  sid: string;
  name: string;
  kindLabel: string;
  kindC: string;
  offsetMs: number;
  durationMs: number;
  leftPct: string;
  widthPct: string;
  indent: number;
  isErr: boolean;
  isSkip: boolean;
  isFallback: boolean; // 该节点触发降级兜底（rag.fallback.used）——waterfall 打标 + 顶部置顶
  pctOfTotal: number; // 占 chain 根总时长的百分比（定位瓶颈比纯 ms 直观）
  sel: boolean;
}

const KNOWN_CODES = ["Ok", "Error", "Unset", "STATUS_CODE_OK", "STATUS_CODE_ERROR", "STATUS_CODE_UNSET"];

/** 轴宽 = chain 根 span 的耗时（RAG 一轮总时长，天然覆盖所有子节点），≥1。瀑布行与轴刻度共用。 */
export function traceSpanTotal(spans: TraceSpan[]): number {
  const root = rootSpanOf(spans);
  if (root) return Math.max(root.durationMs, 1);
  return Math.max(...spans.map((s) => s.durationMs), 1);
}

export function buildWaterfall(spans: TraceSpan[], selSid: string): WfRow[] {
  const root = rootSpanOf(spans);
  const t0 = root ? Date.parse(root.startTime) : 0;
  const total = traceSpanTotal(spans);
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  // 行只渲染 chain 子树内的节点（排除 root 自身 = TRACE 头行，且排除 HTTP/PG 传输 span）。
  return spans
    .filter((s) => root != null && s.spanId !== root.spanId && inSubtree(s, root.spanId, byId))
    .map((s) => {
      const offsetMs = Date.parse(s.startTime) - t0;
      // 显示缩进 = 相对 chain 根深度 − 1（root 直接子 = 0，孙节点 = 20，对齐原型层级）。
      const indent = Math.max(0, depthFromRoot(s, root!.spanId, byId) - 1) * 24;
      const isErr = isErrorCode(s.statusCode);
      return {
        sid: s.spanId,
        name: spanDisplayName(s),
        kindLabel: spanKindColor(s.kind).label,
        kindC: spanKindColor(s.kind).c,
        offsetMs,
        durationMs: s.durationMs,
        leftPct: ((offsetMs / total) * 100).toFixed(2) + "%",
        widthPct: Math.max((s.durationMs / total) * 100, 1.2).toFixed(2) + "%",
        indent,
        isErr,
        isSkip: !KNOWN_CODES.includes(s.statusCode),
        isFallback: !isErr && attrTruthy((s.attributes as Record<string, unknown>)["rag.fallback.used"]),
        pctOfTotal: Math.round((s.durationMs / total) * 100),
        sel: s.spanId === selSid,
      };
    });
}

/** 面板一行键值；tone 给告警类（降级/校验失败/修复重试）着色。 */
export interface MetaRow {
  k: string;
  v: string;
  tone?: "warn" | "err";
}

/**
 * 批 A：按 span kind 从属性铺「有料」的面板行——数据早已在 span，只是之前没铺到面板。
 * LLM 出 模型/协议/输出模式/修复重试/校验错误码/降级；检索出 topK/阈值/融合权重/rerank阈值/多路；
 * 向量·重排出各自模型。缺失的键自动跳过（push 只收非空值）。
 */
export function buildSpanMeta(span: TraceSpan): MetaRow[] {
  const a = span.attributes as Record<string, unknown>;
  const rows: MetaRow[] = [];
  const push = (k: string, v: string | null, tone?: MetaRow["tone"]): void => {
    if (v != null) rows.push(tone ? { k, v, tone } : { k, v });
  };

  if (span.kind === "llm") {
    push("模型", attrStr(a["gen_ai.request.model"]));
    push("协议", attrStr(a["gen_ai.system"]));
    push("输出模式", attrStr(a["rag.structured_output.mode"]));
    const retry = fmtNum(a["rag.repair.retry_count"]);
    if (retry != null && Number(retry) > 0) push("修复重试", `${retry} 次`, "warn");
    push("校验错误码", attrStr(a["rag.validation.error_code"]), "err");
    if (attrTruthy(a["rag.fallback.used"])) push("降级", "已降级兜底", "warn");
  } else if (span.kind === "retrieval") {
    push("Top K", fmtNum(a["rag.retrieval.top_k"]));
    push("Top N", fmtNum(a["rag.retrieval.top_n"]));
    push("召回阈值", fmtNum(a["rag.retrieval.threshold"]));
    const vw = fmtNum(a["rag.retrieval.vec_weight"]);
    if (vw != null) push("融合权重", `向量 ${vw} · 关键词 ${Number((1 - Number(vw)).toFixed(3))}`);
    push("Rerank 阈值", fmtNum(a["rag.rerank.threshold"]));
    if (a["rag.multi"] != null) push("多路召回", attrTruthy(a["rag.multi"]) ? "是" : "否");
  } else if (span.kind === "embeddings") {
    push("向量模型", attrStr(a["gen_ai.request.model"]));
  } else if (span.kind === "rerank") {
    push("重排模型", attrStr(a["gen_ai.request.model"]));
    push("Rerank 阈值", fmtNum(a["rag.rerank.threshold"]));
  } else {
    push("模型", attrStr(a["gen_ai.request.model"]));
    push("节点", attrStr(a["rag.node.name"]));
    if (span.kind === "chain" && attrTruthy(a["rag.fallback.used"])) push("降级", "本轮触发兜底", "warn");
  }
  return rows;
}

/** NodeContract 校验链的一步（结构化输出→校验→修复→降级）。 */
export interface ContractStep {
  label: string;
  status: "ok" | "warn" | "err";
  detail?: string;
}
/**
 * 我们独有（原型没有）：把 LLM 节点的「结构化输出失败→修复→仍失败→降级」画成一条状态链，
 * 排查「这条回答为什么是兜底」一眼看到根因。数据全在 span：
 * rag.validation.error_code（首次校验失败码）/ rag.repair.retry_count / rag.fallback.used。
 * 非结构化节点（三信号皆无且无 structured_output.mode）返回空——面板不渲染。
 */
export function buildContractChain(span: TraceSpan): ContractStep[] {
  if (span.kind !== "llm") return [];
  const a = span.attributes as Record<string, unknown>;
  const errCode = attrStr(a["rag.validation.error_code"]);
  const retry = Number(fmtNum(a["rag.repair.retry_count"]) ?? "0");
  const fellBack = attrTruthy(a["rag.fallback.used"]);
  const failedFirst = errCode != null || retry > 0;
  if (!failedFirst && !fellBack && a["rag.structured_output.mode"] == null) return [];

  const steps: ContractStep[] = [{ label: "结构化输出", status: "ok" }];
  if (failedFirst) {
    steps.push({ label: "首次校验", status: "err", detail: errCode ?? undefined });
    if (retry > 0) steps.push({ label: `修复 ${retry} 次`, status: fellBack ? "err" : "warn" });
  }
  steps.push(fellBack ? { label: "降级兜底", status: "err" } : failedFirst ? { label: "修复通过", status: "ok" } : { label: "校验通过", status: "ok" });
  return steps;
}

/** Trace 级异常/降级汇总（顶部置顶红条：不用逐个点节点就知道哪步出问题）。 */
export interface TraceAlert {
  sid: string;
  name: string;
  tone: "err" | "warn";
  msg: string;
}
export function traceAlerts(spans: TraceSpan[]): TraceAlert[] {
  const root = rootSpanOf(spans);
  if (!root) return [];
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const out: TraceAlert[] = [];
  for (const s of spans) {
    if (!inSubtree(s, root.spanId, byId)) continue; // 只看调用链内节点，排除 HTTP/PG 传输 span
    if (isErrorCode(s.statusCode)) {
      out.push({ sid: s.spanId, name: spanDisplayName(s), tone: "err", msg: s.statusMessage ?? "节点报错" });
    } else if (attrTruthy((s.attributes as Record<string, unknown>)["rag.fallback.used"])) {
      out.push({ sid: s.spanId, name: spanDisplayName(s), tone: "warn", msg: "触发降级兜底" });
    }
  }
  return out;
}

export interface ScoreRow {
  doc: string;
  vec: number | null;
  kw: number | null;
  rr: number | null;
  final: number;
  pass: boolean;
}
export interface CiteRow {
  n: number;
  doc: string;
  score: number;
}
export interface SpanDetailView {
  title: string;
  kindLabel: string;
  statusLabel: string;
  isErr: boolean;
  errType: string;
  errMsg: string;
  meta: MetaRow[];
  scores: ScoreRow[];
  cites: CiteRow[];
  isRoot: boolean;
  input: string | null;
  output: string | null;
  tokens: string | null;
  model: string | null;
  durationMs: number;
  durationPct: number; // 占 chain 根总时长的百分比（面板显示「占总时长 X%」）
  contractChain: ContractStep[];
  routing: { intent: string; kbNames: string[] } | null; // #2 意图→KB 路由（仅 intent 节点有 rag.intent）
  /**
   * rewrite 节点产出的**可独立检索**的问题（`rag.rewrite.query`）。
   *
   * 它一直埋着，但此前没人提取——于是「问题改写」节点在面板上显示
   * 「该节点无独立输入/输出记录」，而它其实是这条链路里最该看的一个输出：
   * 下游检索用的就是它，不是用户原话。
   */
  rewrittenQuery: string | null;
}

/**
 * 从整条 trace 里取 rewrite 节点的产出。
 *
 * 除了面板展示，「加入问题池」也要它——`manual_trace` 入池的样本必须带上改写结果，
 * 否则会被误标「指代未消解」，并让聚类键退回原文（021 决策 F）。
 * 后端读不了 trace（`gaps → traces` 是禁止的边，021 决策 B 规定走前端组合），
 * 所以只能由这一屏透传。
 */
export function rewrittenQueryOf(spans: TraceSpan[]): string | null {
  for (const s of spans) {
    const v = attrStr((s.attributes as Record<string, unknown>)["rag.rewrite.query"]);
    if (v != null && v.trim() !== "") return v.trim();
  }
  return null;
}

function parseJsonArray<T>(v: unknown): T[] {
  try {
    return typeof v === "string" ? (JSON.parse(v) as T[]) : [];
  } catch {
    return [];
  }
}

export function buildSpanDetail(span: TraceSpan, root: TraceSpan): SpanDetailView {
  const a = span.attributes as Record<string, unknown>;
  const isRoot = span.spanId === root.spanId;
  const rawScores = parseJsonArray<{
    doc?: string;
    chunkId: string;
    vec: number | null;
    kw: number | null;
    rerank: number | null;
    final: number;
  }>(a["rag.chunk.scores"]);
  const threshold = Number(a["rag.rerank.threshold"] ?? 0.65);
  const scores: ScoreRow[] = rawScores.map((s) => {
    const rr = s.rerank ?? null;
    return {
      doc: s.doc ?? s.chunkId,
      vec: s.vec ?? null,
      kw: s.kw ?? null,
      rr,
      final: s.final,
      pass: (rr ?? s.final) >= threshold,
    };
  });
  const cites: CiteRow[] = isRoot ? parseJsonArray<CiteRow>(a["rag.citation.ids"]) : [];
  const tin = a["gen_ai.usage.input_tokens"];
  const tout = a["gen_ai.usage.output_tokens"];
  const isErr = isErrorCode(span.statusCode);
  const model = (a["gen_ai.request.model"] as string) ?? null;
  const intentVal = attrStr(a["rag.intent"]);
  const routing = intentVal != null ? { intent: intentVal, kbNames: parseJsonArray<string>(a["rag.route.kb_names"]) } : null;
  return {
    title: spanDisplayName(span),
    kindLabel: spanKindColor(span.kind).label,
    statusLabel: isErr ? "失败" : span.statusCode === "Unset" ? "跳过" : "成功",
    isErr,
    errType: isErr ? (span.statusMessage ? "错误" : "Error") : "",
    errMsg: span.statusMessage ?? "该节点报错（无详细信息）",
    meta: buildSpanMeta(span),
    scores,
    cites,
    isRoot,
    input: isRoot ? String(a["codecrush.io.input"] ?? "") : null,
    output: isRoot ? String(a["codecrush.io.output"] ?? "") : null,
    tokens: tin != null || tout != null ? `入 ${Number(tin ?? 0)} · 出 ${Number(tout ?? 0)}` : null,
    model,
    durationMs: span.durationMs,
    durationPct: Math.round((span.durationMs / Math.max(root.durationMs, 1)) * 100),
    contractChain: buildContractChain(span),
    routing,
    // 只在**产出它的那个节点**上显示，不要挂到整条链的每个 span 上。
    rewrittenQuery: attrStr(a["rag.rewrite.query"]),
  };
}

export function buildOtlpJson(traceId: string, meta: TraceDetailMeta, spans: TraceSpan[]): string {
  const root = rootSpanOf(spans);
  const t0 = root ? Date.parse(root.startTime) : 0;
  return JSON.stringify(
    {
      traceId,
      meta,
      spans: spans.map((s) => ({
        spanId: s.spanId,
        parentSpanId: s.parentSpanId,
        name: s.name,
        spanKind: s.kind,
        startOffsetMs: Date.parse(s.startTime) - t0,
        durationMs: s.durationMs,
        status: { code: s.statusCode, message: s.statusMessage ?? "" },
        attributes: s.attributes,
      })),
    },
    null,
    2,
  );
}
