import { describe, expect, it } from "vitest";
import {
  AgentSchema,
  ChatRequestSchema,
  ChatStreamEventSchema,
  CompileIssueSchema,
  CompileResultSchema,
  CompileStatusSchema,
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
  MovePromptTagRequestSchema,
  PromptDetailSchema,
  TRY_RUN_CHAT_PROTOCOLS,
  TryRunPromptRequestSchema,
  TryRunResultSchema,
  PromptListQuerySchema,
  PromptListResponseSchema,
  PromptNodeVersionCandidateSchema,
  PromptSchema,
  PromptVersionSchema,
  RetrievalTestRequestSchema,
  RetrievalTestResponseSchema,
  UpdateAgentRequestSchema,
} from "./index";

// M7：Agent 契约改三层版本化模型（008 设计），fixture 对齐新形状
const validNodeConfig = {
  freedom: "balance" as const,
  temperatureEnabled: true,
  temperature: 0.5,
  topPEnabled: false,
  topP: 0.9,
};
const validAgentConfigFields = {
  kbIds: ["kb1"],
  genModelId: "m1",
  promptRewriteVerId: "pv1",
  promptIntentVerId: "pv2",
  promptReplyVerId: "pv3",
  promptFallbackVerId: "pv4",
  nodeParams: {
    rewrite: validNodeConfig,
    intent: validNodeConfig,
    reply: validNodeConfig,
    fallback: validNodeConfig,
  },
  topK: 20,
  topN: 5,
  threshold: 0.65,
  multiRecall: true,
  fallbackHuman: true,
};
const validAgentVersion = {
  ...validAgentConfigFields,
  id: "av1",
  agentId: "a1",
  version: 1,
  status: "published" as const,
  evalStatus: "exempt" as const,
  evalRunAt: null,
  evalPassRate: null,
  createdBy: "demo@codecrush.local",
  createdAt: "2026-07-09T00:00:00.000Z",
  publishedBy: "demo@codecrush.local",
  publishedAt: "2026-07-09T00:00:00.000Z",
};

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
    id: "a1",
    name: "售后助手",
    desc: "售后问答",
    enabled: true,
    status: "active" as const,
    currentVersion: validAgentVersion,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    updatedBy: "demo@codecrush.local",
  },
  prompt: {
    id: "p1",
    name: "问题改写-通用",
    node: "rewrite",
    latestVersion: 7,
    versionCount: 3,
    tags: ["production"],
    variables: ["query"],
    createdAt: "2026-07-01T00:00:00.000Z",
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
    contractVersion: 1,
    compileStatus: "ok",
    compileErrors: [],
    tags: ["production"],
    createdAt: "2026-07-01T00:00:00.000Z",
  },
  createPromptReq: { name: "新 Prompt", node: "rewrite" },
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
  it("PromptSchema accepts 无标签空变量（tags/variables 允许空数组）", () => {
    const p = PromptSchema.parse({ ...valid.prompt, tags: [], variables: [] });
    expect(p.tags).toEqual([]);
    expect(p.variables).toEqual([]);
  });
  it("PromptDetailSchema = Prompt + versions[]（012 详情一次拿全）", () => {
    const d = PromptDetailSchema.parse({ ...valid.prompt, versions: [valid.promptVersion] });
    expect(d.versions).toHaveLength(1);
    expect(() => PromptDetailSchema.parse({ ...valid.prompt })).toThrow();
  });
  it("PromptVersionSchema 允许空 body（012 空 v1 / 错误允许保存）", () => {
    expect(PromptVersionSchema.parse({ ...valid.promptVersion, body: "" }).body).toBe("");
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
  it("RetrievalTestRequestSchema rejects rerankThreshold out of range", () => {
    expect(() =>
      RetrievalTestRequestSchema.parse({ ...valid.retrievalReq, rerankThreshold: 1.5 }),
    ).toThrow();
  });
  it("RetrievalTestRequestSchema accepts rerankThreshold within range", () => {
    expect(
      RetrievalTestRequestSchema.parse({ ...valid.retrievalReq, rerankThreshold: 0.5 })
        .rerankThreshold,
    ).toBe(0.5);
  });
  // M7 后 threshold 归属 currentVersion（AgentConfigVersion），Agent 顶层无此字段——
  // 旧扁平 schema 的「顶层 threshold 越界」用例已无意义，由下面 currentVersion 用例覆盖
  it("AgentSchema rejects currentVersion.threshold out of range", () => {
    expect(() =>
      AgentSchema.parse({
        ...valid.agent,
        currentVersion: { ...validAgentVersion, threshold: 2 },
      }),
    ).toThrow();
  });
  it("AgentSchema accepts currentVersion:null (draft，未发布任何版本)", () => {
    expect(AgentSchema.parse({ ...valid.agent, currentVersion: null }).currentVersion).toBeNull();
  });
  it("PromptSchema rejects unknown node", () => {
    expect(() => PromptSchema.parse({ ...valid.prompt, node: "summary" })).toThrow();
  });
  it("PromptSchema rejects 缺 latestVersion / 缺 tags（012 必填）", () => {
    expect(() => PromptSchema.parse({ ...valid.prompt, latestVersion: undefined })).toThrow();
    expect(() => PromptSchema.parse({ ...valid.prompt, tags: undefined })).toThrow();
  });
  it("PromptVersionSchema rejects 旧 status 值形状（compileStatus 枚举外值）", () => {
    expect(() =>
      PromptVersionSchema.parse({ ...valid.promptVersion, compileStatus: "prod" }),
    ).toThrow();
  });
  it("PromptSchema rejects missing updatedAt/updatedBy", () => {
    expect(() => PromptSchema.parse({ ...valid.prompt, updatedAt: undefined })).toThrow();
    expect(() => PromptSchema.parse({ ...valid.prompt, updatedBy: undefined })).toThrow();
  });
  it("PromptSchema rejects missing versionCount", () => {
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
      Schema.parse({
        items: [{ ...valid.agent, currentVersion: { ...validAgentVersion, threshold: 5 } }],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
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
  it("CreateAgentRequestSchema accepts full payload (配置字段 + name/desc)", () => {
    const req = { ...validAgentConfigFields, name: "售后助手", desc: "" };
    expect(CreateAgentRequestSchema.parse(req).name).toBe("售后助手");
    expect(() => CreateAgentRequestSchema.parse({ ...req, topK: -1 })).toThrow();
    expect(() => CreateAgentRequestSchema.parse({ ...req, threshold: 2 })).toThrow();
    expect(() => CreateAgentRequestSchema.parse({ ...req, kbIds: [] })).toThrow(); // 至少绑一个知识库
  });
  it("UpdateAgentRequestSchema is strict — 仅 name/desc/enabled，拒绝未知键（008 决策 3）", () => {
    expect(UpdateAgentRequestSchema.parse({ name: "新名字" }).name).toBe("新名字");
    expect(UpdateAgentRequestSchema.parse({}).name).toBeUndefined();
    expect(UpdateAgentRequestSchema.parse({ enabled: false }).enabled).toBe(false);
    expect(() => UpdateAgentRequestSchema.parse({ topK: 10 })).toThrow();
    expect(() => UpdateAgentRequestSchema.parse({ genModelId: "m2" })).toThrow();
  });
  it("CreatePromptRequestSchema = { name, node }（012：v1 空 body 服务端生成）", () => {
    const parsed = CreatePromptRequestSchema.parse(valid.createPromptReq);
    expect(parsed.name).toBe("新 Prompt");
    expect(parsed.node).toBe("rewrite");
    expect((parsed as Record<string, unknown>).body).toBeUndefined();
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
  it("CreatePromptVersionRequestSchema = { body, note?, sourceVersionId? }，body 允许空", () => {
    const parsed = CreatePromptVersionRequestSchema.parse({
      body: valid.promptVersion.body,
      note: "v2",
      sourceVersionId: "pv1",
    });
    expect(parsed.body).toBe(valid.promptVersion.body);
    expect(parsed.note).toBe("v2");
    expect(parsed.sourceVersionId).toBe("pv1");
    expect(CreatePromptVersionRequestSchema.parse({ body: "" }).body).toBe("");
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
  it("PromptListQuerySchema rejects page=0 / pageSize 越界 / 非法 node", () => {
    expect(() => PromptListQuerySchema.parse({ page: "0" })).toThrow();
    expect(() => PromptListQuerySchema.parse({ pageSize: "0" })).toThrow();
    expect(() => PromptListQuerySchema.parse({ pageSize: "101" })).toThrow();
    expect(() => PromptListQuerySchema.parse({ node: "summary" })).toThrow();
  });
  it("MovePromptTagRequestSchema：name 归一小写 + 命名校验（012 §3）", () => {
    expect(MovePromptTagRequestSchema.parse({ name: "Production", versionId: "pv1" }).name).toBe(
      "production",
    );
    expect(MovePromptTagRequestSchema.parse({ name: "v1.2_beta-x", versionId: "pv1" }).name).toBe(
      "v1.2_beta-x",
    );
    expect(() => MovePromptTagRequestSchema.parse({ name: "有 空格", versionId: "pv1" })).toThrow();
    expect(() => MovePromptTagRequestSchema.parse({ name: "", versionId: "pv1" })).toThrow();
  });
  it("PromptNodeVersionCandidateSchema：候选形状（全版本平权 + 标签信号）", () => {
    const c = PromptNodeVersionCandidateSchema.parse({
      promptId: "p1",
      promptName: "问题改写-通用",
      versionId: "pv1",
      version: 7,
      tags: [],
      compileStatus: "ok",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    expect(c.version).toBe(7);
    expect(() =>
      PromptNodeVersionCandidateSchema.parse({ promptId: "p1", promptName: "x" }),
    ).toThrow();
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

// M6 重构（012）：编译结果/状态 schema（compile_status/compile_errors 的契约形状）
describe("Compile result schemas (012)", () => {
  it("CompileStatusSchema accepts ok/has_errors/has_warnings only", () => {
    expect(CompileStatusSchema.parse("ok")).toBe("ok");
    expect(CompileStatusSchema.parse("has_errors")).toBe("has_errors");
    expect(CompileStatusSchema.parse("has_warnings")).toBe("has_warnings");
    expect(() => CompileStatusSchema.parse("draft")).toThrow();
  });
  it("CompileIssueSchema accepts issue with optional field/suggestion", () => {
    const minimal = {
      code: "INVALID_TEMPLATE_SYNTAX",
      severity: "error",
      message: "存在未闭合的 {",
    };
    expect(CompileIssueSchema.parse(minimal)).toEqual(minimal);
    const full = {
      code: "UNKNOWN_VARIABLE",
      severity: "error",
      message: "未知字段",
      field: "qeury",
      suggestion: "query",
    };
    expect(CompileIssueSchema.parse(full)).toEqual(full);
  });
  it("CompileIssueSchema rejects unknown code/severity", () => {
    expect(() =>
      CompileIssueSchema.parse({ code: "NOPE", severity: "error", message: "x" }),
    ).toThrow();
    expect(() =>
      CompileIssueSchema.parse({ code: "RESERVED_FIELD", severity: "fatal", message: "x" }),
    ).toThrow();
  });
  it("CompileResultSchema accepts { status, issues[] }", () => {
    const r = { status: "has_warnings", issues: [] };
    expect(CompileResultSchema.parse(r)).toEqual(r);
    expect(() => CompileResultSchema.parse({ status: "ok" })).toThrow();
  });
});

// 012 Story 7：try-run 请求与判别联合（text/unavailable/structured 预留）
describe("Try-run schemas (012 Story 7)", () => {
  it("请求：modelId 必填、temperature 0..2、testVars.query 必填字段", () => {
    const parsed = TryRunPromptRequestSchema.parse({
      modelId: "m1",
      temperature: 1.5,
      testVars: { query: "q", history: "h", retrievalContext: "c", reason: "r" },
    });
    expect(parsed.modelId).toBe("m1");
    expect(() =>
      TryRunPromptRequestSchema.parse({ modelId: "m1", temperature: 2.5, testVars: { query: "q" } }),
    ).toThrow();
    expect(() => TryRunPromptRequestSchema.parse({ testVars: { query: "q" } })).toThrow();
    expect(() => TryRunPromptRequestSchema.parse({ modelId: "m1", testVars: {} })).toThrow();
  });
  it("结果联合按 mode 判别：text / unavailable / structured（预留）", () => {
    expect(TryRunResultSchema.parse({ mode: "text", text: "回答" }).mode).toBe("text");
    expect(
      TryRunResultSchema.parse({ mode: "unavailable", reason: "pending_node_runtime" }).mode,
    ).toBe("unavailable");
    expect(
      TryRunResultSchema.parse({
        mode: "structured",
        fields: { intent: "aftersale" },
        validateSteps: [],
        fallbackUsed: false,
      }).mode,
    ).toBe("structured");
    expect(() => TryRunResultSchema.parse({ mode: "unavailable", reason: "nope" })).toThrow();
    expect(() => TryRunResultSchema.parse({ mode: "text" })).toThrow();
  });
  it("支持矩阵常量恰为当前三种 LLM 协议", () => {
    expect([...TRY_RUN_CHAT_PROTOCOLS].sort()).toEqual(["anthropic", "gemini", "openai_compat"]);
  });
});
