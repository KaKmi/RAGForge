# M3 — 模型接入（Model Integration）Spec

> Host spec（独立调查产物，重新规划版）。Peer spec 见 `peer-spec.md`，分歧见 `diff-report.md`。
> 基线：分支 `feat/m3-model-integration` @ main（3b55109，M6 Prompt 管理已合入）。
> 旧版 M3 plan 已被用户删除，本 spec 基于当前代码全新调查（M6 已落地，范式以 prompts 模块为准）。

## Problem / Motivation

M2 把 `models` 模块建成 skeleton：`ModelsService` 用硬编码 `MOCK_MODELS`（`apps/backend/src/modules/models/models.service.ts:4-30`），`create()` 仅回显不持久化（`:44-47`），`test()` 永远返回 `{ok:true}`（`:49-52`）。前端 `ModelsPage.tsx` 完全本地态：`useState(LLM_ROWS)` 渲染 mock（`apps/frontend/src/pages/admin/ModelsPage.tsx:125`），"测试连接"按钮只 `setTested(true)`（`:489`），不调任何 API。

M3 要做成真实可用：注册模型供应商（含 API Key）→ Key 加密存库 → "测试连接"真打 OpenAI 兼容端点验活 → 前端列表/开关/编辑/删除/测试全接真后端 → Key 永远以掩码返回。

**路线图验收（002:86）**：注册模型并"测试"通过；key 前端掩码。
**架构不变量（001:43 Invariant 4）**：模型 API Key 永不明文回传前端，存储加密。

## Investigation findings

### 契约现状（必须修订）

- `packages/contracts/src/models.ts:3` — `ModelTypeSchema = z.enum(["llm","embedding","rerank"])`（小写）。
- `:6-15` — `ModelProviderSchema`：`baseUrl` **optional**、`apiKeyMasked` optional、`role` optional、`enabled` 必填。**无 `deploymentId`**（001:81 表定义有 `deployment_id`）。
- `:21` — `CreateModelRequestSchema = ModelProviderSchema.omit({ id: true })`——只去 id，**保留了 `apiKeyMasked`**，客户端无法提交明文 key。**无 Update / TestResponse schema**。
- zod 版本 `^4.4.3`（`packages/contracts/package.json`）。

### 后端范式（照搬 prompts 模块，M6 已落地的最新范式）

- `apps/backend/src/modules/prompts/schema.ts:6-14` — 域内 `pgTable` 定义 + `$inferSelect/$inferInsert` 导出，头注释声明"零 service 引用（003 不变量 5）"。
- `apps/backend/src/modules/prompts/prompts.repository.ts:48-49` — `@Injectable()` + `@Inject(DRIZZLE) private readonly db: DB`。
- `apps/backend/src/modules/prompts/prompts.service.ts:14-16,118-129` — service 注入 repo，`toPrompt(row)` 做 row→DTO 映射。
- `apps/backend/src/modules/prompts/prompts.controller.ts:14-18` — `createZodDto` + `AuthedRequest`（guard 挂 user）。
- `apps/backend/src/modules/prompts/prompts.module.ts:6-10` — `providers:[Repo, Service], exports:[Service]`。
- `apps/backend/src/db/schema.ts:9-10` — barrel：`export * from "../modules/users/schema"` + prompts。M3 追加 models。
- 迁移：`apps/backend/package.json:11-12` — `db:generate`（drizzle-kit generate）→ `db:migrate`（tsx src/db/migrate.ts）。现有迁移 `drizzle/0000-0002`。

### 平台基础设施

- `apps/backend/src/platform/config/config.schema.ts:3-14` — envSchema **无加密主密钥** env；`JWT_SECRET: z.string().min(32)` 是 fail-fast 先例。
- `apps/backend/src/platform/config/config.module.ts` — `@Global()` + `ConfigModule.forRoot({isGlobal:true, validate})`。
- `apps/backend/src/platform/persistence/persistence.module.ts:10-24` — `@Global()` 平台模块范式：Symbol token（`DRIZZLE`）+ useFactory + exports。
- `apps/backend/src/platform/security/` — 仅 `public.decorator.ts` + `authenticated-user.ts`，**无加密设施、无 SecurityModule**。
- `apps/backend/src/app.module.ts:23-26` — 平台模块（AppConfig/Persistence/ClickHouse）在 root imports 显式注册。

