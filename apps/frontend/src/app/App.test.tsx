import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

const NAV_LABELS = [
  "快速开始",
  "模型接入",
  "知识库",
  "Prompt 管理",
  "Agent 管理",
  "检索测试",
  "Trace 追踪",
];

beforeEach(() => {
  localStorage.clear();
});

it("redirects to /login when visiting /admin without a token", async () => {
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <App />
    </MemoryRouter>,
  );
  // AuthGuard 无 token → Navigate /login → 懒加载 LoginPage 渲染
  expect(await screen.findByPlaceholderText("邮箱")).toBeInTheDocument();
  // 管理后台 shell 不应渲染（「管理后台」只在 AdminLayout Header 出现）
  expect(screen.queryByText("管理后台")).not.toBeInTheDocument();
});

it("renders admin sider with brand and 7 nav items when authenticated", async () => {
  localStorage.setItem("token", "fake-token");
  // 用 /admin/dashboard（不在侧栏）避免页面标题与菜单文案重复匹配
  render(
    <MemoryRouter initialEntries={["/admin/dashboard"]}>
      <App />
    </MemoryRouter>,
  );
  // findByText 走 waitFor，在 act 内刷新 antd Menu/Layout 挂载后的异步状态 + 懒加载
  expect(await screen.findByText("CodeCrushBot")).toBeInTheDocument();
  for (const label of NAV_LABELS) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});

it("renders traces list on /admin/traces when authenticated", async () => {
  localStorage.setItem("token", "fake-token");
  render(
    <MemoryRouter initialEntries={["/admin/traces"]}>
      <App />
    </MemoryRouter>,
  );
  // 用 traces mock 独有查询文案断言列表非空，规避菜单「Trace 追踪」与卡片标题重复匹配
  expect(await screen.findByText("这款产品支持防水吗")).toBeInTheDocument();
});

it("renders agents list on /admin/agents when authenticated", async () => {
  localStorage.setItem("token", "fake-token");
  render(
    <MemoryRouter initialEntries={["/admin/agents"]}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByText("售后客服 Agent")).toBeInTheDocument();
});

it("renders chat three-column layout on /chat when authenticated", async () => {
  localStorage.setItem("token", "fake-token");
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByText("会话列表")).toBeInTheDocument();
  expect(screen.getByText("聊天")).toBeInTheDocument();
  expect(screen.getByText("引用")).toBeInTheDocument();
});

it("protects /chat behind AuthGuard", async () => {
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByPlaceholderText("邮箱")).toBeInTheDocument();
});

it("stores token and navigates to /admin on successful login", async () => {
  global.fetch = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        accessToken: "tok-123",
        tokenType: "Bearer",
        expiresIn: 3600,
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          email: "demo@codecrush.bot",
          displayName: "Demo",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/login"]}>
      <App />
    </MemoryRouter>,
  );
  // 表单初值已填合法 email/password，直接提交。
  // jsdom 不会在点击 submit 按钮时触发 form 的 submit 事件（已知限制），
  // 故直接对 form 派发 submit，触发 antd Form 的 onFinish。
  const form = document.querySelector("form")!;
  fireEvent.submit(form);
  await waitFor(() => expect(localStorage.getItem("token")).toBe("tok-123"));
});
