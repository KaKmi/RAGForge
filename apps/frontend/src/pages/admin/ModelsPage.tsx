import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ModelProvider, ModelType, TestModelResponse } from "@codecrush/contracts";
import {
  createModel,
  deleteModel,
  getModels,
  testModel,
  testModelConfig,
  updateModel,
} from "../../api/client";
import { MODEL_TABS, MODEL_TYPES, TYPE_LABEL, type ModelDraft } from "../../mocks/models";
import { tagOf } from "../../mocks/agents";

/** 模型调用管理：Tab + 列表 + 启用开关 + 接入/编辑抽屉（M3 接真实 /api/models）。 */

const COLS = "200px 110px 110px 1fr 90px 160px";

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

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ModelsPage() {
  const [rows, setRows] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState("");
  const [tab, setTab] = useState<"all" | ModelType>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowTest, setRowTest] = useState<Record<string, TestModelResponse>>({});

  const [open, setOpen] = useState(false);
  const [mf, setMf] = useState<ModelDraft>({
    type: "llm",
    provider: MODEL_TYPES.llm.provs[0],
    name: "",
    baseUrl: MODEL_TYPES.llm.base,
    apiKey: "",
  });
  const [editingMasked, setEditingMasked] = useState("");
  const [mfErr, setMfErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testErr, setTestErr] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setListErr("");
    try {
      setRows(await getModels());
    } catch (e) {
      setListErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = rows.filter(r => tab === "all" || r.type === tab);

  const toggle = async (r: ModelProvider) => {
    if (busyId) return;
    setBusyId(r.id);
    try {
      await updateModel(r.id, { enabled: !r.enabled });
      await refresh();
    } catch (e) {
      setListErr(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const runRowTest = async (r: ModelProvider) => {
    if (busyId) return;
    setBusyId(r.id);
    try {
      const res = await testModel(r.id);
      setRowTest(prev => ({ ...prev, [r.id]: res }));
    } catch (e) {
      setRowTest(prev => ({ ...prev, [r.id]: { ok: false, error: errMsg(e) } }));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (r: ModelProvider) => {
    if (busyId) return;
    if (!window.confirm(`确认删除模型「${r.name}」？`)) return;
    setBusyId(r.id);
    try {
      await deleteModel(r.id);
      await refresh();
    } catch (e) {
      setListErr(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const resetDrawerState = () => {
    setMfErr("");
    setTestState("idle");
    setTestErr("");
  };

  const openCreate = () => {
    const d = MODEL_TYPES.llm;
    setMf({ type: "llm", provider: d.provs[0], name: "", baseUrl: d.base, apiKey: "" });
    setEditingMasked("");
    resetDrawerState();
    setOpen(true);
  };

  const openEdit = (r: ModelProvider) => {
    setMf({
      id: r.id,
      type: r.type,
      provider: r.provider,
      name: r.name,
      baseUrl: r.baseUrl,
      apiKey: "",
    });
    setEditingMasked(r.apiKeyMasked);
    resetDrawerState();
    setOpen(true);
  };

  const set = (patch: Partial<ModelDraft>) => {
    setMf(prev => ({ ...prev, ...patch }));
    setMfErr("");
    setTestState("idle");
  };

  const pickType = (ty: ModelType) => {
    const d = MODEL_TYPES[ty];
    setMf(prev => ({ ...prev, type: ty, provider: d.provs[0], baseUrl: d.base }));
    resetDrawerState();
  };

  // 编辑模式且未填新 key → 用已存 key 测试（testModel）；否则 ad-hoc 测试表单值
  const drawerTest = async () => {
    if (!mf.name.trim()) {
      setMfErr("请填写模型名称 / 部署 ID");
      return;
    }
    if (!mf.id && mf.apiKey.trim().length < 8) {
      setMfErr("请填写 API Key（至少 8 位）");
      return;
    }
    setTestState("testing");
    setTestErr("");
    try {
      const res =
        mf.id && !mf.apiKey.trim()
          ? await testModel(mf.id)
          : await testModelConfig({
              type: mf.type,
              provider: mf.provider,
              name: mf.name.trim(),
              baseUrl: mf.baseUrl.trim(),
              apiKey: mf.apiKey,
            });
      setTestState(res.ok ? "ok" : "fail");
      if (!res.ok) setTestErr(res.error ?? "连接失败");
    } catch (e) {
      setTestState("fail");
      setTestErr(errMsg(e));
    }
  };

  const save = async () => {
    if (!mf.name.trim()) {
      setMfErr("请填写模型名称 / 部署 ID");
      return;
    }
    if (!mf.id && mf.apiKey.trim().length < 8) {
      setMfErr("请填写 API Key（至少 8 位）");
      return;
    }
    setSaving(true);
    try {
      if (mf.id) {
        await updateModel(mf.id, {
          type: mf.type,
          provider: mf.provider,
          name: mf.name.trim(),
          baseUrl: mf.baseUrl.trim(),
          ...(mf.apiKey.trim() ? { apiKey: mf.apiKey } : {}),
        });
      } else {
        await createModel({
          type: mf.type,
          provider: mf.provider,
          name: mf.name.trim(),
          baseUrl: mf.baseUrl.trim(),
          apiKey: mf.apiKey,
          enabled: true,
        });
      }
      setOpen(false);
      setTab(mf.type);
      await refresh();
    } catch (e) {
      setMfErr(errMsg(e));
    } finally {
      setSaving(false);
    }
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
        <div onClick={openCreate} style={btnPrimary}>
          ＋ 接入模型
        </div>
      </div>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)", margin: "8px 0 16px" }}>
        管理 LLM、Rerank、Embedding 三类模型的接入配置。
      </div>

      {listErr && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            border: "1px solid #ffccc7",
            background: "#fff2f0",
            borderRadius: 6,
            fontSize: 13,
            color: "#cf1322",
          }}
        >
          {listErr}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {MODEL_TABS.map(t => {
          const on = tab === t.key;
          const count =
            t.key === "all" ? rows.length : rows.filter(r => r.type === t.key).length;
          return (
            <div
              key={t.key}
              onClick={() => setTab(t.key)}
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
              {t.label} <span style={{ fontSize: 11, opacity: 0.7 }}>{count}</span>
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
        {loading && (
          <div style={{ padding: 24, fontSize: 13, color: "rgba(0,0,0,.45)" }}>加载中…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div style={{ padding: 24, fontSize: 13, color: "rgba(0,0,0,.45)" }}>
            暂无模型，点击右上角「接入模型」开始。
          </div>
        )}
        {!loading &&
          filtered.map(r => {
            const t = tagOf(MODEL_TYPES[r.type].tag);
            const test = rowTest[r.id];
            const busy = busyId === r.id;
            return (
              <div
                key={r.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: COLS,
                  padding: "12px 16px",
                  borderBottom: "1px solid #f0f0f0",
                  fontSize: 13,
                  alignItems: "center",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <div
                  style={{
                    fontWeight: 500,
                    fontFamily: "ui-monospace, Menlo, monospace",
                    fontSize: 12,
                  }}
                >
                  {r.name}
                  <div style={{ color: "rgba(0,0,0,.35)", fontWeight: 400 }}>{r.apiKeyMasked}</div>
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
                    {TYPE_LABEL[r.type]}
                  </span>
                </div>
                <div style={{ color: "rgba(0,0,0,.65)" }}>{r.provider}</div>
                <div style={{ color: "rgba(0,0,0,.55)" }}>{MODEL_TYPES[r.type].hint}</div>
                <div>
                  <div
                    onClick={() => void toggle(r)}
                    style={{
                      width: 40,
                      height: 22,
                      flex: "none",
                      borderRadius: 11,
                      background: r.enabled ? "#1677ff" : "#d9d9d9",
                      position: "relative",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        top: 2,
                        left: r.enabled ? "20px" : "2px",
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: "#fff",
                        transition: "left .15s",
                      }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, fontSize: 13, alignItems: "center" }}>
                  <span style={linkBlue} onClick={() => openEdit(r)}>
                    编辑
                  </span>
                  <span style={linkBlue} onClick={() => void runRowTest(r)}>
                    测试
                  </span>
                  <span style={linkGray} onClick={() => void remove(r)}>
                    删除
                  </span>
                  {test && (
                    <span
                      title={test.ok ? `${test.latencyMs ?? "-"}ms` : (test.error ?? "失败")}
                      style={{ color: test.ok ? "#52c41a" : "#ff4d4f", fontSize: 12 }}
                    >
                      {test.ok ? `✓ ${test.latencyMs ?? "-"}ms` : "✗ 失败"}
                    </span>
                  )}
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
              <div style={{ fontSize: 16, fontWeight: 600 }}>
                {mf.id ? "编辑模型" : "接入模型"}
              </div>
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
                  {(["llm", "rerank", "embedding"] as ModelType[]).map(ty => {
                    const on = mf.type === ty;
                    const d = MODEL_TYPES[ty];
                    return (
                      <div
                        key={ty}
                        onClick={() => (mf.id ? undefined : pickType(ty))}
                        style={{
                          padding: 12,
                          borderRadius: 8,
                          border: `1px solid ${on ? "#1677ff" : "#f0f0f0"}`,
                          background: on ? "#e6f4ff" : "#fff",
                          cursor: mf.id ? "not-allowed" : "pointer",
                          opacity: mf.id && !on ? 0.5 : 1,
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
                          {TYPE_LABEL[ty]}
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
                    const on = mf.provider === p;
                    return (
                      <div
                        key={p}
                        onClick={() => set({ provider: p })}
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
              <Field label="API Base URL" required>
                <input
                  value={mf.baseUrl}
                  onChange={e => set({ baseUrl: e.target.value })}
                  placeholder="https://api.provider.com/v1"
                  style={inputStyle}
                />
              </Field>
              <Field label="API Key" required={!mf.id}>
                <input
                  type="password"
                  value={mf.apiKey}
                  onChange={e => set({ apiKey: e.target.value })}
                  placeholder={mf.id ? `不修改则留空（当前 ${editingMasked}）` : "sk-••••••••••••"}
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
                onClick={() => void drawerTest()}
                title={testState === "fail" ? testErr : undefined}
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
                  maxWidth: 220,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                  color:
                    testState === "ok"
                      ? "#52c41a"
                      : testState === "fail"
                        ? "#ff4d4f"
                        : "rgba(0,0,0,.65)",
                }}
              >
                {testState === "idle" && "⚡ 测试连接"}
                {testState === "testing" && "测试中…"}
                {testState === "ok" && "✓ 连接正常"}
                {testState === "fail" && `✗ ${testErr || "连接失败"}`}
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <div onClick={() => setOpen(false)} style={btnGhost}>
                  取消
                </div>
                <div
                  onClick={() => (saving ? undefined : void save())}
                  style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? "保存中…" : mf.id ? "保存" : "接入"}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
