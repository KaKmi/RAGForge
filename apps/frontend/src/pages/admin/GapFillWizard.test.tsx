import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GapFillDraft } from "@codecrush/contracts";
import GapFillWizard from "./GapFillWizard";

/**
 * 补知识库三步向导（原型 §17.5 `:633`，021 决策 I）。
 *
 * 这一屏的**存在理由**就是「LLM 草的内容不许直接进知识库」——所以本文件的断言重心不是
 * 渲染细节，而是那道人审闸门：没勾确认不许提交、没上线的应用不许选作回验目标、
 * 重建中的知识库不许入库。这些不是 UI 偏好，是 spec 的红线在前端这一侧的落点。
 */

const api = vi.hoisted(() => ({
  getGapFillDraft: vi.fn(),
  draftGapFill: vi.fn(),
  cancelGapFill: vi.fn(),
  resumeGapFill: vi.fn(),
  submitGapFill: vi.fn(),
  getKnowledgeBases: vi.fn(),
  getApplications: vi.fn(),
  getApplicationDetail: vi.fn(),
}));
vi.mock("../../api/client", () => api);

const messageMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("antd", async () => {
  const antd = await vi.importActual<typeof import("antd")>("antd");
  return { ...antd, message: { ...antd.message, ...messageMock } };
});

const CLUSTER = "11111111-1111-4111-8111-111111111111";
const KB = "22222222-2222-4222-8222-222222222222";
const APP = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";

function draft(patch: Partial<GapFillDraft> = {}): GapFillDraft {
  return {
    clusterId: CLUSTER,
    status: "reviewing",
    representativeQuestion: "能开专用发票吗",
    draftQuestion: "能开增值税专用发票吗？",
    draftAnswer: "可以。请提供开票抬头与税号，3 个工作日内寄出。",
    targetKbId: null,
    targetDocumentId: null,
    ...patch,
  };
}

function setup(over: { kbReady?: boolean; appLive?: boolean } = {}) {
  const { kbReady = true, appLive = true } = over;
  api.getKnowledgeBases.mockResolvedValue([
    { id: KB, name: "客服知识库", status: kbReady ? "ready" : "rebuilding" },
  ]);
  // `productionConfigVersionId` 就在列表响应里——向导不再逐个拉详情（见 GapFillWizard 的注释）。
  api.getApplications.mockResolvedValue([
    { id: APP, name: "客服机器人", productionConfigVersionId: appLive ? VERSION : null },
  ]);
}

function renderWizard() {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <GapFillWizard open clusterId={CLUSTER} onClose={onClose} onChanged={onChanged} />,
  );
  return { onChanged, onClose };
}

/** 需要在同一个组件实例上开关 `open` / 换 `clusterId` 的用例走这个。 */
function renderWizardRaw(clusterId: string) {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <GapFillWizard open clusterId={clusterId} onClose={onClose} onChanged={onChanged} />,
  );
  return {
    onChanged,
    onClose,
    rerender: (open: boolean, id: string) =>
      view.rerender(
        <GapFillWizard open={open} clusterId={id} onClose={onClose} onChanged={onChanged} />,
      ),
  };
}

/**
 * 把第②步填到「只差勾确认」的状态。
 *
 * **等的是「选中真的落下了」，不是「某个渲染细节出现了」。**
 * `findByTitle` 只能等到「选项可点」，点完之后选中有没有被 antd 记下来是另一回事——
 * 用它当唯一的同步点，后续断言（提交按钮可用、submitGapFill 收到 configVersionId）
 * 就建立在一个还没落地的前提上，全量并跑抢 CPU 时偶发红（实测约 8 次 1 次）。
 * 选中项文本出现在 `.ant-select-selection-item` 上才是真正的就绪信号。
 *
 * ⚠️ 别改成「等 option 不带 disabled class」——试过，更糟：`findByTitle` 返回的节点
 * 未必有 `.ant-select-item` 祖先，`closest()` 为 `null` 时 `expect(null).not.toHaveClass()`
 * 直接抛错，waitFor 一路重试到 15s 超时，从「8 次红 1 次」变成「4 次全红」。
 */
