import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ChatPage from "./ChatPage";

/** M2：ChatPage 全前端 mock 本地态。发送 → 用户气泡 + 本地兜底回复（setTimeout）；
 * 角标/引用列表点击 → 右栏详情。M8 接真实 SSE 后改测流式事件。 */

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("appends user message and mock reply on send", async () => {
  localStorage.setItem("token", "tok");
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );

  const input = await screen.findByPlaceholderText(/输入您的问题/);
  fireEvent.change(input, { target: { value: "测试问题" } });
  const sendBtn = await screen.findByRole("button", { name: /发\s*送/ });
  fireEvent.click(sendBtn);

  // 用户气泡立即出现 + 输入框清空
  expect(screen.getByText("测试问题")).toBeInTheDocument();
  await waitFor(() => expect(input).toHaveValue(""));
  // 1.1s 后本地兜底回复出现（区别于初始 mock 回复）
  await waitFor(
    () => expect(screen.getByText(/收到～这个问题我帮您记录/)).toBeInTheDocument(),
    { timeout: 3000 },
  );
});

it("shows citation detail in right panel when cite selected", async () => {
  localStorage.setItem("token", "tok");
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );

  // c1 命中 4 条引用；右栏列表首项 sec 唯一
  const sec = await screen.findByText("第二条 · 七天无理由退款");
  fireEvent.click(sec);

  // 选中后详情卡显示文档名（仅详情卡含 doc，列表只含 sec）
  await waitFor(() =>
    expect(screen.getByText(/课程退款与换课政策 V3\.2/)).toBeInTheDocument(),
  );
});