### 设计权威（001/003）

- 001:81 — `model_providers(id, type[llm/embedding/rerank], provider, name, base_url, api_key_enc, deployment_id, enabled)`。
- 001:159 — `api_key_enc` **应用层加密**（阿里云部署用 KMS），返回前端掩码。
- 003:101 — 端口归"需要它的域模块"：**`models` 拥有 `ModelProviderPort`**，适配器（`OpenAiCompatProvider`）经 DI token 注入；"拿端口，不拿适配器"。
- 003:135 — `ingestion`（M4）将依赖 `ModelProviderPort` 而非 models 内部 → **port token 必须从 ModelsModule 导出**。
- 003:139 — 边界由 eslint 焊死：禁止直接 import `adapters/`。
- 003:187 — "模型 API Key 不进 env（加密存库）"——指模型 key 本身；加密**主密钥**放 env 不违反。

### 可观测

- `packages/otel/src/trace.ts:35-54` — 仅 `withSpan(name, {attributes}, fn)`；**无 `trace.llm/embeddings/rerank` 语义封装**（003 计划 M8 建）。
- `packages/otel-conventions/src/index.ts` — `GEN_AI`（SYSTEM/OPERATION_NAME/REQUEST_MODEL…）、`OTEL_OPERATIONS`（CHAT/EMBEDDINGS/RERANK…）、`CODECRUSH_SPAN_KIND`（LLM/EMBEDDINGS/RERANK/TOOL…）常量齐全，直接用。

### 前端现状

- `apps/frontend/src/api/client.ts:119-120` — models 域**只有 `getModels`**（无 create/update/delete/test）；`postJson/getJson` 封装（`:76-99`）与 `deletePrompt` 的 204 处理范式（`:207-214`）可照搬。
- `apps/frontend/src/pages/admin/ModelsPage.tsx:1-519` — 全本地 mock；抽屉表单 `ModelDraft {type,prov,name,base,key}`；**抽屉底部"测试连接"发生在保存之前**（`:489-504`），行内另有"测试"链接（`:334`）。
- `apps/frontend/src/mocks/models.ts:5` — 本地 `ModelType = "LLM"|"Rerank"|"Embedding"`（大写，与契约小写不一致）；`LLM_ROWS`（mock 数据，M3 删）；`MODEL_TYPES`（provider 列表/baseUrl 默认/参数提示，抽屉 UX 常量，保留改造）。
- M6 前端范式：`PromptsPage.tsx:86-106` — `useState` loading/listErr/busyId + `useEffect` 加载 + 防抖搜索，是接线参考。

### 会破坏的现有测试（全量清单）

1. `apps/backend/test/skeleton.e2e.spec.ts:197-227` models 块 4 个测试：
   - `GET /api/models/m1`（mock id）→ 改为动态创建后查询；
   - `POST /api/models` 发 `{type,provider,name,enabled}` **无 apiKey/baseUrl** → 新契约下 400，测试体必须补字段；
   - `POST /api/models/m1/test → {ok:true}` → 真实实现打外网，必须 `overrideProvider(MODEL_PROVIDER_PORT)` mock。
   - TestingModule 直接 imports `ModelsModule`（`:158`）→ ModelsService 新注入的 `ENCRYPTION` token 必须可解析（见 Design 3）。
2. `apps/backend/test/config.schema.spec.ts:16-23` — "合法 JWT_SECRET → 通过"用例的 env 对象**不含新必填 key** → 新增 `MODEL_API_KEY_ENCRYPTION_KEY` 必填后该用例失败，**必须同步更新**（合法契约演进，非软化）。
3. `packages/contracts/src/m2-schemas.test.ts:35-45` — `valid.model` fixture（含 `apiKeyMasked`）；`:149-150,218-219` ModelProviderSchema 正反例；`:310-314` `CreateModelRequestSchema` omit 断言 → 契约改后需更新。
4. `apps/backend/test/openapi.e2e.spec.ts` — 无 models 断言（grep 无命中），不受影响；`skeleton.e2e.spec.ts:578-579` 的 paths 断言仍通过（端点只增不减）。

