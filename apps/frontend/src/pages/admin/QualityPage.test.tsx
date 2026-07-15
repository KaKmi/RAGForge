import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    judgeModel: "qwen-plus",
    judgeVersion: "online-v1",
    status: "healthy" as const,
    lagSeconds: 60,
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
  expect(await screen.findByRole("dialog", { name: "在线评测设置" })).toBeInTheDocument();
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

it.each([
  ["healthy", "在线 LLM 裁判"],
  ["lagging", "评测滞后"],
  ["budget_reduced", "预算降采样"],
] as const)("renders %s status without discarding scores", async (status, label) => {
  vi.mocked(api.getQualityOverview).mockResolvedValue({
    ...baseOverview,
    meta: { ...baseOverview.meta, status },
  });
  renderQuality();
  expect(await screen.findByText(new RegExp(label.replaceAll(" ", "\\s*")))).toBeInTheDocument();
  expect(screen.getByText("92")).toBeInTheDocument();
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
  expect(screen.getByRole("combobox", { name: "应用" })).toHaveValue("agent-2");
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
  fireEvent.click(await screen.findByRole("button", { name: /事实一致性/ }));
  expect(screen.getByTestId("location")).toHaveTextContent("evalMetric=faithfulness");
  expect(screen.getByTestId("location")).toHaveTextContent("evalMax=80");

  renderQuality();
  expect(await screen.findByTestId("trend-point-insufficient")).toHaveStyle({ opacity: "0.35" });
  expect(screen.getAllByTestId("trend-series-faithfulness").length).toBeGreaterThan(0);
  expect(screen.getAllByTestId("trend-series-answerRelevancy").length).toBeGreaterThan(0);
  expect(screen.getAllByTestId("trend-series-contextPrecision").length).toBeGreaterThan(0);
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
  fireEvent.change(screen.getByRole("combobox", { name: "Judge 模型" }), {
    target: { value: "judge-new" },
  });
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
  expect(await screen.findByRole("combobox", { name: "Judge 模型" })).toHaveValue("");
  expect(screen.getByRole("combobox", { name: "Embedding 模型" })).toHaveValue("");
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
  expect(
    await screen.findByText("开启在线评测前，请选择可用的 Judge 与 Embedding 模型"),
  ).toBeInTheDocument();
  expect(api.updateOnlineEvalSettings).not.toHaveBeenCalled();
});
