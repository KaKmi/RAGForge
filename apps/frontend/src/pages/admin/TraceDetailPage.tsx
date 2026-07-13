import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { message, Segmented, Spin } from "antd";
import type { TraceDetailResponse, TraceStatus } from "@codecrush/contracts";
import { getTrace } from "../../api/client";
import {
  autoSelectSpan,
  buildOtlpJson,
  buildSpanDetail,
  buildWaterfall,
  KIND_LEGEND,
  rootSpanOf,
  traceSpanTotal,
} from "./traceDetail";

/** Trace 详情：meta + 时间轴/树 + 数据驱动 span 面板 + OTLP JSON。M9 W2 接真实读模型。 */

const STATUS_TAG: Record<TraceStatus, { label: string; bg: string; c: string; bd: string }> = {
  success: { label: "成功", bg: "#f6ffed", c: "#52c41a", bd: "#b7eb8f" },
  fallback: { label: "兜底", bg: "#fffbe6", c: "#d48806", bd: "#ffe58f" },
  failed: { label: "失败", bg: "#fff2f0", c: "#ff4d4f", bd: "#ffccc7" },
};
const fmtMs = (ms: number): string => (ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms");
const fmtScore = (v: number | null): string => (v == null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(v >= 1 ? 1 : 3));

export default function TraceDetailPage() {
  const { traceId = "" } = useParams<{ traceId: string }>();
  const nav = useNavigate();
  const [data, setData] = useState<TraceDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selSid, setSelSid] = useState<string | null>(null);
  const [view, setView] = useState<"timeline" | "tree">("timeline");
  const [jsonOpen, setJsonOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getTrace(traceId)
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e: unknown) => {
        if (live) message.error(e instanceof Error ? e.message : "加载 Trace 详情失败");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [traceId]);

  const spans = useMemo(() => data?.spans ?? [], [data]);
  const root = useMemo(() => rootSpanOf(spans), [spans]);
  const effSid = useMemo(() => autoSelectSpan(spans, selSid), [spans, selSid]);
  const waterfall = useMemo(() => buildWaterfall(spans, effSid), [spans, effSid]);
  const total = useMemo(() => traceSpanTotal(spans), [spans]);
  const selSpan = useMemo(() => spans.find((s) => s.spanId === effSid), [spans, effSid]);
  const detail = useMemo(() => (selSpan && root ? buildSpanDetail(selSpan, root) : null), [selSpan, root]);

  const copyJson = () => {
    if (!data) return;
    try {
      navigator.clipboard?.writeText(buildOtlpJson(data.traceId, data.meta, spans));
    } catch {
      /* ignore */
    }
    setJsonOpen(true);
  };

  const headBtn: CSSProperties = {
    height: 30,
    padding: "0 12px",
    border: "1px solid #d9d9d9",
    borderRadius: 6,
    background: "#fff",
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 13,
    cursor: "pointer",
  };

  if (loading) {
    return (
      <div style={{ padding: 64, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }
  if (!data || !root) {
    return (
      <div>
        <div onClick={() => nav("/admin/traces")} style={{ ...headBtn, width: "fit-content", marginBottom: 16 }}>
          ← 返回列表
        </div>
        <div style={{ padding: 48, textAlign: "center", color: "rgba(0,0,0,.3)", fontSize: 13 }}>
          未找到该 Trace（可能尚未落库或已过期）
        </div>
      </div>
    );
  }

  const meta = data.meta;
  const st = STATUS_TAG[meta.status];

  return (
    <div>
      {/* 头部：返回 + traceId + 状态 + 跳 Prompt / 复制 JSON（无重放/加入评测集，M11） */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div onClick={() => nav("/admin/traces")} style={headBtn}>
          ← 返回列表
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, fontFamily: "ui-monospace,Menlo,monospace" }}>{data.traceId}</div>
        <span style={{ fontSize: 12, lineHeight: "20px", padding: "0 8px", borderRadius: 4, background: st.bg, color: st.c, border: `1px solid ${st.bd}` }}>
          {st.label}
        </span>
        <div style={{ flex: 1 }} />
        <div onClick={() => nav("/admin/prompts")} style={headBtn}>
          跳转 Prompt 版本 →
        </div>
        <div onClick={copyJson} style={headBtn}>
          {"{ }"} 复制 JSON
        </div>
      </div>

      {/* meta 卡 */}
      <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 4 }}>用户问题</div>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 14 }}>{meta.userInput || "—"}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 14 }}>
          <MetaCell label="Agent" value={meta.agentName ?? "—"} />
          <MetaCell label="生成模型" value={meta.genModel ?? "—"} sub={meta.genModelVersion ?? undefined} />
          <MetaCell label="Prompt 版本" value={meta.promptVersionId ?? "—"} mono />
          <MetaCell label="总耗时" value={fmtMs(meta.durationMs)} bold />
          <MetaCell label="Tokens" value={(meta.inputTokens + meta.outputTokens).toLocaleString()} sub={`入 ${meta.inputTokens} / 出 ${meta.outputTokens}`} />
          <MetaCell label="Cost" value={meta.cost == null ? "—" : "¥" + meta.cost.toFixed(4)} bold color="#1677ff" />
        </div>
      </div>

      {/* 两栏：左调用链 + 右 span 面板 */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ width: 430, flex: "none", background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "12px 10px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px 10px" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>调用链</div>
            <Segmented
              size="small"
              value={view}
              onChange={(v) => setView(v as "timeline" | "tree")}
              options={[
                { label: "时间轴", value: "timeline" },
                { label: "树", value: "tree" },
              ]}
            />
          </div>

          {/* TRACE 根行 */}
          <div
            onClick={() => setSelSid(root.spanId)}
            style={{ display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 6px", borderRadius: 5, cursor: "pointer", background: effSid === root.spanId ? "#e6f4ff" : "transparent", marginBottom: 2 }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".5px", color: "#1677ff", background: "#f0f5ff", border: "1px solid #d6e4ff", borderRadius: 4, padding: "1px 6px" }}>TRACE</span>
            <span style={{ fontSize: 12, color: "rgba(0,0,0,.55)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta.userInput}</span>
            <span style={{ fontSize: 11, color: "rgba(0,0,0,.4)", flex: "none" }}>{fmtMs(meta.durationMs)}</span>
          </div>

          {view === "timeline" && (
            <>
              <div style={{ position: "relative", height: 16, marginLeft: 150, marginBottom: 4, borderBottom: "1px solid #f0f0f0" }}>
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <span key={f} style={{ position: "absolute", top: 0, left: f * 100 + "%", transform: "translateX(-50%)", fontSize: 9.5, color: "rgba(0,0,0,.35)" }}>
                    {fmtMs(Math.round(total * f))}
                  </span>
                ))}
              </div>
              {waterfall.map((s) => (
                <div key={s.sid} onClick={() => setSelSid(s.sid)} style={{ display: "flex", alignItems: "center", height: 30, borderRadius: 5, cursor: "pointer", background: s.sel ? "#e6f4ff" : "transparent" }}>
                  <div style={{ width: 150, flex: "none", display: "flex", alignItems: "center", gap: 6, paddingLeft: s.indent, minWidth: 0, boxSizing: "border-box" }}>
                    <span style={{ width: 6, height: 6, flex: "none", borderRadius: 2, background: s.kindC }} />
                    <span style={{ fontSize: 12, color: s.isErr ? "#ff4d4f" : "rgba(0,0,0,.85)", fontWeight: s.sel ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                  </div>
                  <div style={{ flex: 1, position: "relative", height: "100%", minWidth: 0 }}>
                    <div style={{ position: "absolute", top: 8, height: 14, left: s.leftPct, width: s.widthPct, background: s.isErr ? "#ff4d4f" : s.kindC, opacity: s.isSkip ? 0.35 : s.sel ? 1 : 0.85, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {s.isErr && <span style={{ fontSize: 10, color: "#fff", fontWeight: 700 }}>✕</span>}
                    </div>
                    <span style={{ position: "absolute", top: 7, left: `calc(${s.leftPct} + ${s.widthPct} + 6px)`, fontSize: 10, color: "rgba(0,0,0,.4)", whiteSpace: "nowrap" }}>{s.isSkip ? "未执行" : fmtMs(s.durationMs)}</span>
                  </div>
                </div>
              ))}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: "10px 6px 0", borderTop: "1px solid #f5f5f5", marginTop: 8 }}>
                {KIND_LEGEND.map((k) => (
                  <div key={k.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: k.c }} />
                    <span style={{ fontSize: 10.5, color: "rgba(0,0,0,.5)" }}>{k.label}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {view === "tree" && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {waterfall.map((s) => (
                <div key={s.sid} onClick={() => setSelSid(s.sid)} style={{ display: "flex", alignItems: "center", gap: 7, height: 32, padding: "0 6px", borderRadius: 5, cursor: "pointer", background: s.sel ? "#e6f4ff" : "transparent" }}>
                  <div style={{ width: s.indent, flex: "none" }} />
                  <span style={{ width: 6, height: 6, flex: "none", borderRadius: 2, background: s.kindC }} />
                  <span style={{ fontSize: 12.5, color: s.isErr ? "#ff4d4f" : "rgba(0,0,0,.85)", fontWeight: s.sel ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                  <span style={{ fontSize: 10, color: s.kindC, border: `1px solid ${s.kindC}`, borderRadius: 3, padding: "0 4px", lineHeight: "14px", flex: "none", opacity: 0.75 }}>{s.kindLabel}</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: "rgba(0,0,0,.4)", flex: "none", width: 56, textAlign: "right" }}>{s.isSkip ? "未执行" : fmtMs(s.durationMs)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右栏 span 面板 */}
        {detail && (
          <div style={{ flex: 1, minWidth: 0, background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "18px 22px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{detail.title}</div>
              <span style={{ fontSize: 11, lineHeight: "20px", padding: "0 8px", borderRadius: 4, background: "#f5f5f5", color: "rgba(0,0,0,.5)", border: "1px solid #e8e8e8" }}>{detail.kindLabel}</span>
              <span style={{ fontSize: 12, lineHeight: "20px", padding: "0 8px", borderRadius: 4, background: detail.isErr ? "#fff2f0" : "#f6ffed", color: detail.isErr ? "#ff4d4f" : "#52c41a", border: `1px solid ${detail.isErr ? "#ffccc7" : "#b7eb8f"}` }}>{detail.statusLabel}</span>
              <div style={{ flex: 1 }} />
              {detail.tokens && <span style={{ fontSize: 12, color: "rgba(0,0,0,.5)" }}>Tokens {detail.tokens}</span>}
            </div>

            {detail.isErr && (
              <div style={{ background: "#fff2f0", border: "1px solid #ffccc7", borderRadius: 6, padding: "12px 14px", marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#ff4d4f", marginBottom: 4 }}>⚠ {detail.errType}</div>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.7)", lineHeight: 1.7 }}>{detail.errMsg}</div>
              </div>
            )}

            {detail.meta.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                {detail.meta.map((mt) => (
                  <div key={mt.k} style={{ display: "flex", gap: 12, fontSize: 13 }}>
                    <div style={{ width: 80, flex: "none", color: "rgba(0,0,0,.45)" }}>{mt.k}</div>
                    <div style={{ color: "rgba(0,0,0,.75)" }}>{mt.v}</div>
                  </div>
                ))}
              </div>
            )}

            {detail.isRoot && (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>Scores · 评估</div>
                <div style={{ border: "1px solid #f0f0f0", borderRadius: 6, padding: "12px 14px", marginBottom: 16, fontSize: 12, color: "rgba(0,0,0,.35)" }}>
                  评测打分未接入（评测集 M11）
                </div>
              </>
            )}

            {detail.scores.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>检索命中分表</div>
                <div style={{ border: "1px solid #f0f0f0", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 76px 84px 82px 70px", padding: "8px 14px", background: "#fafafa", borderBottom: "1px solid #f0f0f0", fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.55)" }}>
                    <div>命中分块</div>
                    <div style={{ textAlign: "right" }}>向量分</div>
                    <div style={{ textAlign: "right" }}>关键词分</div>
                    <div style={{ textAlign: "right" }}>Rerank</div>
                    <div style={{ textAlign: "right" }}>结果</div>
                  </div>
                  {detail.scores.map((sc, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 76px 84px 82px 70px", padding: "9px 14px", borderBottom: "1px solid #f5f5f5", fontSize: 12, alignItems: "center" }}>
                      <div style={{ color: "rgba(0,0,0,.7)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 8 }}>{sc.doc}</div>
                      <div style={{ textAlign: "right", fontFamily: "ui-monospace,Menlo,monospace", color: "rgba(0,0,0,.6)" }}>{fmtScore(sc.vec)}</div>
                      <div style={{ textAlign: "right", fontFamily: "ui-monospace,Menlo,monospace", color: "rgba(0,0,0,.6)" }}>{fmtScore(sc.kw)}</div>
                      <div style={{ textAlign: "right", fontFamily: "ui-monospace,Menlo,monospace", fontWeight: 600, color: sc.pass ? "#52c41a" : "#ff4d4f" }}>{fmtScore(sc.rr)}</div>
                      <div style={{ textAlign: "right" }}>
                        <span style={{ fontSize: 11, lineHeight: "18px", padding: "0 6px", borderRadius: 9, background: sc.pass ? "#f6ffed" : "#fff2f0", color: sc.pass ? "#52c41a" : "#ff4d4f", border: `1px solid ${sc.pass ? "#b7eb8f" : "#ffccc7"}` }}>{sc.pass ? "命中" : "已过滤"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {detail.cites.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>引用来源 · 角标 ↔ 命中分块</div>
                <div style={{ border: "1px solid #f0f0f0", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
                  {detail.cites.map((c) => (
                    <div key={c.n} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: "1px solid #f5f5f5" }}>
                      <span style={{ fontSize: 12, fontFamily: "ui-monospace,Menlo,monospace", fontWeight: 700, color: "#1677ff", flex: "none" }}>[{c.n}]</span>
                      <span style={{ fontSize: 13, color: "rgba(0,0,0,.75)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.doc}</span>
                      <span style={{ fontSize: 11, fontFamily: "ui-monospace,Menlo,monospace", color: "#52c41a", flex: "none" }}>Rerank {c.score.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {detail.isRoot ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)" }}>输入</span>
                  <span style={{ fontSize: 11, lineHeight: "18px", padding: "0 7px", borderRadius: 9, background: "#f6ffed", color: "#52c41a", border: "1px solid #b7eb8f" }}>已脱敏</span>
                </div>
                <div style={{ background: "#fafafa", border: "1px solid #f0f0f0", borderRadius: 6, padding: "12px 14px", fontSize: 13, lineHeight: 1.9, whiteSpace: "pre-wrap", marginBottom: 14 }}>{detail.input || "—"}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>输出</div>
                <div style={{ background: "#f0f7ff", border: "1px solid #d6e8ff", borderRadius: 6, padding: "12px 14px", fontSize: 13, lineHeight: 1.9, whiteSpace: "pre-wrap" }}>{detail.output || "—"}</div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)" }}>该节点无独立输入/输出记录（仅根节点保留脱敏 IO）</div>
            )}
          </div>
        )}
      </div>

      {jsonOpen && (
        <>
          <div onClick={() => setJsonOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 60 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 640, maxHeight: "78vh", background: "#fff", zIndex: 61, borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,.2)", overflow: "hidden" }}>
            <div style={{ height: 52, flex: "none", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>OTLP Span JSON · {data.traceId}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 12, color: "#52c41a" }}>✓ 已复制到剪贴板</span>
                <div onClick={() => setJsonOpen(false)} style={{ fontSize: 18, color: "rgba(0,0,0,.45)", cursor: "pointer", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4 }}>×</div>
              </div>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", background: "#1e1e1e" }}>
              <pre style={{ margin: 0, fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, lineHeight: 1.7, color: "#d4d4d4", whiteSpace: "pre-wrap" }}>
                {buildOtlpJson(data.traceId, data.meta, spans)}
              </pre>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MetaCell({ label, value, sub, mono, bold, color }: { label: string; value: string; sub?: string; mono?: boolean; bold?: boolean; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: bold ? 500 : 400, color, fontFamily: mono ? "ui-monospace,Menlo,monospace" : undefined }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)" }}>{sub}</div>}
    </div>
  );
}
