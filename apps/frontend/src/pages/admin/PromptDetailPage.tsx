import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert,
  Button,
  Drawer,
  Input,
  Popconfirm,
  Select,
  Slider,
  Space,
  Spin,
  Tag,
  Tooltip,
  message,
} from "antd";
import {
  compilePromptBody,
  NODE_CONTRACTS,
  TRY_RUN_CHAT_PROTOCOLS,
  type CompileIssue,
  type ModelProvider,
  type PromptDetail,
  type PromptUsageEntry,
  type PromptVersion,
  type TryRunResult,
} from "@codecrush/contracts";
import {
  createPromptVersion,
  getModels,
  getPromptDetail,
  getPromptUsage,
  movePromptTag,
  removePromptTag,
  tryRunPromptVersion,
} from "../../api/client";
import { NODE_LABEL, NODE_META } from "../../mocks/prompts";
import { formatDateTime, tagColor } from "./PromptsPage";

/**
 * Prompt 详情 · Playground（012 §2，对齐 Prompt详情·Playground.dc.html）：
 * 左栏编辑（节点说明 / 正文 / 实时编译红黄线 / 可插入字段 chips / 保存为新版本），
 * 右栏试运行（Story 7 接真实 try-run），历史版本抽屉按需展开。
 * 「谁在用」徽标/服务中条幅依赖 applications usage API（009），不可用时静默省略——
 * 不把未知显示成"无人使用"。
 */

const NODE_TAG_COLOR: Record<string, string> = {
  rewrite: "blue",
  intent: "purple",
  reply: "green",
  fallback: "gold",
};

const mono: CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace" };

