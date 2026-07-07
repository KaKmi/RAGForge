import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Alert,
  Button,
  Drawer,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  type TableColumnsType,
} from "antd";
import {
  diffPromptBodies,
  extractVars,
  renderTemplate,
  type Prompt,
  type PromptNode,
  type PromptVersion,
} from "@codecrush/contracts";
import {
  createPrompt,
  createPromptVersion,
  deletePrompt,
  getPromptVersions,
  getPrompts,
  publishPromptVersion,
  rollbackPromptVersion,
} from "../../api/client";
import {
  NODE_LABEL,
  NODE_META,
  STATUS_LABEL,
  STV,
  VAR_PH,
} from "../../mocks/prompts";

/**
 * Prompt 管理（M6，接真实 /api/prompts）。
 * 列表 8 列 + 编辑抽屉（变量识别/预览）+ 版本管理抽屉（Diff/绑定 Agent）。
 * UI 用 antd v6；「所属 agent」列占位（M7 Agent 实体建好后补真实关联）。
 */

/** antd Tag 预设色板 key（与 mocks/agents TAGS 对齐语义，但直接用 antd 内置色名）。 */
const NODE_TAG_COLOR: Record<PromptNode, string> = {
  rewrite: "blue",
  intent: "purple",
  reply: "green",
  fallback: "gold",
};

const mono: CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace" };

/** ISO datetime → "MM-DD HH:mm"（本地时区，对齐原型展示）。 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 版本号展示：v1 / v2 … */
function verLabel(v: number): string {
  return `v${v}`;
}

/** 编辑/新建抽屉表单。新建走 createPrompt；编辑走 createPromptVersion（基于现有版本出新 draft）。 */
interface PromptDraft {
  isNew: boolean;
  promptId: string; // 新建时为 ""
  name: string;
  node: PromptNode;
  body: string;
  note: string;
  varExamples: Record<string, string>;
  verLabel: string; // 抽屉标题右侧版本徽标
  updatedByLabel: string; // 底部"上次更新"文案
}

