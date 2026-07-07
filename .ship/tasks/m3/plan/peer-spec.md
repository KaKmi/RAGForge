# M3 模型接入 Peer Spec

## 范围与目标

M3 的权威范围是 `model_providers CRUD、密钥加密、连通性测试、OpenAI 兼容适配器(LLM/Embedding/Rerank)`，验收是“注册模型并测试通过；key 前端掩码”（[docs/design/002-implementation-roadmap.md](/Users/zhaopengcheng/Desktop/rag-service/docs/design/002-implementation-roadmap.md:86)）。架构不变量要求模型 API Key 永不明文回传前端、存储加密（[docs/design/001-rag-platform-architecture.md](/Users/zhaopengcheng/Desktop/rag-service/docs/design/001-rag-platform-architecture.md:43)、[docs/design/001-rag-platform-architecture.md](/Users/zhaopengcheng/Desktop/rag-service/docs/design/001-rag-platform-architecture.md:159)）。

本 spec 的完成标准：后端 `models` 从 M2 mock 数组变为 Drizzle/Postgres 持久化；前端模型页从本地 mock 改为真实 API；“测试连接”必须真实调用 OpenAI-compatible endpoint；读 API 永不返回 `apiKey` 明文，只返回 `apiKeyMasked`。

非目标：不实现 M4/M5/M7 的知识库、检索、Agent 绑定真实逻辑；不把 `@codecrush/otel` 扩成完整 `trace.llm` SDK；不引入新的 HTTP client 依赖。

## 调查结论

当前 contracts 的模型契约很薄：`ModelTypeSchema = ["llm","embedding","rerank"]`，`ModelProviderSchema` 包含 `id/type/provider/name/baseUrl/apiKeyMasked/role/enabled`，`CreateModelRequestSchema` 直接 `omit({ id: true })`（[packages/contracts/src/models.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/contracts/src/models.ts:3)、[packages/contracts/src/models.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/contracts/src/models.ts:6)、[packages/contracts/src/models.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/contracts/src/models.ts:21)）。这会让写入侧接受 `apiKeyMasked`，但没有明文 `apiKey` 字段，必须改成独立 create/update DTO。

后端 `models` 目前是桩：controller 只有 `GET /models`、`GET /models/:id`、`POST /models`、`POST /models/:id/test`（[apps/backend/src/modules/models/models.controller.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/models/models.controller.ts:12)）；service 使用 `MOCK_MODELS`，create 只回显不持久化，test 永远 `{ ok: true }`（[apps/backend/src/modules/models/models.service.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/models/models.service.ts:4)、[apps/backend/src/modules/models/models.service.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/models/models.service.ts:44)、[apps/backend/src/modules/models/models.service.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/models/models.service.ts:49)）。`models.module.ts` 只注册 service/controller，没有 repository 或 adapter（[apps/backend/src/modules/models/models.module.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/models/models.module.ts:5)）。

Drizzle 现有模式是域内 `schema.ts` + repository + service，中央 `db/schema.ts` re-export（users: [apps/backend/src/modules/users/schema.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/users/schema.ts:3)、[apps/backend/src/modules/users/users.repository.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/users/users.repository.ts:7)、[apps/backend/src/db/schema.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/db/schema.ts:9)；prompts: [apps/backend/src/modules/prompts/schema.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/prompts/schema.ts:6)、[apps/backend/src/modules/prompts/prompts.repository.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/prompts/prompts.repository.ts:47)、[apps/backend/src/db/schema.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/db/schema.ts:10)）。迁移是显式脚本，不在应用启动时跑（[apps/backend/src/db/migrate.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/db/migrate.ts:6)、[apps/backend/src/db/migrate.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/db/migrate.ts:9)）。

配置层已经有 Zod fail-fast：`envSchema.parse(raw)` 在 `ConfigModule.forRoot` 中执行（[apps/backend/src/platform/config/config.module.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/platform/config/config.module.ts:9)），但当前 env 没有模型密钥加密主密钥（[apps/backend/src/platform/config/config.schema.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/platform/config/config.schema.ts:3)、[apps/backend/.env.example](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/.env.example:1)）。

