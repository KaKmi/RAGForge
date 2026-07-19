import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  ApplicationConfigFields,
  ApplicationConfigVersion,
  ApplicationDetail,
  KnowledgeBase,
  ModelProvider,
  PromptNode,
  PromptNodeVersionCandidate,
  ReleaseCheck,
  ReleaseCheckIssue,
} from "@codecrush/contracts";
import ApplicationDetailPage from "./ApplicationDetailPage";
import * as client from "../../api/client";

/**
 * B1/F5：上线核对弹窗里**无 node 的门禁 issue** 的渲染与阻断语义。
 *
 * 单独成文件（不塞进 ApplicationsPage.test.tsx）：那份文件已经很大，
 * 且这里要反复构造不同 severity 的 ReleaseCheck，独立的 fixture 更清楚。
 */
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

const kb = (): KnowledgeBase =>
  ({
    id: "kb1",
    name: "售后知识库",
    description: "",
    embeddingModelId: "m-embed",
    activeVersion: 1,
    docCount: 1,
    chunkCount: 1,
    status: "ready",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  }) as unknown as KnowledgeBase;

const llm = (): ModelProvider =>
  ({
    id: "m-llm",
    name: "gpt",
    type: "llm",
    protocol: "openai",
    baseUrl: "http://x",
    enabled: true,
    params: {},
  }) as unknown as ModelProvider;

/** 字段与 PromptNodeVersionCandidateSchema 一一对应（漏 tags 会让下拉渲染时炸）。 */
const candidate = (node: PromptNode): PromptNodeVersionCandidate => ({
  promptId: `p-${node}`,
  promptName: `${node} prompt`,
  versionId: `pv-${node}`,
  version: 1,
  tags: [],
  compileStatus: "ok",
  createdAt: "2026-07-01T00:00:00.000Z",
});

