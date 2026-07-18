import { ProtocolDispatchAdapter } from "../src/modules/models/adapters/protocol-dispatch.adapter";
import type { ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

/**
 * E-W2b F1：外部 AbortSignal 与内部固定超时 controller 合并（AbortSignal.any）。
 * 外部中止 → 错误文案说「被中止」而非「超时」；不传 signal 时行为不变（既有 adapter 测试守）。
 */

const cfg = (over: Partial<ModelCallConfig> = {}): ModelCallConfig => ({
  type: "llm",
  protocol: "openai_compat",
  name: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test12345678",
  ...over,
});

/** 挂起的 fetch：直到传入的 signal 触发 abort 才 reject（模拟 provider 长悬挂 + 中断）。 */
function hangingFetch(): jest.Mock {
  return jest.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        const fail = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail);
      }),
  );
}

describe("ProtocolDispatchAdapter · 外部中止（F1）", () => {
  const adapter = new ProtocolDispatchAdapter();
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it("chat：外部 signal 中止 → <500ms reject，错误含「中止」不含「超时」", async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch;
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 50);
    await expect(
      adapter.chat(cfg(), [{ role: "user", content: "hi" }], { signal: ac.signal }),
    ).rejects.toThrow(/中止/);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("embed：外部 signal 中止 → reject 含「中止」", async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(
      adapter.embed(cfg({ type: "embedding" }), ["hello"], { signal: ac.signal }),
    ).rejects.toThrow(/中止/);
  });

  it("rerank：外部 signal 中止 → reject 含「中止」", async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(
      adapter.rerank(cfg({ type: "rerank", protocol: "cohere" }), "q", ["a", "b"], undefined, {
        signal: ac.signal,
      }),
    ).rejects.toThrow(/中止/);
  });

  it("chatStream：外部 signal 中止 → reject 含「中止」", async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const stream = adapter.chatStream(cfg(), [{ role: "user", content: "hi" }], {
      signal: ac.signal,
    });
    await expect(
      (async () => {
        for await (const _ of stream) void _;
      })(),
    ).rejects.toThrow(/中止/);
  });
});
