import { NotFoundException } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type {
  ChatStreamEvent,
  ResolvedApplicationConfig,
  RetrievalHit,
} from "@codecrush/contracts";
import { OrchestrationService } from "../src/modules/chat/orchestration.service";
import type { ApplicationsService } from "../src/modules/applications/applications.service";
import type { NodeRuntimeService } from "../src/modules/node-runtime/executor/node-runtime.service";
import type { RetrievalService } from "../src/modules/retrieval/retrieval.service";
import type { KnowledgeBasesService } from "../src/modules/knowledge-bases/knowledge-bases.service";
import type { ConversationsService } from "../src/modules/conversations/conversations.service";

function cfg(overrides: Partial<ResolvedApplicationConfig> = {}): ResolvedApplicationConfig {
  const node = (promptBody: string) => ({
    promptVersionId: "pv1",
    promptBody,
    contractVersion: 1,
    modelId: "m1",
    freedom: "balanced" as const,
    temperature: 0.7,
    topP: 1,
  });
  return {
    applicationId: "app1",
    slug: "aftersale",
    configVersionId: "cv1",
    version: 1,
    kbIds: ["kb_a", "kb_b"],
    nodes: {
      rewrite: node("改写正文"),
      intent: node("意图正文"),
      reply: node("回复正文"),
      fallback: node("很抱歉，没有找到相关答案。"),
    },
    retrieval: {
      schemaVersion: 1,
      topK: 10,
      topN: 5,
      hybridEnabled: true,
      vectorWeight: 0.7,
      rerankEnabled: false,
    },
    fallback: { toHuman: true },
    preview: false,
    ...overrides,
  };
}

function hit(chunkId: string, finalScore: number): RetrievalHit {
  return {
    chunkId,
    docId: `doc_${chunkId}`,
    docName: `${chunkId}.pdf`,
    text: `内容 ${chunkId}`,
    section: `节 ${chunkId}`,
    vecScore: finalScore,
    finalScore,
  };
}

const KB_ROWS = [
  { id: "kb_a", name: "售后库", desc: "退换货", embeddingModelId: "emb1", intentKey: "SUPPORT" },
  { id: "kb_b", name: "通用库", desc: "", embeddingModelId: "emb1", intentKey: null },
];

/** drain generator：累加 token、收集 citation、读 done/error 事件。 */
async function collect(gen: AsyncGenerator<ChatStreamEvent>) {
  const events: ChatStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  const tokens = events.filter((e): e is Extract<ChatStreamEvent, { type: "token" }> => e.type === "token");
  const citations = events.filter(
    (e): e is Extract<ChatStreamEvent, { type: "citation" }> => e.type === "citation",
  );
  const done = events.find((e): e is Extract<ChatStreamEvent, { type: "done" }> => e.type === "done");
  const error = events.find((e): e is Extract<ChatStreamEvent, { type: "error" }> => e.type === "error");
  return { events, replyText: tokens.map((t) => t.delta).join(""), tokens, citations, done, error };
}

function makeDeps() {
  const applications = { resolvePublic: jest.fn(async () => cfg()) };
  const nodeRuntime = {
    executeStructured: jest.fn(async (node: string) => {
      if (node === "rewrite")
        return {
          output: { rewrittenQuery: "改写后的退货问题", keywords: [] },
          fallbackUsed: false,
          validateSteps: [],
        };
      return { output: { intent: "SUPPORT", confidence: 0.9 }, fallbackUsed: false, validateSteps: [] };
    }),
    // reply 走 streamTextChunks（逐 token）——默认吐两段拼成 "答案[1][2]"
    streamTextChunks: jest.fn(async function* () {
      yield { delta: "答案" };
      yield { delta: "[1][2]" };
      return { outcome: "ok", text: "答案[1][2]" };
    }),
    // streamText 仅 fallback 路径调用（整段）
    streamText: jest.fn(async (node: string) =>
      node === "reply"
        ? { text: "答案[1][2]", fallbackUsed: false }
        : { text: "很抱歉，没有找到相关答案。", fallbackUsed: false },
    ),
  };
  const retrieval = {
    test: jest.fn(async (req: { kbId: string }) => ({
      hits: req.kbId === "kb_a" ? [hit("a1", 0.9)] : [hit("b1", 0.8)],
    })),
  };
  const kbs = { findByIds: jest.fn(async () => KB_ROWS) };
  const conversations = {
    createConversation: jest.fn(async () => ({
      id: "conv1",
      agentId: "app1",
      title: "t",
      updatedAt: new Date().toISOString(),
    })),
    // 默认：任意 convId 都视为属于 app1（多数用例场景）；跨 agentId 用例单独 mock 覆盖。
    get: jest.fn(async (id: string) => ({
      id,
      agentId: "app1",
      title: "t",
      updatedAt: new Date().toISOString(),
    })),
    appendMessage: jest.fn(async (input: object) => ({ id: "m1", ...input })),
    listMessages: jest.fn(async () => []),
  };
  return { applications, nodeRuntime, retrieval, kbs, conversations };
}

