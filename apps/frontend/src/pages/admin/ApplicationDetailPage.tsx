import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert,
  Button,
  Divider,
  Drawer,
  Input,
  Radio,
  Select,
  Slider,
  Space,
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
 * 应用详情 · Playground 骨架（M7a Story 5）：载入最新版本进编辑态，四节点卡 + 检索卡 +
 * 兜底 + 知识库；「保存为新版本」只追加，「上线这个版本」禁用（ReleaseCheck 属 M7b）；
 * 版本历史抽屉可载入历史版本编辑；对话测试面板按骨架 unavailable 渲染占位。
 */

const PROMPT_NODES: PromptNode[] = ["rewrite", "intent", "reply", "fallback"];
const NODE_LABELS: Record<PromptNode, string> = {
  rewrite: "问题改写",
  intent: "意图识别",
  reply: "回复生成",
  fallback: "兜底话术",
};

// 自由度预设 → 温度/Top P（custom 不写值，解锁滑杆）。温度值域 0..2（对齐契约）。
const FREEDOM_PRESET: Record<Exclude<Freedom, "custom">, { temperature: number; topP: number }> = {
  precise: { temperature: 0.2, topP: 0.6 },
  balance: { temperature: 0.7, topP: 0.9 },
  improvise: { temperature: 1.2, topP: 0.95 },
};
const FREEDOM_LABEL: Record<Freedom, string> = {
  precise: "精确",
  balance: "平衡",
  improvise: "创意",
  custom: "自定义",
};

const mono: CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace" };

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** version → 可编辑 config 字段（深拷贝，编辑不改原对象）。 */
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