前端 API client 现在只有 `getModels()`，没有 create/update/delete/test 方法（[apps/frontend/src/api/client.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/api/client.ts:118)）。`ModelsPage` 完全用 `../../mocks/models`，初始 rows 来自 `LLM_ROWS`，toggle/edit/test/save 都是本地 state，测试按钮只是 `setTested(true)`（[apps/frontend/src/pages/admin/ModelsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/ModelsPage.tsx:1)、[apps/frontend/src/pages/admin/ModelsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/ModelsPage.tsx:124)、[apps/frontend/src/pages/admin/ModelsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/ModelsPage.tsx:143)、[apps/frontend/src/pages/admin/ModelsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/ModelsPage.tsx:170)、[apps/frontend/src/pages/admin/ModelsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/ModelsPage.tsx:488)）。mock 类型是 `"LLM" | "Rerank" | "Embedding"`，与 contracts 小写 enum 不一致（[apps/frontend/src/mocks/models.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/mocks/models.ts:5)、[packages/contracts/src/models.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/contracts/src/models.ts:3)）。

M6 的 prompts 是前端真实接 API 的参考：页面 `useEffect` 调 `getPrompts`，保存/发布/删除都 await API 后刷新，错误进 `Alert`（[apps/frontend/src/pages/admin/PromptsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/PromptsPage.tsx:112)、[apps/frontend/src/pages/admin/PromptsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/PromptsPage.tsx:220)、[apps/frontend/src/pages/admin/PromptsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/PromptsPage.tsx:254)、[apps/frontend/src/pages/admin/PromptsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/PromptsPage.tsx:276)、[apps/frontend/src/pages/admin/PromptsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/PromptsPage.tsx:526)）。

Telemetry 当前代码只导出 `startNodeTelemetry`、`withSpan`、`emitManualHelloSpan` 等基础能力（[packages/otel/src/index.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel/src/index.ts:1)、[packages/otel/src/trace.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel/src/trace.ts:35)、[packages/otel/src/trace.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel/src/trace.ts:56)）。`otel-conventions` 现有 GenAI key 有 `gen_ai.system`、`gen_ai.operation.name`、`gen_ai.request.model`、usage token keys，operation 有 `chat/embeddings/rerank`（[packages/otel-conventions/src/index.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel-conventions/src/index.ts:1)、[packages/otel-conventions/src/index.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel-conventions/src/index.ts:25)）。因此 M3 只能用 `withSpan` + conventions 常量埋点，不能假设已有 `trace.llm()`。

已验证不存在的目标文件：`apps/backend/src/modules/models/schema.ts`、`models.repository.ts`、`models/ports/`、`models/adapters/` 当前都不存在；`.ship/tasks/m3/plan/peer-spec.md` 在本次写入前也不存在。

## 设计方案

### Contracts

`packages/contracts/src/models.ts` 改为读写分离：

- `ModelProviderSchema` 是读侧，字段建议为 `id,type,provider,name,baseUrl,apiKeyMasked,deploymentId?,enabled`。不包含 `apiKey`。当前 `role` 不在 001 的 `model_providers` 表形状里（[docs/design/001-rag-platform-architecture.md](/Users/zhaopengcheng/Desktop/rag-service/docs/design/001-rag-platform-architecture.md:81)），M3 不应把它作为持久字段；若要保留展示，前端可按 type 派生文案。
- `CreateModelRequestSchema` 不能再从读 schema omit 出来，必须显式包含明文 `apiKey: z.string().min(1)`，并用 strict object 拒绝 `apiKeyMasked`。
- `UpdateModelRequestSchema` 用于编辑、启停、密钥轮换：`type/provider/name/baseUrl/deploymentId/enabled/apiKey` 均可选，但至少一个字段存在；`apiKey` 为空字符串不允许。
- `TestModelConnectionResponseSchema` 返回 `{ ok, latencyMs?, statusCode?, message? }`。`message` 必须是脱敏错误摘要，不含 key。
- 新增 `TestModelDraftConnectionRequestSchema = CreateModelRequestSchema`，用于抽屉保存前测试；已注册模型的主路径仍是 `POST /api/models/:id/test`。

