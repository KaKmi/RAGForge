import { useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  KB_DOCS,
  STAGE_DEFS,
  CHUNK_OPTS,
  DOC_FAIL_REASON,
  parseStateOf,
  buildDocLifeStages,
  type KbDoc,
} from "../../mocks/knowledge-bases";
import { tagOf } from "../../mocks/agents";

/** 知识库文档：列表 + 处理生命周期 + 上传抽屉 + 生命周期抽屉（对齐原型，纯本地 mock）。M4 接真实 /api/documents。 */

const DOCS_COLS = "1fr 160px 90px 140px 140px";

const linkBlue: CSSProperties = { color: "#1677ff", cursor: "pointer" };

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.45)",
  zIndex: 50,
};

export default function DocumentsPage() {
  const navigate = useNavigate();
  const { kbId = "" } = useParams<{ kbId: string }>();
  const kbName = decodeURIComponent(kbId);

  const [docs, setDocs] = useState<KbDoc[]>(KB_DOCS[kbName] ? KB_DOCS[kbName].slice() : []);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [picked, setPicked] = useState(false);
  const [chunk, setChunk] = useState(CHUNK_OPTS[0]);
  const [lifeName, setLifeName] = useState<string | null>(null);

  const totalChunks = docs.reduce((s, d) => s + d.chunks, 0);

  const goChunks = (docName: string) =>
    navigate(`/admin/knowledge-bases/${encodeURIComponent(kbName)}/documents/${encodeURIComponent(docName)}/chunks`);

  const removeDoc = (docName: string) => {
    setDocs(prev => prev.filter(d => d.name !== docName));
    if (lifeName === docName) setLifeName(null);
  };

  const confirmUpload = () => {
    if (!picked) return;
    setDocs(prev => [
      { name: "课程常见问题汇总 2026Q3.pdf", type: "PDF", chunks: 19, st: "解析中", tag: "gold", updated: "刚刚" },
      ...prev,
    ]);
    setUploadOpen(false);
    setPicked(false);
    setChunk(CHUNK_OPTS[0]);
  };

  const retryParse = (docName: string) => {
    setDocs(prev => prev.map(d => (d.name === docName ? { ...d, st: "解析中", tag: "gold" } : d)));
  };

  const lifeDoc = lifeName ? docs.find(d => d.name === lifeName) : null;
  const lifeStages = lifeDoc ? buildDocLifeStages(lifeDoc) : [];
  const lifeParse = lifeDoc ? parseStateOf(lifeDoc.tag) : null;
  const lifeTag = lifeDoc ? tagOf(lifeDoc.tag) : null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <div
          onClick={() => navigate("/admin/knowledge-bases")}
          style={backBtn}
        >
          ← 返回列表
        </div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{kbName}</div>
        <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>
          {docs.length} 篇文档 · {totalChunks} 个分块 · 启用后才能被检索
        </span>
        <div style={{ flex: 1 }} />
        <div onClick={() => { setPicked(false); setChunk(CHUNK_OPTS[0]); setUploadOpen(true); }} style={btnPrimary}>
          ＋ 新增文件
        </div>
      </div>

      <div style={legendCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>文档处理生命周期</span>
          <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
            每篇文档需依次完成以下阶段，全部通过后才会纳入检索。点击「解析状态」或「生命周期」查看单篇进度
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          {STAGE_DEFS.map((lg, i) => (
            <div key={lg.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={legendNum}>{i + 1}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{lg.label}</div>
                  <div style={{ fontSize: 11, color: "rgba(0,0,0,.4)" }}>{lg.desc}</div>
                </div>
              </div>
              {i < STAGE_DEFS.length - 1 && (
                <span style={{ color: "#d9d9d9", margin: "0 14px", fontSize: 14 }}>→</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
        <div style={gridHeader}>
          <div>文档</div>
          <div>上传时间</div>
          <div>切片数</div>
          <div>处理状态</div>
          <div>操作</div>
        </div>
        {docs.length === 0 ? (
          <div style={{ padding: "40px 16px", textAlign: "center", fontSize: 13, color: "rgba(0,0,0,.4)" }}>
            该知识库暂无文档，点击「新增文件」上传
          </div>
        ) : (
          docs.map(d => {
            const ps = parseStateOf(d.tag);
            return (
              <div key={d.name} style={gridRow}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <div style={typeIcon}>{d.type}</div>
                  <span onClick={() => goChunks(d.name)} style={docNameLink}>
                    {d.name}
                  </span>
                </div>
                <div style={{ color: "rgba(0,0,0,.45)", fontSize: 12 }}>
                  {d.updated === "刚刚" ? "刚刚" : `2026-${d.updated} 01:35`}
                </div>
                <div onClick={() => goChunks(d.name)} style={linkBlue}>
                  {d.chunks}
                </div>
                <div onClick={() => setLifeName(d.name)} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <span style={{ width: 7, height: 7, flex: "none", borderRadius: "50%", background: ps.dot }} />
                  <span
                    style={{
                      fontSize: 12,
                      color: ps.pc,
                      textDecoration: "underline dotted",
                      textUnderlineOffset: 2,
                    }}
                  >
                    {ps.parse}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 14, fontSize: 13, color: "rgba(0,0,0,.45)" }}>
                  <span onClick={() => goChunks(d.name)} style={linkBlue}>
                    查看切片
                  </span>
                  <span onClick={() => removeDoc(d.name)} style={{ cursor: "pointer" }}>
                    删除
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {uploadOpen && (
        <>
          <div onClick={() => setUploadOpen(false)} style={overlay} />
          <div style={drawerRight(460)}>
            <div style={drawerHeader}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>上传文档 · {kbName}</div>
              <div onClick={() => setUploadOpen(false)} style={closeBtn}>
                ×
              </div>
            </div>
            <div style={{ ...drawerBody, gap: 20 }}>
              <div
                onClick={() => setPicked(true)}
                style={{
                  border: "1.5px dashed #d9d9d9",
                  borderRadius: 8,
                  padding: "32px 20px",
                  textAlign: "center",
                  cursor: "pointer",
                  background: "#fafafa",
                }}
              >
                <div style={{ fontSize: 26, color: "#1677ff", marginBottom: 8 }}>⬆</div>
                <div style={{ fontSize: 14, color: "rgba(0,0,0,.75)", marginBottom: 4 }}>点击选择文件或拖拽到此处</div>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>支持 PDF / Word / Markdown / TXT，单文件 ≤ 20MB</div>
              </div>
              {picked && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid #f0f0f0", borderRadius: 6 }}>
                  <div style={{ ...typeIcon, width: 28, height: 28 }}>PDF</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      课程常见问题汇总 2026Q3.pdf
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>1.8 MB</div>
                  </div>
                  <div style={{ fontSize: 12, color: "#52c41a" }}>就绪</div>
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>分块策略</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {CHUNK_OPTS.map(c => {
                    const on = chunk === c;
                    return (
                      <div
                        key={c}
                        onClick={() => setChunk(c)}
                        style={{
                          flex: 1,
                          textAlign: "center",
                          fontSize: 13,
                          lineHeight: "36px",
                          height: 36,
                          borderRadius: 6,
                          border: `1px solid ${on ? "#1677ff" : "#d9d9d9"}`,
                          background: on ? "#e6f4ff" : "#fff",
                          color: on ? "#1677ff" : "rgba(0,0,0,.65)",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        {c}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div style={drawerFooter}>
              <div onClick={() => setUploadOpen(false)} style={btnGhost}>
                取消
              </div>
              <div
                onClick={confirmUpload}
                style={{
                  height: 36,
                  padding: "0 18px",
                  background: picked ? "#1677ff" : "#bfbfbf",
                  color: "#fff",
                  borderRadius: 6,
                  display: "flex",
                  alignItems: "center",
                  fontSize: 14,
                  cursor: picked ? "pointer" : "not-allowed",
                }}
              >
                开始上传并解析
              </div>
            </div>
          </div>
        </>
      )}

      {lifeDoc && lifeParse && lifeTag && (
        <>
          <div onClick={() => setLifeName(null)} style={overlay} />
          <div style={drawerRight(480)}>
            <div style={drawerHeader}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600, flex: "none" }}>文档生命周期</div>
                <span
                  style={{
                    fontSize: 12,
                    lineHeight: "20px",
                    padding: "0 8px",
                    borderRadius: 4,
                    background: lifeTag.bg,
                    color: lifeTag.c,
                    border: `1px solid ${lifeTag.bd}`,
                    flex: "none",
                  }}
                >
                  {lifeParse.parse}
                </span>
              </div>
              <div onClick={() => setLifeName(null)} style={closeBtn}>
                ×
              </div>
            </div>
            <div style={{ ...drawerBody, padding: "20px 24px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
                <div style={typeIcon}>{lifeDoc.type}</div>
                <div
                  style={{
                    fontSize: 13,
                    color: "rgba(0,0,0,.7)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {lifeDoc.name}
                </div>
              </div>

              {lifeDoc.tag === "red" && (
                <div
                  style={{
                    border: "1px solid #ffccc7",
                    background: "#fff2f0",
                    borderRadius: 8,
                    padding: "14px 16px",
                    marginBottom: 22,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          flex: "none",
                          borderRadius: "50%",
                          background: "#ff4d4f",
                          color: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        ✕
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#cf1322" }}>「解析」阶段失败</span>
                    </div>
                    <div
                      onClick={() => retryParse(lifeDoc.name)}
                      style={{
                        height: 30,
                        padding: "0 14px",
                        background: "#ff4d4f",
                        color: "#fff",
                        borderRadius: 6,
                        display: "flex",
                        alignItems: "center",
                        fontSize: 13,
                        cursor: "pointer",
                        userSelect: "none",
                        flex: "none",
                      }}
                    >
                      重新解析
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "#874d00", lineHeight: 1.7, marginTop: 8 }}>{DOC_FAIL_REASON}</div>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column" }}>
                {lifeStages.map((s, i) => (
                  <div key={i} style={{ display: "flex", gap: 14 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "none" }}>
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          flex: "none",
                          borderRadius: "50%",
                          background: s.bg,
                          border: `1.5px solid ${s.bd}`,
                          color: s.c,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 13,
                          fontWeight: 700,
                        }}
                      >
                        {s.icon}
                      </div>
                      {s.notLast && (
                        <div style={{ width: 2, flex: 1, minHeight: 30, background: s.line }} />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0, paddingBottom: 20 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{s.label}</span>
                        <span
                          style={{
                            fontSize: 11,
                            lineHeight: "18px",
                            padding: "0 7px",
                            borderRadius: 9,
                            background: s.bg,
                            color: s.c,
                            border: `1px solid ${s.bd}`,
                          }}
                        >
                          {s.statusLabel}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 3 }}>{s.desc}</div>
                      <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)", marginTop: 5 }}>
                        耗时 {s.dur} · {s.time}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const backBtn: CSSProperties = {
  height: 30,
  padding: "0 12px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  background: "#fff",
  display: "flex",
  alignItems: "center",
  fontSize: 13,
  cursor: "pointer",
};

const btnPrimary: CSSProperties = {
  height: 32,
  padding: "0 16px",
  background: "#1677ff",
  color: "#fff",
  borderRadius: 6,
  display: "flex",
  alignItems: "center",
  fontSize: 13,
  cursor: "pointer",
};

const btnGhost: CSSProperties = {
  height: 36,
  padding: "0 18px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  display: "flex",
  alignItems: "center",
  fontSize: 14,
  cursor: "pointer",
};

const legendCard: CSSProperties = {
  background: "#fff",
  border: "1px solid #f0f0f0",
  borderRadius: 8,
  padding: "14px 18px",
  margin: "10px 0 16px",
};

const legendNum: CSSProperties = {
  width: 24,
  height: 24,
  flex: "none",
  borderRadius: "50%",
  background: "#e6f4ff",
  color: "#1677ff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 600,
};

const typeIcon: CSSProperties = {
  width: 24,
  height: 24,
  flex: "none",
  borderRadius: 5,
  background: "#e6f4ff",
  color: "#1677ff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 10,
  fontWeight: 600,
};

const gridHeader: CSSProperties = {
  display: "grid",
  gridTemplateColumns: DOCS_COLS,
  padding: "12px 16px",
  background: "#fafafa",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  fontWeight: 600,
  color: "rgba(0,0,0,.65)",
};

const gridRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: DOCS_COLS,
  padding: "12px 16px",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  alignItems: "center",
};

const docNameLink: CSSProperties = {
  fontWeight: 500,
  color: "#1677ff",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const closeBtn: CSSProperties = {
  fontSize: 18,
  color: "rgba(0,0,0,.45)",
  cursor: "pointer",
  width: 28,
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
};

const drawerHeader: CSSProperties = {
  height: 56,
  flex: "none",
  borderBottom: "1px solid #f0f0f0",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 24px",
};

const drawerBody: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 24,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

const drawerFooter: CSSProperties = {
  flex: "none",
  borderTop: "1px solid #f0f0f0",
  padding: "14px 24px",
  display: "flex",
  justifyContent: "flex-end",
  gap: 12,
};

function drawerRight(width: number): CSSProperties {
  return {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width,
    background: "#fff",
    zIndex: 51,
    display: "flex",
    flexDirection: "column",
    boxShadow: "-4px 0 16px rgba(0,0,0,.12)",
  };
}
