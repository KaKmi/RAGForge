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

const isErrorCode = (code: string): boolean => code === "Error" || code === "STATUS_CODE_ERROR";

export function rootSpanOf(spans: TraceSpan[]): TraceSpan | undefined {
  return (
    spans.find((s) => s.parentSpanId === null && s.kind === "chain") ??
    spans.find((s) => s.parentSpanId === null)
  );
}

export function autoSelectSpan(spans: TraceSpan[], sel: string | null): string {
  if (sel && spans.some((s) => s.spanId === sel)) return sel;
  const errs = spans.filter((s) => isErrorCode(s.statusCode));
  // 失败时优先定位到具体报错的子节点（非根）；仅根 Error 时退回根——避免总是选中根 chain span。
  const err = errs.find((s) => s.parentSpanId !== null) ?? errs[0];
  return (err ?? rootSpanOf(spans) ?? spans[0])?.spanId ?? "";
}

/** span 相对 root 的层级深度（root=0，root 的直接子节点=1，孙节点=2…）。 */
function depthFromRoot(span: TraceSpan, byId: Map<string, TraceSpan>): number {
  let d = 0;
  let cur: TraceSpan | undefined = span;
  const seen = new Set<string>();
  while (cur?.parentSpanId && !seen.has(cur.spanId)) {
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
  sel: boolean;
}

const KNOWN_CODES = ["Ok", "Error", "Unset", "STATUS_CODE_OK", "STATUS_CODE_ERROR", "STATUS_CODE_UNSET"];

/** 轴宽 = 相对 root 起点的最大结束偏移（含 root，≥1）。瀑布行与轴刻度共用，避免两处各算一遍。 */
export function traceSpanTotal(spans: TraceSpan[]): number {
  const root = rootSpanOf(spans);
  const t0 = root ? Date.parse(root.startTime) : 0;
  return Math.max(...spans.map((s) => Date.parse(s.startTime) - t0 + s.durationMs), 1);
}

export function buildWaterfall(spans: TraceSpan[], selSid: string): WfRow[] {
  const root = rootSpanOf(spans);
  const t0 = root ? Date.parse(root.startTime) : 0;
  // total 用全部 span（含 root）算轴宽；行只渲染非 root 节点（root 单独作 TRACE 头行，避免重复）。
  const total = traceSpanTotal(spans);
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  return spans
    .filter((s) => s.spanId !== root?.spanId)
    .map((s) => {
      const offsetMs = Date.parse(s.startTime) - t0;
      // 显示缩进 = 相对 root 深度 − 1（root 直接子 = 0，孙节点 = 20，对齐原型层级）。
      const indent = Math.max(0, depthFromRoot(s, byId) - 1) * 20;
      return {
        sid: s.spanId,
        name: s.name,
        kindLabel: spanKindColor(s.kind).label,
        kindC: spanKindColor(s.kind).c,
        offsetMs,
        durationMs: s.durationMs,
        leftPct: ((offsetMs / total) * 100).toFixed(2) + "%",
        widthPct: Math.max((s.durationMs / total) * 100, 1.2).toFixed(2) + "%",
        indent,
        isErr: isErrorCode(s.statusCode),
        isSkip: !KNOWN_CODES.includes(s.statusCode),
        sel: s.spanId === selSid,
      };
    });
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
  meta: { k: string; v: string }[];
  scores: ScoreRow[];
  cites: CiteRow[];
  isRoot: boolean;
  input: string | null;
  output: string | null;
  tokens: string | null;
  model: string | null;
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
  return {
    title: span.name,
    kindLabel: spanKindColor(span.kind).label,
    statusLabel: isErr ? "失败" : span.statusCode === "Unset" ? "跳过" : "成功",
    isErr,
    errType: isErr ? (span.statusMessage ? "错误" : "Error") : "",
    errMsg: span.statusMessage ?? "该节点报错（无详细信息）",
    meta: [
      { k: "模型", v: model },
      { k: "节点", v: a["rag.node.name"] as string | null },
    ].filter((m): m is { k: string; v: string } => !!m.v),
    scores,
    cites,
    isRoot,
    input: isRoot ? String(a["codecrush.io.input"] ?? "") : null,
    output: isRoot ? String(a["codecrush.io.output"] ?? "") : null,
    tokens: tin != null || tout != null ? `入 ${Number(tin ?? 0)} · 出 ${Number(tout ?? 0)}` : null,
    model,
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
