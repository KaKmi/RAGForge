# M3 — 模型接入（Peer Spec）

> 独立调查产出。未参考任何已存在的 M3 spec/plan/arch-design 文档。所有结论均引用实际读过的 `file:line`。属 CLAUDE.md「轻量对抗档」（CRUD/配置型），跳过 execution drill。

## Problem / Motivation

M2 已落地模型域的 **skeleton**（返回 mock 数组、`test` 恒返回 `{ok:true}`），但无任何持久化、无密钥加密、无真实模型调用（`apps/backend/src/modules/models/models.service.ts:4-30` `MOCK_MODELS` 硬编码、`:49-52` `test` 桩）。前端 `ModelsPage.tsx` 同样纯 mock，从 `../../mocks/models` 取数据，"测试连接"仅翻转本地 `tested` 状态（`apps/frontend/src/pages/admin/ModelsPage.tsx:489-504`、`:170-185` `save` 只 push 到本地 state）。

M3 要把 skeleton 填成真实逻辑：`model_providers` 表 CRUD、API Key 加密存储 + 前端掩码返回、连通性测试端点调用真实模型、OpenAI 兼容适配器覆盖 LLM/Embedding/Rerank 三类调用。

**验收锚点**（`docs/design/002-implementation-roadmap.md:86`）：(1) 注册模型并点"测试"通过；(2) API key 前端掩码显示、不明文返回。

**架构不变量**（`docs/design/001-rag-platform-architecture.md:42-44`）：`ModelProviderPort` / `RetrieverPort` / `BlobStore` 藏在端口背后；**模型 API Key 永不明文回传前端，存储加密**（Invariant 4）；`model_providers(id, type[llm/embedding/rerank], provider, name, base_url, api_key_enc, deployment_id, enabled)`（`001:81`）。

## Design approach

1. **端口/适配器落地。** `models` 域拥有 `ModelProviderPort`（interface，`chat()/embed()/rerank()/test()`），首个适配器 `OpenAiCompatProvider` 经 NestJS DI token 注入（`003:101`「拿端口不拿适配器」，日后换云零改动）。任何地方不得直接 import `adapters/`（`AGENTS.md` 边界 5）。
2. **密钥加密 = AES-256-GCM + 主密钥。** 用 `node:crypto`（Node 内建，后端 only，符合边界）实现可逆加密（argon2 是单向哈希，只适合密码不适合 API Key，见 `apps/backend/src/modules/users/password.ts:1-20`）。主密钥从 env 读取，fail-fast。密文带版本前缀 `v1:` 便于未来密钥轮换。**返回前端只有 `apiKeyMasked`，永不回传明文 / 密文**（Invariant 4）。
3. **契约读写分离。** M2 的 `CreateModelRequestSchema = ModelProviderSchema.omit({ id: true })`（`packages/contracts/src/models.ts:21`）把读字段 `apiKeyMasked` 当写字段用——这是 M2 skeleton 的偷懒。M3 拆为：读侧 `ModelProviderSchema`（含 `apiKeyMasked`），写侧 `CreateModelRequestSchema` / `UpdateModelRequestSchema`（含 `apiKey` 明文，write-only），测试响应 `TestModelResponseSchema`（真实结果：`ok/latencyMs?/error?/model?`）。
4. **OpenAI 兼容走原生 fetch。** `apps/backend/package.json:16-33` 无 `openai` SDK 依赖。Node 22 有全局 `fetch`，OpenAI 兼容 API 是简单 REST（`/chat/completions`、`/embeddings`、`/rerank`），原生 fetch 足够且零新依赖（呼应 M2 `006:71` 不引入多余运行时依赖的取向）。Rerank 无 OpenAI 标准，用 Cohere/Jina 兼容的 `/rerank` 端点（BGE-reranker 经 TEI/inference endpoints 同形）。
5. **连通性测试可观测。** 测试是 admin 操作（不在问答关键路径），可同步打 span。用 `@codecrush/otel` 的 `withSpan`（`packages/otel/src/trace.ts:35-54`）+ `GEN_AI.*` 属性（`packages/otel-conventions/src/index.ts:1-12`）。**不建 `trace.llm/embeddings` 语义封装**——那是 M0.5 未完成项（`003:270`「M0.5 即建通用版」但 `trace.ts` 只交付了 `emitManualHelloSpan`），M3 不越界扩 SDK scope，直接用 `withSpan`。

## Investigation findings（带 file:line 证据）

### 1. M2 skeleton 现状（要被填实的代码）

