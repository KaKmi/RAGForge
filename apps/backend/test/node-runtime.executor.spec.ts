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
    chatStream: chatStream ?? jest.fn(),
    get: jest.fn(async () => ({ id: "m1", protocol: "openai_compat", type: "llm" })),
  } as unknown as ModelsService;
  return new NodeRuntimeService(models);
}

describe("NodeRuntimeService.executeStructured · rewrite", () => {
  it("首次即合法 JSON → fallbackUsed:false，validateSteps 全 ok", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"改写后","keywords":["a"]}' }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "rewrite", 1, "改写：{query}", "m1", { query: "原问题", history: "" }, {},
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
    const res = await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {});
    expect(res.fallbackUsed).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(res.validateSteps.some((s) => s.step === "repair" && s.ok)).toBe(true);
  });

  it("两次都非法 → fallback，最多两次调用（原始+1次修复，不递归）", async () => {
    const chat = jest.fn(async () => ({ content: "不是 JSON" }));
    const svc = makeService(chat);
    const res = await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "原始问题", history: "" }, {});
    expect(res.output).toEqual({ rewrittenQuery: "原始问题", keywords: [] });
    expect(res.fallbackUsed).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("temperature 透传给 models.chat（Playground Slider 值不能被静默丢弃）", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"x","keywords":[]}' }));
    const svc = makeService(chat);
    await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {}, { temperature: 1.2 });
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
    const res = await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "", history: "" }, {});
    expect(res.fallbackUsed).toBe(true);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("NodeRuntimeService.executeStructured · reservedDataSchema 校验（review round 1）", () => {
  it("intent 节点 reserved 缺 availableRoutes（optional 字段，TS 层不拦截）→ 优雅降级 fallback，不抛未捕获异常，不调用 chat", async () => {
    const chat = jest.fn();
    const svc = makeService(chat);
    // reservedDataSchema 要求 availableRoutes: string[]（非 optional），传入 {} 应该
    // 在 extraValidate 访问 reserved.availableRoutes.includes(...) 抛 TypeError 之前
    // 就被 reservedDataSchema.safeParse 拦下来。
    const res = await svc.executeStructured(
      "intent", 1, "{query}", "m1", { query: "q", history: "" }, {} as never,
    );
    expect(res.fallbackUsed).toBe(true);
    expect(res.output).toEqual({ intent: "unknown", routeIds: [], confidence: 0 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("rewrite 节点：reserved 携带共享 RuntimeContext 的额外字段（如 preview）不应被拒绝——真实模型必须被调用（review round 2 回归）", async () => {
    const chat = jest.fn(async () => ({ content: '{"rewrittenQuery":"改写后","keywords":[]}' }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "rewrite", 1, "{query}", "m1", { query: "q", history: "" }, { preview: true } as never,
    );
    expect(chat).toHaveBeenCalledTimes(1);
    expect(res.fallbackUsed).toBe(false);
    expect(res.output).toEqual({ rewrittenQuery: "改写后", keywords: [] });
  });

  it("input 校验失败与 reserved 校验失败在 validateSteps 里标记为不同的 step（review round 2）", async () => {
    const chat = jest.fn();
    const svc = makeService(chat);
    const badInput = await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "", history: "" }, {});
    expect(badInput.validateSteps.find((s) => !s.ok)?.step).toBe("input");

    const badReserved = await svc.executeStructured(
      "intent", 1, "{query}", "m1", { query: "q", history: "" }, {} as never,
    );
    expect(badReserved.validateSteps.find((s) => !s.ok)?.step).toBe("reserved");
  });
});

describe("NodeRuntimeService.executeStructured · validateSteps 区分失败阶段（review round 1）", () => {
  it("模型输出非法 JSON → 首次失败步骤标记为 output_schema", async () => {
    const chat = jest.fn(async () => ({ content: "不是 JSON" }));
    const svc = makeService(chat);
    const res = await svc.executeStructured("rewrite", 1, "{query}", "m1", { query: "q", history: "" }, {});
    expect(res.validateSteps.find((s) => s.ok === false)?.step).toBe("output_schema");
  });

  it("模型输出结构合法但 extraValidate 越权 → 首次失败步骤标记为 extra_validate（而非笼统的 output_schema）", async () => {
    const chat = jest.fn(async () => ({
      content: '{"intent":"售后","routeIds":["kb_illegal"],"confidence":0.9}',
    }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "intent", 1, "{query}", "m1", { query: "q", history: "" }, { availableRoutes: ["kb_a"] },
    );
    expect(res.validateSteps.find((s) => s.step === "extra_validate")).toBeDefined();
  });
});

describe("NodeRuntimeService.executeStructured · intent extraValidate", () => {
  it("routeIds 越权 → 修复重试；仍越权 → fallback unknown", async () => {
    const chat = jest.fn(async () => ({
      content: '{"intent":"售后","routeIds":["kb_illegal"],"confidence":0.9}',
    }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "intent", 1, "{query}", "m1",
      { query: "q", history: "" },
      { availableRoutes: ["kb_a"] },
    );
    expect(res.fallbackUsed).toBe(true);
    expect(res.output).toEqual({ intent: "unknown", routeIds: [], confidence: 0 });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("routeIds 合法 → 直接通过，不触发修复", async () => {
    const chat = jest.fn(async () => ({
      content: '{"intent":"售后","routeIds":["kb_a"],"confidence":0.9}',
    }));
    const svc = makeService(chat);
    const res = await svc.executeStructured(
      "intent", 1, "{query}", "m1",
      { query: "q", history: "" },
      { availableRoutes: ["kb_a"] },
    );
    expect(res.fallbackUsed).toBe(false);
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
    const svc = makeService(jest.fn(), jest.fn(() => gen()));
    const res = await svc.streamText(
      "reply", 1, "回答：{query}", "m1",
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
    const svc = makeService(jest.fn(), jest.fn(() => gen()));
    const res = await svc.streamText(
      "reply", 1, "{query}", "m1",
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
    const svc = makeService(jest.fn(), jest.fn(() => gen()));
    const res = await svc.streamText(
      "reply", 1, "{query}", "m1",
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
      "reply", 1, "{query}", "m1",
      { query: "q", history: "", retrievalContext: "" },
      { citations: [] },
      { temperature: 0.3 },
    );
    expect(chatStream.mock.calls[0][2]).toMatchObject({ temperature: 0.3 });
  });

  it("fallback 节点：永不调用模型，直接返回固定文案", async () => {
    const chatStream = jest.fn();
    const svc = makeService(jest.fn(), chatStream);
    const res = await svc.streamText("fallback", 1, "{query}", "m1", { query: "q", reason: "超纲" }, {});
    expect(chatStream).not.toHaveBeenCalled();
    expect(res.fallbackUsed).toBe(true);
    expect(res.text.length).toBeGreaterThan(0);
  });
});

describe("NodeRuntimeService.compileAndSample", () => {
  it("多样例聚合：2 合法 + 1 intent 越权 → results 长度一致，越权样例 ok:false", async () => {
    const chat = jest
      .fn()
      .mockResolvedValueOnce({ content: '{"intent":"售后","routeIds":["kb_a"],"confidence":0.9}' })
      .mockResolvedValueOnce({ content: '{"intent":"售后","routeIds":["kb_illegal"],"confidence":0.9}' })
      .mockResolvedValueOnce({ content: '{"intent":"售后","routeIds":["kb_illegal"],"confidence":0.9}' })
      .mockResolvedValueOnce({ content: '{"intent":"售前","routeIds":["kb_b"],"confidence":0.8}' });
    const svc = makeService(chat);
    const res = await svc.compileAndSample({
      node: "intent",
      contractVersion: 1,
      promptVersionId: "pv1",
      promptBody: "{query}",
      modelId: "m1",
      modelParams: { temperature: 0.7, topP: 1 },
      samples: [
        { input: { query: "q1", history: "" }, runtimeContext: { availableRoutes: ["kb_a"] } },
        { input: { query: "q2", history: "" }, runtimeContext: { availableRoutes: ["kb_a"] } },
        { input: { query: "q3", history: "" }, runtimeContext: { availableRoutes: ["kb_b"] } },
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
        { input: { query: "q1", history: "", retrievalContext: "" }, runtimeContext: { citations: [] } },
      ],
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].ok).toBe(true);
  });
});
