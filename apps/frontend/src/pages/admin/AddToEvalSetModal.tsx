import { useEffect, useState } from "react";
import { Alert, Button, Divider, Form, Input, Modal, Select, Space, message } from "antd";
import type { EvalSet } from "@codecrush/contracts";
import { createEvalCase, createEvalSet, getEvalSets } from "../../api/client";

/**
 * B1/F2：Trace 详情「+ 加入评测集」弹窗（原型 §10 `:414` / §17.6 `:647`）。
 *
 * 逐字口径：
 *  · gold 编辑框 placeholder「留空则进集后为待补 gold」（`:414`）；
 *  · 成功 toast「已加入评测集『{名称}』，状态：待审核」（§19.2 `:754`）。
 *
 * 入集后用例状态是 `draft`（后端默认），与 toast 的「待审核」对应；gold 留空合法
 * ——`reviewed` 才要求 ≥1 条 gold，`draft` 不要求。
 */
export interface AddToEvalSetModalProps {
  open: boolean;
  sourceTraceId: string;
  question: string;
  onClose: () => void;
  /** 入集成功后回调（携带目标集 id），供调用方就地刷新按钮态。 */
  onDone: (setId: string) => void;
}

/** §19.1 的长度上限——与 EvalSetsPage 同源，本地先校验，不让 ZodError 冒到 toast。 */
const QUESTION_MAX = 500;
const GOLD_POINT_MAX = 200;

/** 多条 gold 以分号分隔（中英文都认），空条目丢弃。 */
export function splitGoldPoints(value: string): string[] {
  return value
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function AddToEvalSetModal({
  open,
  sourceTraceId,
  question,
  onClose,
  onDone,
}: AddToEvalSetModalProps) {
  const [sets, setSets] = useState<EvalSet[]>([]);
  const [setId, setSetId] = useState<string | undefined>();
  const [gold, setGold] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    void getEvalSets()
      .then(setSets)
      .catch(() => setSets([]));
  }, [open]);

  // 关闭时清干净，避免下次打开还留着上一条 trace 的 gold 草稿。
  useEffect(() => {
    if (open) return;
    setSetId(undefined);
    setGold("");
    setErr(null);
    setNewName("");
  }, [open]);

  const createSet = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await createEvalSet({ name, kbIds: [] });
      setSets((prev) => [...prev, created]);
      setSetId(created.id);
      setNewName("");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "新建评测集失败");
    } finally {
      setCreating(false);
    }
  };

  const submit = async () => {
    if (!setId) {
      setErr("请选择目标评测集");
      return;
    }
    // 本地先把契约的三条硬约束挡下来。不挡的话，client.ts 的 postJson 会在发请求前
    // 同步抛 ZodError，而 ZodError.message 是一坨 JSON —— 用户会在 toast 里看到
    // 一段序列化的 issues 数组，且弹窗里没有问题字段可改，等于死路。
    if (!question.trim()) {
      setErr("该 trace 没有用户问题，无法入集");
      return;
    }
    if (question.trim().length > QUESTION_MAX) {
      setErr(`问题不超过 ${QUESTION_MAX} 字`);
      return;
    }
    const goldPoints = splitGoldPoints(gold);
    if (goldPoints.some((p) => p.length > GOLD_POINT_MAX)) {
      setErr(`gold 要点每条不超过 ${GOLD_POINT_MAX} 字`);
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      await createEvalCase(setId, {
        question,
        goldPoints,
        // 本波不做从 trace 反推 gold 文档引用（那属检索层 gold，屏2 的 GoldRefSelector 负责）；
        // 入集后是 draft，用户在评测集里补齐。
        goldDocRefs: [],
        tags: [],
        sourceTraceId,
      });
      const name = sets.find((s) => s.id === setId)?.name ?? "";
      message.success(`已加入评测集『${name}』，状态：待审核`);
      onDone(setId);
    } catch (e) {
      // 失败必须出声：静默会让用户以为已经加进去了，转头再点一次造重复用例。
      message.error(e instanceof Error ? e.message : "加入评测集失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="加入评测集"
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={submitting}
      // 显式中文按钮文案：不依赖外层 ConfigProvider 的 locale（测试环境没有它）。
      okText="确认加入"
      cancelText="取消"
      destroyOnHidden
    >
      <Form layout="vertical">
        {/* err 现在也承载「问题为空/超长」「gold 超长」，挂在 Select 的 help 上会指错地方。 */}
        {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}
        <Form.Item label="目标评测集" required>
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="选择要加入的评测集"
            value={setId}
            onChange={(v) => {
              setSetId(v);
              setErr(null);
            }}
            options={sets.map((s) => ({ value: s.id, label: s.name }))}
            popupRender={(menu) => (
              <>
                {menu}
                <Divider style={{ margin: "8px 0" }} />
                <Space.Compact style={{ width: "100%", padding: "0 8px 4px" }}>
                  <Input
                    placeholder="新建评测集名称"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  <Button loading={creating} onClick={() => void createSet()}>
                    新建
                  </Button>
                </Space.Compact>
              </>
            )}
          />
        </Form.Item>
        <Form.Item label="gold 要点" help="多条以分号分隔；留空则该用例进集后为「待补 gold」">
          <Input.TextArea
            rows={4}
            placeholder="留空则进集后为待补 gold"
            value={gold}
            onChange={(e) => setGold(e.target.value)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
