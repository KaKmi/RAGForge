import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Spin,
  Switch,
  Tag,
  Timeline,
  Upload,
  message,
} from "antd";
import { InboxOutlined } from "@ant-design/icons";
import type {
  ChunkTemplate,
  Document,
  DocumentLifecycleResponse,
  DocumentLifecycleStage,
  DocumentStatus,
  KnowledgeBase,
  ModelProvider,
} from "@codecrush/contracts";
import {
  deleteDocument,
  getDocumentLifecycle,
  getDocuments,
  getKnowledgeBases,
  getModels,
  triggerParse,
  updateDocumentMetadata,
  updateKnowledgeBase,
  uploadDocuments,
} from "../../api/client";

/** 知识库文档：真实文档表 + KB 配置摘要/编辑 + 上传抽屉 + 元数据 Modal + 生命周期抽屉。M4 接真实 /api/documents 等。 */

const DOCS_COLS = "1fr 110px 60px 125px 95px 105px";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_BATCH = 100;
const ALLOWED_EXT = [".pdf", ".doc", ".docx", ".md", ".markdown", ".txt"];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const linkBlue: CSSProperties = { color: "#1677ff", cursor: "pointer" };

const typeIcon: CSSProperties = {
  width: 24,
  height: 24,
  flex: "none",
  borderRadius: 5,
  background: "#e6f4ff",
  color: "#1677ff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 10,
  fontWeight: 600,
};

const gridHeader: CSSProperties = {
  display: "grid",
  gridTemplateColumns: DOCS_COLS,
  padding: "12px 16px",
  background: "#fafafa",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  fontWeight: 600,
  color: "rgba(0,0,0,.65)",
};

const gridRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: DOCS_COLS,
  padding: "12px 16px",
  borderBottom: "1px solid #f0f0f0",
  fontSize: 13,
  alignItems: "center",
};

