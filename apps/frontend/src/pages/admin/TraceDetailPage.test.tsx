import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { TraceDetailResponse } from "@codecrush/contracts";
import TraceDetailPage from "./TraceDetailPage";
import * as client from "../../api/client";

vi.mock("../../api/client", () => ({ getTrace: vi.fn(), getTraceQuality: vi.fn() }));
const mocked = vi.mocked(client);

const detail: TraceDetailResponse = {
  traceId: "a".repeat(32),
  meta: {
    userInput: "怎么退款",
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
          { chunkId: "c1", doc: "退款政策 V3.2 · 第二条", vec: 0.9, kw: 0.1, rerank: 0.94, final: 0.9 },
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
  mocked.getTrace.mockResolvedValue(detail);
  mocked.getTraceQuality.mockResolvedValue({ status: "unscored" });
});

describe("TraceDetailPage (M9 W2)", () => {
  it("uses a wider responsive call-chain column", async () => {
    renderAt("a".repeat(32));
    expect(await screen.findByTestId("trace-call-chain")).toHaveStyle({ width: "34vw", minWidth: "560px", maxWidth: "680px" });
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

  it("has no replay button", async () => {
    renderAt("a".repeat(32));
    await screen.findByText("退款助手");
    expect(screen.queryByText(/重放/)).not.toBeInTheDocument();
  });

  it("keeps trace content when quality loading fails", async () => {
    mocked.getTraceQuality.mockRejectedValueOnce(new Error("quality unavailable"));
    renderAt("a".repeat(32));
    expect((await screen.findAllByText("怎么退款")).length).toBeGreaterThan(0);
    expect(await screen.findByText("质量数据暂不可用")).toBeInTheDocument();
  });

  it("renders unscored as read-only without score or retry actions", async () => {
    renderAt("a".repeat(32));
    expect(await screen.findByText("未抽样评测")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /立即评测|重试/ })).not.toBeInTheDocument();
  });
});
