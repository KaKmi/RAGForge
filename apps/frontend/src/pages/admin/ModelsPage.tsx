import { useState, type CSSProperties, type ReactNode } from "react";
import {
  LLM_ROWS,
  MODEL_TYPES,
  LLM_TABS,
  type ModelDraft,
  type ModelType,
  type LlmRow,
} from "../../mocks/models";
import { tagOf } from "../../mocks/agents";

/** 模型调用管理：Tab + 列表 + 启用开关 + 接入抽屉（对齐原型）。M3 接真实 /api/models。 */

const COLS = "200px 110px 110px 1fr 90px 130px";

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
  justifyContent: "space-between",
  alignItems: "center",
};

const inputStyle: CSSProperties = {
  height: 38,
  padding: "0 12px",
  border: "1px solid #d9d9d9",
  borderRadius: 6,
  fontSize: 14,
  outline: "none",
  width: "100%",
  fontFamily: "ui-monospace, Menlo, monospace",
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

export default function ModelsPage() {
  const [rows, setRows] = useState<LlmRow[]>(LLM_ROWS);
  const [tab, setTab] = useState<(typeof LLM_TABS)[number]>("全部");
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState(false);
  const [mf, setMf] = useState<ModelDraft>({
    type: "LLM",
    prov: MODEL_TYPES.LLM.provs[0],
    name: "",
    base: MODEL_TYPES.LLM.base,
    key: "",
  });
  const [mfErr, setMfErr] = useState("");
  const [tested, setTested] = useState(false);

  const filtered = rows.filter(r => tab === "全部" || r.type === tab);

  const isOn = (r: LlmRow) => (off[r.m] === undefined ? !r.off : !off[r.m]);

  const toggle = (m: string) => {
    const row = rows.find(r => r.m === m);
    if (!row) return;
    const cur = isOn(row);
    setOff(prev => ({ ...prev, [m]: cur }));
  };

  const openDrawer = () => {
    const d = MODEL_TYPES.LLM;
    setMf({ type: "LLM", prov: d.provs[0], name: "", base: d.base, key: "" });
    setMfErr("");
    setTested(false);
    setOpen(true);
  };

  const set = (patch: Partial<ModelDraft>) => {
    setMf(prev => ({ ...prev, ...patch }));
    setMfErr("");
  };

  const pickType = (ty: ModelType) => {
    const d = MODEL_TYPES[ty];
    setMf({ type: ty, prov: d.provs[0], name: "", base: d.base, key: "" });
    setTested(false);
    setMfErr("");
  };

  const save = () => {
    if (!mf.name.trim()) {
      setMfErr("请填写模型名称 / 部署 ID");
      return;
    }
    if (!mf.key.trim()) {
      setMfErr("请填写 API Key");
      return;
    }
    setRows(prev => [
      ...prev,
      { m: mf.name.trim(), type: mf.type, role: "新接入 · 待启用", prov: mf.prov },
    ]);
    setTab(mf.type);
    setOpen(false);
  };

  const mtDef = MODEL_TYPES[mf.type];

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600 }}>模型接入</div>
        <div onClick={openDrawer} style={btnPrimary}>
          ＋ 接入模型
        </div>
      </div>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)", margin: "8px 0 16px" }}>
        管理 LLM、Rerank、Embedding 三类模型的接入配置。
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {LLM_TABS.map(t => {
          const on = tab === t;
          const count = t === "全部" ? rows.length : rows.filter(r => r.type === t).length;
          return (
            <div
              key={t}
              onClick={() => setTab(t)}
              style={{
                height: 30,
                padding: "0 14px",
                borderRadius: 6,
                border: `1px solid ${on ? "#1677ff" : "#d9d9d9"}`,
                background: on ? "#e6f4ff" : "#fff",
                color: on ? "#1677ff" : "rgba(0,0,0,.65)",
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              {t} <span style={{ fontSize: 11, opacity: 0.7 }}>{count}</span>
            </div>
          );
        })}
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
          <div>模型名称</div>
          <div>类型</div>
          <div>提供商</div>
          <div>用途</div>
          <div>启用</div>
          <div>操作</div>
        </div>
        {filtered.map(r => {
          const t = tagOf(MODEL_TYPES[r.type].tag);
          const on = isOn(r);
          return (
            <div
              key={r.m}
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                padding: "12px 16px",
                borderBottom: "1px solid #f0f0f0",
                fontSize: 13,
                alignItems: "center",
              }}
            >
              <div
                style={{
                  fontWeight: 500,
                  fontFamily: "ui-monospace, Menlo, monospace",
                  fontSize: 12,
                }}
              >
                {r.m}
              </div>
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
                  {r.type}
                </span>
              </div>
              <div style={{ color: "rgba(0,0,0,.65)" }}>{r.prov}</div>
              <div style={{ color: "rgba(0,0,0,.55)" }}>{r.role}</div>
              <div>
                <div
                  onClick={() => toggle(r.m)}
                  style={{
                    width: 40,
                    height: 22,
                    flex: "none",
                    borderRadius: 11,
                    background: on ? "#1677ff" : "#d9d9d9",
                    position: "relative",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      top: 2,
                      left: on ? "20px" : "2px",
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      background: "#fff",
                      transition: "left .15s",
                    }}
                  />
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
                <span style={linkBlue}>编辑</span>
                <span style={linkBlue}>测试</span>
                <span style={linkGray}>删除</span>
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
              <div style={{ fontSize: 16, fontWeight: 600 }}>接入模型</div>
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
              <Field label="模型类型">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {(["LLM", "Rerank", "Embedding"] as ModelType[]).map(ty => {
                    const on = mf.type === ty;
                    const d = MODEL_TYPES[ty];
                    return (
                      <div
                        key={ty}
                        onClick={() => pickType(ty)}
                        style={{
                          padding: 12,
                          borderRadius: 8,
                          border: `1px solid ${on ? "#1677ff" : "#f0f0f0"}`,
                          background: on ? "#e6f4ff" : "#fff",
                          cursor: "pointer",
                          textAlign: "center",
                          userSelect: "none",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: on ? "#1677ff" : "rgba(0,0,0,.88)",
                          }}
                        >
                          {ty}
                        </div>
                        <div style={{ fontSize: 11, color: "rgba(0,0,0,.45)", marginTop: 3 }}>
                          {d.hint}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Field>

              <Field label="提供商">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {mtDef.provs.map(p => {
                    const on = mf.prov === p;
                    return (
                      <div
                        key={p}
                        onClick={() => set({ prov: p })}
                        style={{
                          height: 32,
                          padding: "0 14px",
                          borderRadius: 6,
                          border: `1px solid ${on ? "#1677ff" : "#d9d9d9"}`,
                          background: on ? "#e6f4ff" : "#fff",
                          color: on ? "#1677ff" : "rgba(0,0,0,.65)",
                          fontSize: 13,
                          lineHeight: "32px",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        {p}
                      </div>
                    );
                  })}
                </div>
              </Field>

              <Field label="模型名称 / 部署 ID" required>
                <input
                  value={mf.name}
                  onChange={e => set({ name: e.target.value })}
                  placeholder={mtDef.namePh}
                  style={inputStyle}
                />
              </Field>
              <Field label="API Base URL">
                <input
                  value={mf.base}
                  onChange={e => set({ base: e.target.value })}
                  placeholder="https://api.provider.com/v1"
                  style={inputStyle}
                />
              </Field>
              <Field label="API Key" required>
                <input
                  type="password"
                  value={mf.key}
                  onChange={e => set({ key: e.target.value })}
                  placeholder="sk-••••••••••••"
                  style={inputStyle}
                />
              </Field>

              <Field label={mtDef.paramLabel}>
                <div style={{ display: "flex", gap: 12 }}>
                  {mtDef.params.map(p => (
                    <div
                      key={p.k}
                      style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}
                    >
                      <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>{p.k}</div>
                      <div
                        style={{
                          height: 34,
                          padding: "0 12px",
                          border: "1px solid #f0f0f0",
                          borderRadius: 6,
                          background: "#fafafa",
                          display: "flex",
                          alignItems: "center",
                          fontSize: 13,
                          color: "rgba(0,0,0,.75)",
                        }}
                      >
                        {p.v}
                      </div>
                    </div>
                  ))}
                </div>
              </Field>

              {mfErr && <div style={{ fontSize: 13, color: "#ff4d4f" }}>{mfErr}</div>}
            </div>
            <div style={drawerFooter}>
              <div
                onClick={() => setTested(true)}
                style={{
                  height: 36,
                  padding: "0 16px",
                  border: "1px solid #d9d9d9",
                  borderRadius: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  cursor: "pointer",
                  color: tested ? "#52c41a" : "rgba(0,0,0,.65)",
                }}
              >
                {tested ? "✓ 连接正常" : "⚡ 测试连接"}
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <div onClick={() => setOpen(false)} style={btnGhost}>
                  取消
                </div>
                <div onClick={save} style={btnPrimary}>
                  接入
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
