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
  productionVersion: null,
  productionConfigVersionId: null,
  latestVersion: 1,
  versionCount: 1,
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
  it("未上线态显示「未上线」，服务中态显示「● 服务中 · vN」", async () => {
    mocked.getApplications.mockResolvedValue([
      application(),
      application({ id: "app2", name: "已上线应用", slug: "live-bot", productionVersion: 3 }),
    ]);
    renderRoutes("/admin/applications");
    expect(await screen.findByText("售后助手")).toBeInTheDocument();
    expect(screen.getByText("未上线")).toBeInTheDocument();
    expect(screen.getByText("● 服务中 · v3")).toBeInTheDocument();
  });

  it("点行导航到详情", async () => {
    renderRoutes("/admin/applications");
    fireEvent.click(await screen.findByText("售后助手"));
    await waitFor(() => expect(mocked.getApplicationDetail).toHaveBeenCalledWith("app1"));
  });
});

describe("新建应用弹窗", () => {
  it("无知识库时禁用提交并提示先建知识库", async () => {
    mocked.getKnowledgeBases.mockResolvedValue([]);
    renderRoutes("/admin/applications");
    fireEvent.click(await screen.findByText("＋ 新建应用"));
    expect(await screen.findByText(/请先到「知识库」创建/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /创建并配置/ })).toBeDisabled();
  });

  it("无启用 llm 模型时提示先启用模型", async () => {
    mocked.getModels.mockResolvedValue([llm({ enabled: false })]);
    renderRoutes("/admin/applications");
    fireEvent.click(await screen.findByText("＋ 新建应用"));
    expect(await screen.findByText(/请先到「模型接入」启用一个 LLM 模型/)).toBeInTheDocument();
  });

  it("某节点无 Prompt 候选时提示先建 Prompt", async () => {
    mocked.getPromptNodeVersions.mockImplementation(async (node: PromptNode) =>
      node === "intent" ? [] : [candidate(node)],
    );
    renderRoutes("/admin/applications");
    fireEvent.click(await screen.findByText("＋ 新建应用"));
    expect(await screen.findByText(/请先到「Prompt 管理」为 意图识别 创建 Prompt/)).toBeInTheDocument();
  });

  it("填 slug/name + 选知识库后提交调 createApplication 并跳详情", async () => {
    mocked.createApplication.mockResolvedValue(detail({ id: "app9" }));
    mocked.getApplicationDetail.mockResolvedValue(detail({ id: "app9" }));
    renderRoutes("/admin/applications");
    fireEvent.click(await screen.findByText("＋ 新建应用"));
    // 引用数据加载完成后表单出现
    fireEvent.change(await screen.findByPlaceholderText("如：aftersale-bot"), {
      target: { value: "new-bot" },
    });
    fireEvent.change(screen.getByPlaceholderText("如：售后助手"), {
      target: { value: "新应用" },
    });
    // 选知识库（antd 多选）
    const kbSelect = screen.getByText("选择该应用检索的知识库（必选，至少一个）");
    fireEvent.mouseDown(kbSelect);
    fireEvent.click(await screen.findByText("售后知识库"));

    fireEvent.click(screen.getByRole("button", { name: /创建并配置/ }));
    await waitFor(() =>
      expect(mocked.createApplication).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: "new-bot",
          name: "新应用",
          config: expect.objectContaining({ kbIds: ["kb1"] }),
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

  it("「上线这个版本」禁用（M7b）", async () => {
    renderRoutes("/admin/applications/app1");
    const btn = await screen.findByRole("button", { name: /上线这个版本/ });
    expect(btn).toBeDisabled();
  });

  it("改自由度产生 dirty，保存调 createApplicationConfigVersion 并切到新版本", async () => {
    mocked.createApplicationConfigVersion.mockResolvedValue(version({ id: "appv2", version: 2 }));
    mocked.getApplicationDetail
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(
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
    // reply 卡自由度切到「精确」→ 温度/TopP 变化 → dirty
    const replyCard = screen.getByText("回复生成").closest("div")!.parentElement!;
    fireEvent.click(within(replyCard).getByText("精确"));
    await waitFor(() => expect(saveBtn).toBeEnabled());
    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(mocked.createApplicationConfigVersion).toHaveBeenCalledWith(
        "app1",
        expect.objectContaining({
          config: expect.objectContaining({
            nodes: expect.objectContaining({
              reply: expect.objectContaining({ freedom: "precise", temperature: 0.2, topP: 0.6 }),
            }),
          }),
        }),
      ),
    );
    expect(await screen.findByText(/正在编辑/)).toHaveTextContent("v2");
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
    // 点 v2 载入编辑
    fireEvent.click(screen.getByTestId("history-version-2"));
    await waitFor(() => expect(screen.getByText(/正在编辑/)).toHaveTextContent("v2"));
  });

  it("对话测试骨架返回 unavailable → 渲染 M8 占位", async () => {
    renderRoutes("/admin/applications/app1");
    fireEvent.click(await screen.findByRole("button", { name: /运行对话测试/ }));
    expect(await screen.findByText("真实按版本对话测试将随 M8 编排上线")).toBeInTheDocument();
    expect(mocked.tryApplicationVersionChat).toHaveBeenCalledWith("app1", "appv1");
  });
});