## Design approach

### 1. 契约修订（`packages/contracts/src/models.ts`）

```ts
export const ModelTypeSchema = z.enum(["llm", "embedding", "rerank"]); // 不变

// 读侧：掩码必有（create 强制 apiKey，读侧恒可派生）；补 deploymentId 对齐 001:81。
// role 删除（diff D1 conceded）：001:81 权威表无 role，M2 mock 字段不持久化；
// 前端"用途"列改由 type 派生文案。
export const ModelProviderSchema = z.object({
  id: z.string().min(1),
  type: ModelTypeSchema,
  provider: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),            // optional → 必填（连通性测试的硬依赖，无推断表）
  apiKeyMasked: z.string(),             // optional → 必填
  deploymentId: z.string().optional(),  // 新增，对齐 001:81
  enabled: z.boolean(),
});

// 写侧：明文 apiKey；enabled 缺省 true（抽屉无开关）
export const CreateModelRequestSchema = ModelProviderSchema.omit({
  id: true,
  apiKeyMasked: true,
}).extend({
  apiKey: z.string().min(8),            // 防误填
  enabled: z.boolean().default(true),
});

// PATCH：全可选；apiKey 不传 = 不改
export const UpdateModelRequestSchema = CreateModelRequestSchema.partial();

// ad-hoc 测试（保存前验活，见 Design 6）：与 Create 同形去 enabled
export const TestModelRequestSchema = CreateModelRequestSchema.omit({ enabled: true });

// statusCode（diff D6 patched）：透传上游 HTTP 状态便于 UI 提示；error 为脱敏摘要（不含 key/headers）
export const TestModelResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  statusCode: z.number().int().optional(),
  error: z.string().optional(),
});
```

**决策**：
- `baseUrl` 必填：adapter 直接用，不做 provider→URL 默认表（默认值只作前端 placeholder UX，`MODEL_TYPES` 保留）。
- `apiKeyMasked` 必填：写侧强制有 key，读侧恒可派生，optional 是假灵活。
- 响应侧**永不出现 `apiKey` 字段**。

### 2. 加密（`apps/backend/src/platform/security/encryption.ts` NEW）

Node 内置 `crypto`，AES-256-GCM。密文 envelope 带版本前缀（diff D2 conceded——为 001:159 日后换 KMS 留迁移标识）：`v1:<ivB64>:<tagB64>:<ciphertextB64>`（iv 12B、authTag 16B）。

```ts
@Injectable()
export class EncryptionService {
  constructor(masterKeyB64: string) {} // 32 字节 base64
  encrypt(plaintext: string): string   // 随机 iv，每次密文不同，输出 v1: envelope
  decrypt(envelope: string): string    // 非 v1 前缀 / GCM authTag 校验失败 → 抛错（不吞）
  maskApiKey(plaintext: string): string
  // 掩码规则（diff D7 conceded，两分支）：len≥8 → 首3+"****"+末4（"sk-abcdef1234"→"sk-****1234"，
  // 与 M2 mock 展示格式一致）；len<8 → "****"
}
```

- `security.constants.ts` NEW：`export const ENCRYPTION = Symbol("ENCRYPTION")`。
- `security.module.ts` NEW：`@Global()`（对齐 PersistenceModule 范式）+ `useFactory(cfg: AppConfigService) => new EncryptionService(cfg.modelApiKeyEncryptionKey)` + exports。
- `app.module.ts`：imports 紧挨 PersistenceModule 加 `SecurityModule`（@Global 也必须在 root 注册一次才进模块图）。
- **不变量**：主密钥不进 git；GCM 校验失败向上抛（正常流程不应发生 → 500）。

### 3. env + config

