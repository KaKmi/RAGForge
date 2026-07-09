import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Divider,
  Drawer,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Slider,
  Space,
  Switch,
  Table,
  Tag,
  message,
  type TableColumnsType,
} from "antd";
import type {
  Agent,
  AgentConfigVersion,
  Freedom,
  KnowledgeBase,
  ModelProvider,
  NodeConfig,
  NodeParams,
  Prompt,
  PromptNode,
} from "@codecrush/contracts";
import {
  createAgent,
  createAgentConfigVersion,
  getAgentConfigVersions,
  getAgents,
  getKnowledgeBases,
  getModels,
  getPrompts,
  publishAgentConfigVersion,
  rollbackAgentConfigVersion,
  runAgentConfigVersionEval,
  updateAgent,
} from "../../api/client";
import { EVAL_STATUS_LABEL, STATUS_TAG, tagOf } from "../../mocks/agents";

/**
 * Agent 管理（M7，接真实 /api/agents）。
 * 列表 + 新建抽屉（五区块）+ 编辑抽屉（收窄 name/desc/enabled，008 决策 3）
 * + 配置版本抽屉（历史/新建版本/Eval stub/发布/回滚）。UI 用 antd（用户拍板 2026-07-08）。
 */

const AVATAR_COLORS = ["#1677ff", "#722ed1", "#13c2c2", "#eb2f96", "#fa8c16", "#52c41a"];
const avatarColor = (name: string) =>
  AVATAR_COLORS[[...name].reduce((s, ch) => s + ch.charCodeAt(0), 0) % AVATAR_COLORS.length];

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

// 自由度预设 → 温度/Top P（自定义时解锁滑杆，对齐原型「精确/平衡/创意/自定义」）
const FREEDOM_PRESET: Record<Exclude<Freedom, "custom">, { temperature: number; topP: number }> = {
  precise: { temperature: 0.1, topP: 0.7 },
  balance: { temperature: 0.5, topP: 0.9 },
  improvise: { temperature: 0.9, topP: 0.95 },
};
const FREEDOM_LABEL: Record<Freedom, string> = {
  precise: "精确",
  balance: "平衡",
  improvise: "创意",
  custom: "自定义",
};
const NODE_LABELS: Record<PromptNode, string> = {
  rewrite: "问题改写",
  intent: "意图识别",
  reply: "回复生成",
  fallback: "兜底话术",
};
const PROMPT_NODES: PromptNode[] = ["rewrite", "intent", "reply", "fallback"];

const defaultNodeConfig = (): NodeConfig => ({
  freedom: "balance",
  temperatureEnabled: true,
  temperature: 0.5,
  topPEnabled: true,
  topP: 0.9,
});
const defaultNodeParams = (): NodeParams => ({
  rewrite: defaultNodeConfig(),
  intent: defaultNodeConfig(),
  reply: defaultNodeConfig(),
  fallback: defaultNodeConfig(),
});

/** 新建 Agent / 新建配置版本共用的表单草稿（"" 表示未选，提交前转 undefined/校验） */
interface ConfigDraft {
  name: string;
  desc: string;
  kbIds: string[];
  genModelId: string;
  lightModelId: string;
  rerankModelId: string; // "" = 不启用重排
  promptRewriteVerId: string;
  promptIntentVerId: string;
  promptReplyVerId: string;
  promptFallbackVerId: string;
  nodeParams: NodeParams;
  topK: number;
  topN: number;
  threshold: number;
  multiRecall: boolean;
  vecWeight: number;
  fallbackHuman: boolean;
  note: string;
}

const defaultDraft = (): ConfigDraft => ({
  name: "",
  desc: "",
  kbIds: [],
  genModelId: "",
  lightModelId: "",
  rerankModelId: "",
  promptRewriteVerId: "",
  promptIntentVerId: "",
  promptReplyVerId: "",
  promptFallbackVerId: "",
  nodeParams: defaultNodeParams(),
  topK: 20,
  topN: 5,
  threshold: 0.65,
  multiRecall: true,
  vecWeight: 0.6,
  fallbackHuman: true,
  note: "",
});

const draftFromVersion = (v: AgentConfigVersion): ConfigDraft => ({
  name: "",
  desc: "",
  kbIds: [...v.kbIds],
  genModelId: v.genModelId,
  lightModelId: v.lightModelId ?? "",
  rerankModelId: v.rerankModelId ?? "",
  promptRewriteVerId: v.promptRewriteVerId,
  promptIntentVerId: v.promptIntentVerId,
  promptReplyVerId: v.promptReplyVerId,
  promptFallbackVerId: v.promptFallbackVerId,
  nodeParams: JSON.parse(JSON.stringify(v.nodeParams)) as NodeParams,
  topK: v.topK,
  topN: v.topN,
  threshold: v.threshold,
  multiRecall: v.multiRecall,
  vecWeight: v.vecWeight ?? 0.6,
  fallbackHuman: v.fallbackHuman,
  note: "",
});

