import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Prompt, PromptDetail, PromptVersion } from "@codecrush/contracts";
import PromptsPage from "./PromptsPage";
import PromptDetailPage from "./PromptDetailPage";
import * as client from "../../api/client";

// 012 Story 5：列表导航 / 新建跳转 / 详情编辑保存 / 历史载入与副本 / 无发布回滚 UI
vi.mock("../../api/client", () => ({
  getPrompts: vi.fn(),
  getPromptDetail: vi.fn(),
  createPrompt: vi.fn(),
  createPromptVersion: vi.fn(),
  deletePrompt: vi.fn(),
  movePromptTag: vi.fn(),
  removePromptTag: vi.fn(),
  getModels: vi.fn(),
  tryRunPromptVersion: vi.fn(),
  getPromptUsage: vi.fn(),
}));

const mocked = vi.mocked(client);

function makeVersion(over: Partial<PromptVersion> = {}): PromptVersion {
  return {
    id: "pv1",
    promptId: "p1",
    version: 1,
    body: "",
    variables: [],
    author: "demo@codecrush.local",
    contractVersion: 1,
    compileStatus: "ok",
    compileErrors: [],
    tags: [],
    createdAt: "2026-07-10T08:00:00.000Z",
    ...over,
  };
}

function makePrompt(over: Partial<Prompt> = {}): Prompt {
  return {
    id: "p1",
    name: "售后回复生成",
    node: "reply",
    latestVersion: 2,
    versionCount: 2,
    tags: ["production"],
    variables: ["query"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-10T08:00:00.000Z",
    updatedBy: "demo@codecrush.local",
    ...over,
  };
}

function makeDetail(over: Partial<PromptDetail> = {}): PromptDetail {
  return {
    ...makePrompt(),
    versions: [
      makeVersion({ id: "pv2", version: 2, body: "依据 {retrievalContext} 回答 {query}", tags: ["production"], note: "加引用要求" }),
      makeVersion({ id: "pv1", version: 1, body: "回答 {query}" }),
    ],
    ...over,
  };
}

function renderRoutes(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/admin/prompts" element={<PromptsPage />} />
        <Route path="/admin/prompts/:promptId" element={<PromptDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const llmModel = {
  id: "m1",
  type: "llm" as const,
  protocol: "openai_compat" as const,
  name: "deepseek-v3",
  baseUrl: "https://api.example.com/v1",
  apiKeyMasked: "sk-****",
  params: {},
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getPrompts.mockResolvedValue({
    items: [makePrompt()],
    total: 1,
    page: 1,
    pageSize: 10,
  });
  mocked.getPromptDetail.mockResolvedValue(makeDetail());
  mocked.getModels.mockResolvedValue([llmModel]);
  // 默认无使用（不影响既有用例）；Story 6 各用例按需覆盖
  mocked.getPromptUsage.mockResolvedValue([]);
});

describe("Prompt 列表页（012）", () => {
  it("展示最新版本 / 标识 / 变量列，无发布状态列与发布按钮", async () => {
    renderRoutes("/admin/prompts");
    expect(await screen.findByText("售后回复生成")).toBeInTheDocument();
    expect(screen.getByText("最新版本")).toBeInTheDocument();
    expect(screen.getByText("标识")).toBeInTheDocument();
    expect(screen.getByText("production")).toBeInTheDocument();
    expect(screen.getByText("{query}")).toBeInTheDocument();
    // 012：发布状态机 UI 不存在
    expect(screen.queryByText("状态")).not.toBeInTheDocument();
    expect(screen.queryByText("发布")).not.toBeInTheDocument();
    expect(screen.queryByText("回滚")).not.toBeInTheDocument();
    expect(screen.queryByText("生产中")).not.toBeInTheDocument();
  });

  it("点行导航到 /admin/prompts/:id 详情", async () => {
    renderRoutes("/admin/prompts");
    fireEvent.click(await screen.findByText("售后回复生成"));
    await waitFor(() => expect(mocked.getPromptDetail).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("你希望它怎么做")).toBeInTheDocument();
  });

  it("新建弹窗只填名称/节点，成功后跳详情", async () => {
    mocked.createPrompt.mockResolvedValue(makeDetail({ id: "p9", name: "新建的" }));
    mocked.getPromptDetail.mockResolvedValue(makeDetail({ id: "p9", name: "新建的" }));
    renderRoutes("/admin/prompts");
    fireEvent.click(await screen.findByText("＋ 新建 Prompt"));
    expect(await screen.findByText("新建 Prompt")).toBeInTheDocument();
    // 弹窗内没有正文输入（012：v1 空 body 服务端生成）
    expect(screen.queryByPlaceholderText("在此编写 Prompt 模板…")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("如：售后回复生成"), {
      target: { value: "新建的" },
    });
    fireEvent.click(screen.getByText("创建并打开"));
    await waitFor(() =>
      expect(mocked.createPrompt).toHaveBeenCalledWith({ name: "新建的", node: "reply" }),
    );
    // 跳详情
    expect(await screen.findByText("你希望它怎么做")).toBeInTheDocument();
    expect(mocked.getPromptDetail).toHaveBeenCalledWith("p9");
  });
});

describe("Prompt 详情 Playground（012）", () => {
  it("直接路由进入：载入最新版本正文，头部含节点与历史版本计数", async () => {
    renderRoutes("/admin/prompts/p1");
    expect(await screen.findByText("你希望它怎么做")).toBeInTheDocument();
    expect(screen.getByText("回复生成")).toBeInTheDocument();
    expect(screen.getByText("🕑 历史版本 2")).toBeInTheDocument();
    const textarea = screen.getByPlaceholderText("用大白话写清楚这一节点该怎么做…");
    expect(textarea).toHaveValue("依据 {retrievalContext} 回答 {query}");
    // 编辑中版本标注
    expect(screen.getByText(/编辑中 v2/)).toBeInTheDocument();
    // 无发布/回滚 UI
    expect(screen.queryByText(/发布/)).not.toBeInTheDocument();
    expect(screen.queryByText(/回滚/)).not.toBeInTheDocument();
  });

  it("本地实时编译：未知字段标红并支持一键修复", async () => {
    renderRoutes("/admin/prompts/p1");
    const textarea = await screen.findByPlaceholderText("用大白话写清楚这一节点该怎么做…");
    fireEvent.change(textarea, { target: { value: "回答 {qeury}" } });
    expect(await screen.findByText(/未知字段 \{qeury\}/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("一键改为 {query}"));
    expect(textarea).toHaveValue("回答 {query}");
    await waitFor(() =>
      expect(screen.queryByText(/未知字段/)).not.toBeInTheDocument(),
    );
  });

  it("保存总是创建新版本（携带 sourceVersionId），成功后切到新版本", async () => {
    mocked.createPromptVersion.mockResolvedValue(
      makeVersion({ id: "pv3", version: 3, body: "新的正文 {query}" }),
    );
    mocked.getPromptDetail
      .mockResolvedValueOnce(makeDetail())
      .mockResolvedValueOnce(
        makeDetail({
          latestVersion: 3,
          versionCount: 3,
          versions: [
            makeVersion({ id: "pv3", version: 3, body: "新的正文 {query}" }),
            ...makeDetail().versions,
          ],
        }),
      );
    renderRoutes("/admin/prompts/p1");
    const textarea = await screen.findByPlaceholderText("用大白话写清楚这一节点该怎么做…");
    fireEvent.change(textarea, { target: { value: "新的正文 {query}" } });
    fireEvent.change(
      screen.getByPlaceholderText("版本说明（可选）：记录本次修改，便于回溯"),
      { target: { value: "第三版" } },
    );
    fireEvent.click(screen.getByText("保存为新版本"));
    await waitFor(() =>
      expect(mocked.createPromptVersion).toHaveBeenCalledWith("p1", {
        body: "新的正文 {query}",
        note: "第三版",
        sourceVersionId: "pv2",
      }),
    );
    expect(await screen.findByText(/编辑中 v3/)).toBeInTheDocument();
  });

  it("历史抽屉：点行载入版本；「创建副本」预填『基于 vX 修改』", async () => {
    renderRoutes("/admin/prompts/p1");
    fireEvent.click(await screen.findByText("🕑 历史版本 2"));
    expect(await screen.findByTestId("history-version-1")).toBeInTheDocument();
    // 点行载入 v1
    fireEvent.click(screen.getByTestId("history-version-1"));
    const textarea = screen.getByPlaceholderText("用大白话写清楚这一节点该怎么做…");
    expect(textarea).toHaveValue("回答 {query}");
    expect(screen.getByText(/编辑中 v1/)).toBeInTheDocument();
    // 创建副本：预填版本说明
    fireEvent.click(screen.getByText("🕑 历史版本 2"));
    const copyButtons = await screen.findAllByText("创建副本");
    fireEvent.click(copyButtons[0]); // v2 的副本
    expect(
      screen.getByPlaceholderText("版本说明（可选）：记录本次修改，便于回溯"),
    ).toHaveValue("基于 v2 修改");
  });

  it("试运行面板：reply 节点展示参数/输入与运行按钮（query 为空时禁用）", async () => {
    renderRoutes("/admin/prompts/p1");
    expect(await screen.findByTestId("try-run-panel")).toBeInTheDocument();
    const runBtn = await screen.findByRole("button", { name: /运行 v2/ });
    expect(runBtn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("用户问题（必填）"), {
      target: { value: "怎么退货" },
    });
    expect(runBtn).toBeEnabled();
  });
});

describe("Prompt 详情 · 标签面板（012 Story 6）", () => {
  it("展示全部标签及指向版本，编辑版本以外的标签提供「移到 vX」", async () => {
    renderRoutes("/admin/prompts/p1");
    const panel = await screen.findByTestId("tag-panel");
    expect(panel).toHaveTextContent("production → v2");
    expect(panel).toHaveTextContent("只是记账标记，移动/摘除不影响任何服务");
    // production 已指向当前编辑版本 v2 → 无移动按钮，只有摘除
    expect(screen.queryByText("移到 v2")).not.toBeInTheDocument();
  });

  it("自定义标签入口校验：非法字符 / production / v（大小写不敏感）被拒", async () => {
    renderRoutes("/admin/prompts/p1");
    await screen.findByTestId("tag-panel");
    const input = screen.getByPlaceholderText("自定义标识（字母/数字/._-）");
    const submit = screen.getByText("标到当前版本");

    fireEvent.change(input, { target: { value: "有 空格" } });
    fireEvent.click(submit);
    expect(await screen.findByText("仅允许字母、数字、.、_、-")).toBeInTheDocument();
    expect(mocked.movePromptTag).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "PRODUCTION" } });
    fireEvent.click(submit);
    expect(await screen.findByText(/production 请通过/)).toBeInTheDocument();
    expect(mocked.movePromptTag).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "V" } });
    fireEvent.click(submit);
    expect(await screen.findByText(/v 是保留字/)).toBeInTheDocument();
    expect(mocked.movePromptTag).not.toHaveBeenCalled();
  });

  it("合法自定义标签归一小写后移动到当前编辑版本", async () => {
    mocked.movePromptTag.mockResolvedValue([
      { name: "beta.1", versionId: "pv2", version: 2 },
      { name: "production", versionId: "pv2", version: 2 },
    ]);
    renderRoutes("/admin/prompts/p1");
    await screen.findByTestId("tag-panel");
    fireEvent.change(screen.getByPlaceholderText("自定义标识（字母/数字/._-）"), {
      target: { value: "Beta.1" },
    });
    fireEvent.click(screen.getByText("标到当前版本"));
    await waitFor(() =>
      expect(mocked.movePromptTag).toHaveBeenCalledWith("p1", {
        name: "beta.1",
        versionId: "pv2",
      }),
    );
    // 成功后 refetch 详情
    await waitFor(() => expect(mocked.getPromptDetail.mock.calls.length).toBeGreaterThan(1));
  });

  it("移动标签需二次确认，文案明确不影响任何服务", async () => {
    mocked.movePromptTag.mockResolvedValue([]);
    renderRoutes("/admin/prompts/p1");
    // 载入 v1（历史抽屉），production 指向 v2 → 出现「移到 v1」
    fireEvent.click(await screen.findByText("🕑 历史版本 2"));
    fireEvent.click(await screen.findByTestId("history-version-1"));
    fireEvent.click(await screen.findByText("移到 v1"));
    expect(await screen.findByText("仅移动 Prompt 标签，不影响任何服务。")).toBeInTheDocument();
    // antd 两字中文按钮自动插空格（移 动）
    fireEvent.click(screen.getByRole("button", { name: /移\s?动/ }));
    await waitFor(() =>
      expect(mocked.movePromptTag).toHaveBeenCalledWith("p1", {
        name: "production",
        versionId: "pv1",
      }),
    );
  });

  it("摘除标签需二次确认；失败时提示并 refetch 以服务端为准", async () => {
    mocked.removePromptTag.mockRejectedValue(new Error("conflict"));
    renderRoutes("/admin/prompts/p1");
    await screen.findByTestId("tag-panel");
    const before = mocked.getPromptDetail.mock.calls.length;
    fireEvent.click(screen.getByLabelText("摘除 production"));
    expect(await screen.findByText("仅摘除 Prompt 标签，不影响任何服务。")).toBeInTheDocument();
    // 触发按钮 aria-label 也含「摘除」，用精确匹配 Popconfirm 的确认按钮
    fireEvent.click(screen.getByRole("button", { name: "摘 除" }));
    await waitFor(() => expect(mocked.removePromptTag).toHaveBeenCalledWith("p1", "production"));
    await waitFor(() =>
      expect(mocked.getPromptDetail.mock.calls.length).toBeGreaterThan(before),
    );
  });
});

