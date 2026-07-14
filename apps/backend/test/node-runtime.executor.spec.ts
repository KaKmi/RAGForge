import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { startManualSpan } from "@codecrush/otel";
import { INTENT_TABLE } from "@codecrush/contracts";
import {
  NodeRuntimeService,
  UnsupportedChatProtocolError,
} from "../src/modules/node-runtime/executor/node-runtime.service";
import type { ModelsService } from "../src/modules/models/models.service";

// M8.0 Story 7：executeStructured（rewrite/intent）/streamText（reply/fallback）/
// compileAndSample 全流程——mock ModelsService，不碰真实网络。

function makeService(chat: jest.Mock, chatStream?: jest.Mock) {
  // get() 默认返回合法协议模型行——resolveModel() 的协议前置检查需要它，
  // 不 mock 会让下面所有既有用例在到达真正测的逻辑前就因协议检查失败短路。
  const models = {
    chat,
    chatStream: jest.fn((...args: unknown[]) => {
      (args[3] as (() => void) | undefined)?.();
      return (chatStream ?? jest.fn())(...args);
    }),
    get: jest.fn(async () => ({
      id: "m1",
      protocol: "openai_compat",
      type: "llm",
      deploymentId: null,
      name: "deepseek-chat",
    })),
  } as unknown as ModelsService;
  return new NodeRuntimeService(models);
}