export default function PromptDetailPage() {
  const { promptId = "" } = useParams();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");

  // 编辑态：载入的来源版本 + 正文 + 版本说明
  const [sourceVersion, setSourceVersion] = useState<PromptVersion | null>(null);
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const [historyOpen, setHistoryOpen] = useState(false);

  // 「谁在用」（012 seam / 009）：production 指针引用本 Prompt 版本的应用；失败/404 静默置 null，
  // 不把未知显示成「无人使用」。与详情并行拉取，不阻塞主体。
  const [usage, setUsage] = useState<PromptUsageEntry[] | null>(null);

  // 标签面板：自定义标签输入（012 §3：production/v 不允许从自定义入口创建）
  const [newTag, setNewTag] = useState("");
  const [tagErr, setTagErr] = useState("");
  const [tagBusy, setTagBusy] = useState(false);

  // 试运行（012 §6）：真实模型调用，仅 reply/fallback 开放；rewrite/intent 待 011
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [tryModelId, setTryModelId] = useState<string>("");
  const [tryTemp, setTryTemp] = useState(0.7);
  const [tvQuery, setTvQuery] = useState("");
  const [tvHistory, setTvHistory] = useState("");
  const [tvRetrieval, setTvRetrieval] = useState("");
  const [tvReason, setTvReason] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<TryRunResult | null>(null);
  const [runErr, setRunErr] = useState("");

  // 快速切换路由时的过期响应守卫（review P3）：旧 promptId 的响应回来晚了不覆盖当前页面
  const activePromptId = useRef(promptId);
  useEffect(() => {
    activePromptId.current = promptId;
  }, [promptId]);

  const refresh = useCallback(
    async (loadLatestIntoEditor: boolean) => {
      setLoadErr("");
      try {
        const d = await getPromptDetail(promptId);
        if (activePromptId.current !== promptId) return null;
        setDetail(d);
        if (loadLatestIntoEditor && d.versions.length > 0) {
          setSourceVersion(d.versions[0]);
          setBody(d.versions[0].body);
          setNote("");
        }
        return d;
      } catch (e) {
        if (activePromptId.current !== promptId) return null;
        setLoadErr(e instanceof Error ? e.message : "加载失败");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [promptId],
  );

  useEffect(() => {
    setLoading(true);
    void refresh(true);
  }, [refresh]);

  // usage 单独 try/catch 拉取（与详情并行）：失败/404 置 null 静默隐藏，页面主体不受影响
  useEffect(() => {
    let active = true;
    setUsage(null);
    getPromptUsage(promptId)
      .then((list) => {
        if (active) setUsage(list);
      })
      .catch(() => {
        if (active) setUsage(null);
      });
    return () => {
      active = false;
    };
  }, [promptId]);

  // versionId → 引用它的 production 应用条目（派生渲染徽标/条幅/历史标记三处 UI）
  const usageByVersionId = useMemo(() => {
    const m = new Map<string, PromptUsageEntry[]>();
    for (const u of usage ?? [])
      m.set(u.promptVersionId, [...(m.get(u.promptVersionId) ?? []), u]);
    return m;
  }, [usage]);

  // 可试运行模型 = 启用的 llm 且协议在支持矩阵内；其余不展示为可运行（Invariant 4）
  useEffect(() => {
    let active = true;
    getModels()
      .then((list) => {
        if (!active) return;
        const runnable = list.filter(
          (m) =>
            m.type === "llm" &&
            m.enabled &&
            (TRY_RUN_CHAT_PROTOCOLS as readonly string[]).includes(m.protocol),
        );
        setModels(runnable);
        setTryModelId((prev) => prev || (runnable[0]?.id ?? ""));
      })
      .catch(() => {
        if (active) setModels([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const node = detail?.node;
  const contract = node ? NODE_CONTRACTS[node] : null;
  // 实时编译来自 contracts 纯函数（前后端同一实现）；服务端保存结果是最终事实
  const compiled = useMemo(
    () => (node ? compilePromptBody(body, node) : { status: "ok" as const, issues: [] }),
    [body, node],
  );
  const errors = compiled.issues.filter((i) => i.severity === "error");
  const warnings = compiled.issues.filter((i) => i.severity === "warning");
  const dirty = sourceVersion !== null && body !== sourceVersion.body;
  // 当前编辑版本被哪些 production 应用引用（命中 → 头部徽标 + 底部具名条幅）
  const currentUsage = sourceVersion ? (usageByVersionId.get(sourceVersion.id) ?? []) : [];

  const applySuggestion = (issue: CompileIssue) => {
    if (!issue.field || !issue.suggestion) return;
    setBody((prev) => prev.split(`{${issue.field}}`).join(`{${issue.suggestion}}`));
  };

  const insertField = (field: string) => {
    setBody((prev) => (prev ? prev + (/\s$/.test(prev) ? "" : " ") + `{${field}}` : `{${field}}`));
  };

  // Prompt 全部标签（含所指版本），从详情的版本标签聚合
  const allTags = useMemo(
    () =>
      (detail?.versions ?? []).flatMap((v) =>
        v.tags.map((name) => ({ name, version: v.version, versionId: v.id })),
      ),
    [detail],
  );

  // 移动/摘除失败（并发冲突等）→ 提示并 refetch，以服务端为准
  const moveTagToCurrent = async (name: string) => {
    if (!detail || !sourceVersion) return;
    setTagBusy(true);
    try {
      await movePromptTag(detail.id, { name, versionId: sourceVersion.id });
      message.success(`「${name}」已指向 v${sourceVersion.version}（不影响任何服务）`);
    } catch (e) {
      message.error(e instanceof Error ? `标签移动失败，已刷新：${e.message}` : "标签移动失败");
    } finally {
      setTagBusy(false);
      await refresh(false);
    }
  };

  const removeTagByName = async (name: string) => {
    if (!detail) return;
    setTagBusy(true);
    try {
      await removePromptTag(detail.id, name);
      message.success(`已摘除「${name}」（不影响任何服务）`);
    } catch (e) {
      message.error(e instanceof Error ? `标签摘除失败，已刷新：${e.message}` : "标签摘除失败");
    } finally {
      setTagBusy(false);
      await refresh(false);
    }
  };

  const addCustomTag = async () => {
    const raw = newTag.trim();
    const name = raw.toLowerCase();
    if (!raw) return;
    if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
      setTagErr("仅允许字母、数字、.、_、-");
      return;
    }
    if (name === "production") {
      setTagErr("production 请通过下方「标为 production」入口移动，不能重复创建");
      return;
    }
    if (name === "v") {
      setTagErr("v 是保留字（与版本号前缀混淆），请换一个名称");
      return;
    }
    setTagErr("");
    await moveTagToCurrent(name);
    setNewTag("");
  };

  const runTry = async () => {
    if (!detail || !sourceVersion || !tryModelId) return;
    setRunning(true);
    setRunErr("");
    setRunResult(null);
    try {
      const res = await tryRunPromptVersion(detail.id, sourceVersion.id, {
        modelId: tryModelId,
        temperature: tryTemp,
        testVars: {
          query: tvQuery,
          history: tvHistory || undefined,
          retrievalContext: tvRetrieval || undefined,
          reason: tvReason || undefined,
        },
      });
      setRunResult(res);
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : "试运行失败");
    } finally {
      setRunning(false);
    }
  };

  const loadVersion = (v: PromptVersion, opts?: { copyNote?: boolean }) => {
    setSourceVersion(v);
    setBody(v.body);
    setNote(opts?.copyNote ? `基于 v${v.version} 修改` : "");
    setSaveErr("");
    setHistoryOpen(false);
  };

  const save = async () => {
    if (!detail || !sourceVersion) return;
    if (!body.trim()) {
      // 空 body 允许保存（012），但提示确认语义由按钮文案承担；此处仅提示
      message.warning("正文为空——仍会保存为新版本");
    }
    setSaving(true);
    setSaveErr("");
    try {
      const created = await createPromptVersion(detail.id, {
        body,
        note: note.trim() || undefined,
        sourceVersionId: sourceVersion.id,
      });
      message.success(`已保存为 v${created.version}`);
      const d = await refresh(false);
      // 保存后切换到新版本继续编辑
      const latest = d?.versions.find((v) => v.id === created.id) ?? created;
      setSourceVersion(latest);
      setBody(latest.body);
      setNote("");
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }
  if (!detail || !node || !contract) {
    return (
      <div style={{ padding: 24 }}>
        <Alert type="error" showIcon message={loadErr || "Prompt 不存在"} />
        <Button style={{ marginTop: 16 }} onClick={() => navigate("/admin/prompts")}>
          返回列表
        </Button>
      </div>
    );
  }

  return (
    <div>
      {/* 头部：返回 / 名称 / 节点 / 历史版本按钮 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <Button size="small" onClick={() => navigate("/admin/prompts")}>
          ← 返回
        </Button>
        <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>Prompt 管理 /</span>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{detail.name}</span>
        <Tag color={NODE_TAG_COLOR[node]}>{NODE_LABEL[node]}</Tag>
        {currentUsage.length > 0 && sourceVersion && (
          <Tag color="green">● v{sourceVersion.version} 服务中</Tag>
        )}
        <div style={{ flex: 1 }} />
        <Button onClick={() => setHistoryOpen(true)}>🕑 历史版本 {detail.versionCount}</Button>
      </div>

      {loadErr && (
        <Alert type="error" showIcon closable message={loadErr} style={{ marginBottom: 12 }} />
      )}

      {/* flexWrap：窄视口时右栏换行到下方，避免左栏被固定宽右栏挤压 */}
      <div style={{ display: "flex", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
        {/* 左栏 · 编辑区 */}
        <div
          style={{
            flex: 1,
            minWidth: 420,
            background: "#fff",
            border: "1px solid #f0f0f0",
            borderRadius: 8,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div
            style={{
              background: "#fafafa",
              border: "1px solid #f0f0f0",
              borderRadius: 6,
              padding: "10px 14px",
            }}
          >
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 4 }}>
              这个节点是做什么的
            </div>
            <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)", lineHeight: 1.7 }}>
              {NODE_META[node].hint}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>你希望它怎么做</span>
              <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)", ...mono }}>
                编辑中 v{sourceVersion?.version}
                {dirty ? " · 有未保存修改" : ""}
              </span>
            </div>
            <Input.TextArea
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setSaveErr("");
              }}
              placeholder="用大白话写清楚这一节点该怎么做…"
              autoSize={{ minRows: 12, maxRows: 22 }}
              style={{ ...mono, fontSize: 13, lineHeight: 1.8 }}
            />
            {/* 编译错误（红）/ 警告（黄）——contracts 纯函数实时计算 */}
            {errors.map((i, idx) => (
              <div key={`e${idx}`} style={{ fontSize: 12, color: "#ff4d4f", lineHeight: 1.6 }}>
                ✕ {i.message}
                {i.suggestion && (
                  <Button
                    type="link"
                    size="small"
                    style={{ fontSize: 12, padding: "0 4px" }}
                    onClick={() => applySuggestion(i)}
                  >
                    一键改为 {`{${i.suggestion}}`}
                  </Button>
                )}
              </div>
            ))}
            {warnings.map((i, idx) => (
              <div key={`w${idx}`} style={{ fontSize: 12, color: "#d48806", lineHeight: 1.6 }}>
                ⚠ {i.message}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              可以用到的信息{" "}
              <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)", fontWeight: 400 }}>
                · 点一下插入
              </span>
            </div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", lineHeight: 1.6 }}>
              这些信息由系统固定提供，不需要你配置。插入只是把标记放进策略里，方便指向该参考哪块信息——不插入也一样会正常提供给它。
            </div>
            <Space size={6} wrap>
              {contract.templateFields.map((f) => (
                <Tag
                  key={f}
                  color="blue"
                  style={{ cursor: "pointer", userSelect: "none", ...mono }}
                  onClick={() => insertField(f)}
                >
                  + {`{${f}}`}
                </Tag>
              ))}
            </Space>
          </div>

          {/* 标签面板（012 §3）：排他移动 / 摘除 / 自定义创建。纯记账信号，无上线语义 */}
          <div data-testid="tag-panel" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              标识{" "}
              <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)", fontWeight: 400 }}>
                · 只是记账标记，移动/摘除不影响任何服务
              </span>
            </div>
            <Space size={6} wrap>
              {allTags.map((t) => (
                <span key={t.name} style={{ display: "inline-flex", alignItems: "center" }}>
                  <Tag color={tagColor(t.name)} style={{ ...mono, marginRight: 0 }}>
                    {t.name} → v{t.version}
                  </Tag>
                  {sourceVersion && t.versionId !== sourceVersion.id && (
                    <Popconfirm
                      title={`「${t.name}」当前指向 v${t.version}，移动到 v${sourceVersion.version}？`}
                      description="仅移动 Prompt 标签，不影响任何服务。"
                      okText="移动"
                      cancelText="取消"
                      onConfirm={() => void moveTagToCurrent(t.name)}
                    >
                      <Button type="link" size="small" style={{ fontSize: 12, padding: "0 4px" }}>
                        移到 v{sourceVersion.version}
                      </Button>
                    </Popconfirm>
                  )}
                  <Popconfirm
                    title={`确认摘除「${t.name}」？`}
                    description="仅摘除 Prompt 标签，不影响任何服务。"
                    okText="摘除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void removeTagByName(t.name)}
                  >
                    <Button
                      type="link"
                      size="small"
                      danger
                      style={{ fontSize: 12, padding: "0 4px" }}
                      aria-label={`摘除 ${t.name}`}
                    >
                      ×
                    </Button>
                  </Popconfirm>
                </span>
              ))}
              {allTags.length === 0 && (
                <span style={{ fontSize: 12, color: "rgba(0,0,0,.35)" }}>暂无标识</span>
              )}
            </Space>
            <Space size={6} wrap>
              <Input
                size="small"
                value={newTag}
                onChange={(e) => {
                  setNewTag(e.target.value);
                  setTagErr("");
                }}
                placeholder="自定义标识（字母/数字/._-）"
                style={{ width: 220 }}
                onPressEnter={() => void addCustomTag()}
              />
              <Button size="small" loading={tagBusy} onClick={() => void addCustomTag()}>
                标到当前版本
              </Button>
              {sourceVersion &&
                !allTags.some(
                  (t) => t.name === "production" && t.versionId === sourceVersion.id,
                ) && (
                  <Popconfirm
                    title={(() => {
                      // production 已存在时确认文案必须显示当前指向（012 §3，review 修复）
                      const existing = allTags.find((t) => t.name === "production");
                      return existing
                        ? `production 当前指向 v${existing.version}，移动到 v${sourceVersion.version}？`
                        : `将 production 标到 v${sourceVersion.version}？`;
                    })()}
                    description="仅移动 Prompt 标签，不影响任何服务。production 只是强调色标记。"
                    okText="移动"
                    cancelText="取消"
                    onConfirm={() => void moveTagToCurrent("production")}
                  >
                    <Button size="small" loading={tagBusy}>
                      标为 production
                    </Button>
                  </Popconfirm>
                )}
            </Space>
            {tagErr && <div style={{ fontSize: 12, color: "#ff4d4f" }}>{tagErr}</div>}
          </div>

          <div
            style={{
              borderTop: "1px solid #f0f0f0",
              paddingTop: 14,
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="版本说明（可选）：记录本次修改，便于回溯"
              style={{ flex: 1 }}
            />
            <Button type="primary" loading={saving} onClick={() => void save()}>
              保存为新版本
            </Button>
          </div>
          {saveErr && <div style={{ fontSize: 13, color: "#ff4d4f" }}>{saveErr}</div>}
        </div>

        {/* 右栏 · 试运行区（Story 7 接真实 try-run；未接入前不展示可运行状态） */}
        <div
          data-testid="try-run-panel"
          style={{
            width: 380,
            flex: "none",
            background: "#fff",
            border: "1px solid #f0f0f0",
            borderRadius: 8,
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 500 }}>
            试运行{" "}
            <span style={{ fontSize: 12, color: "rgba(0,0,0,.45)", fontWeight: 400 }}>
              · 只跑这一个节点
            </span>
          </div>
          {node === "rewrite" || node === "intent" ? (
            // 011 未落地：结构化预览不可用，不展示可运行状态（Invariant 4，不伪造）
            <Alert
              type="info"
              showIcon
              message="结构化预览暂不可用"
              description="该节点的试运行需要结构化校验（节点运行时），待 M8.0 上线后开放。"
            />
          ) : models.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="没有可试运行的模型"
              description="需要一个已启用的 LLM 模型（openai_compat / anthropic / gemini 协议）。"
            />
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, color: "rgba(0,0,0,.55)" }}>
                  生成参数 · 仅影响本次试跑
                </span>
                <Select
                  size="small"
                  value={tryModelId}
                  onChange={setTryModelId}
                  options={models.map((m) => ({ value: m.id, label: m.name }))}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "rgba(0,0,0,.55)", flex: "none" }}>
                    温度 {tryTemp}
                  </span>
                  <Slider
                    min={0}
                    max={2}
                    step={0.1}
                    value={tryTemp}
                    onChange={setTryTemp}
                    style={{ flex: 1, margin: "0 6px" }}
                  />
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, color: "rgba(0,0,0,.55)" }}>
                  输入数据 · 这个节点要吃的字段
                </span>
                <Input.TextArea
                  value={tvQuery}
                  onChange={(e) => setTvQuery(e.target.value)}
                  placeholder="用户问题（必填）"
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
                <Input.TextArea
                  value={tvHistory}
                  onChange={(e) => setTvHistory(e.target.value)}
                  placeholder="历史对话 · 可空"
                  autoSize={{ minRows: 1, maxRows: 4 }}
                />
                {node === "reply" && (
                  <Input.TextArea
                    value={tvRetrieval}
                    onChange={(e) => setTvRetrieval(e.target.value)}
                    placeholder="检索到的内容 · 回复的依据，别手编"
                    autoSize={{ minRows: 2, maxRows: 6 }}
                  />
                )}
                {node === "fallback" && (
                  <Input
                    value={tvReason}
                    onChange={(e) => setTvReason(e.target.value)}
                    placeholder="兜底原因（必填），如：知识库未命中"
                  />
                )}
              </div>

              {sourceVersion?.compileStatus === "has_errors" ? (
                <Alert
                  type="error"
                  showIcon
                  message="该版本存在编译错误，无法试运行"
                  description="修复正文并保存新版本后再试。"
                />
              ) : (
                <Button
                  type="primary"
                  loading={running}
                  disabled={
                    !tvQuery.trim() || (node === "fallback" && !tvReason.trim()) || !tryModelId
                  }
                  onClick={() => void runTry()}
                >
                  运行 v{sourceVersion?.version}
                </Button>
              )}
              {dirty && (
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>
                  正文有未保存修改——试运行使用已保存的 v{sourceVersion?.version}。
                </div>
              )}

              {runErr && (
                <Alert
                  type="error"
                  showIcon
                  message="试运行失败"
                  description={runErr}
                  action={
                    <Button size="small" onClick={() => void runTry()}>
                      重试
                    </Button>
                  }
                />
              )}
              {runResult?.mode === "text" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: 12, color: "rgba(0,0,0,.55)" }}>模型输出</span>
                  <div
                    data-testid="try-run-output"
                    style={{
                      border: "1px solid #f0f0f0",
                      borderRadius: 8,
                      background: "#fafafa",
                      padding: "10px 12px",
                      fontSize: 13,
                      lineHeight: 1.8,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {runResult.text}
                  </div>
                </div>
              )}
              {runResult?.mode === "unavailable" && (
                <Alert
                  type="info"
                  showIcon
                  message="本次试运行不可用"
                  description={
                    runResult.reason === "application_context_not_available"
                      ? "参照应用带出参数的能力待应用管理（009）上线。"
                      : runResult.reason === "unsupported_protocol"
                        ? "所选模型的协议暂不支持试运行。"
                        : "该节点的结构化预览待 M8.0 上线。"
                  }
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* 「谁在用」具名条幅：当前编辑版本正被 production 应用引用时提示，改版不影响在线服务 */}
      {currentUsage.length > 0 && sourceVersion && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
          {currentUsage.map((u) => (
            <Alert
              key={u.applicationId}
              type="success"
              showIcon
              message={`「${u.applicationName}」的线上配置正用着 v${u.promptVersion}，对外服务中。改这个版本不会影响正在服务的内容——改完保存会生成新版本；要让新内容生效，去对应应用的配置里把节点指向新版本并上线。`}
            />
          ))}
        </div>
      )}

      {/* 历史版本抽屉：点行载入编辑；「创建副本」预填说明 */}
      <Drawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        size={420}
        title={`历史版本 · ${detail.versionCount}`}
      >
        <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginBottom: 12, lineHeight: 1.6 }}>
          点一行载入编辑（改完保存生成新版本，不动原版本）。
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {detail.versions.map((v) => {
            const isEditing = sourceVersion?.id === v.id;
            return (
              <div
                key={v.id}
                data-testid={`history-version-${v.version}`}
                onClick={() => loadVersion(v)}
                style={{
                  border: `1px solid ${isEditing ? "#1677ff" : "#f0f0f0"}`,
                  background: isEditing ? "#e6f4ff" : "#fff",
                  borderRadius: 8,
                  padding: "10px 12px",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, ...mono }}>v{v.version}</span>
                  {v.tags.map((t) => (
                    <Tag key={t} color={tagColor(t)} style={{ ...mono, fontSize: 11 }}>
                      {t}
                    </Tag>
                  ))}
                  {v.compileStatus === "has_errors" && (
                    <Tooltip title="该版本保存时存在编译错误">
                      <Tag color="red" style={{ fontSize: 11 }}>
                        编译错误
                      </Tag>
                    </Tooltip>
                  )}
                  {(usageByVersionId.get(v.id) ?? []).map((u) => (
                    <Tag key={u.applicationId} color="green" style={{ fontSize: 11 }}>
                      服务中 · {u.applicationName}
                    </Tag>
                  ))}
                  {isEditing && (
                    <span style={{ fontSize: 11, color: "#1677ff" }}>编辑中</span>
                  )}
                  <div style={{ flex: 1 }} />
                  <Button
                    type="link"
                    size="small"
                    style={{ fontSize: 12 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      loadVersion(v, { copyNote: true });
                    }}
                  >
                    创建副本
                  </Button>
                </div>
                <div style={{ fontSize: 12, color: "rgba(0,0,0,.6)", marginBottom: 4 }}>
                  {v.note || "（无说明）"}
                </div>
                <div style={{ fontSize: 11, color: "rgba(0,0,0,.35)" }}>
                  {v.author} · {formatDateTime(v.createdAt)}
                </div>
              </div>
            );
          })}
        </div>
      </Drawer>
    </div>
  );
}
