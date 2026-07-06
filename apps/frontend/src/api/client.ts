import {
  AgentListResponseSchema,
  AgentSchema,
  type Agent,
  type AgentListResponse,
  ChunkListResponseSchema,
  type ChunkListResponse,
  ConversationListResponseSchema,
  ConversationSchema,
  type Conversation,
  type ConversationListResponse,
  DocumentListResponseSchema,
  type DocumentListResponse,
  HealthResponseSchema,
  type HealthResponse,
  IngestionStatusSchema,
  type IngestionStatus,
  KnowledgeBaseListResponseSchema,
  type KnowledgeBaseListResponse,
  MessageListResponseSchema,
  type MessageListResponse,
  ModelProviderListResponseSchema,
  type ModelProviderListResponse,
  PromptListResponseSchema,
  type PromptListResponse,
  PromptVersionListResponseSchema,
  type PromptVersionListResponse,
  RetrievalTestRequestSchema,
  type RetrievalTestRequest,
  RetrievalTestResponseSchema,
  type RetrievalTestResponse,
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
  if (opts.body && !headers.has("Content-Type")) {
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

// agents — @Controller("agents")
export const getAgents = (): Promise<AgentListResponse> =>
  getJson("/api/agents", AgentListResponseSchema);
export const getAgent = (id: string): Promise<Agent> =>
  getJson(`/api/agents/${encodeURIComponent(id)}`, AgentSchema);

// models — @Controller("models")
export const getModels = (): Promise<ModelProviderListResponse> =>
  getJson("/api/models", ModelProviderListResponseSchema);

// knowledge-bases — @Controller("knowledge-bases")
export const getKnowledgeBases = (): Promise<KnowledgeBaseListResponse> =>
  getJson("/api/knowledge-bases", KnowledgeBaseListResponseSchema);

// documents — @Controller("documents")
export const getDocuments = (kbId: string): Promise<DocumentListResponse> =>
  getJson(`/api/documents?kbId=${encodeURIComponent(kbId)}`, DocumentListResponseSchema);

// ingestion — @Controller("documents/:id")
export const getIngestionStatus = (docId: string): Promise<IngestionStatus> =>
  getJson(`/api/documents/${encodeURIComponent(docId)}/ingestion-status`, IngestionStatusSchema);

// chunks — @Controller("chunks")
export const getChunks = (docId: string): Promise<ChunkListResponse> =>
  getJson(`/api/chunks/${encodeURIComponent(docId)}`, ChunkListResponseSchema);

// conversations — @Controller("conversations")
export const getConversations = (): Promise<ConversationListResponse> =>
  getJson("/api/conversations", ConversationListResponseSchema);
export const getConversation = (id: string): Promise<Conversation> =>
  getJson(`/api/conversations/${encodeURIComponent(id)}`, ConversationSchema);
export const getMessages = (convId: string): Promise<MessageListResponse> =>
  getJson(`/api/conversations/${encodeURIComponent(convId)}/messages`, MessageListResponseSchema);

// prompts — @Controller("prompts")
export const getPrompts = (): Promise<PromptListResponse> =>
  getJson("/api/prompts", PromptListResponseSchema);
export const getPromptVersions = (promptId: string): Promise<PromptVersionListResponse> =>
  getJson(
    `/api/prompts/${encodeURIComponent(promptId)}/versions`,
    PromptVersionListResponseSchema,
  );

// retrieval — @Controller("retrieval")
export const testRetrieval = (body: RetrievalTestRequest): Promise<RetrievalTestResponse> =>
  postJson("/api/retrieval/test", body, RetrievalTestRequestSchema, RetrievalTestResponseSchema);