- **契约**（`packages/contracts/src/models.ts:1-22`）：`ModelTypeSchema = z.enum(["llm","embedding","rerank"])`（小写）；`ModelProviderSchema` 字段 `id/type/provider/name/baseUrl?/apiKeyMasked?/role?/enabled`；`CreateModelRequestSchema = ModelProviderSchema.omit({ id: true })`（**写侧误用读字段 `apiKeyMasked`，无 `apiKey` 明文字段**）；无 `UpdateModelRequestSchema` / `TestModelResponseSchema`。
- **后端 controller**（`apps/backend/src/modules/models/models.controller.ts:1-31`）：`@Controller("models")`，`GET /` → `ModelProvider[]`、`GET /:id`、`POST /`（201）、`POST /:id/test`（200 `{ok:boolean}`）。用 `createZodDto(CreateModelRequestSchema)`。无 `PATCH`/`DELETE`。
- **后端 service**（`apps/backend/src/modules/models/models.service.ts:1-53`）：`MOCK_MODELS` 3 条；`list/get/create`（回显）/`test`（恒 `{ok:true}`）。无 repository、无 schema、无 port。
- **后端 module**（`apps/backend/src/modules/models/models.module.ts:1-9`）：仅 `controllers:[ModelsController], providers:[ModelsService]`，无 exports。
- **前端页**（`apps/frontend/src/pages/admin/ModelsPage.tsx:1-519`）：纯 mock，`useState<LlmRow[]>(LLM_ROWS)`（`:125`）；drawer `ModelDraft={type,prov,name,base,key}`（`mocks/models.ts:77-83`）；"测试连接" `setTested(true)`（`:489`）；"接入" push 本地（`:179-184`）；列表"编辑/测试/删除"链接无 onClick（`:332-336`）。前端 `ModelType="LLM"|"Rerank"|"Embedding"`（**大写**，`mocks/models.ts:5`）与契约小写不一致，接真后端需对齐。
- **前端 typed client**（`apps/frontend/src/api/client.ts:109-111`）：仅 `getModels()`。无 `createModel/testModel/updateModel/deleteModel`。

### 2. 类比 feature：`users` 模块（CRUD + schema + repository 完整范式）

- `apps/backend/src/modules/users/schema.ts:1-12` — `pgTable("users",{...})` + `export type UserRow = typeof users.$inferSelect;`（纯表定义，零 service 引用，`AGENTS.md` 边界 8）。
- `apps/backend/src/modules/users/users.repository.ts:1-27` — `@Injectable()`，`@Inject(DRIZZLE) private readonly db: DB`，drizzle `select/update` 查询。`DB = NodePgDatabase<typeof schema>`（`platform/persistence/persistence.module.ts:8`）。
- `apps/backend/src/modules/users/users.service.ts:1-60` — `@Injectable()`，`toProfile(row): UserProfile` 做 row→DTO 映射（`11-20`）。M3 的 `ModelsService.toProvider(row)` 同构（row→`ModelProvider`，把 `apiKeyEnc` 映成 `apiKeyMasked`）。
- `apps/backend/src/modules/users/users.controller.ts:1-31` — `createZodDto(...)` + `@Body`；`@Req() req: AuthedRequest`（`:13` `type AuthedRequest = { user: AuthenticatedUser }`）拿 principal。
- `apps/backend/src/modules/users/users.module.ts:1-11` — `providers:[UsersRepository, UsersService], exports:[UsersService]`。
- `apps/backend/src/modules/users/password.ts:1-20` — argon2id 单向哈希。**API Key 需可逆加密，不能用 argon2**，必须新建 AES-GCM 工具。

### 3. 平台基础设施现状（哪些已有 / 哪些 M3 新增）

- **config**（`apps/backend/src/platform/config/config.schema.ts:1-14`）：env Zod schema，**无主加密密钥**。`config.service.ts:1-39` getters。`config.module.ts:1-17` `@Global` + `validate: (raw)=>envSchema.parse(raw)` fail-fast。→ **M3 新增 `MODEL_API_KEY_MASTER_KEY`（min 32 字符）到 schema + getter + `.env.example`**。
- **persistence**（`apps/backend/src/platform/persistence/persistence.module.ts:1-24`）：`@Global`，`DRIZZLE = Symbol("DRIZZLE")`（`drizzle.constants.ts:1`），`drizzle(pool,{schema})`，schema 来自 `../../db/schema` barrel。→ M3 复用 `@Inject(DRIZZLE)`。
- **db schema barrel**（`apps/backend/src/db/schema.ts:1-8`）：`app_meta` + `export * from "../modules/users/schema"`。→ **M3 追加 `export * from "../modules/models/schema"`**。
- **security**（`apps/backend/src/platform/security/`）：仅 `authenticated-user.ts`（`AuthenticatedUser={id,email}` 类型）+ `public.decorator.ts`（`@Public()`）。**无加密工具、无 SecurityModule**。→ **M3 新增 `platform/security/encryption.ts`（AES-GCM）+ `platform/security/security.module.ts`（@Global，提供 `EncryptionService`）**，镜像 clickhouse module 的 `@Global` + token provider 模式。
- **clickhouse module**（`apps/backend/src/platform/clickhouse/`）：`@Global` + `CLICKHOUSE` token + `useFactory`（参考其 `clickhouse.module.ts` 模式给 `SecurityModule` 注入 `AppConfigService` 取主密钥）。
- **无 `platform/queue` / `platform/storage` / `platform/observability`**（`LS platform/` 仅 4 子目录）。M3 不需要 queue/storage；可观测直接用 `@codecrush/otel` 的 `withSpan`。

