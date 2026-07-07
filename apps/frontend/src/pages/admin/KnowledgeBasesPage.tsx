import { useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { KB_ROWS, KB_EMBED } from "../../mocks/knowledge-bases";
import { tagOf } from "../../mocks/agents";

/** 知识库管理：卡片网格（对齐原型）。点击卡片 / 「进入」跳文档页。M4 接真实 /api/knowledge-bases。 */

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
  userSelect: "none",
};

const linkBlue: CSSProperties = { color: "#1677ff", cursor: "pointer" };

const kbCard: CSSProperties = {
  background: "#fff",
  border: "1px solid #f0f0f0",
  borderRadius: 10,
  padding: "18px 20px",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

export default function KnowledgeBasesPage() {
  const [rows] = useState(KB_ROWS);
  const nav = useNavigate();

  const goDocs = (name: string) => nav(`/admin/knowledge-bases/${encodeURIComponent(name)}/documents`);

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>知识库</div>
        <div style={btnPrimary}>＋ 新建知识库</div>
      </div>
      <div
        style={{
          fontSize: 13,
          color: "rgba(0,0,0,.5)",
          marginBottom: 18,
          lineHeight: 1.7,
          maxWidth: 760,
        }}
      >
        每个知识库是一组文档的集合。上传的文档会被解析、切片、向量化后存入所属知识库，供绑定它的 Agent 检索。
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 16,
        }}
      >
        {rows.map(r => {
          const t = tagOf(r.tag);
          return (
            <div key={r.name} style={kbCard} onClick={() => goDocs(r.name)}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    flex: "none",
                    borderRadius: 9,
                    background: "#e6f4ff",
                    color: "#1677ff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <ellipse cx="12" cy="5" rx="9" ry="3" />
                    <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                    <path d="M3 12a9 3 0 0 0 18 0" />
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{r.name}</span>
                    <span
                      style={{
                        fontSize: 11,
                        lineHeight: "18px",
                        padding: "0 7px",
                        borderRadius: 9,
                        background: t.bg,
                        color: t.c,
                        border: `1px solid ${t.bd}`,
                      }}
                    >
                      {r.st}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 3 }}>{r.desc}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 26 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1 }}>{r.docs}</div>
                  <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 4 }}>文档</div>
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1 }}>{r.chunks}</div>
                  <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 4 }}>切片</div>
                </div>
                <div style={{ flex: 1 }} />
                <div
                  style={{
                    fontSize: 12,
                    color: "rgba(0,0,0,.4)",
                    textAlign: "right",
                    lineHeight: 1.5,
                  }}
                >
                  Embedding
                  <br />
                  {KB_EMBED}
                </div>
              </div>
              <div
                style={{
                  borderTop: "1px solid #f5f5f5",
                  paddingTop: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>更新于 {r.updated}</span>
                <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
                  <span
                    style={linkBlue}
                    onClick={e => {
                      e.stopPropagation();
                      goDocs(r.name);
                    }}
                  >
                    上传文档
                  </span>
                  <span
                    style={linkBlue}
                    onClick={e => {
                      e.stopPropagation();
                      goDocs(r.name);
                    }}
                  >
                    进入 →
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