const docNameLink: CSSProperties = {
  fontWeight: 500,
  color: "#1677ff",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const legendCard: CSSProperties = {
  background: "#fff",
  border: "1px solid #f0f0f0",
  borderRadius: 8,
  padding: "14px 18px",
  margin: "10px 0 16px",
};

const legendNum: CSSProperties = {
  width: 24,
  height: 24,
  flex: "none",
  borderRadius: "50%",
  background: "#e6f4ff",
  color: "#1677ff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 600,
};

const dotSep: CSSProperties = { color: "rgba(0,0,0,.2)" };
const strong: CSSProperties = { color: "rgba(0,0,0,.7)", fontWeight: 500 };
const hintText: CSSProperties = { fontSize: 12, color: "rgba(0,0,0,.4)", lineHeight: 1.6 };
const fieldLabel: CSSProperties = { fontSize: 13, color: "rgba(0,0,0,.65)" };

/** 分块模板选项（对齐 KnowledgeBasesPage 创建表单，此处用于编辑）。 */
const CHUNK_TEMPLATE_OPTS: { value: ChunkTemplate; label: string; desc: string }[] = [
  { value: "general", label: "通用", desc: "按标题结构切分，适合 Markdown / TXT / 层级清晰的文档" },
  { value: "qa", label: "问答", desc: "识别问答对，一问一答作为一个切片，适合 FAQ 文档" },
  { value: "custom", label: "定制", desc: "按指定规则清洗与切分，适合有特定格式要求的专属内容" },
];

/** 知识库状态标签（对齐 KnowledgeBasesPage.statusView）。 */
function kbStatusTag(k: KnowledgeBase): { label: string; color: string } {
  if (k.status === "building") return { label: `重建中 ${k.progress ?? 0}%`, color: "processing" };
  if (k.status === "failed") return { label: "失败", color: "error" };
  return { label: "已就绪", color: "success" };
}

/** 文档状态五值（DocumentStatusSchema）的展示映射：pending/queued 灰、processing 黄、failed 红、ready 绿。 */
const DOC_STATUS_VIEW: Record<DocumentStatus, { label: string; dot: string; tag: string }> = {
  pending: { label: "待处理", dot: "#bfbfbf", tag: "default" },
  queued: { label: "排队中", dot: "#bfbfbf", tag: "default" },
  processing: { label: "处理中", dot: "#faad14", tag: "gold" },
  failed: { label: "失败", dot: "#ff4d4f", tag: "error" },
  ready: { label: "已就绪", dot: "#52c41a", tag: "success" },
};

const TYPE_LABEL: Record<Document["type"], string> = {
  pdf: "PDF",
  word: "DOC",
  markdown: "MD",
  text: "TXT",
};

function fileTypeLabel(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "PDF";
  if (lower.endsWith(".doc") || lower.endsWith(".docx")) return "DOC";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "MD";
  return "TXT";
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 生命周期三阶段的固定文案（对齐原型 STAGE_DEFS，数据源换真实 lifecycle.stages）。 */
const STAGE_ORDER: DocumentLifecycleStage["stage"][] = ["upload", "ingest", "ready"];

const STAGE_LABELS: Record<DocumentLifecycleStage["stage"], { label: string; desc: string }> = {
  upload: { label: "上传", desc: "文件校验 · 落盘存储" },
  ingest: { label: "解析入库", desc: "解析 · 切片 · 向量化写入索引" },
  ready: { label: "就绪", desc: "纳入检索 · 可被问答引用" },
};

const STAGE_VIS: Record<
  DocumentLifecycleStage["status"],
  { icon: string; c: string; bg: string; bd: string; label: string }
> = {
  done: { icon: "✓", c: "#52c41a", bg: "#f6ffed", bd: "#b7eb8f", label: "完成" },
  running: { icon: "◐", c: "#d48806", bg: "#fffbe6", bd: "#ffe58f", label: "进行中" },
  failed: { icon: "✕", c: "#ff4d4f", bg: "#fff2f0", bd: "#ffccc7", label: "失败" },
  pending: { icon: "", c: "#bfbfbf", bg: "#fff", bd: "#e8e8e8", label: "待处理" },
};

function stageDuration(s: DocumentLifecycleStage): string {
  if (!s.startedAt) return "—";
  const start = new Date(s.startedAt).getTime();
  const end = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
  const sec = Math.max(0, (end - start) / 1000);
  return `${sec.toFixed(1)}s`;
}

function stageTime(s: DocumentLifecycleStage): string {
  return s.startedAt ? formatDateTime(s.startedAt) : "—";
}

interface MetaRow {
  key: string;
  value: string;
}

export default function DocumentsPage() {
  const { kbId = "" } = useParams<{ kbId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [models, setModels] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 上传抽屉
  const [uploadOpen, setUploadOpen] = useState(false);
  const [autoParse, setAutoParse] = useState(true); // 007 拍板默认开，不沿用旧原型默认关
  const [folderMode, setFolderMode] = useState(false);
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [uploadErr, setUploadErr] = useState("");
  const [uploading, setUploading] = useState(false);

  // 编辑 KB 摘要
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editChunkTemplate, setEditChunkTemplate] = useState<ChunkTemplate>("general");
  const [editErr, setEditErr] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // 元数据 Modal
  const [metaDoc, setMetaDoc] = useState<Document | null>(null);
  const [metaRows, setMetaRows] = useState<MetaRow[]>([]);
  const [metaErr, setMetaErr] = useState("");
  const [metaSaving, setMetaSaving] = useState(false);

  // 生命周期抽屉
  const [lifecycleDocId, setLifecycleDocId] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<DocumentLifecycleResponse | null>(null);
  const [lifecycleErr, setLifecycleErr] = useState("");
  const [lifecycleLoading, setLifecycleLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [kbs, list] = await Promise.all([getKnowledgeBases(), getDocuments(kbId)]);
      setKb(kbs.find((k) => k.id === kbId) ?? null);
      setDocs(list);
      setError("");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [kbId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 模型列表仅用于把 embeddingModelId 解析成可读名称展示，拉一次即可，不随文档轮询重复请求
  useEffect(() => {
    getModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  const embeddingModelName = kb
    ? (models.find((m) => m.id === kb.embeddingModelId)?.name ?? kb.embeddingModelId)
    : "";

  // 有文档处于处理中状态（queued/processing）时轮询，同 KnowledgeBasesPage 的按需轮询模式
  useEffect(() => {
    if (!docs.some((d) => d.status === "queued" || d.status === "processing")) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [docs, load]);

  const lifecycleDoc = lifecycleDocId ? (docs.find((d) => d.id === lifecycleDocId) ?? null) : null;

  // 生命周期抽屉打开后拉一次；对应文档状态变化（如重试后 failed -> queued）时再拉一次刷新阶段详情
  useEffect(() => {
    if (!lifecycleDocId) {
      setLifecycle(null);
      return;
    }
    let cancelled = false;
    setLifecycleLoading(true);
    setLifecycleErr("");
    getDocumentLifecycle(lifecycleDocId)
      .then((res) => {
        if (!cancelled) setLifecycle(res);
      })
      .catch((e) => {
        if (!cancelled) setLifecycleErr(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setLifecycleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lifecycleDocId, lifecycleDoc?.status]);

  const goChunks = (docId: string) =>
    navigate(
      `/admin/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/chunks`,
    );

  // ---- 上传 ----

  const openUpload = useCallback(() => {
    setPickedFiles([]);
    setAutoParse(true);
    setFolderMode(false);
    setUploadErr("");
    setUploading(false);
    setUploadOpen(true);
  }, []);

  // ?upload=1（KB 列表页「上传文档」带此参数跳入）：加载后自动开上传抽屉，然后清掉参数避免重开
  useEffect(() => {
    if (searchParams.get("upload") !== "1") return;
    openUpload();
    const next = new URLSearchParams(searchParams);
    next.delete("upload");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, openUpload]);

  const onPickFiles = (files: File[]) => {
    if (files.length === 0) return;
    const supported = files.filter((f) =>
      ALLOWED_EXT.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    if (supported.length === 0) {
      setUploadErr("未找到受支持的文件类型（PDF / Word / Markdown / TXT）");
      return;
    }
    if (supported.length > MAX_BATCH) {
      setUploadErr(`单批最多上传 ${MAX_BATCH} 个文件，当前选择了 ${supported.length} 个`);
      return;
    }
    const oversized = supported.filter((f) => f.size > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      setUploadErr(`以下文件超过单文件 20MB 限制：${oversized.map((f) => f.name).join("、")}`);
      return;
    }
    setUploadErr("");
    setPickedFiles(supported);
  };

  const removePickedFile = (idx: number) =>
    setPickedFiles((prev) => prev.filter((_, i) => i !== idx));

  const confirmUpload = async () => {
    if (pickedFiles.length === 0 || uploading) return;
    setUploading(true);
    setUploadErr("");
    try {
      await uploadDocuments(kbId, pickedFiles, { autoParse });
      setUploadOpen(false);
      setPickedFiles([]);
      message.success("上传成功");
      await load();
    } catch (e) {
      setUploadErr(errMsg(e));
    } finally {
      setUploading(false);
    }
  };

  const chunkLabel =
    CHUNK_TEMPLATE_OPTS.find((c) => c.value === kb?.chunkTemplate)?.label ?? "通用";

  // ---- KB 编辑（name / desc / chunkTemplate） ----

  const openEdit = () => {
    if (!kb) return;
    setEditName(kb.name);
    setEditDesc(kb.desc);
    setEditChunkTemplate(kb.chunkTemplate);
    setEditErr("");
    setEditSaving(false);
    setEditOpen(true);
  };

  const submitEdit = async () => {
    if (!kb) return;
    const name = editName.trim();
    if (!name) {
      setEditErr("请填写知识库名称");
      return;
    }
    const chunkTemplateChanged = editChunkTemplate !== kb.chunkTemplate;
    setEditSaving(true);
    setEditErr("");
    try {
      await updateKnowledgeBase(kbId, {
        name,
        desc: editDesc,
        ...(chunkTemplateChanged ? { chunkTemplate: editChunkTemplate } : {}),
      });
      setEditOpen(false);
      message.success("已保存");
      await load();
    } catch (e) {
      const msg = errMsg(e);
      setEditErr(msg.includes("409") ? "知识库正在重建中，请稍候再试" : msg);
    } finally {
      setEditSaving(false);
    }
  };

  // ---- 文档操作 ----

  const retryParse = async (docId: string) => {
    try {
      await triggerParse(docId);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const removeDoc = async (doc: Document) => {
    try {
      await deleteDocument(doc.id);
      if (lifecycleDocId === doc.id) setLifecycleDocId(null);
      message.success("已删除");
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  // ---- 元数据 Modal ----

  const openMeta = (doc: Document) => {
    setMetaDoc(doc);
    const rows = Object.entries(doc.metadata).map(([key, value]) => ({ key, value }));
    setMetaRows(rows.length ? rows : [{ key: "", value: "" }]);
    setMetaErr("");
    setMetaSaving(false);
  };

  const addMetaRow = () => setMetaRows((prev) => [...prev, { key: "", value: "" }]);
  const removeMetaRow = (idx: number) =>
    setMetaRows((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length ? next : [{ key: "", value: "" }];
    });
  const updateMetaRow = (idx: number, patch: Partial<MetaRow>) =>
    setMetaRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const submitMeta = async () => {
    if (!metaDoc) return;
    const keys = metaRows.map((r) => r.key.trim()).filter((k) => k.length > 0);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) {
      setMetaErr(`键「${dup}」重复`);
      return;
    }
    const metadata: Record<string, string> = {};
    for (const r of metaRows) {
      const k = r.key.trim();
      if (k) metadata[k] = r.value;
    }
    setMetaSaving(true);
    setMetaErr("");
    try {
      await updateDocumentMetadata(metaDoc.id, { metadata });
      setMetaDoc(null);
      message.success("已保存");
      await load();
    } catch (e) {
      setMetaErr(errMsg(e));
    } finally {
      setMetaSaving(false);
    }
  };

  const kbTag = kb ? kbStatusTag(kb) : null;
  const failedStage = lifecycle?.stages.find((s) => s.status === "failed");
  const failedLabel = failedStage ? STAGE_LABELS[failedStage.stage].label : "解析入库";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <Button size="small" onClick={() => navigate("/admin/knowledge-bases")}>
          ← 返回列表
        </Button>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{kb?.name ?? "知识库"}</div>
        {kbTag && <Tag color={kbTag.color}>{kbTag.label}</Tag>}
        <div style={{ flex: 1 }} />
        <Button type="primary" onClick={openUpload}>
          ＋ 新增文件
        </Button>
      </div>

      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ margin: "12px 0" }}
          action={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
          closable
          onClose={() => setError("")}
        />
      )}

      {kb && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "12px 0 14px",
            fontSize: 12,
            color: "rgba(0,0,0,.45)",
            flexWrap: "wrap",
          }}
        >
          <span>
            分块模板：<span style={strong}>{chunkLabel}</span>
          </span>
          <span style={dotSep}>·</span>
          <span>
            Embedding：<span style={strong}>{embeddingModelName}</span>
          </span>
          <span style={dotSep}>·</span>
          <span>文档数 {kb.docsCount}</span>
          <span style={dotSep}>·</span>
          <span>切片数 {kb.chunksCount.toLocaleString()}</span>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, height: "auto", marginLeft: 4 }}
            onClick={openEdit}
          >
            编辑
          </Button>
        </div>
      )}

      <div style={legendCard}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>文档处理生命周期</span>
          <span style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
            每篇文档需依次完成以下阶段，全部通过后才会纳入检索。点击「解析状态」或「生命周期」查看单篇进度
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
          {STAGE_ORDER.map((key, i) => {
            const def = STAGE_LABELS[key];
            return (
              <div key={key} style={{ display: "flex", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={legendNum}>{i + 1}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{def.label}</div>
                    <div style={{ fontSize: 11, color: "rgba(0,0,0,.4)" }}>{def.desc}</div>
                  </div>
                </div>
                {i < STAGE_ORDER.length - 1 && (
                  <span style={{ color: "#d9d9d9", margin: "0 14px", fontSize: 14 }}>→</span>
                )}
              </div>
            );
          })}
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
        <div style={gridHeader}>
          <div>文档</div>
          <div>上传时间</div>
          <div>切片数</div>
          <div>处理状态</div>
          <div>元数据</div>
          <div>操作</div>
        </div>
        {loading && (
          <div style={{ padding: "40px 16px", textAlign: "center" }}>
            <Spin />
          </div>
        )}
        {!loading && docs.length === 0 && (
          <Empty
            style={{ padding: "40px 16px" }}
            description="该知识库暂无文档，点击「新增文件」上传"
          />
        )}
        {!loading &&
          docs.map((d) => {
            const sv = DOC_STATUS_VIEW[d.status];
            const metaCount = Object.keys(d.metadata).length;
            return (
              <div key={d.id} style={gridRow}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <div style={typeIcon}>{TYPE_LABEL[d.type]}</div>
                  <span onClick={() => goChunks(d.id)} style={docNameLink} title={d.name}>
                    {d.name}
                  </span>
                </div>
                <div style={{ color: "rgba(0,0,0,.45)", fontSize: 12 }}>
                  {formatDateTime(d.uploadedAt)}
                </div>
                <div onClick={() => goChunks(d.id)} style={linkBlue}>
                  {d.chunksCount}
                </div>
                <div>
                  {d.status === "pending" ? (
                    <div
                      onClick={() => void retryParse(d.id)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        cursor: "pointer",
                        color: "#1677ff",
                        width: "fit-content",
                      }}
                    >
                      <span
                        style={{
                          width: 18,
                          height: 18,
                          flex: "none",
                          borderRadius: "50%",
                          border: "1.5px solid currentColor",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 9,
                          paddingLeft: 2,
                        }}
                      >
                        ▶
                      </span>
                      <span style={{ fontSize: 12 }}>待处理 · 开始</span>
                    </div>
                  ) : (
                    <div
                      onClick={() => setLifecycleDocId(d.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        cursor: "pointer",
                        width: "fit-content",
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          flex: "none",
                          borderRadius: "50%",
                          background: sv.dot,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          color: sv.dot,
                          textDecoration: "underline dotted",
                          textUnderlineOffset: 2,
                        }}
                      >
                        {sv.label}
                      </span>
                    </div>
                  )}
                </div>
                <div>
                  <span onClick={() => openMeta(d)} style={{ ...linkBlue, fontSize: 12 }}>
                    {metaCount ? `${metaCount} 项 · 编辑` : "＋ 添加"}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    fontSize: 13,
                    color: "rgba(0,0,0,.45)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {d.status !== "pending" && (
                    <span onClick={() => goChunks(d.id)} style={linkBlue}>
                      查看切片
                    </span>
                  )}
                  <Popconfirm
                    title={`确认删除文档「${d.name}」？`}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void removeDoc(d)}
                  >
                    <span style={{ cursor: "pointer" }}>删除</span>
                  </Popconfirm>
                </div>
              </div>
            );
          })}
      </div>

      {/* 编辑知识库 Modal：name + desc + chunkTemplate（改分块模板 → 橙色警示即确认，保存直接提交） */}
      <Modal
        title="编辑知识库"
        open={editOpen && !!kb}
        onCancel={() => (editSaving ? undefined : setEditOpen(false))}
        onOk={() => void submitEdit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={editSaving}
        okButtonProps={{ disabled: !editName.trim() }}
        mask={{ closable: !editSaving }}
      >
        {kb && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18, paddingTop: 8 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={fieldLabel}>
                <span style={{ color: "#ff4d4f" }}>*</span> 知识库名称
              </div>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={fieldLabel}>描述</div>
              <Input.TextArea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={fieldLabel}>分块模板</div>
              <Segmented
                block
                value={editChunkTemplate}
                onChange={(v) => setEditChunkTemplate(v as ChunkTemplate)}
                options={CHUNK_TEMPLATE_OPTS.map((c) => ({ label: c.label, value: c.value }))}
              />
              <div style={hintText}>
                {CHUNK_TEMPLATE_OPTS.find((c) => c.value === editChunkTemplate)?.desc}
              </div>
              {editChunkTemplate !== kb.chunkTemplate && (
                <Alert
                  type="warning"
                  showIcon={false}
                  style={{ background: "#fffbe6", border: "1px solid #ffe58f" }}
                  message={
                    <span style={{ color: "#d46b08", fontSize: 12, lineHeight: 1.6 }}>
                      分块模板变更后，库内全部文档将重新解析切片；重建期间检索仍使用旧版本，完成后自动切换。
                    </span>
                  }
                />
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={fieldLabel}>向量模型（Embedding）</div>
              <Select
                disabled
                value={kb.embeddingModelId}
                options={[{ label: embeddingModelName, value: kb.embeddingModelId }]}
                style={{ width: "100%" }}
              />
              <div style={hintText}>创建后不可更换向量模型。</div>
            </div>
            {editErr && <Alert type="error" showIcon message={editErr} />}
          </div>
        )}
      </Modal>

      {/* 上传抽屉：文件/文件夹二选一 + 拖拽区 + 继承分块信息条 + autoParse 开关 */}
      <Drawer
        title={`上传文档 · ${kb?.name ?? ""}`}
        open={uploadOpen}
        onClose={() => (uploading ? undefined : setUploadOpen(false))}
        size={460}
        mask={{ closable: !uploading }}
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
            <Button onClick={() => setUploadOpen(false)} disabled={uploading}>
              取消
            </Button>
            <Button
              type="primary"
              loading={uploading}
              disabled={pickedFiles.length === 0}
              onClick={() => void confirmUpload()}
            >
              {uploading ? "上传中…" : "开始上传"}
            </Button>
          </div>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Segmented
            block
            value={folderMode ? "folder" : "file"}
            onChange={(v) => {
              setFolderMode(v === "folder");
              setPickedFiles([]);
              setUploadErr("");
            }}
            options={[
              { label: "文件", value: "file" },
              { label: "文件夹", value: "folder" },
            ]}
          />
          <Upload.Dragger
            multiple
            showUploadList={false}
            directory={folderMode}
            accept={ALLOWED_EXT.join(",")}
            fileList={[]}
            beforeUpload={(file, fileList) => {
              if (file === fileList[fileList.length - 1]) onPickFiles(fileList as File[]);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">
              {folderMode ? "点击选择文件夹或拖拽到此处" : "点击选择文件或拖拽到此处"}
            </p>
            <p className="ant-upload-hint" style={{ fontSize: 12 }}>
              {folderMode
                ? "将批量识别文件夹内所有支持的文档（PDF / Word / Markdown / TXT）"
                : `支持 PDF / Word / Markdown / TXT，单文件 ≤ 20MB，单批 ≤ ${MAX_BATCH} 个`}
            </p>
          </Upload.Dragger>

          {uploadErr && <Alert type="error" showIcon message={uploadErr} />}

          {pickedFiles.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                maxHeight: 240,
                overflowY: "auto",
              }}
            >
              {pickedFiles.map((f, idx) => {
                const label = folderMode ? f.webkitRelativePath || f.name : f.name;
                return (
                  <div
                    key={`${label}-${idx}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      border: "1px solid #f0f0f0",
                      borderRadius: 6,
                    }}
                  >
                    <div style={{ ...typeIcon, width: 28, height: 28, borderRadius: 6 }}>
                      {fileTypeLabel(f.name)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={label}
                      >
                        {label}
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                        {formatSize(f.size)}
                      </div>
                    </div>
                    <Button type="text" size="small" onClick={() => removePickedFile(idx)}>
                      ×
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "10px 12px",
              background: "#fafafa",
              borderRadius: 6,
              fontSize: 12,
              color: "rgba(0,0,0,.5)",
              lineHeight: 1.6,
              flexWrap: "wrap",
            }}
          >
            分块方式：
            <span style={{ color: "rgba(0,0,0,.75)", fontWeight: 500 }}>{chunkLabel}</span>
            （继承自知识库设置，如需更换请到知识库详情页编辑）
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 13, color: "rgba(0,0,0,.65)" }}>上传后立即解析并切片</div>
              <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)" }}>
                关闭则仅保存原始文件，稍后在文档列表手动触发解析
              </div>
            </div>
            <Switch checked={autoParse} onChange={setAutoParse} />
          </div>
        </div>
      </Drawer>

      {/* 元数据 Modal：受控 key/value 列表编辑器 */}
      <Modal
        title={
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>文档元数据</div>
            <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)", marginTop: 2, fontWeight: 400 }}>
              {metaDoc?.name}
            </div>
          </div>
        }
        open={!!metaDoc}
        onCancel={() => (metaSaving ? undefined : setMetaDoc(null))}
        onOk={() => void submitMeta()}
        okText="保存"
        cancelText="取消"
        confirmLoading={metaSaving}
        mask={{ closable: !metaSaving }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: "rgba(0,0,0,.4)", lineHeight: 1.6 }}>
            元数据随切片一起返回，可用于检索过滤或在生成时补充上下文（如来源、有效期、适用范围）。
          </div>
          {metaRows.map((r, idx) => (
            <div key={idx} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Input
                value={r.key}
                onChange={(e) => updateMetaRow(idx, { key: e.target.value })}
                placeholder="字段名，如 有效期"
              />
              <Input
                value={r.value}
                onChange={(e) => updateMetaRow(idx, { value: e.target.value })}
                placeholder="值"
              />
              <Button type="text" onClick={() => removeMetaRow(idx)}>
                ×
              </Button>
            </div>
          ))}
          <Button
            type="link"
            style={{ alignSelf: "flex-start", padding: 0, height: "auto" }}
            onClick={addMetaRow}
          >
            ＋ 添加字段
          </Button>
          {metaErr && <Alert type="error" showIcon message={metaErr} />}
        </div>
      </Modal>

      {/* 生命周期抽屉：三段进度（上传/解析入库/就绪），数据源真实 getDocumentLifecycle。
          顶部状态徽章按 document.status 映射，不按"最后一个 running 阶段"推断——
          成功路径下 ingest 阶段可能不闭合为 done，仅凭阶段数组会误判为"进行中"。 */}
      <Drawer
        open={!!lifecycleDoc}
        onClose={() => setLifecycleDocId(null)}
        size={480}
        title={
          lifecycleDoc && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span style={{ fontSize: 16, fontWeight: 600, flex: "none" }}>文档生命周期</span>
              <Tag color={DOC_STATUS_VIEW[lifecycleDoc.status].tag}>
                {DOC_STATUS_VIEW[lifecycleDoc.status].label}
              </Tag>
            </div>
          )
        }
      >
        {lifecycleDoc && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
              <div style={{ ...typeIcon, width: 26, height: 26, borderRadius: 6 }}>
                {TYPE_LABEL[lifecycleDoc.type]}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "rgba(0,0,0,.7)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={lifecycleDoc.name}
              >
                {lifecycleDoc.name}
              </div>
            </div>

            {lifecycleDoc.status === "pending" && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 22 }}
                message="文档已上传，尚未解析。点击「开始解析」进入解析入库流程。"
                action={
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => void retryParse(lifecycleDoc.id)}
                  >
                    开始解析
                  </Button>
                }
              />
            )}

            {lifecycleDoc.status === "failed" && (
              <div
                style={{
                  border: "1px solid #ffccc7",
                  background: "#fff2f0",
                  borderRadius: 8,
                  padding: "14px 16px",
                  marginBottom: 22,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        width: 20,
                        height: 20,
                        flex: "none",
                        borderRadius: "50%",
                        background: "#ff4d4f",
                        color: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      ✕
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#cf1322" }}>
                      「{failedLabel}」阶段失败
                    </span>
                  </div>
                  <Button
                    type="primary"
                    danger
                    size="small"
                    onClick={() => void retryParse(lifecycleDoc.id)}
                  >
                    重新解析
                  </Button>
                </div>
                <div style={{ fontSize: 12, color: "#874d00", lineHeight: 1.7, marginTop: 8 }}>
                  {lifecycleDoc.error ?? "文档处理失败，请重试或联系管理员。"}
                </div>
              </div>
            )}

            {lifecycleLoading && <Spin />}
            {lifecycleErr && (
              <Alert type="error" showIcon message={lifecycleErr} style={{ marginBottom: 12 }} />
            )}

            {lifecycle && (
              <Timeline
                items={lifecycle.stages.map((s, i) => {
                  const def = STAGE_LABELS[s.stage];
                  const v = STAGE_VIS[s.status];
                  return {
                    dot: (
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          flex: "none",
                          borderRadius: "50%",
                          background: v.bg,
                          border: `1.5px solid ${v.bd}`,
                          color: v.c,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 13,
                          fontWeight: 700,
                        }}
                      >
                        {v.icon || String(i + 1)}
                      </div>
                    ),
                    children: (
                      <div style={{ paddingBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{def.label}</span>
                          <span
                            style={{
                              fontSize: 11,
                              lineHeight: "18px",
                              padding: "0 7px",
                              borderRadius: 9,
                              background: v.bg,
                              color: v.c,
                              border: `1px solid ${v.bd}`,
                            }}
                          >
                            {v.label}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 3 }}>
                          {def.desc}
                        </div>
                        <div style={{ fontSize: 12, color: "rgba(0,0,0,.35)", marginTop: 5 }}>
                          耗时 {stageDuration(s)} · {stageTime(s)}
                        </div>
                        {s.status === "failed" && s.error && (
                          <div style={{ fontSize: 12, color: "#ff4d4f", marginTop: 5 }}>
                            {s.error}
                          </div>
                        )}
                      </div>
                    ),
                  };
                })}
              />
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}
