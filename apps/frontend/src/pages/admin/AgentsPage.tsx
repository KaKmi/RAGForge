import { useState, type CSSProperties, type ReactNode } from "react";
import {
  AGENT_ROWS,
  ALL_KBS,
  DF_DEFAULT,
  GEN_MODELS,
  LIGHT_MODELS,
  RERANK_MODELS,
  PROMPT_REWRITE_OPTS,
  PROMPT_INTENT_OPTS,
  PROMPT_REPLY_OPTS,
  PROMPT_FALLBACK_OPTS,
  tagOf,
  type AgentDraft,
  type AgentRow,
} from "../../mocks/agents";

/** Agent 管理：列表 + 新建抽屉（对齐原型，纯本地 mock 态）。M7 接真实 /api/agents。 */

const COLS = "200px 1fr 150px 90px 110px 150px";

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

const btnGhost: CSSProperties = {
  height: 36,
  padding: "0 18px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  display: "flex",
  alignItems: "center",
  fontSize: 14,
  cursor: "pointer",
  userSelect: "none",
};

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,.45)",
  zIndex: 50,
};

const drawerRight: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: 480,
  background: "#fff",
  zIndex: 51,
  display: "flex",
  flexDirection: "column",
  boxShadow: "-4px 0 16px rgba(0,0,0,.12)",
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
  gap: 20,
};

const drawerFooter: CSSProperties = {
  flex: "none",
  borderTop: "1px solid #f0f0f0",
  padding: "14px 24px",
  display: "flex",
  justifyContent: "flex-end",
  gap: 12,
};

const inputStyle: CSSProperties = {
  height: 38,
  padding: "0 12px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  fontSize: 14,
  outline: "none",
  width: "100%",
};

const numInput: CSSProperties = {
  width: 90,
  height: 36,
  padding: "0 10px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  fontSize: 13,
  outline: "none",
  textAlign: "center",
};

const selectStyle: CSSProperties = {
  flex: 1,
  height: 36,
  padding: "0 10px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  fontSize: 13,
  outline: "none",
  background: "#fff",
};

const kbTag: CSSProperties = {
  fontSize: 12,
  lineHeight: "20px",
  padding: "0 8px",
  borderRadius: 4,
  background: "#f5f5f5",
  border: "1px solid #e8e8e8",
  color: "rgba(0,0,0,.65)",
};