describe("Prompt 详情 · 试运行（012 Story 7）", () => {
  it("运行成功：mode:text 渲染模型输出", async () => {
    mocked.tryRunPromptVersion.mockResolvedValue({ mode: "text", text: "模型的回答" });
    renderRoutes("/admin/prompts/p1");
    fireEvent.change(await screen.findByPlaceholderText("用户问题（必填）"), {
      target: { value: "怎么退货" },
    });
    fireEvent.click(screen.getByRole("button", { name: /运行 v2/ }));
    expect(await screen.findByTestId("try-run-output")).toHaveTextContent("模型的回答");
    expect(mocked.tryRunPromptVersion).toHaveBeenCalledWith(
      "p1",
      "pv2",
      expect.objectContaining({
        modelId: "m1",
        testVars: expect.objectContaining({ query: "怎么退货" }),
      }),
    );
  });

  it("mode:unavailable 渲染占位说明，不显示运行结果", async () => {
    mocked.tryRunPromptVersion.mockResolvedValue({
      mode: "unavailable",
      reason: "unsupported_protocol",
    });
    renderRoutes("/admin/prompts/p1");
    fireEvent.change(await screen.findByPlaceholderText("用户问题（必填）"), {
      target: { value: "q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /运行 v2/ }));
    expect(await screen.findByText("本次试运行不可用")).toBeInTheDocument();
    expect(screen.queryByTestId("try-run-output")).not.toBeInTheDocument();
  });

  it("失败：错误 Alert + 重试按钮可再次运行", async () => {
    mocked.tryRunPromptVersion
      .mockRejectedValueOnce(new Error("模型调用失败：HTTP 500"))
      .mockResolvedValueOnce({ mode: "text", text: "重试成功" });
    renderRoutes("/admin/prompts/p1");
    fireEvent.change(await screen.findByPlaceholderText("用户问题（必填）"), {
      target: { value: "q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /运行 v2/ }));
    expect(await screen.findByText("试运行失败")).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重\s?试/ }));
    expect(await screen.findByTestId("try-run-output")).toHaveTextContent("重试成功");
  });

  it("mode:'structured' 渲染结构化字段与校验步骤（不再显示暂不可用，M8.0）", async () => {
    mocked.tryRunPromptVersion.mockResolvedValue({
      mode: "structured",
      fields: { rewrittenQuery: "改写后的问题", keywords: ["退款"] },
      validateSteps: [
        { step: "input", ok: true },
        { step: "output_schema", ok: true },
      ],
      fallbackUsed: false,
    });
    renderRoutes("/admin/prompts/p1");
    fireEvent.change(await screen.findByPlaceholderText("用户问题（必填）"), {
      target: { value: "怎么退货" },
    });
    fireEvent.click(screen.getByRole("button", { name: /运行 v2/ }));
    const output = await screen.findByTestId("try-run-output");
    expect(output).toHaveTextContent("rewrittenQuery");
    expect(output).toHaveTextContent("改写后的问题");
    expect(screen.getByText("output_schema")).toBeInTheDocument();
    expect(screen.queryByText("本次试运行不可用")).not.toBeInTheDocument();
  });

  it("rewrite 节点：闸门拆除后展示真实运行控件与结构化结果（替换旧「暂不可用」用例，M8.0）", async () => {
    mocked.getPromptDetail.mockResolvedValue(
      makeDetail({ node: "rewrite", versions: [makeVersion({ id: "pv1", body: "改写 {query}" })] }),
    );
    mocked.tryRunPromptVersion.mockResolvedValue({
      mode: "structured",
      fields: { rewrittenQuery: "改写后的问题", keywords: [] },
      validateSteps: [{ step: "input", ok: true }],
      fallbackUsed: false,
    });
    renderRoutes("/admin/prompts/p1");
    // 闸门拆除前这条会直接失败：找不到「用户问题」输入框，只有「结构化预览暂不可用」
    expect(screen.queryByText("结构化预览暂不可用")).not.toBeInTheDocument();
    fireEvent.change(await screen.findByPlaceholderText("用户问题（必填）"), {
      target: { value: "怎么退货" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^运行/ }));
    expect(await screen.findByTestId("try-run-output")).toHaveTextContent("改写后的问题");
  });

  it("无兼容模型（协议不支持/无 llm）：警示且无运行控件", async () => {
    mocked.getModels.mockResolvedValue([
      { ...llmModel, protocol: "cohere" as never },
      { ...llmModel, id: "m2", type: "embedding" as const },
    ]);
    renderRoutes("/admin/prompts/p1");
    expect(await screen.findByText("没有可试运行的模型")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^运行/ })).not.toBeInTheDocument();
  });

  it("编译错误版本：提示不可试运行且无运行按钮", async () => {
    mocked.getPromptDetail.mockResolvedValue(
      makeDetail({
        versions: [
          makeVersion({
            id: "pv2",
            version: 2,
            body: "{bad_x}",
            compileStatus: "has_errors",
            compileErrors: [{ code: "UNKNOWN_VARIABLE", severity: "error", message: "x" }],
          }),
        ],
      }),
    );
    renderRoutes("/admin/prompts/p1");
    expect(await screen.findByText("该版本存在编译错误，无法试运行")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^运行/ })).not.toBeInTheDocument();
  });
});

