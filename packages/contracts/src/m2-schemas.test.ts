import { describe, expect, it } from "vitest";
import {
  AgentSchema,
  ChatRequestSchema,
  ChatStreamEventSchema,
  ChunkListResponseSchema,
  ChunkSchema,
  ConversationSchema,
  CreateAgentRequestSchema,
  CreateDocumentRequestSchema,
  CreateKnowledgeBaseRequestSchema,
  CreateModelRequestSchema,
  CreatePromptVersionRequestSchema,
  DocumentListResponseSchema,
  DocumentSchema,
  EvalRunSchema,
  EvalSetSchema,
  IngestionStatusSchema,
  KnowledgeBaseSchema,
  MessageListResponseSchema,
  MessageSchema,
  ModelProviderSchema,
  PaginatedResponseSchema,
  PromptSchema,
  PromptVersionSchema,
  RetrievalTestRequestSchema,
  RetrievalTestResponseSchema,
  UpdateAgentRequestSchema,
  UpdateChunkEnabledRequestSchema,
} from "./index";

const valid = {
  model: {
    id: "m1",
    type: "llm",
    provider: "DeepSeek",
    name: "deepseek-v3",
    baseUrl: "https://api.deepseek.com",
    apiKeyMasked: "sk-****1234",
    role: "回复生成（主）",
    enabled: true,
  },
  kb: {
    id: "kb1",
    name: "售后服务知识库",
    desc: "售后政策与流程",
    embeddingModelId: "m2",
    docsCount: 86,
    chunksCount: 3412,
    status: "ready",
    updatedAt: "2026-06-30T00:00:00.000Z",
  },
  doc: {
    id: "d1",
    kbId: "kb1",
    name: "退换货政策.pdf",
    type: "pdf",
    size: 102400,
    chunksCount: 24,
    status: "ready",
    blobKey: "blob/d1",
    updatedAt: "2026-06-30T00:00:00.000Z",
  },
  chunk: {
    id: "c1",
    docId: "d1",
    kbId: "kb1",
    seq: 0,
    text: "7天无理由退货...",
    tokenCount: 128,
    section: "退换货政策 > 退货条件",
    enabled: true,
  },
  retrievalReq: {
    query: "退货流程",
    kbId: "kb1",
    embedModelId: "m2",
    topK: 20,
    threshold: 0.2,
    multi: true,
  },
  retrievalHit: {
    chunkId: "c1",
    docId: "d1",
    docName: "退换货政策.pdf",
    text: "7天无理由退货...",
    section: "退货条件",
    vecScore: 0.82,
    finalScore: 0.82,
  },
  agent: {
    id: "aftersale",
    name: "售后助手",
    desc: "售后问答",
    status: "active",
    kbs: ["kb1"],
    genModelId: "m1",
    promptRewriteVerId: "pv1",
    promptIntentVerId: "pv2",
    promptReplyVerId: "pv3",
    promptFallbackVerId: "pv4",
    topK: 20,
    topN: 5,
    threshold: 0.2,
    multi: true,
    fallbackHuman: true,
  },
  prompt: { id: "p1", name: "问题改写-通用", node: "rewrite", currentVersionId: "pv1" },
  promptVersion: {
    id: "pv1",
    promptId: "p1",
    version: 7,
    body: "你是一个问题改写器...",
    variables: ["query"],
    note: "通用版",
    author: "admin",
    status: "prod",
  },
  chatReq: { agentId: "aftersale", query: "怎么退货" },
  conv: { id: "c1", agentId: "aftersale", title: "退货咨询" },
  msg: { id: "m1", convId: "c1", role: "user", content: "怎么退货" },
  evalSet: { id: "es1", name: "售后基础集", desc: "基础评测", caseCount: 30 },
  evalRun: {
    id: "r1",
    setId: "es1",
    agentId: "aftersale",
    total: 30,
    time: "2m14s",
    metrics: [{ label: "召回率", value: "0.94", pct: "94%" }],
    cases: [{ q: "怎么退货", recall: "0.94", acc: "通过", cite: "正确", st: "通过" }],
  },
};

