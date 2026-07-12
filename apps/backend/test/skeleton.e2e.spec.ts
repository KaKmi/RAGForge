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
  ApplicationChatResultSchema,
  ApplicationConfigVersionSchema,
  ApplicationDetailSchema,
  ApplicationSchema,
  ChatStreamEventSchema,
  ChunkPageResponseSchema,
  ConversationSchema,
  DocumentLifecycleResponseSchema,
  DocumentSchema,
  KnowledgeBaseSchema,
  MessageSchema,
  ModelProviderSchema,
  PromptDetailSchema,
  type PromptListQuery,
  PromptNodeVersionCandidateSchema,
  PromptSchema,
  PromptUsageEntrySchema,
  PromptVersionSchema,
  RetrievalTestResponseSchema,
  TestModelResponseSchema,
} from "@codecrush/contracts";
import { AgentsModule } from "../src/modules/agents/agents.module";
import { ApplicationsModule } from "../src/modules/applications/applications.module";
import { ApplicationsRepository } from "../src/modules/applications/applications.repository";
import type { ApplicationListRow } from "../src/modules/applications/applications.repository";
import type {
  ApplicationConfigVersionRow,
  ApplicationRow,
  NewApplication,
  NewApplicationConfigVersion,
} from "../src/modules/applications/schema";
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
import { INGESTION_QUEUE, RELEASE_CHECK_QUEUE } from "../src/platform/queue/queue.constants";
import { KnowledgeBasesRepository } from "../src/modules/knowledge-bases/knowledge-bases.repository";
import type { KnowledgeBaseRow } from "../src/modules/knowledge-bases/schema";
import { DocumentsRepository } from "../src/modules/documents/documents.repository";
import type { DocumentRow } from "../src/modules/documents/schema";
import { ChunksRepository } from "../src/modules/chunks/chunks.repository";
import { ProcessingRunsRepository } from "../src/modules/ingestion/processing-runs.repository";

const SECRET = "test-secret-at-least-32-characters-long!!";
const PRINCIPAL = { sub: "u1", email: "demo@codecrush.local" };

// M4：测试树引入 QueueModule/StorageModule/IngestionModule 的工厂 provider，它们注入
// AppConfigService——导入真实 AppConfigModule 并兜底必填 env（不连任何真实服务：
// pg-boss 已被 jest.mock 桩掉、BLOB_STORE/INGESTION_QUEUE token 均被 override）。
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/skeleton_e2e_unused";
process.env.JWT_SECRET ??= SECRET;
process.env.MODEL_API_KEY_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

// M6(012) PromptsRepository 内存实现（DB-free）：版本平权 + 排他标签 + 复合 FK/唯一约束模拟
let promptSeq = 0;
let promptVersionSeq = 0;
let promptTagSeq = 0;
const inMemoryPrompts: PromptRow[] = [];
const inMemoryVersions: PromptVersionRow[] = [];
const inMemoryPromptTags: Array<{
  id: string;
  promptId: string;
  promptVersionId: string;
  name: string;
  createdAt: Date;
  createdBy: string;
}> = [];

const pgError = (code: string) =>
  Object.assign(new Error(`pg error ${code}`), { cause: { code } });

const toListRow = (p: PromptRow): PromptListRow => {
  const versions = inMemoryVersions
    .filter((v) => v.promptId === p.id)
    .sort((a, b) => b.version - a.version);
  const latest = versions[0];
  return {
    ...p,
    latestVersionId: latest?.id ?? null,
    latestVersion: latest?.version ?? null,
    latestVariables: latest?.variables ?? null,
    versionCount: versions.length,
  };
};

