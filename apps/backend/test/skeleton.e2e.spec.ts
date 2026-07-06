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
    }).compile();
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
    it("GET / → 200 + schema", async () => {
      const res = await request(app.getHttpServer()).get("/api/prompts").set(auth()).expect(200);
      for (const p of res.body) expect(() => PromptSchema.parse(p)).not.toThrow();
    });
    it("GET /api/prompts/p1/versions → 200 + schema", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/prompts/p1/versions")
        .set(auth())
        .expect(200);
      for (const v of res.body) expect(() => PromptVersionSchema.parse(v)).not.toThrow();
    });
    it("POST /api/prompts/p1/versions → 201", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/prompts/p1/versions")
        .set(auth())
        .send({ body: "新版本...", variables: ["query"] })
        .expect(201);
      expect(res.body.promptId).toBe("p1");
      expect(res.body.status).toBe("draft");
      expect(typeof res.body.version).toBe("number");
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
      expect(paths).toContain("/api/prompts/{id}/versions");
      expect(paths).toContain("/api/chat");
      expect(paths).toContain("/api/conversations/{id}/messages");
    });
  });
});
