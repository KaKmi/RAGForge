import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { message } from "antd";
import AddToEvalSetModal from "./AddToEvalSetModal";
import * as api from "../../api/client";

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getEvalSets: vi.fn(), createEvalCase: vi.fn(), createEvalSet: vi.fn() };
});

const TRACE = "a".repeat(32);

// 不清会串味：上一条用例的 createEvalCase 调用会被下一条的 not.toHaveBeenCalled 读到。
beforeEach(() => {
  vi.clearAllMocks();
});

function renderModal(props: Partial<React.ComponentProps<typeof AddToEvalSetModal>> = {}) {
  vi.mocked(api.getEvalSets).mockResolvedValue([
    { id: "set-1", name: "售后核心 50 题" } as never,
  ]);
  vi.mocked(api.createEvalCase).mockResolvedValue({ id: "case-1" } as never);
  return render(
    <AddToEvalSetModal
      open
      sourceTraceId={TRACE}
      question="课程有效期是终身吗?"
      onClose={() => {}}
      onDone={() => {}}
      {...props}
    />,
  );
}

/**
 * antd Select 不是原生 <select>：mouseDown 开下拉，再在下拉门户里点选项
 * （同 EvalSetsPage.test.tsx:238-243 的既有范式）。
 */
async function pickFirstSet() {
  fireEvent.mouseDown(screen.getByRole("combobox"));
  await screen.findByRole("option", { name: "售后核心 50 题" });
  const dropdown = document.querySelector(".ant-select-dropdown") as HTMLElement;
  fireEvent.click(within(dropdown).getByText("售后核心 50 题"));
}

const confirm = () => screen.getByRole("button", { name: /确认加入/ });
const clickConfirm = () => fireEvent.click(confirm());

it("gold 留空可提交（原型：留空则进集后为待补 gold）", async () => {
  const onDone = vi.fn();
  renderModal({ onDone });
  await pickFirstSet();
  clickConfirm();
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(vi.mocked(api.createEvalCase)).toHaveBeenCalledWith(
    "set-1",
    expect.objectContaining({
      question: "课程有效期是终身吗?",
      goldPoints: [],
      sourceTraceId: TRACE,
    }),
  );
});

it("gold 编辑框 placeholder 逐字照抄原型", async () => {
  renderModal();
  expect(await screen.findByPlaceholderText("留空则进集后为待补 gold")).toBeInTheDocument();
});

it("成功后 toast 文案逐字「已加入评测集『售后核心 50 题』，状态：待审核」", async () => {
  const toast = vi.spyOn(message, "success");
  renderModal();
  await pickFirstSet();
  clickConfirm();
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith("已加入评测集『售后核心 50 题』，状态：待审核"),
  );
});

it("gold 多条按分号拆分（中英文分号都认）", async () => {
  renderModal();
  await pickFirstSet();
  fireEvent.change(screen.getByPlaceholderText("留空则进集后为待补 gold"), {
    target: { value: "7 天无理由退款；已开课按比例退" },
  });
  clickConfirm();
  await waitFor(() =>
    expect(vi.mocked(api.createEvalCase)).toHaveBeenCalledWith(
      "set-1",
      expect.objectContaining({ goldPoints: ["7 天无理由退款", "已开课按比例退"] }),
    ),
  );
});

it("未选目标集时不提交（避免打到一个不存在的 setId）", async () => {
  renderModal();
  await screen.findByPlaceholderText("留空则进集后为待补 gold");
  clickConfirm();
  await waitFor(() => expect(screen.getByText("请选择目标评测集")).toBeInTheDocument());
  expect(vi.mocked(api.createEvalCase)).not.toHaveBeenCalled();
});

/** 入集失败不能静默——用户会以为已经加进去了。 */
it("提交失败时报错且不回调 onDone", async () => {
  const onDone = vi.fn();
  vi.spyOn(message, "error").mockImplementation(() => null as never);
  renderModal({ onDone });
  vi.mocked(api.createEvalCase).mockRejectedValue(new Error("集不存在"));
  await pickFirstSet();
  clickConfirm();
  await waitFor(() => expect(message.error).toHaveBeenCalledWith("集不存在"));
  expect(onDone).not.toHaveBeenCalled();
});

/**
 * 下拉内「新建评测集」是本弹窗最有状态的一段（追加列表 → 自动选中 → 可提交）。
 * 不钉的话，删掉 setSetId(created.id) 或 setSets 追加都不会有任何测试变红。
 */
it("下拉内新建评测集：创建后自动选中，可直接提交到新集", async () => {
  vi.mocked(api.createEvalSet).mockResolvedValue({ id: "set-new", name: "新集" } as never);
  renderModal();
  fireEvent.mouseDown(screen.getByRole("combobox"));
  await screen.findByRole("option", { name: "售后核心 50 题" });

  const nameInput = screen.getByPlaceholderText("新建评测集名称");
  fireEvent.change(nameInput, { target: { value: "  新集  " } });
  fireEvent.click(screen.getByRole("button", { name: /新\s*建/ }));

  // 名称去空白后提交
  await waitFor(() => expect(api.createEvalSet).toHaveBeenCalledWith({ name: "新集", kbIds: [] }));

  // 自动选中新集 → 直接确认即可入到新集
  clickConfirm();
  await waitFor(() =>
    expect(vi.mocked(api.createEvalCase)).toHaveBeenCalledWith(
      "set-new",
      expect.objectContaining({ sourceTraceId: TRACE }),
    ),
  );
});

/**
 * question 为空时 client.ts 的 postJson 会在发请求前同步抛 ZodError，
 * 而 ZodError.message 是一坨 JSON。必须本地挡住并给人话。
 */
it("trace 无用户问题时本地拦截，不发请求也不吐 ZodError", async () => {
  renderModal({ question: "" });
  await pickFirstSet();
  clickConfirm();
  await waitFor(() =>
    expect(screen.getByText("该 trace 没有用户问题，无法入集")).toBeInTheDocument(),
  );
  expect(vi.mocked(api.createEvalCase)).not.toHaveBeenCalled();
});

it("gold 单条超 200 字本地拦截（§19.1），给人话不给 ZodError", async () => {
  renderModal();
  await pickFirstSet();
  fireEvent.change(screen.getByPlaceholderText("留空则进集后为待补 gold"), {
    target: { value: "长".repeat(201) },
  });
  clickConfirm();
  await waitFor(() =>
    expect(screen.getByText("gold 要点每条不超过 200 字")).toBeInTheDocument(),
  );
  expect(vi.mocked(api.createEvalCase)).not.toHaveBeenCalled();
});