### 4. Drizzle 迁移机制

- `apps/backend/drizzle.config.ts:1-9` — `schema:"./src/db/schema.ts"`, `out:"./drizzle"`, `dialect:"postgresql"`。
- `apps/backend/drizzle/0000_natural_trish_tilby.sql`（app_meta）、`0001_spooky_ultimatum.sql`（users）。→ **M3 `pnpm db:generate` 生成 `0002_*.sql`（model_providers 表）**，`pnpm db:migrate` 显式应用（`AGENTS.md` 边界 9，不在启动时静默执行；`db/migrate.ts:1-16` `migrate(db,{migrationsFolder:"./drizzle"})`）。
- 迁移文件名由 drizzle-kit 随机生成，spec 只约束表 DDL。

### 5. 鉴权与路由

- 全局 `JwtAuthGuard`（`apps/backend/src/modules/auth/auth.module.ts:22` `APP_GUARD`），`@Public()` opt-out（`jwt-auth.guard.ts:23-27`）。`request.user={id,email}`（`:41`）。
- 全局前缀 `/api`（`app/app-bootstrap.ts:10-12` `setGlobalPrefix("api",{exclude:["health"]})`）。models 端点 → `/api/models`，受 JwtAuthGuard 保护（admin only，不标 `@Public`）。
- `app.module.ts:11,32` 已 imports `ModelsModule`。M3 扩展 `ModelsModule` 的 providers/imports，不改 `app.module.ts` 的 import 行（除非要加 `SecurityModule`——`SecurityModule` 应在 `app.module.ts` imports 中显式列出，紧挨 `AppConfigModule`/`PersistenceModule`）。

### 6. OTel 现状（连通性测试埋点）

- `packages/otel/src/trace.ts:35-54` — `withSpan(name,{attributes},fn)`，自动 setStatus / recordException / end。`emitManualHelloSpan`（`:56-77`）是唯一语义封装示例。**无 `trace.llm/embeddings/retrieve` 封装**（M0.5 未交付，`003:270` 计划但 `trace.ts` 未落地）。
- `packages/otel-conventions/src/index.ts:1-48` — `GEN_AI.{SYSTEM,OPERATION_NAME,REQUEST_MODEL,USAGE_INPUT_TOKENS,USAGE_OUTPUT_TOKENS}`、`OTEL_OPERATIONS.{CHAT,EMBEDDINGS,RERANK,...}`、`CODECRUSH_SPAN_KIND` 全部可用。
- `@codecrush/otel` 已在后端 deps（`apps/backend/package.json:20`）。M3 直接 import `withSpan`。
- **埋点不入关键路径**（`AGENTS.md` 边界 7）：连通性测试是 admin 操作，同步打 span 安全；真实 `chat()/embed()/rerank()` 在 M8 问答路径上时再考虑异步。

### 7. 已有测试会断（必须同步改，非软化断言）

- `apps/backend/test/skeleton.e2e.spec.ts:98-128` 测 M2 mock skeleton：
  - `:103` `GET /api/models` 断言 `res.body.length > 0`（mock 3 条）。M3 真实空库 → 0。**改**：测试前 seed 一条，或断言 `>= 0` + schema 合规（这是行为从 mock→真实的迁移，非弱化校验，依据 `AGENTS.md`「不要软化测试断言——修代码」此处是改测试适配新真实行为）。
  - `:109-119` `POST /api/models` body `{type,provider,name,enabled}`（**无 apiKey**）。M3 写侧契约要求 `apiKey` → ZodValidationPipe 400。**改**：补 `apiKey` 字段 + 断言响应含 `apiKeyMasked` 不含明文。
  - `:121-127` `POST /api/models/m1/test → 200 {ok:true}`。M3 真实测试 → 响应形状变（`TestModelResponseSchema`）。**改**：换 schema 断言；m1 不存在 → 404 路径单独测。
  - `:105-107` `GET /api/models/m1 → 200`。M3 真实库 m1 不存在 → 404。**改**：先 seed 或测 404。
- 这些是 mock→真实的行为迁移，**更新测试以匹配新真实行为**（不弱化校验，而是断言新形状：掩码、加密、真实测试结果）。spec 显式列出，避免 dev 阶段当成「测试坏了」。