- `config.schema.ts`：`MODEL_API_KEY_ENCRYPTION_KEY: z.string().min(44)`（32B base64 = 44 字符，fail-fast，对齐 `JWT_SECRET.min(32)` 先例）。
- `config.service.ts`：`get modelApiKeyEncryptionKey(): string`。
- `.env.example`：加占位 + 注释 `# 生成：openssl rand -base64 32`；本地 `.env` 用户自行生成（不进 git）。
- **同步更新** `config.schema.spec.ts:16-23`（base 或用例对象补该 key）。
- **e2e 解析策略**：`skeleton.e2e.spec.ts` 的 TestingModule 不 import AppConfigModule，SecurityModule 的 factory 无法解析 → e2e 在 imports 加 `SecurityModule` 并 `overrideProvider(ENCRYPTION).useValue(new EncryptionService(<固定测试 key>))`（override 替换整个 provider 定义，factory 及其 inject 不再执行）。

### 4. DB schema（`apps/backend/src/modules/models/schema.ts` NEW）

```ts
export const modelProviders = pgTable("model_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),              // "llm"|"embedding"|"rerank"
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc").notNull(),  // 列名对齐 001:81
  deploymentId: text("deployment_id"),
  // role 不落库（001:81 无此列，diff D1）；created_at/updated_at 为工程簿记列，
  // users/prompts 均有先例（001 表清单同样未列出），不属架构变更
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type ModelProviderRow = typeof modelProviders.$inferSelect;
export type NewModelProvider = typeof modelProviders.$inferInsert;
```

- `db/schema.ts` barrel 追加 `export * from "../modules/models/schema"`。
- `pnpm db:generate` 出迁移（0003_*），`pnpm db:migrate` 应用。

### 5. Repository + Port/Adapter

`models.repository.ts` NEW（照搬 prompts.repository 范式）：
`find()` / `findById(id)` / `insert(row)` / `update(id, patch)`（自动刷 `updatedAt`）/ `delete(id)`。

`ports/model-provider.port.ts` NEW（003:101 归 models 域）：

```ts
export interface ModelCallConfig {
  type: ModelType; provider: string; name: string; baseUrl: string;
  apiKey: string; deploymentId?: string;
}
export interface TestModelResult { ok: boolean; latencyMs?: number; statusCode?: number; error?: string }
export interface ModelProviderPort {
  testConnection(config: ModelCallConfig): Promise<TestModelResult>;
}
```

端口终态是 001:95 的 `chat()/embed()/rerank()`；M3 **不**预留可选空壳方法（`chat?()` 等）——可选方法迫使 M4/M8 消费方判 undefined，弱化类型；届时加必选方法属非破坏扩展（diff D5）。

`model-provider.constants.ts` NEW：`MODEL_PROVIDER_PORT = Symbol("MODEL_PROVIDER_PORT")`。

`adapters/openai-compat.adapter.ts` NEW，`implements ModelProviderPort`：
- Node 22 全局 `fetch`，**不引 axios/openai SDK**。
- model 参数取 `deploymentId ?? name`（diff D4 conceded——Azure 型部署 ID 即为此设计，001:81）。
- 按 type POST 真调用路径验"该模型可用"（不是只验 auth），2xx 后再做**轻量形状校验**（diff D8 conceded）：
  - llm → `{baseUrl}/chat/completions`，body `{model, messages:[{role:"user",content:"ping"}], max_tokens:1}`；成功 = 2xx 且 `choices` 为数组；
  - embedding → `{baseUrl}/embeddings`，body `{model, input:"ping"}`；成功 = 2xx 且 `data[0].embedding` 为数组；
  - rerank → `{baseUrl}/rerank`，body `{model, query:"ping", documents:["ping","pong"], top_n:1}`（Cohere/Jina/TEI 最大公约数）；成功 = 2xx 且存在 `results` 或 `data` 数组。
