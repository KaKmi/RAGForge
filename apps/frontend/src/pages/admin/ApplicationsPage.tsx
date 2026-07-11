import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Drawer,
  Input,
  Popconfirm,
  Select,
  Slider,
  Spin,
  Table,
  Tag,
  type TableColumnsType,
} from "antd";
import type {
  Application,
  ApplicationConfigFields,
  ApplicationNodeConfig,
  Freedom,
  KnowledgeBase,
  ModelProvider,
  PromptNode,
  PromptNodeVersionCandidate,
} from "@codecrush/contracts";
import {
  createApplication,
  deleteApplication,
  getApplicationDetail,
  getApplications,
  getKnowledgeBases,
  getModels,
  getPromptNodeVersions,
  updateApplication,
} from "../../api/client";

/**
 * 应用列表页（M7a Story 5，对齐原型 CodeCrushBot.dc.html「应用管理」列表屏）：
 * 头像 + 名称/描述、绑定知识库 chips、生成模型、标识（production→vN / 未上线）、更新、操作。
 * 知识库/生成模型列后端 list 不返回——按行并发拉 detail 补齐（应用量少，可接受）。
 * 新建 = 右侧完整配置抽屉（名称/slug/简介/知识库/模型设置/四节点 Prompt 配置），提交进详情。
 */

const PROMPT_NODES: PromptNode[] = ["rewrite", "intent", "reply", "fallback"];
const NODE_LABELS: Record<PromptNode, string> = {
  rewrite: "问题改写",
  intent: "意图识别",
  reply: "回复生成",
  fallback: "兜底话术",
};
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
const AVATAR_COLORS = ["#1677ff", "#52c41a", "#722ed1", "#fa8c16", "#eb2f96", "#13c2c2", "#2f54eb"];

const mono: CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace" };

function avatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

/** ISO datetime → "MM-DD HH:mm"。 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/**
 * 新建 v1 的默认配置：四节点 promptVersionId 取该节点第一个候选、modelId 取第一个启用 llm、
 * freedom balance、temperature 0.7、topP 0.9；检索 topK20/topN5/hybrid on/weight0.7/不重排；
 * 兜底转人工 on。任一节点无候选或无启用 llm → 返回 null。导出供单测。
 */
export function buildDefaultConfig(
  kbIds: string[],
  candidatesByNode: Record<PromptNode, PromptNodeVersionCandidate[]>,
  models: ModelProvider[],
): ApplicationConfigFields | null {
  const llm = models.find((m) => m.type === "llm" && m.enabled);
  if (!llm) return null;
  const nodeConfig = (node: PromptNode): ApplicationNodeConfig | null => {
    const first = candidatesByNode[node]?.[0];
    if (!first) return null;
    return {
      promptVersionId: first.versionId,
      modelId: llm.id,
      freedom: "balance",
      temperature: 0.7,
      topP: 0.9,
    };
  };
  const rewrite = nodeConfig("rewrite");
  const intent = nodeConfig("intent");
  const reply = nodeConfig("reply");
  const fallback = nodeConfig("fallback");
  if (!rewrite || !intent || !reply || !fallback) return null;
  return {
    kbIds,
    nodes: { rewrite, intent, reply, fallback },
    retrieval: {
      schemaVersion: 1,
      topK: 20,
      topN: 5,
      hybridEnabled: true,
      vectorWeight: 0.7,
      rerankEnabled: false,
    },
    fallback: { toHuman: true },
  };
}

interface NodeDraft {
  promptVersionId: string;
  freedom: Freedom;
  temperature: number;
  topP: number;
}
interface CreateDraft {
  name: string;
  slug: string;
  description: string;
  kbIds: string[];
  genModelId: string; // 生成模型 → reply / fallback
  lightModelId: string; // 改写 / 意图模型 → rewrite / intent（空则复用生成）
  rerankModelId: string; // "" = 不启用重排
  nodes: Record<PromptNode, NodeDraft>;
}

