import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { Application, GapFillDraft, KnowledgeBase } from "@codecrush/contracts";
import {
  cancelGapFill,
  draftGapFill,
  getApplicationDetail,
  getApplications,
  getGapFillDraft,
  getKnowledgeBases,
  submitGapFill,
} from "../../api/client";

const { Text } = Typography;

/**
 * `[补知识库]` 三步向导（原型 §9 `:367` 交互 + §17.5 `:633` 组件矩阵 + §19.1 `:746-748` 校验）。
 *
 * 形态是 **Drawer 内 Steps**（§17.5 「形态」栏逐字），不是 Modal——第②步是一个带 2000 字
 * 文本域的编辑表单，Modal 里塞不下。
 *
 * ⛔ **产品红线：无人审不入库**（原型 §1 非目标 `:108` 明列「自动无人审入库」为不做）。
 * 界面上的体现：第②步**没有**「直接入库」的捷径，「确认入库」在勾选「我已核对答案与来源」
 * 之前恒 disabled。后端也各自独立拦了一道（未勾选 400、状态非 `reviewing` 400）——
 * 前端这道只是省一次往返，**不是**唯一防线，改动时别以为去掉它只是少个提示。
 *
 * 步骤由**后端簇状态**驱动而不是本地 step 数字：向导可能被关掉再打开（草稿保留），
 * 用本地计数会让「关掉重开」回到第①步、把已经草拟好的内容又覆盖一遍。
 */

/** 原型 §19.1 `:746-747` 的字段上限（与 `SubmitFillRequestSchema` 同源）。 */
const QUESTION_MAX = 200;
const ANSWER_MAX = 2000;

export interface GapFillWizardProps {
  open: boolean;
  /** 非空即打开向导并锁定该簇。 */
  clusterId: string | null;
  onClose: () => void;
  /** 状态有任何推进后回调，供屏5 重拉列表（状态列/角标要跟着变）。 */
  onChanged: () => void;
}