function makeSvc(d: ReturnType<typeof makeDeps>): OrchestrationService {
  return new OrchestrationService(
    d.applications as unknown as ApplicationsService,
    d.nodeRuntime as unknown as NodeRuntimeService,
    d.retrieval as unknown as RetrievalService,
    d.kbs as unknown as KnowledgeBasesService,
    d.conversations as unknown as ConversationsService,
  );
}

describe("OrchestrationService.run（AsyncGenerator 逐 token）", () => {
  it("正常路径：逐 token（多个 token 事件）+ citation×2 + coverage=full + 落库 user+assistant", async () => {
    const d = makeDeps();
    const r = await collect(makeSvc(d).run("app1", "怎么退货", undefined, "u1"));
    // 逐 token：两个 token 事件而非一个整段
    expect(r.tokens).toHaveLength(2);
    expect(r.replyText).toBe("答案[1][2]");
    expect(r.citations.map((e) => e.citation.n)).toEqual([1, 2]);
    expect(r.citations[0].citation.kb).toBe("售后库");
    expect(r.done).toBeDefined();
    expect(r.done!.isFallback).toBe(false);
    expect(r.done!.fallbackReasons).toEqual([]);
    expect(r.done!.coverage).toBe("full");
    expect(r.done!.confidence).toBeCloseTo(0.9);
    expect(r.done!.traceId).toHaveLength(32);
    // 事件顺序：末位是 done
    expect(r.events[r.events.length - 1].type).toBe("done");
    // reply 走 streamTextChunks，不走 streamText
    expect(d.nodeRuntime.streamTextChunks).toHaveBeenCalled();
    // 检索用改写后的 query，SUPPORT → kb_a(绑定) + kb_b(未绑定通配)
    expect(d.retrieval.test).toHaveBeenCalledTimes(2);
    expect(d.retrieval.test.mock.calls[0][0]).toMatchObject({
      query: "改写后的退货问题",
      kbId: "kb_a",
      embedModelId: "emb1",
    });
    // 落库
    expect(d.conversations.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "app1", userId: "u1" }),
    );
    expect(d.conversations.appendMessage).toHaveBeenCalledTimes(2);
    const assistant = d.conversations.appendMessage.mock.calls[1][0] as Record<string, unknown>;
    expect(assistant).toMatchObject({
      role: "assistant",
      coverage: "full",
      isFallback: false,
      citations: ["1", "2"],
    });
  });

  it("M8 T4：citation 事件带命中段正文 text=h.text", async () => {
    const d = makeDeps();
    const r = await collect(makeSvc(d).run("app1", "怎么退货", undefined, "u1"));
    expect(r.citations[0].citation.text).toBe("内容 a1"); // hit("a1",…).text = `内容 a1`
  });

  it("M8 T4：done 事件带新建会话 convId（createConversation → conv1）", async () => {
    const d = makeDeps();
    const r = await collect(makeSvc(d).run("app1", "怎么退货", undefined, "u1"));
    expect(r.done!.convId).toBe("conv1");
  });

  it("intent=UNKNOWN → 全 KB 回退召回（reply 分支）", async () => {
    const d = makeDeps();
    d.nodeRuntime.executeStructured.mockImplementation(async (node: string) =>
      node === "rewrite"
        ? { output: { rewrittenQuery: "q2", keywords: [] }, fallbackUsed: false, validateSteps: [] }
        : { output: { intent: "UNKNOWN", confidence: 0 }, fallbackUsed: true, validateSteps: [] },
    );
    await collect(makeSvc(d).run("app1", "天书问题"));
    const kbIds = d.retrieval.test.mock.calls.map((c) => (c[0] as { kbId: string }).kbId);
    expect(kbIds.sort()).toEqual(["kb_a", "kb_b"]);
  });

  it("intent=CHAT → 不检索，直走 fallback 节点（整段 streamText），reasons=[chitchat,handled_by_fallback]", async () => {
    const d = makeDeps();
    d.nodeRuntime.executeStructured.mockImplementation(async (node: string) =>
      node === "rewrite"
        ? { output: { rewrittenQuery: "你好", keywords: [] }, fallbackUsed: false, validateSteps: [] }
        : { output: { intent: "CHAT", confidence: 0.95 }, fallbackUsed: false, validateSteps: [] },
    );
    const r = await collect(makeSvc(d).run("app1", "你好"));
    expect(d.retrieval.test).not.toHaveBeenCalled();
    // fallback 走 streamText（整段），不走 streamTextChunks
    expect(d.nodeRuntime.streamText).toHaveBeenCalledWith(
      "fallback",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(d.nodeRuntime.streamTextChunks).not.toHaveBeenCalled();
    expect(r.done!.isFallback).toBe(true);
    expect(r.done!.fallbackReasons).toEqual(["chitchat", "handled_by_fallback"]);
    expect(r.done!.coverage).toBe("partial");
    expect(r.citations).toHaveLength(0);
  });

  it("低分 → isFallback + low_similarity + fallback 节点（fallbackInfo 落库）", async () => {
    const d = makeDeps();
    d.retrieval.test.mockImplementation(async (req: { kbId: string }) => ({
      hits: req.kbId === "kb_a" ? [hit("a1", 0.1)] : [],
    }));
    const r = await collect(makeSvc(d).run("app1", "怎么退货"));
    expect(r.done!.isFallback).toBe(true);
    expect(r.done!.fallbackReasons).toContain("low_similarity");
    expect(r.done!.fallbackReasons).toContain("handled_by_fallback");
    expect(r.done!.coverage).toBe("partial");
    // fallbackInfo 在落库的 assistant 消息里（done 事件不带 fallbackInfo）
    const assistant = d.conversations.appendMessage.mock.calls[1][0] as {
      fallbackInfo: { topScore?: number; threshold?: number; scopeKbNames?: string[] };
    };
    expect(assistant.fallbackInfo.topScore).toBeCloseTo(0.1);
    expect(assistant.fallbackInfo.threshold).toBeCloseTo(0.2);
    expect(assistant.fallbackInfo.scopeKbNames).toEqual(["售后库", "通用库"]);
    const streamNodes = d.nodeRuntime.streamText.mock.calls.map((c) => c[0]);
    expect(streamNodes).toEqual(["fallback"]);
    expect(d.nodeRuntime.streamTextChunks).not.toHaveBeenCalled();
  });

  it("空召回 → empty_retrieval + fallback，无 citation", async () => {
    const d = makeDeps();
    d.retrieval.test.mockResolvedValue({ hits: [] });
    const r = await collect(makeSvc(d).run("app1", "怎么退货"));
    expect(r.done!.isFallback).toBe(true);
    expect(r.done!.fallbackReasons).toContain("empty_retrieval");
    expect(r.citations).toHaveLength(0);
  });

  it("rewrite 降级 → 用原 query 继续检索", async () => {
    const d = makeDeps();
    d.nodeRuntime.executeStructured.mockImplementation(async (node: string) =>
      node === "rewrite"
        ? { output: { rewrittenQuery: "怎么退货", keywords: [] }, fallbackUsed: true, validateSteps: [] }
        : { output: { intent: "SUPPORT", confidence: 0.9 }, fallbackUsed: false, validateSteps: [] },
    );
    await collect(makeSvc(d).run("app1", "怎么退货"));
    expect(d.retrieval.test.mock.calls[0][0]).toMatchObject({ query: "怎么退货" });
  });

  it("resolvePublic 抛（未上线）→ 首个 next() 冒泡异常", async () => {
    const d = makeDeps();
    d.applications.resolvePublic.mockRejectedValue(new NotFoundException("应用未上线"));
    await expect(collect(makeSvc(d).run("appX", "q"))).rejects.toThrow("未上线");
  });

  it("落库异常兜住不冒泡：appendMessage 抛仍产出完整回答（AGENTS.md 边界 7）", async () => {
    const d = makeDeps();
    d.conversations.appendMessage.mockRejectedValue(new Error("db down"));
    const r = await collect(makeSvc(d).run("app1", "怎么退货"));
    expect(r.replyText).toBe("答案[1][2]");
    expect(r.done!.isFallback).toBe(false);
  });

  it("传入 convId → 不新建会话，历史注入 rewrite", async () => {
    const d = makeDeps();
    d.conversations.listMessages.mockResolvedValue([
      { id: "m0", convId: "conv9", role: "user", content: "上一个问题" },
      { id: "m0b", convId: "conv9", role: "assistant", content: "上一个回答" },
    ]);
    await collect(makeSvc(d).run("app1", "接着问", "conv9", "u1"));
    expect(d.conversations.createConversation).not.toHaveBeenCalled();
    const rewriteCall = d.nodeRuntime.executeStructured.mock.calls.find((c) => c[0] === "rewrite")!;
    expect((rewriteCall[4] as { history?: string }).history).toContain("上一个问题");
  });

  it("convId 属于别的 agentId → 拒绝跨应用复用，不读其历史、不写其消息，改新建会话（review P2）", async () => {
    const d = makeDeps();
    d.conversations.get.mockResolvedValue({
      id: "conv9",
      agentId: "app2", // 属于另一应用
      title: "别的应用的会话",
      updatedAt: new Date().toISOString(),
    });
    d.conversations.listMessages.mockResolvedValue([
      { id: "m0", convId: "conv9", role: "user", content: "app2 的私密问题" },
    ]);
    await collect(makeSvc(d).run("app1", "接着问", "conv9", "u1"));
    // 不读别的应用的历史
    expect(d.conversations.listMessages).not.toHaveBeenCalled();
    const rewriteCall = d.nodeRuntime.executeStructured.mock.calls.find((c) => c[0] === "rewrite")!;
    expect((rewriteCall[4] as { history?: string }).history).toBeUndefined();
    // 不写别的应用的会话：改为新建会话，消息落库到新 convId
    expect(d.conversations.createConversation).toHaveBeenCalled();
    const userMsg = d.conversations.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(userMsg.convId).toBe("conv1");
  });

  it("新建会话后 appendMessage 失败 → 仍产出完整回答，不冒泡（边界 7 / review P3）", async () => {
    const d = makeDeps();
    d.conversations.appendMessage.mockRejectedValueOnce(new Error("db down"));
    const r = await collect(makeSvc(d).run("app1", "怎么退货")); // 不传 convId → 触发新建
    expect(d.conversations.createConversation).toHaveBeenCalledTimes(1);
    expect(r.replyText).toBe("答案[1][2]"); // 仍正常产出回答
    expect(r.done).toBeDefined();
  });

  it("首 token 超时 → error 事件、无 done、chain span 记 ERROR（不阻塞流的既有断言）", async () => {
    const d = makeDeps();
    d.nodeRuntime.streamTextChunks.mockImplementation(async function* () {
      return { outcome: "timeout" };
    });
    const r = await collect(makeSvc(d).run("app1", "怎么退货"));
    expect(r.error).toBeDefined();
    expect(r.done).toBeUndefined();
  });

  it("客户端 abort（gen.return）→ 落已产出部分 + 级联 return reply 迭代器（AC6 cascade）", async () => {
    const d = makeDeps();
    let replyReturned = false;
    d.nodeRuntime.streamTextChunks.mockImplementation(() => {
      const inner = (async function* () {
        yield { delta: "答" };
        yield { delta: "案" };
        return { outcome: "ok", text: "答案" };
      })();
      const orig = inner.return.bind(inner);
      inner.return = ((v?: unknown) => {
        replyReturned = true;
        return orig(v as never);
      }) as never;
      return inner;
    });
    const gen = makeSvc(d).run("app1", "怎么退货");
    // reply 分支：先 2 个 citation，再 token。拉到第一个 token 后 abort。
    await gen.next(); // citation 1
    await gen.next(); // citation 2
    const t = await gen.next(); // token "答"
    expect(t.value).toMatchObject({ type: "token", delta: "答" });
    await gen.return(undefined); // 模拟客户端断连 → finally 落部分 + 级联 return
    // 级联：reply 迭代器被 return（→ streamTextChunks finally → reader.cancel + reply span end）
    expect(replyReturned).toBe(true);
    // 落部分 assistant 内容
    const assistantCall = d.conversations.appendMessage.mock.calls.find(
      (c) => (c[0] as { role: string }).role === "assistant",
    );
    expect(assistantCall).toBeDefined();
    expect((assistantCall![0] as { content: string }).content).toBe("答");
  });

  it("reply 首帧后 infra 失败（streamTextChunks 抛）→ error 事件收尾、无 done，不截断（review Finding 2）", async () => {
    const d = makeDeps();
    d.nodeRuntime.streamTextChunks.mockImplementation(
      // 模拟 reply 模型不可解析：generator 首个 next() 即抛（resolveModel 抛）
      (() =>
        (async function* () {
          throw new Error("model gone");
        })()) as never,
    );
    const r = await collect(makeSvc(d).run("app1", "怎么退货"));
    // citations 已在抛错前 flush，随后 error 收尾、无 done
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.error).toBeDefined();
    expect(r.done).toBeUndefined();
    // 仍落库（部分/空 assistant），trace 可对齐
    const assistantCall = d.conversations.appendMessage.mock.calls.find(
      (c) => (c[0] as { role: string }).role === "assistant",
    );
    expect(assistantCall).toBeDefined();
  });
});

