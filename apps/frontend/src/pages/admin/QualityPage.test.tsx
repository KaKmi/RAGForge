import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { message } from "antd";
import * as api from "../../api/client";
import QualityPage from "./QualityPage";

vi.mock("../../api/client", () => ({
  getQualityOverview: vi.fn(),
  getOnlineEvalSettings: vi.fn(),
  updateOnlineEvalSettings: vi.fn(),
}));
vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  return { ...actual, message: { error: vi.fn(), success: vi.fn() } };
});

const metric = (value: number | null, sampleCount: number) => ({
  value,
  previousDelta: sampleCount < 20 ? null : 1,
  sampleCount,
  threshold: 80,
  low: value !== null && value < 80,
});
const baseOverview = {
  meta: {
    enabled: true,
    sampleRate: 0.1,
    evaluatedCount: 30,
    eligibleCount: 300,
    evaluableCount: 270,
    judgeModel: "qwen-plus",
    judgeVersion: "online-v1",
    status: "healthy" as const,
    backlog: 0,
  },
  metrics: {
    faithfulness: metric(92, 30),
    answerRelevancy: metric(88, 30),
    contextPrecision: metric(81, 30),
  },
  trend: [],
  byAgent: [],
  lowSamples: [],
};
const enabledSettings = {
  id: "default",
  enabled: true,
  sampleRate: 0.1,
  judgeModelId: "judge-1",
  embeddingModelId: "embed-1",
  faithfulnessThreshold: 85,
  answerRelevancyThreshold: 80,
  contextPrecisionThreshold: 80,
  dailyCap: 500,
  judgeVersion: "online-v1",
  updatedAt: "2026-07-15T02:00:00.000Z",
};
const settingsFixture = {
  settings: enabledSettings,
  models: {
    judges: [{ id: "judge-1", name: "Judge 1", enabled: true, available: true }],
    embeddings: [{ id: "embed-1", name: "Embedding 1", enabled: true, available: true }],
  },
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderQuality(entry = "/admin/quality?range=7d") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QualityPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

// antd Select 不是原生 <select>：mouseDown 打开下拉后，需等下拉门户渲染再点选项文本
async function chooseAntdOption(testId: string, optionText: string) {
  const combo = within(screen.getByTestId(testId)).getByRole("combobox");
  fireEvent.mouseDown(combo);
  fireEvent.click(await screen.findByText(optionText));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getQualityOverview).mockResolvedValue(baseOverview);
  vi.mocked(api.getOnlineEvalSettings).mockResolvedValue(settingsFixture);
  vi.mocked(api.updateOnlineEvalSettings).mockResolvedValue(settingsFixture);
});

it("renders disabled state and opens settings without hiding navigation", async () => {
  vi.mocked(api.getQualityOverview).mockResolvedValue({
    ...baseOverview,
    meta: { ...baseOverview.meta, enabled: false, status: "disabled" },
  });
  renderQuality();
  expect(await screen.findByText("在线评测未开启")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "去设置" }));
  expect(await screen.findByText("在线评测设置")).toBeInTheDocument();
});

it("marks n<20 as insufficient and hides deltas", async () => {
  vi.mocked(api.getQualityOverview).mockResolvedValue({
    ...baseOverview,
    metrics: {
      faithfulness: metric(92, 12),
      answerRelevancy: metric(88, 12),
      contextPrecision: metric(76, 12),
    },
  });
  renderQuality();
  expect(await screen.findAllByText("样本不足")).toHaveLength(3);
  expect(screen.queryByText(/▲|▼/)).not.toBeInTheDocument();
});

it("keeps previous data visible when refresh fails", async () => {
  vi.mocked(api.getQualityOverview)
    .mockResolvedValueOnce(baseOverview)
    .mockRejectedValueOnce(new Error("network"));
  renderQuality();
  expect(await screen.findByText("92")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /今\s*日/ }));
  expect(await screen.findByText("92")).toBeInTheDocument();
  await waitFor(() => expect(message.error).toHaveBeenCalled());
});

// worker 是独立进程（019）：没起来时屏1 是唯一的信号，不能和「在跑但落后」同形。
it("names a stalled worker instead of calling it lagging", async () => {
  vi.mocked(api.getQualityOverview).mockResolvedValue({
    ...baseOverview,
    meta: { ...baseOverview.meta, status: "worker_stalled" },
  });
  renderQuality();
  expect(await screen.findByText("评测 worker 未在运行")).toBeInTheDocument();
  expect(screen.getByText(/新问答不会被评分/)).toBeInTheDocument();
  expect(screen.queryByText("评测滞后")).not.toBeInTheDocument();
  expect(screen.getByText("92")).toBeInTheDocument();
});

it.each([
  ["healthy", "在线 LLM 裁判"],
  ["lagging", "评测滞后"],
  ["budget_reduced", "预算降采样"],
  ["worker_stalled", "评测 worker 未在运行"],
] as const)("renders %s status without discarding scores", async (status, label) => {
  vi.mocked(api.getQualityOverview).mockResolvedValue({
    ...baseOverview,
    meta: { ...baseOverview.meta, status },
  });
  renderQuality();
  expect(await screen.findByText(new RegExp(label.replaceAll(" ", "\\s*")))).toBeInTheDocument();
  expect(screen.getByText("92")).toBeInTheDocument();
});

