import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { message, Segmented, Spin } from "antd";
import type {
  Application,
  QualitySignal,
  SessionListRow,
  TraceListResponse,
  TraceListRow,
  TraceStatus,
} from "@codecrush/contracts";
import { getApplications, getTraces, getTraceSessions } from "../../api/client";

/** Trace 追踪：Trace/Session 双列表接真实读模型（ClickHouse VIEW）。M9 W1。 */

const STATUSES = ["全部", "成功", "兜底", "失败"] as const;
const QUICKS = ["全部", "失败", "慢请求", "低分召回"] as const;
const RANGES = ["今日", "近 7 日", "近 30 日"] as const;
type StatusFilter = (typeof STATUSES)[number];
type QuickFilter = (typeof QUICKS)[number];
type RangeFilter = (typeof RANGES)[number];

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
  const [tab, setTab] = useState<"trace" | "session">("trace");
  const [query, setQuery] = useState("");
  const [agentId, setAgentId] = useState(""); // ""=全部
  const [status, setStatus] = useState<StatusFilter>("全部");
  const [quick, setQuick] = useState<QuickFilter>("全部");
  const [range, setRange] = useState<RangeFilter>("今日");

  const [apps, setApps] = useState<Application[]>([]);
  const [data, setData] = useState<TraceListResponse | null>(null);
  const [sessions, setSessions] = useState<SessionListRow[] | null>(null);
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
      from: rangeFrom(range),
      page: 1,
      pageSize: 50,
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
  }, [tab, query, agentId, status, quick, range]);

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

  const hasFilter = query !== "" || agentId !== "" || status !== "全部" || quick !== "全部";
  const reset = () => {
    setQuery("");
    setAgentId("");
    setStatus("全部");
    setQuick("全部");
  };

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

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Trace 追踪</div>
        <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>
          {tab === "trace" ? `共 ${traceCount} 条 · 点击行查看调用链路` : `共 ${sessions?.length ?? 0} 个会话`}
        </div>
      </div>

      {/* Trace / Session 分段控件（antd Segmented，样式还原原型 pill） */}
      <div style={{ marginBottom: 16 }}>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as "trace" | "session")}
          options={[
            { label: "Trace", value: "trace" },
            { label: "Session · 会话", value: "session" },
          ]}
        />
      </div>

      {tab === "trace" && (
        <>
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
                  onClick={() => setRange(r)}
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
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "160px 90px 1fr 110px 80px 90px 80px",
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
                        gridTemplateColumns: "160px 90px 1fr 110px 80px 90px 80px",
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
                    </div>
                  );
                })}
                {(data?.items.length ?? 0) === 0 && (
                  <div style={{ padding: 48, textAlign: "center", color: "rgba(0,0,0,.3)", fontSize: 13 }}>没有符合条件的 Trace</div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {tab === "session" && (
        <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "180px 110px 120px 70px 1fr 90px",
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
            <div>状态</div>
          </div>
          {loading ? (
            <div style={{ padding: 48, textAlign: "center" }}>
              <Spin />
            </div>
          ) : (
            <>
              {(sessions ?? []).map((s) => {
                const t = SESSION_TAG[s.status];
                return (
                  <div
                    key={s.sessionId}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "180px 110px 120px 70px 1fr 90px",
                      padding: "12px 16px",
                      borderBottom: "1px solid #f0f0f0",
                      fontSize: 13,
                      alignItems: "center",
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
      )}
    </div>
  );
}
