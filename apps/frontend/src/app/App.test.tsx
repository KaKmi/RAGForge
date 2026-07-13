import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";
import * as client from "../api/client";

// 全量套件并发跑时，本文件每例都冷启动懒加载路由树（M7a 新增两个懒页后转换图更重），
// 默认 1s 的 findBy 窗口偶发被冷转换击穿。放宽异步等待窗口与 it 超时，断言语义不变。
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15_000 });

const NAV_LABELS = [
  "快速开始",
  "模型接入",
  "知识库",
  "Prompt 管理",
  "应用管理",
  "检索测试",
  "Trace 追踪",
  "知识缺口",
  "评测集",
  "效果评测",
];
const NAV_GROUPS = ["配置", "验证 & 观测", "数据飞轮"];

// jsdom 未实现 IntersectionObserver；ChunksPage 无限滚动依赖它，挂载即抛错（同 test/setup.ts 里 ResizeObserver 的处理方式）。
if (!(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver) {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

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

it("renders admin sider with brand, grouped nav (10 items + 3 group headers) when authenticated", async () => {
  localStorage.setItem("token", "fake-token");
  // 用 /admin/dashboard（不在侧栏）避免页面标题与菜单文案重复匹配
  render(
    <MemoryRouter initialEntries={["/admin/dashboard"]}>
      <App />
    </MemoryRouter>,
  );
  // findByText 走 waitFor，在 act 内刷新 antd Layout 挂载后的异步状态 + 懒加载
  // 品牌区文案为「控制台」（对齐原型），breadcrumb「CodeCrushBot 控制台」非精确匹配不会冲突
  expect(await screen.findByText("控制台")).toBeInTheDocument();
  for (const label of NAV_LABELS) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
  for (const group of NAV_GROUPS) {
    expect(screen.getByText(group)).toBeInTheDocument();
  }
  // M7a：导航入口由「Agent 管理」替换为「应用管理」（旧 /admin/agents 仅保留可直达）
  expect(screen.queryByText("Agent 管理")).not.toBeInTheDocument();
});

it("renders GapsPage shell on /admin/gaps (数据飞轮壳页)", async () => {
  localStorage.setItem("token", "fake-token");
  render(
    <MemoryRouter initialEntries={["/admin/gaps"]}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/暂无知识缺口/)).toBeInTheDocument();
});

it("loads TracesPage from real /api/traces on /admin/traces (M9 W1)", async () => {
  localStorage.setItem("token", "fake-token");
  // M9 W1：TracesPage 脱 mock，进页拉真实读模型。mock fetch：/api/traces 返一条、sessions/applications 返空。
  const traceRow = {
    traceId: "a".repeat(32),
    sessionId: "conv1",
    agentId: "app1",
    agentName: "退款助手",
    userId: "u1",
    userInput: "帮我把课退了",
    status: "success",
    startTime: "2026-07-13T09:11:00.000Z",
    durationMs: 2410,
    inputTokens: 1200,
    outputTokens: 200,
    qualitySignals: [],
    promptVersionId: null,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _opts?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.includes("/api/traces/sessions")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    if (u.includes("/api/traces")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [traceRow],
          total: 1,
          summary: { sampledTotal: 1, failRate: 0, failCount: 0, p95Ms: 2410, timeoutCount: 0 },
        }),
      } as unknown as Response;
    }
    if (u.includes("/api/applications")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/admin/traces"]}>
      <App />
    </MemoryRouter>,
  );
  // 真实 API 返回的用户问题渲染 = 页面消费了 /api/traces（不再是本地 mock TRACE_ROWS）
  expect(await screen.findByText("帮我把课退了")).toBeInTheDocument();
  await waitFor(() => {
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/api/traces"))).toBe(true);
  });
});

it("loads AgentsPage from real /api/agents on /admin/agents (M7)", async () => {
  localStorage.setItem("token", "fake-token");
  // mock fetch：/api/agents 返空数组；引用数据（kb/models/prompts）同样返空。证明页面调真 API 而非本地 mock。
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _opts?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.includes("/api/agents")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    if (u.includes("/api/knowledge-bases") || u.includes("/api/models")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    if (u.includes("/api/prompts")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
      } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/admin/agents"]}>
      <App />
    </MemoryRouter>,
  );
  // 空列表态出现 = 页面已挂载且消费了 API 响应（不再渲染 mocks/agents 的 AGENT_ROWS）
  expect(await screen.findByText(/暂无 Agent/)).toBeInTheDocument();
  // 关键断言：挂载时确实调用了 /api/agents（非本地 mock）
  await waitFor(() => {
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => u.includes("/api/agents"))).toBe(true);
  });
});

it("loads PromptsPage from real /api/prompts on /admin/prompts (M6)", async () => {
  localStorage.setItem("token", "fake-token");
  // mock fetch：GET /api/prompts 返空数组，其余 404。证明页面挂载调真 API 而非本地 mock。
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _opts?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.includes("/api/prompts")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/admin/prompts"]}>
      <App />
    </MemoryRouter>,
  );
  // 空列表态出现 = 页面已挂载且消费了 API 响应
  expect(await screen.findByText(/暂无 Prompt/)).toBeInTheDocument();
  // 关键断言：挂载时确实调用了 /api/prompts（非本地 mock）
  await waitFor(() => {
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => u.includes("/api/prompts"))).toBe(true);
  });
});

