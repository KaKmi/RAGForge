import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, DatePicker, Input, message, Pagination, Segmented, Spin, Tag } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import type {
  Application,
  QualitySignal,
  SessionListRow,
  TraceListResponse,
  TraceListRow,
  TraceStatus,
  MetricsStageKey,
  TraceListQuery,
} from "@codecrush/contracts";
import { downloadTraceCandidates, getApplications, getTraces, getTraceSessions } from "../../api/client";
import dayjs from "dayjs";

/** Trace 追踪：Trace/Session 双列表接真实读模型（ClickHouse VIEW）。M9 W1。 */

const STATUSES = ["全部", "成功", "兜底", "失败"] as const;
const QUICKS = ["全部", "失败", "慢请求", "低分召回"] as const;
const RANGES = ["今日", "近 7 日", "近 30 日"] as const;
const STAGES: MetricsStageKey[] = ["rewrite", "intent", "embedding", "retrieval", "rerank", "generation"];
type SignalFilter = NonNullable<TraceListQuery["signal"]>;
const SIGNALS: SignalFilter[] = [
  "repair", "keyword_degraded", "rerank_degraded",
  "confidence_very_low", "confidence_low", "confidence_medium", "confidence_high",
  "citations_none", "citations_one", "citations_two_three", "citations_four_plus",
  "coverage_full", "coverage_partial",
];
const SIGNAL_FILTER_LABELS: Record<SignalFilter, string> = {
  repair: "发生结构化修复", keyword_degraded: "关键词召回降级", rerank_degraded: "Rerank 降级",
  confidence_very_low: "可信度很低", confidence_low: "可信度低", confidence_medium: "可信度中",
  confidence_high: "可信度高", citations_none: "无引用", citations_one: "1 条引用",
  citations_two_three: "2–3 条引用", citations_four_plus: "4+ 条引用",
  coverage_full: "引用覆盖完整", coverage_partial: "引用覆盖部分",
};
const STAGE_LABELS: Record<MetricsStageKey, string> = {
  rewrite: "问题改写", intent: "意图识别", embedding: "向量化",
  retrieval: "检索总段", rerank: "重排", generation: "回复生成",
};
type StatusFilter = (typeof STATUSES)[number];
type QuickFilter = (typeof QUICKS)[number];
type RangeFilter = (typeof RANGES)[number];
type EvalMetricFilter = NonNullable<TraceListQuery["evalMetric"]>;
const EVAL_METRICS: EvalMetricFilter[] = ["faithfulness", "relevancy", "precision"];
const EVAL_LABEL: Record<EvalMetricFilter, string> = {
  faithfulness: "事实一致性",
  relevancy: "答案相关性",
  precision: "上下文精度",
};

// 响应英文 token → 中文 tag（列表状态列）
const TRACE_TAG: Record<TraceStatus, { label: string; bg: string; c: string; bd: string }> = {
  success: { label: "成功", bg: "#f6ffed", c: "#52c41a", bd: "#b7eb8f" },
  fallback: { label: "兜底", bg: "#fffbe6", c: "#d48806", bd: "#ffe58f" },
  failed: { label: "失败", bg: "#fff2f0", c: "#ff4d4f", bd: "#ffccc7" },
};
const SESSION_TAG: Record<SessionListRow["status"], { label: string; bg: string; c: string; bd: string }> = {
  normal: { label: "正常", bg: "#f6ffed", c: "#52c41a", bd: "#b7eb8f" },
  has_fallback: { label: "含兜底", bg: "#fffbe6", c: "#d48806", bd: "#ffe58f" },
  has_failure: { label: "含失败", bg: "#fff2f0", c: "#ff4d4f", bd: "#ffccc7" },
};
const SIGNAL_LABEL: Record<QualitySignal, string> = {
  low_recall: "低分召回",
  no_citations: "无引用",
  refusal: "拒答",
  timeout: "超时",
};

