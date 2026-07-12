import { NotFoundException } from "@nestjs/common";
import type { ResolvedApplicationConfig, RetrievalHit } from "@codecrush/contracts";
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

describe("OrchestrationService.run", () => {
  it("正常路径：带引用回答 + coverage=full + 落库 user+assistant", async () => {
    const d = makeDeps();
    const r = await makeSvc(d).run("app1", "怎么退货", undefined, "u1");
    expect(r.isFallback).toBe(false);
    expect(r.fallbackReasons).toEqual([]);
    expect(r.citations.map((c) => c.n)).toEqual([1, 2]);
    expect(r.citations[0].kb).toBe("售后库");
    expect(r.coverage).toBe("full");
    expect(r.confidence).toBeCloseTo(0.9);
    expect(r.replyText).toBe("答案[1][2]");
    expect(r.traceId).toHaveLength(32);
    expect(r.convId).toBe("conv1");
    // 检索用改写后的 query，SUPPORT → kb_a(绑定) + kb_b(未绑定通配)
    expect(d.retrieval.test).toHaveBeenCalledTimes(2);
    expect(d.retrieval.test.mock.calls[0][0]).toMatchObject({
      query: "改写后的退货问题",
      kbId: "kb_a",
      embedModelId: "emb1",
    });
    expect(d.conversations.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "app1", userId: "u1" }),
    );
    expect(d.conversations.appendMessage).toHaveBeenCalledTimes(2);
    const assistant = d.conversations.appendMessage.mock.calls[1][0] as Record<string, unknown>;
    expect(assistant).toMatchObject({
      convId: "conv1",
      role: "assistant",
      coverage: "full",
      isFallback: false,
      citations: ["1", "2"],
    });
  });

  it("intent=UNKNOWN → 全 KB 回退召回", async () => {
    const d = makeDeps();
    d.nodeRuntime.executeStructured.mockImplementation(async (node: string) =>
      node === "rewrite"
        ? { output: { rewrittenQuery: "q2", keywords: [] }, fallbackUsed: false, validateSteps: [] }
        : { output: { intent: "UNKNOWN", confidence: 0 }, fallbackUsed: true, validateSteps: [] },
    );
    await makeSvc(d).run("app1", "天书问题");
    const kbIds = d.retrieval.test.mock.calls.map((c) => (c[0] as { kbId: string }).kbId);
    expect(kbIds.sort()).toEqual(["kb_a", "kb_b"]);
  });

  it("intent=CHAT → 不检索，直走 fallback 节点，reasons=[chitchat,handled_by_fallback]", async () => {
    const d = makeDeps();
    d.nodeRuntime.executeStructured.mockImplementation(async (node: string) =>
      node === "rewrite"
        ? { output: { rewrittenQuery: "你好", keywords: [] }, fallbackUsed: false, validateSteps: [] }
        : { output: { intent: "CHAT", confidence: 0.95 }, fallbackUsed: false, validateSteps: [] },
    );
    const r = await makeSvc(d).run("app1", "你好");
    expect(d.retrieval.test).not.toHaveBeenCalled();
    expect(d.nodeRuntime.streamText).toHaveBeenCalledWith(
      "fallback",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(r.isFallback).toBe(true);
    expect(r.fallbackReasons).toEqual(["chitchat", "handled_by_fallback"]);
    expect(r.coverage).toBe("partial");
    expect(r.citations).toEqual([]);
  });

  it("低分 → isFallback + low_similarity + fallback 节点", async () => {
    const d = makeDeps();
    d.retrieval.test.mockImplementation(async (req: { kbId: string }) => ({
      hits: req.kbId === "kb_a" ? [hit("a1", 0.1)] : [],
    }));
    const r = await makeSvc(d).run("app1", "怎么退货");
    expect(r.isFallback).toBe(true);
    expect(r.fallbackReasons).toContain("low_similarity");
    expect(r.fallbackReasons).toContain("handled_by_fallback");
    expect(r.fallbackInfo.topScore).toBeCloseTo(0.1);
    expect(r.fallbackInfo.threshold).toBeCloseTo(0.2);
    expect(r.fallbackInfo.scopeKbNames).toEqual(["售后库", "通用库"]);
    expect(r.coverage).toBe("partial");
    const streamNodes = d.nodeRuntime.streamText.mock.calls.map((c) => c[0]);
    expect(streamNodes).toEqual(["fallback"]);
  });

  it("空召回 → empty_retrieval + fallback", async () => {
    const d = makeDeps();
    d.retrieval.test.mockResolvedValue({ hits: [] });
    const r = await makeSvc(d).run("app1", "怎么退货");
    expect(r.isFallback).toBe(true);
    expect(r.fallbackReasons).toContain("empty_retrieval");
    expect(r.citations).toEqual([]);
  });

  it("rewrite 降级 → 用原 query 继续检索", async () => {
    const d = makeDeps();
    d.nodeRuntime.executeStructured.mockImplementation(async (node: string) =>
      node === "rewrite"
        ? { output: { rewrittenQuery: "怎么退货", keywords: [] }, fallbackUsed: true, validateSteps: [] }
        : { output: { intent: "SUPPORT", confidence: 0.9 }, fallbackUsed: false, validateSteps: [] },
    );
    await makeSvc(d).run("app1", "怎么退货");
    expect(d.retrieval.test.mock.calls[0][0]).toMatchObject({ query: "怎么退货" });
  });

  it("resolvePublic 抛（未上线）→ run 冒泡异常", async () => {
    const d = makeDeps();
    d.applications.resolvePublic.mockRejectedValue(new NotFoundException("应用未上线"));
    await expect(makeSvc(d).run("appX", "q")).rejects.toThrow("未上线");
  });

  it("落库异常兜住不冒泡：appendMessage 抛仍返回回答（AGENTS.md 边界 7）", async () => {
    const d = makeDeps();
    d.conversations.appendMessage.mockRejectedValue(new Error("db down"));
    const r = await makeSvc(d).run("app1", "怎么退货");
    expect(r.replyText).toBe("答案[1][2]");
    expect(r.isFallback).toBe(false);
  });

  it("传入 convId → 不新建会话，历史注入 rewrite", async () => {
    const d = makeDeps();
    d.conversations.listMessages.mockResolvedValue([
      { id: "m0", convId: "conv9", role: "user", content: "上一个问题" },
      { id: "m0b", convId: "conv9", role: "assistant", content: "上一个回答" },
    ]);
    const r = await makeSvc(d).run("app1", "接着问", "conv9", "u1");
    expect(d.conversations.createConversation).not.toHaveBeenCalled();
    expect(r.convId).toBe("conv9");
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
    const r = await makeSvc(d).run("app1", "接着问", "conv9", "u1");
    // 不读别的应用的历史：既不调用 listMessages("conv9")，也不把其内容注入 rewrite
    expect(d.conversations.listMessages).not.toHaveBeenCalled();
    const rewriteCall = d.nodeRuntime.executeStructured.mock.calls.find((c) => c[0] === "rewrite")!;
    expect((rewriteCall[4] as { history?: string }).history).toBeUndefined();
    // 不写别的应用的会话：改为新建会话，消息落库到新 convId
    expect(d.conversations.createConversation).toHaveBeenCalled();
    expect(r.convId).toBe("conv1"); // makeDeps 的 createConversation 桩固定返回 conv1
    expect(r.convId).not.toBe("conv9");
    const userMsg = d.conversations.appendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(userMsg.convId).toBe("conv1");
  });

  it("新建会话后 appendMessage 失败 → 仍返回刚创建的 convId，不丢失（review P3）", async () => {
    const d = makeDeps();
    d.conversations.appendMessage.mockRejectedValueOnce(new Error("db down"));
    const r = await makeSvc(d).run("app1", "怎么退货"); // 不传 convId → 触发新建
    expect(d.conversations.createConversation).toHaveBeenCalledTimes(1);
    expect(r.convId).toBe("conv1"); // 而非 undefined
    expect(r.replyText).toBe("答案[1][2]"); // 边界7：仍正常返回回答
  });
});