- headers：`Authorization: Bearer {apiKey}` + `Content-Type: application/json`。
- `AbortController` 10s 固定超时（不加 env 配置项，diff D9——M3 无调参需求，常量导出便于测试）。
- 一切失败（非 2xx / 形状不符 / 网络错 / 超时）catch → `{ok:false, latencyMs, statusCode?, error}`，**不抛**（测试端点要友好结果）。error 信息取 HTTP status + 响应体 message 截断（≤200 字符），**不含 apiKey / headers / 完整 body**。
- baseUrl 归一化：去尾部 `/`；若已以目标 canonical 路径结尾（`/chat/completions`、`/embeddings`、`/rerank`）则不重复拼接（diff D3 patched——原型默认 base `http://infra.internal:8080/rerank` 即全路径形态；同时前端 `MODEL_TYPES` 默认 base 改为根形态 URL，见 Design 7）。

### 6. Service 重写 + Controller 扩展

```ts
@Injectable()
export class ModelsService {
  constructor(
    private readonly repo: ModelsRepository,
    @Inject(ENCRYPTION) private readonly enc: EncryptionService,
    @Inject(MODEL_PROVIDER_PORT) private readonly provider: ModelProviderPort,
  ) {}
  list / get          // toModelProvider(row)：apiKeyMasked = enc.maskApiKey(enc.decrypt(row.apiKeyEnc))
  create(req)         // apiKeyEnc = enc.encrypt(req.apiKey)，明文不落库不返回
  update(id, req)     // req.apiKey 有值才重加密；delete patch.apiKey 后传 repo
  remove(id)          // 404 守卫后硬删
  testById(id)        // findById → 404 守卫 → decrypt → testConfig(...)
  testConfig(cfg)     // ad-hoc：withSpan("model.test_connection", {gen_ai.*}) 包 provider.testConnection
}
```

- test span 属性（常量取自 `@codecrush/otel-conventions`）：`gen_ai.operation.name` = CHAT/EMBEDDINGS/RERANK（按 type 映射）、`gen_ai.system` = provider、`gen_ai.request.model` = name、`codecrush.span.kind` = LLM/EMBEDDINGS/RERANK（按 type）。
- list/get 每行 decrypt 一次生成掩码：列表 <50 行、低 qps，可接受（量大再存冗余掩码列，revisit）。

Controller（`models.controller.ts` 扩展）：

```
GET    /api/models            → list
GET    /api/models/:id        → get
POST   /api/models            → 201 create（CreateModelRequestDto）
PATCH  /api/models/:id        → 200 update（UpdateModelRequestDto）
DELETE /api/models/:id        → 204 remove
POST   /api/models/test       → 200 testConfig（TestModelRequestDto，ad-hoc 保存前验活）
POST   /api/models/:id/test   → 200 testById
```

**注意路由顺序**：`@Post("test")` 必须声明在 `@Post(":id/test")` 与 `@Get(":id")` 相关路由能正确区分的位置（Nest 按声明序匹配，静态段 `test` 放 `:id` 类路由之前）。

**为什么要 ad-hoc test 端点**：原型抽屉的"测试连接"发生在**保存之前**（ModelsPage.tsx:489-504）。只有 `/:id/test` 则要么先保存再测（UX 倒置），要么前端假测试（违背 M3 目标）。ad-hoc 端点收 `TestModelRequest`（含明文 key，HTTPS 内传输与登录密码同级），不落库、只透传测试。

ModelsModule：

```ts
@Module({
  controllers: [ModelsController],
  providers: [ModelsRepository, ModelsService,
    { provide: MODEL_PROVIDER_PORT, useClass: OpenAiCompatAdapter }],
  exports: [ModelsService, MODEL_PROVIDER_PORT], // M4 ingestion 拿 port（003:135）
})
```

### 7. 前端接通

- `api/client.ts`：补
  `createModel(req)`（postJson）、`updateModel(id, req)`（PATCH，apiFetch + ModelProviderSchema.parse）、`deleteModel(id)`（照搬 deletePrompt 204 范式）、`testModel(id)`、`testModelConfig(req)`（POST /api/models/test）。