describe("Prompt 详情 · 谁在用（M7a Story 6）", () => {
  const usageEntry = (over: Partial<import("@codecrush/contracts").PromptUsageEntry> = {}) => ({
    promptVersionId: "pv2",
    promptVersion: 2,
    applicationId: "app1",
    applicationName: "售后助手",
    node: "reply" as const,
    configVersion: 1,
    ...over,
  });

  it("命中当前编辑版本 → 头部「● vN 服务中」徽标 + 底部具名条幅", async () => {
    mocked.getPromptUsage.mockResolvedValue([usageEntry()]);
    renderRoutes("/admin/prompts/p1");
    // 当前编辑版本为 v2（pv2）
    expect(await screen.findByText("● v2 服务中")).toBeInTheDocument();
    expect(
      screen.getByText(
        /「售后助手」的线上配置正用着 v2，对外服务中。改这个版本不会影响正在服务的内容/,
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(mocked.getPromptUsage).toHaveBeenCalledWith("p1"));
  });

  it("历史抽屉命中版本行显示「服务中 · 应用名」标记", async () => {
    mocked.getPromptUsage.mockResolvedValue([usageEntry()]);
    renderRoutes("/admin/prompts/p1");
    await screen.findByText("● v2 服务中");
    fireEvent.click(screen.getByText("🕑 历史版本 2"));
    const row = await screen.findByTestId("history-version-2");
    expect(within(row).getByText("服务中 · 售后助手")).toBeInTheDocument();
    // 未被引用的 v1 行无标记
    expect(
      within(screen.getByTestId("history-version-1")).queryByText(/服务中 ·/),
    ).not.toBeInTheDocument();
  });

  it("usage 请求失败 → 徽标/条幅/标记全部缺席，页面主体正常", async () => {
    mocked.getPromptUsage.mockRejectedValue(new Error("404"));
    renderRoutes("/admin/prompts/p1");
    // 页面主体正常渲染（编辑区可见）
    expect(await screen.findByText("你希望它怎么做")).toBeInTheDocument();
    expect(screen.queryByText(/服务中/)).not.toBeInTheDocument();
    expect(screen.queryByText(/线上配置正用着/)).not.toBeInTheDocument();
  });

  it("usage 返回空数组 → 同样缺席，不渲染任何「无人使用」否定文案", async () => {
    mocked.getPromptUsage.mockResolvedValue([]);
    renderRoutes("/admin/prompts/p1");
    expect(await screen.findByText("你希望它怎么做")).toBeInTheDocument();
    expect(screen.queryByText(/服务中/)).not.toBeInTheDocument();
    expect(screen.queryByText(/无人使用/)).not.toBeInTheDocument();
    expect(screen.queryByText(/没有应用/)).not.toBeInTheDocument();
  });
});