### 数据库与迁移

新增 `apps/backend/src/modules/models/schema.ts`，用 Drizzle 定义：

`model_providers(id uuid pk defaultRandom, type text notNull, provider text notNull, name text notNull, base_url text, api_key_enc text notNull, deployment_id text, enabled boolean notNull default true)`。

这与 001 的控制面表形状保持一致（[docs/design/001-rag-platform-architecture.md](/Users/zhaopengcheng/Desktop/rag-service/docs/design/001-rag-platform-architecture.md:81)）。如果实现者想加 `created_at/updated_at` 或 `role`，必须先更新设计文档；否则 M3 只按上述列落库。`schema.ts` 保持纯表定义，参考 prompts 的“零 service 引用”模式（[apps/backend/src/modules/prompts/schema.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/prompts/schema.ts:3)）。

`apps/backend/src/db/schema.ts` re-export models schema，保证 `PersistenceModule` 的 `NodePgDatabase<typeof schema>` 感知新表（[apps/backend/src/db/schema.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/db/schema.ts:1)、[apps/backend/src/platform/persistence/persistence.module.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/platform/persistence/persistence.module.ts:8)）。迁移通过 `pnpm --filter @codecrush/backend db:generate` 生成 `0003_*.sql`，不手写应用启动迁移。

### 密钥加密与掩码

新增后端平台级加密服务，建议路径 `apps/backend/src/platform/crypto/`，只供后端使用。原因：003 明确 Node/密钥能力不能进共享包（[docs/design/003-code-organization.md](/Users/zhaopengcheng/Desktop/rag-service/docs/design/003-code-organization.md:253)），frontend 也被 lint 禁止 import Node-only SDK（[eslint.config.mjs](/Users/zhaopengcheng/Desktop/rag-service/eslint.config.mjs:30)）。

配置：

- 在 `envSchema` 增加 `MODEL_API_KEY_ENCRYPTION_KEY`，要求 base64 解码后正好 32 bytes；缺失或长度不对 fail-fast。
- `AppConfigService` 暴露 decoded key 或原始 base64 getter。
- `.env.example` 放 dev-only 32-byte base64 示例。
- 更新 `apps/backend/test/config.schema.spec.ts`，现有合法 env 只测 JWT（[apps/backend/test/config.schema.spec.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/test/config.schema.spec.ts:16)），新增主密钥合法/非法断言。

算法：Node `crypto` 的 AES-256-GCM，密文 envelope 为 `v1:<ivB64>:<tagB64>:<ciphertextB64>`。Repository 永远只存 `api_key_enc`。Service 只有在创建、更新 key、连接测试时短暂解密；DTO 映射只输出 `apiKeyMasked`。掩码规则固定为：长度 >= 8 时 `${first3}****${last4}`，否则 `****`；例如 `sk-abcdef1234` → `sk-****1234`。测试必须断言响应 JSON 和 repository row 都不含明文 key。

### 后端 models 模块

按 prompts/users 的形状实现：

- `models.repository.ts`：`findAll/findById/insert/update/delete`，只处理 row，不做 DTO 和加密业务。
- `models.service.ts`：`toModelProvider(row)`、create/update/delete、启停、测试连接；不存在抛 `NotFoundException`，删除成功无响应体。
- `models.controller.ts`：保留现有 list/get/create/test 路径，新增 `PATCH /models/:id`、`DELETE /models/:id`、`POST /models/test` 草稿测试。控制器仍使用 `createZodDto`，与现有 controller 风格一致（models 当前用法见 [apps/backend/src/modules/models/models.controller.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/models/models.controller.ts:1)，prompts 参考见 [apps/backend/src/modules/prompts/prompts.controller.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/src/modules/prompts/prompts.controller.ts:35)）。
- `models.module.ts` 注册 repository、crypto service/module、OpenAI-compatible adapter token；不得让其它模块直接 import `adapters/`。003 要求端口归 models，适配器经 DI token 注入（[docs/design/003-code-organization.md](/Users/zhaopengcheng/Desktop/rag-service/docs/design/003-code-organization.md:101)）。

