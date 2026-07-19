import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { EvalCompareResponse, EvalGateStatus } from "@codecrush/contracts";
import EvalComparePage from "./EvalComparePage";
import * as client from "../../api/client";
import { EvalCompareIncomparableError } from "../../api/client";

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getEvalCompare: vi.fn(), getEvalRuns: vi.fn(), getEvalGate: vi.fn() };
});

const runSummary = {
  id: "run-a",
  setId: "set-1",
  setName: "售后核心",
  applicationId: "app-1",
  configVersionId: "cv-a",
  configVersionLabel: "v6",
  status: "done" as const,
  overallScore: 80,
  totalCases: 1,
  doneCases: 1,
  repeatCount: 1,
  durationMs: 1000,
  createdAt: "2026-07-13T09:00:00.000Z",
  judgeModelId: "judge-1",
  offlineJudgeVersion: "offline-v2",
  tokensUsed: 1000,
};

function makeResponse(over: Partial<EvalCompareResponse> = {}): EvalCompareResponse {
  return {
    a: runSummary,
    b: { ...runSummary, id: "run-b", configVersionLabel: "v7", overallScore: 84 },
    metrics: [
      { key: "faithfulness", a: 80, b: 84, delta: 4, significant: false },
      { key: "ndcg5", a: 81, b: 81, delta: 0, significant: false },
    ],
    latency: { aP95Ms: 1200, bP95Ms: 1100 },
    tokens: { aAvgPerCase: 600, bAvgPerCase: 620 },
    cases: [
      {
        caseId: "c1",
        seq: 1,
        question: "能开专票吗",
        a: { verdict: "pass", minScore: 82, scores: { faithfulness: 82 }, answer: "旧答案", traceId: "a".repeat(32) },
        b: { verdict: "weak", minScore: 61, scores: { faithfulness: 61 }, answer: "新答案", traceId: "b".repeat(32) },
        regressed: true,
        improved: false,
      },
    ],
    summary: {
      overallDelta: 4,
      improvedCount: 0,
      regressedCount: 1,
      flatCount: 0,
      excludedCount: 0,
      judgeMismatch: false,
    },
    ...over,
  };
}

/** 把当前 URL 暴露出来，供「跳发布页携带结论」的断言读取。 */
function LocationDisplay() {
  const loc = useLocation();
  return <div data-testid="location-display">{`${loc.pathname}${loc.search}`}</div>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <EvalComparePage />
      <LocationDisplay />
    </MemoryRouter>,
  );
}

/** B1/F5：门禁状态桩。默认「开关关 + 无 issue」＝既有用例的行为基线（按钮恒可点）。 */
function mockGate(over: Partial<EvalGateStatus> = {}) {
  vi.mocked(client.getEvalGate).mockResolvedValue({ enabled: false, issues: [], ...over });
}

const REGRESSION = {
  code: "EVAL_GATE_REGRESSION",
  message: "存在 5 条回退用例",
  severity: "warning" as const,
};
const NO_RUN = {
  code: "EVAL_GATE_NO_RUN",
  message: "该版本尚未与当前 production 做过对比评测",
  severity: "warning" as const,
};
const STALE = {
  code: "EVAL_GATE_STALE_RUN",
  message: "最近一次对比评测已超过 24 小时，结论可能过时",
  severity: "warning" as const,
};

beforeEach(() => {
  vi.mocked(client.getEvalRuns).mockResolvedValue([]);
  mockGate();
});

it("AC8-1：Δ 表渲染；significant:false → 「— 无显著差异」不给箭头", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  await screen.findByText("忠实度");
  // faithfulness Δ=4 但 significant=false → 无显著差异（无绿箭头）。
  expect(screen.getAllByText("— 无显著差异").length).toBeGreaterThan(0);
  expect(screen.queryByText("▲ +4")).not.toBeInTheDocument();
  // NDCG 显示两位小数。
  expect(screen.getAllByText("0.81").length).toBeGreaterThan(0);
});

it("结论横幅：Δ≥3 有变差 → 橙(warning) 文案含回退提示", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  await waitFor(() =>
    expect(screen.getByText(/综合 \+4 · 可上线，但注意 1 条用例回退/)).toBeInTheDocument(),
  );
});

it("结论横幅：Δ≤-3 → 红(不建议上线)", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(
    makeResponse({ summary: { overallDelta: -5, improvedCount: 0, regressedCount: 2, flatCount: 0, excludedCount: 0, judgeMismatch: false } }),
  );
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  await waitFor(() => expect(screen.getByText(/综合 -5 · 不建议上线/)).toBeInTheDocument());
});

it("|Δ|<3 → 灰(无显著差异)", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(
    makeResponse({ summary: { overallDelta: 1, improvedCount: 0, regressedCount: 0, flatCount: 1, excludedCount: 0, judgeMismatch: false } }),
  );
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  await waitFor(() => expect(screen.getByText(/综合 \+1 · 无显著差异/)).toBeInTheDocument());
});

it("AC8-2：题库版本集合不一致 → 红条 + 重跑基线按钮", async () => {
  vi.mocked(client.getEvalCompare).mockRejectedValue(new EvalCompareIncomparableError());
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  await screen.findByText("两次评测的题库版本不一致，结论不可比");
  expect(screen.getByRole("button", { name: "用当前题库重跑基线" })).toBeInTheDocument();
});

it("judgeMismatch → 灰字提示", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(
    makeResponse({ summary: { overallDelta: 4, improvedCount: 0, regressedCount: 1, flatCount: 0, excludedCount: 0, judgeMismatch: true } }),
  );
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  await screen.findByText("两次 run 的裁判模型不同，分数可比性弱");
});