/** ISO → HH:MM:SS */
function hhmmss(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
/** 时间范围 → from ISO（to 用 now，留空即可） */
function rangeFrom(range: RangeFilter): string | undefined {
  const now = new Date();
  if (range === "今日") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const days = range === "近 7 日" ? 7 : 30;
  return new Date(now.getTime() - days * 86400_000).toISOString();
}

export default function TracesPage() {
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialStatus = searchParams.get("status");
  const initialQuick = searchParams.get("quick");
  const [tab, setTab] = useState<"trace" | "session">("trace");
  const [query, setQuery] = useState("");
  const [agentId, setAgentId] = useState(searchParams.get("agentId") ?? ""); // ""=全部
  const [status, setStatus] = useState<StatusFilter>(
    STATUSES.includes(initialStatus as StatusFilter) ? (initialStatus as StatusFilter) : "全部",
  );
  const [quick, setQuick] = useState<QuickFilter>(
    QUICKS.includes(initialQuick as QuickFilter) ? (initialQuick as QuickFilter) : "全部",
  );
  const initialStage = searchParams.get("stage");
  const [stage, setStage] = useState<MetricsStageKey | undefined>(
    STAGES.includes(initialStage as MetricsStageKey) ? (initialStage as MetricsStageKey) : undefined,
  );
  const initialSignal = searchParams.get("signal");
  const [signal, setSignal] = useState<SignalFilter | undefined>(
    SIGNALS.includes(initialSignal as SignalFilter) ? (initialSignal as SignalFilter) : undefined,
  );
  const [model, setModel] = useState(searchParams.get("model") ?? "");
  const rawEvalMetric = searchParams.get("evalMetric");
  const evalMetric = EVAL_METRICS.includes(rawEvalMetric as EvalMetricFilter)
    ? (rawEvalMetric as EvalMetricFilter)
    : undefined;
  const rawEvalMax = searchParams.get("evalMax");
  const evalMax = rawEvalMax !== null && /^\d+$/.test(rawEvalMax) ? Number(rawEvalMax) : undefined;
  const evalSort = searchParams.get("evalSort") === "desc" ? "desc" : evalMetric ? "asc" : undefined;
  const evalVerdict = searchParams.get("evalVerdict") === "low" ? "low" : undefined;
  const [range, setRange] = useState<RangeFilter>("今日");
  const [urlRange, setUrlRange] = useState({
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  });
  const didMountSearchSync = useRef(false);

  useEffect(() => {
    if (!didMountSearchSync.current) {
      didMountSearchSync.current = true;
      return;
    }
    const nextStatus = searchParams.get("status");
    const nextQuick = searchParams.get("quick");
    const nextStage = searchParams.get("stage");
    const nextSignal = searchParams.get("signal");
    setAgentId(searchParams.get("agentId") ?? "");
    setStatus(STATUSES.includes(nextStatus as StatusFilter) ? (nextStatus as StatusFilter) : "全部");
    setQuick(QUICKS.includes(nextQuick as QuickFilter) ? (nextQuick as QuickFilter) : "全部");
    setStage(STAGES.includes(nextStage as MetricsStageKey) ? (nextStage as MetricsStageKey) : undefined);
    setSignal(SIGNALS.includes(nextSignal as SignalFilter) ? (nextSignal as SignalFilter) : undefined);
    setModel(searchParams.get("model") ?? "");
    setUrlRange({ from: searchParams.get("from") ?? undefined, to: searchParams.get("to") ?? undefined });
  }, [searchParams]);

  const [apps, setApps] = useState<Application[]>([]);
  const [data, setData] = useState<TraceListResponse | null>(null);
  const [tracePage, setTracePage] = useState(1);
  const [sessions, setSessions] = useState<SessionListRow[] | null>(null);
  const [sessionIdSearch, setSessionIdSearch] = useState("");
  const [sessionUserSearch, setSessionUserSearch] = useState("");
  const [sessionAppSearch, setSessionAppSearch] = useState("");
  const [sessionQuestionSearch, setSessionQuestionSearch] = useState("");
  const [sessionDate, setSessionDate] = useState<dayjs.Dayjs | null>(null);
  const [sessionPage, setSessionPage] = useState(1);
  const [loading, setLoading] = useState(true);

  // Agent 下拉（id→name）——一次性加载
  useEffect(() => {
    getApplications()
      .then(setApps)
      .catch(() => {
        /* 下拉降级为仅「全部」，不阻塞列表 */
      });
  }, []);

  // Trace 列表：筛选变更即重拉（summary 须反映筛选集，走后端）
  useEffect(() => {
    if (tab !== "trace") return;
    let live = true;
    setLoading(true);
    getTraces({
      q: query || undefined,
      agentId: agentId || undefined,
      status,
      quick,
      stage,
      signal,
      model: model || undefined,
      evalMetric,
      evalMax,
      evalSort,
      evalVerdict,
      from: urlRange.from ?? rangeFrom(range),
      to: urlRange.to,
      page: tracePage,
      pageSize: 20,
    })
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e: unknown) => {
        if (live) message.error(e instanceof Error ? e.message : "加载 Trace 失败");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [tab, query, agentId, status, quick, stage, signal, model, evalMetric, evalMax, evalSort, evalVerdict, range, urlRange, tracePage]);

  // Session 列表
  useEffect(() => {
    if (tab !== "session") return;
    let live = true;
    setLoading(true);
    getTraceSessions()
      .then((r) => {
        if (live) setSessions(r);
      })
      .catch((e: unknown) => {
        if (live) message.error(e instanceof Error ? e.message : "加载 Session 失败");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [tab]);

  const summary = data?.summary;
  const failColor = summary && summary.failCount > 0 ? "#ff4d4f" : "#52c41a";
  const p95s = summary ? summary.p95Ms / 1000 : 0;
  const p95Label = summary ? (p95s >= 10 ? p95s.toFixed(1) : p95s.toFixed(2)) + "s" : "—";
  const p95Color = summary && summary.p95Ms >= 5000 ? "#ff4d4f" : "#52c41a";

  const hasFilter = query !== "" || agentId !== "" || status !== "全部" || quick !== "全部" || stage !== undefined || signal !== undefined || model !== "" || evalMetric !== undefined || evalVerdict !== undefined || urlRange.from !== undefined || urlRange.to !== undefined;
  const reset = () => {
    setTracePage(1);
    setQuery("");
    setAgentId("");
    setStatus("全部");
    setQuick("全部");
    setStage(undefined);
    setSignal(undefined);
    setModel("");
    setUrlRange({ from: undefined, to: undefined });
    setSearchParams({});
  };

  const updateQualityParam = (key: string, value?: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "evalMetric" && !value) {
      next.delete("evalMax");
      next.delete("evalSort");
    }
    setTracePage(1);
    setSearchParams(next);
  };

  const effectiveFrom = urlRange.from ?? rangeFrom(range);

  const agentOptions = useMemo(() => [{ id: "", name: "全部" }, ...apps.map((a) => ({ id: a.id, name: a.name }))], [apps]);

  const chip = (on: boolean): CSSProperties => ({
    height: 28,
    padding: "0 10px",
    lineHeight: "26px",
    borderRadius: 6,
    border: `1px solid ${on ? "#1677ff" : "#d9d9d9"}`,
    background: on ? "#e6f4ff" : "#fff",
    color: on ? "#1677ff" : "rgba(0,0,0,.65)",
    fontSize: 12,
    cursor: "pointer",
    userSelect: "none",
  });
  const quickChip = (on: boolean): CSSProperties => ({ ...chip(on), borderRadius: 14, padding: "0 12px" });

  const traceCount = data?.items.length ?? 0;
  const filteredSessions = (sessions ?? []).filter((s) => {
    const contains = (value: string | null | undefined, term: string) => !term || (value ?? "").toLowerCase().includes(term.toLowerCase());
    return contains(s.sessionId, sessionIdSearch) && contains(s.userId, sessionUserSearch) && contains(s.agentName, sessionAppSearch)
      && contains(s.firstQuestion, sessionQuestionSearch) && (!sessionDate || dayjs(s.firstTs).isSame(sessionDate, "day"));
  });
  const sessionPageSize = 8;
  const visibleSessions = filteredSessions.slice((sessionPage - 1) * sessionPageSize, sessionPage * sessionPageSize);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Trace 追踪</div>
        <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>
          {tab === "trace" ? `共 ${traceCount} 条 · 点击行查看调用链路` : `共 ${sessions?.length ?? 0} 个会话`}
        </div>
      </div>

      {/* Trace / Session 分段控件（antd Segmented，样式还原原型 pill） */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <Segmented
          value={tab}
          onChange={(v) => { setTab(v as "trace" | "session"); setTracePage(1); }}
          size="large"
          className="trace-view-switcher"
          options={[
            { label: "Trace 追踪", value: "trace" },
            { label: "Session 会话", value: "session" },
          ]}
        />
        {tab === "trace" && <Button icon={<DownloadOutlined />} onClick={() => downloadTraceCandidates({ q: query || undefined, agentId: agentId || undefined, status, quick, stage, signal, model: model || undefined, from: effectiveFrom, to: urlRange.to, page: tracePage, pageSize: 20 }).catch((error: unknown) => message.error(error instanceof Error ? error.message : "导出失败"))}>导出当前结果 CSV</Button>}
      </div>

      {tab === "trace" && (
        <>
          {stage && (
            <div style={{ marginBottom: 12, padding: "9px 12px", border: "1px solid #bae0ff", borderRadius: 8, background: "#f0f8ff", color: "#0958d9", fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ color: "#64748b" }}>当前筛选：</span><Tag color="blue" closable onClose={() => setStage(undefined)}>阶段筛选：{STAGE_LABELS[stage]}</Tag>
            </div>
          )}
          {(signal || model) && (
            <div style={{ marginBottom: 12, padding: "9px 12px", border: "1px solid #d9f7be", borderRadius: 8, background: "#f6ffed", color: "#237804", fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ color: "#64748b" }}>当前筛选：</span>
              {signal && <Tag color="green" closable onClose={() => setSignal(undefined)}>信号筛选：{SIGNAL_FILTER_LABELS[signal]}</Tag>}
              {model && <Tag color="green" closable onClose={() => setModel("")}>模型：{model}</Tag>}
            </div>
          )}
          <div style={{ display: "none" }}>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => downloadTraceCandidates({
                q: query || undefined, agentId: agentId || undefined, status, quick, stage, signal,
                model: model || undefined, from: effectiveFrom, to: urlRange.to, page: 1, pageSize: 50,
              }).catch((error: unknown) => message.error(error instanceof Error ? error.message : "导出失败"))}
            >导出当前候选样本 CSV</Button>
          </div>
          <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1, background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "14px 18px" }}>
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>采样 Trace 数</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{summary?.sampledTotal ?? "—"}</div>
            </div>
            <div style={{ flex: 1, background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "14px 18px" }}>
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>失败率</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: failColor }}>
                {summary ? (summary.failRate * 100).toFixed(1) + "%" : "—"}
              </div>
              <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)", marginTop: 2 }}>{summary?.failCount ?? 0} 条失败</div>
            </div>
            <div style={{ flex: 1, background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "14px 18px" }}>
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>P95 耗时</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: p95Color }}>{p95Label}</div>
              <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)", marginTop: 2 }}>含超时熔断请求</div>
            </div>
            <div style={{ flex: 1.4, background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "12px 18px" }}>
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 8 }}>快捷排查</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {QUICKS.map((k) => (
                  <div key={k} onClick={() => setQuick(k)} style={quickChip(quick === k)}>
                    {k}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              border: "1px solid #f0f0f0",
              borderRadius: 8,
              padding: "14px 16px",
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索问题 / Trace ID"
              style={{ width: 220, height: 32, padding: "0 12px", border: "1px solid #d9d9d9", borderRadius: 6, fontSize: 13, outline: "none" }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>Agent</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {agentOptions.map((a) => (
                  <div key={a.id || "all"} onClick={() => setAgentId(a.id)} style={chip(agentId === a.id)}>
                    {a.name}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>状态</span>
              <div style={{ display: "flex", gap: 6 }}>
                {STATUSES.map((s) => (
                  <div key={s} onClick={() => setStatus(s)} style={chip(status === s)}>
                    {s}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ display: "flex", border: "1px solid #d9d9d9", borderRadius: 6, overflow: "hidden" }}>
              {RANGES.map((r, i) => (
                <div
                  key={r}
                  onClick={() => {
                    setUrlRange({ from: undefined, to: undefined });
                    setRange(r);
                  }}
                  style={{
                    height: 30,
                    padding: "0 12px",
                    lineHeight: "30px",
                    fontSize: 12,
                    cursor: "pointer",
                    background: r === range ? "#1677ff" : "#fff",
                    color: r === range ? "#fff" : "rgba(0,0,0,.65)",
                    borderLeft: i === 0 ? "none" : "1px solid #d9d9d9",
                  }}
                >
                  {r}
                </div>
              ))}
            </div>
            {hasFilter && (
              <div onClick={reset} style={{ fontSize: 12, color: "#1677ff", cursor: "pointer" }}>
                重置
              </div>
            )}
          </div>

          <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #f0f0f0" }}>
              <select
                aria-label="评测指标"
                value={evalMetric ?? ""}
                onChange={(event) => updateQualityParam("evalMetric", event.target.value || undefined)}
                style={{ height: 30, border: "1px solid #d9d9d9", borderRadius: 6, padding: "0 8px" }}
              >
                <option value="">全部评测指标</option>
                {EVAL_METRICS.map((metric) => <option key={metric} value={metric}>{EVAL_LABEL[metric]}</option>)}
              </select>
              <input
                aria-label="最高分"
                type="number"
                min={0}
                max={100}
                value={evalMax ?? ""}
                disabled={!evalMetric}
                placeholder="最高分"
                onChange={(event) => updateQualityParam("evalMax", event.target.value || undefined)}
                style={{ width: 90, height: 28, border: "1px solid #d9d9d9", borderRadius: 6, padding: "0 8px" }}
              />
              <button
                type="button"
                onClick={() => updateQualityParam("evalVerdict", evalVerdict ? undefined : "low")}
                style={chip(evalVerdict === "low")}
              >
                仅看低分
              </button>
              {evalMetric && (
                <button
                  type="button"
                  aria-label={`${EVAL_LABEL[evalMetric]}：${evalSort === "desc" ? "降序" : "升序"}`}
                  onClick={() => updateQualityParam("evalSort", evalSort === "desc" ? "asc" : "desc")}
                  style={chip(true)}
                >
                  {evalSort === "desc" ? "高分优先" : "低分优先"}
                </button>
              )}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "150px 80px 1fr 100px 75px 85px 70px 110px",
                padding: "12px 16px",
                background: "#fafafa",
                borderBottom: "1px solid #f0f0f0",
                fontSize: 13,
                fontWeight: 600,
                color: "rgba(0,0,0,.65)",
              }}
            >
              <div>Trace ID</div>
              <div>时间</div>
              <div>用户问题</div>
              <div>Agent</div>
              <div>状态</div>
              <div>总耗时</div>
              <div>Tokens</div>
              <div>答案质量</div>
            </div>
            {loading ? (
              <div style={{ padding: 48, textAlign: "center" }}>
                <Spin />
              </div>
            ) : (
              <>
                {(data?.items ?? []).map((r: TraceListRow) => {
                  const t = TRACE_TAG[r.status];
                  return (
                    <div
                      key={r.traceId}
                      onClick={() => nav(`/admin/traces/${r.traceId}`)}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "150px 80px 1fr 100px 75px 85px 70px 110px",
                        padding: "12px 16px",
                        borderBottom: "1px solid #f0f0f0",
                        fontSize: 13,
                        alignItems: "center",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "#1677ff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {r.traceId}
                      </div>
                      <div style={{ color: "rgba(0,0,0,.45)" }}>{hhmmss(r.startTime)}</div>
                      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{r.userInput}</span>
                        {r.qualitySignals.length > 0 && (
                          <span style={{ display: "inline-flex", gap: 4, flex: "none" }}>
                            {r.qualitySignals.map((s) => (
                              <span
                                key={s}
                                style={{
                                  fontSize: 10,
                                  lineHeight: "16px",
                                  padding: "0 5px",
                                  borderRadius: 3,
                                  background: "#fff7e6",
                                  color: "#d46b08",
                                  border: "1px solid #ffd591",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {SIGNAL_LABEL[s]}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                      <div style={{ color: "rgba(0,0,0,.65)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.agentName}</div>
                      <div>
                        <span style={{ fontSize: 12, lineHeight: "20px", padding: "0 8px", borderRadius: 4, background: t.bg, color: t.c, border: `1px solid ${t.bd}` }}>
                          {t.label}
                        </span>
                      </div>
                      <div>{(r.durationMs / 1000).toFixed(2)}s</div>
                      <div style={{ color: "rgba(0,0,0,.45)" }}>{(r.inputTokens + r.outputTokens).toLocaleString()}</div>
                      <div>
                        {r.evaluation?.status === "scored" ? (
                          <span style={{ color: r.evaluation.minScore < 70 ? "#cf1322" : "#1677ff", fontWeight: 600 }}>
                            {r.evaluation.minScore} · {r.evaluation.judgeVersion}
                          </span>
                        ) : (
                          <span style={{ color: "rgba(0,0,0,.3)" }}>—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
                {(data?.items.length ?? 0) === 0 && (
                  <div style={{ padding: 48, textAlign: "center", color: "rgba(0,0,0,.3)", fontSize: 13 }}>没有符合条件的 Trace</div>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end", padding: "14px 16px" }}><Pagination current={tracePage} pageSize={20} total={data?.total ?? 0} showSizeChanger={false} showTotal={(total) => `共 ${total} 条`} onChange={setTracePage} /></div>
              </>
            )}
          </div>
        </>
      )}

      {tab === "session" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, marginBottom: 12, padding: 14, background: "#fff", border: "1px solid #e8edf3", borderRadius: 10 }}>
            <Input allowClear value={sessionIdSearch} onChange={(e) => { setSessionIdSearch(e.target.value); setSessionPage(1); }} placeholder="Session ID" />
            <Input allowClear value={sessionUserSearch} onChange={(e) => { setSessionUserSearch(e.target.value); setSessionPage(1); }} placeholder="用户 ID" />
            <Input allowClear value={sessionAppSearch} onChange={(e) => { setSessionAppSearch(e.target.value); setSessionPage(1); }} placeholder="应用名称" />
            <Input allowClear value={sessionQuestionSearch} onChange={(e) => { setSessionQuestionSearch(e.target.value); setSessionPage(1); }} placeholder="首轮问题" />
            <DatePicker allowClear value={sessionDate} onChange={(value) => { setSessionDate(value); setSessionPage(1); }} placeholder="开始日期" format="YYYY-MM-DD" />
            <span style={{ color: "#94a3b8", fontSize: 12 }}>共 {filteredSessions.length} 个会话</span>
          </div>
        <div style={{ background: "#fff", border: "1px solid #e8edf3", borderRadius: 10, overflow: "hidden", boxShadow: "0 4px 16px rgba(15,23,42,.04)" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(170px,1.2fr) minmax(150px,1fr) 150px 70px minmax(220px,2fr) 140px 90px",
              padding: "12px 16px",
              background: "#fafafa",
              borderBottom: "1px solid #f0f0f0",
              fontSize: 13,
              fontWeight: 600,
              color: "rgba(0,0,0,.65)",
            }}
          >
            <div>Session ID</div>
            <div>用户</div>
            <div>Agent</div>
            <div>轮次</div>
            <div>首轮问题</div>
            <div>最近活动</div>
            <div>状态</div>
          </div>
          {loading ? (
            <div style={{ padding: 48, textAlign: "center" }}>
              <Spin />
            </div>
          ) : (
            <>
              {visibleSessions.map((s) => {
                const t = SESSION_TAG[s.status];
                return (
                  <div
                    key={s.sessionId}
                    onClick={() => nav(`/admin/traces/sessions/${s.sessionId}`)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(170px,1.2fr) minmax(150px,1fr) 150px 70px minmax(220px,2fr) 140px 90px",
                      padding: "12px 16px",
                      borderBottom: "1px solid #f0f0f0",
                      fontSize: 13,
                      alignItems: "center",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "#1677ff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.sessionId}
                    </div>
                    <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "rgba(0,0,0,.6)" }}>{s.userId ?? "—"}</div>
                    <div style={{ color: "rgba(0,0,0,.65)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.agentName}</div>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{s.roundCount} 轮</span>
                    </div>
                    <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 10, color: "rgba(0,0,0,.6)" }}>{s.firstQuestion}</div>
                    <div style={{ color: "#64748b", fontSize: 12 }}>{new Date(s.lastTs).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
                    <div>
                      <span style={{ fontSize: 12, lineHeight: "20px", padding: "0 8px", borderRadius: 4, background: t.bg, color: t.c, border: `1px solid ${t.bd}` }}>
                        {t.label}
                      </span>
                    </div>
                  </div>
                );
              })}
              {(sessions?.length ?? 0) === 0 && (
                <div style={{ padding: 48, textAlign: "center", color: "rgba(0,0,0,.3)", fontSize: 13 }}>暂无会话</div>
              )}
            </>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 14 }}><Pagination current={sessionPage} pageSize={sessionPageSize} total={filteredSessions.length} showSizeChanger={false} showTotal={(total) => `共 ${total} 个会话`} onChange={setSessionPage} /></div>
        </div>
      )}
    </div>
  );
}
