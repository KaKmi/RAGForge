import { type INestApplication } from "@nestjs/common";
import { APP_GUARD, APP_PIPE } from "@nestjs/core";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { ZodValidationPipe } from "nestjs-zod";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { applyGlobalConfig, setupSwagger } from "../src/app/app-bootstrap";
import {
  AgentSchema,
  ChatStreamEventSchema,
  ChunkSchema,
  ConversationSchema,
  DocumentSchema,
  IngestionStatusSchema,
  KnowledgeBaseSchema,
  MessageSchema,
  ModelProviderSchema,
  type PromptListQuery,
  PromptSchema,
  PromptVersionSchema,
  RetrievalTestResponseSchema,
} from "@codecrush/contracts";
import { AgentsModule } from "../src/modules/agents/agents.module";
import { ChatModule } from "../src/modules/chat/chat.module";
import { ChunksModule } from "../src/modules/chunks/chunks.module";
import { ConversationsModule } from "../src/modules/conversations/conversations.module";
import { DocumentsModule } from "../src/modules/documents/documents.module";
import { IngestionModule } from "../src/modules/ingestion/ingestion.module";
import { KnowledgeBasesModule } from "../src/modules/knowledge-bases/knowledge-bases.module";
import { ModelsModule } from "../src/modules/models/models.module";
import { PromptsModule } from "../src/modules/prompts/prompts.module";
import { PromptsRepository } from "../src/modules/prompts/prompts.repository";
import type { PromptListResult, PromptListRow } from "../src/modules/prompts/prompts.repository";
import type { NewPrompt, NewPromptVersion, PromptRow, PromptVersionRow } from "../src/modules/prompts/schema";
import { RetrievalModule } from "../src/modules/retrieval/retrieval.module";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";

const SECRET = "test-secret-at-least-32-characters-long!!";
const PRINCIPAL = { sub: "u1", email: "demo@codecrush.local" };

const validCreateAgent = {
  name: "新助手",
  desc: "测试用",
  status: "draft" as const,
  kbs: ["kb1"],
  genModelId: "m1",
  promptRewriteVerId: "pv1",
  promptIntentVerId: "pv2",
  promptReplyVerId: "pv3",
  promptFallbackVerId: "pv4",
  topK: 10,
  topN: 3,
  threshold: 0.25,
  multi: false,
  fallbackHuman: false,
};

