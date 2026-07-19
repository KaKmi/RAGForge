import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  Application,
  ApplicationConfigFields,
  ApplicationConfigVersion,
  ApplicationDetail,
  KnowledgeBase,
  ModelProvider,
  PromptNode,
  PromptNodeVersionCandidate,
} from "@codecrush/contracts";
import ApplicationsPage, { buildDefaultConfig } from "./ApplicationsPage";
import ApplicationDetailPage from "./ApplicationDetailPage";
import * as client from "../../api/client";

vi.mock("../../api/client", () => ({
  getApplications: vi.fn(),
  getApplicationDetail: vi.fn(),
  createApplication: vi.fn(),
  updateApplication: vi.fn(),
  deleteApplication: vi.fn(),
  createApplicationConfigVersion: vi.fn(),
  tryApplicationVersionChat: vi.fn(),
  getKnowledgeBases: vi.fn(),
  getModels: vi.fn(),
  getPromptNodeVersions: vi.fn(),
  listApplicationTags: vi.fn(),
  moveApplicationTag: vi.fn(),
  removeApplicationTag: vi.fn(),
  startApplicationReleaseCheck: vi.fn(),
  getApplicationReleaseCheck: vi.fn(),
  publishApplicationProduction: vi.fn(),
  unpublishApplicationProduction: vi.fn(),
}));

const mocked = vi.mocked(client);

const kb = (over: Partial<KnowledgeBase> = {}): KnowledgeBase =>
  ({
    id: "kb1",
    name: "售后知识库",
    desc: "",
    status: "ready",
    embeddingModelId: "em1",
    chunkTemplate: "general",
    activeVersion: 1,
    buildingVersion: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }) as unknown as KnowledgeBase;

const llm = (over: Partial<ModelProvider> = {}): ModelProvider =>
  ({
    id: "m1",
    type: "llm",
    protocol: "openai_compat",
    name: "deepseek-v3",
    baseUrl: "https://api.example.com/v1",
    apiKeyMasked: "sk-****",
    params: {},
    enabled: true,
    ...over,
  }) as unknown as ModelProvider;

const candidate = (node: PromptNode): PromptNodeVersionCandidate => ({
  promptId: `p-${node}`,
  promptName: `${node} prompt`,
  versionId: `pv-${node}`,
  version: 1,
  tags: node === "reply" ? ["production"] : [],
  compileStatus: "ok",
  createdAt: "2026-07-01T00:00:00.000Z",
});

const candidatesByNode = (): Record<PromptNode, PromptNodeVersionCandidate[]> => ({
  rewrite: [candidate("rewrite")],
  intent: [candidate("intent")],
  reply: [candidate("reply")],
  fallback: [candidate("fallback")],
});

const nodeCfg = (node: PromptNode) => ({
  promptVersionId: `pv-${node}`,
  modelId: "m1",
  freedom: "balance" as const,
  temperature: 0.7,
  topP: 0.9,
});

const configFields = (): ApplicationConfigFields => ({
  kbIds: ["kb1"],
  nodes: {
    rewrite: nodeCfg("rewrite"),
    intent: nodeCfg("intent"),
    reply: nodeCfg("reply"),
    fallback: nodeCfg("fallback"),
  },
  retrieval: {
    schemaVersion: 1,
    topK: 20,
    topN: 5,
    hybridEnabled: true,
    vectorWeight: 0.7,
    rerankEnabled: false,
  },
  fallback: { toHuman: true },
});

const version = (over: Partial<ApplicationConfigVersion> = {}): ApplicationConfigVersion => ({
  ...configFields(),
  id: "appv1",
  applicationId: "app1",
  version: 1,
  configSchemaVersion: 1,
  createdBy: "demo@codecrush.local",
  createdAt: "2026-07-10T08:00:00.000Z",
  ...over,
});

const application = (over: Partial<Application> = {}): Application => ({
  id: "app1",
  slug: "aftersale-bot",
  name: "售后助手",
  description: "处理退换货咨询",
  enabled: true,
  // B1/F5：门禁开关默认关（原型 §8「默认关(仅提示)」）；开关只影响前端按钮态，不影响后端放行。
  evalGateEnabled: false,
  productionVersion: null,
  productionConfigVersionId: null,
  latestVersion: 1,
  versionCount: 1,
  tags: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-10T08:00:00.000Z",
  updatedBy: "demo@codecrush.local",
  createdBy: "demo@codecrush.local",
  ...over,
});