- `pages/admin/ModelsPage.tsx` 重写数据层（保持既有布局/样式，参照 PromptsPage 范式）：
  - 挂载 `getModels()` → loading / listErr / rows；
  - Tab 计数按契约小写 type 过滤，显示用 `TYPE_LABEL: Record<ModelType,"LLM"|"Embedding"|"Rerank">` 映射；
  - 开关 → `updateModel(id, {enabled})`，busy 态防连点；
  - 抽屉"接入" → `createModel({type, provider, name, baseUrl, apiKey})` → 刷新列表；
  - 抽屉"测试连接" → `testModelConfig(表单值)` → ✓/✗ + error 展示；
  - 行内"测试" → `testModel(id)`；行内"编辑" → 抽屉回填（apiKey 留空 = 不改、旁显 `apiKeyMasked`，填了才随 PATCH 提交）→ `updateModel`；行内"删除" → confirm → `deleteModel`；
  - 行"用途"列改为 type 派生文案（`MODEL_TYPES[type].hint`，role 已从契约删除，diff D1）。
- `mocks/models.ts`：删 `LLM_ROWS` 与本地 `ModelType`（改从 `@codecrush/contracts` import）；`MODEL_TYPES` 改键为契约小写 type 并保留（provider 候选/baseUrl 默认/参数提示是纯 UX 常量）；**默认 base 改根形态 URL**（`http://infra.internal:8080/rerank` → `http://infra.internal:8080`，adapter 拼 canonical 路径，diff D3）；`ModelDraft` 补 `baseUrl/apiKey` 命名对齐契约。

## Intent / non-goals / forbidden shortcuts

**Intent**：真实 CRUD 持久化 `model_providers`；Key 加密存库、掩码返回；连通性测试真打 OpenAI 兼容端点（含保存前 ad-hoc 测试）；前端全交互接真后端。

**Non-goals**：
- 不建 `trace.{llm,embeddings,rerank}` SDK 封装（M8 chat 首个消费方时建，M3 用 `withSpan` + 手填 `gen_ai.*`）。
- Port 只暴露 `testConnection`——真正 chat/embed/rerank 调用由 M4/M8 扩展。
- 不引 axios / openai SDK；不做 provider→baseUrl 推断；不做 RBAC（M12）；不做软删除；不 seed 默认模型（key 无法预置）；不做删除引用守卫（KB/Agent 尚为 mock，M4/M7 加）。

**Forbidden shortcuts**：
- 明文 apiKey 不得落库、不得出现在任何响应/日志/span 属性/error message。
- 不得软化 skeleton.e2e / config.schema.spec / m2-schemas.test 断言——按新契约更新测试体是合法演进。
- e2e 不得真打外部 API——必须 `overrideProvider(MODEL_PROVIDER_PORT)`。
- 不得为过测试跳过 GCM authTag 校验。
- 前端不得留任何 mock 数据渲染路径（LLM_ROWS 必删）。

## Acceptance criteria

1. `POST /api/models` `{type,provider,name,baseUrl,apiKey}` → 201；响应含 `apiKeyMasked`（如 `sk-****cdef`）、无 `apiKey`；DB `api_key_enc` 为密文（非明文/掩码）。
2. `GET /api/models` → 200，每项掩码、无明文。
3. `POST /api/models/:id/test` 与 `POST /api/models/test` → 真打 OpenAI 兼容端点；成功 `{ok:true,latencyMs}`，失败 `{ok:false,error}`（HTTP 仍 200，不抛 500）。
4. `PATCH /api/models/:id` `{enabled:false}` → 生效；带 `apiKey` → 重加密；不带 → key 不变。
5. `DELETE /api/models/:id` → 204；再 GET → 404。
6. 前端 ModelsPage：列表/接入/抽屉测试/行内测试/开关/编辑/删除全链路真后端，无 mock 残留。
7. `pnpm db:generate` + `pnpm db:migrate` 产出并应用 `model_providers` 迁移。
8. `pnpm test`、`pnpm lint`（边界 0 违规）、`pnpm build` 全绿。
9. `.env.example` 含 `MODEL_API_KEY_ENCRYPTION_KEY` 占位与生成说明；真值不进 git。
10. OpenAPI docs-json 含 `PATCH/DELETE /api/models/{id}`、`POST /api/models/test`。

## Test plan