async function fillForm() {
  await screen.findByDisplayValue("能开增值税专用发票吗？");
  await pick("目标知识库", "客服知识库");
  await pick("回验应用", "客服机器人");
}

/** 选一个下拉项，并**确认它真的被选中**后才返回。 */
async function pick(label: string, option: string) {
  const select = () => screen.getByRole("combobox", { name: label }).closest(".ant-select")!;
  fireEvent.mouseDown(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByTitle(option));
  await waitFor(() => expect(select()).toHaveTextContent(option));
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

describe("补知识库向导", () => {
  it("状态 pending → 停在第①步，点「AI 草拟」才产生草稿", async () => {
    api.getGapFillDraft.mockResolvedValue(
      draft({ status: "pending", draftQuestion: null, draftAnswer: null }),
    );
    api.draftGapFill.mockResolvedValue({});
    renderWizard();

    fireEvent.click(await screen.findByRole("button", { name: /草拟/ }));

    await waitFor(() => expect(api.draftGapFill).toHaveBeenCalledWith(CLUSTER));
  });

  /**
   * 021 §9b 决策 J 承诺「取消补库后**保留**草稿，下次重开向导跳过①直接到②」。
   * B2b 初版草稿确实留在库里，但 UI 到不了它——第①步唯一的按钮是「重新草拟」，
   * 点下去调模型并把保留的那份**覆盖**掉。承诺的价值一次都没兑现过（运行时 QA 抓出）。
   */
  it("有保留草稿 ⇒ 第①步主按钮是「继续编辑上次草稿」，且**不调模型**", async () => {
    api.getGapFillDraft.mockResolvedValue(
      draft({ status: "pending", draftQuestion: "上次的问题", draftAnswer: "上次的答案" }),
    );
    api.resumeGapFill.mockResolvedValue({});
    renderWizard();

    fireEvent.click(await screen.findByRole("button", { name: "继续编辑上次草稿" }));

    await waitFor(() => expect(api.resumeGapFill).toHaveBeenCalledWith(CLUSTER));
    // 关键：走的是纯状态迁移，**没有**发起新的 LLM 草拟。
    expect(api.draftGapFill).not.toHaveBeenCalled();
  });

  it("没有草稿 ⇒ 只有「开始草拟」，不渲染继续编辑的入口", async () => {
    // 配对：只测「有草稿时有按钮」的话，一个无条件渲染它的实现也能通过——
    // 而那会让绝大多数从没草拟过的簇看到一个点了必 400 的按钮。
    api.getGapFillDraft.mockResolvedValue(
      draft({ status: "pending", draftQuestion: null, draftAnswer: null }),
    );
    renderWizard();

    expect(await screen.findByRole("button", { name: "开始草拟" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续编辑上次草稿" })).not.toBeInTheDocument();
  });

  it("继续编辑失败要出声——错误不能被随后的 load 抹掉", async () => {
    api.getGapFillDraft.mockResolvedValue(
      draft({ status: "pending", draftQuestion: "上次的问题", draftAnswer: "上次的答案" }),
    );
    api.resumeGapFill.mockRejectedValue(new Error("这个缺口没有保留的草稿"));
    renderWizard();

    fireEvent.click(await screen.findByRole("button", { name: "继续编辑上次草稿" }));

    expect(await screen.findByText("这个缺口没有保留的草稿")).toBeInTheDocument();
  });

  it("**没勾「我已核对」不许提交**——这道闸门就是本屏存在的理由", async () => {
    api.getGapFillDraft.mockResolvedValue(draft());
    renderWizard();
    await fillForm();

    // 闸门在界面侧的形态是**按钮直接禁用**，不是点了再报错。
    const submit = screen.getByRole("button", { name: "确认入库" });
    expect(submit).toBeDisabled();

    fireEvent.click(submit);

    // 断言的是「**没有**发出请求」——禁用属性写对了但 onClick 照样跑，仍然是漏。
    expect(api.submitGapFill).not.toHaveBeenCalled();
  });

  it("勾了确认 + 选齐目标 → 带 production 版本号提交", async () => {
    api.getGapFillDraft.mockResolvedValue(draft());
    api.submitGapFill.mockResolvedValue({});
    const { onClose } = renderWizard();
    await fillForm();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认入库" }));

    await waitFor(() =>
      expect(api.submitGapFill).toHaveBeenCalledWith(CLUSTER, {
        question: "能开增值税专用发票吗？",
        answer: "可以。请提供开票抬头与税号，3 个工作日内寄出。",
        targetKbId: KB,
        applicationId: APP,
        // 用户从没选过版本号——它是从应用的 production 指针推出来的。
        configVersionId: VERSION,
        confirmed: true,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("提交失败**不关抽屉**，错误留在屏上（静默会诱发第二份重复文档）", async () => {
    api.getGapFillDraft.mockResolvedValue(draft());
    api.submitGapFill.mockRejectedValue(new Error("知识库正在重建，暂不可入库"));
    const { onClose } = renderWizard();
    await fillForm();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认入库" }));

    await screen.findByText("知识库正在重建，暂不可入库");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("未上线的应用不可选作回验目标", async () => {
    setup({ appLive: false });
    api.getGapFillDraft.mockResolvedValue(draft());
    renderWizard();
    await screen.findByDisplayValue("能开增值税专用发票吗？");

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "回验应用" }));

    // 禁用项的 label 是 Tooltip 包着的 `<span>名字 <Tag>未上线</Tag></span>`，
    // 所以 antd 不会把 `title` 设成应用名——按**文本**找，别按 title 找。
    const label = await screen.findByText("未上线");
    expect(label.closest(".ant-select-item")).toHaveClass("ant-select-item-option-disabled");
  });

  it("提交失败后**重新拉状态**（并发取消时不让用户对着同一个错反复重试）", async () => {
    api.getGapFillDraft.mockResolvedValue(draft());
    api.submitGapFill.mockRejectedValue(new Error("缺口当前状态是「pending」"));
    renderWizard();
    await fillForm();
    fireEvent.click(screen.getByRole("checkbox"));

    expect(api.getGapFillDraft).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "确认入库" }));

    // 第二次 load：失败原因可能正是「这个簇已经不在 reviewing 了」，
    // 不刷新的话界面继续显示人审表单，重试多少次都是同一个错。
    await waitFor(() => expect(api.getGapFillDraft).toHaveBeenCalledTimes(2));
  });

  /**
   * 第二轮复审抓到的 P1，且是**我修 P3 时自己引入的**：为了让并发取消能刷新状态，
   * 我在提交失败分支加了无条件 `load()`——它会把运营人工核实、改写过的答案换回
   * LLM 原始草稿，而「我已核对」复选框仍然勾着。再点一次确认入库，进知识库的
   * 就是一份没有任何人看过的 LLM 生成内容，还带着人审通过的标记。
   *
   * 这三条是那个 P1 的回归网：编辑必须活下来、确认状态必须诚实。
   */
  it("提交失败后**不覆盖**用户已改写的答案（否则人审内容被换回 LLM 草稿）", async () => {
    api.getGapFillDraft.mockResolvedValue(draft());
    api.submitGapFill.mockRejectedValue(new Error("知识库正在重建"));
    renderWizard();
    await fillForm();

    const edited = "可以。抬头+税号发我，2 个工作日内电子发票发邮箱。";
    fireEvent.change(screen.getByLabelText("补库答案"), { target: { value: edited } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认入库" }));

    await screen.findByText("知识库正在重建");
    // 服务端草稿仍是 LLM 那份；重新拉过之后，屏上必须还是**人写的**那份。
    expect(screen.getByLabelText("补库答案")).toHaveValue(edited);
    expect(screen.queryByDisplayValue(draft().draftAnswer!)).not.toBeInTheDocument();
  });

  it("内容被服务端草稿覆盖时，「我已核对」必须跟着作废", async () => {
    /**
     * ⚠️ 这条的**第一版是空测**，第三轮复审用变异测试证明了：删掉 `load` 里的
     * `setConfirmed(false)` 它照样绿。原因是它从 `pending` 起步，复选框自始至终
     * 没被勾过（open effect 早已置 false），`not.toBeChecked()` 恒真，与被测的那行
     * 毫无因果。教训：断言「某状态为假」时，必须先让它真过一次，否则测的是初始值。
     *
     * 现在的构造：reviewing 态勾上确认 → 关掉再打开（触发 preserveEdits=false 的 load）
     * → 内容被服务端草稿重新覆盖，确认必须作废。
     */
    api.getGapFillDraft.mockResolvedValue(draft());
    const { rerender } = renderWizardRaw(CLUSTER);
    await screen.findByDisplayValue("能开增值税专用发票吗？");

    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).toBeChecked();

    rerender(false, CLUSTER);
    rerender(true, CLUSTER);

    await screen.findByDisplayValue("能开增值税专用发票吗？");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  /**
   * 第三轮复审的两条 P1——复审员用探针实测复现了「簇 A 的问答被提交进簇 B」。
   * 本组件在 GapsPage 里是**单实例常驻**（open/clusterId 切换，不卸载重建），
   * 所以 state 必然跨簇存活，这两条在生产可达，不是测试构造出来的。
   */
  it("⛔ 换簇后 load 失败 → 绝不能拿上一个簇的问答去提交", async () => {
    api.getGapFillDraft.mockResolvedValue(draft());
    const { rerender } = renderWizardRaw(CLUSTER);
    await fillForm();
    fireEvent.click(screen.getByRole("checkbox"));

    // 换到簇 B，且 B 的草稿拉取失败。
    const other = "55555555-5555-4555-8555-555555555555";
    api.getGapFillDraft.mockRejectedValue(new Error("网络抖动"));
    rerender(false, CLUSTER);
    rerender(true, other);

    await screen.findByText("网络抖动");
    // 簇 A 的内容必须已经不在屏上，确认入库也不该可点——否则 A 的问答会写进 B 的知识库。
    expect(screen.queryByDisplayValue("能开增值税专用发票吗？")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认入库" })).not.toBeInTheDocument();
    expect(api.submitGapFill).not.toHaveBeenCalled();
  });

  it("⛔ 陈旧响应：慢的簇 A 响应回来时，不得覆盖已渲染的簇 B", async () => {
    const other = "55555555-5555-4555-8555-555555555555";
    let releaseA: (v: unknown) => void = () => {};
    api.getGapFillDraft.mockReturnValueOnce(
      new Promise((res) => {
        releaseA = res;
      }),
    );
    const { rerender } = renderWizardRaw(CLUSTER);

    // A 还挂着就切到 B，B 立刻返回。
    api.getGapFillDraft.mockResolvedValue(
      draft({ clusterId: other, draftQuestion: "B 的问题", draftAnswer: "B 的答案" }),
    );
    rerender(false, CLUSTER);
    rerender(true, other);
    await screen.findByDisplayValue("B 的问题");

    /**
     * 这时 A 的响应才落地——必须被丢弃。
     *
     * ⚠️ 必须用 `act` 把 A 的 `.then` 连续体**跑完**再断言。第一版直接 `releaseA()` 后
     * `waitFor(B 的值还在)`，而那个 waitFor 首次检查就通过了（B 的值本来就在），
     * 根本没等到 A 的 setState——于是这条测试在**修复前的代码上照样绿**，是空测。
     * 「断言某事没发生」时，必须先确保那件事已经有机会发生。
     */
    await act(async () => {
      releaseA(draft());
      await Promise.resolve();
    });

    expect(screen.getByLabelText("补库问题")).toHaveValue("B 的问题");
    expect(screen.queryByDisplayValue("能开增值税专用发票吗？")).not.toBeInTheDocument();
  });

  it("草拟失败要**出声**——错误不能被随后的 load 抹掉", async () => {
    // `setErr` 写在 `load()` 之前就会被 `load` 的 `setErr(null)` 吞掉，
    // 用户点完「AI 草拟」只看到界面弹回原样、没有任何原因说明。
    api.getGapFillDraft.mockResolvedValue(
      draft({ status: "pending", draftQuestion: null, draftAnswer: null }),
    );
    api.draftGapFill.mockRejectedValue(new Error("草拟模型未配置"));
    renderWizard();

    fireEvent.click(await screen.findByRole("button", { name: /草拟/ }));

    expect(await screen.findByText("草拟模型未配置")).toBeInTheDocument();
  });

  /**
   * 原来这里有一条「详情请求失败的应用标『状态未知』而不是谎称『未上线』」。
   * 那条**连同它所守护的分支一起被删掉了**——「状态未知」这一态的唯一来源是
   * 逐个 `getApplicationDetail` 可能失败，而那个请求根本不该发：
   * `productionConfigVersionId` 就在列表响应里（清理复审两位独立指出）。
   * 请求没了，这一态在结构上不可能出现，留着测试就是在守一段死代码。
   *
   * 「未上线」那一半仍然被上面的「未上线的应用不可选作回验目标」守着。
   */
  it("应用列表拉取失败 ⇒ 下拉为空，不伪造任何状态", async () => {
    api.getApplications.mockRejectedValue(new Error("网络抖动"));
    api.getGapFillDraft.mockResolvedValue(draft());
    renderWizard();
    await screen.findByDisplayValue("能开增值税专用发票吗？");

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "回验应用" }));

    expect(screen.queryByText("未上线")).not.toBeInTheDocument();
    expect(screen.queryByTitle("客服机器人")).not.toBeInTheDocument();
  });

  it("换簇重开 → 上个簇选的回验应用不能跟着带过来", async () => {
    /**
     * 复审第二轮：`appId` 是纯本地选择，`load()` 只重置来自草稿的字段，
     * 而 `destroyOnHidden` 销毁的是 Drawer 子树、不是本组件 state。
     * 不清的话，换一个簇打开会静默沿用上一个簇选的应用——回验会跑在错误的应用上，
     * 而界面看起来完全正常。这条测的就是那个 `setAppId(undefined)`。
     */
    api.getGapFillDraft.mockResolvedValue(draft());
    const { rerender } = renderWizardRaw(CLUSTER);
    await fillForm();
    // 选中项的文字在 `.ant-select-selection-item` 上，不在 `combobox`（那是里面的 input）上。
    const appSelect = () =>
      screen.getByRole("combobox", { name: "回验应用" }).closest(".ant-select")!;
    expect(appSelect()).toHaveTextContent("客服机器人");

    // 关掉再以**另一个簇**打开——组件实例不变，state 会活下来。
    rerender(false, CLUSTER);
    const other = "55555555-5555-4555-8555-555555555555";
    api.getGapFillDraft.mockResolvedValue(draft({ clusterId: other }));
    rerender(true, other);

    await screen.findByDisplayValue("能开增值税专用发票吗？");
    expect(appSelect()).not.toHaveTextContent("客服机器人");
  });

  it("状态 filled → 第③步「入库中」，表单不再可编辑", async () => {
    api.getGapFillDraft.mockResolvedValue(draft({ status: "filled" }));
    renderWizard();

    // ⚠️ 不能断言 /入库中/：那是 Steps 的第③步标题，**每个状态都渲染**，
    // 拿它当判据的话连 `verified`（走的是「补库向导不适用」兜底 Alert）都能通过——
    // 复审用一个探针测试实测证明了这一点。要断言只属于 filled 面板的文本。
    await screen.findByText("已提交入库");
    // 人审表单必须已经收起：还留着就意味着能对一份已入库的内容再改一遍。
    expect(screen.queryByLabelText("补库答案")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认入库" })).not.toBeInTheDocument();
  });

  it("取消补库 → 保留草稿并关闭", async () => {
    api.getGapFillDraft.mockResolvedValue(draft());
    api.cancelGapFill.mockResolvedValue({});
    const { onClose, onChanged } = renderWizard();
    await screen.findByDisplayValue("能开增值税专用发票吗？");

    fireEvent.click(screen.getByRole("button", { name: /取消补库/ }));

    await waitFor(() => expect(api.cancelGapFill).toHaveBeenCalledWith(CLUSTER));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