### OpenAI-compatible 端口与连通性测试

新增 `apps/backend/src/modules/models/ports/model-provider.port.ts`，最小接口：

```ts
export interface ModelProviderPort {
  testConnection(config: PlainModelProviderConfig): Promise<ModelConnectionTestResult>;
  chat?(...): Promise<unknown>;
  embed?(...): Promise<unknown>;
  rerank?(...): Promise<unknown>;
}
```

M3 只消费 `testConnection`，但端口名称和模型类型要给 M4/M5/M8 留出 `chat/embed/rerank` 方向，呼应 001 的 `ModelProviderPort: chat() / embed() / rerank()`（[docs/design/001-rag-platform-architecture.md](/Users/zhaopengcheng/Desktop/rag-service/docs/design/001-rag-platform-architecture.md:95)）。

适配器放 `apps/backend/src/modules/models/adapters/openai-compatible.provider.ts`，使用 Node 22 内置 `fetch`，不新增 axios/undici 依赖；仓库要求 Node >=22（[package.json](/Users/zhaopengcheng/Desktop/rag-service/package.json:5)，[.nvmrc](/Users/zhaopengcheng/Desktop/rag-service/.nvmrc:1)）。

测试请求规则：

- LLM：`POST {baseUrl}/chat/completions`，body `{ model: deploymentId ?? name, messages: [{ role: "user", content: "ping" }], max_tokens: 1, temperature: 0 }`，成功条件是 2xx 且有 `choices` 数组。
- Embedding：`POST {baseUrl}/embeddings`，body `{ model: deploymentId ?? name, input: "ping" }`，成功条件是 2xx 且 `data[0].embedding` 是数组。
- Rerank：`POST {baseUrl}/rerank`，body `{ model: deploymentId ?? name, query: "ping", documents: ["ping", "pong"] }`，成功条件是 2xx 且存在常见 rerank 结果数组（优先 `results`，兼容 `data`）。如果 `baseUrl` 已以 `/rerank` 结尾，则直接使用该 URL，避免 `/rerank/rerank`。

通用规则：`Authorization: Bearer <apiKey>`；`Content-Type: application/json`；用 `AbortController` 或 `AbortSignal.timeout()` 实现默认 8s 超时，可通过 `MODEL_PROVIDER_TEST_TIMEOUT_MS` 调整。Provider 返回 401/403/404/5xx、JSON 形状错误、网络错误、超时，都返回 `{ ok:false, statusCode?, message }`，不要把第三方错误提升为 500；只有本地 provider id 不存在才是 404。错误 message 必须脱敏，不包含 request headers、apiKey 或完整 body。

### Observability

连接测试不是问答关键路径，但应该用现有 OTel 原语记录一个 span。不要新增 `trace.llm` wrapper；用 `withSpan("models.test_connection", { attributes }, fn)`（[packages/otel/src/trace.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel/src/trace.ts:35)）。

span 属性：

- `gen_ai.system`: provider 名或 `"openai-compatible"`（常量见 [packages/otel-conventions/src/index.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel-conventions/src/index.ts:2)）
- `gen_ai.operation.name`: LLM 用 `chat`，Embedding 用 `embeddings`，Rerank 用 `rerank`（[packages/otel-conventions/src/index.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel-conventions/src/index.ts:25)）
- `gen_ai.request.model`: `deploymentId ?? name`（[packages/otel-conventions/src/index.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel-conventions/src/index.ts:4)）
- `codecrush.span.kind`: LLM/Embedding/Rerank 分别用现有 `CODECRUSH_SPAN_KIND.LLM/EMBEDDINGS/RERANK`（[packages/otel-conventions/src/index.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel-conventions/src/index.ts:39)）