const detail = (over: Partial<ApplicationDetail> = {}): ApplicationDetail => ({
  ...application(),
  versions: [version()],
  ...over,
});

function renderRoutes(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/admin/applications" element={<ApplicationsPage />} />
        <Route path="/admin/applications/:appId" element={<ApplicationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getApplications.mockResolvedValue([application()]);
  mocked.getApplicationDetail.mockResolvedValue(detail());
  mocked.getKnowledgeBases.mockResolvedValue([kb()]);
  mocked.getModels.mockResolvedValue([llm()]);
  mocked.getPromptNodeVersions.mockImplementation(async (node: PromptNode) => [candidate(node)]);
  mocked.tryApplicationVersionChat.mockResolvedValue({
    mode: "unavailable",
    reason: "pending_orchestration",
  });
  mocked.listApplicationTags.mockResolvedValue([]);
});

describe("buildDefaultConfig", () => {
  it("四节点取首候选 + 首个启用 llm + 默认检索/兜底", () => {
    const cfg = buildDefaultConfig(["kb1"], candidatesByNode(), [llm()]);
    expect(cfg).not.toBeNull();
    expect(cfg!.kbIds).toEqual(["kb1"]);
    expect(cfg!.nodes.reply).toEqual({
      promptVersionId: "pv-reply",
      modelId: "m1",
      freedom: "balance",
      temperature: 0.7,
      topP: 0.9,
    });
    expect(cfg!.retrieval).toEqual({
      schemaVersion: 1,
      topK: 20,
      topN: 5,
      hybridEnabled: true,
      vectorWeight: 0.7,
      rerankEnabled: false,
    });
    expect(cfg!.fallback).toEqual({ toHuman: true });
  });

  it("无启用 llm → null", () => {
    expect(buildDefaultConfig(["kb1"], candidatesByNode(), [llm({ enabled: false })])).toBeNull();
  });

  it("某节点无候选 → null", () => {
    const c = candidatesByNode();
    c.intent = [];
    expect(buildDefaultConfig(["kb1"], c, [llm()])).toBeNull();
  });
});

describe("应用列表页", () => {
  it("标识列展示自定义锚点标签，是否上线列独立（M7b）", async () => {
    mocked.getApplications.mockResolvedValue([
      application(),
      application({
        id: "app2",
        name: "已上线应用",
        slug: "live-bot",
        productionVersion: 3,
        tags: ["qa20260707", "beta"],
      }),
    ]);
    renderRoutes("/admin/applications");
    expect(await screen.findByText("售后助手")).toBeInTheDocument();
    // 「是否上线」列：未上线应用 → 「未上线」，已上线 → 「已上线 · v3」
    expect(screen.getByText("未上线")).toBeInTheDocument();
    expect(screen.getByText("已上线 · v3")).toBeInTheDocument();
    // 「标识」列：展示自定义命名锚点（不再硬编码 production）
    expect(screen.getByText("qa20260707")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
  });

  it("点行导航到详情", async () => {
    renderRoutes("/admin/applications");
    fireEvent.click(await screen.findByText("售后助手"));
    await waitFor(() => expect(mocked.getApplicationDetail).toHaveBeenCalledWith("app1"));
  });
});

describe("新建应用抽屉", () => {
  const openDrawer = async () => {
    fireEvent.click(await screen.findByText("＋ 新建应用"));
    return screen.findByRole("dialog");
  };

  it("无知识库时禁用提交并提示先建知识库", async () => {
    mocked.getKnowledgeBases.mockResolvedValue([]);
    renderRoutes("/admin/applications");
    await openDrawer();
    expect(await screen.findByText(/请先到「知识库」创建/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /创建并配置/ })).toBeDisabled();
  });

  it("无启用 llm 模型时提示先启用模型", async () => {
    mocked.getModels.mockResolvedValue([llm({ enabled: false })]);
    renderRoutes("/admin/applications");
    await openDrawer();
    expect(await screen.findByText(/请先到「模型接入」启用一个 LLM 模型/)).toBeInTheDocument();
  });

  it("某节点无 Prompt 候选时提示先建 Prompt", async () => {
    mocked.getPromptNodeVersions.mockImplementation(async (node: PromptNode) =>
      node === "intent" ? [] : [candidate(node)],
    );
    renderRoutes("/admin/applications");
    await openDrawer();
    expect(
      await screen.findByText(/请先到「Prompt 管理」为 意图识别 创建 Prompt/),
    ).toBeInTheDocument();
  });

  it("填 name/slug + 选知识库后提交调 createApplication 并跳详情", async () => {
    mocked.createApplication.mockResolvedValue(detail({ id: "app9" }));
    mocked.getApplicationDetail.mockResolvedValue(detail({ id: "app9" }));
    renderRoutes("/admin/applications");
    const dialog = await openDrawer();
    fireEvent.change(await within(dialog).findByPlaceholderText("如：售后助手"), {
      target: { value: "新应用" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText(/aftersale-bot/), {
      target: { value: "new-bot" },
    });
    // 选知识库（chip，drawer 内唯一）
    fireEvent.click(within(dialog).getByText("售后知识库"));

    fireEvent.click(screen.getByRole("button", { name: /创建并配置/ }));
    await waitFor(() =>
      expect(mocked.createApplication).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: "new-bot",
          name: "新应用",
          config: expect.objectContaining({
            kbIds: ["kb1"],
            nodes: expect.objectContaining({
              reply: expect.objectContaining({ promptVersionId: "pv-reply", modelId: "m1" }),
            }),
          }),
        }),
      ),
    );
    await waitFor(() => expect(mocked.getApplicationDetail).toHaveBeenCalledWith("app9"));
  });
});

