import {
  CHAT_TIMEOUT_MS,
  ProtocolDispatchAdapter,
} from "../src/modules/models/adapters/protocol-dispatch.adapter";
import type { ChatMessage, ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

// M8.0：dispatch.chat()/chatStream() 的 fetch 编排——超时/错误归一/密钥擦除/形状校验
// （builder 纯函数已由 chat-builders.spec / chat-stream-builders.spec 覆盖，此处 mock
// global.fetch 测编排层）。chat() 部分沿用 012 Story 7 既有断言，入参改为 ChatMessage[]。

const config: ModelCallConfig = {
  type: "llm",
  protocol: "openai_compat",
  name: "m",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-topsecret",
};
const messages: ChatMessage[] = [
  { role: "system", content: "s" },
  { role: "user", content: "u" },
];

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

describe("ProtocolDispatchAdapter.chat()", () => {
  const adapter = new ProtocolDispatchAdapter();
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, "fetch" as never);
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("成功：POST builder 构造的请求并返回抽取文本（ChatResult.content）", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: "回答内容" } }] }),
    );
    const res = await adapter.chat(config, messages, { temperature: 0.7 });
    expect(res.content).toBe("回答内容");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).temperature).toBe(0.7);
  });

  it("非 2xx：抛错并擦除响应里回显的 apiKey", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { message: "invalid key sk-topsecret" } }),
    );
    await expect(adapter.chat(config, messages)).rejects.toThrow(/\[REDACTED\]/);
    await fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { message: "invalid key sk-topsecret" } }),
    );
    await expect(adapter.chat(config, messages)).rejects.not.toThrow(/sk-topsecret/);
  });

  it("200 但形状不符（无文本输出）→ 稳定 provider-response 错误", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [] }));
    await expect(adapter.chat(config, messages)).rejects.toThrow("chat 响应形状不符");
  });

  it("200 但文本为空串 → 同样归一为 provider-response 错误（不静默返回空结果）", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: "" } }] }),
    );
    await expect(adapter.chat(config, messages)).rejects.toThrow("chat 响应形状不符");
    fetchMock.mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "" }] }));
    await expect(
      adapter.chat({ ...config, protocol: "anthropic" }, messages),
    ).rejects.toThrow("chat 响应形状不符");
  });

  it("网络错误消息里出现 key 也被擦除", async () => {
    fetchMock.mockRejectedValue(new Error("connect failed to sk-topsecret@host"));
    await expect(adapter.chat(config, messages)).rejects.toThrow(/\[REDACTED\]/);
  });

  it("超时中断 → 超时错误（AbortController 生效）", async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      );
      const pending = adapter.chat(config, messages);
      const assertion = expect(pending).rejects.toThrow(`chat 请求超时（>${CHAT_TIMEOUT_MS}ms）`);
      await jest.advanceTimersByTimeAsync(CHAT_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it("不支持的协议 → 防御分支抛错（正常被契约矩阵拦在上游）", async () => {
    await expect(adapter.chat({ ...config, protocol: "cohere" }, messages)).rejects.toThrow(
      "unsupported protocol cohere for chat",
    );
  });
});

// 流式 fetch 返回带 body.getReader() 的可读流 mock（Web Streams API，Node 18+ 内置）
function sseStreamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(encoder.encode(lines[i] + "\n\n"));
        i++;
      } else {
        controller.close();
      }
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

describe("ProtocolDispatchAdapter.chatStream()", () => {
  const adapter = new ProtocolDispatchAdapter();
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, "fetch" as never);
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("openai_compat：逐个 data: 行解析为 delta，[DONE] 结束迭代", async () => {
    fetchMock.mockResolvedValue(
      sseStreamResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        "data: [DONE]",
      ]),
    );
    const deltas: string[] = [];
    for await (const chunk of adapter.chatStream(config, messages)) {
      if (chunk.delta) deltas.push(chunk.delta);
      if (chunk.done) break;
    }
    expect(deltas.join("")).toBe("你好");
  });

  it("anthropic：event:/data: 配对行解析，message_stop 结束", async () => {
    const anthropicConfig = { ...config, protocol: "anthropic" as const };
    fetchMock.mockResolvedValue(
      sseStreamResponse([
        'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"你"}}',
        "event: message_stop\ndata: {}",
      ]),
    );
    const deltas: string[] = [];
    for await (const chunk of adapter.chatStream(anthropicConfig, messages)) {
      if (chunk.delta) deltas.push(chunk.delta);
      if (chunk.done) break;
    }
    expect(deltas.join("")).toBe("你");
  });

  it("gemini：逐个 data: 行解析为 delta 拼接", async () => {
    const geminiConfig = { ...config, protocol: "gemini" as const };
    fetchMock.mockResolvedValue(
      sseStreamResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"你"}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"text":"好"}]}}]}',
      ]),
    );
    const deltas: string[] = [];
    for await (const chunk of adapter.chatStream(geminiConfig, messages)) {
      if (chunk.delta) deltas.push(chunk.delta);
    }
    expect(deltas.join("")).toBe("你好");
  });

  it("网络错误/HTTP 失败 → 迭代抛错（by AsyncIterable 协议，for-await 内 throw）", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: "boom" } }));
    await expect(async () => {
      for await (const _ of adapter.chatStream(config, messages)) {
        // 不会执行到
      }
    }).rejects.toThrow(/HTTP 500/);
  });

  it("残缺/非法 JSON 分片 → 迭代抛错并擦除 key（不静默吞掉，Story 2 遗留风险在此收口）", async () => {
    fetchMock.mockResolvedValue(sseStreamResponse(['data: {"choices":[{"delta":{"content":"partial']));
    await expect(async () => {
      for await (const _ of adapter.chatStream(config, messages)) {
        // 不会执行到
      }
    }).rejects.not.toThrow(/sk-topsecret/);
  });

  it("不支持的协议 → 防御分支抛错", async () => {
    await expect(async () => {
      for await (const _ of adapter.chatStream({ ...config, protocol: "cohere" }, messages)) {
        // 不会执行到
      }
    }).rejects.toThrow("unsupported protocol cohere for chatStream");
  });

  it("消费方提前 break（未读到 chunk.done）→ 底层 reader 被 cancel，不悬挂连接（review round 1）", async () => {
    const cancelSpy = jest.fn(async () => undefined);
    const encoder = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        // 持续产出分片，模拟消费方在流结束前主动 break 的场景
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"片"}}]}\n\n'));
        pulled++;
      },
      cancel: cancelSpy,
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: stream } as unknown as Response);

    for await (const chunk of adapter.chatStream(config, messages)) {
      if (chunk.delta) break; // 拿到第一个 delta 就提前退出，不等待 done
    }
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(pulled).toBeGreaterThan(0);
  });
});
