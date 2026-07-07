import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { tagOf } from "../../mocks/agents";
import {
  axisTicksOf,
  buildTraceJson,
  computeSpanDetail,
  computeTraceMeta,
  computeWaterfall,
  detailSetOf,
  KIND_LEGEND,
  spanSetOf,
  TRACE_ROWS,
  type SpanSetName,
} from "../../mocks/traces";

/** Trace 详情：meta + 调用瀑布图 + span 详情 + OTLP JSON。M9 接真实读模型。 */
export default function TraceDetailPage() {
  const { traceId = "" } = useParams<{ traceId: string }>();
  const nav = useNavigate();
  const [selSid, setSelSid] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const traceSel = useMemo(
    () => TRACE_ROWS.find((t) => t.id === traceId) || TRACE_ROWS[0],
    [traceId],
  );

  const { spanSet, spanTotal, setName, detailSet } = useMemo(() => {
    const ss = spanSetOf(traceSel.st);
    const total = Math.max(...ss.map((s) => s.start + s.dur)) || 1;
    const sn: SpanSetName = traceSel.st === "失败" ? "fail" : traceSel.st === "兜底" ? "fallback" : "ok";
    return { spanSet: ss, spanTotal: total, setName: sn, detailSet: detailSetOf(traceSel.st) };
  }, [traceSel]);

  const effSid = useMemo(() => {
    if (selSid && spanSet.some((s) => s.sid === selSid)) return selSid;
    const err = spanSet.find((s) => s.status === "ERROR");
    return (err ? err.sid : spanSet[0].sid) as string;
  }, [selSid, spanSet]);

  const waterfall = useMemo(() => computeWaterfall(spanSet, effSid, spanTotal), [spanSet, effSid, spanTotal]);
  const axisTicks = useMemo(() => axisTicksOf(spanTotal), [spanTotal]);
  const spanDetail = useMemo(
    () => computeSpanDetail(spanSet, detailSet, effSid, setName),
    [spanSet, detailSet, effSid, setName],
  );
  const meta = useMemo(() => computeTraceMeta(spanSet, traceSel, spanTotal), [spanSet, traceSel, spanTotal]);
  const traceJson = useMemo(() => buildTraceJson(traceSel, spanSet), [traceSel, spanSet]);

  const replay = () => {
    setToast("已在调试台重放该请求，新 Trace 生成中…");
    window.setTimeout(() => setToast(null), 2200);
  };
  const copyJson = () => {
    try {
      navigator.clipboard?.writeText(traceJson);
    } catch {
      // ignore
    }
    setJsonOpen(true);
  };

  const tag = tagOf(traceSel.tag);
  const headBtn: React.CSSProperties = {
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

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div onClick={() => nav("/admin/traces")} style={headBtn}>
          ← 返回列表
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, fontFamily: "ui-monospace,Menlo,monospace" }}>{traceSel.id}</div>
        <span
          style={{
            fontSize: 12,
            lineHeight: "20px",
            padding: "0 8px",
            borderRadius: 4,
            background: tag.bg,
            color: tag.c,
            border: `1px solid ${tag.bd}`,
          }}
        >
          {traceSel.st}
        </span>
        <div style={{ flex: 1 }} />
        <div onClick={replay} style={headBtn}>
          ↻ 重放
        </div>
        <div onClick={() => nav("/admin/prompts")} style={headBtn}>
          跳转 Prompt 版本 →
        </div>
        <div onClick={copyJson} style={headBtn}>
          {"{ }"} 复制 JSON
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 4 }}>用户问题</div>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 14 }}>{traceSel.q}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>Agent</div>
            <div style={{ fontSize: 13 }}>{traceSel.agent}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>生成模型</div>
            <div style={{ fontSize: 13 }}>{meta.model}</div>
            <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)" }}>{meta.modelVer}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>Prompt 版本</div>
            <div style={{ fontSize: 13, fontFamily: "ui-monospace,Menlo,monospace" }}>{meta.promptVer}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>总耗时</div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{meta.latTotal}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>Tokens</div>
            <div style={{ fontSize: 13 }}>{meta.totalTok}</div>
            <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)" }}>
              入 {meta.promptTok} / 出 {meta.compTok}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 3 }}>Cost</div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1677ff" }}>{meta.cost}</div>
          </div>
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "16px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>调用瀑布图 · Span 树</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {KIND_LEGEND.map((k) => (
              <div key={k.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: k.c }} />
                <span style={{ fontSize: 11, color: "rgba(0,0,0,.5)" }}>{k.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ position: "relative", height: 16, marginLeft: 210, marginBottom: 6, borderBottom: "1px solid #f0f0f0" }}>
          {axisTicks.map((t) => (
            <span
              key={t.leftPct}
              style={{
                position: "absolute",
                top: 0,
                left: t.leftPct,
                transform: "translateX(-50%)",
                fontSize: 10,
                color: "rgba(0,0,0,.35)",
              }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {waterfall.map((s) => (
            <div
              key={s.sid}
              onClick={() => setSelSid(s.sid)}
              style={{
                display: "flex",
                alignItems: "center",
                height: 30,
                borderRadius: 5,
                cursor: "pointer",
                background: s.rowBg,
              }}
            >
              <div
                style={{
                  width: 210,
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  paddingLeft: s.indent,
                  minWidth: 0,
                  boxSizing: "border-box",
                }}
              >
                <span style={{ width: 6, height: 6, flex: "none", borderRadius: 2, background: s.kindC }} />
                <span
                  style={{
                    fontSize: "12.5px",
                    color: s.nameC,
                    fontWeight: s.nameFw,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {s.name}
                </span>
                <span style={{ fontSize: 10, color: "rgba(0,0,0,.3)", flex: "none" }}>{s.kindLabel}</span>
              </div>
              <div style={{ flex: 1, position: "relative", height: "100%", minWidth: 0 }}>
                <div
                  style={{
                    position: "absolute",
                    top: 8,
                    height: 14,
                    left: s.leftPct,
                    width: s.widthPct,
                    background: s.barC,
                    opacity: s.barOpacity,
                    borderRadius: 3,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {s.badge && (
                    <span style={{ fontSize: 10, color: "#fff", fontWeight: 700 }}>{s.badge}</span>
                  )}
                </div>
                <span
                  style={{
                    position: "absolute",
                    top: 7,
                    left: `calc(${s.leftPct} + ${s.widthPct} + 6px)`,
                    fontSize: "10.5px",
                    color: "rgba(0,0,0,.4)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.durLabel}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, padding: "18px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{spanDetail.title}</div>
          <span
            style={{
              fontSize: 11,
              lineHeight: "20px",
              padding: "0 8px",
              borderRadius: 4,
              background: "#f5f5f5",
              color: "rgba(0,0,0,.5)",
              border: "1px solid #e8e8e8",
            }}
          >
            {spanDetail.kindLabel}
          </span>
          <span
            style={{
              fontSize: 12,
              lineHeight: "20px",
              padding: "0 8px",
              borderRadius: 4,
              background: spanDetail.stBg,
              color: spanDetail.stC,
              border: `1px solid ${spanDetail.stBd}`,
            }}
          >
            {spanDetail.statusLabel}
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "rgba(0,0,0,.5)" }}>耗时 {spanDetail.dur}</span>
          {spanDetail.hasTok && (
            <span style={{ fontSize: 12, color: "rgba(0,0,0,.5)" }}>· Tokens {spanDetail.attrTok}</span>
          )}
          {spanDetail.hasCost && (
            <span style={{ fontSize: 12, color: "#1677ff", fontWeight: 500 }}>· {spanDetail.attrCost}</span>
          )}
        </div>

        {spanDetail.isErr && (
          <div
            style={{
              background: "#fff2f0",
              border: "1px solid #ffccc7",
              borderRadius: 6,
              padding: "12px 14px",
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#ff4d4f" }}>⚠ {spanDetail.errType}</span>
            </div>
            <div style={{ fontSize: 13, color: "rgba(0,0,0,.7)", lineHeight: 1.7 }}>{spanDetail.errMsg}</div>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          {spanDetail.meta.map((mt) => (
            <div key={mt.k} style={{ display: "flex", gap: 12, fontSize: 13 }}>
              <div style={{ width: 80, flex: "none", color: "rgba(0,0,0,.45)" }}>{mt.k}</div>
              <div style={{ color: "rgba(0,0,0,.75)" }}>{mt.v}</div>
            </div>
          ))}
        </div>

        {spanDetail.hasScores && (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>
              {spanDetail.scoresTitle}
            </div>
            <div
              style={{
                border: "1px solid #f0f0f0",
                borderRadius: 6,
                overflow: "hidden",
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 76px 84px 82px 70px",
                  padding: "8px 14px",
                  background: "#fafafa",
                  borderBottom: "1px solid #f0f0f0",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "rgba(0,0,0,.55)",
                }}
              >
                <div>命中分块</div>
                <div style={{ textAlign: "right" }}>向量分</div>
                <div style={{ textAlign: "right" }}>关键词分</div>
                <div style={{ textAlign: "right" }}>Rerank</div>
                <div style={{ textAlign: "right" }}>结果</div>
              </div>
              {spanDetail.scores.map((sc) => (
                <div
                  key={sc.doc}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 76px 84px 82px 70px",
                    padding: "9px 14px",
                    borderBottom: "1px solid #f5f5f5",
                    fontSize: 12,
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      color: "rgba(0,0,0,.7)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      paddingRight: 8,
                    }}
                  >
                    {sc.doc}
                  </div>
                  <div style={{ textAlign: "right", fontFamily: "ui-monospace,Menlo,monospace", color: "rgba(0,0,0,.6)" }}>
                    {sc.vec}
                  </div>
                  <div style={{ textAlign: "right", fontFamily: "ui-monospace,Menlo,monospace", color: "rgba(0,0,0,.6)" }}>
                    {sc.kw}
                  </div>
                  <div
                    style={{
                      textAlign: "right",
                      fontFamily: "ui-monospace,Menlo,monospace",
                      fontWeight: 600,
                      color: sc.rrColor,
                    }}
                  >
                    {sc.rr}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span
                      style={{
                        fontSize: 11,
                        lineHeight: "18px",
                        padding: "0 6px",
                        borderRadius: 9,
                        background: sc.passBg,
                        color: sc.passC,
                        border: `1px solid ${sc.passBd}`,
                      }}
                    >
                      {sc.passLabel}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {spanDetail.hasCites && (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)", marginBottom: 6 }}>
              引用来源 · 角标 ↔ 命中分块
            </div>
            <div
              style={{
                border: "1px solid #f0f0f0",
                borderRadius: 6,
                overflow: "hidden",
                marginBottom: 16,
              }}
            >
              {spanDetail.cites.map((c) => (
                <div
                  key={c.n}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 14px",
                    borderBottom: "1px solid #f5f5f5",
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontFamily: "ui-monospace,Menlo,monospace",
                      fontWeight: 700,
                      color: "#1677ff",
                      flex: "none",
                    }}
                  >
                    {c.n}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      color: "rgba(0,0,0,.75)",
                      flex: 1,
                      minWidth: 0,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {c.doc}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: "ui-monospace,Menlo,monospace",
                      color: "#52c41a",
                      flex: "none",
                    }}
                  >
                    Rerank {c.rr}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)" }}>输入</span>
          <span
            style={{
              fontSize: 11,
              lineHeight: "18px",
              padding: "0 7px",
              borderRadius: 9,
              background: "#f6ffed",
              color: "#52c41a",
              border: "1px solid #b7eb8f",
            }}
          >
            已脱敏
          </span>
        </div>
        <div
          style={{
            background: "#fafafa",
            border: "1px solid #f0f0f0",
            borderRadius: 6,
            padding: "12px 14px",
            fontSize: 13,
            lineHeight: 1.9,
            whiteSpace: "pre-wrap",
            marginBottom: 14,
          }}
        >
          {spanDetail.input}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(0,0,0,.45)" }}>输出</span>
        </div>
        <div
          style={{
            background: "#f0f7ff",
            border: "1px solid #d6e8ff",
            borderRadius: 6,
            padding: "12px 14px",
            fontSize: 13,
            lineHeight: 1.9,
            whiteSpace: "pre-wrap",
          }}
        >
          {spanDetail.output}
        </div>
      </div>

      {jsonOpen && (
        <>
          <div
            onClick={() => setJsonOpen(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 60 }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%,-50%)",
              width: 640,
              maxHeight: "78vh",
              background: "#fff",
              zIndex: 61,
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 8px 32px rgba(0,0,0,.2)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: 52,
                flex: "none",
                borderBottom: "1px solid #f0f0f0",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 20px",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600 }}>OTLP Span JSON · {traceSel.id}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 12, color: "#52c41a" }}>✓ 已复制到剪贴板</span>
                <div
                  onClick={() => setJsonOpen(false)}
                  style={{
                    fontSize: 18,
                    color: "rgba(0,0,0,.45)",
                    cursor: "pointer",
                    width: 28,
                    height: 28,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 4,
                  }}
                >
                  ×
                </div>
              </div>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", background: "#1e1e1e" }}>
              <pre
                style={{
                  margin: 0,
                  fontFamily: "ui-monospace,Menlo,monospace",
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: "#d4d4d4",
                  whiteSpace: "pre-wrap",
                }}
              >
                {traceJson}
              </pre>
            </div>
          </div>
        </>
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 62,
            background: "rgba(0,0,0,.82)",
            color: "#fff",
            fontSize: 13,
            padding: "10px 18px",
            borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,.25)",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
