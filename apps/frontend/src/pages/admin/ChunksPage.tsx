import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { KB_DOCS, chunkBodiesOf } from "../../mocks/knowledge-bases";

/** 文档切片：左原文 + 右切片结果（选择/启停/删除/全文-省略/搜索，对齐原型，纯本地 mock）。M4 接真实 /api/chunks。 */

interface ChunkView {
  key: string;
  idx: number;
  tokens: number;
  body: string;
  stateLabel: string;
  bd: string;
  cardBg: string;
  textC: string;
  swBg: string;
  swX: string;
  selBd: string;
  selBg: string;
  selMark: string;
  match: boolean;
}

export default function ChunksPage() {
  const navigate = useNavigate();
  const { kbId = "", docId = "" } = useParams<{ kbId: string; docId: string }>();
  const kbName = decodeURIComponent(kbId);
  const docName = decodeURIComponent(docId);
  const doc = (KB_DOCS[kbName] || []).find(d => d.name === docName);

  const [chunkOff, setChunkOff] = useState<Record<string, boolean>>({});
  const [chunkSel, setChunkSel] = useState<Record<string, boolean>>({});
  const [chunkDel, setChunkDel] = useState<Record<string, boolean>>({});
  const [chunkMode, setChunkMode] = useState<"full" | "brief">("brief");
  const [chunkQuery, setChunkQuery] = useState("");

  const { fullText, chunks } = useMemo(() => {
    if (!doc) return { fullText: "", chunks: [] as ChunkView[] };
    const bodies = chunkBodiesOf(docName, doc.chunks);
    const full = bodies.join("\n\n");
    const q = chunkQuery.trim();
    const base = `${kbName}::${docName}`;
    const views: ChunkView[] = bodies
      .map((body, i) => {
        const ck = `${base}#${i}`;
        const on = !chunkOff[ck];
        const sel = !!chunkSel[ck];
        const del = !!chunkDel[ck];
        const full = chunkMode === "full";
        const shown = full ? body : body.length > 64 ? body.slice(0, 64) + "…" : body;
        return {
          key: ck,
          idx: i + 1,
          tokens: Math.round(body.length * 1.4),
          body: shown,
          stateLabel: on ? "已启用" : "已禁用",
          bd: sel ? "#1677ff" : on ? "#91caff" : "#f0f0f0",
          cardBg: on ? "#fff" : "#fafafa",
          textC: on ? "rgba(0,0,0,.82)" : "rgba(0,0,0,.35)",
          swBg: on ? "#1677ff" : "#d9d9d9",
          swX: on ? "18px" : "2px",
          selBd: sel ? "#1677ff" : "#d9d9d9",
          selBg: sel ? "#1677ff" : "#fff",
          selMark: sel ? "✓" : "",
          match: (!q || body.includes(q)) && !del,
          on,
        };
      })
      .filter(c => c.match);
    return { fullText: full, chunks: views };
  }, [doc, docName, kbName, chunkOff, chunkSel, chunkDel, chunkMode, chunkQuery]);

  if (!doc) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "rgba(0,0,0,.45)", fontSize: 13 }}>
        未找到该文档，<span style={{ color: "#1677ff", cursor: "pointer" }} onClick={() => navigate(-1)}>返回</span>
      </div>
    );
  }

  const visibleKeys = chunks.map(c => c.key);
  const selKeys = visibleKeys.filter(k => chunkSel[k]);
  const allSelected = visibleKeys.length > 0 && visibleKeys.every(k => chunkSel[k]);
  const hasSel = selKeys.length > 0;
  const batchC = hasSel ? "rgba(0,0,0,.65)" : "rgba(0,0,0,.25)";
  const batchCur = hasSel ? "pointer" : "not-allowed";

  const toggleSelect = (ck: string, sel: boolean) => {
    setChunkSel(prev => {
      const next = { ...prev };
      if (sel) next[ck] = true;
      else delete next[ck];
      return next;
    });
  };
  const toggleOff = (ck: string, on: boolean) => {
    setChunkOff(prev => {
      const next = { ...prev };
      if (!on) next[ck] = true;
      else delete next[ck];
      return next;
    });
  };
  const selectAll = () => {
    setChunkSel(() => {
      if (allSelected) return {};
      const m: Record<string, boolean> = {};
      visibleKeys.forEach(k => (m[k] = true));
      return m;
    });
  };
  const batchEnable = () => {
    if (!hasSel) return;
    setChunkOff(prev => {
      const next = { ...prev };
      selKeys.forEach(k => delete next[k]);
      return next;
    });
    setChunkSel({});
  };
  const batchDisable = () => {
    if (!hasSel) return;
    setChunkOff(prev => {
      const next = { ...prev };
      selKeys.forEach(k => (next[k] = true));
      return next;
    });
    setChunkSel({});
  };
  const batchDelete = () => {
    if (!hasSel) return;
    setChunkDel(prev => {
      const next = { ...prev };
      selKeys.forEach(k => (next[k] = true));
      return next;
    });
    setChunkSel({});
  };

  const size = `${12 + doc.chunks} KB`;
  const uploaded = `2026-${doc.updated} 01:35`;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div
          onClick={() => navigate(`/admin/knowledge-bases/${encodeURIComponent(kbName)}/documents`)}
          style={backBtn}
        >
          ← 返回
        </div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{docName}</div>
        <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>
          {size} · 上传于 {uploaded}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
        <div style={card}>
          <div style={cardHead}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>原文</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 2 }}>文档解析后的完整文本。</div>
          </div>
          <div
            style={{
              padding: 18,
              height: 560,
              overflowY: "auto",
              fontSize: 13,
              lineHeight: 1.9,
              color: "rgba(0,0,0,.75)",
              whiteSpace: "pre-wrap",
            }}
          >
            {fullText}
          </div>
        </div>

        <div style={card}>
          <div style={cardHead}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>切片结果</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 2 }}>查看用于嵌入和召回的切片段落。</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <div onClick={selectAll} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", userSelect: "none" }}>
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    border: `1.5px solid ${allSelected ? "#1677ff" : "#d9d9d9"}`,
                    background: allSelected ? "#1677ff" : "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontSize: 11,
                  }}
                >
                  {allSelected ? "✓" : ""}
                </div>
                <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>选择所有</span>
              </div>
              <div onClick={batchEnable} style={{ ...batchBtn, color: batchC, cursor: batchCur }}>◉ 启用</div>
              <div onClick={batchDisable} style={{ ...batchBtn, color: batchC, cursor: batchCur }}>◍ 禁用</div>
              <div
                onClick={batchDelete}
                style={{
                  ...batchBtn,
                  border: `1px solid ${hasSel ? "#ffccc7" : "#d9d9d9"}`,
                  color: hasSel ? "#ff4d4f" : "rgba(0,0,0,.25)",
                  cursor: batchCur,
                }}
              >
                🗑 删除
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", border: "1px solid #d9d9d9", borderRadius: 6, overflow: "hidden" }}>
                <div
                  onClick={() => setChunkMode("full")}
                  style={{
                    fontSize: 12,
                    lineHeight: "26px",
                    padding: "0 12px",
                    cursor: "pointer",
                    background: chunkMode === "full" ? "#1677ff" : "#fff",
                    color: chunkMode === "full" ? "#fff" : "rgba(0,0,0,.65)",
                  }}
                >
                  全文
                </div>
                <div
                  onClick={() => setChunkMode("brief")}
                  style={{
                    fontSize: 12,
                    lineHeight: "26px",
                    padding: "0 12px",
                    cursor: "pointer",
                    background: chunkMode === "brief" ? "#1677ff" : "#fff",
                    color: chunkMode === "brief" ? "#fff" : "rgba(0,0,0,.65)",
                    borderLeft: "1px solid #d9d9d9",
                  }}
                >
                  省略
                </div>
              </div>
              <input
                value={chunkQuery}
                onChange={e => setChunkQuery(e.target.value)}
                placeholder="搜索"
                style={{ width: 150, height: 28, padding: "0 12px", border: "1px solid #d9d9d9", borderRadius: 6, fontSize: 13, outline: "none" }}
              />
            </div>
            {hasSel && (
              <div style={{ fontSize: 12, color: "#1677ff", marginTop: 10 }}>已选择 {selKeys.length} 个切片</div>
            )}
          </div>
          <div style={{ padding: "14px 18px", height: 496, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
            {chunks.length === 0 ? (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "rgba(0,0,0,.3)",
                  fontSize: 13,
                }}
              >
                没有匹配的切片
              </div>
            ) : (
              chunks.map(c => (
                <div key={c.key} style={{ border: `1px solid ${c.bd}`, borderRadius: 8, overflow: "hidden", background: c.cardBg }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 12px",
                      background: "#fafafa",
                      borderBottom: "1px solid #f0f0f0",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div
                        onClick={() => toggleSelect(c.key, !chunkSel[c.key])}
                        style={{
                          width: 16,
                          height: 16,
                          flex: "none",
                          borderRadius: 4,
                          border: `1.5px solid ${c.selBd}`,
                          background: c.selBg,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        {c.selMark}
                      </div>
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
                        #{c.idx}
                      </span>
                      <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                        {c.tokens} tokens · {c.stateLabel}
                      </span>
                    </div>
                    <div
                      onClick={() => toggleOff(c.key, !!chunkOff[c.key])}
                      style={{
                        width: 36,
                        height: 20,
                        flex: "none",
                        borderRadius: 10,
                        background: c.swBg,
                        position: "relative",
                        cursor: "pointer",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          top: 2,
                          left: c.swX,
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          background: "#fff",
                          transition: "left .15s",
                        }}
                      />
                    </div>
                  </div>
                  <div
                    style={{
                      padding: "12px 14px",
                      fontSize: 13,
                      lineHeight: 1.85,
                      color: c.textC,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {c.body}
                  </div>
                </div>
              ))
            )}
          </div>
          <div
            style={{
              padding: "10px 18px",
              borderTop: "1px solid #f0f0f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 14,
              fontSize: 13,
              color: "rgba(0,0,0,.55)",
            }}
          >
            <span>总共 {chunks.length} 条</span>
            <div style={{ display: "flex", gap: 4 }}>
              <div style={pageBtn}>‹</div>
              <div style={{ ...pageBtn, border: "1px solid #1677ff", color: "#1677ff" }}>1</div>
              <div style={pageBtn}>›</div>
            </div>
          </div>
        </div>
      </div>
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
};

const batchBtn: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  height: 28,
  padding: "0 12px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  fontSize: 12,
};

const pageBtn: CSSProperties = {
  width: 26,
  height: 26,
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "rgba(0,0,0,.35)",
};