describe("应用详情骨架", () => {
  it("载入最新版本为编辑态，四节点卡与检索卡渲染", async () => {
    renderRoutes("/admin/applications/app1");
    expect(await screen.findByText("售后助手")).toBeInTheDocument();
    expect(screen.getByText(/正在编辑/)).toHaveTextContent("v1");
    expect(screen.getByText("问题改写")).toBeInTheDocument();
    expect(screen.getByText("回复生成")).toBeInTheDocument();
    expect(screen.getByText("检索设置")).toBeInTheDocument();
    expect(screen.getByText("还没上线")).toBeInTheDocument();
  });

  it("兜底话术节点只展示 Prompt，不展示模型及生成参数", async () => {
    renderRoutes("/admin/applications/app1");
    await screen.findByText("售后助手");
    const fallbackNode = screen.getByTestId("prompt-node-fallback");
    expect(within(fallbackNode).getByRole("combobox")).toBeInTheDocument();
    expect(within(fallbackNode).queryByText("模型")).not.toBeInTheDocument();
    expect(within(fallbackNode).queryByText("自由度")).not.toBeInTheDocument();
    expect(within(fallbackNode).queryByText("温度")).not.toBeInTheDocument();
    expect(within(fallbackNode).queryByText("Top P")).not.toBeInTheDocument();
  });

  it("「上线这个版本」启用并触发上线核对（M7b）", async () => {
    mocked.startApplicationReleaseCheck.mockResolvedValue({
      id: "rc1",
      applicationId: "app1",
      configVersionId: "appv1",
      configFingerprint: "fp",
      status: "passed",
      issues: [],
      sampleSummary: {
        rewrite: { ok: 10, total: 10 },
        intent: { ok: 10, total: 10 },
        reply: { ok: 1, total: 1 },
        fallback: { ok: 1, total: 1 },
      },
      startedAt: "2026-07-12T00:00:00.000Z",
      finishedAt: "2026-07-12T00:00:12.000Z",
      expiresAt: "2026-07-12T00:15:12.000Z",
      createdBy: "demo@codecrush.local",
      createdAt: "2026-07-12T00:00:00.000Z",
    });
    renderRoutes("/admin/applications/app1");
    const btn = await screen.findByRole("button", { name: /上线这个版本/ });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    // 触发异步 ReleaseCheck，核对弹窗出现，通过后可确认上线
    await waitFor(() =>
      expect(mocked.startApplicationReleaseCheck).toHaveBeenCalledWith("app1", "appv1"),
    );
    expect(await screen.findByText("上线前自动核对一遍")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /核对通过 · 上线/ })).toBeInTheDocument();
  });

  it("静态门禁失败时显示中文节点名和 Prompt 修复建议", async () => {
    mocked.startApplicationReleaseCheck.mockRejectedValue(
      new Error("reply 的 Prompt 存在编译错误，请前往 Prompt 试运行修复"),
    );
    renderRoutes("/admin/applications/app1");
    const btn = await screen.findByRole("button", { name: /上线这个版本/ });
    fireEvent.click(btn);

    expect(
      await screen.findByText("回复生成节点的 Prompt 存在编译错误，请前往 Prompt 试运行修复"),
    ).toBeInTheDocument();
  });

  it("改配置产生 dirty，保存调 createApplicationConfigVersion 并切到新版本", async () => {
    mocked.createApplicationConfigVersion.mockResolvedValue(version({ id: "appv2", version: 2 }));
    mocked.getApplicationDetail.mockResolvedValueOnce(detail()).mockResolvedValueOnce(
      detail({
        latestVersion: 2,
        versionCount: 2,
        versions: [version({ id: "appv2", version: 2 }), version()],
      }),
    );
    renderRoutes("/admin/applications/app1");
    await screen.findByText("售后助手");
    // 保存按钮初始禁用（无修改）
    const saveBtn = screen.getByRole("button", { name: /保存为新版本/ });
    expect(saveBtn).toBeDisabled();
    // 关掉「查不到答案时转人工」→ fallback.toHuman false → dirty（转人工是最后一个 Switch）
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[switches.length - 1]);
    await waitFor(() => expect(saveBtn).toBeEnabled());
    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(mocked.createApplicationConfigVersion).toHaveBeenCalledWith(
        "app1",
        expect.objectContaining({
          config: expect.objectContaining({ fallback: { toHuman: false } }),
        }),
      ),
    );
    expect(await screen.findByText(/正在编辑/)).toHaveTextContent("v2");
  });

  it("保存配置校验失败时显示简短中文业务提示，不展示结构化错误", async () => {
    mocked.createApplicationConfigVersion.mockRejectedValue(
      new Error(
        JSON.stringify([
          {
            code: "custom",
            path: ["config", "retrieval", "rerankModelId"],
            message: "启用模型精排后，请选择精排模型",
          },
        ]),
      ),
    );
    renderRoutes("/admin/applications/app1");
    await screen.findByText("售后助手");
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[switches.length - 1]);
    fireEvent.click(screen.getByRole("button", { name: /保存为新版本/ }));

    expect(await screen.findByText("启用模型精排后，请选择精排模型")).toBeInTheDocument();
    expect(screen.queryByText(/rerankModelId/)).not.toBeInTheDocument();
  });

  it("版本历史抽屉降序展示 + 服务中标记，点行载入编辑", async () => {
    mocked.getApplicationDetail.mockResolvedValue(
      detail({
        productionConfigVersionId: "appv1",
        productionVersion: 1,
        latestVersion: 2,
        versionCount: 2,
        versions: [version({ id: "appv2", version: 2 }), version()],
      }),
    );
    renderRoutes("/admin/applications/app1");
    fireEvent.click(await screen.findByText(/版本历史/));
    expect(await screen.findByTestId("history-version-1")).toBeInTheDocument();
    expect(screen.getByTestId("history-version-2")).toBeInTheDocument();
    // v1 是服务中版本
    expect(within(screen.getByTestId("history-version-1")).getByText("服务中")).toBeInTheDocument();
    // 点 v2 的「载入编辑」按钮
    fireEvent.click(within(screen.getByTestId("history-version-2")).getByText("载入编辑"));
    await waitFor(() => expect(screen.getByText(/正在编辑/)).toHaveTextContent("v2"));
  });

  it("运行对话测试生成公开聊天链接并在新页面打开", async () => {
    renderRoutes("/admin/applications/app1");
    const link = await screen.findByRole("link", { name: /运行对话测试/ });
    expect(link).toHaveAttribute("href", "/chat/aftersale-bot");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