/** 草稿 → 请求体的版本化配置字段（不含 name/desc/note） */
function draftConfigFields(d: ConfigDraft) {
  return {
    kbIds: d.kbIds,
    genModelId: d.genModelId,
    lightModelId: d.lightModelId || undefined,
    rerankModelId: d.rerankModelId || undefined,
    promptRewriteVerId: d.promptRewriteVerId,
    promptIntentVerId: d.promptIntentVerId,
    promptReplyVerId: d.promptReplyVerId,
    promptFallbackVerId: d.promptFallbackVerId,
    nodeParams: d.nodeParams,
    topK: d.topK,
    topN: d.topN,
    threshold: d.threshold,
    multiRecall: d.multiRecall,
    vecWeight: d.multiRecall ? d.vecWeight : undefined,
    fallbackHuman: d.fallbackHuman,
  };
}

/** 草稿校验：返回错误文案或 null */
function validateDraft(d: ConfigDraft, needName: boolean): string | null {
  if (needName && !d.name.trim()) return "请填写 Agent 名称";
  if (d.kbIds.length === 0) return "请至少绑定一个知识库";
  if (!d.genModelId) return "请选择生成模型";
  if (!d.promptRewriteVerId || !d.promptIntentVerId || !d.promptReplyVerId || !d.promptFallbackVerId)
    return "请为四个 Prompt 节点各选择一个已发布版本";
  return null;
}

function FieldLabel({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)", marginBottom: 6 }}>
      {required && <span style={{ color: "#ff4d4f" }}>* </span>}
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(0,0,0,.88)", margin: "4px 0" }}>
      {children}
    </div>
  );
}

/** 知识库 chips：选中蓝 / 可选灰 / embedding 冲突红警示（点击不生效 + 错误提示）。
 * 前端仅体验层拦截，真正强校验在后端（008 Invariant 5）。 */