it("loads ModelsPage from real /api/models on /admin/models (M3)", async () => {
  localStorage.setItem("token", "fake-token");
  // mock fetch：GET /api/models 返空数组，其余 404。证明页面挂载调真 API 而非本地 mock。
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _opts?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.includes("/api/models")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/admin/models"]}>
      <App />
    </MemoryRouter>,
  );
  // 空态出现 = 页面消费了 API 响应（不再渲染本地 LLM_ROWS）
  expect(await screen.findByText(/暂无模型/)).toBeInTheDocument();
  await waitFor(() => {
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => u.includes("/api/models"))).toBe(true);
  });
});

it("loads KnowledgeBasesPage from real /api/knowledge-bases on /admin/knowledge-bases (M4)", async () => {
  localStorage.setItem("token", "fake-token");
  // mock fetch：GET /api/knowledge-bases 返空数组，其余 404。证明页面挂载调真 API 而非本地 mock。
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _opts?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.includes("/api/knowledge-bases")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/admin/knowledge-bases"]}>
      <App />
    </MemoryRouter>,
  );
  // 空列表态出现 = 页面已挂载且消费了 API 响应（不再渲染 mocks/knowledge-bases 里的固定数据）
  expect(await screen.findByText(/暂无知识库/)).toBeInTheDocument();
  // 关键断言：挂载时确实调用了 /api/knowledge-bases（非本地 mock）
  await waitFor(() => {
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => u.includes("/api/knowledge-bases"))).toBe(true);
  });
});

it("loads DocumentsPage from real /api/documents on /admin/knowledge-bases/:kbId/documents (M4)", async () => {
  localStorage.setItem("token", "fake-token");
  // mock fetch：GET /api/documents?kbId= 与 GET /api/knowledge-bases（KB 摘要）都返空/空数组，其余 404。
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _opts?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.includes("/api/documents")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    if (u.includes("/api/knowledge-bases")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/admin/knowledge-bases/kb1/documents"]}>
      <App />
    </MemoryRouter>,
  );
  // 空列表态出现 = 页面已挂载且消费了 API 响应（不再渲染本地 mock 文档）。
  // DocumentsPage 是最重的懒加载 chunk，全量套件并发跑时 vitest 现场转换可超 findByText
  // 默认 1s 超时（单跑轻载能过）——放宽等待窗口，断言语义不变。
  expect(await screen.findByText(/该知识库暂无文档/, {}, { timeout: 10_000 })).toBeInTheDocument();
  // 关键断言：挂载时确实调用了 /api/documents?kbId=kb1（非本地 mock）
  await waitFor(() => {
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => u.includes("/api/documents") && u.includes("kbId=kb1"))).toBe(true);
  });
});

it("loads ChunksPage from real /api/documents/:id/chunks on the chunks route (M4)", async () => {
  localStorage.setItem("token", "fake-token");
  // mock fetch：GET /api/documents/d1/content 与 GET /api/documents/d1/chunks 都返空，其余 404。
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _opts?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.includes("/chunks")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [], total: 0, offset: 0, limit: 20, hasMore: false }),
      } as unknown as Response;
    }
    if (u.includes("/content")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ documentId: "d1", text: "" }),
      } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/admin/knowledge-bases/kb1/documents/d1/chunks"]}>
      <App />
    </MemoryRouter>,
  );
  // 空态出现 = 页面已挂载且消费了 API 响应（不再渲染本地 mock 切片）
  expect(await screen.findByText("没有匹配的切片")).toBeInTheDocument();
  // 关键断言：挂载时确实调用了 /api/documents/d1/chunks（非本地 mock）
  await waitFor(() => {
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => u.includes("/api/documents/d1/chunks"))).toBe(true);
  });
});

it("renders chat three-column layout on /chat/:agentId when authenticated", async () => {
  localStorage.setItem("token", "fake-token");
  // M8 T4：ChatPage 进页拉真实应用元信息（mock client 网络边界）——已上线应用渲染三栏。
  const app = {
    id: "app1",
    slug: "aftersale",
    name: "售后助手",
    description: "退款换课",
    productionConfigVersionId: "v1",
  } as unknown as Awaited<ReturnType<typeof client.getApplications>>[number];
  vi.spyOn(client, "getApplications").mockResolvedValue([app]);
  vi.spyOn(client, "getApplicationDetail").mockResolvedValue({
    ...app,
    versions: [],
  } as unknown as Awaited<ReturnType<typeof client.getApplicationDetail>>);
  vi.spyOn(client, "getKnowledgeBases").mockResolvedValue([]);
  vi.spyOn(client, "getConversations").mockResolvedValue([]);
  try {
    render(
      <MemoryRouter initialEntries={["/chat/aftersale"]}>
        <App />
      </MemoryRouter>,
    );
    // 三栏可识别：左品牌「CodeCrushBot」+ 头部 agent 名 + 右栏头「引用原文」
    expect(await screen.findByText("CodeCrushBot")).toBeInTheDocument();
    expect(screen.getAllByText("售后助手").length).toBeGreaterThan(0);
    expect(screen.getByText("引用原文")).toBeInTheDocument();
  } finally {
    vi.restoreAllMocks();
  }
});

it("protects /chat/:agentId behind AuthGuard", async () => {
  render(
    <MemoryRouter initialEntries={["/chat/aftersale"]}>
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
  // 断言导航落点：nav("/admin") 后 AdminLayout 渲染，Sider 品牌字「控制台」出现。
  // 否则即便 nav 被删/写错，token 断言仍通过——回归不被捕获（AC 2 重定向部分）。
  expect(await screen.findByText("控制台")).toBeInTheDocument();
});