export default function GapFillWizard({
  open,
  clusterId,
  onClose,
  onChanged,
}: GapFillWizardProps) {
  const [draft, setDraft] = useState<GapFillDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 第②步的可编辑内容与选择项。
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [kbId, setKbId] = useState<string | undefined>();
  const [appId, setAppId] = useState<string | undefined>();
  const [confirmed, setConfirmed] = useState(false);

  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [apps, setApps] = useState<Application[]>([]);
  /** 应用 → 其当前 production 配置版本。没上线过的应用不能做回验目标，见下方 Select。 */
  const [productionVersions, setProductionVersions] = useState<Record<string, string | null>>({});

  const load = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    try {
      const next = await getGapFillDraft(clusterId);
      setDraft(next);
      setQuestion(next.draftQuestion ?? "");
      setAnswer(next.draftAnswer ?? "");
      setKbId(next.targetKbId ?? undefined);
      setErr(null);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "加载补库草稿失败");
    } finally {
      setLoading(false);
    }
  }, [clusterId]);

  // 每次打开都重新拉：草稿可能被上一次会话改过，也可能已经被别人推进到别的状态。
  useEffect(() => {
    if (!open) return;
    setConfirmed(false);
    setErr(null);
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    void getKnowledgeBases()
      .then(setKbs)
      .catch(() => setKbs([]));
    void getApplications()
      .then(async (list) => {
        setApps(list);
        // 逐个取 production 指针：列表接口不带它，而「这个应用能不能用来回验」全看它。
        const entries = await Promise.all(
          list.map(async (app) => {
            try {
              const detail = await getApplicationDetail(app.id);
              return [app.id, detail.productionConfigVersionId] as const;
            } catch {
              return [app.id, null] as const;
            }
          }),
        );
        setProductionVersions(Object.fromEntries(entries));
      })
      .catch(() => setApps([]));
  }, [open]);

  const status = draft?.status;

  /** 第①步：请求草拟。失败时后端已把簇退回 `pending`，所以这里允许原地重试。 */
  const runDraft = async () => {
    if (!clusterId) return;
    setDrafting(true);
    setErr(null);
    try {
      await draftGapFill(clusterId);
      await load();
      onChanged();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "草拟失败");
      // 重新拉一次拿到退回后的状态，否则界面会停在一个已经不成立的「草拟中」。
      await load();
      onChanged();
    } finally {
      setDrafting(false);
    }
  };

  const cancel = async () => {
    if (!clusterId) return;
    try {
      await cancelGapFill(clusterId);
      message.success("已取消补库，草稿已保留");
      onChanged();
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "取消失败");
    }
  };

  const submit = async () => {
    if (!clusterId) return;
    // 本地先拦契约硬约束：不挡的话 postJson 会在发请求前同步抛 ZodError，
    // 用户在 toast 里看到一段序列化的 issues 数组，而表单上没有任何指向出错字段的提示。
    if (!question.trim()) return setErr("问题不能为空");
    if (question.trim().length > QUESTION_MAX) return setErr(`问题不超过 ${QUESTION_MAX} 字`);
    if (!answer.trim()) return setErr("答案不能为空");
    if (answer.trim().length > ANSWER_MAX) return setErr(`答案不超过 ${ANSWER_MAX} 字`);
    if (!kbId) return setErr("请选择目标知识库");
    if (!appId) return setErr("请选择用于回验的应用");
    const configVersionId = productionVersions[appId];
    if (!configVersionId) return setErr("该应用尚未上线，无法用于回验");
    if (!confirmed) return setErr("请先勾选「我已核对答案与来源」"); // §19.1 逐字

    setSubmitting(true);
    setErr(null);
    try {
      await submitGapFill(clusterId, {
        question: question.trim(),
        answer: answer.trim(),
        targetKbId: kbId,
        applicationId: appId,
        configVersionId,
        confirmed: true,
      });
      // §19.2 `:757` 逐字。
      message.success("已提交入库，文档处理完成后将自动回验");
      onChanged();
      onClose();
    } catch (error) {
      // 失败必须出声：静默会让人以为已经提交了，转头再点一次就是第二份重复文档。
      setErr(error instanceof Error ? error.message : "提交入库失败");
    } finally {
      setSubmitting(false);
    }
  };

  /** 原型 §17.5 `:633` 的三态：①草拟中 ②人审编辑 ③入库中。 */
  const stepIndex = status === "reviewing" ? 1 : status === "filled" ? 2 : 0;

  return (
    <Drawer
      open={open}
      title="补知识库"
      width={720}
      onClose={onClose}
      destroyOnHidden
      extra={
        <Space>
          {(status === "drafting" || status === "reviewing") && (
            <Button onClick={() => void cancel()}>取消补库</Button>
          )}
          {status === "reviewing" && (
            <Button
              type="primary"
              loading={submitting}
              // 红线的界面侧体现：没勾「已核对」就点不了。后端另有独立一道。
              disabled={!confirmed}
              onClick={() => void submit()}
            >
              确认入库
            </Button>
          )}
        </Space>
      }
    >
      <Steps
        size="small"
        current={stepIndex}
        style={{ marginBottom: 16 }}
        items={[{ title: "草拟" }, { title: "人审编辑" }, { title: "入库中" }]}
      />

      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}

      {loading && !draft ? (
        <Spin />
      ) : status === "pending" || status === "drafting" ? (
        <div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="LLM 先起一份候选问答，你审阅并修改后才会入库"
            description="草稿只依据模型自身的常识，**不掌握**你们的内部资料——具体数字、期限、金额一律会写成「（待确认）」，请在下一步逐条核实。"
          />
          {drafting ? (
            <Space>
              <Spin size="small" />
              <Text type="secondary">正在草拟…（约 10 秒）</Text>
            </Space>
          ) : (
            <Button type="primary" onClick={() => void runDraft()}>
              {draft?.draftQuestion ? "重新草拟" : "开始草拟"}
            </Button>
          )}
        </div>
      ) : status === "reviewing" ? (
        <div>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="来源未确认"
            description="以下内容由模型生成、未经资料核实。入库后会进入检索并被真实回答引用，请逐条确认后再提交。"
          />
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            问题 <Text type="danger">*</Text>
          </div>
          <Input
            aria-label="补库问题"
            value={question}
            maxLength={QUESTION_MAX}
            showCount
            onChange={(e) => setQuestion(e.target.value)}
            style={{ marginBottom: 12 }}
          />
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            答案 <Text type="danger">*</Text>
          </div>
          <Input.TextArea
            aria-label="补库答案"
            value={answer}
            maxLength={ANSWER_MAX}
            showCount
            autoSize={{ minRows: 8, maxRows: 20 }}
            onChange={(e) => setAnswer(e.target.value)}
            style={{ marginBottom: 12 }}
          />
          <Space size={12} wrap style={{ marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                目标知识库 <Text type="danger">*</Text>
              </div>
              <Select
                aria-label="目标知识库"
                style={{ width: 240 }}
                placeholder="选择要写入的知识库"
                value={kbId}
                onChange={setKbId}
                options={kbs.map((kb) => ({
                  value: kb.id,
                  // 重建中的库不可选：文档会挂到一个即将被换掉的版本上，
                  // 用户以为补好了、检索却永远看不到它（后端也会 400，这里是提前告知）。
                  disabled: kb.status !== "ready",
                  label:
                    kb.status === "ready" ? (
                      kb.name
                    ) : (
                      <Tooltip title="知识库重建中，暂不可入库">
                        <span>
                          {kb.name} <Tag>重建中</Tag>
                        </span>
                      </Tooltip>
                    ),
                }))}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                回验应用 <Text type="danger">*</Text>
              </div>
              <Select
                aria-label="回验应用"
                style={{ width: 240 }}
                placeholder="用哪个应用验证补库效果"
                value={appId}
                onChange={setAppId}
                options={apps.map((app) => ({
                  value: app.id,
                  // 没上线过的应用没有 production 版本，回验无从跑起——
                  // 在这里禁掉，别等到提交时才报错。
                  disabled: !productionVersions[app.id],
                  label: productionVersions[app.id] ? (
                    app.name
                  ) : (
                    <Tooltip title="该应用尚未上线，无法用于回验">
                      <span>
                        {app.name} <Tag>未上线</Tag>
                      </span>
                    </Tooltip>
                  ),
                }))}
              />
            </div>
          </Space>
          <div>
            <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}>
              我已核对答案与来源
            </Checkbox>
          </div>
        </div>
      ) : status === "filled" ? (
        <Alert
          type="success"
          showIcon
          message="已提交入库"
          description="文档正在走切片与向量化管线，完成后会自动回验并更新缺口状态，无需在此等待。"
        />
      ) : (
        <Alert
          type="info"
          showIcon
          message={`该缺口当前状态为「${status ?? "未知"}」，补库向导不适用`}
          description="补库只能从「待处理」发起；已回验或已忽略的缺口请先重新打开。"
        />
      )}
    </Drawer>
  );
}
