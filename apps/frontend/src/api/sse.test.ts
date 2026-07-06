import { openChatStream } from "./sse";

const TOKEN_KEY = "token";

/** 构造 mock ReadableStream<Uint8Array>，模拟后端 text/event-stream 字节流。 */
function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

/** 构造一帧完整 SSE：`data: ${JSON}\n\n`（对齐后端 chat.controller.ts）。 */
function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("parses token → citation → done sequence from chunked stream", async () => {
  localStorage.setItem(TOKEN_KEY, "tok-abc");
  // 故意切成两段，验证跨 chunk 的 buffer 拼接
  const full =
    frame({ type: "token", delta: "你" }) +
    frame({ type: "token", delta: "好" }) +
    frame({
      type: "citation",
      citation: { n: 1, doc: "x.pdf", kb: "kb1", section: "s", score: 0.82 },
    }) +
    frame({ type: "done", traceId: "abc123", confidence: 0.82 });
  const mid = Math.floor(full.length / 2);
  const chunks = [full.slice(0, mid), full.slice(mid)];

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: makeSseStream(chunks),
  }) as unknown as typeof fetch;

  const events = [];
  for await (const e of openChatStream({ agentId: "a1", query: "你好" })) {
    events.push(e);
  }

  expect(events).toHaveLength(4);
  expect(events[0]).toEqual({ type: "token", delta: "你" });
  expect(events[1]).toEqual({ type: "token", delta: "好" });
  expect(events[2]).toMatchObject({
    type: "citation",
    citation: { doc: "x.pdf", n: 1 },
  });
  expect(events[3]).toEqual({ type: "done", traceId: "abc123", confidence: 0.82 });
});

it("attaches Authorization header from localStorage token", async () => {
  localStorage.setItem(TOKEN_KEY, "tok-bearer");
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: makeSseStream([frame({ type: "done", traceId: "t1" })]),
  }) as unknown as typeof fetch;

  const events = [];
  for await (const e of openChatStream({ agentId: "a1", query: "q" })) {
    events.push(e);
  }
  expect(events).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  const init = call[1] as RequestInit;
  expect(init.method).toBe("POST");
  expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-bearer");
  expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
});

it("omits Authorization header when no token stored", async () => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: makeSseStream([frame({ type: "done", traceId: "t2" })]),
  }) as unknown as typeof fetch;

  for await (const _ of openChatStream({ agentId: "a1", query: "q" })) {
    // drain
  }
  const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
  expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
});

it("throws on non-ok response with status", async () => {
  localStorage.setItem(TOKEN_KEY, "tok");
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
  }) as unknown as typeof fetch;

  await expect(
    (async () => {
      for await (const _ of openChatStream({ agentId: "a1", query: "q" })) {
        // drain
      }
    })(),
  ).rejects.toThrow(/401/);
});

it("skips comment lines, event fields, and retry directives", async () => {
  // 混入 SSE 注释（: keep-alive）、event 字段、retry 指令；只 data: 行应被解析
  const raw =
    ": keep-alive\n\n" +
    "event: token\n" +
    "retry: 1000\n\n" +
    frame({ type: "token", delta: "嗨" }) +
    "retry: 2000\n\n" +
    frame({ type: "done", traceId: "t3" });
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: makeSseStream([raw]),
  }) as unknown as typeof fetch;

  const events = [];
  for await (const e of openChatStream({ agentId: "a1", query: "q" })) {
    events.push(e);
  }
  expect(events.map((e) => e.type)).toEqual(["token", "done"]);
});

it("passes AbortSignal through to fetch", async () => {
  const ac = new AbortController();
  let captured: RequestInit | undefined;
  global.fetch = vi.fn().mockImplementation((_url, init) => {
    captured = init as RequestInit;
    return Promise.resolve({
      ok: true,
      body: makeSseStream([frame({ type: "done", traceId: "t4" })]),
    });
  }) as unknown as typeof fetch;

  for await (const _ of openChatStream({ agentId: "a1", query: "q" }, ac.signal)) {
    // drain
  }
  expect(captured?.signal).toBe(ac.signal);
});

it("rejects malformed event payload via ChatStreamEventSchema", async () => {
  localStorage.setItem(TOKEN_KEY, "tok");
  // delta 缺失 + 未知 type —— Zod discriminatedUnion 应拒绝
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    body: makeSseStream([
      frame({ type: "token" }), // 缺 delta
      frame({ type: "done", traceId: "t5" }),
    ]),
  }) as unknown as typeof fetch;

  await expect(
    (async () => {
      for await (const _ of openChatStream({ agentId: "a1", query: "q" })) {
        // drain
      }
    })(),
  ).rejects.toThrow();
});