const makeVersionRow = (row: NewPromptVersion): PromptVersionRow => {
  if (
    inMemoryVersions.some((v) => v.promptId === row.promptId && v.version === row.version)
  ) {
    throw pgError("23505"); // unique(promptId, version)
  }
  const r: PromptVersionRow = {
    id: `pv${++promptVersionSeq}`,
    promptId: row.promptId,
    version: row.version,
    body: row.body,
    variables: row.variables ?? [],
    contractVersion: row.contractVersion ?? 1,
    compileStatus: row.compileStatus,
    compileErrors: row.compileErrors ?? [],
    note: row.note ?? null,
    author: row.author,
    createdAt: new Date(),
  };
  inMemoryVersions.push(r);
  return r;
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
    const total = list.length;
    const start = (q.page - 1) * q.pageSize;
    return { items: list.slice(start, start + q.pageSize), total };
  },
  findPromptById: async (id: string): Promise<PromptListRow | undefined> => {
    const p = inMemoryPrompts.find((x) => x.id === id);
    return p ? toListRow(p) : undefined;
  },
  createPromptWithV1: async (
    prompt: NewPrompt,
    versionSeed: Omit<NewPromptVersion, "promptId">,
  ): Promise<{ prompt: PromptRow; version: PromptVersionRow }> => {
    if (inMemoryPrompts.some((x) => x.name === prompt.name)) throw pgError("23505");
    const p: PromptRow = {
      id: `p${++promptSeq}`,
      name: prompt.name,
      node: prompt.node,
      updatedBy: prompt.updatedBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    inMemoryPrompts.push(p);
    const version = makeVersionRow({ ...versionSeed, promptId: p.id } as NewPromptVersion);
    return { prompt: p, version };
  },
  findVersions: async (promptId: string): Promise<PromptVersionRow[]> =>
    inMemoryVersions
      .filter((v) => v.promptId === promptId)
      .sort((a, b) => b.version - a.version),
  findVersionById: async (id: string): Promise<PromptVersionRow | undefined> =>
    inMemoryVersions.find((v) => v.id === id),
  insertVersion: async (row: NewPromptVersion, actorEmail: string): Promise<PromptVersionRow> => {
    const r = makeVersionRow(row);
    const p = inMemoryPrompts.find((x) => x.id === row.promptId);
    if (p) {
      p.updatedBy = actorEmail;
      p.updatedAt = new Date();
    }
    return r;
  },
  findTagsByPromptId: async (promptId: string) =>
    inMemoryPromptTags
      .filter((t) => t.promptId === promptId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ promptVersionId: t.promptVersionId, name: t.name })),
  findTagsByVersionIds: async (versionIds: string[]) =>
    inMemoryPromptTags
      .filter((t) => versionIds.includes(t.promptVersionId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ promptVersionId: t.promptVersionId, name: t.name })),
  findTagsWithVersion: async (promptId: string) =>
    inMemoryPromptTags
      .filter((t) => t.promptId === promptId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        versionId: t.promptVersionId,
        version: inMemoryVersions.find((v) => v.id === t.promptVersionId)?.version ?? 0,
      })),
  upsertTag: async (promptId: string, versionId: string, name: string, actorEmail: string) => {
    // 复合 FK 模拟：版本必须存在且属于同一 prompt
    const version = inMemoryVersions.find((v) => v.id === versionId);
    if (!version || version.promptId !== promptId) throw pgError("23503");
    const existing = inMemoryPromptTags.find(
      (t) => t.promptId === promptId && t.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      existing.promptVersionId = versionId;
      existing.createdAt = new Date();
      existing.createdBy = actorEmail;
    } else {
      inMemoryPromptTags.push({
        id: `pt${++promptTagSeq}`,
        promptId,
        promptVersionId: versionId,
        name,
        createdAt: new Date(),
        createdBy: actorEmail,
      });
    }
  },
  deleteTag: async (promptId: string, name: string): Promise<number> => {
    const before = inMemoryPromptTags.length;
    for (let i = inMemoryPromptTags.length - 1; i >= 0; i--) {
      const t = inMemoryPromptTags[i];
      if (t.promptId === promptId && t.name === name) inMemoryPromptTags.splice(i, 1);
    }
    return before - inMemoryPromptTags.length;
  },
  findNodeVersionCandidates: async (node: string) =>
    inMemoryVersions
      .map((v) => ({ v, p: inMemoryPrompts.find((x) => x.id === v.promptId) }))
      .filter((x): x is { v: PromptVersionRow; p: PromptRow } => !!x.p && x.p.node === node)
      .sort((a, b) => a.p.name.localeCompare(b.p.name) || b.v.version - a.v.version)
      .map(({ v, p }) => ({
        promptId: p.id,
        promptName: p.name,
        versionId: v.id,
        version: v.version,
        compileStatus: v.compileStatus,
        createdAt: v.createdAt,
      })),
  deletePrompt: async (id: string): Promise<void> => {
    // FK RESTRICT 模拟：agent 配置版本引用该 prompt 的任一版本时拒删（23503）
    const versionIds = new Set(
      inMemoryVersions.filter((v) => v.promptId === id).map((v) => v.id),
    );
    const referenced = inMemoryAgentVersions.some(
      (av) =>
        versionIds.has(av.promptRewriteVerId) ||
        versionIds.has(av.promptIntentVerId) ||
        versionIds.has(av.promptReplyVerId) ||
        versionIds.has(av.promptFallbackVerId),
    );
    if (referenced) throw pgError("23503");
    const idx = inMemoryPrompts.findIndex((x) => x.id === id);
    if (idx >= 0) inMemoryPrompts.splice(idx, 1);
    for (let i = inMemoryVersions.length - 1; i >= 0; i--) {
      if (inMemoryVersions[i].promptId === id) inMemoryVersions.splice(i, 1);
    }
    for (let i = inMemoryPromptTags.length - 1; i >= 0; i--) {
      if (inMemoryPromptTags[i].promptId === id) inMemoryPromptTags.splice(i, 1);
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
  // M8.0：try-run 经 NodeRuntime 三层消息组装走到这里——回显全部消息内容，
  // e2e 只需证明"真的打到了 provider、不是伪造结果"，具体消息拼装细节由
  // node-runtime.compiler.spec.ts/node-runtime.executor.spec.ts 单测覆盖。
  chat: jest.fn(async (_config: unknown, messages: Array<{ role: string; content: string }>) => ({
    content: `echo:${messages.map((m) => m.content).join("|")}`,
  })),
  chatStream: jest.fn(async function* (
    _config: unknown,
    messages: Array<{ role: string; content: string }>,
  ) {
    yield { delta: `echo:${messages.map((m) => m.content).join("|")}` };
    yield { done: true };
  }),
  // KnowledgeBasesService.create() 的 1024 维探针会走到这里
  embed: jest.fn(async (_config: unknown, texts: string[]) => ({
    vectors: texts.map(() => Array.from({ length: 1024 }, () => 0.01)),
  })),
  // M5 retrieval 的 rerank 接线用例走到这里；不校验 config.type（接线验证，非业务校验）
  rerank: jest.fn(async (_config: unknown, _query: string, documents: string[]) => ({
    results: documents.map((_, i) => ({ index: i, score: 0.5 })),
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
  // M5 retrieval：一条罐头行（e2e 只验证 HTTP→service→repo→port 接线与契约形状，非召回语义；
  // 非空结果才能让 rerank 分支真正执行，空候选会短路跳过重排）
  searchByVector: async () => [
    {
      chunkId: "ch-e2e-1",
      docId: "doc-e2e-1",
      docName: "退换货政策.pdf",
      text: "7天无理由退货需保留商品完好",
      section: "退货条件",
      vecScore: 0.9,
    },
  ],
  searchByKeyword: async () => [],
} as Partial<ChunksRepository>;

// —— M4.1 ProcessingRunsRepository 内存实现（e2e 只验证接线与端点 smoke，无真库）——
const inMemoryProcessingRuns = new Map<string, Record<string, unknown>>();
let processingRunSeq = 0;
const inMemoryProcessingRunsRepo: Partial<ProcessingRunsRepository> = {
  insert: (async (row: Record<string, unknown>) => {
    const id = `run-e2e-${++processingRunSeq}`;
    const full = { id, status: "queued", createdAt: new Date(), startedAt: null, ...row };
    inMemoryProcessingRuns.set(id, full);
    return full;
  }) as ProcessingRunsRepository["insert"],
  findById: (async (id: string) => inMemoryProcessingRuns.get(id)) as ProcessingRunsRepository["findById"],
  findByDocument: (async (docId: string) =>
    [...inMemoryProcessingRuns.values()].filter(
      (r) => r.documentId === docId,
    )) as ProcessingRunsRepository["findByDocument"],
  update: (async (id: string, patch: Record<string, unknown>) => {
    const row = inMemoryProcessingRuns.get(id);
    if (row) inMemoryProcessingRuns.set(id, { ...row, ...patch });
    return inMemoryProcessingRuns.get(id);
  }) as ProcessingRunsRepository["update"],
};

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

// —— M7a ApplicationsRepository 内存实现（DB-free，同上手写风格）——
// production 指针默认 null（契约要求新建 v1 不上线）；prompt-usage 用例通过直接改
// inMemoryApplications[i].productionConfigVersionId 模拟迁移回填后的生产指针。
let applicationSeq = 0;
let applicationVerSeq = 0;
const inMemoryApplications: ApplicationRow[] = [];
const inMemoryAppVersions: ApplicationConfigVersionRow[] = [];
const inMemoryAppVersionKbs: Array<{ configVersionId: string; kbId: string }> = [];

const toAppListRow = (a: ApplicationRow): ApplicationListRow => {
  const versions = inMemoryAppVersions.filter((v) => v.applicationId === a.id);
  const production = a.productionConfigVersionId
    ? versions.find((v) => v.id === a.productionConfigVersionId)
    : undefined;
  return {
    ...a,
    productionVersion: production?.version ?? null,
    latestVersion: Math.max(1, ...versions.map((v) => v.version)),
    versionCount: versions.length || 1,
  };
};
const insertAppVersion = (
  row: NewApplicationConfigVersion,
  kbIds: string[],
): ApplicationConfigVersionRow => {
  // unique(application_id, version) 模拟：撞号抛 23505（service createVersion 会 retry）
  if (inMemoryAppVersions.some((v) => v.applicationId === row.applicationId && v.version === row.version))
    throw pgError("23505");
  const version = {
    id: `appv${++applicationVerSeq}`,
    configSchemaVersion: 1,
    rerankModelId: null,
    note: null,
    createdAt: new Date(),
    ...stripUndefined(row as Record<string, unknown>),
  } as ApplicationConfigVersionRow;
  inMemoryAppVersions.push(version);
  kbIds.forEach((kbId) => inMemoryAppVersionKbs.push({ configVersionId: version.id, kbId }));
  return version;
};

const inMemoryAppTags: {
  applicationId: string;
  configVersionId: string;
  name: string;
  createdBy: string;
}[] = [];

let appReleaseCheckSeq = 0;
const inMemoryReleaseChecks: Record<string, unknown>[] = [];

const inMemoryApplicationsRepo: Partial<ApplicationsRepository> = {
  findApplications: async () =>
    inMemoryApplications.filter((a) => !a.deletedAt).map(toAppListRow),
  findApplicationById: async (id: string) => {
    const a = inMemoryApplications.find((x) => x.id === id && !x.deletedAt);
    return a ? toAppListRow(a) : undefined;
  },
  // D8：撞名预检不过滤软删（DB unique 非 partial，软删 slug/name 不可复用）
  findBySlug: async (slug: string) => inMemoryApplications.find((x) => x.slug === slug),
  findByName: async (name: string) => inMemoryApplications.find((x) => x.name === name),
  findVersions: async (applicationId: string) =>
    inMemoryAppVersions
      .filter((v) => v.applicationId === applicationId)
      .sort((a, b) => b.version - a.version),
  findVersionById: async (id: string) => inMemoryAppVersions.find((v) => v.id === id),
  findVersionKbIds: async (id: string) =>
    inMemoryAppVersionKbs.filter((k) => k.configVersionId === id).map((k) => k.kbId),
  findKbIdsByVersionIds: async (ids: string[]) => {
    const map = new Map<string, string[]>();
    for (const k of inMemoryAppVersionKbs)
      if (ids.includes(k.configVersionId))
        map.set(k.configVersionId, [...(map.get(k.configVersionId) ?? []), k.kbId]);
    return map;
  },
  createApplicationWithV1: async (app: NewApplication, versionRow, kbIds: string[]) => {
    if (inMemoryApplications.some((x) => x.slug === app.slug || x.name === app.name))
      throw pgError("23505");
    const application = {
      id: `app${++applicationSeq}`,
      description: "",
      enabled: true,
      productionConfigVersionId: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...stripUndefined(app as Record<string, unknown>),
    } as ApplicationRow;
    inMemoryApplications.push(application);
    const version = insertAppVersion(
      { ...versionRow, applicationId: application.id } as NewApplicationConfigVersion,
      kbIds,
    );
    return { application, version };
  },
  insertVersion: async (row: NewApplicationConfigVersion, kbIds: string[], actor: string) => {
    const version = insertAppVersion(row, kbIds);
    const a = inMemoryApplications.find((x) => x.id === row.applicationId);
    if (a) {
      a.updatedBy = actor;
      a.updatedAt = new Date();
    }
    return version;
  },
  updateBase: async (id: string, patch) => {
    const a = inMemoryApplications.find((x) => x.id === id);
    if (!a) return undefined;
    Object.assign(a, stripUndefined(patch as Record<string, unknown>), { updatedAt: new Date() });
    return a;
  },
  // M7b：软删——置 deletedAt（幂等：仅未删的行），配置/kbs/标签快照保留供历史解释
  deleteApplication: async (id: string) => {
    const a = inMemoryApplications.find((x) => x.id === id && !x.deletedAt);
    if (!a) return 0;
    a.deletedAt = new Date();
    return 1;
  },
  findPromptUsage: async (promptVersionIds: string[]) => {
    if (promptVersionIds.length === 0) return [];
    const ids = new Set(promptVersionIds);
    const rows: {
      application_id: string;
      application_name: string;
      config_version: number;
      node: string;
      prompt_version_id: string;
    }[] = [];
    // 只看 production 指针指向的版本；节点优先级 rewrite>intent>reply>fallback，
    // 每个生产版本至多产一行（对齐真实 SQL 的 CASE 语义）。
    for (const a of inMemoryApplications) {
      if (!a.productionConfigVersionId) continue;
      const v = inMemoryAppVersions.find((x) => x.id === a.productionConfigVersionId);
      if (!v) continue;
      const ordered: Array<[string, string]> = [
        ["rewrite", v.promptRewriteVersionId],
        ["intent", v.promptIntentVersionId],
        ["reply", v.promptReplyVersionId],
        ["fallback", v.promptFallbackVersionId],
      ];
      const hit = ordered.find(([, colId]) => ids.has(colId));
      if (hit)
        rows.push({
          application_id: a.id,
          application_name: a.name,
          config_version: v.version,
          node: hit[0],
          prompt_version_id: hit[1],
        });
    }
    return rows;
  },
  // M7b S2 自定义标签（in-memory）
  findTagNamesByAppIds: async (appIds: string[]) => {
    const map = new Map<string, string[]>();
    for (const t of inMemoryAppTags)
      if (appIds.includes(t.applicationId))
        map.set(t.applicationId, [...(map.get(t.applicationId) ?? []), t.name]);
    return map;
  },
  findTagsWithVersion: async (appId: string) =>
    inMemoryAppTags
      .filter((t) => t.applicationId === appId)
      .map((t) => ({
        name: t.name,
        versionId: t.configVersionId,
        version: inMemoryAppVersions.find((v) => v.id === t.configVersionId)?.version ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  upsertTag: async (appId: string, versionId: string, name: string, actor: string) => {
    // 复合 FK 归属：拒绝指向别应用版本（对齐 DB 23503）
    const v = inMemoryAppVersions.find((x) => x.id === versionId);
    if (!v || v.applicationId !== appId) throw pgError("23503");
    const existing = inMemoryAppTags.find(
      (t) => t.applicationId === appId && t.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) existing.configVersionId = versionId;
    else inMemoryAppTags.push({ applicationId: appId, configVersionId: versionId, name, createdBy: actor });
  },
  deleteTag: async (appId: string, name: string) => {
    const before = inMemoryAppTags.length;
    for (let i = inMemoryAppTags.length - 1; i >= 0; i--)
      if (inMemoryAppTags[i].applicationId === appId && inMemoryAppTags[i].name === name)
        inMemoryAppTags.splice(i, 1);
    return before - inMemoryAppTags.length;
  },
  countTags: async (appId: string) =>
    inMemoryAppTags.filter((t) => t.applicationId === appId).length,
  tagExists: async (appId: string, lowerName: string) =>
    inMemoryAppTags.some((t) => t.applicationId === appId && t.name.toLowerCase() === lowerName),
  // M7b S4 ReleaseCheck（worker 在 e2e 不跑——fakeQueue.subscribe 是 no-op，故只留 queued 态）
  insertReleaseCheck: async (row: {
    applicationId: string;
    configVersionId: string;
    configFingerprint: string;
    createdBy: string;
  }) => {
    const check = {
      id: `rc${++appReleaseCheckSeq}`,
      ...row,
      status: "queued",
      issues: [],
      sampleSummary: {},
      startedAt: null,
      finishedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    };
    inMemoryReleaseChecks.push(check);
    return check;
  },
  findReleaseCheckById: async (id: string) => inMemoryReleaseChecks.find((c) => c.id === id),
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
        ApplicationsModule,
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
      .overrideProvider(ProcessingRunsRepository)
      .useValue(inMemoryProcessingRunsRepo)
      .overrideProvider(AgentsRepository)
      .useValue(inMemoryAgentsRepo)
      .overrideProvider(ApplicationsRepository)
      .useValue(inMemoryApplicationsRepo)
      .overrideProvider(BLOB_STORE)
      .useValue(fakeBlobStore)
      .overrideProvider(INGESTION_QUEUE)
      .useValue(fakeQueue)
      .overrideProvider(RELEASE_CHECK_QUEUE)
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

    it("POST multipart（autoParse 默认开，Profile 特性开）→ 201 + queued + 建 Run 超集入队", async () => {
      fakeQueue.publish.mockClear();
      const res = await request(app.getHttpServer())
        .post(`/api/knowledge-bases/${kbId}/documents`)
        .set(auth())
        .attach("files", Buffer.from("auto parse me"), "b.md")
        .expect(201);
      expect(res.body[0].status).toBe("queued");
      const doc = res.body[0];
      // Profile 特性开启（默认）→ 走 createRun：payload 携带 processingRunId，singletonKey=runId（去重按 Run）。
      expect(fakeQueue.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ documentId: doc.id, processingRunId: expect.any(String) }),
        expect.objectContaining({ retryLimit: 1 }),
      );
      const [, payload, opts] = fakeQueue.publish.mock.calls[0] as [
        string,
        { processingRunId: string },
        { singletonKey: string },
      ];
      expect(opts.singletonKey).toBe(payload.processingRunId);
    });

    it("GET /documents?kbId= → 200 + schema", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/documents?kbId=${kbId}`)
        .set(auth())
        .expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      for (const d of res.body) expect(() => DocumentSchema.parse(d)).not.toThrow();
    });

    it("POST /documents/:id/parse（空 body = 用当前方案重解析）→ 202，触发入队；不存在 → 404", async () => {
      fakeQueue.publish.mockClear();
      await request(app.getHttpServer())
        .post(`/api/documents/${docId}/parse`)
        .set(auth())
        .send({})
        .expect(202);
      expect(fakeQueue.publish).toHaveBeenCalled();
      await request(app.getHttpServer())
        .post("/api/documents/nope/parse")
        .set(auth())
        .send({})
        .expect(404);
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

    it("GET /documents/:id/content → 200（未解析时 text/markdown 为空串）", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/documents/${docId}/content`)
        .set(auth())
        .expect(200);
      expect(res.body.documentId).toBe(docId);
      expect(res.body.text).toBe("");
      expect(res.body.markdown).toBe("");
    });

    it("GET /documents/:id/processing-runs → 200 数组；不存在文档 → 404", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/documents/${docId}/processing-runs`)
        .set(auth())
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      await request(app.getHttpServer())
        .get("/api/documents/00000000-0000-0000-0000-000000000000/processing-runs")
        .set(auth())
        .expect(404);
    });

    it("GET /api/processing-profiles → 200 且方案数 ≥3（含 documentType 过滤）", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/processing-profiles")
        .set(auth())
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(3);
      expect(res.body[0]).toHaveProperty("label");
      expect(res.body[0]).toHaveProperty("summary");
      await request(app.getHttpServer())
        .get("/api/processing-profiles?documentType=pdf")
        .set(auth())
        .expect(200);
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
      // M5 起 service 真实查 kb/model：桩时代硬编码的 "m2" 会 404（models describe 删过行，
      // 内存 repo 以数组长度生成 id），改用文件级共享的 embeddingModelId。
      await ensureEmbeddingModel();
      const res = await request(app.getHttpServer())
        .post("/api/retrieval/test")
        .set(auth())
        .send({
          query: "退货",
          kbId: "kb1",
          embedModelId: embeddingModelId,
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

    it("POST /api/retrieval/test 带 rerankModelId → fake rerank port 被调用", async () => {
      await ensureEmbeddingModel();
      fakeModelProviderPort.rerank.mockClear();
      const res = await request(app.getHttpServer())
        .post("/api/retrieval/test")
        .set(auth())
        .send({
          query: "退货",
          kbId: "kb1",
          embedModelId: embeddingModelId,
          topK: 10,
          threshold: 0,
          multi: false,
          // 复用同一个 embedding 模型 id 当 rerankModelId：fake port 不校验 config.type，
          // 这里只验证接线（HTTP → service → port.rerank 被调到）而非真实业务校验。
          rerankModelId: embeddingModelId,
        })
        .expect(200);
      expect(() => RetrievalTestResponseSchema.parse(res.body)).not.toThrow();
      expect(fakeModelProviderPort.rerank).toHaveBeenCalled();
      expect(res.body.hits[0].rerankScore).toBe(0.5);
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
        // 012：创建返回 PromptDetail（含空 v1），直接取 versions[0].id
        const pRes = await request(app.getHttpServer())
          .post("/api/prompts")
          .set(auth())
          .send({ name: `agent-e2e-${node}`, node })
          .expect(201);
        ids[node] = pRes.body.versions[0].id;
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

  describe("applications (M7a)", () => {
    let appModelId: string;
    let appKbId: string;
    let promptVerIds: Record<"rewrite" | "intent" | "reply" | "fallback", string>;
    let appSeq = 0;

    const nodeCfg = (promptVersionId: string, modelId: string) => ({
      promptVersionId,
      modelId,
      freedom: "balance" as const,
      temperature: 0.7,
      topP: 0.9,
    });
    const validConfig = () => ({
      kbIds: [appKbId],
      nodes: {
        rewrite: nodeCfg(promptVerIds.rewrite, appModelId),
        intent: nodeCfg(promptVerIds.intent, appModelId),
        reply: nodeCfg(promptVerIds.reply, appModelId),
        fallback: nodeCfg(promptVerIds.fallback, appModelId),
      },
      retrieval: {
        schemaVersion: 1 as const,
        topK: 20,
        topN: 5,
        hybridEnabled: true,
        vectorWeight: 0.7,
        rerankEnabled: false,
      },
      fallback: { toHuman: true },
    });
    const validCreate = () => {
      appSeq++;
      return {
        slug: `demo-app-${appSeq}`,
        name: `演示应用-${appSeq}`,
        description: "e2e",
        config: validConfig(),
      };
    };

    // 自建 fixture（启用 llm 模型 / kb / 4 节点 prompt 版本）
    beforeAll(async () => {
      await ensureEmbeddingModel();
      const modelRes = await request(app.getHttpServer())
        .post("/api/models")
        .set(auth())
        .send({
          type: "llm",
          protocol: "openai_compat",
          name: "app-e2e-llm",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-appe2e123456",
        })
        .expect(201);
      appModelId = modelRes.body.id;

      const kbRes = await request(app.getHttpServer())
        .post("/api/knowledge-bases")
        .set(auth())
        .send({
          name: `app-e2e-kb-${Date.now()}`,
          desc: "",
          chunkTemplate: "general",
          embeddingModelId,
        })
        .expect(201);
      appKbId = kbRes.body.id;

      const nodes = ["rewrite", "intent", "reply", "fallback"] as const;
      const ids: Partial<Record<(typeof nodes)[number], string>> = {};
      for (const node of nodes) {
        const pRes = await request(app.getHttpServer())
          .post("/api/prompts")
          .set(auth())
          .send({ name: `app-e2e-${node}`, node })
          .expect(201);
        ids[node] = pRes.body.versions[0].id;
      }
      promptVerIds = ids as Record<(typeof nodes)[number], string>;
    });

    it("POST / 合法 → 201：v1 未上线、四 FK 与 JSONB 回读一致；同 slug/name 二发 409", async () => {
      const body = validCreate();
      const res = await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send(body)
        .expect(201);
      expect(() => ApplicationDetailSchema.parse(res.body)).not.toThrow();
      expect(res.body.productionConfigVersionId).toBeNull();
      expect(res.body.productionVersion).toBeNull();
      expect(res.body.latestVersion).toBe(1);
      expect(res.body.versions).toHaveLength(1);
      const v1 = res.body.versions[0];
      expect(v1.version).toBe(1);
      expect(v1.kbIds).toEqual([appKbId]);
      expect(v1.nodes.rewrite.promptVersionId).toBe(promptVerIds.rewrite);
      expect(v1.nodes.intent.promptVersionId).toBe(promptVerIds.intent);
      expect(v1.nodes.reply.promptVersionId).toBe(promptVerIds.reply);
      expect(v1.nodes.fallback.promptVersionId).toBe(promptVerIds.fallback);
      expect(v1.nodes.reply.modelId).toBe(appModelId);
      expect(v1.retrieval).toEqual(body.config.retrieval);
      expect(v1.fallback).toEqual({ toHuman: true });

      // 同 slug → 409
      await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send({ ...validCreate(), slug: body.slug })
        .expect(409);
      // 同 name → 409
      await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send({ ...validCreate(), name: body.name })
        .expect(409);
    });

    it("config-version-tags（M7b）：排他移动 / 标识列 / 保留字拒绝 / 摘除 / 跨应用 404", async () => {
      const created = (
        await request(app.getHttpServer())
          .post("/api/applications")
          .set(auth())
          .send(validCreate())
          .expect(201)
      ).body;
      const appId = created.id as string;
      const v1 = created.versions[0].id as string;
      const v2 = (
        await request(app.getHttpServer())
          .post(`/api/applications/${appId}/config-versions`)
          .set(auth())
          .send({ config: validConfig() })
          .expect(201)
      ).body.id as string;

      // 打 qa1 → v1
      let tags = (
        await request(app.getHttpServer())
          .put(`/api/applications/${appId}/config-version-tags`)
          .set(auth())
          .send({ name: "qa1", versionId: v1 })
          .expect(200)
      ).body;
      expect(tags).toContainEqual({ name: "qa1", versionId: v1, version: 1 });

      // 排他移动 qa1 → v2（同名唯一，从 v1 移到 v2）
      tags = (
        await request(app.getHttpServer())
          .put(`/api/applications/${appId}/config-version-tags`)
          .set(auth())
          .send({ name: "QA1", versionId: v2 })
          .expect(200)
      ).body;
      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatchObject({ name: "qa1", versionId: v2 });

      // 列表「标识」列含 qa1
      const listed = (
        await request(app.getHttpServer()).get("/api/applications").set(auth()).expect(200)
      ).body.find((a: { id: string }) => a.id === appId);
      expect(listed.tags).toContain("qa1");

      // 保留字 production/v → 契约 refine 拒绝（400）；不走标签路径
      await request(app.getHttpServer())
        .put(`/api/applications/${appId}/config-version-tags`)
        .set(auth())
        .send({ name: "production", versionId: v2 })
        .expect(400);

      // 摘除（大小写不敏感）→ 204；再摘不存在 → 404
      await request(app.getHttpServer())
        .delete(`/api/applications/${appId}/config-version-tags/qa1`)
        .set(auth())
        .expect(204);
      await request(app.getHttpServer())
        .delete(`/api/applications/${appId}/config-version-tags/qa1`)
        .set(auth())
        .expect(404);

      // 跨应用版本 → 404（复合 FK 归属）
      const other = (
        await request(app.getHttpServer())
          .post("/api/applications")
          .set(auth())
          .send(validCreate())
          .expect(201)
      ).body;
      await request(app.getHttpServer())
        .put(`/api/applications/${appId}/config-version-tags`)
        .set(auth())
        .send({ name: "qa2", versionId: other.versions[0].id })
        .expect(404);
    });

    it("release-checks（M7b）：静态门禁通过 → 201 queued + fingerprint + 轮询；坏版本 404", async () => {
      const created = (
        await request(app.getHttpServer())
          .post("/api/applications")
          .set(auth())
          .send(validCreate())
          .expect(201)
      ).body;
      const appId = created.id as string;
      const v1 = created.versions[0].id as string;

      const check = (
        await request(app.getHttpServer())
          .post(`/api/applications/${appId}/config-versions/${v1}/release-checks`)
          .set(auth())
          .expect(201)
      ).body;
      expect(check.status).toBe("queued");
      expect(check.configFingerprint).toEqual(expect.any(String));
      expect(check.configVersionId).toBe(v1);

      // 轮询检查状态
      const polled = (
        await request(app.getHttpServer())
          .get(`/api/applications/${appId}/release-checks/${check.id}`)
          .set(auth())
          .expect(200)
      ).body;
      expect(polled.id).toBe(check.id);

      // 不存在的版本 → 404
      await request(app.getHttpServer())
        .post(`/api/applications/${appId}/config-versions/does-not-exist/release-checks`)
        .set(auth())
        .expect(404);
    });

    it("POST / kbIds 空 → 400；引用不存在 prompt version → 404；node 不匹配 → 400", async () => {
      await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send({ ...validCreate(), config: { ...validConfig(), kbIds: [] } })
        .expect(400);

      const badPromptCfg = validConfig();
      badPromptCfg.nodes.rewrite = nodeCfg("nope", appModelId);
      await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send({ ...validCreate(), config: badPromptCfg })
        .expect(404);

      const mismatchCfg = validConfig();
      mismatchCfg.nodes.rewrite = nodeCfg(promptVerIds.intent, appModelId);
      await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send({ ...validCreate(), config: mismatchCfg })
        .expect(400);
    });

    it("PATCH 基础信息 200（name/description/enabled）；带 slug → 400（strict）", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send(validCreate())
        .expect(201);
      const res = await request(app.getHttpServer())
        .patch(`/api/applications/${created.body.id}`)
        .set(auth())
        .send({ name: `改名后-${appSeq}`, description: "改了描述", enabled: false })
        .expect(200);
      expect(() => ApplicationSchema.parse(res.body)).not.toThrow();
      expect(res.body.name).toBe(`改名后-${appSeq}`);
      expect(res.body.description).toBe("改了描述");
      expect(res.body.enabled).toBe(false);

      // slug 不可改（strictObject 拒未知键）
      await request(app.getHttpServer())
        .patch(`/api/applications/${created.body.id}`)
        .set(auth())
        .send({ slug: "new-slug" })
        .expect(400);
    });

    it("POST config-versions → 201 version 2；GET 列表降序 [2,1]；GET :versionId 归属不符 404", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send(validCreate())
        .expect(201);
      const appId = created.body.id;

      const v2 = await request(app.getHttpServer())
        .post(`/api/applications/${appId}/config-versions`)
        .set(auth())
        .send({ config: validConfig(), note: "调大召回" })
        .expect(201);
      expect(() => ApplicationConfigVersionSchema.parse(v2.body)).not.toThrow();
      expect(v2.body.version).toBe(2);
      expect(v2.body.note).toBe("调大召回");

      const list = await request(app.getHttpServer())
        .get(`/api/applications/${appId}/config-versions`)
        .set(auth())
        .expect(200);
      expect(list.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);

      // 归属不符：另一应用的版本从这个应用查 → 404
      const other = await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send(validCreate())
        .expect(201);
      const otherVersionId = other.body.versions[0].id;
      await request(app.getHttpServer())
        .get(`/api/applications/${appId}/config-versions/${otherVersionId}`)
        .set(auth())
        .expect(404);
    });

    it("验收 3：移动 Prompt 标签不改变应用引用的 prompt_*_version_id", async () => {
      // 建一个 reply prompt 的第二版，供标签移动
      const pRes = await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: `app-e2e-tagmove-${Date.now()}`, node: "reply" })
        .expect(201);
      const pid = pRes.body.id;
      const replyV1Id = pRes.body.versions[0].id;
      const v2 = await request(app.getHttpServer())
        .post(`/api/prompts/${pid}/versions`)
        .set(auth())
        .send({ body: "第二版 {query} {retrievalContext}" })
        .expect(201);

      const cfg = validConfig();
      cfg.nodes.reply = nodeCfg(replyV1Id, appModelId);
      const created = await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send({ ...validCreate(), config: cfg })
        .expect(201);
      const before = created.body.versions[0].nodes;

      // 移动 production 标签到 v2
      await request(app.getHttpServer())
        .put(`/api/prompts/${pid}/tags`)
        .set(auth())
        .send({ name: "production", versionId: v2.body.id })
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(`/api/applications/${created.body.id}`)
        .set(auth())
        .expect(200);
      // 应用引用的四节点版本 id 逐字节不变
      expect(after.body.versions[0].nodes).toEqual(before);
      expect(after.body.versions[0].nodes.reply.promptVersionId).toBe(replyV1Id);
    });

    it("GET prompt-usage：production 空 → []；置生产指针后返回具名条目；缺 promptId → 400", async () => {
      // production 指针为 null 时该 prompt 无使用
      const pRes = await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: `app-e2e-usage-${Date.now()}`, node: "reply" })
        .expect(201);
      const usagePromptId = pRes.body.id;
      const usageVersionId = pRes.body.versions[0].id;

      const cfg = validConfig();
      cfg.nodes.reply = nodeCfg(usageVersionId, appModelId);
      const created = await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send({ ...validCreate(), config: cfg })
        .expect(201);

      // 静态路由不被 :id 捕获，且 production 为 null → []
      const empty = await request(app.getHttpServer())
        .get(`/api/applications/prompt-usage?promptId=${usagePromptId}`)
        .set(auth())
        .expect(200);
      expect(empty.body).toEqual([]);

      // 手工把 production 指向 v1（模拟迁移回填/M7b 上线后的状态）
      const stored = inMemoryApplications.find((a) => a.id === created.body.id);
      stored!.productionConfigVersionId = created.body.versions[0].id;

      const used = await request(app.getHttpServer())
        .get(`/api/applications/prompt-usage?promptId=${usagePromptId}`)
        .set(auth())
        .expect(200);
      expect(Array.isArray(used.body)).toBe(true);
      expect(used.body).toHaveLength(1);
      expect(() => PromptUsageEntrySchema.parse(used.body[0])).not.toThrow();
      expect(used.body[0]).toMatchObject({
        applicationId: created.body.id,
        applicationName: created.body.name,
        node: "reply",
        configVersion: 1,
        promptVersionId: usageVersionId,
        promptVersion: 1,
      });

      // 缺 promptId → 400
      await request(app.getHttpServer())
        .get("/api/applications/prompt-usage")
        .set(auth())
        .expect(400);
    });

    it("POST .../:versionId/chat → 200 unavailable；跨应用版本 → 404", async () => {
      const created = await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send(validCreate())
        .expect(201);
      const appId = created.body.id;
      const versionId = created.body.versions[0].id;

      const res = await request(app.getHttpServer())
        .post(`/api/applications/${appId}/config-versions/${versionId}/chat`)
        .set(auth())
        .expect(200);
      expect(() => ApplicationChatResultSchema.parse(res.body)).not.toThrow();
      expect(res.body).toEqual({ mode: "unavailable", reason: "pending_orchestration" });

      // 跨应用：拿别的应用的版本 id 走这个应用的 chat → 404
      const other = await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send(validCreate())
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/applications/${appId}/config-versions/${other.body.versions[0].id}/chat`)
        .set(auth())
        .expect(404);
    });

    it("DELETE 软删（M7b）→ 204；GET/列表/版本隐藏；slug 不可复用；再删 404", async () => {
      const body = validCreate();
      const created = await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send(body)
        .expect(201);
      const appId = created.body.id;

      await request(app.getHttpServer())
        .delete(`/api/applications/${appId}`)
        .set(auth())
        .expect(204);
      // detail 404（mustFind 过滤 deleted_at）
      await request(app.getHttpServer())
        .get(`/api/applications/${appId}`)
        .set(auth())
        .expect(404);
      // 列表排除软删应用
      const listed = (
        await request(app.getHttpServer()).get("/api/applications").set(auth()).expect(200)
      ).body;
      expect(listed.some((a: { id: string }) => a.id === appId)).toBe(false);
      // 版本端点因应用不可见 → 404（软删保留版本行，仅读路径隐藏）
      await request(app.getHttpServer())
        .get(`/api/applications/${appId}/config-versions`)
        .set(auth())
        .expect(404);
      // D8：软删行仍占 slug/name（DB unique 非 partial）→ 同 slug 再建 409
      await request(app.getHttpServer())
        .post("/api/applications")
        .set(auth())
        .send({ ...validCreate(), slug: body.slug })
        .expect(409);
      // 幂等：再删软删应用 → 404（deleteApplication 返回 0）
      await request(app.getHttpServer())
        .delete(`/api/applications/${appId}`)
        .set(auth())
        .expect(404);
    });
  });

  describe("prompts (012)", () => {
    let promptId: string;
    let v1Id: string;
    let v2Id: string;

    it("POST /api/prompts {name,node} → 201 PromptDetail：空 v1、无标签、updatedBy=JWT email", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: "测试 Prompt", node: "rewrite" })
        .expect(201);
      expect(() => PromptDetailSchema.parse(res.body)).not.toThrow();
      expect(res.body.latestVersion).toBe(1);
      expect(res.body.versionCount).toBe(1);
      expect(res.body.tags).toEqual([]);
      expect(res.body.updatedBy).toBe(PRINCIPAL.email);
      expect(res.body.versions).toHaveLength(1);
      expect(res.body.versions[0].body).toBe("");
      expect(res.body.versions[0].compileStatus).toBe("ok");
      expect(res.body.versions[0].author).toBe(PRINCIPAL.email);
      promptId = res.body.id;
      v1Id = res.body.versions[0].id;
    });

    it("POST 同名 → 409（name 唯一）", async () => {
      await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: "测试 Prompt", node: "reply" })
        .expect(409);
    });

    it("POST /:id/versions → 201 不可变新版本（服务端编译持久化，作者来自 JWT）", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions`)
        .set(auth())
        .send({ body: "改写 {query}", note: "v2", author: "forged@evil.com" })
        .expect(201);
      expect(() => PromptVersionSchema.parse(res.body)).not.toThrow();
      expect(res.body.version).toBe(2);
      expect(res.body.compileStatus).toBe("ok");
      expect(res.body.variables).toEqual(["query"]);
      expect(res.body.author).toBe(PRINCIPAL.email);
      v2Id = res.body.id;
    });

    it("编译错误的 body 允许保存（compileStatus=has_errors + issues）", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions`)
        .set(auth())
        .send({ body: "未知 {nonexistent_field}" })
        .expect(201);
      expect(res.body.compileStatus).toBe("has_errors");
      expect(res.body.compileErrors[0].code).toBe("UNKNOWN_VARIABLE");
    });

    it("GET /:id → PromptDetail：versions 降序 + 最新版本摘要", async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/prompts/${promptId}`)
        .set(auth())
        .expect(200);
      expect(() => PromptDetailSchema.parse(res.body)).not.toThrow();
      expect(res.body.latestVersion).toBe(3);
      expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    });

    it("PUT /:id/tags 移动标签：大小写归一小写 + 排他移动", async () => {
      // Production → 归一 production，指到 v2
      const first = await request(app.getHttpServer())
        .put(`/api/prompts/${promptId}/tags`)
        .set(auth())
        .send({ name: "Production", versionId: v2Id })
        .expect(200);
      expect(first.body).toEqual([{ name: "production", versionId: v2Id, version: 2 }]);
      // 再移到 v1 —— 同名标签只有一行，指向变更
      const moved = await request(app.getHttpServer())
        .put(`/api/prompts/${promptId}/tags`)
        .set(auth())
        .send({ name: "production", versionId: v1Id })
        .expect(200);
      expect(moved.body).toEqual([{ name: "production", versionId: v1Id, version: 1 }]);
      // 详情里 v1 带标签、v2 无标签
      const detail = await request(app.getHttpServer())
        .get(`/api/prompts/${promptId}`)
        .set(auth())
        .expect(200);
      const v1 = detail.body.versions.find((v: { id: string }) => v.id === v1Id);
      const v2 = detail.body.versions.find((v: { id: string }) => v.id === v2Id);
      expect(v1.tags).toEqual(["production"]);
      expect(v2.tags).toEqual([]);
    });

    it("PUT tags 指向别的 Prompt 的版本 → 404；非法标签名 → 400", async () => {
      const other = await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: "另一个 Prompt", node: "rewrite" })
        .expect(201);
      await request(app.getHttpServer())
        .put(`/api/prompts/${promptId}/tags`)
        .set(auth())
        .send({ name: "cross", versionId: other.body.versions[0].id })
        .expect(404);
      await request(app.getHttpServer())
        .put(`/api/prompts/${promptId}/tags`)
        .set(auth())
        .send({ name: "有 空格", versionId: v1Id })
        .expect(400);
      await request(app.getHttpServer())
        .delete(`/api/prompts/${other.body.id}`)
        .set(auth())
        .expect(204);
    });

    it("DELETE /:id/tags/:name → 204；再删 → 404", async () => {
      await request(app.getHttpServer())
        .put(`/api/prompts/${promptId}/tags`)
        .set(auth())
        .send({ name: "beta", versionId: v2Id })
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/api/prompts/${promptId}/tags/beta`)
        .set(auth())
        .expect(204);
      await request(app.getHttpServer())
        .delete(`/api/prompts/${promptId}/tags/beta`)
        .set(auth())
        .expect(404);
    });

    it("GET /api/prompts/versions?node= → 节点全版本候选（含无标签版本，静态路由不被 :id 捕获）", async () => {
      const res = await request(app.getHttpServer())
        .get("/api/prompts/versions?node=rewrite")
        .set(auth())
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      for (const c of res.body) expect(() => PromptNodeVersionCandidateSchema.parse(c)).not.toThrow();
      const mine = res.body.filter((c: { promptId: string }) => c.promptId === promptId);
      expect(mine).toHaveLength(3); // 全部版本平权，不过滤
      expect(mine.some((c: { tags: string[] }) => c.tags.includes("production"))).toBe(true);
      expect(mine.some((c: { tags: string[] }) => c.tags.length === 0)).toBe(true);
      // 非法 node → 400
      await request(app.getHttpServer())
        .get("/api/prompts/versions?node=summary")
        .set(auth())
        .expect(400);
    });

    it("GET /api/prompts → 分页响应 + PromptSchema（携带最新版本 tags/variables）", async () => {
      const res = await request(app.getHttpServer()).get("/api/prompts").set(auth()).expect(200);
      expect(res.body).toHaveProperty("total");
      expect(res.body).toHaveProperty("page", 1);
      expect(res.body).toHaveProperty("pageSize", 10);
      for (const p of res.body.items) expect(() => PromptSchema.parse(p)).not.toThrow();
    });

    it("旧发布状态机端点已删除：publish/rollback → 404", async () => {
      await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions/${v1Id}/publish`)
        .set(auth())
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/prompts/${promptId}/versions/${v1Id}/rollback`)
        .set(auth())
        .expect(404);
    });

    it("DELETE /api/prompts/:id：无引用 → 204（含标签级联）；不存在 → 404", async () => {
      // promptId 带着 production 标签也可删——不再有「已发布不可删」语义
      await request(app.getHttpServer())
        .delete(`/api/prompts/${promptId}`)
        .set(auth())
        .expect(204);
      await request(app.getHttpServer()).get(`/api/prompts/${promptId}`).set(auth()).expect(404);
      await request(app.getHttpServer())
        .delete("/api/prompts/nonexistent-id")
        .set(auth())
        .expect(404);
    });

    it("DELETE 被 Agent 配置引用的 Prompt → 409（FK RESTRICT 事实）", async () => {
      // agents describe 的 fixture prompt（agent-e2e-rewrite）已被 Agent 配置引用
      const list = await request(app.getHttpServer())
        .get("/api/prompts?search=agent-e2e-rewrite")
        .set(auth())
        .expect(200);
      expect(list.body.items).toHaveLength(1);
      await request(app.getHttpServer())
        .delete(`/api/prompts/${list.body.items[0].id}`)
        .set(auth())
        .expect(409);
    });
  });

  describe("prompts try-run (012 Story 7)", () => {
    let replyPromptId: string;
    let replyVersionId: string;
    let errorVersionId: string;
    let rewritePromptId: string;
    let rewriteVersionId: string;
    let llmModelId: string;

    beforeAll(async () => {
      const model = await request(app.getHttpServer())
        .post("/api/models")
        .set(auth())
        .send({
          type: "llm",
          protocol: "openai_compat",
          name: "tryrun-e2e-llm",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-tryrune2e12345",
        })
        .expect(201);
      llmModelId = model.body.id;

      const reply = await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: "tryrun-reply", node: "reply" })
        .expect(201);
      replyPromptId = reply.body.id;
      const v2 = await request(app.getHttpServer())
        .post(`/api/prompts/${replyPromptId}/versions`)
        .set(auth())
        .send({ body: "依据 {retrievalContext} 回答 {query}" })
        .expect(201);
      replyVersionId = v2.body.id;
      const bad = await request(app.getHttpServer())
        .post(`/api/prompts/${replyPromptId}/versions`)
        .set(auth())
        .send({ body: "坏字段 {unknown_field_x}" })
        .expect(201);
      errorVersionId = bad.body.id;

      const rewrite = await request(app.getHttpServer())
        .post("/api/prompts")
        .set(auth())
        .send({ name: "tryrun-rewrite", node: "rewrite" })
        .expect(201);
      rewritePromptId = rewrite.body.id;
      rewriteVersionId = rewrite.body.versions[0].id;
    });

    it("reply 真实调用：经 NodeRuntime 两层组装打到 provider.chatStream → mode:text（M8.0）", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/prompts/${replyPromptId}/versions/${replyVersionId}/try-run`)
        .set(auth())
        .send({
          modelId: llmModelId,
          temperature: 0.5,
          testVars: { query: "怎么退货", retrievalContext: "第二条 七天无理由" },
        })
        .expect(200);
      // 只断言"真的打到了 provider、拿到真实回显"，不锁定两层消息拼装的具体字符串——
      // 那部分已由 node-runtime.compiler.spec.ts 单测覆盖，这里是 wiring smoke test。
      expect(res.body.mode).toBe("text");
      expect(res.body.text).toMatch(/^echo:/);
      expect(res.body.text).toContain("依据 第二条 七天无理由 回答 怎么退货"); // 管理员正文渲染结果，现在拼进 system 消息
      expect(res.body.text).toContain("怎么退货"); // user 层 JSON envelope 里的 query
    });

    it("rewrite 节点：经 NodeRuntime.executeStructured 真实结构化（echo 非合法 JSON → 修复两次后 fallback，不再是 unavailable，M8.0）", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/prompts/${rewritePromptId}/versions/${rewriteVersionId}/try-run`)
        .set(auth())
        .send({ modelId: llmModelId, testVars: { query: "q" } })
        .expect(200);
      // echo mock 回显的不是合法 JSON，两次尝试都失败 → fallback：直接用原始 query
      expect(res.body).toEqual({
        mode: "structured",
        fields: { rewrittenQuery: "q", keywords: [] },
        validateSteps: expect.any(Array),
        fallbackUsed: true,
      });
      expect(fakeModelProviderPort.chat).toHaveBeenCalledTimes(2); // 首次 + 修复重试一次，不递归
    });

    it("存量编译错误的版本 → 422，不调用 provider", async () => {
      await request(app.getHttpServer())
        .post(`/api/prompts/${replyPromptId}/versions/${errorVersionId}/try-run`)
        .set(auth())
        .send({ modelId: llmModelId, testVars: { query: "q" } })
        .expect(422);
    });

    it("refApplicationId 非空 → unavailable/application_context_not_available（009 门控）", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/prompts/${replyPromptId}/versions/${replyVersionId}/try-run`)
        .set(auth())
        .send({ modelId: llmModelId, testVars: { query: "q" }, refApplicationId: "app-x" })
        .expect(200);
      expect(res.body).toEqual({
        mode: "unavailable",
        reason: "application_context_not_available",
      });
    });

    it("temperature 越界（>2）→ 400；版本不属于该 Prompt → 404", async () => {
      await request(app.getHttpServer())
        .post(`/api/prompts/${replyPromptId}/versions/${replyVersionId}/try-run`)
        .set(auth())
        .send({ modelId: llmModelId, temperature: 3, testVars: { query: "q" } })
        .expect(400);
      await request(app.getHttpServer())
        .post(`/api/prompts/${replyPromptId}/versions/${rewriteVersionId}/try-run`)
        .set(auth())
        .send({ modelId: llmModelId, testVars: { query: "q" } })
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
      // 012：新静态候选路由 + 标签路由；旧发布状态机路由必须不存在
      expect(paths).toContain("/api/prompts/versions");
      expect(paths).toContain("/api/prompts/{id}/tags");
      expect(paths).toContain("/api/prompts/{id}/tags/{name}");
      expect(paths).not.toContain("/api/prompts/{id}/versions/{versionId}/publish");
      expect(paths).not.toContain("/api/prompts/{id}/versions/{versionId}/rollback");
      expect(paths).toContain("/api/chat");
      expect(paths).toContain("/api/conversations/{id}/messages");
      // M7a applications：静态 prompt-usage + 版本 chat 骨架；M7b production 端点不存在
      expect(paths).toContain("/api/applications");
      expect(paths).toContain("/api/applications/{id}");
      expect(paths).toContain("/api/applications/prompt-usage");
      expect(paths).toContain("/api/applications/{id}/config-versions");
      expect(paths).toContain("/api/applications/{id}/config-versions/{versionId}");
      expect(paths).toContain("/api/applications/{id}/config-versions/{versionId}/chat");
      expect(paths).not.toContain("/api/applications/{id}/production");
    });
  });
});