不得记录 `apiKey`、Authorization header、完整请求体。`withSpan` 会在异常时标 ERROR 并重抛（[packages/otel/src/trace.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/otel/src/trace.ts:46)），因此 adapter 的 provider 错误应转换为 `{ ok:false }`，避免普通连通性失败被当成后端异常。

### 前端

`apps/frontend/src/api/client.ts` 扩展 models 方法：`createModel`、`updateModel`、`deleteModel`、`testModelConnection(id)`、`testModelDraftConnection(body)`。复用 `apiFetch` 的鉴权和 401 处理（[apps/frontend/src/api/client.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/api/client.ts:60)）；当前只有 `postJson`，需要增加 `patchJson` 或显式 `apiFetch`。

`ModelsPage.tsx` 改成真实 API 页面：

- on mount 调 `getModels()`，维护 loading/error，参考 PromptsPage 的 `refreshList` 和 `Alert`（[apps/frontend/src/pages/admin/PromptsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/PromptsPage.tsx:112)、[apps/frontend/src/pages/admin/PromptsPage.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/pages/admin/PromptsPage.tsx:526)）。
- tabs 内部状态用 `"all" | ModelType`，显示层用映射 `llm -> LLM`、`embedding -> Embedding`、`rerank -> Rerank`，消除当前大小写 mismatch。
- 抽屉“测试连接”调用 `POST /api/models/test`，创建时发送明文 `apiKey`；编辑时 API Key 输入框为空，旁边显示 `apiKeyMasked`，只有用户输入新 key 才发送 `apiKey`。
- 行内“启用”调用 `PATCH /models/:id { enabled }`；“测试”调用真实 test endpoint 并显示 ok/failed；“删除”用确认后 `DELETE`；“编辑”打开同一抽屉。
- `apps/frontend/src/mocks/models.ts` 可保留 provider 列表、placeholder、颜色等纯 UI 元数据，但 `LLM_ROWS` 不再作为数据源。

## 受影响文件

- `packages/contracts/src/models.ts`：读写 schema 分离，新增 update/test schemas。
- `packages/contracts/src/m2-schemas.test.ts`：更新模型正负例；新增“create 接受 apiKey 且不接受 apiKeyMasked”、“read schema 不接受 apiKey”。
- `apps/backend/src/platform/config/*`、`apps/backend/.env.example`、`apps/backend/test/config.schema.spec.ts`：加密主密钥和 timeout 配置。
- `apps/backend/src/platform/crypto/*`：新增 AES-GCM 服务。
- `apps/backend/src/modules/models/schema.ts`、`models.repository.ts`、`ports/model-provider.port.ts`、`adapters/openai-compatible.provider.ts`、`models.service.ts`、`models.controller.ts`、`models.module.ts`。
- `apps/backend/src/db/schema.ts`、`apps/backend/drizzle/0003_*.sql`。
- `apps/backend/test/skeleton.e2e.spec.ts`：替换 models mock 断言，覆盖真实 create/mask/test path。
- 新增 `apps/backend/test/models.service.spec.ts`、`models.repository.spec.ts` 或 service-level repo mock、`openai-compatible.provider.spec.ts`。
- `apps/frontend/src/api/client.ts`、`apps/frontend/src/pages/admin/ModelsPage.tsx`、必要时 `apps/frontend/src/mocks/models.ts`。
- `apps/frontend/src/app/App.test.tsx` 或新增 `ModelsPage.test.tsx`：断言 `/admin/models` 挂载调用 `/api/models`，并覆盖 create/test/toggle/delete。

## 会破的现有测试与更新方式