### 8. 边界 lint 现状

- `eslint.config.mjs:29-49` 强制 frontend 不 import backend / `@codecrush/otel`；`:51-70` contracts 不依赖 apps/OTel；`:72-96` otel-conventions 零运行时依赖；`:99-122` `@codecrush/otel` 不碰 contracts/clickhouse/apps。
- **无后端跨域 barrel-only 规则**（`003:137-139` 要求但未落地，M2 peer-spec `:188` 已记录）。M3 的 `models/adapters/` 禁止被直接 import——靠人工遵守 + 模块封装（adapter 只在 `models.module.ts` 作为 DI provider 注册，不 export）。

## Changes by file

### A. 契约扩展（`packages/contracts/src/models.ts`）— 读写分离

重写为读写分离 + 测试响应（沿用 `users.ts:1-20` 的 `z.object + export type` 风格，Zod 4）：

- `ModelTypeSchema = z.enum(["llm","embedding","rerank"])`（保留）。
- `ModelProviderSchema`（**读/响应**）：`id:z.string().uuid()`、`type:ModelTypeSchema`、`provider,name:z.string().min(1)`、`baseUrl:z.string().url().optional()`、`apiKeyMasked:z.string()`（**必填**，永不明文）、`deploymentId:z.string().optional()`（对齐 `001:81`）、`role:z.string().optional()`、`enabled:z.boolean()`、`createdAt/updatedAt:z.string().datetime()`。
- `CreateModelRequestSchema`（**写**）：`ModelProviderSchema.omit({id,apiKeyMasked,createdAt,updatedAt}).extend({ apiKey:z.string().min(1) })`（**明文 apiKey，write-only**，不进响应）。
- `UpdateModelRequestSchema`（**写，partial**）：`CreateModelRequestSchema.partial()`（启用开关 / 改 key 都走它）。
- `TestModelResponseSchema`：`z.object({ ok:z.boolean(), latencyMs:z.number().int().nonnegative().optional(), model:z.string().optional(), error:z.string().optional() })`。
- `ModelProviderListResponseSchema = z.array(ModelProviderSchema)`（保留）。
- `index.ts:5` 已 `export * from "./models"`，无需改。

### B. 平台：加密服务（新增 `apps/backend/src/platform/security/`）

- `encryption.ts`（新）— `EncryptionService` class：
  - 构造注入 master key（hex 或 base64，32 字节）。
  - `encrypt(plaintext:string):string` — AES-256-GCM，返回 `v1:` + base64(iv(12)|tag(16)|ciphertext)。随机 iv 每次不同（同 key 加密两次密文不同）。
  - `decrypt(serialized:string):string` — 解析前缀版本，校验 tag，失败抛错。
  - `mask(plaintext:string):string` — 掩码：`sk-****1234` 风格（首 3 + 末 4，中间 `****`；长度 < 8 全 `****` 末 2）。**纯函数，不暴露明文**。
  - 用 `node:crypto`（`createCipheriv/createDecipheriv/randomBytes`），Node 内建，后端 only，不违反边界。
- `security.module.ts`（新）— `@Global`，`providers:[{provide:ENCRYPTION,useFactory:(config:AppConfigService)=>new EncryptionService(config.modelApiKeyMasterKey),inject:[AppConfigService]}],exports:[ENCRYPTION]`。`ENCRYPTION = Symbol("ENCRYPTION")`（`drizzle.constants.ts:1` 同模式）。
- `config.schema.ts:1-14` 追加 `MODEL_API_KEY_MASTER_KEY:z.string().min(32)`（fail-fast，主密钥缺失/过短启动即崩）。
- `config.service.ts` 追加 `get modelApiKeyMasterKey():string`。
- `.env.example` 追加 `MODEL_API_KEY_MASTER_KEY=<generate-32-byte-hex>`（示例给生成命令注释）。
- `app.module.ts:23-30` imports 紧挨 `PersistenceModule` 加 `SecurityModule`。

### C. models 域模块（`apps/backend/src/modules/models/`）— 填真实逻辑

- `schema.ts`（新）— 纯表定义（`users/schema.ts:1-12` 同构）：
  ```ts
  export const modelProviders = pgTable("model_providers", {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),          // llm|embedding|rerank
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url"),             // nullable
    apiKeyEnc: text("api_key_enc").notNull(),  // 加密密文
    deploymentId: text("deployment_id"),
    role: text("role"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  });
  export type ModelProviderRow = typeof modelProviders.$inferSelect;
  ```