function emptyNode(): NodeDraft {
  return { promptVersionId: "", freedom: "balance", temperature: 0.7, topP: 0.9 };
}
function initDraft(
  candidatesByNode: Record<PromptNode, PromptNodeVersionCandidate[]>,
  models: ModelProvider[],
): CreateDraft {
  const llm = models.find((m) => m.type === "llm" && m.enabled);
  const nodes = {} as Record<PromptNode, NodeDraft>;
  for (const n of PROMPT_NODES)
    nodes[n] = { ...emptyNode(), promptVersionId: candidatesByNode[n]?.[0]?.versionId ?? "" };
  return {
    name: "",
    slug: "",
    description: "",
    kbIds: [],
    genModelId: llm?.id ?? "",
    lightModelId: "",
    rerankModelId: "",
    nodes,
  };
}
/** 抽屉草稿 → CreateApplicationRequest 的 config（生成/改写意图模型映射到四节点）。 */
function assembleConfig(d: CreateDraft): ApplicationConfigFields {
  const nodeCfg = (node: PromptNode, modelId: string): ApplicationNodeConfig => ({
    promptVersionId: d.nodes[node].promptVersionId,
    modelId,
    freedom: d.nodes[node].freedom,
    temperature: d.nodes[node].temperature,
    topP: d.nodes[node].topP,
  });
  const light = d.lightModelId || d.genModelId;
  return {
    kbIds: d.kbIds,
    nodes: {
      rewrite: nodeCfg("rewrite", light),
      intent: nodeCfg("intent", light),
      reply: nodeCfg("reply", d.genModelId),
      fallback: nodeCfg("fallback", d.genModelId),
    },
    retrieval: {
      schemaVersion: 1,
      topK: 20,
      topN: 5,
      hybridEnabled: true,
      vectorWeight: 0.7,
      rerankEnabled: !!d.rerankModelId,
      rerankModelId: d.rerankModelId || undefined,
      rerankThreshold: d.rerankModelId ? 0.5 : undefined,
    },
    fallback: { toHuman: true },
  };
}

interface RowExtra {
  kbNames: string[];
  genModel: string;
}