`packages/contracts/src/m2-schemas.test.ts` 当前 valid model 带 `apiKeyMasked` 和 `role`，create request 直接用读模型去掉 id（[packages/contracts/src/m2-schemas.test.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/contracts/src/m2-schemas.test.ts:35)、[packages/contracts/src/m2-schemas.test.ts](/Users/zhaopengcheng/Desktop/rag-service/packages/contracts/src/m2-schemas.test.ts:310)）。应改为读侧只断言 masked，写侧单独断言 plaintext `apiKey`。

`apps/backend/test/skeleton.e2e.spec.ts` 当前断言 GET models 非空、GET `/m1` 成功、POST 不带 apiKey 也 201、POST `/m1/test` 恒 `{ok:true}`（[apps/backend/test/skeleton.e2e.spec.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/test/skeleton.e2e.spec.ts:197)）。M3 后应使用 in-memory ModelsRepository + fake ModelProviderPort：先 POST 带 apiKey 创建，再 GET，断言 `apiKey` 不在响应、`apiKeyMasked` 存在；test 断言 fake port 被调用且响应 schema 合规。不能把断言软化成“任意 200”。

`apps/frontend/src/app/App.test.tsx` 目前只有 PromptsPage 真实 API 挂载断言，没有 ModelsPage API 断言（[apps/frontend/src/app/App.test.tsx](/Users/zhaopengcheng/Desktop/rag-service/apps/frontend/src/app/App.test.tsx:68)）。M3 应新增 `/admin/models` 测试，mock `/api/models` 返回 contracts 合规数组，断言页面不再渲染本地 `LLM_ROWS` 的数据源。

`apps/backend/test/config.schema.spec.ts` 现有合法 env 只包含 `DATABASE_URL/JWT_SECRET`（[apps/backend/test/config.schema.spec.ts](/Users/zhaopengcheng/Desktop/rag-service/apps/backend/test/config.schema.spec.ts:3)）。加密主密钥 required 后，该测试必须补 key，并增加缺失/非法 base64/非 32 bytes fail-fast 用例。

## 验收标准

1. `POST /api/models` 必须要求 plaintext `apiKey`，数据库只存 `api_key_enc`，响应只有 `apiKeyMasked`。
2. `GET /api/models` 和 `GET /api/models/:id` 永不包含 `apiKey` 或 `apiKeyEnc`。
3. `PATCH /api/models/:id { enabled:false }` 后列表反映禁用状态；不带 `apiKey` 的编辑不会清空原 key；带 `apiKey` 会轮换密文和掩码。
4. `DELETE /api/models/:id` 后再次 GET 返回 404。
5. `POST /api/models/:id/test` 会真实调用对应 OpenAI-compatible endpoint；LLM/Embedding/Rerank 三类分别命中不同 path/body；provider 失败返回 `{ ok:false }` 且错误脱敏。
6. 前端模型页加载、创建、编辑、启停、测试、删除都走 API；刷新页面后数据仍来自后端而非本地 mock。
7. `pnpm test`、`pnpm lint`、`pnpm build` 通过。

## 风险与明确假设

Rerank 没有 OpenAI 官方统一 endpoint；本 spec 选 `/rerank` 并兼容 `results`/`data` 数组，这是面向 Jina/Cohere/vLLM 类兼容服务的最小交集。若实际供应商要求完全不同 body，应新增 provider-specific adapter，而不是把前端或 service 写成条件拼接。

`role` 目前只是 M2 mock/UI 字段，权威 DB 表没有它。M3 不持久化 `role`；若产品要求“用途”可编辑，应先更新 001 的 `model_providers` 表定义，再实现。

配置主密钥是 dev/local 的应用层加密方案。001 提到阿里云可用 KMS（[docs/design/001-rag-platform-architecture.md](/Users/zhaopengcheng/Desktop/rag-service/docs/design/001-rag-platform-architecture.md:152)），但 M3 不接 KMS；以后替换时应只改 platform crypto 实现，不改 models service/controller。
