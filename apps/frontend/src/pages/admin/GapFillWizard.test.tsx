import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    ...patch,
  };
}

function setup(over: { kbReady?: boolean; appLive?: boolean } = {}) {
  const { kbReady = true, appLive = true } = over;
  api.getKnowledgeBases.mockResolvedValue([
    { id: KB, name: "客服知识库", status: kbReady ? "ready" : "rebuilding" },
  ]);
  api.getApplications.mockResolvedValue([{ id: APP, name: "客服机器人" }]);
  api.getApplicationDetail.mockResolvedValue({
    id: APP,
    productionConfigVersionId: appLive ? VERSION : null,
  });
}

function renderWizard() {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <GapFillWizard open clusterId={CLUSTER} onClose={onClose} onChanged={onChanged} />,
  );
  return { onChanged, onClose };
}

/** 把第②步填到「只差勾确认」的状态。 */
async function fillForm() {
  await screen.findByDisplayValue("能开增值税专用发票吗？");
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "目标知识库" }));
  fireEvent.click(await screen.findByTitle("客服知识库"));
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "回验应用" }));
  fireEvent.click(await screen.findByTitle("客服机器人"));
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

  it("状态 filled → 第③步「入库中」，表单不再可编辑", async () => {
    api.getGapFillDraft.mockResolvedValue(draft({ status: "filled" }));
    renderWizard();

    await screen.findByText(/入库中|处理中|自动回验/);
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