- `models.repository.ts`（新）— `@Injectable()`，`@Inject(DRIZZLE) db: DB`（`users.repository.ts:1-27` 同构）。方法：`findAll()/findById(id)/insert(row)/update(id,patch)/delete(id)`。
- `ports/model-provider.port.ts`（新）— interface：
  ```ts
  export interface ChatInput { messages:{role:string;content:string}[]; model:string; maxTokens?:number; temperature?:number; }
  export interface EmbedInput { input:string|string[]; model:string; }
  export interface RerankInput { query:string; documents:string[]; model:string; topN?:number; }
  export interface ModelProviderPort {
    test(cfg:{baseUrl?:string;apiKey:string;model:string;type:ModelType;}): Promise<{ok:boolean;latencyMs:number;error?:string}>;
    chat(cfg:{baseUrl?:string;apiKey:string}, input:ChatInput): Promise<{content:string;inputTokens?:number;outputTokens?:number;}>;
    embed(cfg, input:EmbedInput): Promise<{vectors:number[][];}>;
    rerank(cfg, input:RerankInput): Promise<{scores:number[];}>;
  }
  export const MODEL_PROVIDER_PORT = Symbol("MODEL_PROVIDER_PORT");
  ```
  仅 interface + token，无实现（端口归域模块所有，`003:101`）。
- `adapters/openai-compat.adapter.ts`（新）— `@Injectable()` implements `ModelProviderPort`：
  - 用全局 `fetch`（Node 22，无新依赖）。
  - `test()` 按 `type` 分派：llm→`POST {baseUrl}/chat/completions`（`messages:[{role:"user",content:"ping"}],max_tokens:1`），embedding→`POST {baseUrl}/embeddings`（`input:"ping"`），rerank→`POST {baseUrl}/rerank`（`query:"ping",documents:["a","b"],top_n:1`）。测 2xx + 关键字段存在，计时 `latencyMs`。
  - `chat/embed/rerank()` 实现真实调用（M8 chat 路径会用，M3 先可用但连通性测试是首个消费方）。`baseUrl` 默认按 provider 推断（DeepSeek→`https://api.deepseek.com/v1` 等，或要求必填）。
  - headers：`Authorization: Bearer ${apiKey}`、`Content-Type: application/json`。
  - 失败：HTTP 非 2xx → 读 `error.message`；网络错 → `ok:false,error:err.message`；不抛错（测试端点要友好结果）。
  - **不在 adapters 里做 trace 埋点**（埋点在 service 层用 `withSpan` 包，adapter 保持纯调用）。
- `models.service.ts`（重写）— `@Injectable()`，构造注入 `ModelsRepository` + `@Inject(ENCRYPTION) enc:EncryptionService` + `@Inject(MODEL_PROVIDER_PORT) port:ModelProviderPort`：
  - `list():Promise<ModelProvider[]>` — repo.findAll + `toProvider(row)`（映射，`apiKeyEnc`→`enc.mask(enc.decrypt(row.apiKeyEnc))`）。
  - `get(id):Promise<ModelProvider>` — 同映射，not found 抛 `NotFoundException`。
  - `create(req:CreateModelRequest):Promise<ModelProvider>` — `enc.encrypt(req.apiKey)` → repo.insert → 返回映射（**不含明文 apiKey**）。
  - `update(id,patch:UpdateModelRequest):Promise<ModelProvider>` — 若 `patch.apiKey` 存在则重新加密；`enabled` 开关走这里。not found 抛错。
  - `delete(id):Promise<void>`。
  - `test(id):Promise<TestModelResponse>` — 取 row（not found 抛 404）→ 解密 key → `withSpan("model.test",{attributes:{[GEN_AI.OPERATION_NAME]:type===..."chat":"embeddings",[GEN_AI.REQUEST_MODEL]:row.name,[GEN_AI.SYSTEM]:row.provider,[CODECRUSH_SPAN_KIND.xxx]:...}})` 包 `port.test({...})` → 返回 `{ok,latencyMs,error?}`。**同步埋点**（admin 路径，非关键路径）。
- `models.controller.ts`（重写）— 加 `PATCH/:id`、`DELETE/:id`；`POST/:id/test` 返回 `TestModelResponse`；`POST /` 用 `CreateModelRequestDto`（含 apiKey）；`PATCH /:id` 用 `UpdateModelRequestDto`。响应类型 `ModelProvider`（含 `apiKeyMasked`，**不含 apiKey**）。沿用 `createZodDto`（`users.controller.ts:11`）。
- `models.module.ts`（重写）— `controllers:[ModelsController]`，`providers:[ModelsRepository,ModelsService,{provide:MODEL_PROVIDER_PORT,useClass:OpenAiCompatProvider},OpenAiCompatProvider]`，`exports:[ModelsService]`。imports: `[SecurityModule]`（拿 `ENCRYPTION`）。**adapter 不 export**（禁止直接 import adapters/）。
- `db/schema.ts:8` 追加 `export * from "../modules/models/schema";`。
- `drizzle/0002_*.sql` — `pnpm db:generate` 自动生成（`CREATE TABLE "model_providers"...`，字段见 schema.ts）。

