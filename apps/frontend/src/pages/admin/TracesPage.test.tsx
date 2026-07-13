import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SessionListRow, TraceListResponse, TraceListRow } from "@codecrush/contracts";
import TracesPage from "./TracesPage";
import * as client from "../../api/client";

vi.mock("../../api/client", () => ({
  getTraces: vi.fn(),
  getTraceSessions: vi.fn(),
  getApplications: vi.fn(),
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

function renderPage() {
  return render(
    <MemoryRouter>
      <TracesPage />
    </MemoryRouter>,
  );
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
});
