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
  ApplicationListResponseSchema,
  type ApplicationListResponse,
  ApplicationDetailSchema,
  type ApplicationDetail,
  ApplicationSchema,
  type Application,
  ApplicationConfigVersionSchema,
  type ApplicationConfigVersion,
  ApplicationChatResultSchema,
  type ApplicationChatResult,
  ApplicationTagListResponseSchema,
  type ApplicationTagListResponse,
  type MoveApplicationTagRequest,
  ReleaseCheckSchema,
  type ReleaseCheck,
  PublishProductionRequestSchema,
  type PublishProductionRequest,
  UnpublishProductionRequestSchema,
  type UnpublishProductionRequest,
  CreateApplicationRequestSchema,
  type CreateApplicationRequest,
  CreateApplicationConfigVersionRequestSchema,
  type CreateApplicationConfigVersionRequest,
  UpdateApplicationRequestSchema,
  type UpdateApplicationRequest,
  PromptUsageResponseSchema,
  type PromptUsageResponse,
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
  PromptDetailSchema,
  type PromptDetail,
  PromptListResponseSchema,
  type PromptListResponse,
  type PromptNode,
  MovePromptTagRequestSchema,
  type MovePromptTagRequest,
  PromptNodeVersionListResponseSchema,
  type PromptNodeVersionListResponse,
  PromptTagListResponseSchema,
  type PromptTagListResponse,
  TryRunPromptRequestSchema,
  type TryRunPromptRequest,
  TryRunResultSchema,
  type TryRunResult,
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
  TraceListResponseSchema,
  type TraceListResponse,
  type TraceListQuery,
  SessionListResponseSchema,
  type SessionListResponse,
  SessionDetailResponseSchema,
  type SessionDetailResponse,
  TraceDetailResponseSchema,
  type TraceDetailResponse,
  MetricsOverviewResponseSchema,
  MetricsAppResponseSchema,
  type MetricsOverviewResponse,
  type MetricsAppResponse,
  type MetricsQuery,
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

async function responseError(resp: Response, fallback: string): Promise<Error> {
  try {
    const body = (await resp.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.trim()) {
      return new Error(body.message);
    }
    if (Array.isArray(body.message)) {
      const messages = body.message.filter((item): item is string => typeof item === "string");
      if (messages.length > 0) return new Error(messages.join("；"));
    }
  } catch {
    // 非 JSON 错误响应使用调用方提供的中文兜底文案。
  }
  return new Error(fallback);
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
    throw await responseError(resp, `请求失败（${resp.status}）`);
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
    throw await responseError(resp, `提交失败（${resp.status}）`);
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
export const getAgentConfigVersions = (agentId: string): Promise<AgentConfigVersionListResponse> =>
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

// applications — @Controller("applications")（M7a 应用配置基础：CRUD + 不可变配置版本 +
// 版本对话骨架；production 上线语义留 M7b）
export const getApplications = (): Promise<ApplicationListResponse> =>
  getJson("/api/applications", ApplicationListResponseSchema);

// M9 W1：Trace 追踪读模型（列表 + 概览 / Session 列表）
export const getTraces = (q: TraceListQuery): Promise<TraceListResponse> => {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.agentId) p.set("agentId", q.agentId);
  if (q.status && q.status !== "全部") p.set("status", q.status);
  if (q.quick && q.quick !== "全部") p.set("quick", q.quick);
  if (q.stage) p.set("stage", q.stage);
  if (q.model) p.set("model", q.model);
  if (q.signal) p.set("signal", q.signal);
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  p.set("page", String(q.page ?? 1));
  p.set("pageSize", String(q.pageSize ?? 20));
  return getJson(`/api/traces?${p.toString()}`, TraceListResponseSchema);
};

