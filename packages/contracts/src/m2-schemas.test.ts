import { describe, expect, it } from "vitest";
import {
  AgentSchema,
  ChatRequestSchema,
  ChatStreamEventSchema,
  ConversationSchema,
  CreateAgentRequestSchema,
  CreateModelRequestSchema,
  CreatePromptRequestSchema,
  CreatePromptVersionRequestSchema,
  EvalRunSchema,
  EvalSetSchema,
  MessageListResponseSchema,
  MessageSchema,
  ModelProviderSchema,
  PaginatedResponseSchema,
  PromptListQuerySchema,
  PromptListResponseSchema,
  PromptSchema,
  PromptVersionSchema,
  RetrievalTestRequestSchema,
  RetrievalTestResponseSchema,
  UpdateAgentRequestSchema,
} from "./index";

const valid = {
  model: {
    id: "m1",
    type: "llm",
    protocol: "openai_compat",
    name: "deepseek-v3",
    baseUrl: "https://api.deepseek.com",
    apiKeyMasked: "sk-****1234",
    params: { temperature: "0.3", max_tokens: "2048" },
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
  prompt: {
    id: "p1",
    name: "问题改写-通用",
    node: "rewrite",
    currentVersionId: "pv1",
    currentVersionNumber: 7,
    versionCount: 3,
    updatedAt: "2026-07-01T00:00:00.000Z",
    updatedBy: "demo@codecrush.local",
  },
  promptVersion: {
    id: "pv1",
    promptId: "p1",
    version: 7,
    body: "你是一个问题改写器...",
    variables: ["query"],
    note: "通用版",
    author: "admin",
    status: "prod",
    createdAt: "2026-07-01T00:00:00.000Z",
  },
  createPromptReq: { name: "新 Prompt", node: "rewrite", body: "你好 {query}", note: "test" },
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
  it("PromptSchema accepts currentVersionId:null + currentVersionNumber:null (未发布)", () => {
    const p = PromptSchema.parse({
      ...valid.prompt,
      currentVersionId: null,
      currentVersionNumber: null,
    });
    expect(p.currentVersionId).toBeNull();
    expect(p.currentVersionNumber).toBeNull();
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
  it("RetrievalTestRequestSchema rejects threshold out of range", () => {
    expect(() => RetrievalTestRequestSchema.parse({ ...valid.retrievalReq, threshold: 1.5 })).toThrow();
  });
  it("AgentSchema rejects threshold out of range", () => {
    expect(() => AgentSchema.parse({ ...valid.agent, threshold: 2 })).toThrow();
  });
  it("PromptSchema rejects unknown node", () => {
    expect(() => PromptSchema.parse({ ...valid.prompt, node: "summary" })).toThrow();
  });
  it("PromptSchema rejects currentVersionId:undefined (nullable 非 optional)", () => {
    const { currentVersionId: _v, ...rest } = valid.prompt;
    void _v;
    expect(() => PromptSchema.parse(rest)).toThrow();
  });
  it("PromptSchema rejects missing updatedAt/updatedBy", () => {
    expect(() => PromptSchema.parse({ ...valid.prompt, updatedAt: undefined })).toThrow();
    expect(() => PromptSchema.parse({ ...valid.prompt, updatedBy: undefined })).toThrow();
  });
  it("PromptSchema rejects missing currentVersionNumber/versionCount", () => {
    expect(() => PromptSchema.parse({ ...valid.prompt, currentVersionNumber: undefined })).toThrow();
    expect(() => PromptSchema.parse({ ...valid.prompt, versionCount: undefined })).toThrow();
  });
  it("PromptSchema rejects negative versionCount", () => {
    expect(() => PromptSchema.parse({ ...valid.prompt, versionCount: -1 })).toThrow();
  });
  it("PromptVersionSchema rejects missing createdAt", () => {
    expect(() => PromptVersionSchema.parse({ ...valid.promptVersion, createdAt: undefined })).toThrow();
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
  it("CreateModelRequestSchema 要求明文 apiKey，读侧无 apiKey", () => {
    const { id: _id, apiKeyMasked: _m, ...rest } = valid.model;
    void _id;
    void _m;
    expect(() => CreateModelRequestSchema.parse(rest)).toThrow(); // 缺 apiKey
    const created = CreateModelRequestSchema.parse({ ...rest, apiKey: "sk-12345678" });
    expect(created.enabled).toBe(true);
    expect(() =>
      CreateModelRequestSchema.parse({ ...rest, apiKey: "sk-12345678", type: "vision" }),
    ).toThrow();
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
  it("CreatePromptRequestSchema accepts { name, node, body, note? }", () => {
    const parsed = CreatePromptRequestSchema.parse(valid.createPromptReq);
    expect(parsed.name).toBe("新 Prompt");
    expect(parsed.node).toBe("rewrite");
    expect(parsed.body).toBe("你好 {query}");
    expect(parsed.note).toBe("test");
    // 客户端塞 id/currentVersionId/updatedAt/updatedBy 被 strip（后端分配）
    expect(
      (
        CreatePromptRequestSchema.parse({ ...valid.createPromptReq, id: "x" }) as Record<
          string,
          unknown
        >
      ).id,
    ).toBeUndefined();
  });
  it("CreatePromptVersionRequestSchema = { body, note? } (variables/author 服务端填)", () => {
    const parsed = CreatePromptVersionRequestSchema.parse({
      body: valid.promptVersion.body,
      note: "v2",
    });
    expect(parsed.body).toBe(valid.promptVersion.body);
    expect(parsed.note).toBe("v2");
    // variables 由后端 extractVars 计算、author 来自 JWT —— 客户端不可塞
    expect(
      (
        CreatePromptVersionRequestSchema.parse({ body: "x", variables: ["hack"] }) as Record<
          string,
          unknown
        >
      ).variables,
    ).toBeUndefined();
    expect(
      (
        CreatePromptVersionRequestSchema.parse({ body: "x", author: "hack" }) as Record<
          string,
          unknown
        >
      ).author,
    ).toBeUndefined();
  });
  it("PromptListQuerySchema 接受空对象（默认 page=1/pageSize=10）+ coerce string→number", () => {
    expect(PromptListQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 10,
      search: undefined,
      node: undefined,
      status: undefined,
    });
    expect(PromptListQuerySchema.parse({ page: "2", pageSize: "20" })).toMatchObject({
      page: 2,
      pageSize: 20,
    });
  });
  it("PromptListQuerySchema search 空白串→undefined，非空→trim", () => {
    expect(PromptListQuerySchema.parse({ search: "   " }).search).toBeUndefined();
    expect(PromptListQuerySchema.parse({ search: " x " }).search).toBe("x");
  });
  it("PromptListQuerySchema rejects page=0 / pageSize 越界 / 非法 node / 非法 status", () => {
    expect(() => PromptListQuerySchema.parse({ page: "0" })).toThrow();
    expect(() => PromptListQuerySchema.parse({ pageSize: "0" })).toThrow();
    expect(() => PromptListQuerySchema.parse({ pageSize: "101" })).toThrow();
    expect(() => PromptListQuerySchema.parse({ node: "summary" })).toThrow();
    expect(() => PromptListQuerySchema.parse({ status: "archived" })).toThrow();
  });
  it("PromptListResponseSchema 接受 { items, total, page, pageSize }", () => {
    const res = PromptListResponseSchema.parse({
      items: [valid.prompt],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(1);
  });
  it("PromptListResponseSchema rejects 缺 total/page / 非法 item / 负 total", () => {
    expect(() => PromptListResponseSchema.parse({ items: [], page: 1, pageSize: 10 })).toThrow();
    expect(() =>
      PromptListResponseSchema.parse({
        items: [{ ...valid.prompt, versionCount: -1 }],
        total: 1,
        page: 1,
        pageSize: 10,
      }),
    ).toThrow();
    expect(() =>
      PromptListResponseSchema.parse({ items: [], total: -1, page: 1, pageSize: 10 }),
    ).toThrow();
  });
});