function KbChips({
  kbs,
  selected,
  onChange,
}: {
  kbs: KnowledgeBase[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [conflictMsg, setConflictMsg] = useState("");
  const baseEmbed =
    selected.length > 0 ? kbs.find((k) => k.id === selected[0])?.embeddingModelId : null;
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {kbs.map((k) => {
          const on = selected.includes(k.id);
          const conflict = !on && baseEmbed != null && k.embeddingModelId !== baseEmbed;
          return (
            <div
              key={k.id}
              onClick={() => {
                if (conflict) {
                  setConflictMsg(
                    `「${k.name}」与已选知识库的向量模型不一致，无法同时绑定`,
                  );
                  return;
                }
                setConflictMsg("");
                onChange(on ? selected.filter((x) => x !== k.id) : [...selected, k.id]);
              }}
              style={{
                fontSize: 13,
                lineHeight: "30px",
                height: 30,
                padding: "0 12px",
                borderRadius: 6,
                border: `1px solid ${on ? "#1677ff" : conflict ? "#ffccc7" : "#d9d9d9"}`,
                background: on ? "#e6f4ff" : conflict ? "#fff2f0" : "#fff",
                color: on ? "#1677ff" : conflict ? "#ff7875" : "rgba(0,0,0,.65)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              {k.name}
            </div>
          );
        })}
        {kbs.length === 0 && (
          <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
            暂无知识库，请先到「知识库管理」创建
          </span>
        )}
      </div>
      {conflictMsg && (
        <Alert type="error" showIcon title={conflictMsg} style={{ marginTop: 8 }} />
      )}
    </>
  );
}

/** 单节点自由度/温度/TopP 编辑器 */
function NodeConfigRow({
  node,
  config,
  onChange,
}: {
  node: PromptNode;
  config: NodeConfig;
  onChange: (c: NodeConfig) => void;
}) {
  const setFreedom = (freedom: Freedom) => {
    if (freedom === "custom") {
      onChange({ ...config, freedom });
    } else {
      const preset = FREEDOM_PRESET[freedom];
      onChange({
        freedom,
        temperatureEnabled: true,
        temperature: preset.temperature,
        topPEnabled: true,
        topP: preset.topP,
      });
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 72, flex: "none", fontSize: 12, color: "rgba(0,0,0,.55)" }}>
          {NODE_LABELS[node]}
        </div>
        <Select<Freedom>
          size="small"
          value={config.freedom}
          onChange={setFreedom}
          style={{ width: 110 }}
          options={(Object.keys(FREEDOM_LABEL) as Freedom[]).map((f) => ({
            value: f,
            label: FREEDOM_LABEL[f],
          }))}
        />
        {config.freedom !== "custom" && (
          <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
            温度 {config.temperature} · Top P {config.topP}
          </span>
        )}
      </div>
      {config.freedom === "custom" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 84 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch
              size="small"
              checked={config.temperatureEnabled}
              onChange={(v) => onChange({ ...config, temperatureEnabled: v })}
            />
            <span style={{ fontSize: 12, color: "rgba(0,0,0,.55)", width: 56 }}>温度</span>
            <Slider
              min={0}
              max={1}
              step={0.01}
              disabled={!config.temperatureEnabled}
              value={config.temperature}
              onChange={(v) => onChange({ ...config, temperature: v })}
              style={{ flex: 1, margin: "0 8px" }}
            />
            <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>
              {config.temperature}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch
              size="small"
              checked={config.topPEnabled}
              onChange={(v) => onChange({ ...config, topPEnabled: v })}
            />
            <span style={{ fontSize: 12, color: "rgba(0,0,0,.55)", width: 56 }}>Top P</span>
            <Slider
              min={0}
              max={1}
              step={0.01}
              disabled={!config.topPEnabled}
              value={config.topP}
              onChange={(v) => onChange({ ...config, topP: v })}
              style={{ flex: 1, margin: "0 8px" }}
            />
            <span style={{ fontSize: 12, width: 36, textAlign: "right" }}>{config.topP}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 五区块中 2-5 区块（知识库/模型/Prompt/检索）：新建 Agent 与新建配置版本共用 */
function ConfigFields({
  draft,
  patch,
  kbs,
  models,
  promptsByNode,
}: {
  draft: ConfigDraft;
  patch: (p: Partial<ConfigDraft>) => void;
  kbs: KnowledgeBase[];
  models: ModelProvider[];
  promptsByNode: Record<PromptNode, Prompt[]>;
}) {
  const llmOpts = models
    .filter((m) => m.type === "llm" && m.enabled)
    .map((m) => ({ value: m.id, label: m.name }));
  const rerankOpts = [
    { value: "", label: "不启用重排" },
    ...models
      .filter((m) => m.type === "rerank" && m.enabled)
      .map((m) => ({ value: m.id, label: m.name })),
  ];
  const promptOpts = (node: PromptNode, current: string) => {
    const opts = promptsByNode[node]
      .filter((p) => p.currentVersionId !== null)
      .map((p) => ({
        value: p.currentVersionId as string,
        label: `${p.name} v${p.currentVersionNumber}`,
      }));
    // 预填的引用可能指向旧版本（不在"当前生产版本"选项里），补一项避免显示裸 UUID
    if (current && !opts.some((o) => o.value === current)) {
      opts.unshift({ value: current, label: "沿用原引用版本" });
    }
    return opts;
  };
  const promptField = (node: PromptNode) =>
    (`prompt${node.charAt(0).toUpperCase()}${node.slice(1)}VerId`) as
      | "promptRewriteVerId"
      | "promptIntentVerId"
      | "promptReplyVerId"
      | "promptFallbackVerId";

  return (
    <>
      <div>
        <FieldLabel required>绑定知识库</FieldLabel>
        <KbChips kbs={kbs} selected={draft.kbIds} onChange={(kbIds) => patch({ kbIds })} />
      </div>

      <Divider style={{ margin: "4px 0" }} />
      <SectionTitle>模型设置</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <FieldLabel required>生成模型</FieldLabel>
          <Select
            value={draft.genModelId || undefined}
            onChange={(v) => patch({ genModelId: v })}
            placeholder="选择 LLM 模型"
            style={{ width: "100%" }}
            options={llmOpts}
          />
        </div>
        <div>
          <FieldLabel>改写 / 意图模型</FieldLabel>
          <Select
            allowClear
            value={draft.lightModelId || undefined}
            onChange={(v) => patch({ lightModelId: v ?? "" })}
            placeholder="不单独配置则复用生成模型"
            style={{ width: "100%" }}
            options={llmOpts}
          />
        </div>
        <div>
          <FieldLabel>重排模型</FieldLabel>
          <Select
            value={draft.rerankModelId}
            onChange={(v) => patch({ rerankModelId: v })}
            style={{ width: "100%" }}
            options={rerankOpts}
          />
        </div>
        <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)", lineHeight: 1.6 }}>
          向量嵌入模型由绑定的知识库决定，无需在此单独配置。
        </div>
      </div>

      <Divider style={{ margin: "4px 0" }} />
      <SectionTitle>Prompt 配置</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {PROMPT_NODES.map((node) => {
          const field = promptField(node);
          return (
            <div key={node}>
              <FieldLabel required>{NODE_LABELS[node]}</FieldLabel>
              <Select
                value={draft[field] || undefined}
                onChange={(v) => patch({ [field]: v } as Partial<ConfigDraft>)}
                placeholder={`选择${NODE_LABELS[node]} Prompt（生产版本）`}
                style={{ width: "100%" }}
                options={promptOpts(node, draft[field])}
                notFoundContent="该节点暂无已发布的 Prompt，请先到「Prompt 管理」发布"
              />
              <div style={{ marginTop: 6 }}>
                <NodeConfigRow
                  node={node}
                  config={draft.nodeParams[node]}
                  onChange={(c) => patch({ nodeParams: { ...draft.nodeParams, [node]: c } })}
                />
              </div>
            </div>
          );
        })}
      </div>

      <Divider style={{ margin: "4px 0" }} />
      <SectionTitle>检索设置</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 96, flex: "none", fontSize: 13, color: "rgba(0,0,0,.65)" }}>
            召回 Top-K
          </span>
          <InputNumber min={1} value={draft.topK} onChange={(v) => patch({ topK: v ?? 1 })} />
          <span
            style={{ width: 80, flex: "none", fontSize: 13, color: "rgba(0,0,0,.65)", marginLeft: 8 }}
          >
            重排 Top-N
          </span>
          <InputNumber min={1} value={draft.topN} onChange={(v) => patch({ topN: v ?? 1 })} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 96, flex: "none", fontSize: 13, color: "rgba(0,0,0,.65)" }}>
            相似度阈值
          </span>
          <Slider
            min={0}
            max={1}
            step={0.01}
            value={draft.threshold}
            onChange={(v) => patch({ threshold: v })}
            style={{ flex: 1 }}
          />
          <span style={{ width: 44, textAlign: "right", fontSize: 13 }}>{draft.threshold}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>多路召回（向量 + 关键词）</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>关闭则仅使用向量召回</div>
          </div>
          <Switch checked={draft.multiRecall} onChange={(v) => patch({ multiRecall: v })} />
        </div>
        {draft.multiRecall && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 96, flex: "none", fontSize: 13, color: "rgba(0,0,0,.65)" }}>
              向量权重
            </span>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={draft.vecWeight}
              onChange={(v) => patch({ vecWeight: v })}
              style={{ flex: 1 }}
            />
            <span style={{ width: 110, textAlign: "right", fontSize: 12, color: "rgba(0,0,0,.55)" }}>
              向量 {draft.vecWeight.toFixed(2)} · 关键词 {(1 - draft.vecWeight).toFixed(2)}
            </span>
          </div>
        )}
      </div>

      <Divider style={{ margin: "4px 0" }} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>未命中知识时兜底转人工</div>
          <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
            召回分数低于阈值时提示联系人工客服
          </div>
        </div>
        <Switch checked={draft.fallbackHuman} onChange={(v) => patch({ fallbackHuman: v })} />
      </div>
    </>
  );
}

