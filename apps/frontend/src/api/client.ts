import {
  AgentListResponseSchema,
  AgentSchema,
  type Agent,
  type AgentListResponse,
  AgentConfigVersionListResponseSchema,
  type AgentConfigVersionListResponse,
  AgentConfigVersionSchema,
  type AgentConfigVersion,
  CreateAgentRequestSchema,
  type CreateAgentRequest,
  UpdateAgentRequestSchema,
  type UpdateAgentRequest,
  CreateAgentConfigVersionRequestSchema,
  type CreateAgentConfigVersionRequest,
  ChunkBatchDeleteRequestSchema,
  type ChunkBatchDeleteRequest,
  ChunkBatchDeleteResponseSchema,
  type ChunkBatchDeleteResponse,
  ChunkPageResponseSchema,
  type ChunkPageResponse,
  ConversationListResponseSchema,
  ConversationSchema,
  type Conversation,
  type ConversationListResponse,
  CreateKnowledgeBaseRequestSchema,
  type CreateKnowledgeBaseRequest,
  DocumentContentResponseSchema,
  type DocumentContentResponse,
  DocumentLifecycleResponseSchema,
  type DocumentLifecycleResponse,
  DocumentListResponseSchema,
  type DocumentListResponse,
  DocumentSchema,
  type Document,
  type DocumentType,
  HealthResponseSchema,
  type HealthResponse,
  ParseDocumentRequestSchema,
  type ParseDocumentRequest,
  ProcessingProfileListResponseSchema,
  type ProcessingProfileDescriptor,
  ProcessingRunListResponseSchema,
  type ProcessingRun,
  RebuildKnowledgeBaseRequestSchema,
  type RebuildKnowledgeBaseRequest,
  KnowledgeBaseListResponseSchema,
  type KnowledgeBaseListResponse,
  KnowledgeBaseSchema,
  type KnowledgeBase,
  MessageListResponseSchema,
  type MessageListResponse,
  ModelProviderListResponseSchema,
  type ModelProviderListResponse,
  ModelProviderSchema,
  type ModelProvider,
  CreateModelRequestSchema,
  type CreateModelRequest,
  UpdateModelRequestSchema,
  type UpdateModelRequest,
  TestModelOverrideSchema,
  type TestModelOverride,
  TestModelRequestSchema,
  type TestModelRequest,
  TestModelResponseSchema,
  type TestModelResponse,
  CreatePromptRequestSchema,
  type CreatePromptRequest,
  CreatePromptVersionRequestSchema,
  type CreatePromptVersionRequest,
  PromptListResponseSchema,
  type PromptListResponse,
  type PromptNode,
  PromptSchema,
  type Prompt,
  PromptVersionListResponseSchema,
  type PromptVersionListResponse,
  PromptVersionSchema,
  type PromptVersion,
  RetrievalTestRequestSchema,
  type RetrievalTestRequest,
  RetrievalTestResponseSchema,
  type RetrievalTestResponse,
  UpdateDocumentMetadataRequestSchema,
  type UpdateDocumentMetadataRequest,
  UpdateKnowledgeBaseRequestSchema,
  type UpdateKnowledgeBaseRequest,
} from "@codecrush/contracts";

const TOKEN_KEY = "token";

/**
 * Zod schema 的最小结构接口——避免前端直接 import `zod`（AGENTS.md 边界：前端只 import
 * `@codecrush/contracts` 与 `@codecrush/otel-conventions`）。zod schema 实例的 `.parse()`
 * 签名结构兼容本接口（参数更宽 + 返回 T）。
 */
interface ZodSchema<T> {
  parse(input: unknown): T;
}

/**
 * 通用 fetch 封装：自动注入 `Authorization: Bearer <token>`（来自 localStorage），
 * 401 时清 token 并重定向到 /login。`/health` 等无鉴权端点应直接用 fetch 而非本函数。
 *
 * M2 页面用 mock 数据不调用本函数；为 M3+ 接真实后端铺路。
 */
export async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = new Headers(opts.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const isFormData = typeof FormData !== "undefined" && opts.body instanceof FormData;
  if (opts.body && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const resp = await fetch(path, { ...opts, headers });
  if (resp.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    window.location.assign("/login");
  }
  return resp;
}

/** GET + Zod 校验的便捷封装。非 2xx 抛错。 */
async function getJson<T>(path: string, schema: ZodSchema<T>, opts?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, { ...opts, method: opts?.method ?? "GET" });
  if (!resp.ok) {
    throw new Error(`${path} failed: ${resp.status} ${resp.statusText}`);
  }
  return schema.parse(await resp.json());
}

