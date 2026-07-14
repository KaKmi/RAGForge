import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import type { SessionListRow, TraceListResponse, TraceListRow } from "@codecrush/contracts";
import TracesPage from "./TracesPage";
import * as client from "../../api/client";

vi.mock("../../api/client", () => ({
  getTraces: vi.fn(),
  getTraceSessions: vi.fn(),
  getApplications: vi.fn(),
  downloadTraceCandidates: vi.fn(),
}));

const mocked = vi.mocked(client);

const traceRow = (over: Partial<TraceListRow> = {}): TraceListRow => ({
  traceId: "a".repeat(32),
  sessionId: "conv1",
  agentId: "app1",
  agentName: "退款助手",
  userId: "u1",
  userInput: "怎么退款",
  status: "success",
  startTime: "2026-07-13T09:11:00.000Z",
  durationMs: 2410,
  inputTokens: 1200,
  outputTokens: 200,
  qualitySignals: ["no_citations"],
  promptVersionId: null,
  ...over,
});

const resp = (items: TraceListRow[]): TraceListResponse => ({
  items,
  total: items.length,
  summary: { sampledTotal: items.length, failRate: 0, failCount: 0, p95Ms: 2410, timeoutCount: 0 },
});

const sessionRow: SessionListRow = {
  sessionId: "conv1",
  userId: "u1",
  agentId: "app1",
  agentName: "退款助手",
  roundCount: 3,
  firstQuestion: "怎么退款",
  firstTs: "2026-07-13T09:11:00.000Z",
  lastTs: "2026-07-13T09:20:00.000Z",
  status: "has_fallback",
};

beforeEach(() => {
  mocked.getApplications.mockResolvedValue([]);
  mocked.getTraces.mockResolvedValue(resp([traceRow()]));
  mocked.getTraceSessions.mockResolvedValue([sessionRow]);
});

function renderPage(initialEntry = "/admin/traces") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TracesPage />
    </MemoryRouter>,
  );
}

function NavigateTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>navigate-test</button>;
}

describe("TracesPage (M9 W1)", () => {
  it("renders real trace rows with quality-signal tags and agent name", async () => {
    renderPage();
    expect(await screen.findByText("怎么退款")).toBeInTheDocument();
    expect(screen.getByText("退款助手")).toBeInTheDocument();
    expect(screen.getByText("无引用")).toBeInTheDocument(); // no_citations → 无引用
    expect(mocked.getTraces).toHaveBeenCalled();
  });

  it("switching to Session segment renders the session list", async () => {
    renderPage();
    await screen.findByText("怎么退款");
    fireEvent.click(screen.getByText("Session · 会话"));
    expect(await screen.findByText("3 轮")).toBeInTheDocument();
    expect(screen.getByText("含兜底")).toBeInTheDocument(); // has_fallback → 含兜底
    expect(mocked.getTraceSessions).toHaveBeenCalled();
  });

  it("shows empty state when no traces", async () => {
    mocked.getTraces.mockResolvedValueOnce(resp([]));
    renderPage();
    expect(await screen.findByText("没有符合条件的 Trace")).toBeInTheDocument();
  });

  it("keeps dashboard drill-down filters in the first trace request", async () => {
    renderPage("/admin/traces?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-08T00%3A00%3A00.000Z&agentId=app1&status=%E5%85%9C%E5%BA%95");
    await screen.findByText("怎么退款");
    expect(mocked.getTraces).toHaveBeenCalledWith(expect.objectContaining({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-08T00:00:00.000Z",
      agentId: "app1",
      status: "兜底",
    }));
  });

  it("hydrates the supported low-recall quick filter from the URL", async () => {
    renderPage("/admin/traces?quick=%E4%BD%8E%E5%88%86%E5%8F%AC%E5%9B%9E");
    await screen.findByText("怎么退款");
    expect(mocked.getTraces).toHaveBeenCalledWith(
      expect.objectContaining({ quick: "低分召回" }),
    );
  });

  it("hydrates an exact stage filter from the URL", async () => {
    renderPage("/admin/traces?agentId=app1&stage=rerank");
    expect(await screen.findByText("阶段筛选：重排")).toBeInTheDocument();
    expect(mocked.getTraces).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "app1", stage: "rerank" }),
    );
  });

  it("hydrates signal and model filters from dashboard drill-down", async () => {
    renderPage("/admin/traces?agentId=app1&signal=repair&model=deepseek-chat");
    expect(await screen.findByText(/信号筛选：发生结构化修复/)).toBeInTheDocument();
    expect(screen.getByText(/模型：deepseek-chat/)).toBeInTheDocument();
    expect(mocked.getTraces).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "app1", signal: "repair", model: "deepseek-chat" }),
    );
    expect(screen.getByRole("button", { name: /导出当前候选样本 CSV/ })).toBeInTheDocument();
  });

  it("reset clears URL-derived filters and their fixed time range", async () => {
    renderPage("/admin/traces?agentId=app1&signal=repair&from=2026-07-01T00%3A00%3A00.000Z");
    await vi.waitFor(() => expect(mocked.getTraces).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "app1", signal: "repair", from: "2026-07-01T00:00:00.000Z" }),
    ));
    fireEvent.click(screen.getByText("重置"));
    await vi.waitFor(() => {
      const last = mocked.getTraces.mock.calls.at(-1)?.[0];
      expect(last?.agentId).toBeUndefined();
      expect(last?.signal).toBeUndefined();
      expect(last?.from).not.toBe("2026-07-01T00:00:00.000Z");
    });
  });

  it("rehydrates exact filters after client-side navigation", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/traces"]}>
        <NavigateTo to="/admin/traces?agentId=app2&signal=rerank_degraded" />
        <TracesPage />
      </MemoryRouter>,
    );
    await screen.findByText("怎么退款");
    fireEvent.click(screen.getByText("navigate-test"));
    await vi.waitFor(() => expect(mocked.getTraces).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "app2", signal: "rerank_degraded" }),
    ));
  });

  it("ignores an unknown signal instead of sending an untyped filter", async () => {
    renderPage("/admin/traces?signal=not-a-signal");
    /*
    await screen.findByText("鎬庝箞閫€娆?);
    */
    await vi.waitFor(() => expect(mocked.getTraces).toHaveBeenCalled());
    expect(mocked.getTraces).toHaveBeenCalledWith(
      expect.objectContaining({ signal: undefined }),
    );
  });
});