### D. 前端（`apps/frontend/`）— 接真后端

- `api/client.ts` 扩展（`:99-111` 之后）：`createModel(body):Promise<ModelProvider>`（`postJson`，请求 `CreateModelRequestSchema` 含 apiKey，响应 `ModelProviderSchema`）、`updateModel(id,patch):Promise<ModelProvider>`（`PATCH`，需加 `patchJson` 辅助或复用 fetch）、`deleteModel(id):Promise<void>`、`testModel(id):Promise<TestModelResponse>`。沿用 `apiFetch`（Bearer token 自动注入，`:51-64`）。
- `pages/admin/ModelsPage.tsx` 改写：
  - 去掉 `../../mocks/models` 的 `LLM_ROWS` 数据依赖（保留 `MODEL_TYPES`/`LLM_TABS` 作为 UI 配置：tab、provider 选项、placeholder）。
  - `useEffect` 调 `getModels()` 初始化 `rows`（映射契约 `ModelProvider` → 渲染行；`type` 小写→展示大写 Tag）。
  - drawer "测试连接" 调 `testModel(id)`（已存模型）或 `createModel` 后再 test；显示 `ok/error/latencyMs`。
  - "接入" 调 `createModel({type,provider,name,baseUrl,apiKey,enabled})`，成功后刷新列表。
  - 启用开关 → `updateModel(id,{enabled})`。
  - "编辑/删除" 链接接 `updateModel`/`deleteModel`（M2 无 onClick，`:332-336`）。
  - **apiKey 输入**：新建时明文输入（`type="password"`），编辑时预填 `apiKeyMasked` + 可选"重新输入 key"（留空不改）。
  - 类型对齐：前端 `ModelType` 改为契约小写 `llm|embedding|rerank`（`mocks/models.ts:5` 大写仅 UI 展示用，内部走契约）。
- `mocks/models.ts` — 保留 `MODEL_TYPES`/`LLM_TABS`/`ModelDraft`（UI 配置），删 `LLM_ROWS`（不再用 mock 数据）或保留作 fallback（建议删，避免漂移）。

## Intent / Non-goals / Forbidden shortcuts

**Intent**：模型注册 CRUD 落库、密钥加密 + 掩码返回、真实连通性测试（三类调用）、OpenAI 兼容适配器端口化。让 M4（embedding 消费）/M5（rerank 消费）/M7（Agent 绑模型）/M8（chat 编排）有可用的 `ModelProviderPort`。

**Non-goals**：
- 不建 `trace.llm/embeddings` 语义封装（M0.5 未完成项，M3 用 `withSpan` 直接打）。
- 不做密钥轮换 UI / KMS 集成（阿里云 Tier B，`001:159`；密文 `v1:` 前缀为未来轮换留口）。
- 不做模型调用计费 / 用量聚合（M10 看板）。
- 不做多租户 / RBAC（M12）。
- 不接真实第三方模型做 e2e（测试用 mock fetch，真实 key 由用户填）。
- 不改 `traces` / `chat` / 其他域模块。

**Forbidden shortcuts**：
- 不得把明文 apiKey 放进响应 / 日志 / span 属性（Invariant 4，`001:43`）。
- 不得直接 import `adapters/`（`AGENTS.md` 边界 5），只能经 `MODEL_PROVIDER_PORT` token。
- 不得在 `contracts` 引入 `node:crypto` / 任何运行时依赖（`AGENTS.md` 边界 3）。
- 不得软化 `skeleton.e2e.spec.ts` 断言来「过」测试——改测试适配新真实行为（掩码、真实测试响应），保留 schema 合规断言强度。
- 不得在应用启动时静默跑迁移（`AGENTS.md` 边界 9）。
- 不得把加密工具放 `contracts` 或 `otel-conventions`（地基包保持纯净）。

## Acceptance criteria

1. **注册模型**：`POST /api/models`（含 `apiKey` 明文）→ 201，响应 `ModelProvider` 含 `apiKeyMasked`（如 `sk-****1234`），**不含 `apiKey` 字段**，符合 `ModelProviderSchema`。
2. **掩码返回**：`GET /api/models` / `GET /api/models/:id` 响应只含 `apiKeyMasked`，DB 存的是 `v1:` 加密密文（非明文、非掩码）。
3. **连通性测试通过**：注册一个真实可用的 OpenAI 兼容模型（用户提供 key），点"测试"→ `POST /api/models/:id/test` 返回 `{ok:true,latencyMs,model?}`；对错误 key/URL 返回 `{ok:false,error}`（不抛 500）。
4. **三类模型**：LLM/Embedding/Rerank 各能注册并测试（adapter 按 type 分派到 `/chat/completions`、`/embeddings`、`/rerank`）。
5. **启用开关**：`PATCH /api/models/:id {enabled:false}` → 200，`GET` 反映新状态。
6. **删除**：`DELETE /api/models/:id` → 204，再 `GET /:id` → 404。
7. **前端接真**：`ModelsPage` 列表来自 `getModels()`，"接入"→`createModel`，"测试"→`testModel`，开关→`updateModel`，"删除"→`deleteModel`；apiKey 输入框 `type=password`，列表只显掩码。
8. **迁移显式**：`pnpm db:generate` 生成 `0002_*.sql`；`pnpm db:migrate` 后表存在；启动时不跑迁移。
9. **fail-fast**：缺 `MODEL_API_KEY_MASTER_KEY`（或 < 32 字符）→ 启动崩（config schema 拒绝）。
10. **lint/边界 0 违规**：`pnpm lint` 通过；frontend 不 import backend；contracts 无平台依赖；adapter 不被域外直接 import。

