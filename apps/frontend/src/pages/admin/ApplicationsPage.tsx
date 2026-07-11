import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  type TableColumnsType,
} from "antd";
import type {
  Application,
  ApplicationConfigFields,
  ApplicationNodeConfig,
  KnowledgeBase,
  ModelProvider,
  PromptNode,
  PromptNodeVersionCandidate,
} from "@codecrush/contracts";
import {
  createApplication,
  deleteApplication,
  getApplications,
  getKnowledgeBases,
  getModels,
  getPromptNodeVersions,
} from "../../api/client";

/**
 * 应用列表页（M7a Story 5）：● 服务中 · vN / 未上线两态、版本计数、点行进详情。
 * 新建弹窗只收 slug/name/description + 知识库多选（业务核心选择不代填）；v1 其余配置
 * 用 buildDefaultConfig 默认值，进详情再逐节点调整并保存新版本。production 上线属 M7b。
 */

const PROMPT_NODES: PromptNode[] = ["rewrite", "intent", "reply", "fallback"];
const NODE_LABELS: Record<PromptNode, string> = {
  rewrite: "问题改写",
  intent: "意图识别",
  reply: "回复生成",
  fallback: "兜底话术",
};

const mono: CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace" };

/** ISO datetime → "MM-DD HH:mm"（本地时区，对齐原型展示）。 */
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
 * 新建 v1 的默认配置：四节点 promptVersionId 取该节点第一个候选、modelId 取第一个启用
 * llm、freedom balance、temperature 0.7、topP 0.9；检索 topK20/topN5/hybrid on/weight0.7、
 * 不启用重排；兜底转人工 on。任一节点无候选或无启用 llm → 返回 null（新建应被禁用）。
 * 导出纯函数便于单测。
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