const linkBlue: CSSProperties = { color: "#1677ff", cursor: "pointer" };
const linkGray: CSSProperties = { color: "rgba(0,0,0,.45)", cursor: "pointer" };

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>
        {required && <span style={{ color: "#ff4d4f" }}>* </span>}
        {label}
      </div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "#f0f0f0", margin: "2px 0" }} />;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(0,0,0,.88)" }}>{children}</div>;
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 96, flex: "none", fontSize: 13, color: "rgba(0,0,0,.65)" }}>{label}</div>
      <select value={value} onChange={e => onChange(e.target.value)} style={selectStyle}>
        {options.map(o => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div>
        <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>{label}</div>
        <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>{hint}</div>
      </div>
      <div
        onClick={onToggle}
        style={{
          width: 44,
          height: 24,
          flex: "none",
          borderRadius: 12,
          background: on ? "#1677ff" : "#d9d9d9",
          position: "relative",
          cursor: "pointer",
          transition: "background .15s",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 2,
            left: on ? "22px" : "2px",
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .15s",
          }}
        />
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const [rows, setRows] = useState<AgentRow[]>(AGENT_ROWS);
  const [open, setOpen] = useState(false);
  const [df, setDf] = useState<AgentDraft>(DF_DEFAULT);
  const [dfErr, setDfErr] = useState("");

  const set = (patch: Partial<AgentDraft>) => {
    setDf(prev => ({ ...prev, ...patch }));
    setDfErr("");
  };

  const openDrawer = () => {
    setDf({ ...DF_DEFAULT });
    setDfErr("");
    setOpen(true);
  };

  const save = () => {
    const name = df.name.trim();
    if (!name) {
      setDfErr("请填写 Agent 名称");
      return;
    }
    if (!df.kbs.length) {
      setDfErr("请至少绑定一个知识库");
      return;
    }
    const colors = ["#eb2f96", "#fa8c16", "#52c41a", "#2f54eb"];
    const row: AgentRow = {
      name,
      desc: df.desc.trim() || "—",
      initial: name[0],
      color: colors[rows.length % colors.length],
      kbs: df.kbs.slice(),
      model: df.genModel,
      st: "已上线",
      tag: "green",
      updated: "刚刚",
    };
    setRows(prev => [row, ...prev]);
    setOpen(false);
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600 }}>Agent 管理</div>
        <div onClick={openDrawer} style={btnPrimary}>
          ＋ 新建 Agent
        </div>
      </div>

      <div
        style={{
          background: "#fff",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: COLS,
            padding: "12px 16px",
            background: "#fafafa",
            borderBottom: "1px solid #f0f0f0",
            fontSize: 13,
            fontWeight: 600,
            color: "rgba(0,0,0,.65)",
          }}
        >
          <div>Agent</div>
          <div>绑定知识库</div>
          <div>生成模型</div>
          <div>状态</div>
          <div>更新时间</div>
          <div>操作</div>
        </div>
        {rows.map(r => {
          const t = tagOf(r.tag);
          return (
            <div
              key={r.name}
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                padding: "12px 16px",
                borderBottom: "1px solid #f0f0f0",
                fontSize: 13,
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 30,
                    height: 30,
                    flex: "none",
                    borderRadius: 8,
                    background: r.color,
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {r.initial}
                </div>
                <div>
                  <div style={{ fontWeight: 500 }}>{r.name}</div>
                  <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>{r.desc}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {r.kbs.map(kb => (
                  <span key={kb} style={kbTag}>
                    {kb}
                  </span>
                ))}
              </div>
              <div style={{ color: "rgba(0,0,0,.65)" }}>{r.model}</div>
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
              <div style={{ color: "rgba(0,0,0,.45)" }}>{r.updated}</div>
              <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
                <span style={linkBlue}>编辑</span>
                <span style={linkBlue}>评测</span>
                <span style={linkGray}>日志</span>
              </div>
            </div>
          );
        })}
      </div>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={overlay} />
          <div style={drawerRight}>
            <div style={drawerHeader}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>新建 Agent</div>
              <div
                onClick={() => setOpen(false)}
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
            <div style={drawerBody}>
              <Field label="Agent 名称" required>
                <input
                  value={df.name}
                  onChange={e => set({ name: e.target.value })}
                  placeholder="如：售后支持"
                  style={inputStyle}
                />
              </Field>
              <Field label="简介">
                <input
                  value={df.desc}
                  onChange={e => set({ desc: e.target.value })}
                  placeholder="一句话描述 Agent 的职责范围"
                  style={inputStyle}
                />
              </Field>
              <Field label="绑定知识库" required>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {ALL_KBS.map(k => {
                    const on = df.kbs.includes(k);
                    return (
                      <div
                        key={k}
                        onClick={() =>
                          set({ kbs: on ? df.kbs.filter(x => x !== k) : [...df.kbs, k] })
                        }
                        style={{
                          fontSize: 13,
                          lineHeight: "30px",
                          height: 30,
                          padding: "0 12px",
                          borderRadius: 6,
                          border: `1px solid ${on ? "#1677ff" : "#d9d9d9"}`,
                          background: on ? "#e6f4ff" : "#fff",
                          color: on ? "#1677ff" : "rgba(0,0,0,.65)",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        {k}
                      </div>
                    );
                  })}
                </div>
              </Field>

              <Divider />
              <SectionTitle>模型设置</SectionTitle>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <SelectRow
                  label="生成模型"
                  value={df.genModel}
                  options={GEN_MODELS}
                  onChange={v => set({ genModel: v })}
                />
                <SelectRow
                  label="改写 / 意图"
                  value={df.lightModel}
                  options={LIGHT_MODELS}
                  onChange={v => set({ lightModel: v })}
                />
                <SelectRow
                  label="重排模型"
                  value={df.rerankModel}
                  options={RERANK_MODELS}
                  onChange={v => set({ rerankModel: v })}
                />
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)", lineHeight: 1.6 }}>
                  向量嵌入模型由绑定的知识库决定，无需在此单独配置。
                </div>
              </div>

              <Divider />
              <SectionTitle>Prompt 配置</SectionTitle>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <SelectRow
                  label="问题改写"
                  value={df.promptRewrite}
                  options={PROMPT_REWRITE_OPTS}
                  onChange={v => set({ promptRewrite: v })}
                />
                <SelectRow
                  label="意图识别"
                  value={df.promptIntent}
                  options={PROMPT_INTENT_OPTS}
                  onChange={v => set({ promptIntent: v })}
                />
                <SelectRow
                  label="回复生成"
                  value={df.promptReply}
                  options={PROMPT_REPLY_OPTS}
                  onChange={v => set({ promptReply: v })}
                />
                <SelectRow
                  label="兜底话术"
                  value={df.promptFallback}
                  options={PROMPT_FALLBACK_OPTS}
                  onChange={v => set({ promptFallback: v })}
                />
              </div>

              <Divider />
              <SectionTitle>检索设置</SectionTitle>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 96, flex: "none", fontSize: 13, color: "rgba(0,0,0,.65)" }}>
                    召回 Top-K
                  </div>
                  <input
                    value={df.topK}
                    onChange={e => set({ topK: e.target.value.replace(/[^0-9]/g, "") })}
                    style={numInput}
                  />
                  <div
                    style={{
                      width: 70,
                      flex: "none",
                      fontSize: 13,
                      color: "rgba(0,0,0,.65)",
                      marginLeft: 8,
                    }}
                  >
                    重排 Top-N
                  </div>
                  <input
                    value={df.topN}
                    onChange={e => set({ topN: e.target.value.replace(/[^0-9]/g, "") })}
                    style={numInput}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 96, flex: "none", fontSize: 13, color: "rgba(0,0,0,.65)" }}>
                    相似度阈值
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={df.threshold}
                    onChange={e => set({ threshold: e.target.value })}
                    style={{ flex: 1, accentColor: "#1677ff" }}
                  />
                  <div
                    style={{
                      width: 44,
                      textAlign: "right",
                      fontSize: 13,
                      color: "rgba(0,0,0,.75)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {df.threshold}
                  </div>
                </div>
                <ToggleRow
                  label="多路召回（向量 + 关键词）"
                  hint="关闭则仅使用向量召回"
                  on={df.multi}
                  onToggle={() => set({ multi: !df.multi })}
                />
              </div>

              <Divider />
              <ToggleRow
                label="未命中知识时兜底转人工"
                hint="召回分数低于阈值时提示联系人工客服"
                on={df.fallback}
                onToggle={() => set({ fallback: !df.fallback })}
              />
              {dfErr && <div style={{ fontSize: 13, color: "#ff4d4f" }}>{dfErr}</div>}
            </div>
            <div style={drawerFooter}>
              <div onClick={() => setOpen(false)} style={btnGhost}>
                取消
              </div>
              <div onClick={save} style={btnPrimary}>
                创建 Agent
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