export default function PromptsPage() {
  const [rows, setRows] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState("");
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterNode, setFilterNode] = useState<PromptNode | "all">("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "prod" | "draft">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [drawer, setDrawer] = useState(false);
  const [pf, setPf] = useState<PromptDraft | null>(null);
  const [pfErr, setPfErr] = useState("");
  const [pfSaving, setPfSaving] = useState(false);

  // 版本管理抽屉
  const [verPromptId, setVerPromptId] = useState<string | null>(null);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [verLoading, setVerLoading] = useState(false);
  const [verErr, setVerErr] = useState("");
  const [pvSelVer, setPvSelVer] = useState<string | null>(null);
  const [pvTab, setPvTab] = useState<"diff" | "bind">("diff");

  // 后端真分页 + 条件查询：search/name+updatedBy、node、status(prod/draft)
  const refreshList = useCallback(async () => {
    setLoading(true);
    setListErr("");
    try {
      const res = await getPrompts({
        page,
        pageSize,
        search: debouncedSearch || undefined,
        node: filterNode === "all" ? undefined : filterNode,
        status: filterStatus === "all" ? undefined : filterStatus,
      });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, debouncedSearch, filterNode, filterStatus]);

  // 分页/筛选/搜索变化 → 后端查询
  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // 搜索输入 debounce 300ms + 回第 1 页
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const refreshVersions = async (promptId: string) => {
    setVerLoading(true);
    setVerErr("");
    try {
      setVersions(await getPromptVersions(promptId));
    } catch (e) {
      setVerErr(e instanceof Error ? e.message : "加载版本失败");
    } finally {
      setVerLoading(false);
    }
  };

  useEffect(() => {
    if (!verPromptId) return;
    void refreshVersions(verPromptId);
    setPvSelVer(null);
    setPvTab("diff");
  }, [verPromptId]);

  const patchPf = (patch: Partial<PromptDraft>) => {
    setPf(prev => (prev ? { ...prev, ...patch } : prev));
    setPfErr("");
  };

  const openNew = () => {
    setPf({
      isNew: true,
      promptId: "",
      name: "",
      node: "reply",
      body: "",
      note: "",
      varExamples: {},
      verLabel: "新建 v1",
      updatedByLabel: "—",
    });
    setPfErr("");
    setDrawer(true);
  };

  const openEdit = async (r: Prompt) => {
    setPfErr("");
    setDrawer(true);
    // 取当前 prod 版本 body 作为新版本起点；无 prod 则取最新版本
    setPf({
      isNew: false,
      promptId: r.id,
      name: r.name,
      node: r.node,
      body: "",
      note: "",
      varExamples: {},
      verLabel: "加载中…",
      updatedByLabel: `上次更新：${r.updatedBy} · ${formatDateTime(r.updatedAt)}`,
    });
    try {
      const vs = await getPromptVersions(r.id);
      const prod = vs.find(v => v.status === "prod") ?? vs[0];
      setPf(prev =>
        prev
          ? {
              ...prev,
              body: prod?.body ?? "",
              verLabel: prod ? `基于 ${verLabel(prod.version)} 编辑` : "新建 v1",
            }
          : prev,
      );
    } catch (e) {
      setPf(prev => (prev ? { ...prev, verLabel: "加载版本失败" } : prev));
      void e;
    }
  };

  const save = async () => {
    if (!pf) return;
    const name = pf.name.trim();
    if (!name) {
      setPfErr("请填写 Prompt 名称");
      return;
    }
    if (!pf.body.trim()) {
      setPfErr("请填写 Prompt 内容");
      return;
    }
    setPfSaving(true);
    setPfErr("");
    try {
      if (pf.isNew) {
        await createPrompt({ name, node: pf.node, body: pf.body, note: pf.note || undefined });
      } else {
        await createPromptVersion(pf.promptId, { body: pf.body, note: pf.note || undefined });
      }
      setDrawer(false);
      await refreshList();
    } catch (e) {
      setPfErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setPfSaving(false);
    }
  };

  const insertVar = (v: string) => {
    if (!pf) return;
    const body = pf.body ? pf.body + (/\s$/.test(pf.body) ? "" : " ") + v : v;
    patchPf({ body });
  };

  // 列表「发布」按钮：发布最新草稿版本（currentVersionId === null 时显示）
  const publishLatestDraft = async (promptId: string) => {
    setPublishingId(promptId);
    setListErr("");
    try {
      const vs = await getPromptVersions(promptId);
      const draft = [...vs]
        .sort((a, b) => b.version - a.version)
        .find(v => v.status === "draft");
      if (!draft) {
        setListErr("无可发布的草稿版本");
        return;
      }
      await publishPromptVersion(promptId, draft.id);
      await refreshList();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "发布失败");
    } finally {
      setPublishingId(null);
    }
  };

  // 列表「删除」按钮：仅草稿（currentVersionId === null）显示；Popconfirm 二次确认
  const deletePromptById = async (promptId: string) => {
    setDeletingId(promptId);
    setListErr("");
    try {
      await deletePrompt(promptId);
      await refreshList();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeletingId(null);
    }
  };

  // 版本管理抽屉：发布 draft 或回滚 archived
  const actOnVersion = async (v: PromptVersion) => {
    if (!verPromptId) return;
    setVerErr("");
    try {
      if (v.status === "draft") {
        await publishPromptVersion(verPromptId, v.id);
      } else {
        await rollbackPromptVersion(verPromptId, v.id);
      }
      await refreshVersions(verPromptId);
      await refreshList();
    } catch (e) {
      setVerErr(e instanceof Error ? e.message : v.status === "draft" ? "发布失败" : "回滚失败");
    }
  };

  // 版本管理抽屉派生量
  const ver = useMemo(() => {
    if (!verPromptId) return null;
    const prompt = rows.find(r => r.id === verPromptId);
    const sorted = [...versions].sort((a, b) => b.version - a.version); // 最新在前
    const prodVersion = sorted.find(v => v.status === "prod");
    const selVersion = sorted.find(v => v.id === pvSelVer) ?? sorted[0] ?? null;
    const diff =
      prodVersion && selVersion
        ? diffPromptBodies(prodVersion.body, selVersion.body).map(d => ({
            text: d.text || " ",
            sign: d.type === "add" ? "+" : d.type === "del" ? "−" : " ",
            bg: d.type === "add" ? "#f6ffed" : d.type === "del" ? "#fff2f0" : "transparent",
            color: d.type === "add" ? "#237804" : d.type === "del" ? "#a8071a" : "rgba(0,0,0,.7)",
            signC: d.type === "add" ? "#52c41a" : d.type === "del" ? "#ff4d4f" : "rgba(0,0,0,.25)",
          }))
        : [];
    const adds = diff.filter(d => d.sign === "+").length;
    const dels = diff.filter(d => d.sign === "−").length;
    const sameVer = !!prodVersion && !!selVersion && prodVersion.id === selVersion.id;
    const selStatus = selVersion?.status;
    const canPublishSel = !!selVersion && selStatus !== "prod";
    const publishSelLabel = selVersion
      ? selStatus === "draft"
        ? `发布上线 ${verLabel(selVersion.version)}`
        : `回滚到 ${verLabel(selVersion.version)}`
      : "";
    return {
      prompt,
      versions: sorted,
      prodVersion,
      selVersion,
      diff,
      diffFrom: prodVersion ? verLabel(prodVersion.version) : "—",
      diffTo: selVersion ? verLabel(selVersion.version) : "—",
      sameVer,
      adds,
      dels,
      canPublishSel,
      publishSelLabel,
    };
  }, [verPromptId, rows, versions, pvSelVer]);

  const pfMeta = pf ? NODE_META[pf.node] : null;
  // hasFilter 用于 emptyText 区分（搜索/筛选无结果 vs 无数据）
  const hasFilter = search !== "" || filterNode !== "all" || filterStatus !== "all";
  const resetFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setFilterNode("all");
    setFilterStatus("all");
    setPage(1);
  };
  // M6 fix: extractVars 返回不带花括号的 key（["context"]），与 renderTemplate 的 vars 查找一致；
  // 显示变量名时再加花括号；VAR_PH 的 key 带花括号，故用 `{${v}}` 查。
  const pfDetected = pf ? extractVars(pf.body) : [];
  const pfPreview = pf ? renderTemplate(pf.body, pf.varExamples) : "";

  const columns: TableColumnsType<Prompt> = [
    {
      title: "Prompt 名称",
      dataIndex: "name",
      key: "name",
      width: 220,
      render: (name: string) => <span style={{ fontWeight: 500 }}>{name}</span>,
    },
    {
      title: "所属节点",
      dataIndex: "node",
      key: "node",
      width: 110,
      render: (_: unknown, r: Prompt) => (
        <Tag color={NODE_TAG_COLOR[r.node]}>{NODE_LABEL[r.node]}</Tag>
      ),
    },
    {
      title: "所属 agent",
      key: "agent",
      width: 120,
      render: () => <span style={{ color: "rgba(0,0,0,.35)" }}>—</span>,
    },
    {
      title: "当前版本",
      key: "version",
      width: 100,
      render: (_: unknown, r: Prompt) =>
        r.currentVersionNumber != null ? (
          <span style={{ ...mono }}>{verLabel(r.currentVersionNumber)}</span>
        ) : (
          <span style={{ color: "rgba(0,0,0,.35)" }}>—</span>
        ),
    },
    {
      title: "状态",
      key: "status",
      width: 100,
      render: (_: unknown, r: Prompt) =>
        r.currentVersionId === null ? (
          <Tag color="purple">草稿</Tag>
        ) : (
          <Tag color="green">线上运行中</Tag>
        ),
    },
    {
      title: "更新人",
      dataIndex: "updatedBy",
      key: "updatedBy",
      width: 160,
      render: (who: string) => <span style={{ color: "rgba(0,0,0,.65)" }}>{who}</span>,
    },
    {
      title: "更新时间",
      key: "updatedAt",
      width: 130,
      render: (_: unknown, r: Prompt) => formatDateTime(r.updatedAt),
    },
    {
      title: "操作",
      key: "action",
      width: 220,
      render: (_: unknown, r: Prompt) => (
        <Space size="small">
          <Button type="link" size="small" onClick={() => void openEdit(r)}>
            编辑
          </Button>
          {r.versionCount > 1 && (
            <Button type="link" size="small" onClick={() => setVerPromptId(r.id)}>
              版本历史
            </Button>
          )}
          {r.currentVersionId === null && (
            <Popconfirm
              title="确认发布该 Prompt 的最新草稿版本？"
              okText="发布"
              cancelText="取消"
              onConfirm={() => publishLatestDraft(r.id)}
            >
              <Button
                type="link"
                size="small"
                loading={publishingId === r.id}
              >
                发布
              </Button>
            </Popconfirm>
          )}
          {r.currentVersionId === null && (
            <Popconfirm
              title="确认删除该草稿 Prompt？此操作不可撤销。"
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => deletePromptById(r.id)}
            >
              <Button type="link" size="small" danger loading={deletingId === r.id}>
                删除
              </Button>
            </Popconfirm>
          )}
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
        <div style={{ fontSize: 16, fontWeight: 600 }}>Prompt 管理</div>
        <Button type="primary" onClick={openNew}>
          ＋ 新建 Prompt
        </Button>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="搜索名称或更新人"
          allowClear
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
        <Select<PromptNode | "all">
          value={filterNode}
          onChange={v => {
            setFilterNode(v);
            setPage(1);
          }}
          style={{ width: 140 }}
          options={[
            { value: "all" as const, label: "全部节点" },
            ...(Object.keys(NODE_LABEL) as PromptNode[]).map(n => ({
              value: n,
              label: NODE_LABEL[n],
            })),
          ]}
        />
        <Select<"all" | "prod" | "draft">
          value={filterStatus}
          onChange={v => {
            setFilterStatus(v);
            setPage(1);
          }}
          style={{ width: 120 }}
          options={[
            { value: "all" as const, label: "全部状态" },
            { value: "prod" as const, label: "生产中" },
            { value: "draft" as const, label: "草稿" },
          ]}
        />
        {hasFilter && <Button onClick={resetFilters}>重置</Button>}
      </Space>

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

      <Table<Prompt>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: t => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
        size="middle"
        locale={{
          emptyText: hasFilter
            ? "无匹配的 Prompt"
            : "暂无 Prompt，点击右上角「新建 Prompt」创建",
        }}
      />

      {/* 编辑 / 新建抽屉 */}
      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        size={720}
        title={
          <Space>
            <span>{pf?.isNew ? "新建 Prompt" : "编辑 Prompt"}</span>
            {pf && (
              <Tag
                style={{ fontSize: 12, color: "rgba(0,0,0,.55)", background: "#f5f5f5", border: "1px solid #e8e8e8" }}
              >
                {pf.verLabel}
              </Tag>
            )}
          </Space>
        }
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              {pfErr ? (
                <span style={{ fontSize: 13, color: "#ff4d4f" }}>{pfErr}</span>
              ) : (
                <span style={{ fontSize: 13, color: "rgba(0,0,0,.45)" }}>{pf?.updatedByLabel}</span>
              )}
            </div>
            <Space>
              <Button onClick={() => setDrawer(false)}>取消</Button>
              <Button type="primary" loading={pfSaving} onClick={() => void save()}>
                {pf?.isNew ? "创建 Prompt" : "保存为新版本"}
              </Button>
            </Space>
          </div>
        }
      >
        {pf && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>Prompt 名称</div>
                <Input
                  value={pf.name}
                  onChange={e => patchPf({ name: e.target.value })}
                  placeholder="如：售后回复生成"
                />
              </div>
              <div style={{ width: 200, flex: "none", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>所属节点</div>
                <Select<PromptNode>
                  value={pf.node}
                  onChange={v => patchPf({ node: v })}
                  style={{ width: "100%" }}
                  options={(Object.keys(NODE_LABEL) as PromptNode[]).map(n => ({
                    value: n,
                    label: NODE_LABEL[n],
                  }))}
                />
              </div>
            </div>
            {pfMeta && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  background: "#fafafa",
                  border: "1px solid #f0f0f0",
                  borderRadius: 6,
                  padding: "9px 12px",
                  marginTop: -8,
                }}
              >
                <span style={{ fontSize: 12, lineHeight: "18px", color: "#1677ff", flex: "none" }}>ⓘ</span>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.5)", lineHeight: 1.6 }}>{pfMeta.hint}</div>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>Prompt 内容</div>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                  用 <span style={mono}>{`{变量名}`}</span> 插入动态内容
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>推荐变量</span>
                {pfMeta?.vars.map(v => (
                  <Tag
                    key={v}
                    color="blue"
                    style={{ cursor: "pointer", userSelect: "none", ...mono }}
                    onClick={() => insertVar(v)}
                  >
                    + {v}
                  </Tag>
                ))}
              </div>
              <Input.TextArea
                value={pf.body}
                onChange={e => patchPf({ body: e.target.value })}
                placeholder="在此编写 Prompt 模板…"
                autoSize={{ minRows: 8, maxRows: 14 }}
                style={{ ...mono, fontSize: 13, lineHeight: 1.8 }}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>变量</div>
                <Tag
                  style={{
                    fontSize: 11,
                    lineHeight: "18px",
                    padding: "0 7px",
                    borderRadius: 9,
                    background: "#f5f5f5",
                    color: "rgba(0,0,0,.5)",
                    border: "1px solid #e8e8e8",
                  }}
                >
                  自动识别 {pfDetected.length}
                </Tag>
              </div>
              {pfDetected.length > 0 ? (
                <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden" }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "190px 1fr",
                      padding: "9px 14px",
                      background: "#fafafa",
                      borderBottom: "1px solid #f0f0f0",
                      fontSize: 12,
                      color: "rgba(0,0,0,.55)",
                    }}
                  >
                    <div>变量</div>
                    <div>示例值 · 用于预览</div>
                  </div>
                  {pfDetected.map(v => {
                    const varKey = `{${v}}`; // 显示用带花括号
                    const placeholder = VAR_PH[varKey] || "示例值";
                    return (
                      <div
                        key={v}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "190px 1fr",
                          padding: "8px 14px",
                          borderBottom: "1px solid #f5f5f5",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div style={{ ...mono, fontSize: 12.5, color: "#1677ff" }}>{varKey}</div>
                        <Input
                          size="small"
                          value={pf.varExamples[v] || ""}
                          onChange={e =>
                            patchPf({
                              varExamples: { ...pf.varExamples, [v]: e.target.value },
                            })
                          }
                          placeholder={placeholder}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div
                  style={{
                    border: "1px dashed #e8e8e8",
                    borderRadius: 8,
                    padding: 14,
                    textAlign: "center",
                    fontSize: 12,
                    color: "rgba(0,0,0,.35)",
                  }}
                >
                  暂未检测到变量，在内容里用 {`{变量名}`} 语法插入即可自动识别
                </div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>预览</div>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>已用示例值填充变量</div>
              </div>
              <div
                style={{
                  border: "1px solid #f0f0f0",
                  borderRadius: 8,
                  background: "#fafafa",
                  padding: "12px 14px",
                  ...mono,
                  fontSize: 12.5,
                  lineHeight: 1.9,
                  color: "rgba(0,0,0,.8)",
                  whiteSpace: "pre-wrap",
                  maxHeight: 200,
                  overflowY: "auto",
                }}
              >
                {pfPreview}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>
                版本说明 <span style={{ color: "rgba(0,0,0,.4)" }}>记录本次修改，便于回溯</span>
              </div>
              <Input
                value={pf.note}
                onChange={e => patchPf({ note: e.target.value })}
                placeholder="如：补充引用标注要求，扩展兜底话术"
              />
            </div>
          </div>
        )}
      </Drawer>

      {/* 版本管理抽屉 */}
      <Drawer
        open={verPromptId !== null}
        onClose={() => setVerPromptId(null)}
        size={760}
        title={
          <Space>
            <span>版本管理</span>
            <span style={{ fontSize: 13, color: "rgba(0,0,0,.55)" }}>{ver?.prompt?.name ?? "—"}</span>
            {ver?.prompt && <Tag color={NODE_TAG_COLOR[ver.prompt.node]}>{NODE_LABEL[ver.prompt.node]}</Tag>}
          </Space>
        }
        styles={{ body: { padding: 0 } }}
      >
        {ver && (
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
                版本历史 · 点击对比
              </div>
              {verLoading ? (
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", padding: 8 }}>加载中…</div>
              ) : ver.versions.length === 0 ? (
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)", padding: 8 }}>暂无版本</div>
              ) : (
                ver.versions.map(v => {
                  const st = STV[v.status];
                  const selected = (ver.selVersion?.id ?? null) === v.id;
                  return (
                    <div
                      key={v.id}
                      onClick={() => setPvSelVer(v.id)}
                      style={{
                        border: `1px solid ${selected ? "#1677ff" : "#f0f0f0"}`,
                        background: selected ? "#e6f4ff" : "#fff",
                        borderRadius: 8,
                        padding: "10px 12px",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, ...mono }}>{verLabel(v.version)}</span>
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
                          {STATUS_LABEL[v.status]}
                        </span>
                      </div>
                      <div
                        style={{ fontSize: 12, color: "rgba(0,0,0,.6)", lineHeight: 1.5, marginBottom: 5 }}
                      >
                        {v.note || "（无说明）"}
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)" }}>
                        {v.author} · {formatDateTime(v.createdAt)}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <Tabs
                activeKey={pvTab}
                onChange={k => setPvTab(k as "diff" | "bind")}
                style={{ padding: "0 20px" }}
                items={[
                  { key: "diff", label: "版本 Diff" },
                  { key: "bind", label: "绑定 Agent" },
                ]}
              />
              {verErr && (
                <div style={{ padding: "8px 20px 0", fontSize: 12, color: "#ff4d4f" }}>{verErr}</div>
              )}
              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", minHeight: 0 }}>
                {pvTab === "diff" ? (
                  <>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        marginBottom: 12,
                        fontSize: 13,
                      }}
                    >
                      <span style={{ color: "rgba(0,0,0,.55)" }}>对比</span>
                      <span style={{ ...mono, fontWeight: 600 }}>{ver.diffFrom}</span>
                      <span style={{ color: "rgba(0,0,0,.35)" }}>（生产）→</span>
                      <span style={{ ...mono, fontWeight: 600, color: "#1677ff" }}>{ver.diffTo}</span>
                      <div style={{ flex: 1 }} />
                      <span style={{ fontSize: 12, color: "#52c41a" }}>+{ver.adds}</span>
                      <span style={{ fontSize: 12, color: "#ff4d4f" }}>−{ver.dels}</span>
                    </div>
                    {ver.sameVer ? (
                      <div style={{ padding: 40, textAlign: "center", color: "rgba(0,0,0,.35)", fontSize: 13 }}>
                        选中的是当前生产版本，请在左侧选择其他版本进行对比。
                      </div>
                    ) : ver.selVersion == null ? (
                      <div style={{ padding: 40, textAlign: "center", color: "rgba(0,0,0,.35)", fontSize: 13 }}>
                        暂无版本可对比。
                      </div>
                    ) : (
                      <div
                        style={{
                          border: "1px solid #f0f0f0",
                          borderRadius: 8,
                          overflow: "hidden",
                          ...mono,
                          fontSize: 12.5,
                          lineHeight: 1.9,
                        }}
                      >
                        {ver.diff.map((d, i) => (
                          <div key={i} style={{ display: "flex", background: d.bg }}>
                            <span
                              style={{
                                flex: "none",
                                width: 22,
                                textAlign: "center",
                                color: d.signC,
                                userSelect: "none",
                              }}
                            >
                              {d.sign}
                            </span>
                            <span
                              style={{
                                flex: 1,
                                whiteSpace: "pre-wrap",
                                color: d.color,
                                paddingRight: 12,
                              }}
                            >
                              {d.text}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {ver.canPublishSel && ver.selVersion && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          marginTop: 16,
                          borderTop: "1px solid #f0f0f0",
                          paddingTop: 16,
                        }}
                      >
                        <div style={{ fontSize: 12, color: "rgba(0,0,0,.5)", lineHeight: 1.6 }}>
                          {ver.selVersion.status === "draft"
                            ? "发布后原生产版本将自动归档，可随时回滚。"
                            : "回滚后原生产版本将自动归档，可再次回滚。"}
                        </div>
                        <Popconfirm
                          title={
                            ver.selVersion.status === "draft"
                              ? `确认发布 ${verLabel(ver.selVersion.version)} 为生产版本？`
                              : `确认回滚到 ${verLabel(ver.selVersion.version)}？`
                          }
                          description="原生产版本将自动归档。"
                          okText="确认"
                          cancelText="取消"
                          onConfirm={() => void actOnVersion(ver.selVersion!)}
                        >
                          <Button type="primary">{ver.publishSelLabel}</Button>
                        </Popconfirm>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 13, color: "rgba(0,0,0,.6)", lineHeight: 1.7, marginBottom: 16 }}>
                      以下 Agent 版本绑定了该 Prompt。发布新版本前请确认对这些 Agent 的影响。
                    </div>
                    <div
                      style={{
                        padding: 40,
                        textAlign: "center",
                        color: "rgba(0,0,0,.35)",
                        fontSize: 13,
                        border: "1px dashed #e8e8e8",
                        borderRadius: 8,
                      }}
                    >
                      M7 Agent 管理接入后展示绑定关系
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
