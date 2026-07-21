import { useCallback, useEffect, useRef, useState } from "react";
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
import type {
  Application,
  GapClusterStatus,
  GapFillDraft,
  KnowledgeBase,
} from "@codecrush/contracts";
import {
  cancelGapFill,
  draftGapFill,
  resumeGapFill,
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

/**
 * 原型 §17.5 `:633` 的三态在各簇状态上的落点。
 *
 * 「哪些状态属于向导」与「它们各在第几步」是**同一份数据**——原先拆成
 * `WIZARD_STATES` 数组 + 一串嵌套三元，加了新状态而三元没跟上就会静默错位。
 * 不在表里的状态（`verified`/`ignored`/`routed_retrieval`）走「向导不适用」兜底 Alert。
 */
const STEP_OF: Partial<Record<GapClusterStatus, number>> = {
  pending: 0,
  drafting: 0,
  reviewing: 1,
  filled: 2,
};

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

  /**
   * 拉草稿。`preserveEdits` 决定**要不要用服务端内容覆盖用户正在编辑的文本**。
   *
   * ⛔ 这个参数是红线设施，不是便利开关。复审在第二轮抓到：提交失败后无条件 `load()`
   * 会把运营已经人工核实、改写过的答案换回 LLM 原始草稿，而 `confirmed` 复选框
   * **仍然是勾上的**（`setConfirmed(false)` 只在 open effect 里跑）。用户再点一次
   * 确认入库，进知识库的就是一份没有任何人看过的 LLM 生成内容，还带着「已核对」标记——
   * 正是整个向导存在要防的那件事。
   *
   * 于是分成两类调用：
   *  · `preserveEdits: false`（打开、草拟完成）——服务端内容就是**新的事实**，该覆盖，
   *    同时把 `confirmed` 清掉：换了内容，之前那次确认自然作废。
   *  · `preserveEdits: true`（提交失败后）——只刷新状态，用户的编辑一个字都不能动。
   */
  /** 始终指向**当前**渲染的簇——异步连续体用它判断自己是否已经过期（见 `load`）。 */
  const currentClusterRef = useRef(clusterId);
  useEffect(() => {
    currentClusterRef.current = clusterId;
  }, [clusterId]);

  const load = useCallback(
    async (opts: { preserveEdits?: boolean } = {}) => {
      if (!clusterId) return;
      setLoading(true);
      try {
        const next = await getGapFillDraft(clusterId);
        /**
         * ⛔ 陈旧响应守卫（第三轮复审 P1-2，复审员用延迟 mock 实测复现）。
         *
         * `load` 是闭包，`await` 期间用户可能已经切到**另一个**簇了。慢的簇 A 响应
         * 后落地，会把已经渲染好的簇 B 内容整个覆盖掉——用户核对的是 A 的答案，
         * 入库到的是 B。
         *
         * ⚠️ 必须比 `currentClusterRef.current`，**不能**比闭包里的 `clusterId`：
         * 那个值在 A 的闭包里恒等于 A，`next.clusterId` 也是 A，守卫永远成立、
         * 等于没写。第一版就是这么写的，靠一条同样有缺陷的测试「验证」通过——
         * 直到把测试修对（用 act 跑完 A 的连续体）才暴露出来。ref 存的是**当前**
         * 渲染的簇，与闭包无关，这才是「我还是不是用户正在看的那个簇」的真实答案。
         */
        if (next.clusterId !== currentClusterRef.current) return;
        setDraft(next);
        if (!opts.preserveEdits) {
          setQuestion(next.draftQuestion ?? "");
          setAnswer(next.draftAnswer ?? "");
          setKbId(next.targetKbId ?? undefined);
          // 内容被换掉 ⇒ 上一次的「我已核对」作废。人只确认过他看见的那份。
          setConfirmed(false);
          setErr(null);
        }
      } catch (error) {
        setErr(error instanceof Error ? error.message : "加载补库草稿失败");
      } finally {
        setLoading(false);
      }
    },
    [clusterId],
  );

  // 每次打开都重新拉：草稿可能被上一次会话改过，也可能已经被别人推进到别的状态。
  useEffect(() => {
    if (!open) return;
    setConfirmed(false);
    setErr(null);
    /**
     * ⛔ 打开时必须把**上一个簇的内容清干净**（第三轮复审 P1-1，实测可复现）。
     *
     * ⚠️ 前提已变：`GapsPage` 现在给本组件挂了 `key={fillClusterId}`，key 变化即卸载重建，
     * 所以**在单个实例内 `clusterId` 恒定**，这段清理实际上不可达。保留是刻意的——
     * 它是 key 被误删时的保险（那时 state 会重新开始跨簇存活）。
     * 原先只清 `confirmed`/`err`/`appId`，内容字段留着——
     * 于是「关掉簇 A，打开簇 B，而 B 的 fill-draft 请求失败」这条路径上，
     * 屏幕显示的是**簇 A 的问答**、报错 Alert 同时挂着、「确认入库」还可点，
     * 提交出去就是把 A 的内容写进 B 的知识库并触发对 B 的回验。
     *
     * `appId` 同理：它是纯本地选择，`load()` 根本不碰。
     */
    setDraft(null);
    setQuestion("");
    setAnswer("");
    setKbId(undefined);
    setAppId(undefined);
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    void getKnowledgeBases()
      .then(setKbs)
      .catch(() => setKbs([]));
    /**
     * `productionConfigVersionId` **就在列表响应里**（`ApplicationSchema` 上，
     * 后端 `APP_SELECT` 显式选了它），不需要再逐个拉详情。
     *
     * 初版对每个应用都发了一次 `getApplicationDetail`，注释还写着「列表接口不带它」——
     * 那句是错的，清理复审两位独立指出。代价不只是 1+N 次请求：详情响应是
     * `ApplicationSchema.extend({ versions })`，每次还额外拖回该应用的**全部配置版本历史**。
     * 而且它逼出了一整套本不需要的三态（`string`/`null`/`undefined`）与「状态未知」文案分支
     * ——那个分支存在的唯一理由是「详情请求可能失败」，而这个请求根本不该发。
     * 仓库里 `EvalSetsPage`/`ChatPage` 早就是直接从列表读这个字段的。
     */
    void getApplications()
      .then(setApps)
      .catch(() => setApps([]));
  }, [open]);

  /**
   * ⛔ `draft` 必须与**当前**簇同源，否则视为「没有草稿」。
   *
   * 第三轮复审的两条 P1 同源：`draft` 曾会跨簇存活。open effect 在打开时清内容，
   * `load` 丢弃陈旧响应——这里是第三道，把「渲染哪一屏」这个决策本身也锁死在同源前提上。
   * 三道都指向同一件事：**用户核对的内容，必须就是即将入库到这个簇的内容**。
   *
   * ⚠️ 三道**不是互为冗余**（021 §11.8 曾这么写，独立复审实测证伪）：
   * 只有本道单独充分；第一道只覆盖「打开时残留」，第二道只覆盖「陈旧响应」。
   * 结构性修法是 `GapsPage` 的 `key={fillClusterId}`（卸载重建），三道降级为纵深防御。
   *
   * ⚠️ 本道目前**没有测试单独钉住**：改成 `draft !== null` 时 18 条全绿（复审实测）。
   * 因为在有 key 的结构下它不可达，构造不出只依赖它的场景。已知覆盖缺口，别当它被保护着。
   */
  const draftFresh = draft?.clusterId === clusterId;
  const status = draftFresh ? draft?.status : undefined;

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
      const msg = error instanceof Error ? error.message : "草拟失败";
      // 重新拉一次拿到退回后的状态，否则界面会停在一个已经不成立的「草拟中」。
      await load();
      onChanged();
      // 与 submit 同理：`setErr` 必须在 `load()` 之后，否则被 `load` 的 `setErr(null)`
      // 抹掉，用户点完「开始草拟」只看到界面弹回原样、没有任何原因说明。
      // （第二轮复审指出这里原本就是错的，而修 submit 时的注释还写着「与 runDraft 对齐」。）
      setErr(msg);
    } finally {
      setDrafting(false);
    }
  };

  /**
   * 拿回上次保留的草稿，直接回第②步。**不调模型**——这正是它与「重新草拟」的区别。
   *
   * 成功后 `load()` 把状态刷成 `reviewing`，渲染自然切到人审表单，
   * 内容用的是库里保留的那份（`load` 的 `preserveEdits: false` 分支写进输入框）。
   */
  const resumeDraft = async () => {
    if (!clusterId) return;
    setErr(null);
    try {
      await resumeGapFill(clusterId);
      await load();
      onChanged();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "无法继续上次草稿";
      await load();
      onChanged();
      // 与 runDraft/submit 同理：setErr 必须在 load() **之后**，
      // 否则被 load 成功路径的 setErr(null) 抹掉，用户点完只看到界面弹回原样。
      setErr(msg);
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
    const configVersionId = apps.find((a) => a.id === appId)?.productionConfigVersionId;
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
      const msg = error instanceof Error ? error.message : "提交入库失败";
      /**
       * 重新拉一次状态（与 `runDraft` 的 catch 对齐）。失败原因可能正是「这个簇已经
       * 不在 reviewing 了」——别人并发取消/推进过。不刷新的话界面会继续显示人审表单、
       * 确认入库按钮仍然可点，用户重试多少次都是同一个错。
       */
      // `preserveEdits`：只刷新状态，**绝不**拿服务端草稿覆盖用户已核实的文本。
      // 详见 `load` 的注释——覆盖 + confirmed 残留 = 未经人审的内容进库。
      await load({ preserveEdits: true });
      onChanged();
      /**
       * ⚠️ `setErr` 必须在 `load()` **之后**：`load()` 成功时会 `setErr(null)`，
       * 顺序反过来就把刚写的报错抹掉了，用户看到的是一个什么都没说的界面——
       * 而「失败必须出声」正是这段代码存在的理由（静默会让人以为提交成功了，
       * 转头再点一次就是第二份重复文档）。这条被测试抓了个正着。
       */
      setErr(msg);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 原型 §17.5 `:633` 的三态：①草拟中 ②人审编辑 ③入库中。
   *
   * `verified`/`ignored`/`routed_retrieval` 走的是「向导不适用」兜底 Alert，
   * 此时不能再高亮第①步——那会和 Alert 说的话自相矛盾（复审 P3）。`-1` = 不高亮任何步。
   */
  const stepIndex = (status && STEP_OF[status]) ?? -1;

  return (
    <Drawer
      open={open}
      /*
        标题带上代表问题：核对一份答案却看不到它要回答的原始问题本就不合理，
        而且这是内容串簇时用户**唯一**能察觉异常的锚点（复审 P3，纵深防御）。
      */
      title={
        draftFresh && draft?.representativeQuestion
          ? `补知识库 — ${draft.representativeQuestion}`
          : "补知识库"
      }
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
          {/*
            `drafting`（本地）只反映**本客户端**的在途请求。后端 status 也是 `drafting`
            时说明别的标签页/同事已经在草拟了——那时渲染一个可点的「开始草拟」，
            点下去只会拿到 400。两个来源都要认（复审 P3）。
          */}
          {drafting || status === "drafting" ? (
            <Space>
              <Spin size="small" />
              <Text type="secondary">正在草拟…（约 10 秒）</Text>
            </Space>
          ) : draft?.draftQuestion ? (
            /*
              有保留的草稿时，**「继续编辑」才是主按钮**（021 §9b 决策 J：
              「保留 fill_draft_* 供下次重新打开向导时跳过①直接到②」）。

              B2b 初版这里只有「重新草拟」——草稿确实留在库里，用户却到不了它，
              点下去发起一次新的 LLM 调用并把保留的那份覆盖掉。承诺的价值一次都没兑现过
              （运行时 QA 抓出「文档承诺 ≠ 实现」）。「重新草拟」降为次要按钮，
              并在 Tooltip 里说清它会覆盖——那是个不可逆动作，不该看起来和继续编辑同级。
            */
            <Space>
              <Button type="primary" onClick={() => void resumeDraft()}>
                继续编辑上次草稿
              </Button>
              <Tooltip title="会调用模型重新生成，覆盖上次保留的草稿">
                <Button onClick={() => void runDraft()}>重新草拟</Button>
              </Tooltip>
            </Space>
          ) : (
            <Button type="primary" onClick={() => void runDraft()}>
              开始草拟
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
                  disabled: !app.productionConfigVersionId,
                  label: app.productionConfigVersionId ? (
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