const configFields = (): ApplicationConfigFields => ({
  kbIds: ["kb1"],
  nodes: {
    rewrite: { promptVersionId: "pv-rewrite", modelId: "m-llm", freedom: "balance", temperature: 0.7, topP: 0.9 },
    intent: { promptVersionId: "pv-intent", modelId: "m-llm", freedom: "balance", temperature: 0.7, topP: 0.9 },
    reply: { promptVersionId: "pv-reply", modelId: "m-llm", freedom: "balance", temperature: 0.7, topP: 0.9 },
    fallback: { promptVersionId: "pv-fallback", modelId: "m-llm", freedom: "balance", temperature: 0.7, topP: 0.9 },
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

const version = (): ApplicationConfigVersion => ({
  ...configFields(),
  id: "appv1",
  applicationId: "app1",
  version: 1,
  configSchemaVersion: 1,
  createdBy: "demo@codecrush.local",
  createdAt: "2026-07-10T08:00:00.000Z",
});

const detail = (): ApplicationDetail => ({
  id: "app1",
  slug: "aftersale-bot",
  name: "售后助手",
  description: "处理退换货咨询",
  enabled: true,
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
  versions: [version()],
});

const releaseCheck = (over: Partial<ReleaseCheck> = {}): ReleaseCheck => ({
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
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getApplicationDetail.mockResolvedValue(detail());
  mocked.getKnowledgeBases.mockResolvedValue([kb()]);
  mocked.getModels.mockResolvedValue([llm()]);
  mocked.getPromptNodeVersions.mockImplementation(async (node: PromptNode) => [candidate(node)]);
  mocked.listApplicationTags.mockResolvedValue([]);
});

/** 只渲染页面（不开弹窗），用于发布卡片本身的断言。 */
function renderPage(url = "/admin/applications/app1") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/admin/applications/:appId" element={<ApplicationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 走真实交互路径：点「上线这个版本」→ 触发 ReleaseCheck → 核对弹窗。 */
async function openReleaseModal(check: ReleaseCheck) {
  mocked.startApplicationReleaseCheck.mockResolvedValue(check);
  mocked.getApplicationReleaseCheck.mockResolvedValue(check);
  render(
    <MemoryRouter initialEntries={["/admin/applications/app1"]}>
      <Routes>
        <Route path="/admin/applications/:appId" element={<ApplicationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  const btn = await screen.findByRole("button", { name: /上线这个版本/ });
  fireEvent.click(btn);
  await screen.findByText("上线前自动核对一遍");
}

const GATE_WARNING: ReleaseCheckIssue = {
  code: "EVAL_GATE_REGRESSION",
  message: "存在 5 条回退用例",
  severity: "warning",
};

it("无 node 的门禁 warning 必须渲染出来，且不阻断上线", async () => {
  await openReleaseModal(releaseCheck({ status: "passed", issues: [GATE_WARNING] }));

  // 【本波最关键的一钉】节点卡片按 i.node === node 过滤，门禁 issue 没有 node，
  // 不单开区块就一条都显示不出来 —— 门禁做了等于没做。
  expect(await screen.findByText("存在 5 条回退用例")).toBeInTheDocument();
  expect(screen.getByText("评测提示（不阻断上线）")).toBeInTheDocument();

  // 软提示：确认上线按钮照常可用
  expect(await screen.findByRole("button", { name: /核对通过 · 上线/ })).toBeEnabled();
});

it("多条门禁 warning 全部列出", async () => {
  await openReleaseModal(
    releaseCheck({
      status: "passed",
      issues: [
        GATE_WARNING,
        {
          code: "EVAL_GATE_STALE_RUN",
          message: "最近一次对比评测已超过 24 小时，结论可能过时",
          severity: "warning",
        },
      ],
    }),
  );
  expect(await screen.findByText("存在 5 条回退用例")).toBeInTheDocument();
  expect(
    screen.getByText("最近一次对比评测已超过 24 小时，结论可能过时"),
  ).toBeInTheDocument();
});

/**
 * 【安全方向的回归钉，勿删】
 * 历史行的 severity 是 undefined（toReleaseCheck 手写映射，响应不过 Zod）。
 * 分区判据必须是排除法：undefined 落「阻断」一侧，渲染成 error 而不是「不阻断的提示」。
 */
it("severity 缺失的历史 issue 按阻断渲染，且不给确认上线按钮", async () => {
  await openReleaseModal(
    releaseCheck({
      status: "failed",
      expiresAt: null,
      issues: [{ code: "NO_KB", message: "至少需要一个知识库" }] as unknown as ReleaseCheckIssue[],
    }),
  );
  expect(await screen.findByText("至少需要一个知识库")).toBeInTheDocument();
  expect(screen.getByText("发布检查未通过")).toBeInTheDocument();
  // 不得被误渲染成「不阻断的提示」
  expect(screen.queryByText("评测提示（不阻断上线）")).not.toBeInTheDocument();
  // status=failed ⇒ 弹窗不给确认上线按钮
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /核对通过 · 上线/ })).not.toBeInTheDocument(),
  );
});

it("门禁 warning 与阻断 issue 并存时分区渲染，两块都在", async () => {
  await openReleaseModal(
    releaseCheck({
      status: "failed",
      expiresAt: null,
      issues: [
        GATE_WARNING,
        { code: "NO_KB", message: "至少需要一个知识库", severity: "error" },
      ],
    }),
  );
  expect(await screen.findByText("发布检查未通过")).toBeInTheDocument();
  expect(screen.getByText("评测提示（不阻断上线）")).toBeInTheDocument();
  expect(screen.getByText("至少需要一个知识库")).toBeInTheDocument();
  expect(screen.getByText("存在 5 条回退用例")).toBeInTheDocument();
});

it("无门禁 issue 时不渲染任何全局区块（不给空壳 Alert）", async () => {
  await openReleaseModal(releaseCheck({ status: "passed", issues: [] }));
  await screen.findByRole("button", { name: /核对通过 · 上线/ });
  expect(screen.queryByText("评测提示（不阻断上线）")).not.toBeInTheDocument();
  expect(screen.queryByText("发布检查未通过")).not.toBeInTheDocument();
});

// —— B1/F5：原型 `:621`「跳应用发布页，发布卡片显示评测摘要」——

it("URL 带 fromCompare 时，发布卡片显示评测摘要", async () => {
  renderPage("/admin/applications/app1?fromCompare=run-a_run-b&regressed=5&delta=3.6");
  expect(await screen.findByText("来自版本对比的评测结论")).toBeInTheDocument();
  expect(screen.getByText(/综合 Δ 3\.6 · 回退用例 5 条/)).toBeInTheDocument();
});

it("URL 无 fromCompare 时不显示评测摘要（不给空壳卡片）", async () => {
  renderPage();
  await screen.findByRole("button", { name: /上线这个版本/ });
  expect(screen.queryByText("来自版本对比的评测结论")).not.toBeInTheDocument();
});

/** NULL 不退化为 0：屏4 对 null delta 传空串，这里必须显示「—」而不是 0。 */
it("delta 为空（overallDelta 为 null）时显示「—」而非 0", async () => {
  renderPage("/admin/applications/app1?fromCompare=run-a_run-b&regressed=0&delta=");
  expect(await screen.findByText("来自版本对比的评测结论")).toBeInTheDocument();
  expect(screen.getByText(/综合 Δ — · 回退用例 0 条/)).toBeInTheDocument();
});