// 缺口 20(a)：横幅曾写「已评测 30 / 可评测 300」，可 300 里绝大多数水位线已越过、永不会被评。
// 分母改称「窗口内」（与分子同窗口 ⇒ 可比的覆盖率），错过的量单列，不再伪装成待办。
it("separates the window total from what is still evaluable", async () => {
  vi.mocked(api.getQualityOverview).mockResolvedValue({
    ...baseOverview,
    meta: { ...baseOverview.meta, evaluatedCount: 0, eligibleCount: 32, evaluableCount: 1, backlog: 1 },
    metrics: {
      faithfulness: metric(null, 0),
      answerRelevancy: metric(null, 0),
      contextPrecision: metric(null, 0),
    },
  });
  renderQuality();
  expect(await screen.findByText(/已评测\s*0\s*\/\s*窗口内\s*32/)).toBeInTheDocument();
  expect(screen.getByText(/已错过\s*31/)).toBeInTheDocument();
  expect(screen.getByText(/待处理\s*1/)).toBeInTheDocument();
  expect(screen.queryByText(/可评测/)).not.toBeInTheDocument();
});

it("omits the missed count when the cursor has passed nothing", async () => {
  vi.mocked(api.getQualityOverview).mockResolvedValue({
    ...baseOverview,
    meta: { ...baseOverview.meta, evaluatedCount: 30, eligibleCount: 300, evaluableCount: 270 },
  });
  renderQuality();
  expect(await screen.findByText(/已评测\s*30\s*\/\s*窗口内\s*300/)).toBeInTheDocument();
  expect(screen.queryByText(/已错过/)).not.toBeInTheDocument();
});

it("renders zero-sample empty state", async () => {
  vi.mocked(api.getQualityOverview).mockResolvedValue({
    ...baseOverview,
    meta: { ...baseOverview.meta, evaluatedCount: 0 },
    metrics: {
      faithfulness: metric(null, 0),
      answerRelevancy: metric(null, 0),
      contextPrecision: metric(null, 0),
    },
  });
  renderQuality();
  expect(await screen.findByText("暂无评测样本")).toBeInTheDocument();
});

it("hydrates range and agent from URL and sends the translated query", async () => {
  renderQuality("/admin/quality?range=30d&agentId=agent-2");
  await waitFor(() =>
    expect(api.getQualityOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-2",
        from: expect.any(String),
        to: expect.any(String),
      }),
    ),
  );
  expect(screen.getByTestId("agent-filter")).toHaveTextContent("agent-2");
});

it("opens shareable Trace filters and low-sample quality detail", async () => {
  vi.mocked(api.getQualityOverview).mockResolvedValue({
    ...baseOverview,
    trend: [
      {
        bucket: "2026-07-15T01:00:00.000Z",
        faithfulness: 70,
        answerRelevancy: 80,
        contextPrecision: 90,
        sampleCount: 9,
        insufficientSample: true,
      },
    ],
    lowSamples: [
      {
        targetTraceId: "a".repeat(32),
        question: "退款多久",
        minMetric: "faithfulness" as const,
        minScore: 70,
        evidenceSummary: "第二条主张缺少依据",
      },
    ],
  });
  renderQuality();
  fireEvent.click(await screen.findByTestId("metric-faithfulness"));
  expect(screen.getByTestId("location")).toHaveTextContent("evalMetric=faithfulness");
  expect(screen.getByTestId("location")).toHaveTextContent("evalMax=80");

  renderQuality();
  expect(await screen.findByRole("img", { name: "三项质量指标趋势" })).toBeInTheDocument();
  fireEvent.click(screen.getAllByText("退款多久")[0]);
  expect(
    screen
      .getAllByTestId("location")
      .some((node) => node.textContent?.includes(`/admin/traces/${"a".repeat(32)}?panel=quality`)),
  ).toBe(true);
});

it("shows unavailable models, validates thresholds, saves, and refreshes", async () => {
  vi.mocked(api.getOnlineEvalSettings).mockResolvedValue({
    settings: { ...enabledSettings, judgeModelId: "judge-old" },
    models: {
      judges: [
        { id: "judge-old", name: "旧 Judge", enabled: false, available: false },
        { id: "judge-new", name: "新 Judge", enabled: true, available: true },
      ],
      embeddings: settingsFixture.models.embeddings,
    },
  });
  renderQuality();
  fireEvent.click(await screen.findByRole("button", { name: "设置" }));
  expect(await screen.findByText("旧 Judge（不可用）")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("事实一致性阈值"), { target: { value: "101" } });
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  expect(await screen.findByText("请输入 0–100 的整数")).toBeInTheDocument();
  expect(api.updateOnlineEvalSettings).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("事实一致性阈值"), { target: { value: "85" } });
  await chooseAntdOption("judge-select", "新 Judge");
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  await waitFor(() => expect(api.updateOnlineEvalSettings).toHaveBeenCalled());
  await waitFor(() => expect(api.getQualityOverview).toHaveBeenCalledTimes(2));
});

it("requires explicit available models before enabling online evaluation", async () => {
  vi.mocked(api.getOnlineEvalSettings).mockResolvedValue({
    settings: {
      ...enabledSettings,
      enabled: false,
      judgeModelId: null,
      embeddingModelId: null,
    },
    models: settingsFixture.models,
  });
  renderQuality();
  fireEvent.click(await screen.findByRole("button", { name: "设置" }));
  expect(await screen.findByTestId("judge-select")).toHaveTextContent("请选择 Judge 模型");
  expect(screen.getByTestId("embed-select")).toHaveTextContent("请选择 Embedding 模型");
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  expect(
    await screen.findByText("开启在线评测前，请选择可用的 Judge 与 Embedding 模型"),
  ).toBeInTheDocument();
  expect(api.updateOnlineEvalSettings).not.toHaveBeenCalled();
});