export default function ApplicationsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [extra, setExtra] = useState<Record<string, RowExtra>>({});

  // 新建抽屉引用数据 + 草稿
  const [createOpen, setCreateOpen] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [refLoading, setRefLoading] = useState(false);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [candidatesByNode, setCandidatesByNode] = useState<
    Record<PromptNode, PromptNodeVersionCandidate[]>
  >({ rewrite: [], intent: [], reply: [], fallback: [] });
  const [draft, setDraft] = useState<CreateDraft>(() => initDraft(
    { rewrite: [], intent: [], reply: [], fallback: [] },
    [],
  ));

  const refreshList = useCallback(async () => {
    setLoading(true);
    setListErr("");
    try {
      const list = await getApplications();
      setRows(list);
      // 并发补齐每行的知识库名 / 生成模型名（后端 list 不含这些字段）
      const [kbList, modelList] = await Promise.all([getKnowledgeBases(), getModels()]);
      const kbName = new Map(kbList.map((k) => [k.id, k.name]));
      const modelName = new Map(modelList.map((m) => [m.id, m.name]));
      const details = await Promise.all(
        list.map((a) => getApplicationDetail(a.id).catch(() => null)),
      );
      const map: Record<string, RowExtra> = {};
      list.forEach((a, i) => {
        const d = details[i];
        if (!d) return;
        const v = d.versions.find((x) => x.id === d.productionConfigVersionId) ?? d.versions[0];
        map[a.id] = {
          kbNames: (v?.kbIds ?? []).map((id) => kbName.get(id) ?? id),
          genModel: v ? (modelName.get(v.nodes.reply.modelId) ?? v.nodes.reply.modelId) : "",
        };
      });
      setExtra(map);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // 先加载引用数据、再打开抽屉：避免点击那一刻抽屉遮罩恰好渲染在指针下、mouseup 触发
  // maskClose 把刚开的抽屉又关掉。按钮在加载期间显示 loading 反馈。
  const openCreate = async () => {
    setCreateErr("");
    setRefLoading(true);
    try {
      const [kbList, modelList, ...nodeLists] = await Promise.all([
        getKnowledgeBases(),
        getModels(),
        ...PROMPT_NODES.map((node) => getPromptNodeVersions(node)),
      ]);
      const cbn = {
        rewrite: nodeLists[0],
        intent: nodeLists[1],
        reply: nodeLists[2],
        fallback: nodeLists[3],
      };
      setKbs(kbList);
      setModels(modelList);
      setCandidatesByNode(cbn);
      setDraft(initDraft(cbn, modelList));
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "加载引用数据失败");
    } finally {
      setRefLoading(false);
      setCreateOpen(true);
    }
  };

  // 缺失文案（分别断言）：无知识库 / 无启用 llm / 某节点无 Prompt 候选
  const missing = useMemo(() => {
    const m: string[] = [];
    if (kbs.length === 0) m.push("请先到「知识库」创建至少一个知识库");
    if (!models.some((x) => x.type === "llm" && x.enabled))
      m.push("请先到「模型接入」启用一个 LLM 模型");
    const emptyNodes = PROMPT_NODES.filter((n) => candidatesByNode[n].length === 0);
    if (emptyNodes.length > 0)
      m.push(`请先到「Prompt 管理」为 ${emptyNodes.map((n) => NODE_LABELS[n]).join("、")} 创建 Prompt`);
    return m;
  }, [kbs, models, candidatesByNode]);

  const llmOptions = models
    .filter((m) => m.type === "llm" && m.enabled)
    .map((m) => ({ value: m.id, label: m.name }));
  const rerankOptions = [
    { value: "", label: "不启用重排" },
    ...models.filter((m) => m.type === "rerank" && m.enabled).map((m) => ({ value: m.id, label: m.name })),
  ];

  const patchDraftNode = (node: PromptNode, patch: Partial<NodeDraft>) =>
    setDraft((d) => ({ ...d, nodes: { ...d.nodes, [node]: { ...d.nodes[node], ...patch } } }));
  const setNodeFreedom = (node: PromptNode, freedom: Freedom) => {
    if (freedom === "custom") patchDraftNode(node, { freedom });
    else patchDraftNode(node, { freedom, ...FREEDOM_PRESET[freedom] });
  };

  const submitCreate = async () => {
    if (!draft.name.trim()) return setCreateErr("请填写应用名称");
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(draft.slug.trim()))
      return setCreateErr("slug 需小写字母/数字/连字符，2-63 位，不以连字符开头");
    if (draft.kbIds.length === 0) return setCreateErr("请至少选择一个知识库");
    if (!draft.genModelId) return setCreateErr("请选择生成模型");
    if (PROMPT_NODES.some((n) => !draft.nodes[n].promptVersionId))
      return setCreateErr("请为四个节点各选择一个 Prompt 版本");
    setCreating(true);
    setCreateErr("");
    try {
      const detail = await createApplication({
        slug: draft.slug.trim(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        config: assembleConfig(draft),
      });
      setCreateOpen(false);
      navigate(`/admin/applications/${detail.id}`);
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const toggleEnabled = async (a: Application) => {
    setBusyId(a.id);
    try {
      await updateApplication(a.id, { enabled: !a.enabled });
      await refreshList();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const deleteById = async (id: string) => {
    setBusyId(id);
    setListErr("");
    try {
      await deleteApplication(id);
      await refreshList();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  };

  const columns: TableColumnsType<Application> = [
    {
      title: "应用",
      key: "app",
      width: 240,
      render: (_: unknown, r: Application) => (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 30,
              height: 30,
              flex: "none",
              borderRadius: 8,
              background: avatarColor(r.id),
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {r.name.trim().charAt(0).toUpperCase() || "?"}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontWeight: 500 }}>{r.name}</span>
              {!r.enabled && (
                <Tag style={{ margin: 0, fontSize: 11, lineHeight: "16px" }}>已停用</Tag>
              )}
            </div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>{r.description || "—"}</div>
          </div>
        </div>
      ),
    },
    {
      title: "绑定知识库",
      key: "kbs",
      render: (_: unknown, r: Application) => {
        const e = extra[r.id];
        if (!e) return <span style={{ color: "rgba(0,0,0,.3)" }}>—</span>;
        return (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {e.kbNames.map((n) => (
              <Tag key={n} style={{ margin: 0 }}>
                {n}
              </Tag>
            ))}
          </div>
        );
      },
    },
    {
      title: "生成模型",
      key: "genModel",
      width: 150,
      render: (_: unknown, r: Application) => (
        <span style={{ color: "rgba(0,0,0,.65)" }}>{extra[r.id]?.genModel || "—"}</span>
      ),
    },
    {
      // M7a 仅有 production 一个标识；M7b 引入自定义命名标签（qa20260707 等）后此列展示锚点
      title: "标识",
      key: "tags",
      width: 130,
      render: (_: unknown, r: Application) =>
        r.productionVersion != null ? (
          <Tag color="green" style={mono}>
            production
          </Tag>
        ) : (
          <span style={{ color: "rgba(0,0,0,.35)" }}>—</span>
        ),
    },
    {
      title: "是否上线",
      key: "online",
      width: 120,
      render: (_: unknown, r: Application) =>
        r.productionVersion != null ? (
          <Tag color="green">已上线 · v{r.productionVersion}</Tag>
        ) : (
          <Tag>未上线</Tag>
        ),
    },
    {
      title: "更新",
      key: "updated",
      width: 170,
      render: (_: unknown, r: Application) => (
        <span style={{ color: "rgba(0,0,0,.45)" }}>
          {r.updatedBy} · {formatDateTime(r.updatedAt)}
        </span>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 170,
      render: (_: unknown, r: Application) => (
        <div style={{ display: "flex", gap: 12, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
          <a onClick={() => navigate(`/admin/applications/${r.id}`)}>配置版本</a>
          <a style={{ color: "rgba(0,0,0,.55)" }} onClick={() => void toggleEnabled(r)}>
            {r.enabled ? "停用" : "启用"}
          </a>
          <Popconfirm
            title={`删除「${r.name}」？`}
            description="会删除这个应用的所有配置版本，不影响它引用过的 Prompt。不可撤销。"
            okText="删除"
            okButtonProps={{ danger: true, loading: busyId === r.id }}
            cancelText="取消"
            onConfirm={() => deleteById(r.id)}
          >
            <a style={{ color: "#cf1322" }}>删除</a>
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>应用管理</div>
        <Button type="primary" loading={refLoading} onClick={() => void openCreate()}>
          ＋ 新建应用
        </Button>
      </div>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,.45)", marginBottom: 16, lineHeight: 1.7 }}>
        一个应用 = 知识库 + 四个节点各自用哪个 Prompt 版本、配什么模型，打包成一份可对外服务的配置。
        配置版本是不可变快照序列；上线 / 回滚统一为移动 production 标识（M7b 开放）。
      </div>

      {listErr && (
        <Alert type="error" title={listErr} showIcon closable onClose={() => setListErr("")} style={{ marginBottom: 12 }} />
      )}

      <Table<Application>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        onRow={(r) => ({ onClick: () => navigate(`/admin/applications/${r.id}`), style: { cursor: "pointer" } })}
        pagination={false}
        size="middle"
        locale={{ emptyText: "暂无应用，点击右上角「新建应用」创建" }}
      />

      <Drawer
        title="新建应用"
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setCreateErr("");
        }}
        size={480}
        extra={
          <Button
            type="primary"
            loading={creating}
            disabled={refLoading || missing.length > 0}
            onClick={() => void submitCreate()}
          >
            创建并配置
          </Button>
        }
      >
        {refLoading ? (
          <div style={{ padding: 24, textAlign: "center" }}>
            <Spin />
          </div>
        ) : missing.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {missing.map((m) => (
              <Alert key={m} type="warning" showIcon title={m} />
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <Field label={<><span style={{ color: "#ff4d4f" }}>* </span>应用名称</>}>
              <Input
                placeholder="如：售后助手"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </Field>
            <Field label={<><span style={{ color: "#ff4d4f" }}>* </span>应用标识 slug</>}>
              <Input
                placeholder="如：aftersale-bot（小写字母/数字/连字符）"
                value={draft.slug}
                onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
              />
            </Field>
            <Field label="简介">
              <Input
                placeholder="一句话描述这个应用的职责范围"
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </Field>
            <Field
              label={
                <>
                  <span style={{ color: "#ff4d4f" }}>* </span>绑定知识库{" "}
                  <span style={{ color: "rgba(0,0,0,.4)", fontWeight: 400, fontSize: 12 }}>
                    需使用相同向量模型，否则无法一起检索
                  </span>
                </>
              }
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {kbs.map((k) => {
                  const on = draft.kbIds.includes(k.id);
                  return (
                    <div
                      key={k.id}
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          kbIds: on ? d.kbIds.filter((x) => x !== k.id) : [...d.kbIds, k.id],
                        }))
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
                      {k.name}
                    </div>
                  );
                })}
              </div>
            </Field>

            <div style={{ height: 1, background: "#f0f0f0" }} />
            <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(0,0,0,.88)" }}>模型设置</div>
            <ModelRow label="生成模型">
              <Select
                value={draft.genModelId || undefined}
                onChange={(v) => setDraft((d) => ({ ...d, genModelId: v }))}
                style={{ flex: 1 }}
                placeholder="选择 LLM"
                options={llmOptions}
              />
            </ModelRow>
            <ModelRow label="改写 / 意图">
              <Select
                allowClear
                value={draft.lightModelId || undefined}
                onChange={(v) => setDraft((d) => ({ ...d, lightModelId: v ?? "" }))}
                style={{ flex: 1 }}
                placeholder="不单独配置则复用生成模型"
                options={llmOptions}
              />
            </ModelRow>
            <ModelRow label="重排模型">
              <Select
                value={draft.rerankModelId}
                onChange={(v) => setDraft((d) => ({ ...d, rerankModelId: v }))}
                style={{ flex: 1 }}
                options={rerankOptions}
              />
            </ModelRow>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)", lineHeight: 1.6 }}>
              向量嵌入模型由绑定的知识库决定，无需在此单独配置。
            </div>

            <div style={{ height: 1, background: "#f0f0f0" }} />
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(0,0,0,.88)" }}>Prompt 配置</div>
              <div style={{ fontSize: 11.5, color: "rgba(0,0,0,.35)" }}>
                「自由度」预设 temperature / Top P，选「自定义」可微调
              </div>
            </div>
            {PROMPT_NODES.map((node) => {
              const n = draft.nodes[node];
              const locked = n.freedom !== "custom";
              return (
                <div key={node} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <ModelRow label={NODE_LABELS[node]}>
                    <Select
                      value={n.promptVersionId || undefined}
                      onChange={(v) => patchDraftNode(node, { promptVersionId: v })}
                      style={{ flex: 1 }}
                      placeholder="选择 Prompt 版本"
                      options={candidatesByNode[node].map((c) => ({
                        value: c.versionId,
                        label: `${c.promptName} v${c.version}${c.tags.length ? `（${c.tags.join(" ")}）` : ""}`,
                      }))}
                    />
                  </ModelRow>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 96 }}>
                    <span style={{ fontSize: 11.5, color: "rgba(0,0,0,.4)", width: 44, flex: "none" }}>
                      自由度
                    </span>
                    <Select
                      size="small"
                      value={n.freedom}
                      onChange={(v) => setNodeFreedom(node, v as Freedom)}
                      style={{ width: 92 }}
                      options={FREEDOM_OPTIONS}
                    />
                    <span style={{ fontSize: 11.5, color: "rgba(0,0,0,.4)", width: 34, flex: "none" }}>
                      温度
                    </span>
                    <Slider
                      min={0}
                      max={2}
                      step={0.01}
                      disabled={locked}
                      value={n.temperature}
                      onChange={(v) => patchDraftNode(node, { temperature: v })}
                      style={{ flex: 1, margin: 0 }}
                    />
                    <span style={{ ...mono, fontSize: 11.5, color: "rgba(0,0,0,.6)", width: 30 }}>
                      {n.temperature}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 96 }}>
                    <span style={{ width: 44, flex: "none" }} />
                    <span style={{ fontSize: 11.5, color: "rgba(0,0,0,.4)", width: 92, flex: "none" }}>
                      Top P
                    </span>
                    <Slider
                      min={0}
                      max={1}
                      step={0.01}
                      disabled={locked}
                      value={n.topP}
                      onChange={(v) => patchDraftNode(node, { topP: v })}
                      style={{ flex: 1, margin: 0 }}
                    />
                    <span style={{ ...mono, fontSize: 11.5, color: "rgba(0,0,0,.6)", width: 30 }}>
                      {n.topP}
                    </span>
                  </div>
                </div>
              );
            })}
            {createErr && <Alert type="error" showIcon title={createErr} />}
          </div>
        )}
      </Drawer>
    </div>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>{label}</div>
      {children}
    </div>
  );
}
function ModelRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ width: 96, flex: "none", fontSize: 13, color: "rgba(0,0,0,.65)" }}>{label}</div>
      {children}
    </div>
  );
}