/** POST + 请求体 Zod 校验 + 响应 Zod 校验。 */
async function postJson<TReq, TRes>(
  path: string,
  body: TReq,
  reqSchema: ZodSchema<TReq>,
  resSchema: ZodSchema<TRes>,
): Promise<TRes> {
  const resp = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(reqSchema.parse(body)),
  });
  if (!resp.ok) {
    throw new Error(`${path} failed: ${resp.status} ${resp.statusText}`);
  }
  return resSchema.parse(await resp.json());
}

// === 无鉴权端点 ===

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch("/health");
  return HealthResponseSchema.parse(await res.json());
}

// === 域 typed client（M3+ 真实调用；M2 页面用 mock 不调用）===
// 路径对齐后端 skeleton 路由前缀（见各域 @Controller）。
// evalsets/evals 后端无 skeleton（M11 才有），故不在此声明。

// agents — @Controller("agents")（M7 真实 CRUD + 配置版本 + Eval stub + 发布/回滚）
export const getAgents = (): Promise<AgentListResponse> =>
  getJson("/api/agents", AgentListResponseSchema);
export const getAgent = (id: string): Promise<Agent> =>
  getJson(`/api/agents/${encodeURIComponent(id)}`, AgentSchema);
export const createAgent = (req: CreateAgentRequest): Promise<Agent> =>
  postJson("/api/agents", req, CreateAgentRequestSchema, AgentSchema);
export async function updateAgent(id: string, req: UpdateAgentRequest): Promise<Agent> {
  const resp = await apiFetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(UpdateAgentRequestSchema.parse(req)),
  });
  if (!resp.ok) throw new Error(`update agent failed: ${resp.status} ${resp.statusText}`);
  return AgentSchema.parse(await resp.json());
}
export const getAgentConfigVersions = (
  agentId: string,
): Promise<AgentConfigVersionListResponse> =>
  getJson(
    `/api/agents/${encodeURIComponent(agentId)}/config-versions`,
    AgentConfigVersionListResponseSchema,
  );
export const createAgentConfigVersion = (
  agentId: string,
  req: CreateAgentConfigVersionRequest,
): Promise<AgentConfigVersion> =>
  postJson(
    `/api/agents/${encodeURIComponent(agentId)}/config-versions`,
    req,
    CreateAgentConfigVersionRequestSchema,
    AgentConfigVersionSchema,
  );
// eval-run / publish / rollback：无请求体 POST（对齐 prompts publish/rollback 的封装形状）
async function postAgentVersionAction(
  agentId: string,
  versionId: string,
  action: "eval-run" | "publish" | "rollback",
): Promise<AgentConfigVersion> {
  const resp = await apiFetch(
    `/api/agents/${encodeURIComponent(agentId)}/config-versions/${encodeURIComponent(versionId)}/${action}`,
    { method: "POST" },
  );
  if (!resp.ok) throw new Error(`${action} failed: ${resp.status}`);
  return AgentConfigVersionSchema.parse(await resp.json());
}
export const runAgentConfigVersionEval = (
  agentId: string,
  versionId: string,
): Promise<AgentConfigVersion> => postAgentVersionAction(agentId, versionId, "eval-run");
export const publishAgentConfigVersion = (
  agentId: string,
  versionId: string,
): Promise<AgentConfigVersion> => postAgentVersionAction(agentId, versionId, "publish");
export const rollbackAgentConfigVersion = (
  agentId: string,
  versionId: string,
): Promise<AgentConfigVersion> => postAgentVersionAction(agentId, versionId, "rollback");

// models — @Controller("models")（M3 真实 CRUD + 连通性测试）
export const getModels = (): Promise<ModelProviderListResponse> =>
  getJson("/api/models", ModelProviderListResponseSchema);
export const createModel = (req: CreateModelRequest): Promise<ModelProvider> =>
  postJson("/api/models", req, CreateModelRequestSchema, ModelProviderSchema);
