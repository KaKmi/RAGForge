import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { tagOf } from "../../mocks/agents";
import {
  computeTrSummary,
  durNum,
  TR_AGENTS,
  TR_QUICK,
  TR_RANGES,
  TR_STATUSES,
  TRACE_ROWS,
  type TraceRow,
} from "../../mocks/traces";

/** Trace 追踪：概览 + 筛选 + 列表。M9 接真实读模型（ClickHouse VIEW）。 */
export default function TracesPage() {
  const nav = useNavigate();
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("全部");
  const [status, setStatus] = useState("全部");
  const [range, setRange] = useState(TR_RANGES[0]);
  const [quick, setQuick] = useState(TR_QUICK[0]);

  const filtered = useMemo(() => {
    const q = query.trim();
    return TRACE_ROWS.filter((t) => {
      if (q && !(t.q.includes(q) || t.id.includes(q))) return false;
      if (agent !== "全部" && t.agent !== agent) return false;
      if (status !== "全部" && t.st !== status) return false;
      if (quick === "失败" && t.st !== "失败") return false;
      if (quick === "慢请求" && durNum(t) < 3) return false;
      if (quick === "低分召回" && t.st !== "兜底") return false;
      return true;
    });
  }, [query, agent, status, quick]);

  const summary = useMemo(() => computeTrSummary(TRACE_ROWS), []);
  const hasFilter = query !== "" || agent !== "全部" || status !== "全部" || quick !== "全部";

  const reset = () => {
    setQuery("");
    setAgent("全部");
    setStatus("全部");
    setQuick(TR_QUICK[0]);
  };

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

  const quickChip = (on: boolean): CSSProperties => ({
    height: 28,
    padding: "0 12px",
    lineHeight: "26px",
    borderRadius: 14,
    border: `1px solid ${on ? "#1677ff" : "#d9d9d9"}`,
    background: on ? "#e6f4ff" : "#fff",
    color: on ? "#1677ff" : "rgba(0,0,0,.65)",
    fontSize: 12,
    cursor: "pointer",
    userSelect: "none",
  });

  const open = (r: TraceRow) => nav(`/admin/traces/${r.id}`);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Trace 追踪</div>
        <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>
          共 {filtered.length} 条 · 点击行查看调用链路
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1, background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "14px 18px" }}>
          <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>采样 Trace 数</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{summary.total}</div>
        </div>
        <div style={{ flex: 1, background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "14px 18px" }}>
          <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>失败率</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: summary.failC }}>{summary.failRate}</div>
          <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)", marginTop: 2 }}>{summary.failN} 条失败</div>
        </div>
        <div style={{ flex: 1, background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "14px 18px" }}>
          <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>P95 耗时</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: summary.p95C }}>{summary.p95}</div>
          <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)", marginTop: 2 }}>含超时熔断请求</div>
        </div>
        <div style={{ flex: 1.4, background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "12px 18px" }}>
          <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 8 }}>快捷排查</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {TR_QUICK.map((k) => (
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
          style={{
            width: 220,
            height: 32,
            padding: "0 12px",
            border: "1px solid #d9d9d9",
            borderRadius: 6,
            fontSize: 13,
            outline: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>Agent</span>
          <div style={{ display: "flex", gap: 6 }}>
            {TR_AGENTS.map((a) => (
              <div key={a} onClick={() => setAgent(a)} style={chip(agent === a)}>
                {a}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>状态</span>
          <div style={{ display: "flex", gap: 6 }}>
            {TR_STATUSES.map((s) => (
              <div key={s} onClick={() => setStatus(s)} style={chip(status === s)}>
                {s}
              </div>
            ))}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", border: "1px solid #d9d9d9", borderRadius: 6, overflow: "hidden" }}>
          {TR_RANGES.map((r, i) => (
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
        {filtered.map((r) => {
          const t = tagOf(r.tag);
          return (
            <div
              key={r.id}
              onClick={() => open(r)}
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
              <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, color: "#1677ff" }}>{r.id}</div>
              <div style={{ color: "rgba(0,0,0,.45)" }}>{r.time}</div>
              <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.q}</div>
              <div style={{ color: "rgba(0,0,0,.65)" }}>{r.agent}</div>
              <div>
                <span
                  style={{
                    fontSize: 12,
                    lineHeight: "20px",
                    padding: "0 8px",
                    borderRadius: 4,
                    background: t.bg,
                    color: t.c,
                    border: `1px solid ${t.bd}`,
                  }}
                >
                  {r.st}
                </span>
              </div>
              <div>{r.dur}</div>
              <div style={{ color: "rgba(0,0,0,.45)" }}>{r.tok}</div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: 48, textAlign: "center", color: "rgba(0,0,0,.3)", fontSize: 13 }}>
            没有符合条件的 Trace
          </div>
        )}
      </div>
    </div>
  );
}