## Test plan

**契约（vitest，沿用 `packages/contracts` 现有 `*.test.ts` 模式）：**
- `ModelProviderSchema`：正例（含 apiKeyMasked）通过；反例（含 `apiKey` 明文字段）—— 决策：响应 schema 不含 apiKey，若误传应被忽略或拒（zod 默认 strip，可加 `.strict()`）。反例（缺 enabled / type 非法）抛错。
- `CreateModelRequestSchema`：正例（含 apiKey）通过；反例（缺 apiKey / type 非法）抛错。
- `TestModelResponseSchema`：正例（ok:true）+（ok:false,error）都通过；反例（缺 ok）抛错。

**后端单元（jest，沿用 `test/users.service.spec.ts` mock repo 模式）：**
- `EncryptionService`：encrypt→decrypt 往返一致；同明文两次加密密文不同（随机 iv）；mask 不含明文中间段；解密被篡改密文抛错。
- `ModelsService`（mock repo + mock port + real enc）：
  - `create`：调用 `enc.encrypt(apiKey)`，repo.insert 收到 `apiKeyEnc` 以 `v1:` 开头；返回值含 `apiKeyMasked` 不含 `apiKey`。
  - `list/get`：返回值 `apiKeyMasked` = `enc.mask(enc.decrypt(row.apiKeyEnc))`，无明文泄漏。
  - `test`：not found → `NotFoundException`；正常 → 调 `port.test` 并返回其结果；span 被创建（可用 `@opentelemetry/sdk-trace-base` 的 `InMemorySpanExporter` 断言，已在 devDeps `apps/backend/package.json:40`）。
- `OpenAiCompatProvider`（mock global `fetch`）：
  - `test` llm → fetch 调 `POST {baseUrl}/chat/completions`，body 含 `max_tokens:1`；200 + `choices[0]` → `{ok:true,latencyMs}`；500 → `{ok:false,error}`。
  - `test` embedding → `/embeddings`，body `input:"ping"`。
  - `test` rerank → `/rerank`，body `query+documents`。
  - 网络错（fetch reject）→ `{ok:false,error:err.message}`，不抛。

**后端 e2e（jest + supertest，沿用 `test/skeleton.e2e.spec.ts` 模式，需真 PG 或 mock repo）：**
- 因 `ModelsService` 依赖真 DB + 真 enc，e2e 需决策：**方案 A**（推荐）e2e 用真实 PG（compose 起的，`AGENTS.md` `docker compose ... up --wait`）+ 测试用 master key env + mock `MODEL_PROVIDER_PORT`（避免真调第三方）。**方案 B** 全 mock（repo + port + enc），e2e 只验 controller 接线。
- `POST /api/models`（apiKey）→ 201，响应无 `apiKey` 字段，有 `apiKeyMasked`，DB 查 `api_key_enc` 以 `v1:` 开头且 ≠ apiKey 明文。
- `GET /api/models` → 200，每条 `ModelProviderSchema.parse` 通过，无明文 key。
- `POST /api/models/:id/test`（mock port 返回 `{ok:true,latencyMs:42}`）→ 200 `{ok:true,latencyMs:42}`；`/test` 不存在的 id → 404。
- `PATCH /api/models/:id {enabled:false}` → 200；`GET` 反映。
- `DELETE /api/models/:id` → 204；`GET /:id` → 404。
- **更新 `skeleton.e2e.spec.ts:98-128`**：mock→真实行为迁移（见 Investigation §7），补 apiKey、改 test 响应断言、seed 或调整 list 断言。
- OpenAPI（`test/openapi.e2e.spec.ts` 模式）：`/api/docs-json` paths 含 `/api/models/{id}/test`、`PATCH /api/models/{id}`、`DELETE /api/models/{id}`。