describe("M2 contracts — positive cases", () => {
  it("ModelProviderSchema accepts a valid provider", () => {
    expect(ModelProviderSchema.parse(valid.model)).toEqual(valid.model);
  });
  it("KnowledgeBaseSchema accepts a valid kb (progress optional)", () => {
    expect(KnowledgeBaseSchema.parse(valid.kb)).toEqual(valid.kb);
  });
  it("KnowledgeBaseSchema accepts building state with progress", () => {
    expect(KnowledgeBaseSchema.parse({ ...valid.kb, status: "building", progress: 62 }).progress).toBe(62);
  });
  it("DocumentSchema accepts a valid document", () => {
    expect(DocumentSchema.parse(valid.doc)).toEqual(valid.doc);
  });
  it("ChunkSchema accepts a valid chunk", () => {
    expect(ChunkSchema.parse(valid.chunk)).toEqual(valid.chunk);
  });
  it("RetrievalTestRequestSchema accepts a valid request", () => {
    expect(RetrievalTestRequestSchema.parse(valid.retrievalReq)).toEqual(valid.retrievalReq);
  });
  it("RetrievalTestResponseSchema accepts hits array", () => {
    expect(RetrievalTestResponseSchema.parse({ hits: [valid.retrievalHit] }).hits).toHaveLength(1);
  });
  it("AgentSchema accepts a valid agent", () => {
    expect(AgentSchema.parse(valid.agent)).toEqual(valid.agent);
  });
  it("PromptSchema accepts a valid prompt", () => {
    expect(PromptSchema.parse(valid.prompt)).toEqual(valid.prompt);
  });
  it("PromptVersionSchema accepts a valid version", () => {
    expect(PromptVersionSchema.parse(valid.promptVersion)).toEqual(valid.promptVersion);
  });
  it("ChatRequestSchema accepts request without convId", () => {
    expect(ChatRequestSchema.parse(valid.chatReq)).toEqual(valid.chatReq);
  });
  it("ConversationSchema accepts a valid conversation", () => {
    expect(ConversationSchema.parse(valid.conv)).toEqual(valid.conv);
  });
  it("MessageSchema accepts a valid message", () => {
    expect(MessageSchema.parse(valid.msg)).toEqual(valid.msg);
  });
  it("DocumentListResponseSchema wraps documents", () => {
    expect(DocumentListResponseSchema.parse([valid.doc]).length).toBe(1);
    expect(() => DocumentListResponseSchema.parse([{ ...valid.doc, type: "xlsx" }])).toThrow();
  });
  it("ChunkListResponseSchema wraps chunks", () => {
    expect(ChunkListResponseSchema.parse([valid.chunk]).length).toBe(1);
    expect(() => ChunkListResponseSchema.parse([{ ...valid.chunk, seq: -1 }])).toThrow();
  });
  it("MessageListResponseSchema wraps messages", () => {
    expect(MessageListResponseSchema.parse([valid.msg]).length).toBe(1);
    expect(() => MessageListResponseSchema.parse([{ ...valid.msg, role: "system" }])).toThrow();
  });
  it("EvalSetSchema accepts a valid eval set", () => {
    expect(EvalSetSchema.parse(valid.evalSet)).toEqual(valid.evalSet);
  });
  it("EvalRunSchema accepts a valid eval run", () => {
    expect(EvalRunSchema.parse(valid.evalRun)).toEqual(valid.evalRun);
  });
});

describe("M2 contracts — negative cases", () => {
  it("ModelProviderSchema rejects unknown type", () => {
    expect(() => ModelProviderSchema.parse({ ...valid.model, type: "vision" })).toThrow();
  });
  it("KnowledgeBaseSchema rejects negative counts", () => {
    expect(() => KnowledgeBaseSchema.parse({ ...valid.kb, docsCount: -1 })).toThrow();
  });
  it("DocumentSchema rejects non-http baseUrl? (n/a) — rejects unknown type", () => {
    expect(() => DocumentSchema.parse({ ...valid.doc, type: "xlsx" })).toThrow();
  });
  it("RetrievalTestRequestSchema rejects threshold out of range", () => {
    expect(() => RetrievalTestRequestSchema.parse({ ...valid.retrievalReq, threshold: 1.5 })).toThrow();
  });
  it("AgentSchema rejects threshold out of range", () => {
    expect(() => AgentSchema.parse({ ...valid.agent, threshold: 2 })).toThrow();
  });
  it("PromptSchema rejects unknown node", () => {
    expect(() => PromptSchema.parse({ ...valid.prompt, node: "summary" })).toThrow();
  });
  it("ChatRequestSchema rejects empty query", () => {
    expect(() => ChatRequestSchema.parse({ agentId: "a", query: "" })).toThrow();
  });
  it("MessageSchema rejects unknown role", () => {
    expect(() => MessageSchema.parse({ ...valid.msg, role: "system" })).toThrow();
  });
});

