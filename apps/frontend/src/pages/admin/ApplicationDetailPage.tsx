import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert,
  Button,
  Drawer,
  Input,
  InputNumber,
  Select,
  Slider,
  Spin,
  Switch,
  Tag,
  Tooltip,
  message,
} from "antd";
import type {
  ApplicationConfigFields,
  ApplicationConfigVersion,
  ApplicationDetail,
  Freedom,
  KnowledgeBase,
  ModelProvider,
  PromptNode,
  PromptNodeVersionCandidate,
} from "@codecrush/contracts";
import {
  createApplicationConfigVersion,
  getApplicationDetail,
  getKnowledgeBases,
  getModels,
  getPromptNodeVersions,
  tryApplicationVersionChat,
} from "../../api/client";

/**
 * 应用详情 · Playground（M7a Story 5，对齐原型 CodeCrushBot.dc.html「应用管理」详情屏）：
 * 左右两栏——左栏 Prompt 配置 / 检索设置 / 知识库 三卡，右栏「上线」区 + 提示卡。
 * 载入最新版本进草稿编辑，「保存为新版本」只追加；「上线这个版本」M7a 禁用（ReleaseCheck 属 M7b）；
 * 「以线上版本重置草稿」重置到 production/最新；版本历史抽屉可载入编辑 / 对话测试骨架。
 */

const PROMPT_NODES: PromptNode[] = ["rewrite", "intent", "reply", "fallback"];
const NODE_LABELS: Record<PromptNode, string> = {
  rewrite: "问题改写",
  intent: "意图识别",
  reply: "回复生成",
  fallback: "兜底话术",
};
const NODE_DESC: Record<PromptNode, string> = {
  rewrite: "把用户口语问题整理成更利于检索的形式",
  intent: "判断用户想做什么，决定走哪条路",
  reply: "根据检索到的资料生成最终回答",
  fallback: "没查到答案时怎么回应",
};

// 自由度预设 → 温度/Top P（custom 解锁滑杆）。温度值域 0..2（对齐契约）。
const FREEDOM_PRESET: Record<Exclude<Freedom, "custom">, { temperature: number; topP: number }> = {
  precise: { temperature: 0.2, topP: 0.6 },
  balance: { temperature: 0.7, topP: 0.9 },
  improvise: { temperature: 1.2, topP: 0.95 },
};
const FREEDOM_OPTIONS: Array<{ value: Freedom; label: string }> = [
  { value: "precise", label: "精确" },
  { value: "balance", label: "平衡" },
  { value: "improvise", label: "创意" },
  { value: "custom", label: "自定义" },
];

const mono: CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace" };
const cardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #f0f0f0",
  borderRadius: 12,
  overflow: "hidden",
};
const cardHeadStyle: CSSProperties = {
  padding: "13px 18px",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  fontWeight: 600,
  color: "rgba(0,0,0,.8)",
};
const cardBodyStyle: CSSProperties = { padding: "14px 18px" };

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** version → 可编辑 config 字段（深拷贝）。 */
function versionToFields(v: ApplicationConfigVersion): ApplicationConfigFields {
  return {
    kbIds: [...v.kbIds],
    nodes: {
      rewrite: { ...v.nodes.rewrite },
      intent: { ...v.nodes.intent },
      reply: { ...v.nodes.reply },
      fallback: { ...v.nodes.fallback },
    },
    retrieval: { ...v.retrieval },
    fallback: { ...v.fallback },
  };
}

/** 候选版本 → Select options（有标签的排前）。 */
function promptOptions(
  candidates: PromptNodeVersionCandidate[],
  current: string,
): Array<{ value: string; label: string }> {
  const sorted = [...candidates].sort(
    (a, b) => (b.tags.length > 0 ? 1 : 0) - (a.tags.length > 0 ? 1 : 0),
  );
  const opts = sorted.map((c) => ({
    value: c.versionId,
    label: `${c.promptName} v${c.version}${c.tags.length ? `（${c.tags.join(" ")}）` : ""}`,
  }));
  if (current && !opts.some((o) => o.value === current))
    opts.unshift({ value: current, label: "沿用原引用版本" });
  return opts;
}

function FieldRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 96, flex: "none", fontSize: 13, color: "rgba(0,0,0,.65)" }}>{label}</div>
      {children}
    </div>
  );
}

export default function ApplicationDetailPage() {
  const { appId = "" } = useParams();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");

  const [basedOnVersionId, setBasedOnVersionId] = useState("");
  const [draft, setDraft] = useState<ApplicationConfigFields | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const [historyOpen, setHistoryOpen] = useState(false);

  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [candidatesByNode, setCandidatesByNode] = useState<
    Record<PromptNode, PromptNodeVersionCandidate[]>
  >({ rewrite: [], intent: [], reply: [], fallback: [] });
  const [kbPickerOpen, setKbPickerOpen] = useState(false);

  const [chatBusy, setChatBusy] = useState(false);
  const [chatUnavailable, setChatUnavailable] = useState(false);

  const activeAppId = useRef(appId);
  useEffect(() => {
    activeAppId.current = appId;
  }, [appId]);

  const loadVersionIntoEditor = useCallback((v: ApplicationConfigVersion) => {
    setBasedOnVersionId(v.id);
    setDraft(versionToFields(v));
    setNote("");
  }, []);

  const refresh = useCallback(
    async (loadLatest: boolean, focusVersionId?: string) => {
      setLoadErr("");
      try {
        const d = await getApplicationDetail(appId);
        if (activeAppId.current !== appId) return null;
        setDetail(d);
        if (focusVersionId) {
          const target = d.versions.find((v) => v.id === focusVersionId);
          if (target) loadVersionIntoEditor(target);
        } else if (loadLatest && d.versions.length > 0) {
          loadVersionIntoEditor(d.versions[0]);
        }
        return d;
      } catch (e) {
        if (activeAppId.current !== appId) return null;
        setLoadErr(e instanceof Error ? e.message : "加载失败");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [appId, loadVersionIntoEditor],
  );

  useEffect(() => {
    setLoading(true);
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    let active = true;
    Promise.all([
      getKnowledgeBases(),
      getModels(),
      ...PROMPT_NODES.map((node) => getPromptNodeVersions(node)),
    ])
      .then(([kbList, modelList, ...nodeLists]) => {
        if (!active) return;
        setKbs(kbList);
        setModels(modelList);
        setCandidatesByNode({
          rewrite: nodeLists[0],
          intent: nodeLists[1],
          reply: nodeLists[2],
          fallback: nodeLists[3],
        });
      })
      .catch(() => {
        /* 候选缺失不阻塞详情展示 */
      });
    return () => {
      active = false;
    };
  }, []);

  const basedOnVersion = detail?.versions.find((v) => v.id === basedOnVersionId) ?? null;
  const dirty =
    draft !== null &&
    basedOnVersion !== null &&
    JSON.stringify(draft) !== JSON.stringify(versionToFields(basedOnVersion));

  const llmOptions = models
    .filter((m) => m.type === "llm" && m.enabled)
    .map((m) => ({ value: m.id, label: m.name }));
  const rerankOptions = models
    .filter((m) => m.type === "rerank" && m.enabled)
    .map((m) => ({ value: m.id, label: m.name }));

  const patchNode = (
    node: PromptNode,
    patch: Partial<ApplicationConfigFields["nodes"][PromptNode]>,
  ) =>
    setDraft((prev) =>
      prev ? { ...prev, nodes: { ...prev.nodes, [node]: { ...prev.nodes[node], ...patch } } } : prev,
    );
  const patchRetrieval = (patch: Partial<ApplicationConfigFields["retrieval"]>) =>
    setDraft((prev) => (prev ? { ...prev, retrieval: { ...prev.retrieval, ...patch } } : prev));

  const setFreedom = (node: PromptNode, freedom: Freedom) => {
    if (freedom === "custom") {
      patchNode(node, { freedom });
    } else {
      const preset = FREEDOM_PRESET[freedom];
      patchNode(node, { freedom, temperature: preset.temperature, topP: preset.topP });
    }
  };

  const removeKb = (id: string) =>
    setDraft((prev) => (prev ? { ...prev, kbIds: prev.kbIds.filter((x) => x !== id) } : prev));
  const addKb = (id: string) => {
    setDraft((prev) =>
      prev && !prev.kbIds.includes(id) ? { ...prev, kbIds: [...prev.kbIds, id] } : prev,
    );
    setKbPickerOpen(false);
  };

  const resetToProduction = () => {
    if (!detail) return;
    const prod = detail.versions.find((v) => v.id === detail.productionConfigVersionId);
    const target = prod ?? detail.versions[0];
    if (target) loadVersionIntoEditor(target);
  };

  const save = async () => {
    if (!draft || !detail) return;
    if (draft.kbIds.length === 0) {
      setSaveErr("请至少绑定一个知识库");
      return;
    }
    setSaving(true);
    setSaveErr("");
    try {
      const created = await createApplicationConfigVersion(detail.id, {
        config: draft,
        note: note.trim() || undefined,
      });
      message.success(`已保存为 v${created.version}（未上线，不影响正在服务的内容）`);
      await refresh(false, created.id);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const runChatTest = async (versionId: string) => {
    if (!detail || !versionId) return;
    setChatBusy(true);
    try {
      const result = await tryApplicationVersionChat(detail.id, versionId);
      setChatUnavailable(result.mode === "unavailable");
    } catch {
      setChatUnavailable(false);
      message.error("对话测试请求失败");
    } finally {
      setChatBusy(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }
  if (loadErr || !detail || !draft) {
    return (
      <div style={{ padding: 24 }}>
        <Alert type="error" showIcon title={loadErr || "应用不存在"} />
        <Button style={{ marginTop: 12 }} onClick={() => navigate("/admin/applications")}>
          返回列表
        </Button>
      </div>
    );
  }

  const editingVersion = basedOnVersion?.version ?? null;
  const availableKbs = kbs.filter((k) => !draft.kbIds.includes(k.id));
  const rt = draft.retrieval;
  const hybridPct = Math.round(rt.vectorWeight * 100);

  return (
    <div>
      {/* 顶部行 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Button size="small" onClick={() => navigate("/admin/applications")}>
          ← 返回
        </Button>
        <span style={{ fontSize: 13, color: "rgba(0,0,0,.4)" }}>应用管理 /</span>
        <span style={{ fontSize: 17, fontWeight: 600 }}>{detail.name}</span>
        {detail.productionVersion != null ? (
          <Tag color="green" style={mono}>
            ● 服务中 · v{detail.productionVersion}
          </Tag>
        ) : (
          <Tag>还没上线</Tag>
        )}
        <div style={{ flex: 1 }} />
        <Button size="small" onClick={resetToProduction}>
          ↺ 以线上版本重置草稿
        </Button>
        <Button size="small" onClick={() => setHistoryOpen(true)}>
          🕑 版本历史 {detail.versions.length}
        </Button>
      </div>
      <div
        style={{ fontSize: 12.5, color: "rgba(0,0,0,.42)", marginBottom: 16, lineHeight: 1.6 }}
      >
        正在编辑基于 <b style={{ ...mono, color: "rgba(0,0,0,.6)" }}>v{editingVersion}</b> 的草稿 ·{" "}
        <span style={{ color: dirty ? "#fa8c16" : "#389e0d" }}>
          {dirty ? "有未保存修改" : "与该版本一致"}
        </span>
        。改完点「保存为新版本」；「上线这个版本」会先自动核对四个节点和知识库都没问题才对外服务。
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* 左栏 */}
        <div style={{ flex: "1.3 1 460px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Prompt 配置 */}
          <div style={cardStyle}>
            <div style={cardHeadStyle}>Prompt 配置</div>
            <div style={{ ...cardBodyStyle, display: "flex", flexDirection: "column", gap: 16 }}>
              {PROMPT_NODES.map((node) => {
                const n = draft.nodes[node];
                const locked = n.freedom !== "custom";
                return (
                  <div key={node} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{ fontSize: 13, fontWeight: 600, color: "rgba(0,0,0,.8)", width: 76, flex: "none" }}
                      >
                        {NODE_LABELS[node]}
                      </span>
                      <span style={{ fontSize: 11.5, color: "rgba(0,0,0,.42)", flex: 1 }}>
                        {NODE_DESC[node]}
                      </span>
                    </div>
                    <Select
                      value={n.promptVersionId}
                      onChange={(v) => patchNode(node, { promptVersionId: v })}
                      style={{ width: "100%" }}
                      options={promptOptions(candidatesByNode[node], n.promptVersionId)}
                    />
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        flexWrap: "wrap",
                        paddingLeft: 2,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11.5, color: "rgba(0,0,0,.45)" }}>模型</span>
                        <Select
                          size="small"
                          value={n.modelId}
                          onChange={(v) => patchNode(node, { modelId: v })}
                          style={{ width: 150 }}
                          options={
                            llmOptions.some((o) => o.value === n.modelId)
                              ? llmOptions
                              : [{ value: n.modelId, label: n.modelId }, ...llmOptions]
                          }
                        />
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11.5, color: "rgba(0,0,0,.45)" }}>自由度</span>
                        <Select
                          size="small"
                          value={n.freedom}
                          onChange={(v) => setFreedom(node, v as Freedom)}
                          style={{ width: 92 }}
                          options={FREEDOM_OPTIONS}
                        />
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 150 }}>
                        <span style={{ fontSize: 11.5, color: "rgba(0,0,0,.45)" }}>温度</span>
                        <Slider
                          min={0}
                          max={2}
                          step={0.01}
                          disabled={locked}
                          value={n.temperature}
                          onChange={(v) => patchNode(node, { temperature: v })}
                          style={{ flex: 1, margin: 0 }}
                        />
                        <span style={{ ...mono, fontSize: 11.5, color: "rgba(0,0,0,.6)", width: 30 }}>
                          {n.temperature}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 150 }}>
                        <span style={{ fontSize: 11.5, color: "rgba(0,0,0,.45)" }}>Top P</span>
                        <Slider
                          min={0}
                          max={1}
                          step={0.01}
                          disabled={locked}
                          value={n.topP}
                          onChange={(v) => patchNode(node, { topP: v })}
                          style={{ flex: 1, margin: 0 }}
                        />
                        <span style={{ ...mono, fontSize: 11.5, color: "rgba(0,0,0,.6)", width: 30 }}>
                          {n.topP}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 检索设置 */}
          <div style={cardStyle}>
            <div style={cardHeadStyle}>检索设置</div>
            <div style={{ ...cardBodyStyle, display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: "rgba(0,0,0,.55)" }}>召回数量</span>
                  <InputNumber
                    min={1}
                    max={200}
                    value={rt.topK}
                    onChange={(v) =>
                      typeof v === "number" &&
                      patchRetrieval({ topK: v, topN: Math.min(rt.topN, v) })
                    }
                    style={{ width: 72 }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: "rgba(0,0,0,.55)" }}>精排后保留</span>
                  <InputNumber
                    min={1}
                    max={Math.min(50, rt.topK)}
                    value={rt.topN}
                    onChange={(v) => typeof v === "number" && patchRetrieval({ topN: v })}
                    style={{ width: 72 }}
                  />
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 12.5, color: "rgba(0,0,0,.7)" }}>
                    同时用关键词 + 语义两种方式召回
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(0,0,0,.4)", marginTop: 1 }}>
                    关闭则只用语义（向量）召回
                  </div>
                </div>
                <Switch
                  checked={rt.hybridEnabled}
                  onChange={(v) => patchRetrieval({ hybridEnabled: v })}
                />
              </div>
              {rt.hybridEnabled && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12.5, color: "rgba(0,0,0,.55)" }}>
                      更偏向语义还是关键词
                    </span>
                    <span style={{ ...mono, fontSize: 11.5, color: "rgba(0,0,0,.45)" }}>
                      语义 {hybridPct}% · 关键词 {100 - hybridPct}%
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={1}
                    step={0.01}
                    value={rt.vectorWeight}
                    onChange={(v) => patchRetrieval({ vectorWeight: v })}
                    style={{ margin: 0 }}
                  />
                </div>
              )}

              <div style={{ height: 1, background: "#f0f0f0" }} />

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 12.5, color: "rgba(0,0,0,.7)" }}>召回后再用模型精排一次</div>
                <Switch
                  checked={rt.rerankEnabled}
                  onChange={(v) =>
                    patchRetrieval(
                      v
                        ? { rerankEnabled: true, rerankThreshold: rt.rerankThreshold ?? 0.5 }
                        : { rerankEnabled: false, rerankModelId: undefined, rerankThreshold: undefined },
                    )
                  }
                />
              </div>
              {rt.rerankEnabled && (
                <>
                  <FieldRow label={<span style={{ fontSize: 12.5, color: "rgba(0,0,0,.55)" }}>精排模型</span>}>
                    <Select
                      value={rt.rerankModelId}
                      onChange={(v) => patchRetrieval({ rerankModelId: v })}
                      placeholder="选择 rerank 模型"
                      style={{ flex: 1 }}
                      options={rerankOptions}
                    />
                  </FieldRow>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12.5, color: "rgba(0,0,0,.55)" }}>
                        精排分数低于多少就不要了
                      </span>
                      <span style={{ ...mono, fontSize: 11.5, color: "rgba(0,0,0,.6)" }}>
                        {rt.rerankThreshold ?? 0}
                      </span>
                    </div>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={rt.rerankThreshold ?? 0}
                      onChange={(v) => patchRetrieval({ rerankThreshold: v })}
                      style={{ margin: 0 }}
                    />
                  </div>
                </>
              )}

              <div style={{ height: 1, background: "#f0f0f0" }} />

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 12.5, color: "rgba(0,0,0,.7)" }}>查不到答案时转人工</div>
                  <div style={{ fontSize: 11, color: "rgba(0,0,0,.4)", marginTop: 1 }}>
                    关闭则走「兜底」节点的话术回答
                  </div>
                </div>
                <Switch
                  checked={draft.fallback.toHuman}
                  onChange={(v) =>
                    setDraft((prev) => (prev ? { ...prev, fallback: { toHuman: v } } : prev))
                  }
                />
              </div>
            </div>
          </div>

          {/* 知识库 */}
          <div style={cardStyle}>
            <div style={cardHeadStyle}>知识库</div>
            <div style={{ ...cardBodyStyle, display: "flex", alignItems: "flex-start", gap: 10 }}>
              <span
                style={{ fontSize: 12.5, color: "rgba(0,0,0,.55)", width: 76, flex: "none", paddingTop: 4 }}
              >
                范围
              </span>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  {draft.kbIds.map((id) => {
                    const k = kbs.find((x) => x.id === id);
                    return (
                      <Tag key={id} closable onClose={() => removeKb(id)} style={{ marginInlineEnd: 0 }}>
                        {k?.name ?? id}
                      </Tag>
                    );
                  })}
                  <Tooltip title={availableKbs.length === 0 ? "已经全部添加了" : undefined}>
                    <Button
                      size="small"
                      type="dashed"
                      disabled={availableKbs.length === 0}
                      onClick={() => setKbPickerOpen((o) => !o)}
                    >
                      + 添加知识库
                    </Button>
                  </Tooltip>
                </div>
                {kbPickerOpen && availableKbs.length > 0 && (
                  <div
                    style={{
                      border: "1px solid #91caff",
                      borderRadius: 8,
                      background: "#fff",
                      boxShadow: "0 8px 24px rgba(0,0,0,.1)",
                      padding: 6,
                      maxWidth: 280,
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    {availableKbs.map((k) => (
                      <div
                        key={k.id}
                        onClick={() => addKb(k.id)}
                        style={{
                          padding: "7px 10px",
                          borderRadius: 6,
                          fontSize: 12.5,
                          color: "rgba(0,0,0,.75)",
                          cursor: "pointer",
                        }}
                      >
                        {k.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 右栏 */}
        <div style={{ width: 280, flex: "none", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ ...cardStyle, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(0,0,0,.8)" }}>上线</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.5)", lineHeight: 1.7 }}>
              {detail.productionVersion != null ? (
                <>
                  当前对外服务的是 <b style={{ ...mono, color: "rgba(0,0,0,.7)" }}>v{detail.productionVersion}</b>
                  。上线这个版本后，用户马上会用到新的配置。
                </>
              ) : (
                <>这个应用还没有版本上线。上线这个版本后即可对外服务。</>
              )}
            </div>
            {saveErr && <Alert type="error" showIcon title={saveErr} />}
            <Input
              placeholder="版本说明（可选）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button block disabled={!dirty} loading={saving} onClick={() => void save()}>
              保存为新版本
            </Button>
            <Tooltip title="上线核对（ReleaseCheck）将在 M7b 开放">
              <Button block type="primary" disabled>
                上线这个版本
              </Button>
            </Tooltip>
          </div>

          <div style={{ ...cardStyle, padding: "14px 16px", display: "flex", gap: 9, alignItems: "flex-start" }}>
            <span style={{ flex: "none", fontSize: 12, color: "rgba(0,0,0,.35)", marginTop: 1 }}>ⓘ</span>
            <div style={{ fontSize: 11.5, color: "rgba(0,0,0,.5)", lineHeight: 1.7 }}>
              上线前会自动核对一遍：确认四个节点和知识库都配好了、能正常工作，有问题会直接告诉你（M7b 开放）。
            </div>
          </div>

          {/* 对话测试骨架 */}
          <div style={{ ...cardStyle, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(0,0,0,.8)" }}>对话测试</div>
            <Button block loading={chatBusy} onClick={() => void runChatTest(basedOnVersionId)}>
              运行对话测试
            </Button>
            {chatUnavailable && (
              <Alert type="info" showIcon title="真实按版本对话测试将随 M8 编排上线" />
            )}
          </div>
        </div>
      </div>

      {/* 版本历史抽屉 */}
      <Drawer title="版本历史" open={historyOpen} onClose={() => setHistoryOpen(false)} size={440}>
        <div style={{ fontSize: 11.5, color: "rgba(0,0,0,.4)", marginBottom: 12, lineHeight: 1.6 }}>
          点「载入编辑」把这个版本的内容载入草稿；绿色 = 当前对外服务的版本。保存只会追加新版本，不改历史。
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {detail.versions.map((v) => {
            const serving = detail.productionConfigVersionId === v.id;
            const editing = basedOnVersionId === v.id;
            return (
              <div
                key={v.id}
                data-testid={`history-version-${v.version}`}
                style={{
                  border: `1px solid ${editing ? "#91caff" : serving ? "#b7eb8f" : "#f0f0f0"}`,
                  borderRadius: 9,
                  padding: "11px 13px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <span style={{ ...mono, fontSize: 13.5, fontWeight: 700 }}>v{v.version}</span>
                  {serving && <Tag color="green">服务中</Tag>}
                  {editing && <Tag color="blue">编辑中</Tag>}
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                    {v.createdBy} · {formatDateTime(v.createdAt)}
                  </span>
                </div>
                {v.note && (
                  <div style={{ fontSize: 12.5, color: "rgba(0,0,0,.6)", lineHeight: 1.5, marginBottom: 6 }}>
                    {v.note}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "rgba(0,0,0,.4)", marginBottom: 8 }}>
                  知识库 {v.kbIds.length} · {v.nodes.reply.modelId ? "已配模型" : ""}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button
                    size="small"
                    type={editing ? "default" : "primary"}
                    ghost={!editing}
                    onClick={() => {
                      loadVersionIntoEditor(v);
                      setHistoryOpen(false);
                    }}
                  >
                    载入编辑
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      loadVersionIntoEditor(v);
                      setHistoryOpen(false);
                      void runChatTest(v.id);
                    }}
                  >
                    对话测试
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Drawer>
    </div>
  );
}