**前端（vitest + @testing-library/react，沿用 `App.test.tsx` 模式）：**
- `ModelsPage` 渲染：mock `getModels` 返回 2 条 → 列表显 2 行，掩码显示。
- drawer "接入"：填表 → `createModel` 被调（参数含 apiKey），成功后列表刷新。
- "测试连接"：调 `testModel`，显示 ok/错误。
- 启用开关：点击 → `updateModel({enabled})`。
- 不显式断言明文 apiKey（保证无明文渲染）。

## Risks / unknowns

1. **e2e 测试 DB 策略未定。** 现有 e2e（`skeleton.e2e.spec.ts`）全用 mock service，不打真 DB。M3 `ModelsService` 依赖真 repo + 真 enc。**方案 A**（真 PG + mock port）需要测试启动 compose（`AGENTS.md` 命令），CI 要有 PG；**方案 B**（全 mock）e2e 失去验真实加密/映射的价值。**建议**：单元测覆盖 enc + service 映射（mock repo），e2e 用方案 A 验端点接线 + 掩码返回。dev 阶段定。
2. **OpenAI 兼容 baseUrl 是否必填。** 原型 `MODEL_TYPES.LLM.base` 给默认值（`mocks/models.ts:42` DeepSeek）。但不同 provider 默认不同。**决策**：`baseUrl` 契约 optional，但 adapter 调用时若缺则按 `provider` 推断（DeepSeek→`https://api.deepseek.com/v1`，OpenAI→`https://api.openai.com/v1`，自部署→必填否则 test 报错）。推断表放 adapter。或简化：要求 `baseUrl` 必填（用户填，M2 drawer 已有该字段）。倾向必填，减少推断复杂度——dev 定。
3. **Rerank 端点形状多样性。** Cohere（`/rerank`，body `query/documents/top_n`）、Jina（`/rerank` 同形）、TEI（`/rerank` 同形）、vLLM（无原生 rerank）。M3 adapter 锁 Cohere/Jina/TEI 兼容的 `/rerank` 形状。对 vLLM 等无 rerank 端点的部署，test 报 `{ok:false,error}`（合理）。**不抽象多 rerank 协议**（YAGNI，等真有第二类需求再加适配器）。
4. **前端 `ModelType` 大小写迁移。** `mocks/models.ts:5` `ModelType="LLM"|"Rerank"|"Embedding"`（大写）vs 契约小写。改前端内部用小写、UI 展示时大写首字母。`MODEL_TYPES` 的 key 也要改小写。这是 mock→契约对齐，`006:67` Invariant 2 要求类型一致。低风险但需细心。
5. **`trace.llm/embeddings` 封装缺失。** M3 用 `withSpan` 直接打，属性手填 `GEN_AI.*`。M0.5 本应建 `trace.*` 封装（`003:270`）但未落地。**不阻塞 M3**，但 M8 chat 路径会重复手填属性。**Revisit**：M3 收尾后单列任务补 `trace.{llm,embeddings,rerank}` 封装（M0.5 收尾），M8 受益。
6. **主密钥管理与轮换。** `v1:` 前缀留轮换口，但 M3 不实现轮换。若主密钥泄漏，需手动重加密所有 key（脚本）。**风险**：单点，首期接受（`001:126` Postgres 单点同构）。dev 文档给生成命令 `openssl rand -hex 32`。
7. **`skeleton.e2e.spec.ts` 行为迁移边界。** 改测试时易顺手弱化（如把 `length>0` 改 `>=0`）。**纪律**：list 断言改为「seed 后 length===1 + schema 合规」而非「>=0」；test 断言改为 `TestModelResponseSchema.parse` + `ok` 布言；create 断言加「响应无 apiKey 字段」。保持断言强度，只换形状。
8. **adapter 内 fetch 的超时与重试。** 连通性测试若目标 URL 慢/挂，会阻塞。**决策**：`AbortController` 设 10s 超时，超时→`{ok:false,error:"timeout"}`。不重试（test 是一次性探测）。M8 真实调用再定重试策略（`001:122` 生成不重试、改写/embed 重试 1 次）。

## Self-review

- **placeholder 扫描**：无 TBD/XXX/待定 占位。
- **内部一致**：契约读写分离（§A）与 service 映射（§C）、前端 typed client（§D）、AC（1-7）、Test plan 一致；端口 token `MODEL_PROVIDER_PORT` / `ENCRYPTION` 全文一致。
- **scope 检查**：未越界到 traces/chat/M0.5 trace 封装；Non-goals 显式排除。
- **ambiguity**：e2e DB 策略（Risk 1）、baseUrl 必填否（Risk 2）列为 dev 决策点，不阻塞 spec。
- **integrity**：所有 file:line 引用均实际读过（见 Investigation）；未臆测未开文件。`ModelProviderPort` 形状对齐 `001:96` `chat()/embed()/rerank()` + 加 `test()`；表结构对齐 `001:81`。