**新增**：
- `packages/contracts/src/models.test.ts`（或扩 m2-schemas.test.ts）：Create 拒绝无 apiKey / key<8 / 缺 baseUrl；接受合法体且 `enabled` 缺省 true；ModelProviderSchema 无 apiKey 字段（strict 场景断言掩码必填）；Update 全可选；TestModelRequest 无 enabled。
- `apps/backend/test/encryption.spec.ts`：encrypt→decrypt 往返；同明文两次密文不同（随机 iv）；错 key / 篡改密文 / 非 v1 前缀 → 抛错；maskApiKey 边界（空串、<8、=8、>8）。
- `apps/backend/test/models.service.spec.ts`：mock repo + mock port + 真 EncryptionService（固定 key）——create 后 repo 收到的是密文；list 返回掩码；update 带/不带 apiKey 两分支；testById 404 守卫 + 透传 port 结果。
- `apps/backend/test/openai-compat.adapter.spec.ts`：mock 全局 fetch——三类 type 各验 URL 路径与 body 形状（model 取 deploymentId ?? name）；2xx + 形状合规 → ok:true；2xx 但形状不符 → ok:false；非 2xx → ok:false + statusCode + error；fetch reject → ok:false 不抛；baseUrl 尾斜杠与 canonical 后缀去重。
- `apps/frontend/src/app/App.test.tsx` 扩展（对齐 M6 PromptsPage 挂载测试范式 `App.test.tsx:68-92`）：`/admin/models` 挂载时 mock fetch 断言真调 `/api/models`、空态渲染、不再消费本地 LLM_ROWS。
- `skeleton.e2e.spec.ts` models 块重写：imports 加 SecurityModule，`overrideProvider(ENCRYPTION)`（固定 key 实例）+ `overrideProvider(MODEL_PROVIDER_PORT)`（mock）+ `overrideProvider(ModelsRepository)`（in-memory，照搬 inMemoryPromptsRepo 范式 `skeleton.e2e.spec.ts:58-148`）；覆盖 POST→201+掩码、GET 列表、PATCH enabled、DELETE 204、/:id/test 与 /test。

**更新（非软化）**：`config.schema.spec.ts:16-23` 补新 env key；`m2-schemas.test.ts` valid.model fixture + omit 断言按新契约改。

## Risks / unknowns

1. **rerank 端点碎片化**：Cohere/Jina/TEI payload 字段名有差异（documents/texts、top_n/topN）。M3 用最通用形 `{model,query,documents,top_n}`，400/404 一律 `{ok:false}` 可见 error；M5 真消费时再细化多 provider 兼容。
2. **ad-hoc test 传明文 key**：HTTPS 内与登录密码同级；不落库不打日志。若用户反对该端点，回退方案是"先保存再测"（抽屉测试按钮改为保存后自动触发），属 UX 降级不阻塞。
3. **掩码需逐行解密**：≤50 行列表可接受；revisit：量大时存冗余掩码列。
4. **e2e 不碰真 PG**：drizzle 查询正确性靠 TS 类型推断 + `pnpm db:migrate` 手动兜底（与 users/prompts 现状一致）；发现不足再补真 PG 集成测试。
5. **update 的 `deploymentId` 清空语义**：PATCH partial 下 `undefined`=不改；显式 `null` 清空不支持（zod optional 不收 null）——M3 不需要清空场景，记录即可。
6. **role/用途 字段被移除**：M2 mock 的 role 文案（如"回复生成（主）"）不再持久化；真实"用途"信息 M7 由 Agent 绑定关系派生。若产品要求可编辑用途，先改 001:81 表定义再实现（CLAUDE.md：改架构先改文档）。

## References

- 路线图 002:86（M3 行）；架构 001:81（表）、001:43/159（key 不变量）；组织 003:101/135/139/187（端口/边界/密钥）。
- 范式：`modules/prompts/*`（M6 后端+e2e in-memory repo）、`PromptsPage.tsx`（前端接线）、`users.repository.ts`（最简 repo）。
- 原型：`CodeCrushBot.dc.html` 模型接入页（抽屉先测后存交互）。