export async function downloadTraceCandidates(q: TraceListQuery): Promise<void> {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.agentId) p.set("agentId", q.agentId);
  if (q.status && q.status !== "全部") p.set("status", q.status);
  if (q.quick && q.quick !== "全部") p.set("quick", q.quick);
  if (q.stage) p.set("stage", q.stage);
  if (q.model) p.set("model", q.model);
  if (q.signal) p.set("signal", q.signal);
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  const response = await apiFetch(`/api/traces/export?${p.toString()}`);
  if (!response.ok) throw new Error(`导出失败：${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `trace-candidates-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const getTraceSessions = (): Promise<SessionListResponse> =>
  getJson("/api/traces/sessions", SessionListResponseSchema);

export const getSession = (sessionId: string): Promise<SessionDetailResponse> =>
  getJson(`/api/traces/sessions/${encodeURIComponent(sessionId)}`, SessionDetailResponseSchema);

// M9 W2：Trace 详情（meta + 规范化 spans）
export const getTrace = (traceId: string): Promise<TraceDetailResponse> =>
  getJson(`/api/traces/${encodeURIComponent(traceId)}`, TraceDetailResponseSchema);

function metricsParams(q: MetricsQuery): string {
  const params = new URLSearchParams();
  if (q.from) params.set("from", q.from);
  if (q.to) params.set("to", q.to);
  if (q.agentId) params.set("agentId", q.agentId);
  if (q.model) params.set("model", q.model);
  return params.toString();
}

export const getMetricsOverview = (q: MetricsQuery): Promise<MetricsOverviewResponse> =>
  getJson(`/api/metrics/overview?${metricsParams(q)}`, MetricsOverviewResponseSchema);

export const getApplicationMetrics = (
  applicationId: string,
  q: MetricsQuery,
): Promise<MetricsAppResponse> =>
  getJson(
    `/api/metrics/apps/${encodeURIComponent(applicationId)}?${metricsParams(q)}`,
    MetricsAppResponseSchema,
  );
export const getApplicationDetail = (id: string): Promise<ApplicationDetail> =>
  getJson(`/api/applications/${encodeURIComponent(id)}`, ApplicationDetailSchema);
export const createApplication = (req: CreateApplicationRequest): Promise<ApplicationDetail> =>
  postJson("/api/applications", req, CreateApplicationRequestSchema, ApplicationDetailSchema);
export async function updateApplication(
  id: string,
  req: UpdateApplicationRequest,
): Promise<Application> {
  const resp = await apiFetch(`/api/applications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(UpdateApplicationRequestSchema.parse(req)),
  });
  if (!resp.ok) throw new Error(`update application failed: ${resp.status} ${resp.statusText}`);
  return ApplicationSchema.parse(await resp.json());
}
export async function deleteApplication(id: string): Promise<void> {
  const resp = await apiFetch(`/api/applications/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!resp.ok) throw new Error(`delete application failed: ${resp.status} ${resp.statusText}`);
}
export const createApplicationConfigVersion = (
  id: string,
  req: CreateApplicationConfigVersionRequest,
): Promise<ApplicationConfigVersion> =>
  postJson(
    `/api/applications/${encodeURIComponent(id)}/config-versions`,
    req,
    CreateApplicationConfigVersionRequestSchema,
    ApplicationConfigVersionSchema,
  );
// 版本对话测试骨架：稳定返回 {mode:"unavailable"}（M8 换真实编排不破坏形状）
export async function tryApplicationVersionChat(
  id: string,
  versionId: string,
): Promise<ApplicationChatResult> {
  const resp = await apiFetch(
    `/api/applications/${encodeURIComponent(id)}/config-versions/${encodeURIComponent(versionId)}/chat`,
    { method: "POST" },
  );
  if (!resp.ok) throw new Error(`application chat failed: ${resp.status} ${resp.statusText}`);
  return ApplicationChatResultSchema.parse(await resp.json());
}
// 「谁在用」（012 seam）：production 指针引用该 prompt 的应用；失败/404 由调用方降级静默
export const getPromptUsage = (promptId: string): Promise<PromptUsageResponse> =>
  getJson(
    `/api/applications/prompt-usage?promptId=${encodeURIComponent(promptId)}`,
    PromptUsageResponseSchema,
  );

// —— M7b 应用发布闭环：命名标签 / ReleaseCheck / production CAS ——
// 非 2xx 透出服务端 message（400 保留字/归属、404 跨应用/标签缺失、409 CAS 冲突/过期/依赖变化、422 静态门禁/cap）
async function applicationActionJson<T>(
  path: string,
  init: RequestInit,
  parse: (data: unknown) => T,
): Promise<T> {
  const resp = await apiFetch(path, init);
  if (!resp.ok) {
    let msg = `操作失败（${resp.status}）`;
    try {
      const body = (await resp.json()) as {
        message?: string | string[];
        issues?: Array<{ message?: unknown; action?: unknown }>;
      };
      const issueMessages = Array.isArray(body.issues)
        ? body.issues
            .filter((issue) => typeof issue.message === "string")
            .map((issue) =>
              issue.action === "OPEN_PROMPT_TRY_RUN"
                ? `${issue.message as string}，请前往 Prompt 试运行修复`
                : (issue.message as string),
            )
        : [];
      const m = Array.isArray(body.message) ? body.message.join("；") : body.message;
      if (issueMessages.length > 0) msg = issueMessages.join("；");
      else if (m) msg = m;
    } catch {
      /* 非 JSON 错误体，保留中文状态文案 */
    }
    throw new Error(msg);
  }
  return parse(await resp.json());
}

export const listApplicationTags = (id: string): Promise<ApplicationTagListResponse> =>
  getJson(
    `/api/applications/${encodeURIComponent(id)}/config-version-tags`,
    ApplicationTagListResponseSchema,
  );
export const moveApplicationTag = (
  id: string,
  req: MoveApplicationTagRequest,
): Promise<ApplicationTagListResponse> =>
  applicationActionJson(
    `/api/applications/${encodeURIComponent(id)}/config-version-tags`,
    { method: "PUT", body: JSON.stringify(req) },
    (d) => ApplicationTagListResponseSchema.parse(d),
  );
export async function removeApplicationTag(id: string, name: string): Promise<void> {
  const resp = await apiFetch(
    `/api/applications/${encodeURIComponent(id)}/config-version-tags/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!resp.ok) throw new Error(`remove application tag failed: ${resp.status} ${resp.statusText}`);
}
export const startApplicationReleaseCheck = (
  id: string,
  versionId: string,
): Promise<ReleaseCheck> =>
  applicationActionJson(
    `/api/applications/${encodeURIComponent(id)}/config-versions/${encodeURIComponent(versionId)}/release-checks`,
    { method: "POST" },
    (d) => ReleaseCheckSchema.parse(d),
  );
export const getApplicationReleaseCheck = (id: string, checkId: string): Promise<ReleaseCheck> =>
  getJson(
    `/api/applications/${encodeURIComponent(id)}/release-checks/${encodeURIComponent(checkId)}`,
    ReleaseCheckSchema,
  );
export const publishApplicationProduction = (
  id: string,
  req: PublishProductionRequest,
): Promise<Application> =>
  applicationActionJson(
    `/api/applications/${encodeURIComponent(id)}/production`,
    { method: "PUT", body: JSON.stringify(PublishProductionRequestSchema.parse(req)) },
    (d) => ApplicationSchema.parse(d),
  );
export const unpublishApplicationProduction = (
  id: string,
  req: UnpublishProductionRequest,
): Promise<Application> =>
  applicationActionJson(
    `/api/applications/${encodeURIComponent(id)}/production`,
    { method: "DELETE", body: JSON.stringify(UnpublishProductionRequestSchema.parse(req)) },
    (d) => ApplicationSchema.parse(d),
  );

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
// M8 T4：C 端按 agentId 过滤（userId 由后端从 JWT 取）；不传 = 全部（保留管理面用法）。
export const getConversations = (agentId?: string): Promise<ConversationListResponse> =>
  getJson(
    `/api/conversations${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
    ConversationListResponseSchema,
  );
export const getConversation = (id: string): Promise<Conversation> =>
  getJson(`/api/conversations/${encodeURIComponent(id)}`, ConversationSchema);
export const getMessages = (convId: string): Promise<MessageListResponse> =>
  getJson(`/api/conversations/${encodeURIComponent(convId)}/messages`, MessageListResponseSchema);

// prompts — @Controller("prompts")（012：版本平权 + 排他标签 + 路由式详情，无发布/回滚）
export async function getPrompts(query: {
  page: number;
  pageSize: number;
  search?: string;
  node?: PromptNode;
}): Promise<PromptListResponse> {
  const params = new URLSearchParams();
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));
  if (query.search) params.set("search", query.search);
  if (query.node) params.set("node", query.node);
  return getJson(`/api/prompts?${params.toString()}`, PromptListResponseSchema);
}
export const getPromptDetail = (promptId: string): Promise<PromptDetail> =>
  getJson(`/api/prompts/${encodeURIComponent(promptId)}`, PromptDetailSchema);
// 节点下全部具体版本（012 版本平权：应用/旧 Agent 表单候选，不按标签过滤）
export const getPromptNodeVersions = (node: PromptNode): Promise<PromptNodeVersionListResponse> =>
  getJson(
    `/api/prompts/versions?node=${encodeURIComponent(node)}`,
    PromptNodeVersionListResponseSchema,
  );
export const getPromptVersions = (promptId: string): Promise<PromptVersionListResponse> =>
  getJson(`/api/prompts/${encodeURIComponent(promptId)}/versions`, PromptVersionListResponseSchema);

// 写操作（author 由后端从 JWT 填）：新建 = {name,node}（服务端事务生成空 v1），
// 保存 = 总是产生不可变新版本（sourceVersionId 供「创建副本」沿用 contractVersion）
export async function createPrompt(req: CreatePromptRequest): Promise<PromptDetail> {
  return postJson("/api/prompts", req, CreatePromptRequestSchema, PromptDetailSchema);
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

// 标签排他移动/摘除（012 §3：production 与自定义同一写路径，无任何上线语义）
export async function movePromptTag(
  promptId: string,
  req: MovePromptTagRequest,
): Promise<PromptTagListResponse> {
  const resp = await apiFetch(`/api/prompts/${encodeURIComponent(promptId)}/tags`, {
    method: "PUT",
    body: JSON.stringify(MovePromptTagRequestSchema.parse(req)),
  });
  if (!resp.ok) throw new Error(`move tag failed: ${resp.status} ${resp.statusText}`);
  return PromptTagListResponseSchema.parse(await resp.json());
}
export async function removePromptTag(promptId: string, name: string): Promise<void> {
  const resp = await apiFetch(
    `/api/prompts/${encodeURIComponent(promptId)}/tags/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!resp.ok) throw new Error(`remove tag failed: ${resp.status} ${resp.statusText}`);
}

// 试运行（012 §6）：非 2xx 透出服务端 message（422 编译错误 / 400 字段要求 / 502 provider 失败）
export async function tryRunPromptVersion(
  promptId: string,
  versionId: string,
  req: TryRunPromptRequest,
): Promise<TryRunResult> {
  const resp = await apiFetch(
    `/api/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(versionId)}/try-run`,
    { method: "POST", body: JSON.stringify(TryRunPromptRequestSchema.parse(req)) },
  );
  if (!resp.ok) {
    const j = (await resp.json().catch(() => undefined)) as { message?: unknown } | undefined;
    throw new Error(typeof j?.message === "string" ? j.message : `try-run failed: ${resp.status}`);
  }
  return TryRunResultSchema.parse(await resp.json());
}

// 删除 prompt（被应用配置引用时后端返 409。204 无响应体）
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
