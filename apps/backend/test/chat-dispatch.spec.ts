import {
  CHAT_TIMEOUT_MS,
  ProtocolDispatchAdapter,
} from "../src/modules/models/adapters/protocol-dispatch.adapter";
import type { ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

// 012 Story 7：dispatch.chat() 的 fetch 编排——超时/错误归一/密钥擦除/形状校验
// （builder 纯函数已由 chat-builders.spec 覆盖，此处 mock global.fetch 测编排层）

const config: ModelCallConfig = {
  type: "llm",
  protocol: "openai_compat",
  name: "m",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-topsecret",
};
const input = { system: "s", user: "u" };

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

  it("成功：POST builder 构造的请求并返回抽取文本", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: "回答内容" } }] }),
    );
    const res = await adapter.chat(config, input, { temperature: 0.7 });
    expect(res.text).toBe("回答内容");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).temperature).toBe(0.7);
  });

  it("非 2xx：抛错并擦除响应里回显的 apiKey", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { message: "invalid key sk-topsecret" } }),
    );
    await expect(adapter.chat(config, input)).rejects.toThrow(/\[REDACTED\]/);
    await fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { message: "invalid key sk-topsecret" } }),
    );
    await expect(adapter.chat(config, input)).rejects.not.toThrow(/sk-topsecret/);
  });

  it("200 但形状不符（无文本输出）→ 稳定 provider-response 错误", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [] }));
    await expect(adapter.chat(config, input)).rejects.toThrow("chat 响应形状不符");
  });

  it("网络错误消息里出现 key 也被擦除", async () => {
    fetchMock.mockRejectedValue(new Error("connect failed to sk-topsecret@host"));
    await expect(adapter.chat(config, input)).rejects.toThrow(/\[REDACTED\]/);
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
      const pending = adapter.chat(config, input);
      const assertion = expect(pending).rejects.toThrow(`chat 请求超时（>${CHAT_TIMEOUT_MS}ms）`);
      await jest.advanceTimersByTimeAsync(CHAT_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it("不支持的协议 → 防御分支抛错（正常被契约矩阵拦在上游）", async () => {
    await expect(adapter.chat({ ...config, protocol: "cohere" }, input)).rejects.toThrow(
      "unsupported protocol cohere for chat",
    );
  });
});