export async function updateModel(id: string, req: UpdateModelRequest): Promise<ModelProvider> {
  const resp = await apiFetch(`/api/models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(UpdateModelRequestSchema.parse(req)),
  });
  if (!resp.ok) throw new Error(`update model failed: ${resp.status} ${resp.statusText}`);
  return ModelProviderSchema.parse(await resp.json());
}
export async function deleteModel(id: string): Promise<void> {
  const resp = await apiFetch(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!resp.ok) throw new Error(`delete model failed: ${resp.status} ${resp.statusText}`);
}
// override：编辑抽屉改了配置但未换 key 时传当前配置（不含 key），服务端用存量 key 测试
export async function testModel(
  id: string,
  override?: TestModelOverride,
): Promise<TestModelResponse> {
  const resp = await apiFetch(`/api/models/${encodeURIComponent(id)}/test`, {
    method: "POST",
    ...(override ? { body: JSON.stringify(TestModelOverrideSchema.parse(override)) } : {}),
  });
  if (!resp.ok) throw new Error(`test model failed: ${resp.status} ${resp.statusText}`);
  return TestModelResponseSchema.parse(await resp.json());
}
// ad-hoc 测试：抽屉保存前验活（明文 key 仅经 HTTPS 透传，不落库）
export const testModelConfig = (req: TestModelRequest): Promise<TestModelResponse> =>
  postJson("/api/models/test", req, TestModelRequestSchema, TestModelResponseSchema);

// knowledge-bases — @Controller("knowledge-bases")
export const getKnowledgeBases = (): Promise<KnowledgeBaseListResponse> =>
  getJson("/api/knowledge-bases", KnowledgeBaseListResponseSchema);
export const createKnowledgeBase = (req: CreateKnowledgeBaseRequest): Promise<KnowledgeBase> =>
  postJson("/api/knowledge-bases", req, CreateKnowledgeBaseRequestSchema, KnowledgeBaseSchema);
export async function updateKnowledgeBase(
  id: string,
  req: UpdateKnowledgeBaseRequest,
): Promise<KnowledgeBase> {
  const resp = await apiFetch(`/api/knowledge-bases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(UpdateKnowledgeBaseRequestSchema.parse(req)),
  });
  if (!resp.ok) throw new Error(`update kb failed: ${resp.status} ${resp.statusText}`);
  return KnowledgeBaseSchema.parse(await resp.json());
}

// 显式重建（应用新默认方案到已有文档）：scope='inherited' 只重建继承默认的文档。202 返回 building 态 KB。
export async function rebuildKnowledgeBase(
  id: string,
  req: RebuildKnowledgeBaseRequest,
): Promise<KnowledgeBase> {
  const resp = await apiFetch(`/api/knowledge-bases/${encodeURIComponent(id)}/rebuild`, {
    method: "POST",
    body: JSON.stringify(RebuildKnowledgeBaseRequestSchema.parse(req)),
  });
  if (!resp.ok) throw new Error(`rebuild failed: ${resp.status} ${resp.statusText}`);
  return KnowledgeBaseSchema.parse(await resp.json());
}

// 处理方案目录（只读）：知识库/上传/重解析选择方案用。documentType 过滤仅返回支持该类型的方案。
export const getProcessingProfiles = (
  documentType?: DocumentType,
): Promise<ProcessingProfileDescriptor[]> =>
  getJson(
    `/api/processing-profiles${documentType ? `?documentType=${encodeURIComponent(documentType)}` : ""}`,
    ProcessingProfileListResponseSchema,
  );

// documents — 上传挂在知识库资源下；其余操作扁平挂在 /api/documents/:id 下
export const getDocuments = (kbId: string): Promise<DocumentListResponse> =>
  getJson(`/api/documents?kbId=${encodeURIComponent(kbId)}`, DocumentListResponseSchema);

export async function uploadDocuments(
  kbId: string,
  files: File[],
  opts: { autoParse: boolean; profile?: { profileId: string; profileVersion: number } },
): Promise<Document[]> {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  form.append("autoParse", String(opts.autoParse));
  if (opts.profile) {
    form.append("profileId", opts.profile.profileId);
    form.append("profileVersion", String(opts.profile.profileVersion));
  }
  const resp = await apiFetch(`/api/knowledge-bases/${encodeURIComponent(kbId)}/documents`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) throw new Error(`upload failed: ${resp.status} ${resp.statusText}`);
  const json = await resp.json();
  return (json as unknown[]).map((d) => DocumentSchema.parse(d));
}

// 空 body = 用当前有效方案重解析；{mode:"retry"} = 服务端复用最近失败 Run 快照；
// {profileId,profileVersion} = 显式换方案（服务端写回文档 override）。
export async function triggerParse(
  docId: string,
  req: ParseDocumentRequest = {},
): Promise<Document> {
  const resp = await apiFetch(`/api/documents/${encodeURIComponent(docId)}/parse`, {
    method: "POST",
    body: JSON.stringify(ParseDocumentRequestSchema.parse(req)),
  });
  if (!resp.ok) throw new Error(`parse trigger failed: ${resp.status} ${resp.statusText}`);
  return DocumentSchema.parse(await resp.json());
}

// 文档处理历史（Run 列表，createdAt desc）：生命周期抽屉「处理历史」区块用。
export const getProcessingRuns = (docId: string): Promise<ProcessingRun[]> =>
  getJson(
    `/api/documents/${encodeURIComponent(docId)}/processing-runs`,
    ProcessingRunListResponseSchema,
  );

export const getDocumentLifecycle = (docId: string): Promise<DocumentLifecycleResponse> =>
  getJson(`/api/documents/${encodeURIComponent(docId)}/lifecycle`, DocumentLifecycleResponseSchema);

