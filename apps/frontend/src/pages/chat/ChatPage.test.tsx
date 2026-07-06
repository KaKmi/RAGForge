import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatPage from "./ChatPage";

/** 构造 mock SSE 字节流（对齐后端 chat.controller.ts 的 `data: ${JSON}\n\n` 格式）。 */
function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("streams assistant reply from openChatStream on send", async () => {
  localStorage.setItem("token", "tok");
  const sse =
    frame({ type: "token", delta: "你" }) +
    frame({ type: "token", delta: "好" }) +
    frame({
      type: "citation",
      citation: { n: 1, doc: "退换货政策.pdf", kb: "kb1", section: "退货条件", score: 0.82 },
    }) +
    frame({ type: "done", traceId: "abc123", confidence: 0.82 });
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: makeSseStream([sse]),
  }) as unknown as typeof fetch;

  render(<ChatPage />);

  const input = await screen.findByPlaceholderText(/输入问题/);
  fireEvent.change(input, { target: { value: "怎么退货" } });
  // antd 6 给中文 Button 文本加字间距（"发 送"），用 \s* 兼容
  const sendBtn = await screen.findByRole("button", { name: /发\s*送/ });
  fireEvent.click(sendBtn);

  // token 累积渲染为 "你好"（区别于初始 mock assistant 消息「您可以在...」）
  await waitFor(() => expect(screen.getByText(/你\s*好/)).toBeInTheDocument());
  // 流式 citation 出现在右栏（section「退货条件」区别于 mock 的「第一节/第二节」）
  await waitFor(() => expect(screen.getByText(/退\s*货\s*条\s*件/)).toBeInTheDocument());
  // 流式结束后输入框清空（Button disabled 由空输入触发，非 loading）
  await waitFor(() => expect(input).toHaveValue(""));
});

it("shows error when stream fails", async () => {
  localStorage.setItem("token", "tok");
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
  }) as unknown as typeof fetch;

  render(<ChatPage />);
  const input = await screen.findByPlaceholderText(/输入问题/);
  fireEvent.change(input, { target: { value: "测试" } });
  const sendBtn = await screen.findByRole("button", { name: /发\s*送/ });
  fireEvent.click(sendBtn);

  await waitFor(() => expect(screen.getByText(/500/)).toBeInTheDocument());
});
