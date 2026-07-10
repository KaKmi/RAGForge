import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Empty, Form, Input, Modal, Select, Spin } from "antd";
import type {
  KnowledgeBase,
  ModelProvider,
  ProcessingProfileDescriptor,
} from "@codecrush/contracts";
import {
  createKnowledgeBase,
  getKnowledgeBases,
  getModels,
  getProcessingProfiles,
} from "../../api/client";

/** 知识库管理：卡片网格（对齐重设计原型）。点击卡片 / 「进入」跳文档页。M4 接真实 /api/knowledge-bases。 */

// ccb-blink：building 态元信息行的蓝色呼吸点动画（原型 keyframes，注入一次）。
const BLINK_KEYFRAMES = "@keyframes ccb-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}";

const kbCard: CSSProperties = {
  background: "#fff",
  border: "1px solid #f0f0f0",
  borderRadius: 10,
  padding: "18px 20px",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const linkBlue: CSSProperties = { color: "#1677ff", cursor: "pointer" };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** building/failed 才在元信息行渲染指示点；ready 常态不展示任何状态标签。 */
function statusIndicator(
  r: KnowledgeBase,
): { color: string; blink: boolean; label: string } | null {
  if (r.status === "building")
    return { color: "#1677ff", blink: true, label: `重建中 ${r.progress ?? 0}%` };
  if (r.status === "failed") return { color: "#ff4d4f", blink: false, label: "构建失败" };
  return null;
}

interface CreateForm {
  name: string;
  desc: string;
  processingProfileId: string;
  embeddingModelId: string;
}

const emptyForm: CreateForm = {
  name: "",
  desc: "",
  processingProfileId: "general-v1",
  embeddingModelId: "",
};

export default function KnowledgeBasesPage() {
  const [rows, setRows] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();

  const [form] = Form.useForm<CreateForm>();
  const selectedProfileId = Form.useWatch("processingProfileId", form) ?? "general-v1";

  const [createOpen, setCreateOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProcessingProfileDescriptor[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<ModelProvider[]>([]);
  const [embedErr, setEmbedErr] = useState("");
  const [submitErr, setSubmitErr] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await getKnowledgeBases());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 3s 轮询：有 kb 处于 building 态时才轮询，避免空转请求
  useEffect(() => {
    if (!rows.some((r) => r.status === "building")) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [rows, load]);

  const openCreate = async () => {
    form.resetFields();
    form.setFieldsValue(emptyForm);
    setEmbedErr("");
    setSubmitErr("");
    setSaving(false);
    try {
      const [models, profileList] = await Promise.all([
        getModels().then((ms) => ms.filter((m) => m.type === "embedding" && m.enabled)),
        getProcessingProfiles(),
      ]);
      setProfiles(profileList);
      setEmbeddingModels(models);
      if (models.length === 0) {
        setEmbedErr("暂无可用的 Embedding 模型，请先在「模型接入」页启用一个");
      } else {
        form.setFieldValue("embeddingModelId", models[0].id);
      }
    } catch (e) {
      setEmbeddingModels([]);
      setEmbedErr(errMsg(e));
    }
    setCreateOpen(true);
  };

  const closeCreate = () => {
    if (saving) return;
    setCreateOpen(false);
  };

  const submitCreate = async () => {
    if (saving) return;
    let values: CreateForm;
    try {
      values = await form.validateFields();
    } catch {
      return; // 校验未过，antd 已在字段上呈现错误
    }
    const profile = profiles.find((p) => p.id === values.processingProfileId);
    if (!profile) {
      setSubmitErr("处理方案不可用，请重新选择");
      return;
    }
    setSaving(true);
    setSubmitErr("");
    try {
      await createKnowledgeBase({
        name: values.name.trim(),
        desc: values.desc.trim(),
        processingProfileId: profile.id,
        processingProfileVersion: profile.version,
        embeddingModelId: values.embeddingModelId,
      });
      setCreateOpen(false);
      await load();
    } catch (e) {
      const msg = errMsg(e);
      if (msg.includes("409")) {
        form.setFields([{ name: "name", errors: ["知识库名称已存在，请更换一个"] }]);
      } else {
        setSubmitErr(msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const docsPath = (id: string, upload = false) =>
    `/admin/knowledge-bases/${encodeURIComponent(id)}/documents${upload ? "?upload=1" : ""}`;
  const goDocs = (id: string) => nav(docsPath(id));
  const goUpload = (id: string) => nav(docsPath(id, true));

  const noModels = embeddingModels.length === 0;

  return (
    <div>
      <style>{BLINK_KEYFRAMES}</style>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>知识库</div>
        <Button type="primary" onClick={() => void openCreate()}>
          ＋ 新建知识库
        </Button>
      </div>
      <div
        style={{
          fontSize: 13,
          color: "rgba(0,0,0,.5)",
          marginBottom: 18,
          lineHeight: 1.7,
          maxWidth: 760,
        }}
      >
        每个知识库是一组文档的集合。上传的文档会被解析、切片、向量化后存入所属知识库，供绑定它的
        Agent 检索。
      </div>

      {error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={error}
          action={
            <Button size="small" type="text" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      )}

      {loading && (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <Spin />
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <Empty
          style={{ marginTop: 48 }}
          description="暂无知识库，点击右上角「＋ 新建知识库」创建。"
        />
      )}

      {!loading && rows.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 16,
          }}
        >
          {rows.map((r) => {
            const ind = statusIndicator(r);
            return (
              <div key={r.id} style={kbCard} onClick={() => goDocs(r.id)}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      flex: "none",
                      borderRadius: 9,
                      background: "#e6f4ff",
                      color: "#1677ff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <ellipse cx="12" cy="5" rx="9" ry="3" />
                      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                      <path d="M3 12a9 3 0 0 0 18 0" />
                    </svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{r.name}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)", marginTop: 3 }}>
                      {r.desc}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 12,
                        fontSize: 12,
                        color: "rgba(0,0,0,.45)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <span>
                        <b style={{ color: "rgba(0,0,0,.75)" }}>{r.docsCount}</b> 篇文档
                      </span>
                      <span style={{ color: "rgba(0,0,0,.2)" }}>·</span>
                      <span>更新于 {r.updatedAt.slice(0, 10)}</span>
                      {ind && (
                        <>
                          <span style={{ color: "rgba(0,0,0,.2)" }}>·</span>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              color: ind.color,
                            }}
                          >
                            <span
                              style={{
                                width: 6,
                                height: 6,
                                flex: "none",
                                borderRadius: "50%",
                                background: ind.color,
                                animation: ind.blink
                                  ? "ccb-blink 1.2s infinite ease-in-out"
                                  : undefined,
                              }}
                            />
                            {ind.label}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ flex: 1 }} />
                <div
                  style={{
                    borderTop: "1px solid #f5f5f5",
                    paddingTop: 12,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                  }}
                >
                  <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
                    <span
                      style={linkBlue}
                      onClick={(e) => {
                        e.stopPropagation();
                        goUpload(r.id);
                      }}
                    >
                      上传文档
                    </span>
                    <span
                      style={linkBlue}
                      onClick={(e) => {
                        e.stopPropagation();
                        goDocs(r.id);
                      }}
                    >
                      进入 →
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        title="新建知识库"
        open={createOpen}
        onCancel={closeCreate}
        onOk={() => void submitCreate()}
        okText="创建"
        cancelText="取消"
        confirmLoading={saving}
        mask={{ closable: !saving }}
        okButtonProps={{ disabled: noModels }}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={emptyForm}
          onValuesChange={() => setSubmitErr("")}
          style={{ marginTop: 12 }}
        >
          <Form.Item
            label="知识库名称"
            name="name"
            rules={[{ required: true, whitespace: true, message: "请填写知识库名称" }]}
          >
            <Input placeholder="例如：售后服务知识库" />
          </Form.Item>

          <Form.Item label="描述" name="desc">
            <Input.TextArea rows={2} placeholder="这个知识库存放什么内容，供哪些 Agent 使用" />
          </Form.Item>

          <Form.Item
            label="文档处理方案"
            name="processingProfileId"
            rules={[{ required: true, message: "请选择处理方案" }]}
          >
            <Select
              placeholder="选择这类文档如何解析、清洗、分块"
              optionLabelProp="label"
              options={profiles.map((p) => ({
                value: p.id,
                label: p.label,
                title: p.summary,
                option: (
                  <div>
                    <div>{p.label}</div>
                    <div style={{ fontSize: 12, color: "rgba(0,0,0,.45)" }}>{p.summary}</div>
                  </div>
                ),
              }))}
              optionRender={(opt) => opt.data.option}
            />
          </Form.Item>
          <div
            style={{
              marginTop: -16,
              marginBottom: 16,
              fontSize: 12,
              color: "rgba(0,0,0,.4)",
              lineHeight: 1.6,
            }}
          >
            {profiles.find((p) => p.id === selectedProfileId)?.description}
          </div>

          <Form.Item
            label="向量模型（Embedding）"
            name="embeddingModelId"
            rules={[{ required: true, message: "请选择 Embedding 模型" }]}
            extra="知识库创建后不可更换向量模型，如需切换请新建知识库。"
          >
            <Select
              disabled={noModels}
              placeholder="（无可用模型）"
              options={embeddingModels.map((m) => ({ label: m.name, value: m.id }))}
            />
          </Form.Item>

          {embedErr && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={embedErr} />
          )}
          {submitErr && <Alert type="error" showIcon message={submitErr} />}
        </Form>
      </Modal>
    </div>
  );
}