/** 候选版本 → Select options（有标签的排前，稳定排序）。 */
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

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(0,0,0,.88)", margin: "12px 0 8px" }}>
      {children}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        padding: 16,
        background: "#fff",
        marginBottom: 12,
      }}
    >
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

  // 编辑态：来源版本 + 可编辑 config 字段 + 版本说明
  const [basedOnVersionId, setBasedOnVersionId] = useState("");
  const [draft, setDraft] = useState<ApplicationConfigFields | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const [historyOpen, setHistoryOpen] = useState(false);

  // 表单候选引用数据
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [candidatesByNode, setCandidatesByNode] = useState<
    Record<PromptNode, PromptNodeVersionCandidate[]>
  >({ rewrite: [], intent: [], reply: [], fallback: [] });

  // 对话测试骨架
  const [chatBusy, setChatBusy] = useState(false);
  const [chatUnavailable, setChatUnavailable] = useState(false);

  // 快速切换路由时的过期响应守卫：旧 appId 的响应回来晚了不覆盖当前页面
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

  // 候选引用数据（知识库/模型/四节点 Prompt 版本）一次拉全
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
        /* 候选缺失不阻塞详情展示；Select 退化为已选值 */
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

  const patchNode = (node: PromptNode, patch: Partial<ApplicationConfigFields["nodes"][PromptNode]>) =>
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

  const toggleKb = (id: string) =>
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            kbIds: prev.kbIds.includes(id)
              ? prev.kbIds.filter((x) => x !== id)
              : [...prev.kbIds, id],
          }
        : prev,
    );

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
      message.success(`已保存为 v${created.version}`);
      await refresh(false, created.id);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const runChatTest = async () => {
    if (!detail || !basedOnVersionId) return;
    setChatBusy(true);
    try {
      const result = await tryApplicationVersionChat(detail.id, basedOnVersionId);
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
        <Alert type="error" showIcon message={loadErr || "应用不存在"} />
        <Button style={{ marginTop: 12 }} onClick={() => navigate("/admin/applications")}>
          返回列表
        </Button>
      </div>
    );
  }

  const editingVersion = basedOnVersion?.version ?? null;

  return (
    <div style={{ maxWidth: 900 }}>
      {/* 头部 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <Button size="small" onClick={() => navigate("/admin/applications")}>
          ← 返回
        </Button>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{detail.name}</div>
        {detail.productionVersion != null ? (
          <Tag color="green">● 服务中 · v{detail.productionVersion}</Tag>
        ) : (
          <Tag>还没上线</Tag>
        )}
        <div style={{ flex: 1 }} />
        <Button onClick={() => setHistoryOpen(true)}>🕑 版本历史 {detail.versions.length}</Button>
      </div>

      {editingVersion != null && (
        <div style={{ fontSize: 13, color: "rgba(0,0,0,.55)", marginBottom: 12 }}>
          正在编辑 <span style={mono}>v{editingVersion}</span>
          {dirty && <span style={{ color: "#fa8c16" }}> · 有未保存修改</span>}
        </div>
      )}

      {/* 知识库 */}
      <Card>
        <SectionTitle>知识库</SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {kbs.map((k) => {
            const on = draft.kbIds.includes(k.id);
            return (
              <div
                key={k.id}
                onClick={() => toggleKb(k.id)}
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
                {k.name}
              </div>
            );
          })}
          {/* 候选未加载出的已选 kb 兜底展示 */}
          {draft.kbIds
            .filter((id) => !kbs.some((k) => k.id === id))
            .map((id) => (
              <Tag key={id} color="blue" style={mono}>
                {id}
              </Tag>
            ))}
          {kbs.length === 0 && draft.kbIds.length === 0 && (
            <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>暂无知识库</span>
          )}
        </div>
      </Card>

      {/* 四节点卡 */}
      {PROMPT_NODES.map((node) => {
        const nodeCfg = draft.nodes[node];
        return (
          <Card key={node}>
            <SectionTitle>{NODE_LABELS[node]}</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)", marginBottom: 4 }}>
                  Prompt 版本
                </div>
                <Select
                  value={nodeCfg.promptVersionId}
                  onChange={(v) => patchNode(node, { promptVersionId: v })}
                  style={{ width: "100%" }}
                  options={promptOptions(candidatesByNode[node], nodeCfg.promptVersionId)}
                />
              </div>
              <div>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)", marginBottom: 4 }}>模型</div>
                <Select
                  value={nodeCfg.modelId}
                  onChange={(v) => patchNode(node, { modelId: v })}
                  style={{ width: "100%" }}
                  options={
                    llmOptions.some((o) => o.value === nodeCfg.modelId)
                      ? llmOptions
                      : [{ value: nodeCfg.modelId, label: nodeCfg.modelId }, ...llmOptions]
                  }
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>自由度</span>
                <Radio.Group
                  value={nodeCfg.freedom}
                  onChange={(e) => setFreedom(node, e.target.value as Freedom)}
                  optionType="button"
                  options={(Object.keys(FREEDOM_LABEL) as Freedom[]).map((f) => ({
                    value: f,
                    label: FREEDOM_LABEL[f],
                  }))}
                />
                {nodeCfg.freedom !== "custom" && (
                  <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                    温度 {nodeCfg.temperature} · Top P {nodeCfg.topP}
                  </span>
                )}
              </div>
              {nodeCfg.freedom === "custom" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 12, color: "rgba(0,0,0,.55)", width: 48 }}>温度</span>
                    <Slider
                      min={0}
                      max={2}
                      step={0.01}
                      value={nodeCfg.temperature}
                      onChange={(v) => patchNode(node, { temperature: v })}
                      style={{ flex: 1, margin: "0 8px" }}
                    />
                    <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>
                      {nodeCfg.temperature}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 12, color: "rgba(0,0,0,.55)", width: 48 }}>Top P</span>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      value={nodeCfg.topP}
                      onChange={(v) => patchNode(node, { topP: v })}
                      style={{ flex: 1, margin: "0 8px" }}
                    />
                    <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>
                      {nodeCfg.topP}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </Card>
        );
      })}

      {/* 检索设置 */}
      <Card>
        <SectionTitle>检索设置</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)", width: 96 }}>召回数量 topK</span>
            <Slider
              min={1}
              max={200}
              value={draft.retrieval.topK}
              onChange={(v) =>
                patchRetrieval({ topK: v, topN: Math.min(draft.retrieval.topN, v) })
              }
              style={{ flex: 1, margin: "0 8px" }}
            />
            <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>
              {draft.retrieval.topK}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)", width: 96 }}>精排保留 topN</span>
            <Slider
              min={1}
              max={Math.min(50, draft.retrieval.topK)}
              value={draft.retrieval.topN}
              onChange={(v) => patchRetrieval({ topN: v })}
              style={{ flex: 1, margin: "0 8px" }}
            />
            <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>
              {draft.retrieval.topN}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch
              checked={draft.retrieval.hybridEnabled}
              onChange={(v) => patchRetrieval({ hybridEnabled: v })}
            />
            <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>混合召回</span>
          </div>
          {draft.retrieval.hybridEnabled && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)", width: 96 }}>语义权重</span>
              <Slider
                min={0}
                max={1}
                step={0.01}
                value={draft.retrieval.vectorWeight}
                onChange={(v) => patchRetrieval({ vectorWeight: v })}
                style={{ flex: 1, margin: "0 8px" }}
              />
              <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>
                {draft.retrieval.vectorWeight}
              </span>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch
              checked={draft.retrieval.rerankEnabled}
              onChange={(v) =>
                patchRetrieval(
                  v
                    ? { rerankEnabled: true }
                    : { rerankEnabled: false, rerankModelId: undefined, rerankThreshold: undefined },
                )
              }
            />
            <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>精排（rerank）</span>
          </div>
          {draft.retrieval.rerankEnabled && (
            <>
              <div>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)", marginBottom: 4 }}>
                  精排模型
                </div>
                <Select
                  value={draft.retrieval.rerankModelId}
                  onChange={(v) => patchRetrieval({ rerankModelId: v })}
                  placeholder="选择 rerank 模型"
                  style={{ width: "100%" }}
                  options={rerankOptions}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)", width: 96 }}>相似度阈值</span>
                <Slider
                  min={0}
                  max={1}
                  step={0.01}
                  value={draft.retrieval.rerankThreshold ?? 0}
                  onChange={(v) => patchRetrieval({ rerankThreshold: v })}
                  style={{ flex: 1, margin: "0 8px" }}
                />
                <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>
                  {draft.retrieval.rerankThreshold ?? 0}
                </span>
              </div>
            </>
          )}
        </div>
      </Card>

      {/* 兜底 */}
      <Card>
        <SectionTitle>兜底策略</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Switch
            checked={draft.fallback.toHuman}
            onChange={(v) => setDraft((prev) => (prev ? { ...prev, fallback: { toHuman: v } } : prev))}
          />
          <span style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>查不到答案时转人工</span>
        </div>
      </Card>

      {/* 对话测试骨架 */}
      <Card>
        <SectionTitle>对话测试</SectionTitle>
        <Button onClick={() => void runChatTest()} loading={chatBusy}>
          运行对话测试
        </Button>
        {chatUnavailable && (
          <Alert
            style={{ marginTop: 10 }}
            type="info"
            showIcon
            message="真实按版本对话测试将随 M8 编排上线"
          />
        )}
      </Card>

      {/* 底部操作 */}
      {saveErr && <Alert type="error" showIcon message={saveErr} style={{ marginBottom: 12 }} />}
      <Space>
        <Input
          placeholder="版本说明（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{ width: 280 }}
        />
        <Button type="primary" disabled={!dirty} loading={saving} onClick={() => void save()}>
          保存为新版本
        </Button>
        <Tooltip title="上线核对（ReleaseCheck）将在 M7b 开放">
          <Button disabled>上线这个版本</Button>
        </Tooltip>
      </Space>

      {/* 版本历史抽屉 */}
      <Drawer
        title="版本历史"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        width={420}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          {detail.versions.map((v) => {
            const serving = detail.productionConfigVersionId === v.id;
            const editing = basedOnVersionId === v.id;
            return (
              <div
                key={v.id}
                data-testid={`history-version-${v.version}`}
                onClick={() => {
                  loadVersionIntoEditor(v);
                  setHistoryOpen(false);
                }}
                style={{
                  border: `1px solid ${editing ? "#1677ff" : "#f0f0f0"}`,
                  borderRadius: 8,
                  padding: 12,
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ ...mono, fontWeight: 600 }}>v{v.version}</span>
                  {serving && <Tag color="green">服务中</Tag>}
                  {editing && <Tag color="blue">编辑中</Tag>}
                </div>
                {v.note && (
                  <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)", marginTop: 4 }}>
                    {v.note}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)", marginTop: 4 }}>
                  {v.createdBy} · {formatDateTime(v.createdAt)}
                </div>
              </div>
            );
          })}
        </Space>
        <Divider />
        <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>
          点任一版本载入编辑；保存只会追加新版本，不会修改历史版本。
        </div>
      </Drawer>
    </div>
  );
}