// M6 PromptsRepository 内存实现（DB-free，对齐 skeleton.e2e 现状）
const inMemoryPrompts: PromptRow[] = [];
const inMemoryVersions: PromptVersionRow[] = [];
// 方案 A：findPrompts/findPromptById 返回带聚合的行（currentVersionNumber + versionCount）
const toListRow = (p: PromptRow): PromptListRow => {
  const versions = inMemoryVersions.filter((v) => v.promptId === p.id);
  const current = p.currentVersionId
    ? versions.find((v) => v.id === p.currentVersionId)?.version ?? null
    : null;
  return { ...p, currentVersionNumber: current, versionCount: versions.length };
};
const inMemoryPromptsRepo = {
  findPrompts: async (q: PromptListQuery): Promise<PromptListResult> => {
    let list = inMemoryPrompts.map(toListRow);
    if (q.search) {
      const like = q.search.toLowerCase();
      list = list.filter(
        (r) => r.name.toLowerCase().includes(like) || r.updatedBy.toLowerCase().includes(like),
      );
    }
    if (q.node) list = list.filter((r) => r.node === q.node);
    if (q.status === "prod") list = list.filter((r) => r.currentVersionId !== null);
    if (q.status === "draft") list = list.filter((r) => r.currentVersionId === null);
    const total = list.length;
    const start = (q.page - 1) * q.pageSize;
    return { items: list.slice(start, start + q.pageSize), total };
  },
  findPromptById: async (id: string): Promise<PromptListRow | undefined> => {
    const p = inMemoryPrompts.find((x) => x.id === id);
    return p ? toListRow(p) : undefined;
  },
  insertPrompt: async (row: NewPrompt): Promise<PromptRow> => {
    const r: PromptRow = {
      id: `p${inMemoryPrompts.length + 1}`,
      name: row.name,
      node: row.node,
      currentVersionId: row.currentVersionId ?? null,
      updatedBy: row.updatedBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    inMemoryPrompts.push(r);
    return r;
  },
  findVersions: async (promptId: string): Promise<PromptVersionRow[]> =>
    inMemoryVersions.filter((v) => v.promptId === promptId),
  findVersionById: async (id: string): Promise<PromptVersionRow | undefined> =>
    inMemoryVersions.find((v) => v.id === id),
  insertVersion: async (row: NewPromptVersion): Promise<PromptVersionRow> => {
    const r: PromptVersionRow = {
      id: `pv${inMemoryVersions.length + 1}`,
      promptId: row.promptId,
      version: row.version,
      body: row.body,
      variables: row.variables ?? [],
      note: row.note ?? null,
      author: row.author,
      status: row.status ?? "draft",
      createdAt: new Date(),
    };
    inMemoryVersions.push(r);
    return r;
  },
  findProdVersion: async (promptId: string): Promise<PromptVersionRow | undefined> =>
    inMemoryVersions.find((v) => v.promptId === promptId && v.status === "prod"),
  publishVersion: async (
    promptId: string,
    versionId: string,
    actorEmail: string,
  ): Promise<PromptVersionRow> => {
    for (const v of inMemoryVersions) {
      if (v.promptId === promptId && v.status === "prod") v.status = "archived";
    }
    const v = inMemoryVersions.find((x) => x.id === versionId);
    if (!v) throw new Error(`version ${versionId} not found`);
    v.status = "prod";
    const p = inMemoryPrompts.find((x) => x.id === promptId);
    if (!p) throw new Error(`prompt ${promptId} not found`);
    p.currentVersionId = versionId;
    p.updatedBy = actorEmail;
    p.updatedAt = new Date();
    return v;
  },
  deletePrompt: async (id: string): Promise<void> => {
    const idx = inMemoryPrompts.findIndex((x) => x.id === id);
    if (idx >= 0) inMemoryPrompts.splice(idx, 1);
    for (let i = inMemoryVersions.length - 1; i >= 0; i--) {
      if (inMemoryVersions[i].promptId === id) inMemoryVersions.splice(i, 1);
    }
  },
};

describe("M2 domain skeleton", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: SECRET, signOptions: { expiresIn: "1h" } }),
        ModelsModule,
        KnowledgeBasesModule,
        DocumentsModule,
        IngestionModule,
        ChunksModule,
        RetrievalModule,
        AgentsModule,
        PromptsModule,
        ChatModule,
        ConversationsModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    })
      .overrideProvider(PromptsRepository)
      .useValue(inMemoryPromptsRepo)
      .compile();
    app = ref.createNestApplication();
    applyGlobalConfig(app);
    setupSwagger(app);
    await app.init();
    token = ref.get(JwtService).sign(PRINCIPAL);
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  describe("auth guard", () => {
    it("无 token → 401", async () => {
      await request(app.getHttpServer()).get("/api/models").expect(401);
      await request(app.getHttpServer()).post("/api/chat").send({ agentId: "a", query: "q" }).expect(401);
    });
  });

  describe("models", () => {
    it("GET /api/models → 200 + schema 合规", async () => {
      const res = await request(app.getHttpServer()).get("/api/models").set(auth()).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      for (const m of res.body) expect(() => ModelProviderSchema.parse(m)).not.toThrow();
    });
    it("GET /api/models/m1 → 200", async () => {
      const res = await request(app.getHttpServer()).get("/api/models/m1").set(auth()).expect(200);
      expect(() => ModelProviderSchema.parse(res.body)).not.toThrow();
    });
    it("POST /api/models → 201", async () => {
      await request(app.getHttpServer())
        .post("/api/models")
        .set(auth())
        .send({
          type: "llm",
          provider: "OpenAI",
          name: "gpt-4o",
          enabled: true,
        })
        .expect(201);
    });
    it("POST /api/models/m1/test → 200 {ok:true}", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/models/m1/test")
        .set(auth())
        .expect(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe("knowledge-bases", () => {
    it("GET / → 200 + schema", async () => {
      const res = await request(app.getHttpServer()).get("/api/knowledge-bases").set(auth()).expect(200);
      for (const k of res.body) expect(() => KnowledgeBaseSchema.parse(k)).not.toThrow();
    });
    it("POST / → 201", async () => {
      await request(app.getHttpServer())
        .post("/api/knowledge-bases")
        .set(auth())
        .send({ name: "新库", desc: "", embeddingModelId: "m2" })
        .expect(201);
    });
  });

  describe("documents + ingestion", () => {
    it("GET /api/documents?kbId=kb1 → 200 + schema", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/documents?kbId=kb1")
        .set(auth())
        .expect(200);
      for (const d of res.body) expect(() => DocumentSchema.parse(d)).not.toThrow();
    });
    it("POST /api/documents → 202 (上传受理)", async () => {
      await request(app.getHttpServer())
        .post("/api/documents")
        .set(auth())
        .send({ kbId: "kb1", name: "x.pdf", type: "pdf", size: 1024, blobKey: "blob/x" })
        .expect(202);
    });
    it("POST /api/documents/d1/ingest → 202", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/documents/d1/ingest")
        .set(auth())
        .expect(202);
      expect(() => IngestionStatusSchema.parse(res.body)).not.toThrow();
    });
    it("GET /api/documents/d1/ingestion-status → 200", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/documents/d1/ingestion-status")
        .set(auth())
        .expect(200);
      expect(() => IngestionStatusSchema.parse(res.body)).not.toThrow();
    });
  });

  describe("chunks", () => {
    it("GET /api/chunks/d1 → 200 + schema", async () => {
      const res = await request(app.getHttpServer()).get("/api/chunks/d1").set(auth()).expect(200);
      for (const c of res.body) expect(() => ChunkSchema.parse(c)).not.toThrow();
    });
    it("PATCH /api/chunks/c1 → 200 (toggle)", async () => {
      const res = await request(app.getHttpServer())
        .patch("/api/chunks/c1")
        .set(auth())
        .send({ enabled: false })
        .expect(200);
      expect(res.body.enabled).toBe(false);
    });
  });

  describe("retrieval", () => {
    it("POST /api/retrieval/test → 200 + schema", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/retrieval/test")
        .set(auth())
        .send({
          query: "退货",
          kbId: "kb1",
          embedModelId: "m2",
          topK: 10,
          threshold: 0.2,
          multi: true,
        })
        .expect(200);
      expect(() => RetrievalTestResponseSchema.parse(res.body)).not.toThrow();
    });
    it("POST /api/retrieval/test 非法 body → 400", async () => {
      await request(app.getHttpServer())
        .post("/api/retrieval/test")
        .set(auth())
        .send({ query: "" }) // 缺必填
        .expect(400);
    });
  });

  describe("agents (AC 10: 非法 body → 400)", () => {
    it("GET / → 200 + schema", async () => {
      const res = await request(app.getHttpServer()).get("/api/agents").set(auth()).expect(200);
      for (const a of res.body) expect(() => AgentSchema.parse(a)).not.toThrow();
    });
    it("POST / 合法 → 201", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send(validCreateAgent)
        .expect(201);
      expect(() => AgentSchema.parse(res.body)).not.toThrow();
    });
    it("POST / 非法 body（threshold 越界）→ 400（ZodValidationPipe）", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send({ ...validCreateAgent, threshold: 5 })
        .expect(400);
      expect(res.body.message).toBe("Validation failed");
      expect(Array.isArray(res.body.errors)).toBe(true);
    });
    it("PATCH /api/agents/aftersale → 200", async () => {
      const res = await request(app.getHttpServer())
        .patch("/api/agents/aftersale")
        .set(auth())
        .send({ name: "售后助手-v2" })
        .expect(200);
      expect(res.body.name).toBe("售后助手-v2");
    });
  });

  describe("prompts", () => {
    let promptId: string;
    let v1Id: string;
    let v2Id: string;

    it("POST /api/prompts → 201 + currentVersionId:null + currentVersionNumber:null + versionCount:1 + updatedBy=JWT email", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: "测试 Prompt", node: "rewrite", body: "你好 {query}", note: "n" })
        .expect(201);
      expect(() => PromptSchema.parse(res.body)).not.toThrow();
      expect(res.body.currentVersionId).toBeNull();
      expect(res.body.currentVersionNumber).toBeNull();
      expect(res.body.versionCount).toBe(1);
      expect(res.body.updatedBy).toBe(PRINCIPAL.email);
      expect(res.body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      promptId = res.body.id;
    });

    it("GET /api/prompts/:id/versions → v1 draft（variables 含 query，author 来自 JWT）", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/prompts/${promptId}/versions`)
        .set(auth())
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      const v1 = res.body[0];
      expect(() => PromptVersionSchema.parse(v1)).not.toThrow();
      expect(v1.status).toBe("draft");
      expect(v1.version).toBe(1);
      expect(v1.variables).toContain("query");
      expect(v1.author).toBe(PRINCIPAL.email);
      expect(v1.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      v1Id = v1.id;
    });

    it("POST publish v1 → 200 + v1 prod + currentVersionId 指向 v1 + currentVersionNumber:1", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions/${v1Id}/publish`)
        .set(auth())
        .expect(200);
      expect(res.body.status).toBe("prod");
      const p = await request(app.getHttpServer())
        .get(`/api/prompts/${promptId}`)
        .set(auth())
        .expect(200);
      expect(p.body.currentVersionId).toBe(v1Id);
      expect(p.body.currentVersionNumber).toBe(1);
      expect(p.body.versionCount).toBe(1);
    });

    it("POST publish v1（已 prod）→ 409（D15）", async () => {
      await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions/${v1Id}/publish`)
        .set(auth())
        .expect(409);
    });

    it("建 v2 → publish v2 → 200 + v2 prod + v1 archived + updatedBy 推进（D2 + D16）", async () => {
      const created = await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions`)
        .set(auth())
        .send({ body: "v2 你好 {query}" })
        .expect(201);
      expect(created.body.version).toBe(2);
      expect(created.body.status).toBe("draft");
      v2Id = created.body.id;

      const pub = await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions/${v2Id}/publish`)
        .set(auth())
        .expect(200);
      expect(pub.body.status).toBe("prod");

      const versions = await request(app.getHttpServer())
        .get(`/api/prompts/${promptId}/versions`)
        .set(auth())
        .expect(200);
      const v1 = versions.body.find((v: { id: string }) => v.id === v1Id);
      const v2 = versions.body.find((v: { id: string }) => v.id === v2Id);
      expect(v1.status).toBe("archived");
      expect(v2.status).toBe("prod");

      const p = await request(app.getHttpServer())
        .get(`/api/prompts/${promptId}`)
        .set(auth())
        .expect(200);
      expect(p.body.currentVersionId).toBe(v2Id);
      expect(p.body.currentVersionNumber).toBe(2);
      expect(p.body.versionCount).toBe(2);
      expect(p.body.updatedBy).toBe(PRINCIPAL.email);
    });

    it("POST rollback v1 → 200 + v1 prod + v2 archived（D2）", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions/${v1Id}/rollback`)
        .set(auth())
        .expect(200);
      expect(res.body.status).toBe("prod");

      const versions = await request(app.getHttpServer())
        .get(`/api/prompts/${promptId}/versions`)
        .set(auth())
        .expect(200);
      const v1 = versions.body.find((v: { id: string }) => v.id === v1Id);
      const v2 = versions.body.find((v: { id: string }) => v.id === v2Id);
      expect(v1.status).toBe("prod");
      expect(v2.status).toBe("archived");

      const p = await request(app.getHttpServer())
        .get(`/api/prompts/${promptId}`)
        .set(auth())
        .expect(200);
      expect(p.body.currentVersionId).toBe(v1Id);
    });

    it("D6 不接受请求体 author（服务端从 JWT 填）", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions`)
        .set(auth())
        .send({ body: "v3 {query}", author: "forged@evil.com" })
        .expect(201);
      expect(res.body.author).toBe(PRINCIPAL.email);
      expect(res.body.author).not.toBe("forged@evil.com");
    });

    it("GET /api/prompts → 200 { items, total, page, pageSize }（分页响应）", async () => {
      const res = await request(app.getHttpServer()).get("/api/prompts").set(auth()).expect(200);
      expect(res.body).toHaveProperty("items");
      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("page", 1);
      expect(res.body).toHaveProperty("pageSize", 10);
      expect(Array.isArray(res.body.items)).toBe(true);
      for (const p of res.body.items) expect(() => PromptSchema.parse(p)).not.toThrow();
    });

    it("GET /api/prompts?node=rewrite&status=prod&page=1&pageSize=5 → 条件筛选 + 分页", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/prompts?node=rewrite&status=prod&page=1&pageSize=5")
        .set(auth())
        .expect(200);
      expect(res.body.pageSize).toBe(5);
      for (const p of res.body.items) {
        expect(p.node).toBe("rewrite");
        expect(p.currentVersionId).not.toBeNull();
      }
    });

    it("DELETE /api/prompts/:id 草稿 → 204 + 级联；已启用 → 409；不存在 → 404", async () => {
      // 新建一个草稿 prompt（currentVersionId:null）
      const created = await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: "待删除草稿", node: "reply", body: "临时 {q}" })
        .expect(201);
      const draftId: string = created.body.id;
      // 草稿可删 → 204
      await request(app.getHttpServer())
        .delete(`/api/prompts/${draftId}`)
        .set(auth())
        .expect(204);
      // 删除后再 GET → 404
      await request(app.getHttpServer())
        .get(`/api/prompts/${draftId}`)
        .set(auth())
        .expect(404);
      // 已启用（块前 publish/rollback 过的 promptId）→ 409
      await request(app.getHttpServer())
        .delete(`/api/prompts/${promptId}`)
        .set(auth())
        .expect(409);
      // 不存在 → 404
      await request(app.getHttpServer())
        .delete("/api/prompts/nonexistent-id")
        .set(auth())
        .expect(404);
    });
  });

  describe("chat SSE (AC 9)", () => {
    it("POST /api/chat → text/event-stream，事件可被 ChatStreamEventSchema parse", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/chat")
        .set(auth())
        .send({ agentId: "aftersale", query: "怎么退货" })
        .expect(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
      const text: string = res.text;
      const dataLines = text
        .split("\n\n")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("data: "))
        .map((s) => s.slice("data: ".length));
      expect(dataLines.length).toBeGreaterThanOrEqual(3); // token×N + citation + done
      const events = dataLines.map((line) => JSON.parse(line));
      for (const e of events) expect(() => ChatStreamEventSchema.parse(e)).not.toThrow();
      const types = events.map((e: { type: string }) => e.type);
      expect(types).toContain("token");
      expect(types).toContain("citation");
      expect(types[types.length - 1]).toBe("done");
    });
    it("POST /api/chat 非法 body → 400", async () => {
      await request(app.getHttpServer())
        .post("/api/chat")
        .set(auth())
        .send({ agentId: "" })
        .expect(400);
    });
  });

  describe("conversations", () => {
    it("GET / → 200 + schema", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/conversations")
        .set(auth())
        .expect(200);
      for (const c of res.body) expect(() => ConversationSchema.parse(c)).not.toThrow();
    });
    it("GET /api/conversations/c1/messages → 200 + schema", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/conversations/c1/messages")
        .set(auth())
        .expect(200);
      for (const m of res.body) expect(() => MessageSchema.parse(m)).not.toThrow();
    });
  });

  describe("OpenAPI (AC 4: 含全部新域端点)", () => {
    it("GET /api/docs-json paths 含新域端点", async () => {
      const res = await request(app.getHttpServer()).get("/api/docs-json").expect(200);
      const paths = Object.keys(res.body.paths);
      expect(paths).toContain("/api/models");
      expect(paths).toContain("/api/models/{id}");
      expect(paths).toContain("/api/knowledge-bases");
      expect(paths).toContain("/api/documents");
      expect(paths).toContain("/api/documents/{id}/ingest");
      expect(paths).toContain("/api/documents/{id}/ingestion-status");
      expect(paths).toContain("/api/chunks/{docId}");
      expect(paths).toContain("/api/retrieval/test");
      expect(paths).toContain("/api/agents");
      expect(paths).toContain("/api/prompts");
      expect(paths).toContain("/api/prompts/{id}/versions");
      expect(paths).toContain("/api/prompts/{id}/versions/{versionId}/publish");
      expect(paths).toContain("/api/prompts/{id}/versions/{versionId}/rollback");
      expect(paths).toContain("/api/chat");
      expect(paths).toContain("/api/conversations/{id}/messages");
    });
  });
});