describe("ChatStreamEventSchema (discriminated union)", () => {
  it("accepts a token event", () => {
    expect(ChatStreamEventSchema.parse({ type: "token", delta: "你" }).type).toBe("token");
  });
  it("accepts a citation event", () => {
    const e = ChatStreamEventSchema.parse({
      type: "citation",
      citation: { n: 1, doc: "退换货政策.pdf", kb: "售后知识库", section: "退货条件", score: 0.82 },
    });
    expect(e.type).toBe("citation");
  });
  it("accepts a done event", () => {
    expect(ChatStreamEventSchema.parse({ type: "done", traceId: "abc" }).type).toBe("done");
  });
  it("accepts an error event", () => {
    expect(ChatStreamEventSchema.parse({ type: "error", message: "boom" }).type).toBe("error");
  });
  it("rejects an unknown event type", () => {
    expect(() => ChatStreamEventSchema.parse({ type: "unknown", delta: "x" })).toThrow();
  });
});

describe("PaginatedResponseSchema (generic factory)", () => {
  it("wraps an item schema with pagination fields", () => {
    const Schema = PaginatedResponseSchema(AgentSchema);
    const parsed = Schema.parse({
      items: [valid.agent],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });
  it("rejects when an item is invalid", () => {
    const Schema = PaginatedResponseSchema(AgentSchema);
    expect(() =>
      Schema.parse({ items: [{ ...valid.agent, threshold: 5 }], total: 1, page: 1, pageSize: 20 }),
    ).toThrow();
  });
  it("rejects page=0", () => {
    const Schema = PaginatedResponseSchema(AgentSchema);
    expect(() => Schema.parse({ items: [], total: 0, page: 0, pageSize: 20 })).toThrow();
  });
});

describe("M2 request schemas (skeleton DTOs)", () => {
  it("CreateModelRequestSchema omits id, keeps enabled", () => {
    const { id: _id, ...rest } = valid.model;
    void _id;
    expect(CreateModelRequestSchema.parse(rest).enabled).toBe(true);
    expect(() => CreateModelRequestSchema.parse({ ...rest, type: "vision" })).toThrow();
  });
  it("CreateKnowledgeBaseRequestSchema omits id/counts/status/updatedAt", () => {
    const { id: _a, docsCount: _b, chunksCount: _c, status: _d, updatedAt: _e, ...rest } = valid.kb;
    void _a;
    void _b;
    void _c;
    void _d;
    void _e;
    expect(CreateKnowledgeBaseRequestSchema.parse(rest).name).toBe(valid.kb.name);
  });
  it("CreateDocumentRequestSchema omits id/counts/status/updatedAt", () => {
    const { id: _a, chunksCount: _b, status: _c, updatedAt: _d, ...rest } = valid.doc;
    void _a;
    void _b;
    void _c;
    void _d;
    expect(CreateDocumentRequestSchema.parse(rest).name).toBe(valid.doc.name);
  });
  it("IngestionStatusSchema accepts a valid status", () => {
    expect(
      IngestionStatusSchema.parse({
        documentId: "d1",
        status: "processing",
        progress: 42,
        stage: "切片",
      }).progress,
    ).toBe(42);
    expect(() =>
      IngestionStatusSchema.parse({ documentId: "d1", status: "queued", progress: 0, stage: "" }),
    ).toThrow();
  });
  it("UpdateChunkEnabledRequestSchema accepts { enabled }", () => {
    expect(UpdateChunkEnabledRequestSchema.parse({ enabled: false }).enabled).toBe(false);
    expect(() => UpdateChunkEnabledRequestSchema.parse({ enabled: "yes" })).toThrow();
  });
  it("CreateAgentRequestSchema omits id", () => {
    const { id: _id, ...rest } = valid.agent;
    void _id;
    expect(CreateAgentRequestSchema.parse(rest).name).toBe(valid.agent.name);
    expect(() => CreateAgentRequestSchema.parse({ ...rest, topK: -1 })).toThrow();
  });
  it("UpdateAgentRequestSchema is partial (allows single field)", () => {
    expect(UpdateAgentRequestSchema.parse({ name: "新名字" }).name).toBe("新名字");
    expect(UpdateAgentRequestSchema.parse({}).name).toBeUndefined();
  });
  it("CreatePromptVersionRequestSchema omits id/promptId/version/status (后端分配)", () => {
    const { id: _a, promptId: _b, version: _c, status: _d, ...rest } = valid.promptVersion;
    void _a;
    void _b;
    void _c;
    void _d;
    const parsed = CreatePromptVersionRequestSchema.parse(rest);
    expect(parsed.body).toBe(valid.promptVersion.body);
    expect(parsed.variables).toEqual(["query"]);
    // 拒绝客户端塞 status/version（后端分配）—— 多余 key 被 zod 默认 strip，但若客户端传非法值在 strict 下应拒
    // 这里验证 status/version 不在 parse 结果里
    expect((parsed as Record<string, unknown>).status).toBeUndefined();
    expect((parsed as Record<string, unknown>).version).toBeUndefined();
  });
});