export async function updateDocumentMetadata(
  docId: string,
  req: UpdateDocumentMetadataRequest,
): Promise<Document> {
  const resp = await apiFetch(`/api/documents/${encodeURIComponent(docId)}/metadata`, {
    method: "PATCH",
    body: JSON.stringify(UpdateDocumentMetadataRequestSchema.parse(req)),
  });
  if (!resp.ok) throw new Error(`update metadata failed: ${resp.status} ${resp.statusText}`);
  return DocumentSchema.parse(await resp.json());
}

export async function deleteDocument(docId: string): Promise<void> {
  const resp = await apiFetch(`/api/documents/${encodeURIComponent(docId)}`, { method: "DELETE" });
  if (!resp.ok) throw new Error(`delete document failed: ${resp.status} ${resp.statusText}`);
}

export const getDocumentContent = (docId: string): Promise<DocumentContentResponse> =>
  getJson(`/api/documents/${encodeURIComponent(docId)}/content`, DocumentContentResponseSchema);

// chunks
export function getDocumentChunks(
  docId: string,
  query: { offset: number; limit: number; q?: string },
): Promise<ChunkPageResponse> {
  const params = new URLSearchParams();
  params.set("offset", String(query.offset));
  params.set("limit", String(query.limit));
  if (query.q) params.set("q", query.q);
  return getJson(
    `/api/documents/${encodeURIComponent(docId)}/chunks?${params.toString()}`,
    ChunkPageResponseSchema,
  );
}

export const batchDeleteChunks = (
  req: ChunkBatchDeleteRequest,
): Promise<ChunkBatchDeleteResponse> =>
  postJson(
    "/api/chunks/batch-delete",
    req,
    ChunkBatchDeleteRequestSchema,
    ChunkBatchDeleteResponseSchema,
  );

// conversations — @Controller("conversations")
export const getConversations = (): Promise<ConversationListResponse> =>
  getJson("/api/conversations", ConversationListResponseSchema);
export const getConversation = (id: string): Promise<Conversation> =>
  getJson(`/api/conversations/${encodeURIComponent(id)}`, ConversationSchema);
export const getMessages = (convId: string): Promise<MessageListResponse> =>
  getJson(`/api/conversations/${encodeURIComponent(convId)}/messages`, MessageListResponseSchema);

// prompts — @Controller("prompts")
export async function getPrompts(query: {
  page: number;
  pageSize: number;
  search?: string;
  node?: PromptNode;
  status?: "prod" | "draft";
}): Promise<PromptListResponse> {
  const params = new URLSearchParams();
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));
  if (query.search) params.set("search", query.search);
  if (query.node) params.set("node", query.node);
  if (query.status) params.set("status", query.status);
  return getJson(`/api/prompts?${params.toString()}`, PromptListResponseSchema);
}
export const getPromptVersions = (promptId: string): Promise<PromptVersionListResponse> =>
  getJson(`/api/prompts/${encodeURIComponent(promptId)}/versions`, PromptVersionListResponseSchema);

// M6 写操作：建 Prompt / 出新版本 / 发布 / 回滚（author 由后端从 JWT 填，D6）
export async function createPrompt(req: CreatePromptRequest): Promise<Prompt> {
  return postJson("/api/prompts", req, CreatePromptRequestSchema, PromptSchema);
}
export async function createPromptVersion(
  promptId: string,
  req: CreatePromptVersionRequest,
): Promise<PromptVersion> {
  return postJson(
    `/api/prompts/${encodeURIComponent(promptId)}/versions`,
    req,
    CreatePromptVersionRequestSchema,
    PromptVersionSchema,
  );
}
export async function publishPromptVersion(
  promptId: string,
  versionId: string,
): Promise<PromptVersion> {
  const resp = await apiFetch(
    `/api/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(versionId)}/publish`,
    { method: "POST" },
  );
  if (!resp.ok) throw new Error(`publish failed: ${resp.status}`);
  return PromptVersionSchema.parse(await resp.json());
}
export async function rollbackPromptVersion(
  promptId: string,
  versionId: string,
): Promise<PromptVersion> {
  const resp = await apiFetch(
    `/api/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(versionId)}/rollback`,
    { method: "POST" },
  );
  if (!resp.ok) throw new Error(`rollback failed: ${resp.status}`);
  return PromptVersionSchema.parse(await resp.json());
}

// 删除 prompt（仅草稿可删；已启用后端返 409。204 无响应体）
export async function deletePrompt(promptId: string): Promise<void> {
  const resp = await apiFetch(`/api/prompts/${encodeURIComponent(promptId)}`, {
    method: "DELETE",
  });
  if (!resp.ok) {
    throw new Error(`delete failed: ${resp.status} ${resp.statusText}`);
  }
}

// retrieval — @Controller("retrieval")
export const testRetrieval = (body: RetrievalTestRequest): Promise<RetrievalTestResponse> =>
  postJson("/api/retrieval/test", body, RetrievalTestRequestSchema, RetrievalTestResponseSchema);