export default function ApplicationsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 新建弹窗引用数据：知识库 / 模型 / 四节点 Prompt 候选（判定缺什么 + 组装默认 config）
  const [createOpen, setCreateOpen] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [candidatesByNode, setCandidatesByNode] = useState<
    Record<PromptNode, PromptNodeVersionCandidate[]>
  >({ rewrite: [], intent: [], reply: [], fallback: [] });
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);
  const [form] = Form.useForm<{ slug: string; name: string; description?: string }>();

  const refreshList = useCallback(async () => {
    setLoading(true);
    setListErr("");
    try {
      setRows(await getApplications());
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // 新建弹窗打开时拉引用数据（判定缺什么 + 组装 v1 config）
  const openCreate = async () => {
    setCreateOpen(true);
    setCreateErr("");
    setSelectedKbIds([]);
    form.resetFields();
    try {
      const [kbList, modelList, ...nodeLists] = await Promise.all([
        getKnowledgeBases(),
        getModels(),
        ...PROMPT_NODES.map((node) => getPromptNodeVersions(node)),
      ]);
      setKbs(kbList);
      setModels(modelList);
      setCandidatesByNode({
        rewrite: nodeLists[0],
        intent: nodeLists[1],
        reply: nodeLists[2],
        fallback: nodeLists[3],
      });
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "加载引用数据失败");
    }
  };

  // 缺失文案（三态分别断言）：无知识库 / 无启用 llm / 某节点无 Prompt 候选
  const missing: string[] = [];
  if (kbs.length === 0) missing.push("请先到「知识库」创建至少一个知识库");
  if (!models.some((m) => m.type === "llm" && m.enabled))
    missing.push("请先到「模型接入」启用一个 LLM 模型");
  const emptyNodes = PROMPT_NODES.filter((n) => candidatesByNode[n].length === 0);
  if (emptyNodes.length > 0)
    missing.push(
      `请先到「Prompt 管理」为 ${emptyNodes.map((n) => NODE_LABELS[n]).join("、")} 创建 Prompt`,
    );

  const submitCreate = async () => {
    let values: { slug: string; name: string; description?: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (selectedKbIds.length === 0) {
      setCreateErr("请至少选择一个知识库");
      return;
    }
    const config = buildDefaultConfig(selectedKbIds, candidatesByNode, models);
    if (!config) {
      setCreateErr("默认配置不完整，请检查模型与 Prompt 候选");
      return;
    }
    setCreating(true);
    setCreateErr("");
    try {
      const detail = await createApplication({
        slug: values.slug.trim(),
        name: values.name.trim(),
        description: values.description?.trim() ?? "",
        config,
      });
      setCreateOpen(false);
      navigate(`/admin/applications/${detail.id}`);
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const deleteById = async (id: string) => {
    setDeletingId(id);
    setListErr("");
    try {
      await deleteApplication(id);
      await refreshList();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  const columns: TableColumnsType<Application> = [
    {
      title: "应用名称",
      dataIndex: "name",
      key: "name",
      width: 220,
      render: (name: string, r: Application) => (
        <div>
          <div style={{ fontWeight: 500 }}>{name}</div>
          <div style={{ ...mono, fontSize: 12, color: "rgba(0,0,0,.35)" }}>{r.slug}</div>
        </div>
      ),
    },
    {
      title: "上线状态",
      key: "production",
      width: 140,
      render: (_: unknown, r: Application) =>
        r.productionVersion != null ? (
          <Tag color="green">● 服务中 · v{r.productionVersion}</Tag>
        ) : (
          <Tag>未上线</Tag>
        ),
    },
    {
      title: "描述",
      dataIndex: "description",
      key: "description",
      render: (desc: string) =>
        desc ? (
          <span style={{ color: "rgba(0,0,0,.65)" }}>{desc}</span>
        ) : (
          <span style={{ color: "rgba(0,0,0,.35)" }}>—</span>
        ),
    },
    {
      title: "版本",
      key: "versions",
      width: 100,
      render: (_: unknown, r: Application) => (
        <span style={mono}>
          v{r.latestVersion}
          {r.versionCount > 1 && (
            <span style={{ color: "rgba(0,0,0,.35)", fontSize: 12 }}> / {r.versionCount} 版</span>
          )}
        </span>
      ),
    },
    {
      title: "更新人 · 时间",
      key: "updated",
      width: 200,
      render: (_: unknown, r: Application) => (
        <span style={{ color: "rgba(0,0,0,.65)" }}>
          {r.updatedBy} · {formatDateTime(r.updatedAt)}
        </span>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 120,
      render: (_: unknown, r: Application) => (
        <Space size="small" onClick={(e) => e.stopPropagation()}>
          <Button
            type="link"
            size="small"
            onClick={() => navigate(`/admin/applications/${r.id}`)}
          >
            打开
          </Button>
          <Popconfirm
            title="确认删除该应用？全部配置版本将一并删除。"
            description={r.productionConfigVersionId ? "该应用有生产版本指针，删除后不可恢复。" : undefined}
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => deleteById(r.id)}
          >
            <Button type="link" size="small" danger loading={deletingId === r.id}>
              删除
            </Button>
          </Popconfirm>
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
        <div style={{ fontSize: 16, fontWeight: 600 }}>应用管理</div>
        <Button type="primary" onClick={() => void openCreate()}>
          ＋ 新建应用
        </Button>
      </div>

      {listErr && (
        <Alert
          type="error"
          message={listErr}
          showIcon
          closable
          onClose={() => setListErr("")}
          style={{ marginBottom: 12 }}
        />
      )}

      <Table<Application>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        onRow={(r) => ({
          onClick: () => navigate(`/admin/applications/${r.id}`),
          style: { cursor: "pointer" },
        })}
        pagination={false}
        size="middle"
        locale={{ emptyText: "暂无应用，点击右上角「新建应用」创建" }}
      />

      <Modal
        open={createOpen}
        title="新建应用"
        okText="创建并配置"
        cancelText="取消"
        confirmLoading={creating}
        okButtonProps={{ disabled: missing.length > 0 || selectedKbIds.length === 0 }}
        onOk={() => void submitCreate()}
        onCancel={() => {
          setCreateOpen(false);
          setCreateErr("");
          form.resetFields();
        }}
        destroyOnHidden
      >
        {missing.length > 0 ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            {missing.map((m) => (
              <Alert key={m} type="warning" showIcon message={m} />
            ))}
          </Space>
        ) : (
          <Form form={form} layout="vertical">
            <Form.Item
              name="slug"
              label="应用标识 slug"
              rules={[
                { required: true, message: "请填写 slug" },
                {
                  pattern: /^[a-z0-9][a-z0-9-]{1,62}$/,
                  message: "小写字母/数字/连字符，2-63 位，不以连字符开头",
                },
              ]}
            >
              <Input placeholder="如：aftersale-bot" />
            </Form.Item>
            <Form.Item
              name="name"
              label="应用名称"
              rules={[{ required: true, whitespace: true, message: "请填写应用名称" }]}
            >
              <Input placeholder="如：售后助手" />
            </Form.Item>
            <Form.Item name="description" label="描述（可选）">
              <Input.TextArea rows={2} placeholder="一句话说明这个应用做什么" />
            </Form.Item>
            <Form.Item label="绑定知识库" required>
              <Select
                mode="multiple"
                placeholder="选择该应用检索的知识库（必选，至少一个）"
                value={selectedKbIds}
                onChange={setSelectedKbIds}
                style={{ width: "100%" }}
                options={kbs.map((k) => ({ value: k.id, label: k.name }))}
              />
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 6 }}>
                四节点 Prompt、模型与检索参数将用默认值创建首个版本，进详情后可逐项调整并保存新版本。
              </div>
            </Form.Item>
          </Form>
        )}
        {createErr && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#ff4d4f" }}>{createErr}</div>
        )}
      </Modal>
    </div>
  );
}
