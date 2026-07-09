// pg-boss v12 是纯 ESM 包，Jest CJS runtime 无法加载真实模块；QueueModule 的 PG_BOSS_INSTANCE
// 工厂在测试树里仍会 new PgBoss(...) 并在生命周期钩子 start/stop——用无副作用桩类顶替
//（@swc/jest 开启 hidden.jest 转换，jest.mock 会被提升到 require 之前）。
jest.mock("pg-boss", () => ({
  PgBoss: class FakePgBoss {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

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
  ChunkPageResponseSchema,
  ConversationSchema,
  DocumentLifecycleResponseSchema,
  DocumentSchema,
  KnowledgeBaseSchema,
  MessageSchema,
  ModelProviderSchema,
  type PromptListQuery,
  PromptSchema,
  PromptVersionSchema,
  RetrievalTestResponseSchema,
  TestModelResponseSchema,
} from "@codecrush/contracts";
import { AgentsModule } from "../src/modules/agents/agents.module";
import { AgentsRepository } from "../src/modules/agents/agents.repository";
import type { AgentListRow } from "../src/modules/agents/agents.repository";
import type {
  AgentConfigVersionRow,
  AgentRow,
  NewAgent,
  NewAgentConfigVersion,
} from "../src/modules/agents/schema";
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
import type {
  NewPrompt,
  NewPromptVersion,
  PromptRow,
  PromptVersionRow,
} from "../src/modules/prompts/schema";
import { RetrievalModule } from "../src/modules/retrieval/retrieval.module";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { SecurityModule } from "../src/platform/security/security.module";
import { EncryptionService } from "../src/platform/security/encryption";
import { ENCRYPTION } from "../src/platform/security/security.constants";
import { ModelsRepository } from "../src/modules/models/models.repository";
import { MODEL_PROVIDER_PORT } from "../src/modules/models/model-provider.constants";
import type { ModelProviderRow, NewModelProvider } from "../src/modules/models/schema";
import { AppConfigModule } from "../src/platform/config/config.module";
import { BLOB_STORE } from "../src/platform/storage/blob-store.constants";
import { INGESTION_QUEUE } from "../src/platform/queue/queue.constants";
import { KnowledgeBasesRepository } from "../src/modules/knowledge-bases/knowledge-bases.repository";
import type { KnowledgeBaseRow } from "../src/modules/knowledge-bases/schema";
import { DocumentsRepository } from "../src/modules/documents/documents.repository";
import type { DocumentRow } from "../src/modules/documents/schema";
import { ChunksRepository } from "../src/modules/chunks/chunks.repository";

const SECRET = "test-secret-at-least-32-characters-long!!";
const PRINCIPAL = { sub: "u1", email: "demo@codecrush.local" };

// M4：测试树引入 QueueModule/StorageModule/IngestionModule 的工厂 provider，它们注入
// AppConfigService——导入真实 AppConfigModule 并兜底必填 env（不连任何真实服务：
// pg-boss 已被 jest.mock 桩掉、BLOB_STORE/INGESTION_QUEUE token 均被 override）。
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/skeleton_e2e_unused";
process.env.JWT_SECRET ??= SECRET;
process.env.MODEL_API_KEY_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

// M6 PromptsRepository 内存实现（DB-free，对齐 skeleton.e2e 现状）
const inMemoryPrompts: PromptRow[] = [];
const inMemoryVersions: PromptVersionRow[] = [];
// 方案 A：findPrompts/findPromptById 返回带聚合的行（currentVersionNumber + versionCount）
const toListRow = (p: PromptRow): PromptListRow => {
  const versions = inMemoryVersions.filter((v) => v.promptId === p.id);
  const current = p.currentVersionId
    ? (versions.find((v) => v.id === p.currentVersionId)?.version ?? null)
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

// M3 ModelsRepository 内存实现（DB-free）+ fake port（不真打外网）+ 固定 key 加密实例
const inMemoryModels: ModelProviderRow[] = [];
const inMemoryModelsRepo = {
  find: async (): Promise<ModelProviderRow[]> => [...inMemoryModels],
  findById: async (id: string): Promise<ModelProviderRow | undefined> =>
    inMemoryModels.find((m) => m.id === id),
  insert: async (row: NewModelProvider): Promise<ModelProviderRow> => {
    const r: ModelProviderRow = {
      id: `m${inMemoryModels.length + 1}`,
      type: row.type,
      protocol: row.protocol,
      name: row.name,
      baseUrl: row.baseUrl,
      apiKeyEnc: row.apiKeyEnc,
      deploymentId: row.deploymentId ?? null,
      params: row.params ?? {},
      enabled: row.enabled ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    inMemoryModels.push(r);
    return r;
  },
  update: async (
    id: string,
    patch: Partial<NewModelProvider>,
  ): Promise<ModelProviderRow | undefined> => {
    const r = inMemoryModels.find((m) => m.id === id);
    if (r) Object.assign(r, patch, { updatedAt: new Date() });
    return r;
  },
  delete: async (id: string): Promise<void> => {
    const i = inMemoryModels.findIndex((m) => m.id === id);
    if (i >= 0) inMemoryModels.splice(i, 1);
  },
};
const fakeModelProviderPort = {
  testConnection: jest.fn(async () => ({ ok: true, latencyMs: 5, statusCode: 200 })),
  // KnowledgeBasesService.create() 的 1024 维探针会走到这里
  embed: jest.fn(async (_config: unknown, texts: string[]) => ({
    vectors: texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  })),
};
const testEncryption = new EncryptionService(Buffer.alloc(32, 7).toString("base64"));

// —— M4 内存假实现（同 inMemoryModelsRepo 手写风格；不连真实 Postgres/pg-boss）——
// 真实 drizzle 的 .set() 会跳过 undefined 字段；假实现必须同语义，否则部分 PATCH 会把
// 未携带的列冲成 undefined（null 是显式清空，保留）。
const stripUndefined = <T extends Record<string, unknown>>(patch: T): Partial<T> =>
  Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;

let kbSeq = 0;
const inMemoryKbs: KnowledgeBaseRow[] = [];
const inMemoryKbsRepo: Partial<KnowledgeBasesRepository> = {
  find: async () => [...inMemoryKbs],
  findById: async (id: string) => inMemoryKbs.find((k) => k.id === id),
  findByIds: async (ids: string[]) => inMemoryKbs.filter((k) => ids.includes(k.id)),
  findByName: async (name: string) => inMemoryKbs.find((k) => k.name === name),
  insert: async (row) => {
    const r = {
      id: `kb${++kbSeq}`,
      desc: "",
      status: "ready",
      activeVersion: 1,
      buildingVersion: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...stripUndefined(row as Record<string, unknown>),
    } as KnowledgeBaseRow;
    inMemoryKbs.push(r);
    return r;
  },
  update: async (id, patch) => {
    const r = inMemoryKbs.find((k) => k.id === id);
    if (r)
      Object.assign(r, stripUndefined(patch as Record<string, unknown>), { updatedAt: new Date() });
    return r;
  },
  updateVersions: async (id, patch) => {
    const r = inMemoryKbs.find((k) => k.id === id);
    if (r)
      Object.assign(r, stripUndefined(patch as Record<string, unknown>), { updatedAt: new Date() });
    return r;
  },
};

let docSeq = 0;
const inMemoryDocs: DocumentRow[] = [];
const inMemoryDocsRepo: Partial<DocumentsRepository> = {
  find: async () => [...inMemoryDocs],
  findByKb: async (kbId: string) => inMemoryDocs.filter((d) => d.kbId === kbId),
  findById: async (id: string) => inMemoryDocs.find((d) => d.id === id),
  insert: async (row) => {
    const r = {
      id: `doc${++docSeq}`,
      parsedText: null,
      metadata: {},
      status: "pending",
      chunkVersion: null,
      lifecycle: [],
      error: null,
      uploadedAt: new Date(),
      updatedAt: new Date(),
      ...stripUndefined(row as Record<string, unknown>),
    } as DocumentRow;
    inMemoryDocs.push(r);
    return r;
  },
  update: async (id, patch) => {
    const r = inMemoryDocs.find((d) => d.id === id);
    if (r)
      Object.assign(r, stripUndefined(patch as Record<string, unknown>), { updatedAt: new Date() });
    return r;
  },
  appendLifecycleStage: async (id, stage) => {
    const r = inMemoryDocs.find((d) => d.id === id);
    if (r) (r.lifecycle as unknown[]).push(stage);
    return r;
  },
  completeLifecycleStage: async (id, stage, patch) => {
    const r = inMemoryDocs.find((d) => d.id === id);
    if (!r) return false;
    for (let i = r.lifecycle.length - 1; i >= 0; i--) {
      const st = r.lifecycle[i];
      if (st.stage === stage && st.status === "running" && !st.endedAt) {
        r.lifecycle[i] = { ...st, ...patch };
        return true;
      }
    }
    return false;
  },
  countByKbs: async (kbIds: string[]) =>
    kbIds
      .map((kbId) => ({ kbId, count: inMemoryDocs.filter((d) => d.kbId === kbId).length }))
      .filter((c) => c.count > 0),
  delete: async (id: string) => {
    const i = inMemoryDocs.findIndex((d) => d.id === id);
    if (i >= 0) inMemoryDocs.splice(i, 1);
  },
} as Partial<DocumentsRepository>;

// 只存 id 集合即可支撑删除计数语义：真实 batchDelete 返回「实际删掉的行数」，
// 不存在的 id 不计数——回显 ids.length 的坏实现必须被这里揪出来。
const inMemoryChunkIds = new Set<string>();
const inMemoryChunksRepo: Partial<ChunksRepository> = {
  findPage: async () => ({ items: [], total: 0 }),
  countByDocs: async () => [],
  countByKbVersions: async () => [],
  batchDelete: async (ids: string[]) => ids.filter((id) => inMemoryChunkIds.delete(id)).length,
  replaceVersion: async () => undefined,
  deleteByVersion: async () => 0,
} as Partial<ChunksRepository>;

// —— M7 AgentsRepository 内存实现（DB-free，同上手写风格）——
let agentSeq = 0;
let agentVerSeq = 0;
const inMemoryAgents: AgentRow[] = [];
const inMemoryAgentVersions: AgentConfigVersionRow[] = [];
const inMemoryAgentVersionKbs: Array<{ versionId: string; kbId: string }> = [];

const toAgentListRow = (a: AgentRow): AgentListRow => {
  const cur = a.currentVersionId
    ? inMemoryAgentVersions.find((v) => v.id === a.currentVersionId)
    : undefined;
  return {
    ...a,
    currentVersionNumber: cur?.version ?? null,
    currentVersionStatus: cur?.status ?? null,
  };
};
const insertAgentVersion = (
  row: NewAgentConfigVersion,
  kbIds: string[],
): AgentConfigVersionRow => {
  const version = {
    id: `av${++agentVerSeq}`,
    status: "draft",
    lightModelId: null,
    rerankModelId: null,
    nodeParams: {},
    multiRecall: true,
    vecWeight: null,
    fallbackHuman: true,
    evalStatus: "not_run",
    evalRunAt: null,
    evalPassRate: null,
    evalSummary: null,
    note: null,
    createdAt: new Date(),
    publishedBy: null,
    publishedAt: null,
    ...stripUndefined(row as Record<string, unknown>),
  } as AgentConfigVersionRow;
  inMemoryAgentVersions.push(version);
  kbIds.forEach((kbId) => inMemoryAgentVersionKbs.push({ versionId: version.id, kbId }));
  return version;
};

const inMemoryAgentsRepo: Partial<AgentsRepository> = {
  findAgents: async () => inMemoryAgents.map(toAgentListRow),
  findAgentById: async (id: string) => {
    const a = inMemoryAgents.find((x) => x.id === id);
    return a ? toAgentListRow(a) : undefined;
  },
  findAgentByName: async (name: string) => inMemoryAgents.find((x) => x.name === name),
  findVersionById: async (id: string) => inMemoryAgentVersions.find((v) => v.id === id),
  findVersions: async (agentId: string) =>
    inMemoryAgentVersions.filter((v) => v.agentId === agentId),
  findVersionKbIds: async (versionId: string) =>
    inMemoryAgentVersionKbs.filter((k) => k.versionId === versionId).map((k) => k.kbId),
  createAgentWithV1: async (agentRow: NewAgent, versionRow, kbIds: string[]) => {
    const agent = {
      id: `agent${++agentSeq}`,
      desc: "",
      enabled: true,
      currentVersionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...stripUndefined(agentRow as Record<string, unknown>),
    } as AgentRow;
    inMemoryAgents.push(agent);
    const version = insertAgentVersion(
      { ...versionRow, agentId: agent.id } as NewAgentConfigVersion,
      kbIds,
    );
    agent.currentVersionId = version.id;
    return { agent, version };
  },
  insertDraftVersion: async (versionRow: NewAgentConfigVersion, kbIds: string[]) =>
    insertAgentVersion(versionRow, kbIds),
  updateVersionEval: async (versionId, patch) => {
    const v = inMemoryAgentVersions.find((x) => x.id === versionId);
    if (!v) throw new Error(`version ${versionId} not found`);
    Object.assign(v, patch);
    return v;
  },
  updateAgentBase: async (id, patch) => {
    const a = inMemoryAgents.find((x) => x.id === id);
    if (!a) return undefined;
    Object.assign(a, stripUndefined(patch as Record<string, unknown>), { updatedAt: new Date() });
    return a;
  },
  promote: async (agentId: string, versionId: string, actorEmail: string) => {
    inMemoryAgentVersions
      .filter((v) => v.agentId === agentId && v.status === "published")
      .forEach((v) => {
        v.status = "archived";
      });
    const target = inMemoryAgentVersions.find((v) => v.id === versionId);
    if (!target) throw new Error(`version ${versionId} not found`);
    target.status = "published";
    target.publishedBy = actorEmail;
    target.publishedAt = new Date();
    const agent = inMemoryAgents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    agent.currentVersionId = versionId;
    agent.updatedBy = actorEmail;
    agent.updatedAt = new Date();
    return target;
  },
};

const inMemoryBlobs = new Map<string, Buffer>();
const fakeBlobStore = {
  put: async (key: string, data: Buffer) => void inMemoryBlobs.set(key, data),
  get: async (key: string) => inMemoryBlobs.get(key) ?? Buffer.alloc(0),
  delete: async (key: string) => void inMemoryBlobs.delete(key),
};

const fakeQueue = {
  publish: jest.fn(async () => undefined),
  subscribe: jest.fn(async () => undefined),
};

describe("M2 domain skeleton", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: SECRET, signOptions: { expiresIn: "1h" } }),
        // M4：QueueModule/StorageModule/IngestionModule 的工厂 provider 注入 AppConfigService
        AppConfigModule,
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
        // SecurityModule 注册 ENCRYPTION token 供 override（factory 被替换后不需 AppConfigService）
        SecurityModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    })
      .overrideProvider(PromptsRepository)
      .useValue(inMemoryPromptsRepo)
      .overrideProvider(ModelsRepository)
      .useValue(inMemoryModelsRepo)
      .overrideProvider(ENCRYPTION)
      .useValue(testEncryption)
      .overrideProvider(MODEL_PROVIDER_PORT)
      .useValue(fakeModelProviderPort)
      .overrideProvider(KnowledgeBasesRepository)
      .useValue(inMemoryKbsRepo)
      .overrideProvider(DocumentsRepository)
      .useValue(inMemoryDocsRepo)
      .overrideProvider(ChunksRepository)
      .useValue(inMemoryChunksRepo)
      .overrideProvider(AgentsRepository)
      .useValue(inMemoryAgentsRepo)
      .overrideProvider(BLOB_STORE)
      .useValue(fakeBlobStore)
      .overrideProvider(INGESTION_QUEUE)
      .useValue(fakeQueue)
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
      await request(app.getHttpServer())
        .post("/api/chat")
        .send({ agentId: "a", query: "q" })
        .expect(401);
    });
  });

  describe("models (M3 真实 CRUD + 加密 + 连通性测试)", () => {
    let modelId: string;
    const createBody = {
      type: "llm",
      protocol: "openai_compat",
      name: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test12345678",
      params: { temperature: "0.3" },
    };

    it("POST /api/models 缺 apiKey → 400（ZodValidationPipe）", async () => {
      const { apiKey: _k, ...noKey } = createBody;
      void _k;
      await request(app.getHttpServer()).post("/api/models").set(auth()).send(noKey).expect(400);
    });

    it("POST /api/models 非法 (type, protocol) 组合 → 400（llm+dashscope）", async () => {
      await request(app.getHttpServer())
        .post("/api/models")
        .set(auth())
        .send({ ...createBody, protocol: "dashscope" })
        .expect(400);
    });

    it("POST /api/models → 201 + 掩码、无明文", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/models")
        .set(auth())
        .send(createBody)
        .expect(201);
      expect(() => ModelProviderSchema.parse(res.body)).not.toThrow();
      expect(res.body.apiKeyMasked).toBe("sk-****5678");
      expect(res.body.apiKey).toBeUndefined();
      expect(res.body.enabled).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain("sk-test12345678");
      modelId = res.body.id;
    });

    it("GET /api/models → 200 列表 schema 合规 + 掩码", async () => {
      const res = await request(app.getHttpServer()).get("/api/models").set(auth()).expect(200);
      expect(res.body.length).toBeGreaterThan(0);
      for (const m of res.body) expect(() => ModelProviderSchema.parse(m)).not.toThrow();
      expect(JSON.stringify(res.body)).not.toContain("sk-test12345678");
    });

    it("GET /api/models/:id → 200；不存在 → 404", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/models/${modelId}`)
        .set(auth())
        .expect(200);
      expect(() => ModelProviderSchema.parse(res.body)).not.toThrow();
      await request(app.getHttpServer()).get("/api/models/nope").set(auth()).expect(404);
    });

    it("PATCH enabled:false → 生效；不带 apiKey 掩码不变", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/models/${modelId}`)
        .set(auth())
        .send({ enabled: false })
        .expect(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.apiKeyMasked).toBe("sk-****5678");
    });

    it("PATCH 带 apiKey → 轮换掩码", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/models/${modelId}`)
        .set(auth())
        .send({ apiKey: "sk-rotated9999" })
        .expect(200);
      expect(res.body.apiKeyMasked).toBe("sk-****9999");
    });

    it("PATCH 单改 protocol 为非法组合 → 400（llm 行改 dashscope）", async () => {
      await request(app.getHttpServer())
        .patch(`/api/models/${modelId}`)
        .set(auth())
        .send({ protocol: "dashscope" })
        .expect(400);
    });

    it("POST /:id/test 带 override → fake port 收到 override 配置 + 存量 key", async () => {
      await request(app.getHttpServer())
        .post(`/api/models/${modelId}/test`)
        .set(auth())
        .send({ baseUrl: "http://drawer.internal:9090" })
        .expect(200);
      expect(fakeModelProviderPort.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "http://drawer.internal:9090" }),
      );
    });

    it("POST /api/models/:id/test → 200 且 fake port 收到解密明文", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/models/${modelId}/test`)
        .set(auth())
        .expect(200);
      expect(() => TestModelResponseSchema.parse(res.body)).not.toThrow();
      expect(res.body.ok).toBe(true);
      expect(fakeModelProviderPort.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-rotated9999" }),
      );
      await request(app.getHttpServer()).post("/api/models/nope/test").set(auth()).expect(404);
    });

    it("POST /api/models/test（ad-hoc，保存前验活）→ 200", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/models/test")
        .set(auth())
        .send({ ...createBody, apiKey: "sk-drafttest1234" })
        .expect(200);
      expect(res.body.ok).toBe(true);
      expect(fakeModelProviderPort.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-drafttest1234" }),
      );
    });

    it("DELETE → 204，再 GET → 404", async () => {
      await request(app.getHttpServer()).delete(`/api/models/${modelId}`).set(auth()).expect(204);
      await request(app.getHttpServer()).get(`/api/models/${modelId}`).set(auth()).expect(404);
    });
  });

  // —— M4：KB/documents/chunks 走真实 service/controller（仓储/blob/队列为内存假实现）——
  // 三个 describe 共享一个 embedding 模型（type=embedding 且 enabled，探针走 fakeModelProviderPort.embed）。
  let embeddingModelId: string;
  const ensureEmbeddingModel = async (): Promise<void> => {
    if (embeddingModelId) return;
    const res = await request(app.getHttpServer())
      .post("/api/models")
      .set(auth())
      .send({
        type: "embedding",
        protocol: "openai_compat",
        name: "bge-large-zh",
        baseUrl: "http://embeddings.internal:8080/v1",
        apiKey: "sk-embedding1234",
      })
      .expect(201);
    embeddingModelId = res.body.id;
  };

  describe("knowledge-bases (M4 真实 CRUD + 探针 + 蓝绿重建)", () => {
    let kbId: string;
    let kbName: string;

    beforeAll(ensureEmbeddingModel);

    it("POST / 缺 chunkTemplate → 400（ZodValidationPipe）", async () => {
      await request(app.getHttpServer())
        .post("/api/knowledge-bases")
        .set(auth())
        .send({ name: "缺字段库", desc: "", embeddingModelId })
        .expect(400);
    });

    it("POST / 成功 → 201 + schema，activeVersion=1，探针收到解密明文", async () => {
      fakeModelProviderPort.embed.mockClear();
      kbName = `课程库-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post("/api/knowledge-bases")
        .set(auth())
        .send({ name: kbName, desc: "", chunkTemplate: "general", embeddingModelId })
        .expect(201);
      expect(() => KnowledgeBaseSchema.parse(res.body)).not.toThrow();
      expect(res.body.activeVersion).toBe(1);
      expect(res.body.buildingVersion).toBeNull();
      expect(res.body.status).toBe("ready");
      expect(fakeModelProviderPort.embed).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-embedding1234" }),
        ["probe"],
      );
      kbId = res.body.id;
    });

    it("POST / 同名 → 409", async () => {
      await request(app.getHttpServer())
        .post("/api/knowledge-bases")
        .set(auth())
        .send({ name: kbName, desc: "", chunkTemplate: "general", embeddingModelId })
        .expect(409);
    });

    it("GET / → 200 + schema；GET /:id 不存在 → 404", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/knowledge-bases")
        .set(auth())
        .expect(200);
      for (const k of res.body) expect(() => KnowledgeBaseSchema.parse(k)).not.toThrow();
      await request(app.getHttpServer()).get("/api/knowledge-bases/nope").set(auth()).expect(404);
    });

    it("PATCH /:id 携带 embeddingModelId → 400（strictObject 契约层拒绝，创建后锁定）", async () => {
      await request(app.getHttpServer())
        .patch(`/api/knowledge-bases/${kbId}`)
        .set(auth())
        .send({ embeddingModelId: "other" })
        .expect(400);
    });

    it("PATCH /:id 空库改 chunkTemplate → 200，空库短路直切（activeVersion+1，回到 ready）", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/knowledge-bases/${kbId}`)
        .set(auth())
        .send({ chunkTemplate: "qa" })
        .expect(200);
      // 库下无文档：startRebuild 立即 finalize——版本推进、building 清空、状态回 ready
      expect(res.body.chunkTemplate).toBe("qa");
      expect(res.body.activeVersion).toBe(2);
      expect(res.body.buildingVersion).toBeNull();
      expect(res.body.status).toBe("ready");
    });

    it("PATCH /:id 有未完成文档时改 chunkTemplate → 200 + building；重建中再改 → 409", async () => {
      // 先给库塞一个 pending 文档（fakeQueue 不真消费，重建停留在 building 态）
      await request(app.getHttpServer())
        .post(`/api/knowledge-bases/${kbId}/documents`)
        .set(auth())
        .field("autoParse", "false")
        .attach("files", Buffer.from("重建测试文本"), "rebuild.txt")
        .expect(201);

      fakeQueue.publish.mockClear();
      const res = await request(app.getHttpServer())
        .patch(`/api/knowledge-bases/${kbId}`)
        .set(auth())
        .send({ chunkTemplate: "general" })
        .expect(200);
      expect(res.body.status).toBe("building");
      expect(res.body.buildingVersion).toBe(3);
      expect(res.body.activeVersion).toBe(2); // 读侧仍用旧 active_version
      expect(fakeQueue.publish).toHaveBeenCalled();

      await request(app.getHttpServer())
        .patch(`/api/knowledge-bases/${kbId}`)
        .set(auth())
        .send({ chunkTemplate: "qa" })
        .expect(409);
    });
  });

  describe("documents (M4 multipart 上传/手动解析/元数据/生命周期)", () => {
    let kbId: string;
    let docId: string;

    beforeAll(async () => {
      await ensureEmbeddingModel();
      const res = await request(app.getHttpServer())
        .post("/api/knowledge-bases")
        .set(auth())
        .send({
          name: `文档测试库-${Date.now()}`,
          desc: "",
          chunkTemplate: "general",
          embeddingModelId,
        })
        .expect(201);
      kbId = res.body.id;
    });

    it("POST /knowledge-bases/:kbId/documents multipart（autoParse=false）→ 201 + pending", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/knowledge-bases/${kbId}/documents`)
        .set(auth())
        .field("autoParse", "false")
        .attach("files", Buffer.from("hello world"), "a.txt")
        .expect(201);
      expect(Array.isArray(res.body)).toBe(true);
      expect(() => DocumentSchema.parse(res.body[0])).not.toThrow();
      expect(res.body[0].status).toBe("pending");
      expect(res.body[0].chunkVersion).toBeNull();
      docId = res.body[0].id;
    });

    it("POST 混合批次（合法+非法类型）→ 400 且无部分提交", async () => {
      const before = inMemoryDocs.length;
      await request(app.getHttpServer())
        .post(`/api/knowledge-bases/${kbId}/documents`)
        .set(auth())
        .field("autoParse", "false")
        .attach("files", Buffer.from("ok"), "ok.txt")
        .attach("files", Buffer.from("bad"), "bad.exe")
        .expect(400);
      expect(inMemoryDocs.length).toBe(before); // 整批拒绝，前面的合法文件也不落库
    });

    it("POST 到不存在的库 → 404", async () => {
      await request(app.getHttpServer())
        .post("/api/knowledge-bases/nope/documents")
        .set(auth())
        .field("autoParse", "false")
        .attach("files", Buffer.from("x"), "x.txt")
        .expect(404);
    });

    it("POST multipart（autoParse 默认开）→ 201 + queued + 幂等入队 opts", async () => {
      fakeQueue.publish.mockClear();
      const res = await request(app.getHttpServer())
        .post(`/api/knowledge-bases/${kbId}/documents`)
        .set(auth())
        .attach("files", Buffer.from("auto parse me"), "b.md")
        .expect(201);
      expect(res.body[0].status).toBe("queued");
      const doc = res.body[0];
      expect(fakeQueue.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ documentId: doc.id }),
        expect.objectContaining({ singletonKey: doc.id, retryLimit: 1 }),
      );
    });

    it("GET /documents?kbId= → 200 + schema", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/documents?kbId=${kbId}`)
        .set(auth())
        .expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      for (const d of res.body) expect(() => DocumentSchema.parse(d)).not.toThrow();
    });

    it("POST /documents/:id/parse → 202，触发入队；不存在 → 404", async () => {
      fakeQueue.publish.mockClear();
      await request(app.getHttpServer())
        .post(`/api/documents/${docId}/parse`)
        .set(auth())
        .expect(202);
      expect(fakeQueue.publish).toHaveBeenCalled();
      await request(app.getHttpServer()).post("/api/documents/nope/parse").set(auth()).expect(404);
    });

    it("GET /documents/:id/lifecycle → 200 + schema（含 upload 完成项）", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/documents/${docId}/lifecycle`)
        .set(auth())
        .expect(200);
      expect(() => DocumentLifecycleResponseSchema.parse(res.body)).not.toThrow();
      expect(res.body.stages.some((s: { stage: string }) => s.stage === "upload")).toBe(true);
    });

    it("PATCH /documents/:id/metadata → 200，元数据写入", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/documents/${docId}/metadata`)
        .set(auth())
        .send({ metadata: { author: "qa", 来源: "e2e" } })
        .expect(200);
      expect(res.body.metadata.author).toBe("qa");
    });

    it("GET /documents/:id/content → 200（未解析时 text 为空串）", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/documents/${docId}/content`)
        .set(auth())
        .expect(200);
      expect(res.body.documentId).toBe(docId);
      expect(res.body.text).toBe("");
    });

    it("DELETE /documents/:id → 204（blob 同删），再 GET lifecycle → 404", async () => {
      const blobCountBefore = inMemoryBlobs.size;
      await request(app.getHttpServer()).delete(`/api/documents/${docId}`).set(auth()).expect(204);
      expect(inMemoryBlobs.size).toBe(blobCountBefore - 1);
      await request(app.getHttpServer())
        .get(`/api/documents/${docId}/lifecycle`)
        .set(auth())
        .expect(404);
    });
  });

  describe("chunks (M4 分页搜索 + 批量删除，删除制)", () => {
    let docId: string;

    beforeAll(async () => {
      await ensureEmbeddingModel();
      const kbRes = await request(app.getHttpServer())
        .post("/api/knowledge-bases")
        .set(auth())
        .send({
          name: `切片测试库-${Date.now()}`,
          desc: "",
          chunkTemplate: "general",
          embeddingModelId,
        })
        .expect(201);
      const docRes = await request(app.getHttpServer())
        .post(`/api/knowledge-bases/${kbRes.body.id}/documents`)
        .set(auth())
        .field("autoParse", "false")
        .attach("files", Buffer.from("x"), "x.txt")
        .expect(201);
      docId = docRes.body[0].id;
    });

    it("GET /documents/:id/chunks → 200 + 分页 schema（chunkVersion null 时空页）", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/documents/${docId}/chunks?offset=0&limit=20`)
        .set(auth())
        .expect(200);
      expect(() => ChunkPageResponseSchema.parse(res.body)).not.toThrow();
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
      expect(res.body.hasMore).toBe(false);
    });

    it("GET /documents/:id/chunks limit>100 → 400；文档不存在 → 404", async () => {
      await request(app.getHttpServer())
        .get(`/api/documents/${docId}/chunks?limit=500`)
        .set(auth())
        .expect(400);
      await request(app.getHttpServer()).get("/api/documents/nope/chunks").set(auth()).expect(404);
    });

    it("POST /chunks/batch-delete 空数组 → 400", async () => {
      await request(app.getHttpServer())
        .post("/api/chunks/batch-delete")
        .set(auth())
        .send({ ids: [] })
        .expect(400);
    });

    it("POST /chunks/batch-delete → 201 + deletedCount 只计实际存在的行", async () => {
      inMemoryChunkIds.clear();
      inMemoryChunkIds.add("c1");
      const res = await request(app.getHttpServer())
        .post("/api/chunks/batch-delete")
        .set(auth())
        .send({ ids: ["c1", "c2"] }) // c2 不存在——回显 ids.length 的实现会在这里露馅
        .expect(201);
      expect(res.body.deletedCount).toBe(1);
      expect(inMemoryChunkIds.size).toBe(0);
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

  describe("agents (M7 真实 CRUD + 版本化 + Eval stub + 发布回滚)", () => {
    let agentModelId: string;
    let agentKbId: string;
    let promptVerIds: Record<"rewrite" | "intent" | "reply" | "fallback", string>;
    let agentNameSeq = 0;

    const nodeConfig = {
      freedom: "balance" as const,
      temperatureEnabled: true,
      temperature: 0.5,
      topPEnabled: false,
      topP: 0.9,
    };
    const validCreateAgent = () => ({
      name: `e2e助手-${++agentNameSeq}`,
      desc: "e2e",
      kbIds: [agentKbId],
      genModelId: agentModelId,
      promptRewriteVerId: promptVerIds.rewrite,
      promptIntentVerId: promptVerIds.intent,
      promptReplyVerId: promptVerIds.reply,
      promptFallbackVerId: promptVerIds.fallback,
      nodeParams: {
        rewrite: nodeConfig,
        intent: nodeConfig,
        reply: nodeConfig,
        fallback: nodeConfig,
      },
      topK: 10,
      topN: 3,
      threshold: 0.25,
      multiRecall: false,
      fallbackHuman: false,
    });

    // 自建 fixture（llm 模型 / kb / 4 节点 prompt 版本），不依赖其他 describe 的块级变量
    beforeAll(async () => {
      await ensureEmbeddingModel();
      const modelRes = await request(app.getHttpServer())
        .post("/api/models")
        .set(auth())
        .send({
          type: "llm",
          protocol: "openai_compat",
          name: "agent-e2e-llm",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-agente2e12345",
        })
        .expect(201);
      agentModelId = modelRes.body.id;

      const kbRes = await request(app.getHttpServer())
        .post("/api/knowledge-bases")
        .set(auth())
        .send({
          name: `agent-e2e-kb-${Date.now()}`,
          desc: "",
          chunkTemplate: "general",
          embeddingModelId,
        })
        .expect(201);
      agentKbId = kbRes.body.id;

      const nodes = ["rewrite", "intent", "reply", "fallback"] as const;
      const ids: Partial<Record<(typeof nodes)[number], string>> = {};
      for (const node of nodes) {
        const pRes = await request(app.getHttpServer())
          .post("/api/prompts")
          .set(auth())
          .send({ name: `agent-e2e-${node}`, node, body: "内容 {x}" })
          .expect(201);
        const versions = await request(app.getHttpServer())
          .get(`/api/prompts/${pRes.body.id}/versions`)
          .set(auth())
          .expect(200);
        ids[node] = versions.body[0].id;
      }
      promptVerIds = ids as Record<(typeof nodes)[number], string>;
    });

    it("GET / → 200 + schema", async () => {
      const res = await request(app.getHttpServer()).get("/api/agents").set(auth()).expect(200);
      for (const a of res.body) expect(() => AgentSchema.parse(a)).not.toThrow();
    });

    it("POST / 合法 → 201，v1 evalStatus=exempt，status=active（008 决策 4）", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send(validCreateAgent())
        .expect(201);
      expect(() => AgentSchema.parse(res.body)).not.toThrow();
      expect(res.body.status).toBe("active");
      expect(res.body.currentVersion.evalStatus).toBe("exempt");
      expect(res.body.currentVersion.status).toBe("published");
      expect(res.body.currentVersion.kbIds).toEqual([agentKbId]);
    });

    it("POST / kbIds 指向不同 embedding 模型的知识库 → 400（后端一致性校验）", async () => {
      const embed2 = await request(app.getHttpServer())
        .post("/api/models")
        .set(auth())
        .send({
          type: "embedding",
          protocol: "openai_compat",
          name: "agent-e2e-embed2",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-embed2test123",
        })
        .expect(201);
      const kb2 = await request(app.getHttpServer())
        .post("/api/knowledge-bases")
        .set(auth())
        .send({
          name: `agent-e2e-kb2-${Date.now()}`,
          desc: "",
          chunkTemplate: "general",
          embeddingModelId: embed2.body.id,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send({ ...validCreateAgent(), kbIds: [agentKbId, kb2.body.id] })
        .expect(400);
    });

    it("POST / 非法 body（threshold 越界）→ 400（ZodValidationPipe）", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send({ ...validCreateAgent(), threshold: 5 })
        .expect(400);
      expect(res.body.message).toBe("Validation failed");
      expect(Array.isArray(res.body.errors)).toBe(true);
    });

    it("PATCH 携带非 name/desc/enabled 字段 → 400（strictObject，008 决策 3）", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send(validCreateAgent())
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/agents/${created.body.id}`)
        .set(auth())
        .send({ topK: 99 })
        .expect(400);
    });

    it("PATCH name/enabled → 200；enabled=false 时派生 status=archived", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send(validCreateAgent())
        .expect(201);
      const res = await request(app.getHttpServer())
        .patch(`/api/agents/${created.body.id}`)
        .set(auth())
        .send({ name: `改名后-${agentNameSeq}`, enabled: false })
        .expect(200);
      expect(res.body.name).toBe(`改名后-${agentNameSeq}`);
      expect(res.body.status).toBe("archived");
    });

    it("配置版本全链路：draft(not_run) → publish 409 → eval-run → publish 200 → rollback v1", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send(validCreateAgent())
        .expect(201);
      const agentId = created.body.id;

      const draft = await request(app.getHttpServer())
        .post(`/api/agents/${agentId}/config-versions`)
        .set(auth())
        .send({ ...validCreateAgent(), topK: 30, note: "调大召回" })
        .expect(201);
      expect(draft.body.evalStatus).toBe("not_run");
      expect(draft.body.version).toBe(2);

      // Eval 门槛：未跑 Eval 直接发布 → 409
      await request(app.getHttpServer())
        .post(`/api/agents/${agentId}/config-versions/${draft.body.id}/publish`)
        .set(auth())
        .expect(409);

      // Eval stub：立即 passed，evalPassRate 恒 null（不编造数字）
      const evaled = await request(app.getHttpServer())
        .post(`/api/agents/${agentId}/config-versions/${draft.body.id}/eval-run`)
        .set(auth())
        .expect(200);
      expect(evaled.body.evalStatus).toBe("passed");
      expect(evaled.body.evalPassRate).toBeNull();

      await request(app.getHttpServer())
        .post(`/api/agents/${agentId}/config-versions/${draft.body.id}/publish`)
        .set(auth())
        .expect(200);

      // 发布后 v1 转 archived，可回滚；rollback 后 v1 重新 published
      const versions = await request(app.getHttpServer())
        .get(`/api/agents/${agentId}/config-versions`)
        .set(auth())
        .expect(200);
      const v1 = versions.body.find((v: { version: number }) => v.version === 1);
      expect(v1.status).toBe("archived");

      const rolled = await request(app.getHttpServer())
        .post(`/api/agents/${agentId}/config-versions/${v1.id}/rollback`)
        .set(auth())
        .expect(200);
      expect(rolled.body.status).toBe("published");

      // 对非 archived 版本回滚 → 409（v1 已是 published）
      await request(app.getHttpServer())
        .post(`/api/agents/${agentId}/config-versions/${v1.id}/rollback`)
        .set(auth())
        .expect(409);
    });

    it("引用不存在的 prompt version → 404；node 不匹配 → 400", async () => {
      await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send({ ...validCreateAgent(), promptRewriteVerId: "nope" })
        .expect(404);
      await request(app.getHttpServer())
        .post("/api/agents")
        .set(auth())
        .send({ ...validCreateAgent(), promptRewriteVerId: promptVerIds.intent })
        .expect(400);
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
      await request(app.getHttpServer()).delete(`/api/prompts/${draftId}`).set(auth()).expect(204);
      // 删除后再 GET → 404
      await request(app.getHttpServer()).get(`/api/prompts/${draftId}`).set(auth()).expect(404);
      // 已启用（块前 publish/rollback 过的 promptId）→ 409
      await request(app.getHttpServer()).delete(`/api/prompts/${promptId}`).set(auth()).expect(409);
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
      expect(paths).toContain("/api/models/test");
      expect(paths).toContain("/api/models/{id}/test");
      expect(paths).toContain("/api/knowledge-bases");
      expect(paths).toContain("/api/knowledge-bases/{id}");
      expect(paths).toContain("/api/knowledge-bases/{kbId}/documents");
      expect(paths).toContain("/api/documents");
      expect(paths).toContain("/api/documents/{id}/parse");
      expect(paths).toContain("/api/documents/{id}/lifecycle");
      expect(paths).toContain("/api/documents/{id}/metadata");
      expect(paths).toContain("/api/documents/{id}/content");
      expect(paths).toContain("/api/documents/{id}/chunks");
      expect(paths).toContain("/api/chunks/batch-delete");
      // M2 旧入库路由已随删除制/异步管线移除
      expect(paths).not.toContain("/api/documents/{id}/ingest");
      expect(paths).not.toContain("/api/documents/{id}/ingestion-status");
      expect(paths).not.toContain("/api/chunks/{docId}");
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