/** 版本只读摘要（编辑抽屉/配置版本详情共用） */
function VersionSummary({
  v,
  kbName,
  modelName,
}: {
  v: AgentConfigVersion;
  kbName: (id: string) => string;
  modelName: (id: string) => string;
}) {
  const line: React.CSSProperties = { display: "flex", gap: 8, fontSize: 13, lineHeight: 1.9 };
  const label: React.CSSProperties = { width: 88, flex: "none", color: "rgba(0,0,0,.45)" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={line}>
        <span style={label}>知识库</span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {v.kbIds.map((id) => (
            <Tag key={id}>{kbName(id)}</Tag>
          ))}
        </span>
      </div>
      <div style={line}>
        <span style={label}>生成模型</span>
        <span>{modelName(v.genModelId)}</span>
      </div>
      {v.rerankModelId && (
        <div style={line}>
          <span style={label}>重排模型</span>
          <span>{modelName(v.rerankModelId)}</span>
        </div>
      )}
      <div style={line}>
        <span style={label}>检索参数</span>
        <span>
          topK {v.topK} · topN {v.topN} · 阈值 {v.threshold}
          {v.multiRecall ? ` · 多路召回（向量 ${v.vecWeight ?? "-"}）` : " · 仅向量"}
        </span>
      </div>
      <div style={line}>
        <span style={label}>兜底转人工</span>
        <span>{v.fallbackHuman ? "开启" : "关闭"}</span>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState("");
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [promptsByNode, setPromptsByNode] = useState<Record<PromptNode, Prompt[]>>({
    rewrite: [],
    intent: [],
    reply: [],
    fallback: [],
  });

  // 新建 Agent 抽屉
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<ConfigDraft>(defaultDraft());
  const [draftErr, setDraftErr] = useState("");
  const [saving, setSaving] = useState(false);

  // 编辑抽屉（收窄 name/desc/enabled）
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editForm, setEditForm] = useState({ name: "", desc: "", enabled: true });
  const [editErr, setEditErr] = useState("");

  // 配置版本抽屉
  const [verAgent, setVerAgent] = useState<Agent | null>(null);
  const [versions, setVersions] = useState<AgentConfigVersion[]>([]);
  const [verLoading, setVerLoading] = useState(false);
  const [verErr, setVerErr] = useState("");
  const [selVerId, setSelVerId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // 新建配置版本（嵌套抽屉）
  const [newVerOpen, setNewVerOpen] = useState(false);
  const [verDraft, setVerDraft] = useState<ConfigDraft>(defaultDraft());
  const [verDraftErr, setVerDraftErr] = useState("");
  const [verSaving, setVerSaving] = useState(false);

  const kbNameMap = useMemo(() => new Map(kbs.map((k) => [k.id, k.name])), [kbs]);
  const modelNameMap = useMemo(() => new Map(models.map((m) => [m.id, m.name])), [models]);
  const kbName = useCallback((id: string) => kbNameMap.get(id) ?? id, [kbNameMap]);
  const modelName = useCallback((id: string) => modelNameMap.get(id) ?? id, [modelNameMap]);

  const refreshList = useCallback(async () => {
    setLoading(true);
    setListErr("");
    try {
      setRows(await getAgents());
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 引用数据（知识库/模型/各节点 Prompt）一次拉全，供表单与列表名称映射
  const loadRefs = useCallback(async () => {
    try {
      const [kbList, modelList, ...promptPages] = await Promise.all([
        getKnowledgeBases(),
        getModels(),
        ...PROMPT_NODES.map((node) => getPrompts({ page: 1, pageSize: 100, node })),
      ]);
      setKbs(kbList);
      setModels(modelList);
      setPromptsByNode({
        rewrite: promptPages[0].items,
        intent: promptPages[1].items,
        reply: promptPages[2].items,
        fallback: promptPages[3].items,
      });
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "加载引用数据失败");
    }
  }, []);

  useEffect(() => {
    void refreshList();
    void loadRefs();
  }, [refreshList, loadRefs]);

  const refreshVersions = useCallback(async (agentId: string) => {
    setVerLoading(true);
    setVerErr("");
    try {
      setVersions(await getAgentConfigVersions(agentId));
    } catch (e) {
      setVerErr(e instanceof Error ? e.message : "加载配置版本失败");
    } finally {
      setVerLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!verAgent) return;
    void refreshVersions(verAgent.id);
    setSelVerId(null);
  }, [verAgent, refreshVersions]);

  const patchDraft = (p: Partial<ConfigDraft>) => {
    setDraft((prev) => ({ ...prev, ...p }));
    setDraftErr("");
  };
  const patchVerDraft = (p: Partial<ConfigDraft>) => {
    setVerDraft((prev) => ({ ...prev, ...p }));
    setVerDraftErr("");
  };

  const openCreate = () => {
    setDraft(defaultDraft());
    setDraftErr("");
    setCreateOpen(true);
  };

  const saveCreate = async () => {
    const err = validateDraft(draft, true);
    if (err) {
      setDraftErr(err);
      return;
    }
    setSaving(true);
    try {
      await createAgent({
        ...draftConfigFields(draft),
        name: draft.name.trim(),
        desc: draft.desc.trim(),
      });
      message.success("Agent 已创建并上线（v1）");
      setCreateOpen(false);
      await refreshList();
    } catch (e) {
      setDraftErr(e instanceof Error ? e.message : "创建失败");
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (a: Agent) => {
    setEditAgent(a);
    setEditForm({ name: a.name, desc: a.desc, enabled: a.enabled });
    setEditErr("");
  };

  const saveEdit = async () => {
    if (!editAgent) return;
    if (!editForm.name.trim()) {
      setEditErr("请填写 Agent 名称");
      return;
    }
    setSaving(true);
    try {
      await updateAgent(editAgent.id, {
        name: editForm.name.trim(),
        desc: editForm.desc.trim(),
        enabled: editForm.enabled,
      });
      message.success("已保存");
      setEditAgent(null);
      await refreshList();
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const openNewVersion = () => {
    if (!verAgent) return;
    const base =
      versions.find((v) => v.status === "published") ?? verAgent.currentVersion ?? undefined;
    setVerDraft(base ? draftFromVersion(base) : defaultDraft());
    setVerDraftErr("");
    setNewVerOpen(true);
  };

  const saveNewVersion = async () => {
    if (!verAgent) return;
    const err = validateDraft(verDraft, false);
    if (err) {
      setVerDraftErr(err);
      return;
    }
    setVerSaving(true);
    try {
      const created = await createAgentConfigVersion(verAgent.id, {
        ...draftConfigFields(verDraft),
        note: verDraft.note.trim() || undefined,
      });
      message.success(`已创建配置版本 v${created.version}（草稿）`);
      setNewVerOpen(false);
      await refreshVersions(verAgent.id);
      setSelVerId(created.id);
    } catch (e) {
      setVerDraftErr(e instanceof Error ? e.message : "创建失败");
    } finally {
      setVerSaving(false);
    }
  };

  const doVersionAction = async (
    action: "eval" | "publish" | "rollback",
    v: AgentConfigVersion,
  ) => {
    if (!verAgent) return;
    setActionBusy(true);
    setVerErr("");
    try {
      if (action === "eval") {
        await runAgentConfigVersionEval(verAgent.id, v.id);
        message.success("Eval 已通过（M11 前为占位评测）");
      } else if (action === "publish") {
        await publishAgentConfigVersion(verAgent.id, v.id);
        message.success(`v${v.version} 已发布为生产版本`);
      } else {
        await rollbackAgentConfigVersion(verAgent.id, v.id);
        message.success(`已回滚到 v${v.version}`);
      }
      await refreshVersions(verAgent.id);
      await refreshList();
    } catch (e) {
      setVerErr(e instanceof Error ? e.message : "操作失败");
    } finally {
      setActionBusy(false);
    }
  };

  const selVersion = versions.find((v) => v.id === selVerId) ?? versions[0] ?? null;

  const columns: TableColumnsType<Agent> = [
    {
      title: "Agent",
      key: "agent",
      width: 220,
      render: (_: unknown, r: Agent) => (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 30,
              height: 30,
              flex: "none",
              borderRadius: 8,
              background: avatarColor(r.name),
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {r.name[0]}
          </div>
          <div>
            <div style={{ fontWeight: 500 }}>{r.name}</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>{r.desc || "—"}</div>
          </div>
        </div>
      ),
    },
    {
      title: "绑定知识库",
      key: "kbs",
      render: (_: unknown, r: Agent) => (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(r.currentVersion?.kbIds ?? []).map((id) => (
            <Tag key={id}>{kbName(id)}</Tag>
          ))}
          {!r.currentVersion && <span style={{ color: "rgba(0,0,0,.35)" }}>—</span>}
        </div>
      ),
    },
    {
      title: "生成模型",
      key: "model",
      width: 150,
      render: (_: unknown, r: Agent) =>
        r.currentVersion ? (
          <span style={{ color: "rgba(0,0,0,.65)" }}>{modelName(r.currentVersion.genModelId)}</span>
        ) : (
          <span style={{ color: "rgba(0,0,0,.35)" }}>—</span>
        ),
    },
    {
      title: "状态",
      key: "status",
      width: 90,
      render: (_: unknown, r: Agent) => {
        const st = STATUS_TAG[r.status];
        const t = tagOf(st.tag);
        return (
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
            {st.label}
          </span>
        );
      },
    },
    {
      title: "更新时间",
      key: "updatedAt",
      width: 120,
      render: (_: unknown, r: Agent) => (
        <span style={{ color: "rgba(0,0,0,.45)" }}>{formatDateTime(r.updatedAt)}</span>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 190,
      render: (_: unknown, r: Agent) => (
        <Space size="small">
          <Button type="link" size="small" onClick={() => setVerAgent(r)}>
            配置版本
          </Button>
          <Button type="link" size="small" onClick={() => openEdit(r)}>
            编辑
          </Button>
          {/* Trace 过滤键用 agentId（稳定主键，008 Invariant 4——name 可编辑，改名会漏历史） */}
          <Button
            type="link"
            size="small"
            style={{ color: "rgba(0,0,0,.45)" }}
            onClick={() => navigate(`/admin/traces?agentId=${encodeURIComponent(r.id)}`)}
          >
            日志
          </Button>
        </Space>
      ),
    },
  ];

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
        <Button type="primary" onClick={openCreate}>
          ＋ 新建 Agent
        </Button>
      </div>

      {listErr && (
        <Alert
          type="error"
          title={listErr}
          showIcon
          closable
          onClose={() => setListErr("")}
          style={{ marginBottom: 12 }}
        />
      )}

      <Table<Agent>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        size="middle"
        locale={{ emptyText: "暂无 Agent，点击右上角「新建 Agent」创建" }}
      />

      {/* 新建 Agent 抽屉（五区块，原型 480px） */}
      <Drawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        size={480}
        title="新建 Agent"
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#ff4d4f" }}>{draftErr}</span>
            <Space>
              <Button onClick={() => setCreateOpen(false)}>取消</Button>
              <Button type="primary" loading={saving} onClick={() => void saveCreate()}>
                创建 Agent
              </Button>
            </Space>
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <FieldLabel required>Agent 名称</FieldLabel>
            <Input
              value={draft.name}
              onChange={(e) => patchDraft({ name: e.target.value })}
              placeholder="如：售后支持"
            />
          </div>
          <div>
            <FieldLabel>简介</FieldLabel>
            <Input
              value={draft.desc}
              onChange={(e) => patchDraft({ desc: e.target.value })}
              placeholder="一句话描述 Agent 的职责范围"
            />
          </div>
          <ConfigFields
            draft={draft}
            patch={patchDraft}
            kbs={kbs}
            models={models}
            promptsByNode={promptsByNode}
          />
        </div>
      </Drawer>

      {/* 编辑抽屉：仅 name/desc/enabled 可改（008 决策 3），其余只读 + 引导走配置版本 */}
      <Drawer
        open={editAgent !== null}
        onClose={() => setEditAgent(null)}
        size={480}
        title={`编辑 Agent${editAgent ? ` · ${editAgent.name}` : ""}`}
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#ff4d4f" }}>{editErr}</span>
            <Space>
              <Button onClick={() => setEditAgent(null)}>取消</Button>
              <Button type="primary" loading={saving} onClick={() => void saveEdit()}>
                保存
              </Button>
            </Space>
          </div>
        }
      >
        {editAgent && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <FieldLabel required>Agent 名称</FieldLabel>
              <Input
                value={editForm.name}
                onChange={(e) => {
                  setEditForm((f) => ({ ...f, name: e.target.value }));
                  setEditErr("");
                }}
              />
            </div>
            <div>
              <FieldLabel>简介</FieldLabel>
              <Input
                value={editForm.desc}
                onChange={(e) => setEditForm((f) => ({ ...f, desc: e.target.value }))}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>启用状态</div>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                  关闭后 Agent 下线，不再对外服务
                </div>
              </div>
              <Switch
                checked={editForm.enabled}
                onChange={(v) => setEditForm((f) => ({ ...f, enabled: v }))}
              />
            </div>

            <Divider style={{ margin: "4px 0" }} />
            <SectionTitle>当前生产配置（只读）</SectionTitle>
            {editAgent.currentVersion ? (
              <VersionSummary
                v={editAgent.currentVersion}
                kbName={kbName}
                modelName={modelName}
              />
            ) : (
              <span style={{ fontSize: 13, color: "rgba(0,0,0,.35)" }}>暂无生产版本</span>
            )}
            <Alert
              type="info"
              showIcon
              title="如需调整知识库/模型/Prompt/检索参数，请通过「新建配置版本」走 Eval 门槛后发布"
              action={
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    const a = editAgent;
                    setEditAgent(null);
                    setVerAgent(a);
                  }}
                >
                  去配置版本
                </Button>
              }
            />
          </div>
        )}
      </Drawer>

      {/* 配置版本抽屉：左版本历史 + 右详情/操作 */}
      <Drawer
        open={verAgent !== null}
        onClose={() => setVerAgent(null)}
        size={760}
        title={
          <Space>
            <span>配置版本</span>
            <span style={{ fontSize: 13, color: "rgba(0,0,0,.55)" }}>{verAgent?.name ?? "—"}</span>
          </Space>
        }
        extra={
          <Button type="primary" size="small" onClick={openNewVersion}>
            ＋ 新建配置版本
          </Button>
        }
        styles={{ body: { padding: 0 } }}
      >
        <div style={{ display: "flex", minHeight: "100%" }}>
          <div
            style={{
              width: 264,
              flex: "none",
              borderRight: "1px solid #f0f0f0",
              overflowY: "auto",
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", padding: "0 2px" }}>
              版本历史 · 一次发布 = 配置整体快照
            </div>
            {verLoading ? (
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", padding: 8 }}>加载中…</div>
            ) : versions.length === 0 ? (
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)", padding: 8 }}>暂无版本</div>
            ) : (
              versions.map((v) => {
                const selected = selVersion?.id === v.id;
                const stTag =
                  v.status === "published" ? "green" : v.status === "draft" ? "purple" : "gray";
                const st = tagOf(stTag);
                return (
                  <div
                    key={v.id}
                    onClick={() => setSelVerId(v.id)}
                    style={{
                      border: `1px solid ${selected ? "#1677ff" : "#f0f0f0"}`,
                      background: selected ? "#e6f4ff" : "#fff",
                      borderRadius: 8,
                      padding: "10px 12px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>v{v.version}</span>
                      <span
                        style={{
                          fontSize: 11,
                          lineHeight: "18px",
                          padding: "0 7px",
                          borderRadius: 9,
                          background: st.bg,
                          color: st.c,
                          border: `1px solid ${st.bd}`,
                        }}
                      >
                        {v.status === "published"
                          ? "生产中"
                          : v.status === "draft"
                            ? "草稿"
                            : "已归档"}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(0,0,0,.6)", marginBottom: 5 }}>
                      {v.note || "（无变更说明）"}
                    </div>
                    <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)" }}>
                      {v.createdBy} · {formatDateTime(v.createdAt)}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div
            style={{
              flex: 1,
              minWidth: 0,
              padding: "16px 20px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {verErr && (
              <Alert type="error" showIcon title={verErr} closable onClose={() => setVerErr("")} />
            )}
            {selVersion ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>v{selVersion.version}</span>
                  <Tag
                    color={
                      selVersion.evalStatus === "not_run"
                        ? "default"
                        : selVersion.evalStatus === "exempt"
                          ? "blue"
                          : "green"
                    }
                  >
                    {EVAL_STATUS_LABEL[selVersion.evalStatus]}
                  </Tag>
                  {selVersion.publishedAt && (
                    <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                      发布于 {formatDateTime(selVersion.publishedAt)} · {selVersion.publishedBy}
                    </span>
                  )}
                </div>
                <VersionSummary v={selVersion} kbName={kbName} modelName={modelName} />
                {selVersion.evalStatus === "passed" && selVersion.evalRunAt && (
                  <Alert
                    type="info"
                    showIcon
                    title={`Eval 于 ${formatDateTime(selVersion.evalRunAt)} 标记通过 — M11 评测系统上线前为占位（未执行真实回归集）`}
                  />
                )}

                <Divider style={{ margin: "4px 0" }} />
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {selVersion.status === "draft" && selVersion.evalStatus === "not_run" && (
                    <>
                      <Button
                        type="primary"
                        loading={actionBusy}
                        onClick={() => void doVersionAction("eval", selVersion)}
                      >
                        跑 Eval
                      </Button>
                      <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                        发布前必须先跑一次 Eval 并通过（M7 阶段为占位评测，直接标记通过）
                      </span>
                    </>
                  )}
                  {selVersion.status === "draft" &&
                    (selVersion.evalStatus === "passed" || selVersion.evalStatus === "exempt") && (
                      <Popconfirm
                        title={`确认发布 v${selVersion.version} 为生产版本？`}
                        description="原生产版本将自动归档，可随时回滚。"
                        okText="通过并发布"
                        cancelText="取消"
                        onConfirm={() => void doVersionAction("publish", selVersion)}
                      >
                        <Button type="primary" loading={actionBusy}>
                          通过并发布
                        </Button>
                      </Popconfirm>
                    )}
                  {selVersion.status === "archived" && (
                    <Popconfirm
                      title={`确认回滚到 v${selVersion.version}？`}
                      description="当前生产版本将自动归档。"
                      okText="回滚"
                      cancelText="取消"
                      onConfirm={() => void doVersionAction("rollback", selVersion)}
                    >
                      <Button loading={actionBusy}>回滚到此版本</Button>
                    </Popconfirm>
                  )}
                  {selVersion.status === "published" && (
                    <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                      当前生产版本，对外服务中
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div style={{ padding: 40, textAlign: "center", color: "rgba(0,0,0,.35)" }}>
                左侧选择一个版本查看详情
              </div>
            )}
          </div>
        </div>
      </Drawer>

      {/* 新建配置版本（嵌套抽屉，预填当前生产版本，可改绑知识库——008 决策 1） */}
      <Drawer
        open={newVerOpen}
        onClose={() => setNewVerOpen(false)}
        size={480}
        title={`新建配置版本${verAgent ? ` · ${verAgent.name}` : ""}`}
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#ff4d4f" }}>{verDraftErr}</span>
            <Space>
              <Button onClick={() => setNewVerOpen(false)}>取消</Button>
              <Button type="primary" loading={verSaving} onClick={() => void saveNewVersion()}>
                创建草稿版本
              </Button>
            </Space>
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Alert
            type="info"
            showIcon
            title="已预填当前生产配置作为起点；创建后为草稿，需跑 Eval 并发布才生效"
          />
          <ConfigFields
            draft={verDraft}
            patch={patchVerDraft}
            kbs={kbs}
            models={models}
            promptsByNode={promptsByNode}
          />
          <div>
            <FieldLabel>变更说明</FieldLabel>
            <Input
              value={verDraft.note}
              onChange={(e) => patchVerDraft({ note: e.target.value })}
              placeholder="记录本次调整的目的，便于回溯"
            />
          </div>
        </div>
      </Drawer>
    </div>
  );
}
