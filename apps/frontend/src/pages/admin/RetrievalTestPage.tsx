import { useState, type CSSProperties } from "react";
import { CITES } from "../../mocks/conversations";
import { RT_KBS, RT_EMBEDS, RT_RERANKS, computeRtResults } from "../../mocks/retrieval";

/** 知识检索测试：左配置 + 右结果（对齐原型，纯本地 mock 计算）。M5 接 POST /api/retrieval/test。 */

const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #f0f0f0",
  borderRadius: 8,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const cardHead: CSSProperties = {
  padding: "14px 18px",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 14,
  fontWeight: 600,
};

const fieldLabel: CSSProperties = { fontSize: 13, color: "rgba(0,0,0,.65)" };

const selectStyle: CSSProperties = {
  height: 36,
  padding: "0 10px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  fontSize: 13,
  outline: "none",
  background: "#fff",
};

export default function RetrievalTestPage() {
  const [kb, setKb] = useState(RT_KBS[0]);
  const [embed, setEmbed] = useState(RT_EMBEDS[0]);
  const [threshold, setThreshold] = useState("0.65");
  const [vec, setVec] = useState("0.60");
  const [rerank, setRerank] = useState(RT_RERANKS[0]);
  const [multi, setMulti] = useState(true);
  const [query, setQuery] = useState("");
  const [ran, setRan] = useState(false);

  const vecN = parseFloat(vec);
  const thrN = parseFloat(threshold);
  const full = +(1 - vecN).toFixed(2);
  const results = ran
    ? computeRtResults(Object.values(CITES), { vec: vecN, threshold: thrN, multi })
    : [];
  const runBg = query.trim() ? "#1677ff" : "#bfbfbf";

  const run = () => {
    if (query.trim()) setRan(true);
  };

  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>知识检索测试</div>
      <div
        style={{
          fontSize: 13,
          color: "rgba(0,0,0,.45)",
          marginBottom: 16,
          lineHeight: 1.7,
        }}
      >
        验证召回配置：确认当前设置能从知识库召回正确的文本块。此处的调整仅用于测试，不会自动保存到 Agent 配置。
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 16, alignItems: "start" }}>
        <div style={card}>
          <div style={cardHead}>测试设置</div>
          <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 18 }}>
            <Field label="检索知识库">
              <select value={kb} onChange={e => setKb(e.target.value)} style={selectStyle}>
                {RT_KBS.map(k => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </Field>
            <Field label="向量模型（Embedding）">
              <select value={embed} onChange={e => setEmbed(e.target.value)} style={selectStyle}>
                {RT_EMBEDS.map(k => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </Field>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={fieldLabel}>相似度阈值</span>
                <span
                  style={{
                    fontSize: 13,
                    color: "rgba(0,0,0,.75)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {threshold}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={threshold}
                onChange={e => setThreshold(e.target.value)}
                style={{ accentColor: "#1677ff" }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={fieldLabel}>向量 / 关键词权重</span>
                <span
                  style={{
                    fontSize: 13,
                    color: "rgba(0,0,0,.75)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  向量 {vec} · 关键词 {full.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={vec}
                onChange={e => setVec(e.target.value)}
                style={{ accentColor: "#1677ff" }}
              />
            </div>
            <Field label="Rerank 模型">
              <select value={rerank} onChange={e => setRerank(e.target.value)} style={selectStyle}>
                {RT_RERANKS.map(k => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </Field>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={fieldLabel}>多路召回（向量 + 关键词）</div>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>关闭则仅向量召回</div>
              </div>
              <div
                onClick={() => setMulti(m => !m)}
                style={{
                  width: 44,
                  height: 24,
                  flex: "none",
                  borderRadius: 12,
                  background: multi ? "#1677ff" : "#d9d9d9",
                  position: "relative",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 2,
                    left: multi ? "22px" : "2px",
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: "#fff",
                    transition: "left .15s",
                  }}
                />
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={fieldLabel}>测试问题</div>
              <textarea
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="输入一个问题，测试能召回哪些文本块…"
                style={{
                  height: 90,
                  padding: "10px 12px",
                  border: "1px solid #d9d9d9",
                  borderRadius: 6,
                  fontSize: 13,
                  lineHeight: 1.7,
                  outline: "none",
                  resize: "none",
                  fontFamily: "inherit",
                }}
              />
            </div>
            <div
              onClick={run}
              style={{
                alignSelf: "flex-end",
                height: 36,
                padding: "0 22px",
                background: runBg,
                color: "#fff",
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 14,
                cursor: query.trim() ? "pointer" : "not-allowed",
              }}
            >
              运行 ➤
            </div>
          </div>
        </div>

        <div style={card}>
          <div style={{ ...cardHead, display: "flex", alignItems: "center", gap: 10 }}>
            <div>测试结果</div>
            {ran && (
              <span style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>
                共 {results.length} 条 · 阈值 {threshold} 以上
              </span>
            )}
          </div>
          <div style={{ padding: "16px 18px", height: 560, overflowY: "auto" }}>
            {ran ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {results.map(r => (
                  <div
                    key={r.rank}
                    style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                        padding: "9px 14px",
                        background: "#fafafa",
                        borderBottom: "1px solid #f0f0f0",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: "#1677ff",
                          background: "#e6f4ff",
                          borderRadius: 4,
                          padding: "1px 7px",
                        }}
                      >
                        #{r.rank}
                      </span>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "#1677ff",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {r.hybrid}
                      </span>
                      <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>混合</span>
                      <span
                        style={{
                          fontSize: 12,
                          color: "rgba(0,0,0,.45)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {r.kw} 关键词
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          color: "rgba(0,0,0,.45)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {r.vec} 向量
                      </span>
                      <div style={{ flex: 1 }} />
                      <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>{r.source}</span>
                    </div>
                    <div
                      style={{
                        padding: "12px 14px",
                        fontSize: 13,
                        lineHeight: 1.85,
                        color: "rgba(0,0,0,.82)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {r.text}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "rgba(0,0,0,.3)",
                  fontSize: 13,
                  gap: 8,
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: "#f5f5f5",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 20,
                    color: "rgba(0,0,0,.2)",
                  }}
                >
                  ⌕
                </div>
                输入问题并点击「运行」查看召回结果
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={fieldLabel}>{label}</div>
      {children}
    </div>
  );
}
