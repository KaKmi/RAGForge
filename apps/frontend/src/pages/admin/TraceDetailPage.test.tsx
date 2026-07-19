import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { TraceDetailResponse } from "@codecrush/contracts";
import TraceDetailPage from "./TraceDetailPage";
import * as client from "../../api/client";

vi.mock("../../api/client", () => ({
  getTrace: vi.fn(),
  getTraceQuality: vi.fn(),
  // B1/F2：「加入评测集」按钮两态的数据源；弹窗内部还会用到集列表与创建接口。
  getEvalCaseRefs: vi.fn(),
  getEvalSets: vi.fn(),
  createEvalCase: vi.fn(),
  createEvalSet: vi.fn(),
  // B1/F3：质量面板「立即评测」/「重试」的入队入口。
  scoreTraceNow: vi.fn(),
}));
const mocked = vi.mocked(client);

const detail: TraceDetailResponse = {
  traceId: "a".repeat(32),
  meta: {
    userInput: "怎么退款",
    agentId: "app-1",
    agentName: "退款助手",
    genModel: "deepseek-v3",
    genModelVersion: null,
    promptVersionId: "cv1",
    durationMs: 2410,
    inputTokens: 1200,
    outputTokens: 200,
    cost: null,
    status: "failed",
    qualitySignals: [],
  },
  spans: [
    {
      traceId: "a".repeat(32),
      spanId: "root".padEnd(16, "0"),
      parentSpanId: null,
      name: "rag.pipeline",
      kind: "chain",
      startTime: "2026-07-13T09:11:00.000Z",
      durationMs: 2410,
      statusCode: "Ok",
      statusMessage: null,
      attributes: {
        "codecrush.io.input": "怎么退款",
        "rag.citation.ids": JSON.stringify([{ n: 1, doc: "退款政策 V3.2", score: 0.94 }]),
      },
    },
    {
      traceId: "a".repeat(32),
      spanId: "ret".padEnd(16, "0"),
      parentSpanId: "root".padEnd(16, "0"),
      name: "retrieval.retrieve",
      kind: "retrieval",
      startTime: "2026-07-13T09:11:00.100Z",
      durationMs: 300,
      statusCode: "Error",
      statusMessage: "上游超时",
      attributes: {
        "rag.chunk.scores": JSON.stringify([
          {
            chunkId: "c1",
            doc: "退款政策 V3.2 · 第二条",
            vec: 0.9,
            kw: 0.1,
            rerank: 0.94,
            final: 0.9,
          },
        ]),
      },
    },
  ],
};

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/admin/traces/${id}`]}>
      <Routes>
        <Route path="/admin/traces/:traceId" element={<TraceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getTrace.mockResolvedValue(detail);
  mocked.getTraceQuality.mockResolvedValue({ status: "unscored" });
  mocked.getEvalCaseRefs.mockResolvedValue([]);
  mocked.getEvalSets.mockResolvedValue([]);
});

describe("TraceDetailPage (M9 W2)", () => {
  it("uses a wider responsive call-chain column", async () => {
    renderAt("a".repeat(32));
    expect(await screen.findByTestId("trace-call-chain")).toHaveStyle({
      width: "34vw",
      minWidth: "560px",
      maxWidth: "680px",
    });
  });
  it("renders head meta from real detail", async () => {
    renderAt("a".repeat(32));
    expect(await screen.findByText("退款助手")).toBeInTheDocument(); // Agent cell（唯一）
    expect(screen.getByText("deepseek-v3")).toBeInTheDocument();
    expect(screen.getAllByText("怎么退款").length).toBeGreaterThan(0); // 用户问题 + TRACE 根行
  });

  it("failed trace auto-selects the error span and shows error message", async () => {
    renderAt("a".repeat(32));
    // 错误信息出现在顶部置顶告警条 + 选中节点错误框（#4 降级/异常置顶）
    expect((await screen.findAllByText(/上游超时/)).length).toBeGreaterThan(0);
  });

  it("retrieval span shows hit-scores table with doc name", async () => {
    renderAt("a".repeat(32));
    expect(await screen.findByText(/退款政策 V3.2 · 第二条/)).toBeInTheDocument();
  });

  // E-W2b F7：头部新增「↻ 重放」按钮（原「无重放，M11」注记已随本波交付）。
  it("has a replay button (agentId present)", async () => {
    renderAt("a".repeat(32));
    await screen.findByText("退款助手");
    expect(screen.getByRole("button", { name: "↻ 重放" })).toBeEnabled();
  });

  it("keeps trace content when quality loading fails", async () => {
    mocked.getTraceQuality.mockRejectedValueOnce(new Error("quality unavailable"));
    renderAt("a".repeat(32));
    expect((await screen.findAllByText("怎么退款")).length).toBeGreaterThan(0);
    expect(await screen.findByText("质量数据暂不可用")).toBeInTheDocument();
  });

  /**
   * B1/F3 起，未评态**不再**是只读的：原型 §17.6 明确「E-W1 只读三态，不显示操作按钮；
   * **E-W2 再增加立即评测、评分中轮询与重试**」。本用例原先断言「无立即评测/重试按钮」，
   * 那是 E-W1 的契约，已由本波按原型有意取代——故改为断言「有立即评测、无重试」
   * （重试只属失败态），而不是把断言删掉。
   */
  it("renders unscored with 立即评测 but no 重试 (E-W2)", async () => {
    renderAt("a".repeat(32));
    expect(await screen.findByText("未抽样评测")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即评测" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重\s*试/ })).not.toBeInTheDocument();
  });

  it("renders partial scored quality with neutral unscored faithfulness", async () => {
    mocked.getTraceQuality.mockResolvedValueOnce({
      status: "scored",
      scores: { faithfulness: null, answerRelevancy: 80, contextPrecision: 70 },
      thresholds: { faithfulness: 85, answerRelevancy: 80, contextPrecision: 80 },
      judgeModel: "judge-1",
      judgeVersion: "online-v2",
      scoredAt: "2026-07-15T02:00:00.000Z",
      currentVersion: true,
      evidence: {
        answerRelevancy: ["relevant"],
        contextPrecision: ["one noisy chunk"],
      },
    });
    renderAt("a".repeat(32));

    expect(await screen.findByText("未评")).toBeInTheDocument();
    expect(screen.getByTestId("quality-score-faithfulness")).toHaveAttribute(
      "data-quality-state",
      "unscored",
    );
  });

  it("keeps complete scored quality pass and low states", async () => {
    mocked.getTraceQuality.mockResolvedValueOnce({
      status: "scored",
      scores: { faithfulness: 90, answerRelevancy: 80, contextPrecision: 70 },
      thresholds: { faithfulness: 85, answerRelevancy: 80, contextPrecision: 80 },
      judgeModel: "judge-1",
      judgeVersion: "online-v2",
      scoredAt: "2026-07-15T02:00:00.000Z",
      currentVersion: true,
      evidence: {
        faithfulness: ["grounded"],
        answerRelevancy: ["relevant"],
        contextPrecision: ["one noisy chunk"],
      },
    });
    renderAt("a".repeat(32));

    await screen.findByText("90");
    expect(screen.getByTestId("quality-score-faithfulness")).toHaveAttribute(
      "data-quality-state",
      "pass",
    );
    expect(screen.getByTestId("quality-score-contextPrecision")).toHaveAttribute(
      "data-quality-state",
      "low",
    );
  });
});

// —— B1/F2：「加入评测集」按钮两态（原型 §17.6 `:647`）——

it("未入集 → 显示「+ 加入评测集」，点击开弹窗", async () => {
  mocked.getEvalCaseRefs.mockResolvedValue([]);
  renderAt("a".repeat(32));
  const btn = await screen.findByRole("button", { name: "+ 加入评测集" });
  fireEvent.click(btn);
  expect(await screen.findByText("加入评测集")).toBeInTheDocument();
  expect(screen.getByPlaceholderText("留空则进集后为待补 gold")).toBeInTheDocument();
});

it("已入集 → 按钮变「已在评测集 · 查看」，不再显示加入按钮", async () => {
  mocked.getEvalCaseRefs.mockResolvedValue([
    { setId: "s1", setName: "售后核心 50 题", caseId: "c1" },
  ]);
  renderAt("a".repeat(32));
  expect(await screen.findByRole("button", { name: "已在评测集 · 查看" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "+ 加入评测集" })).not.toBeInTheDocument();
});

/** 读 case-refs 失败不能把按钮弄没——退回「未入集」态，用户仍可尝试入集（后端会真实校验）。 */
it("case-refs 读取失败 → 退回「+ 加入评测集」态", async () => {
  mocked.getEvalCaseRefs.mockRejectedValue(new Error("boom"));
  renderAt("a".repeat(32));
  expect(await screen.findByRole("button", { name: "+ 加入评测集" })).toBeInTheDocument();
});

/** AC10 的真正路径：入集成功后按钮当场切态（不只是两个静态态各自渲染正确）。 */
it("入集成功后按钮当场切成「已在评测集 · 查看」", async () => {
  mocked.getEvalCaseRefs.mockResolvedValue([]);
  mocked.getEvalSets.mockResolvedValue([{ id: "set-1", name: "售后核心 50 题" } as never]);
  mocked.createEvalCase.mockResolvedValue({ id: "case-1" } as never);
  renderAt("a".repeat(32));

  fireEvent.click(await screen.findByRole("button", { name: "+ 加入评测集" }));
  await screen.findByPlaceholderText("留空则进集后为待补 gold");

  fireEvent.mouseDown(screen.getByRole("combobox"));
  await screen.findByRole("option", { name: "售后核心 50 题" });
  const dropdown = document.querySelector(".ant-select-dropdown") as HTMLElement;
  fireEvent.click(within(dropdown).getByText("售后核心 50 题"));

  // 重取返回空数组：按钮仍必须切态（乐观置位兜底），否则用户会重复入集
  mocked.getEvalCaseRefs.mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: /确认加入/ }));
  await waitFor(() => expect(mocked.createEvalCase).toHaveBeenCalled());

  expect(await screen.findByRole("button", { name: "已在评测集 · 查看" })).toBeInTheDocument();
});

/** 问题为空的 trace 入不了集，按钮直接禁用并给原因。 */
it("trace 无用户问题 → 「+ 加入评测集」禁用", async () => {
  mocked.getEvalCaseRefs.mockResolvedValue([]);
  mocked.getTrace.mockResolvedValue({ ...detail, meta: { ...detail.meta, userInput: "" } });
  renderAt("a".repeat(32));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "+ 加入评测集" })).toBeDisabled(),
  );
});

// === B1/F3：质量面板四态（原型 §18.D 状态机 + 补充状态示例 :659-660）===

const TID = "a".repeat(32);

it("未评态显示「立即评测」按钮", async () => {
  mocked.getTraceQuality.mockResolvedValue({ status: "unscored" });
  renderAt(TID);
  expect(await screen.findByRole("button", { name: "立即评测" })).toBeInTheDocument();
});

it("点「立即评测」后进入评分中，文案逐字「裁判评分中…（约 30s）」", async () => {
  mocked.getTraceQuality.mockResolvedValue({ status: "unscored" });
  mocked.scoreTraceNow.mockResolvedValue({ status: "scoring" });
  renderAt(TID);
  fireEvent.click(await screen.findByRole("button", { name: "立即评测" }));
  expect(await screen.findByText("● 裁判评分中…（约 30s）")).toBeInTheDocument();
  expect(mocked.scoreTraceNow).toHaveBeenCalledWith(TID);
});

/**
 * 后端说 `scored`（该 trace 已有当前判分版本的分数）时**不能**进轮询：
 * 那会白等 5s 才显示一个早就拿得到的分数。必须立即重取详情。
 */
it("「立即评测」返回 scored → 不进轮询，直接重取详情", async () => {
  mocked.getTraceQuality.mockResolvedValue({ status: "unscored" });
  mocked.scoreTraceNow.mockResolvedValue({ status: "scored" });
  renderAt(TID);
  fireEvent.click(await screen.findByRole("button", { name: "立即评测" }));

  await waitFor(() => expect(mocked.getTraceQuality).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("● 裁判评分中…（约 30s）")).not.toBeInTheDocument();
});

it("评分中每 5s 轮询，6 次仍未出结果则转失败态", async () => {
  vi.useFakeTimers();
  try {
    mocked.getTraceQuality.mockResolvedValue({ status: "scoring", startedAt: null });
    renderAt(TID);
    // 先冲掉首次加载那一发，轮询 effect 才真正挂上；否则第一拍会被挂载时序吃掉。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 首次加载 1 次 + 轮询 6 次
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    }
    expect(mocked.getTraceQuality).toHaveBeenCalledTimes(7);
    expect(screen.getByText("裁判调用失败")).toBeInTheDocument();

    // 到顶后必须停表：再推进时间不得继续打接口（否则是一个永不停歇的轮询泄漏）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(mocked.getTraceQuality).toHaveBeenCalledTimes(7);
  } finally {
    vi.useRealTimers();
  }
});

/** 轮询期间后端出了分数 → 立刻停表并渲染三分，不该继续轮询到 6 次上限。 */
it("轮询中拿到 scored → 停表并显示分数", async () => {
  vi.useFakeTimers();
  try {
    mocked.getTraceQuality.mockResolvedValue({ status: "scoring", startedAt: null });
    renderAt(TID);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    mocked.getTraceQuality.mockResolvedValue({
      status: "scored",
      scores: { faithfulness: 91, answerRelevancy: 88, contextPrecision: 84 },
      thresholds: { faithfulness: 85, answerRelevancy: 80, contextPrecision: 80 },
      judgeModel: "judge-1",
      judgeVersion: "online-v2",
      scoredAt: "2026-07-18T00:00:00.000Z",
      currentVersion: true,
      evidence: { answerRelevancy: ["relevant"], contextPrecision: ["rank 1"] },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const callsAtScored = mocked.getTraceQuality.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(mocked.getTraceQuality).toHaveBeenCalledTimes(callsAtScored);
    expect(screen.queryByText("● 裁判评分中…（约 30s）")).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("失败态显示「裁判调用失败」与「重试」按钮，点击重新入队", async () => {
  mocked.getTraceQuality.mockResolvedValue({
    status: "failed",
    judgeVersion: "online-v2",
    failedAt: "2026-07-18T00:00:00.000Z",
    reason: "judge timeout",
    currentVersion: true,
  });
  mocked.scoreTraceNow.mockResolvedValue({ status: "scoring" });
  renderAt(TID);
  expect(await screen.findByText("裁判调用失败")).toBeInTheDocument();
  // antd 会在两个汉字的按钮文案中间自动插空格（「重试」→「重 试」），同 Popconfirm 的「确 定」。
  fireEvent.click(await screen.findByRole("button", { name: /重\s*试/ }));
  await waitFor(() => expect(mocked.scoreTraceNow).toHaveBeenCalledWith(TID));
});

/** 已评态是终态：不得出现「立即评测」，否则用户会重复触发一次无谓的判分。 */
it("已评态不显示「立即评测」", async () => {
  mocked.getTraceQuality.mockResolvedValue({
    status: "scored",
    scores: { faithfulness: 91, answerRelevancy: 88, contextPrecision: 84 },
    thresholds: { faithfulness: 85, answerRelevancy: 80, contextPrecision: 80 },
    judgeModel: "judge-1",
    judgeVersion: "online-v2",
    scoredAt: "2026-07-18T00:00:00.000Z",
    currentVersion: true,
    evidence: { answerRelevancy: ["relevant"], contextPrecision: ["rank 1"] },
  });
  renderAt(TID);
  await screen.findByTestId("quality-score-faithfulness");
  expect(screen.queryByRole("button", { name: "立即评测" })).not.toBeInTheDocument();
});