// M8 T3：chain span 写侧富化——codecrush.io.input/output + 四质量布尔（所有结束路径写一次）。
// chain span 经 startManualSpan 直接 setAttribute（无子 span 挂父需求），故只需 InMemorySpanExporter。
describe("OrchestrationService · chain span 质量信号 + IO (M8 T3)", () => {
  let exporter: InMemorySpanExporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    trace.disable();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });
  afterEach(() => trace.disable());

  const chainAttrs = () => {
    const span = exporter.getFinishedSpans().find((s) => s.name === "rag.pipeline");
    if (!span) throw new Error("rag.pipeline span not found");
    return span.attributes as Record<string, unknown>;
  };

  it("正常问答 → io.input/output 记录，四质量布尔全 false", async () => {
    const d = makeDeps();
    await collect(makeSvc(d).run("app1", "怎么退货", undefined, "u1"));
    const a = chainAttrs();
    expect(a["codecrush.io.input"]).toBe("怎么退货");
    expect(a["codecrush.io.output"]).toBe("答案[1][2]");
    expect(a["rag.quality.low_recall"]).toBe(false);
    expect(a["rag.quality.no_citations"]).toBe(false);
    expect(a["rag.quality.refusal"]).toBe(false);
    expect(a["rag.quality.timeout"]).toBe(false);
  });

  it("低分兜底 → refusal + low_recall + no_citations 为 true", async () => {
    const d = makeDeps();
    // 两 KB 命中最高分均 < FALLBACK_THRESHOLD(0.2) → decideFallback 判 low_similarity → 兜底
    d.retrieval.test = jest.fn(async (req: { kbId: string }) => ({
      hits: [hit(`${req.kbId}_low`, 0.1)],
    }));
    await collect(makeSvc(d).run("app1", "无关问题", undefined, "u1"));
    const a = chainAttrs();
    expect(a["rag.quality.refusal"]).toBe(true);
    expect(a["rag.quality.low_recall"]).toBe(true);
    expect(a["rag.quality.no_citations"]).toBe(true);
    expect(a["rag.quality.timeout"]).toBe(false);
  });

  it("reply 节点契约降级（检索过阈但 reply 出兜底）→ refusal=true（low_recall/no_citations 仍 false）", async () => {
    const d = makeDeps();
    // 检索正常有命中（走 reply 分支），但 reply 模型输出未过契约 → streamTextChunks 返回 fallback
    d.nodeRuntime.streamTextChunks = jest.fn(async function* () {
      return { outcome: "fallback", text: "很抱歉，暂时无法回答。" };
    });
    await collect(makeSvc(d).run("app1", "怎么退货", undefined, "u1"));
    const a = chainAttrs();
    expect(a["rag.quality.refusal"]).toBe(true); // 生成拒答（review Finding 1）
    expect(a["rag.quality.low_recall"]).toBe(false); // 检索本身过阈
    expect(a["rag.quality.no_citations"]).toBe(false); // 有引用
    expect(a["codecrush.io.output"]).toBe("很抱歉，暂时无法回答。");
  });
});