describe("NodeRuntimeService.executeStructured · rewrite", () => {
  it("首次即合法 JSON → fallbackUsed:false，validateSteps 全 ok", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"改写后","keywords":["a"]}' }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "rewrite",
      1,
      "改写：{query}",
      "m1",
      { query: "原问题", history: "" },
      {},
    );
    expect(res.output).toEqual({ rewrittenQuery: "改写后", keywords: ["a"] });
    expect(res.fallbackUsed).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("首次非法 JSON、修复重试后合法 → fallbackUsed:false，validateSteps 含 repair:ok", async () => {
    const chat = jest
      .fn()
      .mockResolvedValueOnce({ content: "不是 JSON" })
      .mockResolvedValueOnce({ content: '{"rewrittenQuery":"改写后","keywords":[]}' });
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "rewrite",
      1,
      "{query}",
      "m1",
      { query: "q", history: "" },
      {},
    );
    expect(res.fallbackUsed).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(res.validateSteps.some((s) => s.step === "repair" && s.ok)).toBe(true);
  });

  it("两次都非法 → fallback，最多两次调用（原始+1次修复，不递归）", async () => {
    const chat = jest.fn(async () => ({ content: "不是 JSON" }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "rewrite",
      1,
      "{query}",
      "m1",
      { query: "原始问题", history: "" },
      {},
    );
    expect(res.output).toEqual({ rewrittenQuery: "原始问题", keywords: [] });
    expect(res.fallbackUsed).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("temperature 透传给 models.chat（Playground Slider 值不能被静默丢弃）", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"x","keywords":[]}' }));
    const svc = makeService(chat);
    await svc.executeStructured(
      "rewrite",
      1,
      "{query}",
      "m1",
      { query: "q", history: "" },
      {},
      { temperature: 1.2 },
    );
    expect(chat.mock.calls[0][2]).toMatchObject({ temperature: 1.2 });
  });

  it("协议不支持 → UnsupportedChatProtocolError，不调用 chat", async () => {
    const chat = jest.fn();
    const models = {
      chat,
      chatStream: jest.fn(),
      get: jest.fn(async () => ({ id: "m1", protocol: "cohere", type: "llm" })),
    } as unknown as ModelsService;
    const svc = new NodeRuntimeService(models);
    await expect(
      svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {}),
    ).rejects.toThrow(UnsupportedChatProtocolError);
    expect(chat).not.toHaveBeenCalled();
  });

  it("未知 contractVersion → 抛错，不调用 chat", async () => {
    const chat = jest.fn();
    const svc = makeService(chat);
    await expect(
      svc.executeStructured("rewrite", 99, "{query}", "m1", { query: "q", history: "" }, {}),
    ).rejects.toThrow();
    expect(chat).not.toHaveBeenCalled();
  });

  it("inputSchema 校验失败（空 query）→ 直接 fallback，不调用 chat", async () => {
    const chat = jest.fn();
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "rewrite",
      1,
      "{query}",
      "m1",
      { query: "", history: "" },
      {},
    );
    expect(res.fallbackUsed).toBe(true);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("NodeRuntimeService repair metrics observer", () => {
  it.each([
    ["first attempt success", [{ content: '{"rewrittenQuery":"q","keywords":[]}' }], 0, false],
    ["repair success", [{ content: "bad" }, { content: '{"rewrittenQuery":"q","keywords":[]}' }], 1, false],
    ["repair failure fallback", [{ content: "bad" }, { content: "still bad" }], 1, true],
  ] as const)("%s reports retry count %s", async (_name, responses, expectedRetry, fallbackUsed) => {
    const chat = jest.fn();
    for (const response of responses) chat.mockResolvedValueOnce(response);
    const onRepair = jest.fn();
    const result = await makeService(chat).executeStructured(
      "rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {},
      { metricsObserver: { onRepair } },
    );
    expect(onRepair).toHaveBeenCalledWith(expectedRetry);
    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(result.fallbackUsed).toBe(fallbackUsed);
  });

  it("validation before model call is not eligible and does not notify repair", async () => {
    const chat = jest.fn();
    const onRepair = jest.fn();
    await makeService(chat).executeStructured(
      "rewrite", 1, "{query}", "m1", { query: "" }, {},
      { metricsObserver: { onRepair } },
    );
    expect(chat).not.toHaveBeenCalled();
    expect(onRepair).not.toHaveBeenCalled();
  });
});

describe("NodeRuntimeService.executeStructured · reservedDataSchema 校验（review round 1）", () => {
  it("intent 节点 reserved 缺 availableIntents（optional 字段，TS 层不拦截）→ 优雅降级 fallback，不抛未捕获异常，不调用 chat", async () => {
    const chat = jest.fn();
    const svc = makeService(chat);
    // reservedDataSchema 要求 availableIntents: 对象数组（非 optional），传入 {} 应该
    // 在进入模型调用之前就被 reservedDataSchema.safeParse 拦下来。
    const res = await svc.executeStructured(
      "intent",
      1,
      "{query}",
      "m1",
      { query: "q", history: "" },
      {} as never,
    );
    expect(res.fallbackUsed).toBe(true);
    expect(res.output).toEqual({ intent: "UNKNOWN", confidence: 0 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("rewrite 节点：reserved 携带共享 RuntimeContext 的额外字段（如 preview）不应被拒绝——真实模型必须被调用（review round 2 回归）", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"改写后","keywords":[]}' }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "rewrite",
      1,
      "{query}",
      "m1",
      { query: "q", history: "" },
      { preview: true } as never,
    );
    expect(chat).toHaveBeenCalledTimes(1);
    expect(res.fallbackUsed).toBe(false);
    expect(res.output).toEqual({ rewrittenQuery: "改写后", keywords: [] });
  });

  it("input 校验失败与 reserved 校验失败在 validateSteps 里标记为不同的 step（review round 2）", async () => {
    const chat = jest.fn();
    const svc = makeService(chat);
    const badInput = await svc.executeStructured(
      "rewrite",
      1,
      "{query}",
      "m1",
      { query: "", history: "" },
      {},
    );
    expect(badInput.validateSteps.find((s) => !s.ok)?.step).toBe("input");

    const badReserved = await svc.executeStructured(
      "intent",
      1,
      "{query}",
      "m1",
      { query: "q", history: "" },
      {} as never,
    );
    expect(badReserved.validateSteps.find((s) => !s.ok)?.step).toBe("reserved");
  });
});

describe("NodeRuntimeService.executeStructured · validateSteps 区分失败阶段（review round 1）", () => {
  it("模型输出非法 JSON → 首次失败步骤标记为 output_schema", async () => {
    const chat = jest.fn(async () => ({ content: "不是 JSON" }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "rewrite",
      1,
      "{query}",
      "m1",
      { query: "q", history: "" },
      {},
    );
    expect(res.validateSteps.find((s) => s.ok === false)?.step).toBe("output_schema");
  });

});

describe("NodeRuntimeService.executeStructured · intent enum 闭集（014 D3）", () => {
  it("intent 非闭集成员 → schema 解析层拒绝、修复重试；仍非法 → fallback UNKNOWN", async () => {
    const chat = jest.fn(async () => ({
      content: '{"intent":"售后","confidence":0.9}',
    }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "intent",
      1,
      "{query}",
      "m1",
      { query: "q", history: "" },
      { availableIntents: INTENT_TABLE },
    );
    expect(res.fallbackUsed).toBe(true);
    expect(res.output).toEqual({ intent: "UNKNOWN", confidence: 0 });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(res.validateSteps.find((s) => s.ok === false)?.step).toBe("output_schema");
  });

  it("intent 为闭集成员 → 直接通过，不触发修复", async () => {
    const chat = jest.fn(async () => ({
      content: '{"intent":"SUPPORT","confidence":0.9}',
    }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "intent",
      1,
      "{query}",
      "m1",
      { query: "q", history: "" },
      { availableIntents: INTENT_TABLE },
    );
    expect(res.fallbackUsed).toBe(false);
    expect(res.output).toEqual({ intent: "SUPPORT", confidence: 0.9 });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe("NodeRuntimeService.streamText · reply/fallback", () => {
  it("reply：collect 模式收集完整流式文本", async () => {
    async function* gen() {
      yield { delta: "你" };
      yield { delta: "好" };
      yield { done: true };
    }
    const svc = makeService(
      jest.fn(),
      jest.fn(() => gen()),
    );
    const res = await svc.streamText(
      "reply",
      1,
      "回答：{query}",
      "m1",
      { query: "q", history: "", retrievalContext: "" },
      { citations: [] },
    );
    expect(res.text).toBe("你好");
    expect(res.fallbackUsed).toBe(false);
  });

  it("reply：已产出部分内容后报错 → 保留已产出文本，不触发 fallback（review round 1，011 Design：不可撤回已展示内容）", async () => {
    async function* gen() {
      yield { delta: "已经生成的部分答案" };
      yield { error: "连接中断" };
    }
    const svc = makeService(
      jest.fn(),
      jest.fn(() => gen()),
    );
    const res = await svc.streamText(
      "reply",
      1,
      "{query}",
      "m1",
      { query: "q", history: "", retrievalContext: "" },
      { citations: [] },
    );
    expect(res.text).toBe("已经生成的部分答案");
    expect(res.fallbackUsed).toBe(false);
  });

  it("reply：首 token 前即报错 → 无痕切 fallback", async () => {
    async function* gen() {
      yield { error: "上游超时" };
    }
    const svc = makeService(
      jest.fn(),
      jest.fn(() => gen()),
    );
    const res = await svc.streamText(
      "reply",
      1,
      "{query}",
      "m1",
      { query: "q", history: "", retrievalContext: "" },
      { citations: [] },
    );
    expect(res.fallbackUsed).toBe(true);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it("reply：temperature 透传给 models.chatStream", async () => {
    async function* gen() {
      yield { delta: "答案" };
      yield { done: true };
    }
    const chatStream = jest.fn(() => gen());
    const svc = makeService(jest.fn(), chatStream);
    await svc.streamText(
      "reply",
      1,
      "{query}",
      "m1",
      { query: "q", history: "", retrievalContext: "" },
      { citations: [] },
      { temperature: 0.3 },
    );
    expect(chatStream.mock.calls[0][2]).toMatchObject({ temperature: 0.3 });
  });

  it("fallback 节点：永不调用模型，Prompt 正文就是最终话术", async () => {
    const chatStream = jest.fn();
    const svc = makeService(jest.fn(), chatStream);
    const res = await svc.streamText("fallback", 1, "抱歉，暂时无法回答。", "m1", {}, {});
    expect(chatStream).not.toHaveBeenCalled();
    expect(res.text).toBe("抱歉，暂时无法回答。");
    expect(res.fallbackUsed).toBe(false);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it("reply：inputSchema 校验失败（缺必填字段）→ 直接 fallback，不调用 chatStream（review P2）", async () => {
    const chatStream = jest.fn();
    const svc = makeService(jest.fn(), chatStream);
    const res = await svc.streamText("reply", 1, "{query}", "m1", { query: "" } as never, {
      citations: [],
    });
    expect(chatStream).not.toHaveBeenCalled();
    expect(res.fallbackUsed).toBe(true);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it("reply：input 为 null（越过 TS 类型的运行时调用方）→ 优雅降级 fallback，不抛未捕获异常（review P2）", async () => {
    const chatStream = jest.fn();
    const svc = makeService(jest.fn(), chatStream);
    const res = await svc.streamText("reply", 1, "{query}", "m1", null as never, { citations: [] });
    expect(chatStream).not.toHaveBeenCalled();
    expect(res.fallbackUsed).toBe(true);
  });

  it("reply：reservedDataSchema 校验失败 → 直接 fallback，不调用 chatStream（review P2）", async () => {
    const chatStream = jest.fn();
    const svc = makeService(jest.fn(), chatStream);
    const res = await svc.streamText(
      "reply",
      1,
      "{query}",
      "m1",
      { query: "q", history: "", retrievalContext: "" },
      { citations: "not-an-array" } as never,
    );
    expect(chatStream).not.toHaveBeenCalled();
    expect(res.fallbackUsed).toBe(true);
  });
});

describe("NodeRuntimeService.streamTextChunks · reply 逐 token", () => {
  // 手动 drain generator：收集 yield 的 delta 与末位 summary
  async function drain(gen: AsyncGenerator<{ delta: string }, unknown>) {
    const deltas: string[] = [];
    let r = await gen.next();
    while (!r.done) {
      deltas.push(r.value.delta);
      r = await gen.next();
    }
    return { deltas, summary: r.value as { outcome: string; text?: string; traceId?: string } };
  }
  function replyStream(chunks: Array<{ delta?: string; done?: boolean; error?: string }>) {
    return async function* () {
      for (const c of chunks) yield c;
    };
  }

  it("逐个 yield 每个 delta（不整段），summary.outcome=ok 且 text=拼接", async () => {
    const chatStream = jest.fn(() => replyStream([{ delta: "你" }, { delta: "好" }, { done: true }])());
    const svc = makeService(jest.fn(), chatStream);
    const { deltas, summary } = await drain(
      svc.streamTextChunks("reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] }),
    );
    expect(deltas).toEqual(["你", "好"]);
    expect(summary).toMatchObject({ outcome: "ok", text: "你好" });
  });

  it("首 token 前即报错 → 无 delta，outcome=fallback", async () => {
    const chatStream = jest.fn(() => replyStream([{ error: "boom" }])());
    const svc = makeService(jest.fn(), chatStream);
    const { deltas, summary } = await drain(
      svc.streamTextChunks("reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] }),
    );
    expect(deltas).toEqual([]);
    expect(summary.outcome).toBe("fallback");
    expect(summary.text && summary.text.length).toBeGreaterThan(0);
  });

  it("已 yield token 后断流 → 保留已产出，outcome=partial", async () => {
    const chatStream = jest.fn(() => replyStream([{ delta: "答" }, { error: "断" }])());
    const svc = makeService(jest.fn(), chatStream);
    const { deltas, summary } = await drain(
      svc.streamTextChunks("reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] }),
    );
    expect(deltas).toEqual(["答"]);
    expect(summary).toMatchObject({ outcome: "partial", text: "答" });
  });

  it("首 token 超时 → outcome=timeout，且上游 generator 被 return()（级联 cancel）", async () => {
    let returned = false;
    const hanging = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => new Promise(() => {}), // 永不 resolve
      return: async () => {
        returned = true;
        return { done: true, value: undefined };
      },
    } as unknown as AsyncIterableIterator<{ delta?: string }>;
    const chatStream = jest.fn(() => hanging);
    const svc = makeService(jest.fn(), chatStream);
    const onGenerationTiming = jest.fn();
    jest.useFakeTimers();
    const gen = svc.streamTextChunks(
      "reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] },
      { metricsObserver: { onGenerationTiming } },
    );
    const p = gen.next();
    await jest.advanceTimersByTimeAsync(20_000);
    const r = await p;
    jest.useRealTimers();
    expect(r.done).toBe(true);
    expect((r.value as { outcome: string }).outcome).toBe("timeout");
    expect(returned).toBe(true);
    expect(onGenerationTiming).toHaveBeenCalledTimes(1);
    expect(onGenerationTiming.mock.calls[0][0]).not.toHaveProperty("ttftMs");
  });

  it("首 token 前的空/keepalive 帧被跳过、不重置窗口、不泄漏计时器（单一 deadline）", async () => {
    // 真实适配器：首 delta 前常有空帧（anthropic message_start/ping、openai role 首帧映射为 {}）。
    // 旧实现每帧新建 timer → 泄漏 + 窗口重置；本用例用真实计时器，若泄漏会拖慢/开句柄。
    const chatStream = jest.fn(() => replyStream([{}, {}, { delta: "x" }, { done: true }])());
    const svc = makeService(jest.fn(), chatStream);
    const { deltas, summary } = await drain(
      svc.streamTextChunks("reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] }),
    );
    expect(deltas).toEqual(["x"]);
    expect(summary).toMatchObject({ outcome: "ok", text: "x" });
  });

  it("TTFT starts immediately before provider streaming; empty keepalives do not stop it", async () => {
    const now = jest.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(145)
      .mockReturnValueOnce(180);
    const onGenerationTiming = jest.fn();
    const chatStream = jest.fn(() => replyStream([{}, { delta: "x" }, { done: true }])());
    const svc = makeService(jest.fn(), chatStream);
    await drain(svc.streamTextChunks(
      "reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] },
      { metricsObserver: { onGenerationTiming } },
    ));
    expect(onGenerationTiming).toHaveBeenCalledWith({ ttftMs: 45, generationDurationMs: 80 });
    now.mockRestore();
  });

  it("empty stream omits TTFT but reports generation duration", async () => {
    const now = jest.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(30);
    const onGenerationTiming = jest.fn();
    const svc = makeService(jest.fn(), jest.fn(() => replyStream([{ done: true }])()));
    const { summary } = await drain(svc.streamTextChunks(
      "reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] },
      { metricsObserver: { onGenerationTiming } },
    ));
    expect(summary.outcome).toBe("fallback");
    expect(onGenerationTiming).toHaveBeenCalledWith({ generationDurationMs: 20 });
    now.mockRestore();
  });

  it("timing observer failure never changes the stream result", async () => {
    const svc = makeService(jest.fn(), jest.fn(() => replyStream([{ delta: "x" }, { done: true }])()));
    const { deltas, summary } = await drain(svc.streamTextChunks(
      "reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] },
      { metricsObserver: { onGenerationTiming: () => { throw new Error("telemetry down"); } } },
    ));
    expect(deltas).toEqual(["x"]);
    expect(summary).toMatchObject({ outcome: "ok", text: "x" });
  });

  it("abort after first token preserves TTFT and reports duration from finally", async () => {
    const now = jest.spyOn(performance, "now")
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(70)
      .mockReturnValueOnce(95);
    const onGenerationTiming = jest.fn();
    const svc = makeService(jest.fn(), jest.fn(() => replyStream([{ delta: "x" }, { delta: "y" }])()));
    const gen = svc.streamTextChunks(
      "reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] },
      { metricsObserver: { onGenerationTiming } },
    );
    await gen.next();
    await gen.return(undefined);
    expect(onGenerationTiming).toHaveBeenCalledWith({ ttftMs: 20, generationDurationMs: 45 });
    now.mockRestore();
  });

  it("消费者提前 return()（abort）→ 级联 return 底层迭代器（reader.cancel）", async () => {
    let returned = false;
    const upstream = replyStream([{ delta: "答" }, { delta: "案" }, { done: true }])();
    const origReturn = upstream.return?.bind(upstream);
    upstream.return = ((v?: unknown) => {
      returned = true;
      return origReturn ? origReturn(v as never) : Promise.resolve({ done: true, value: undefined });
    }) as never;
    const chatStream = jest.fn(() => upstream);
    const svc = makeService(jest.fn(), chatStream);
    const gen = svc.streamTextChunks("reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] });
    const first = await gen.next(); // 第一个 token
    expect(first.value).toEqual({ delta: "答" });
    await gen.return(undefined); // 模拟消费者 abort：应触发 finally 级联 upstream.return()
    expect(returned).toBe(true);
  });

  it("消费者 abort 前把已知 model 与累计 usage 通知调用方", async () => {
    const onModel = jest.fn();
    const onUsage = jest.fn();
    const chatStream = jest.fn(async function* () {
      yield { usage: { inputTokens: 30, outputTokens: 0 } };
      yield { delta: "答" };
      yield { usage: { inputTokens: 0, outputTokens: 12 } };
      yield { delta: "案" };
    });
    const svc = makeService(jest.fn(), chatStream);
    const gen = svc.streamTextChunks(
      "reply",
      1,
      "{query}",
      "m1",
      { query: "hi", history: "" },
      { citations: [] },
      { metricsObserver: { onModel, onUsage } },
    );
    await gen.next();
    await gen.return(undefined);
    expect(onModel).toHaveBeenCalledWith("deepseek-chat");
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 30, outputTokens: 0 });
  });

  it("input 校验失败 → 不调 chatStream，outcome=fallback", async () => {
    const chatStream = jest.fn();
    const svc = makeService(jest.fn(), chatStream);
    const { deltas, summary } = await drain(
      svc.streamTextChunks("reply", 1, "{query}", "m1", { query: "" } as never, { citations: [] }),
    );
    expect(chatStream).not.toHaveBeenCalled();
    expect(deltas).toEqual([]);
    expect(summary.outcome).toBe("fallback");
  });

  it("fallback 节点误调 → 防御性整段返回 promptBody，不调模型", async () => {
    const chatStream = jest.fn();
    const svc = makeService(jest.fn(), chatStream);
    const { deltas, summary } = await drain(svc.streamTextChunks("fallback", 1, "抱歉，暂时无法回答。", "m1", {}, {}));
    expect(chatStream).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ outcome: "fallback", text: "抱歉，暂时无法回答。" });
    expect(deltas).toEqual([]);
  });

  // AC3：reply span 显式挂父到传入的 parentCtx（不靠活动上下文），且流末 end（跨多 yield 存活）。
  // 用真实 InMemorySpanExporter 断言父子关系——@codecrush/otel 的 export* 产生不可配置 getter，
  // jest.spyOn 会抛 "Cannot redefine property"，故不用 spy。
  it("parentCtx → reply span 显式挂父到根、且流末 end（AC3）", async () => {
    // parentCtx 显式传给 startManualSpan（tracer.startSpan 第三参），挂父不经活动上下文，
    // 故本测试无需注册 ContextManager——只需 InMemorySpanExporter 读父子关系。
    const exporter = new InMemorySpanExporter();
    trace.disable();
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    try {
      const { span: root, ctx: rootCtx } = startManualSpan("test.root", undefined);
      const chatStream = jest.fn(() => replyStream([{ delta: "x" }, { done: true }])());
      const svc = makeService(jest.fn(), chatStream);
      await drain(
        svc.streamTextChunks("reply", 1, "{query}", "m1", { query: "hi", history: "" }, { citations: [] }, undefined, rootCtx),
      );
      root.end();
      const spans = exporter.getFinishedSpans() as Array<{
        name: string;
        spanContext(): { traceId: string; spanId: string };
        parentSpanContext?: { spanId: string };
        parentSpanId?: string;
      }>;
      const reply = spans.find((s) => s.name === "node_runtime.stream_text")!;
      expect(reply).toBeDefined(); // 出现在 finished == 已 end（跨 yield 后流末 end）
      const pid = reply.parentSpanContext?.spanId ?? reply.parentSpanId;
      expect(pid).toBe(root.spanContext().spanId); // 显式挂父到根，不靠活动上下文
      expect(reply.spanContext().traceId).toBe(root.spanContext().traceId);
    } finally {
      trace.disable();
    }
  });
});

describe("NodeRuntimeService.compileAndSample", () => {
  it("多样例聚合：2 合法 + 1 intent 非闭集 → results 长度一致，非法样例 ok:false", async () => {
    const chat = jest
      .fn()
      .mockResolvedValueOnce({ content: '{"intent":"SUPPORT","confidence":0.9}' })
      .mockResolvedValueOnce({ content: '{"intent":"售后","confidence":0.9}' })
      .mockResolvedValueOnce({ content: '{"intent":"售后","confidence":0.9}' })
      .mockResolvedValueOnce({ content: '{"intent":"FEEDBACK","confidence":0.8}' });
    const svc = makeService(chat);
    const res = await svc.compileAndSample({
      node: "intent",
      contractVersion: 1,
      promptVersionId: "pv1",
      promptBody: "{query}",
      modelId: "m1",
      modelParams: { temperature: 0.7, topP: 1 },
      samples: [
        { input: { query: "q1", history: "" }, runtimeContext: { availableIntents: INTENT_TABLE } },
        { input: { query: "q2", history: "" }, runtimeContext: { availableIntents: INTENT_TABLE } },
        { input: { query: "q3", history: "" }, runtimeContext: { availableIntents: INTENT_TABLE } },
      ],
    });
    expect(res.results).toHaveLength(3);
    expect(res.results[0].ok).toBe(true);
    expect(res.results[1].fallbackUsed).toBe(true);
    expect(res.results[2].ok).toBe(true);
  });

  it("modelParams.temperature 透传进每次样例调用", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"x","keywords":[]}' }));
    const svc = makeService(chat);
    await svc.compileAndSample({
      node: "rewrite",
      contractVersion: 1,
      promptVersionId: "pv1",
      promptBody: "{query}",
      modelId: "m1",
      modelParams: { temperature: 0.9, topP: 1 },
      samples: [{ input: { query: "q1", history: "" }, runtimeContext: {} }],
    });
    expect(chat.mock.calls[0][2]).toMatchObject({ temperature: 0.9 });
  });

  it("reply/fallback 节点走 streamText 分支聚合", async () => {
    async function* gen() {
      yield { delta: "答案" };
      yield { done: true };
    }
    const chatStream = jest.fn(() => gen());
    const svc = makeService(jest.fn(), chatStream);
    const res = await svc.compileAndSample({
      node: "reply",
      contractVersion: 1,
      promptVersionId: "pv1",
      promptBody: "{query}",
      modelId: "m1",
      modelParams: { temperature: 0.5, topP: 1 },
      samples: [
        {
          input: { query: "q1", history: "", retrievalContext: "" },
          runtimeContext: { citations: [] },
        },
      ],
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].ok).toBe(true);
  });

  it("单样例基础设施失败（如未知模型 ID）不应中断整批——其余样例仍返回结果（review P2）", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"x","keywords":[]}' }));
    const models = {
      chat,
      chatStream: jest.fn(),
      get: jest.fn(async (id: string) => {
        if (id === "bad-model") throw new Error("模型不存在");
        return { id, protocol: "openai_compat", type: "llm" };
      }),
    } as unknown as ModelsService;
    const svc = new NodeRuntimeService(models);
    const res = await svc.compileAndSample({
      node: "rewrite",
      contractVersion: 1,
      promptVersionId: "pv1",
      promptBody: "{query}",
      modelId: "bad-model",
      modelParams: { temperature: 0.9, topP: 1 },
      samples: [
        { input: { query: "q1", history: "" }, runtimeContext: {} },
        { input: { query: "q2", history: "" }, runtimeContext: {} },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(2);
    expect(res.results[0].ok).toBe(false);
    expect(res.results[0].issues[0]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(res.results[1].ok).toBe(false);
  });

  it("M7b S0：结构化样例回填 span traceId（供 ReleaseCheck OPEN_PROMPT_TRY_RUN 深链）", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"x","keywords":[]}' }));
    const svc = makeService(chat);
    const res = await svc.compileAndSample({
      node: "rewrite",
      contractVersion: 1,
      promptVersionId: "pv1",
      promptBody: "{query}",
      modelId: "m1",
      modelParams: { temperature: 0.2, topP: 1 },
      samples: [{ input: { query: "hi", history: "" }, runtimeContext: {} }],
    });
    // span.spanContext().traceId 是 W3C 32-hex（无 SDK 时为全零，仍证明字段已从 span 接通而非 undefined）
    expect(res.results[0].traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("M7b S0：流式（reply）样例同样回填 traceId", async () => {
    async function* gen() {
      yield { delta: "答案" };
      yield { done: true };
    }
    const svc = makeService(
      jest.fn(),
      jest.fn(() => gen()),
    );
    const res = await svc.compileAndSample({
      node: "reply",
      contractVersion: 1,
      promptVersionId: "pv1",
      promptBody: "{query}",
      modelId: "m1",
      modelParams: { temperature: 0.5, topP: 1 },
      samples: [
        {
          input: { query: "q1", history: "", retrievalContext: "" },
          runtimeContext: { citations: [] },
        },
      ],
    });
    expect(res.results[0].traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("null 样例 input（越过 TS 类型的运行时调用方）不应抛未捕获异常中断整批（review P2）", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"x","keywords":[]}' }));
    const svc = makeService(chat);
    const res = await svc.compileAndSample({
      node: "rewrite",
      contractVersion: 1,
      promptVersionId: "pv1",
      promptBody: "{query}",
      modelId: "m1",
      modelParams: { temperature: 0.9, topP: 1 },
      samples: [
        { input: null, runtimeContext: {} },
        { input: { query: "q2", history: "" }, runtimeContext: {} },
      ],
    });
    expect(res.results).toHaveLength(2);
    // rewrite 契约的 fallback(input) 本身会访问 input.query（对 null 抛 TypeError）——
    // 这层未捕获异常被 compileAndSample 新增的 try/catch 隔离转成 INTERNAL_ERROR，
    // 关键断言是：第二个样例的结果没有因第一个样例异常而丢失。
    expect(res.results[0].ok).toBe(false);
    expect(res.results[0].issues[0]).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(res.results[1].ok).toBe(true);
  });
});

// M8 T3：gen_ai.usage.* 落 LLM span（executeStructured 两次尝试求和；stream 逐字段合并）
describe("NodeRuntimeService · gen_ai.usage (M8 T3)", () => {
  let exporter: InMemorySpanExporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    trace.disable();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });
  afterEach(() => trace.disable());

  const attrs = (name: string) => {
    const span = exporter.getFinishedSpans().find((s) => s.name === name);
    if (!span) throw new Error(`span ${name} not found`);
    return span.attributes as Record<string, unknown>;
  };

  it("executeStructured：单次成功 → span 带 usage", async () => {
    const chat = jest.fn(async () => ({
      content: '{"rewrittenQuery":"q","keywords":[]}',
      usage: { inputTokens: 11, outputTokens: 4 },
    }));
    const svc = makeService(chat);
    await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {});
    const a = attrs("node_runtime.execute_structured");
    expect(a["gen_ai.usage.input_tokens"]).toBe(11);
    expect(a["gen_ai.usage.output_tokens"]).toBe(4);
  });

  it("executeStructured：修复重试 → 两次尝试 usage 求和", async () => {
    const chat = jest
      .fn()
      .mockResolvedValueOnce({ content: "不是JSON", usage: { inputTokens: 10, outputTokens: 2 } })
      .mockResolvedValueOnce({
        content: '{"rewrittenQuery":"q","keywords":[]}',
        usage: { inputTokens: 11, outputTokens: 4 },
      });
    const svc = makeService(chat);
    await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {});
    const a = attrs("node_runtime.execute_structured");
    expect(a["gen_ai.usage.input_tokens"]).toBe(21);
    expect(a["gen_ai.usage.output_tokens"]).toBe(6);
  });

  it("streamTextChunks：分帧 usage 逐字段合并落 span（anthropic 式 message_start/delta）", async () => {
    const chatStream = jest.fn(async function* () {
      yield { usage: { inputTokens: 30, outputTokens: 0 } }; // message_start
      yield { delta: "答" };
      yield { usage: { inputTokens: 0, outputTokens: 12 } }; // message_delta
      yield { done: true };
    });
    const svc = makeService(jest.fn(), chatStream);
    const gen = svc.streamTextChunks("reply", 1, "{query}", "m1", { query: "hi", history: "" }, {
      citations: [],
    });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const a = attrs("node_runtime.stream_text");
    expect(a["gen_ai.usage.input_tokens"]).toBe(30);
    expect(a["gen_ai.usage.output_tokens"]).toBe(12);
  });

  it("streamTextChunks(reply) 末值带 usage 与 model 标签", async () => {
    const chatStream = jest.fn(async function* () {
      yield { delta: "答" };
      yield { usage: { inputTokens: 20, outputTokens: 15 } };
      yield { done: true };
    });
    const svc = makeService(jest.fn(), chatStream);
    const it = svc.streamTextChunks(
      "reply",
      1,
      "body {query}",
      "m1",
      { query: "q", history: "", retrievalContext: "" },
      { citations: [] },
      { temperature: 0 },
      undefined,
    );
    let r = await it.next();
    while (!r.done) r = await it.next();
    expect(r.value.usage).toEqual({ inputTokens: 20, outputTokens: 15 });
    expect(r.value.model).toBe("deepseek-chat");
  });

  it("executeStructured 返回 usage", async () => {
    const chat = jest.fn(async () => ({
      content: '{"rewrittenQuery":"q","keywords":[]}',
      usage: { inputTokens: 20, outputTokens: 15 },
    }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "rewrite",
      1,
      "body {query}",
      "m1",
      { query: "q", history: "" },
      {},
      { temperature: 0 },
    );
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 15 });
  });

  it("无 usage → 不 set 属性、不抛", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"q","keywords":[]}' }));
    const svc = makeService(chat);
    await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {});
    const a = attrs("node_runtime.execute_structured");
    expect(a["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(a["gen_ai.usage.output_tokens"]).toBeUndefined();
  });

  // M9：spanEnrich 把 output 派生属性写到 span（intent 路由用它落 rag.intent / rag.route.kb_names）
  it("spanEnrich：成功路径把 output 派生属性写入 span", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"路由查询","keywords":[]}' }));
    const svc = makeService(chat);
    await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {}, {
      spanEnrich: (o) => ({ "rag.intent": (o as { rewrittenQuery: string }).rewrittenQuery }),
    });
    expect(attrs("node_runtime.execute_structured")["rag.intent"]).toBe("路由查询");
  });

  it("spanEnrich 抛错被吞，不影响产出（遥测不得中断请求）", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"q","keywords":[]}' }));
    const svc = makeService(chat);
    const r = await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {}, {
      spanEnrich: () => {
        throw new Error("boom");
      },
    });
    expect(r.output).toMatchObject({ rewrittenQuery: "q" });
  });
});
