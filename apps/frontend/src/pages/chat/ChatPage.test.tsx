import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import type { ChatStreamEvent } from "@codecrush/contracts";
import ChatPage from "./ChatPage";
import * as client from "../../api/client";
import * as sse from "../../api/sse";

/** M8 T4：C 端问答页接真实 SSE 流。mock openChatStream（网络边界）+ api client，
 * 断言逐 token 渲染、行内角标 ⇄ 右栏真实正文、可信度/兜底、未上线占位。 */

function renderAt(slug = "aftersale") {
  return render(
    <MemoryRouter initialEntries={[`/chat/${slug}`]}>
      <Routes>
        <Route path="/chat/:agentId" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function* stream(evs: ChatStreamEvent[]) {
  for (const e of evs) yield e;
}

beforeEach(() => {
  localStorage.setItem("token", "tok");
  vi.spyOn(client, "getApplications").mockResolvedValue([
    {
      id: "app1",
      slug: "aftersale",
      name: "售后助手",
      description: "退款换课",
      productionConfigVersionId: "v1",
    },
  ] as unknown as Awaited<ReturnType<typeof client.getApplications>>);
  vi.spyOn(client, "getApplicationDetail").mockResolvedValue({
    id: "app1",
    productionConfigVersionId: "v1",
    versions: [{ id: "v1", kbIds: ["kb1"] }],
  } as unknown as Awaited<ReturnType<typeof client.getApplicationDetail>>);
  vi.spyOn(client, "getKnowledgeBases").mockResolvedValue([
    { id: "kb1", name: "售后库" },
  ] as unknown as Awaited<ReturnType<typeof client.getKnowledgeBases>>);
  vi.spyOn(client, "getConversations").mockResolvedValue([]);
  vi.spyOn(client, "getMessages").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it("逐 token 渲染回答 + citation 填右栏 + done 可信度 + 角标点开原文", async () => {
  vi.spyOn(sse, "openChatStream").mockImplementation(() =>
    stream([
      {
        type: "citation",
        citation: {
          n: 1,
          doc: "退款政策",
          kb: "售后库",
          section: "第二条 · 七天无理由退款",
          score: 0.86,
          text: "自购买之日起7个自然日内可申请全额退款",
        },
      },
      { type: "token", delta: "支持七天无理由退款" },
      { type: "token", delta: "[1]。" },
      { type: "done", traceId: "t1", convId: "c1", confidence: 0.86, coverage: "full", isFallback: false, fallbackReasons: [] },
    ]),
  );
  renderAt();

  const input = await screen.findByPlaceholderText(/输入您的问题/);
  fireEvent.change(input, { target: { value: "能退款吗" } });
  fireEvent.click(await screen.findByRole("button", { name: /发\s*送/ }));

  expect(screen.getByText("能退款吗")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText(/支持七天无理由退款/)).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText(/可信度.*86%/)).toBeInTheDocument());
  expect(screen.getByText(/引用完整/)).toBeInTheDocument();

  // 角标点击 → 右栏命中正文（内联角标为 DOM 首个「1」，中栏在右栏之前）
  fireEvent.click(screen.getAllByText("1")[0]);
  await waitFor(() =>
    expect(screen.getByText(/自购买之日起7个自然日内可申请全额退款/)).toBeInTheDocument(),
  );
});

it("兜底 done 显兜底卡、无可信度徽标", async () => {
  vi.spyOn(sse, "openChatStream").mockImplementation(() =>
    stream([
      { type: "token", delta: "这个问题超出我的知识范围。" },
      {
        type: "done",
        traceId: "t2",
        convId: "c2",
        coverage: "partial",
        isFallback: true,
        fallbackReasons: ["out_of_scope", "handled_by_fallback"],
      },
    ]),
  );
  renderAt();

  fireEvent.change(await screen.findByPlaceholderText(/输入您的问题/), {
    target: { value: "你老板是谁" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /发\s*送/ }));

  await waitFor(() => expect(screen.getByText(/未在知识库中找到匹配内容/)).toBeInTheDocument());
  expect(screen.getByText("超出范围")).toBeInTheDocument();
  expect(screen.queryByText(/可信度/)).not.toBeInTheDocument();
});

it("低置信度回答显黄条提示", async () => {
  vi.spyOn(sse, "openChatStream").mockImplementation(() =>
    stream([
      { type: "citation", citation: { n: 1, doc: "d", kb: "售后库", section: "s", score: 0.5, text: "x" } },
      { type: "token", delta: "大概是这样[1]" },
      { type: "done", traceId: "t3", convId: "c3", confidence: 0.6, coverage: "partial", isFallback: false, fallbackReasons: [] },
    ]),
  );
  renderAt();

  fireEvent.change(await screen.findByPlaceholderText(/输入您的问题/), { target: { value: "模糊问题" } });
  fireEvent.click(await screen.findByRole("button", { name: /发\s*送/ }));

  await waitFor(() => expect(screen.getByText(/该回答可信度较低/)).toBeInTheDocument());
  expect(screen.getByText(/可信度.*60%/)).toBeInTheDocument();
});

it("未上线应用显占位、无输入区", async () => {
  vi.spyOn(client, "getApplications").mockResolvedValue([
    {
      id: "app2",
      slug: "aftersale",
      name: "售后助手",
      description: "d",
      productionConfigVersionId: null,
    },
  ] as unknown as Awaited<ReturnType<typeof client.getApplications>>);
  renderAt();

  await waitFor(() => expect(screen.getByText(/尚未上线/)).toBeInTheDocument());
  expect(screen.queryByPlaceholderText(/输入您的问题/)).not.toBeInTheDocument();
  expect(screen.getByText(/去管理台配置/)).toBeInTheDocument();
});

it("切换 agent 时中止进行中的流（不跨 agent 污染会话列表）", async () => {
  vi.spyOn(client, "getApplications").mockResolvedValue([
    { id: "app1", slug: "agentA", name: "A", description: "", productionConfigVersionId: "v1" },
    { id: "app2", slug: "agentB", name: "B", description: "", productionConfigVersionId: "v1" },
  ] as unknown as Awaited<ReturnType<typeof client.getApplications>>);
  const abortSpy = vi.spyOn(AbortController.prototype, "abort");
  let releaseHang: () => void = () => {};
  const hang = new Promise<void>((r) => {
    releaseHang = r;
  });
  async function* inflight() {
    yield {
      type: "citation" as const,
      citation: { n: 1, doc: "d", kb: "售后库", section: "s", score: 0.8, text: "x" },
    };
    await hang; // 永不 done，保持流在飞行中
  }
  vi.spyOn(sse, "openChatStream").mockImplementation(() => inflight());

  function Nav() {
    const nav = useNavigate();
    return (
      <button type="button" onClick={() => nav("/chat/agentB")}>
        go-b
      </button>
    );
  }
  render(
    <MemoryRouter initialEntries={["/chat/agentA"]}>
      <Routes>
        <Route
          path="/chat/:agentId"
          element={
            <>
              <ChatPage />
              <Nav />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

  fireEvent.change(await screen.findByPlaceholderText(/输入您的问题/), { target: { value: "q" } });
  fireEvent.click(await screen.findByRole("button", { name: /发\s*送/ }));
  await waitFor(() => expect(sse.openChatStream).toHaveBeenCalled());

  abortSpy.mockClear();
  fireEvent.click(screen.getByText("go-b")); // 中途切到 agentB（组件复用，不卸载）
  await waitFor(() => expect(abortSpy).toHaveBeenCalled());
  releaseHang();
});

it("SSE 404 → 该消息显错误提示，不崩页", async () => {
  vi.spyOn(sse, "openChatStream").mockImplementation(() => {
    throw new sse.ChatStreamError(404, "chat stream failed: 404");
  });
  renderAt();

  fireEvent.change(await screen.findByPlaceholderText(/输入您的问题/), { target: { value: "q" } });
  fireEvent.click(await screen.findByRole("button", { name: /发\s*送/ }));

  await waitFor(() => expect(screen.getByText(/该 Agent 当前不可用/)).toBeInTheDocument());
});