it("延迟/Token 黄底行常显", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  await screen.findByText(/P95 延迟/);
  expect(screen.getByText(/每题均 Token/)).toBeInTheDocument();
});

it("缺 a/b → 选择器态", async () => {
  renderAt("/admin/eval/compare");
  expect(await screen.findByText("选择同一评测集的两个 run 进行对比")).toBeInTheDocument();
});

it("选择一侧后禁用另一评测集的 run", async () => {
  vi.mocked(client.getEvalRuns).mockResolvedValue([
    runSummary,
    { ...runSummary, id: "run-same-set", configVersionLabel: "v7" },
    { ...runSummary, id: "run-other-set", setId: "set-2", setName: "其他评测集" },
  ]);
  renderAt("/admin/eval/compare?a=run-a");

  const candidate = await screen.findByRole("combobox", { name: "候选 run" });
  fireEvent.mouseDown(candidate);
  expect(await screen.findByTitle("其他评测集 · v6")).toHaveAttribute("aria-disabled", "true");
});

// —— B1/F5：屏4「通过评测，去上线」按钮的门禁态（原型 §17.4 `:621`）——

it("门禁关：有回退也始终可点（原型 §17.4「门禁关:始终可点」）", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  mockGate({ enabled: false, issues: [REGRESSION] });
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  const btn = await screen.findByRole("button", { name: /通过评测，去上线/ });
  // 先确认门禁结论已到手，否则「初始就是可点」会让断言无意义
  await waitFor(() => expect(client.getEvalGate).toHaveBeenCalled());
  expect(btn).toBeEnabled();
});

it("门禁开 + 有回退：disabled 且给出原因「存在 5 条回退用例」", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  mockGate({ enabled: true, issues: [REGRESSION] });
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  const btn = await screen.findByRole("button", { name: /通过评测，去上线/ });
  await waitFor(() => expect(btn).toBeDisabled());
  // antd Tooltip 是浮层不是 title 属性；disabled 的 Button 不派发鼠标事件，
  // 故 hover 外包的 <span>（实现里正是为此包的这一层）。
  fireEvent.mouseEnter(btn.parentElement!);
  expect(await screen.findByText("存在 5 条回退用例")).toBeInTheDocument();
});

it("门禁开 + 无 issue：可点", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  mockGate({ enabled: true, issues: [] });
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  const btn = await screen.findByRole("button", { name: /通过评测，去上线/ });
  await waitFor(() => expect(client.getEvalGate).toHaveBeenCalled());
  expect(btn).toBeEnabled();
});

/**
 * 原型 §8（`:348`）：门禁条件是三项**合取**——「存在 24h 内的、对当前 production 的对比 run」
 * 且「综合 Δ≥0」且「变差数=0」，「否则发布按钮禁用并给原因」。
 * 故无对比 run / run 过期同样不满足条件，按钮同样 disabled（AC 30）。
 */
it("门禁开 + 无对比 run：disabled", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  mockGate({ enabled: true, issues: [NO_RUN] });
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /通过评测，去上线/ })).toBeDisabled(),
  );
});

it("门禁开 + 对比 run 过期：disabled", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  mockGate({ enabled: true, issues: [STALE] });
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /通过评测，去上线/ })).toBeDisabled(),
  );
});

/**
 * 前端取门禁失败也 fail-open：拿不到结论不拦，与后端同向。
 *
 * 断言必须有牙齿：初始态本来就是「可点」，直接断言可点的话，把整个 .catch 删掉
 * 也照样绿。故先确认门禁接口真的被调用过（即走到了 catch），再断言按钮可点。
 */
it("门禁接口失败 → 不拦（fail-open），按钮仍可点", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  vi.mocked(client.getEvalGate).mockRejectedValue(new Error("gate down"));
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  const btn = await screen.findByRole("button", { name: /通过评测，去上线/ });
  await waitFor(() => expect(client.getEvalGate).toHaveBeenCalled());
  expect(btn).toBeEnabled();
});

/** 原型 `:621`「跳发布页**携带结论**」——开/关两态都要带上评测摘要参数。 */
it("跳转 URL 携带评测结论（门禁关时同样携带）", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(makeResponse());
  mockGate({ enabled: false, issues: [REGRESSION] });
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  const btn = await screen.findByRole("button", { name: /通过评测，去上线/ });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.click(btn);
  await waitFor(() =>
    expect(screen.getByTestId("location-display").textContent).toContain("regressed=1"),
  );
});

/** NULL 不退化为 0：overallDelta 为 null 时 URL 传空串，绝不能传 0（0 会被读成「持平」）。 */
it("overallDelta 为 null → URL 带 delta= 空值而非 delta=0", async () => {
  vi.mocked(client.getEvalCompare).mockResolvedValue(
    makeResponse({
      summary: {
        overallDelta: null,
        improvedCount: 0,
        regressedCount: 0,
        flatCount: 1,
        excludedCount: 0,
        judgeMismatch: false,
      },
    }),
  );
  renderAt("/admin/eval/compare?a=run-a&b=run-b");
  const btn = await screen.findByRole("button", { name: /通过评测，去上线/ });
  await waitFor(() => expect(client.getEvalGate).toHaveBeenCalled());
  fireEvent.click(btn);
  await waitFor(() => {
    const url = screen.getByTestId("location-display").textContent ?? "";
    expect(url).toContain("delta=");
    expect(url).not.toContain("delta=0");
  });
});
