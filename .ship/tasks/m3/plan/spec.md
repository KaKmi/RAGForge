# M3 — 模型接入（Model Integration）Spec

> Host spec（独立调查产物）。Peer spec 见 `peer-spec.md`，分歧见 `diff-report.md`。
> 基线：分支 `design/m3-m6` @ `feat/m2-app-shell` (75e9b61)。M2 skeleton 已就位。

## Problem / Motivation

M2 把 `models` 模块建成了 skeleton：`ModelsService` 用硬编码 `MOCK_MODELS` 数组（`models.service.ts:4-30`），`create()` 仅回显（`:46`），`test()` 永远返回 `{ok:true}`（`:49-52`）。前端 `ModelsPage.tsx` 用本地 mock（`mocks/models.ts` `LLM_ROWS`）渲染，不调任何 API。

M3 要把"模型接入"做成真实可用：能注册一个模型供应商（含 API Key），把 Key 加密存库，点"测试连接"真去打 OpenAI 兼容端点验活，前端列表/开关/编辑/删除接真后端，Key 永远以掩码形式返回前端。

**路线图验收（002 M3 行）**：注册模型并"测试"通过；key 前端掩码。

## Investigation findings

### 现有 skeleton（M2 产物，必读）

- `packages/contracts/src/models.ts:1-22` — `ModelTypeSchema = z.enum(["llm","embedding","rerank"])`（小写）；`ModelProviderSchema` 含 `apiKeyMasked: z.string().optional()`（读侧掩码）、`baseUrl?: string`、`role?: string`、`enabled: boolean`；`CreateModelRequestSchema = ModelProviderSchema.omit({ id })`——**问题**：omit 只去掉 id，仍保留 `apiKeyMasked` + `enabled`，客户端没法提交明文 key。M3 必须改契约为 `apiKey`（明文写）。
- `apps/backend/src/modules/models/models.service.ts:1-53` — mock 桩，3 个 MOCK_MODELS。
- `apps/backend/src/modules/models/models.controller.ts:1-32` — `GET /`、`GET /:id`、`POST /`（201）、`POST /:id/test`（200 `{ok}`）。DTO 用 `createZodDto(CreateModelRequestSchema)`。
- `apps/backend/src/modules/models/models.module.ts:1-9` — 仅 `controllers:[ModelsController], providers:[ModelsService]`，无 repo、无 port。
- `apps/backend/src/app.module.ts:11,32` — ModelsModule 已注册。

### 同类范式（users 真实 CRUD，照搬结构）

- `apps/backend/src/modules/users/schema.ts:1-11` — `pgTable("users", {...})`，`$inferSelect` 导出 `UserRow`。纯表定义，零 service 引用（003 不变量 5）。
- `apps/backend/src/modules/users/users.repository.ts:1-27` — `@Injectable()` + `@Inject(DRIZZLE) private readonly db: DB`，方法 `findById/findByEmail/updatePasswordHash`。
- `apps/backend/src/modules/users/users.service.ts:1-60` — `@Injectable()`，注入 `UsersRepository`，`toProfile(row): UserProfile` 做 row→DTO 映射，含时序攻击防护（dummyHash）。
- `apps/backend/src/modules/users/users.module.ts:1-11` — `providers:[UsersRepository, UsersService], exports:[UsersService]`。
- `apps/backend/src/modules/users/users.controller.ts:1-32` — `@Req() req: AuthedRequest` 拿 `req.user.id`；`createZodDto`。

### 平台基础设施

- `apps/backend/src/platform/persistence/persistence.module.ts:1-24` — `@Global() PersistenceModule`，provider `DRIZZLE`（`drizzle(pool, { schema })`），export `DRIZZLE`。`DB = NodePgDatabase<typeof schema>`。
- `apps/backend/src/platform/persistence/drizzle.constants.ts` — `DRIZZLE` Symbol token。
- `apps/backend/src/platform/config/config.schema.ts:1-14` — envSchema。**无加密主密钥** env。M3 要加 `MODEL_API_KEY_ENCRYPTION_KEY`。
- `apps/backend/src/platform/config/config.service.ts:1-39` — `AppConfigService` 按 env 逐个 getter。M3 加 `modelApiKeyEncryptionKey` getter。
- `apps/backend/src/platform/security/` — 现有 `public.decorator.ts` + `authenticated-user.ts`，**无 crypto**。M3 在此加 `crypto.ts`。
- `apps/backend/src/db/schema.ts:1-9` — barrel，仅 `appMeta` + `export * from "../modules/users/schema"`。M3 加 `export * from "../modules/models/schema"`。
- `apps/backend/drizzle.config.ts:1-9` — `schema: "./src/db/schema.ts", out: "./drizzle", dialect: "postgresql"`。迁移由 `drizzle-kit generate` 生成、`pnpm db:migrate`（`db/migrate.ts:1-16`）应用。

### 可观测（003 §通用 Telemetry SDK 与包边界）

- `packages/otel/src/trace.ts:1-77` — 仅 `withSpan(name, {attributes}, fn)` + `emitManualHelloSpan` + `forceFlushTelemetry`。**无 `trace.llm/embeddings/rerank` 语义封装**（003:270 计划 M0.5 建，未交付）。
- `@codecrush/otel-conventions` — `CODECRUSH_SPAN_KIND` + `OTEL_OPERATIONS` 常量（`trace.ts:2` 导入）。
- 结论：M3 连通性测试用 `withSpan` 直接打 + 手填 `gen_ai.*` 属性即可工作；`trace.{llm,embeddings,rerank}` 封装列为 non-goal（M8 chat 路径再建，重复手填届时统一收口）。

### 前端现状

- `apps/frontend/src/pages/admin/ModelsPage.tsx:1-519` — 完全本地态：`useState(LLM_ROWS)`，tab/开关/抽屉全本地，"测试连接"按钮 `setTested(true)`（`:489`），"接入"按钮 `save()` 本地 push（`:170-185`）。不调 `api/client.ts`。
- `apps/frontend/src/mocks/models.ts:1-83` — 本地 `ModelType = "LLM"|"Rerank"|"Embedding"`（**大写**，与契约小写 enum 不一致）；`LLM_ROWS` 7 条；`MODEL_TYPES`（UI 常量：provider 列表/baseUrl 默认/参数提示）；`ModelDraft`（抽屉表单：type/prov/name/base/key）。
- `apps/frontend/src/api/client.ts` — M2 已有 typed client（`getModels/createModel/...`，见 M2 dev-ledger Story 6），但 M2 无页面调用。M3 首次接通。

### 现有测试（会被改动）

- `apps/backend/test/skeleton.e2e.spec.ts:98-128` — models 4 个测试：
  - `POST /api/models` 发 `{type,provider,name,enabled}`（无 apiKey）→ 201。M3 改契约后缺 apiKey → 400。**必须更新**测试体加 `apiKey`，并断言响应含 `apiKeyMasked`、不含明文。
  - `POST /api/models/m1/test → {ok:true}`。M3 真实 testConnection 需打外部 API，e2e 必须 mock `MODEL_PROVIDER_PORT`。
- `packages/contracts/src/m2-schemas.test.ts` — 含 `CreateModelRequestSchema` 正反例。改契约后要更新。

## Design approach

### 1. 契约修订（`packages/contracts/src/models.ts`）

> diff 应用：D3 `baseUrl` 改必填（删默认表）；D8 列名 `api_key_enc`；D10 读 DTO 加 `deploymentId`。

```ts
// 响应（读侧）：保持 apiKeyMasked，去掉明文
export const ModelProviderSchema = z.object({
  id: z.string().min(1),
  type: ModelTypeSchema,
  provider: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),        // 必填（D3：去 optional + 默认表）
  apiKeyMasked: z.string().optional(),
  deploymentId: z.string().optional(), // D10：对齐 001:81
  role: z.string().optional(),
  enabled: z.boolean(),
});

// 创建（写侧）：明文 apiKey，去掉 apiKeyMasked
export const CreateModelRequestSchema = ModelProviderSchema.omit({
  id: true,
  apiKeyMasked: true,
}).extend({ apiKey: z.string().min(8) });

// 更新（PATCH）：全部可选；apiKey 可选（不传则不改 key）
export const UpdateModelRequestSchema = CreateModelRequestSchema.partial();

// 测试结果
export const TestModelResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  error: z.string().optional(),
});
```

**决策点**：
- `baseUrl` **必填**（D3 conceded to peer）：抽屉恒提交，默认表是死代码 + 维护负担（新增 provider 须改表）。adapter 直接用 `row.baseUrl`，不做 provider→baseUrl 推断。
- `apiKey.min(8)`：太短的 key 直接 400（防误填）。

### 2. 加密服务（`apps/backend/src/platform/security/encryption.ts` NEW）

> diff 应用：D6 conceded to peer——`EncryptionService` class + `SecurityModule`（@Global）+ `ENCRYPTION` token，对齐 platform module 约定（ClickHouseModule/PersistenceModule）。可测（`overrideProvider(ENCRYPTION)`）+ API 干净（`encrypt(plaintext)` 无 key 参数）。D9 `maskApiKey` 边界细化。

Node 内置 `crypto`（backend-only，不进 contracts）。AES-256-GCM：

```ts
// apps/backend/src/platform/security/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { Injectable } from "@nestjs/common";

@Injectable()
export class EncryptionService {
  constructor(private readonly masterKeyB64: string) {} // 32 字节 base64 = 44 字符

  private get key(): Buffer { return Buffer.from(this.masterKeyB64, "base64"); } // 32 bytes

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64"); // iv(12)|tag(16)|enc
  }

  decrypt(blobB64: string): string {
    const buf = Buffer.from(blobB64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }

  // 掩码（D9 边界细化）：<4 全 ****；4-8 → **末2；>8 → 首3****末4
  maskApiKey(plaintext: string): string {
    if (plaintext.length < 4) return "****";
    if (plaintext.length <= 8) return `**${plaintext.slice(-2)}`;
    return `${plaintext.slice(0, 3)}****${plaintext.slice(-4)}`;
  }
}
```

```ts
// apps/backend/src/platform/security/security.constants.ts
export const ENCRYPTION = Symbol("ENCRYPTION");
```

```ts
// apps/backend/src/platform/security/security.module.ts
import { Global, Module } from "@nestjs/common";
import { AppConfigService } from "../config/config.service";
import { EncryptionService } from "./encryption";
import { ENCRYPTION } from "./security.constants";

@Global()
@Module({
  providers: [
    {
      provide: ENCRYPTION,
      useFactory: (cfg: AppConfigService) => new EncryptionService(cfg.modelApiKeyEncryptionKey),
      inject: [AppConfigService],
    },
  ],
  exports: [ENCRYPTION],
})
export class SecurityModule {}
```

**不变量**：master key 不进 git（`.env.example` 只放占位 + 生成说明）；GCM auth 失败（key 不匹配/密文被篡改）抛错，service 转 500（不应发生在正常流程）。

### 3. env + config + app.module

- `config.schema.ts`：`MODEL_API_KEY_ENCRYPTION_KEY: z.string().min(44)`（32 字节 base64 = 44 字符；fail-fast，缺/过短启动崩）。
- `config.service.ts`：`get modelApiKeyEncryptionKey(): string`。
- `.env.example`：`MODEL_API_KEY_ENCRYPTION_KEY=` + 注释生成命令 `openssl rand -base64 32`。
- `app.module.ts` imports：紧挨 `PersistenceModule`/`ClickHouseModule` 显式加 `SecurityModule`（D14 patched——@Global platform 模块须在 root imports 触发 provider 注册）。

### 4. DB schema（`apps/backend/src/modules/models/schema.ts` NEW）

> diff 应用：D8 列名 `api_key_enc`（对齐 001:81）；D10 补 `deployment_id`（对齐 001:81）；D3 `base_url` 必填。

```ts
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const modelProviders = pgTable("model_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),        // "llm"|"embedding"|"rerank"
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),            // D3 必填
  apiKeyEnc: text("api_key_enc").notNull(),        // D8 encrypt() 输出
  deploymentId: text("deployment_id"),             // D10 对齐 001:81
  role: text("role"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type ModelProviderRow = typeof modelProviders.$inferSelect;
```

- `db/schema.ts` barrel 追加 `export * from "../modules/models/schema";`。
- 迁移：`pnpm --filter @codecrush/backend dlx drizzle-kit generate` → 生成 `drizzle/<ts>_*.sql`；`pnpm db:migrate` 应用。

### 5. ModelsRepository（`models.repository.ts` NEW）

照搬 `users.repository.ts` 模式：

```ts
@Injectable()
export class ModelsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}
  async find(): Promise<ModelProviderRow[]>
  async findById(id: string): Promise<ModelProviderRow | undefined>
  async insert(row: NewModelProvider): Promise<ModelProviderRow>
  async update(id: string, patch: Partial<NewModelProvider>): Promise<void>
  async delete(id: string): Promise<void>
}
```

### 6. ModelProviderPort + 适配器（端口/适配器，003 §端口/适配器落位）

> diff 应用：D3 `baseUrl` 必填（删 `resolveBaseUrl` 默认表）；D5a testConnection 改 POST 真路径验 model name 可用；D5b port 仅暴露 `testConnection`（chat/embed/rerank 留 M4/M8）。

`apps/backend/src/modules/models/ports/model-provider.port.ts` NEW：

```ts
export interface ModelProviderPort {
  testConnection(config: ModelCallConfig): Promise<TestModelResult>;
}
export interface ModelCallConfig {
  type: ModelType;
  provider: string;
  name: string;
  baseUrl: string;   // D3 必填
  apiKey: string;
}
export interface TestModelResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  error?: string;
}
```

`apps/backend/src/modules/models/adapters/openai-compat.adapter.ts` NEW：

```ts
@Injectable()
export class OpenAiCompatAdapter implements ModelProviderPort {
  async testConnection(config): Promise<TestModelResult> {
    const t0 = Date.now();
    try {
      if (config.type === "rerank") return await this.testRerank(config);
      if (config.type === "embedding") return await this.testEmbedding(config);
      return await this.testChat(config); // llm
    } catch (e) { return { ok:false, latencyMs: Date.now()-t0, error: errMsg(e) }; }
  }
  // 三类均 POST 真路径（D5a conceded to peer），验 model name 可用
  private async testChat(c): Promise<TestModelResult> {
    // POST {baseUrl}/chat/completions { model:c.name, messages:[{role:"user",content:"ping"}], max_tokens:1 }
  }
  private async testEmbedding(c): Promise<TestModelResult> {
    // POST {baseUrl}/embeddings { model:c.name, input:"ping" }
  }
  private async testRerank(c): Promise<TestModelResult> {
    // POST {baseUrl}/rerank { model:c.name, query:"ping", documents:["a"], top_n:1 }
  }
}
```

- 用 Node 22 全局 `fetch`（**不引 axios/openai SDK**）。
- 三类均 POST 真调用路径（D5a）：`chat/completions`（max_tokens:1，token 成本 ≤1）、`embeddings`（input:"ping"）、`rerank`（Cohere/Jina/TEI 兼容 payload）。验"具体 `name` 模型可跑"，非仅 auth/可达。
- headers：`Authorization: Bearer {apiKey}` + `Content-Type: application/json`。
- 失败统一 `catch` → `{ok:false, latencyMs, error}`（不抛——测试端点要友好结果）。`AbortController` 10s 超时 → `{ok:false, error:"timeout"}`（peer Risk 8）。
- DI token：`apps/backend/src/modules/models/model-provider.constants.ts` → `MODEL_PROVIDER_PORT = Symbol("MODEL_PROVIDER_PORT")`。

### 7. ModelsService（重写）

> diff 应用：D6 注入 `@Inject(ENCRYPTION) enc: EncryptionService`（替代 AppConfigService + 纯函数）；D8 字段 `apiKeyEnc`。

```ts
@Injectable()
export class ModelsService {
  constructor(
    private readonly repo: ModelsRepository,
    @Inject(ENCRYPTION) private readonly enc: EncryptionService,
    @Inject(MODEL_PROVIDER_PORT) private readonly provider: ModelProviderPort,
  ) {}
  async list(): Promise<ModelProvider[]> { return (await repo.find()).map(r => this.toModelProvider(r)) }
  async get(id): Promise<ModelProvider> { const r = await repo.findById(id); if (!r) throw new NotFoundException(); return this.toModelProvider(r); }
  async create(req: CreateModelRequest): Promise<ModelProvider> {
    const apiKeyEnc = this.enc.encrypt(req.apiKey);
    const row = await repo.insert({ ...req, apiKeyEnc }); // 不存明文
    return this.toModelProvider(row);
  }
  async update(id, req: UpdateModelRequest): Promise<ModelProvider> {
    const patch = { ...req };
    if (req.apiKey) patch.apiKeyEnc = this.enc.encrypt(req.apiKey);
    delete patch.apiKey;
    await repo.update(id, patch); return this.get(id);
  }
  async remove(id): Promise<void> { await repo.delete(id) }
  async test(id): Promise<TestModelResponse> {
    const row = await repo.findById(id); if (!row) throw new NotFoundException();
    const apiKey = this.enc.decrypt(row.apiKeyEnc);
    // 可观测：best-effort span，失败不影响 test 结果（AGENTS.md 不变量 7 精神）
    return withSpan("model.test_connection", {
      attributes: { "gen_ai.operation.name": row.type === "llm" ? "chat" : row.type, "gen_ai.system": row.provider, "gen_ai.request.model": row.name, "codecrush.span.kind": "tool" }
    }, async () => {
      const r = await this.provider.testConnection({ type: row.type, provider: row.provider, name: row.name, baseUrl: row.baseUrl, apiKey });
      return { ok: r.ok, latencyMs: r.latencyMs, model: r.model, error: r.error };
    });
  }
  private toModelProvider(row: ModelProviderRow): ModelProvider {
    return {
      id: row.id, type: row.type, provider: row.provider, name: row.name,
      baseUrl: row.baseUrl, deploymentId: row.deploymentId ?? undefined,
      role: row.role ?? undefined, enabled: row.enabled,
      apiKeyMasked: this.enc.maskApiKey(this.enc.decrypt(row.apiKeyEnc)),
    };
  }
}
```

- `toModelProvider(row)` 用 `enc.maskApiKey(enc.decrypt(row.apiKeyEnc))`——解密→掩码，不暴露明文。
- list/get 每行解密一次以生成掩码——可接受（≤10 qps、列表通常 <50 行）。若未来量大再加缓存或存掩码冗余列（revisit，非 M3）。

### 8. Controller（扩展）

```ts
@Get() list()
@Get(":id") get()
@Post() @HttpCode(201) create(@Body() CreateModelRequestDto)
@Patch(":id") update(@Body() UpdateModelRequestDto)
@Delete(":id") @HttpCode(204) remove()
@Post(":id/test") @HttpCode(200) test(): TestModelResponse
```

### 9. ModelsModule

```ts
@Module({
  controllers: [ModelsController],
  providers: [
    ModelsRepository,
    ModelsService,
    { provide: MODEL_PROVIDER_PORT, useClass: OpenAiCompatAdapter },
  ],
  exports: [ModelsService, MODEL_PROVIDER_PORT], // M4/M5/M8 消费
})
```

### 10. 前端接通

- `apps/frontend/src/api/client.ts`：补 `updateModel(id, req)`、`deleteModel(id)`、`testModel(id)`（M2 已有 getModels/createModel，确认签名匹配新契约）。
- `apps/frontend/src/pages/admin/ModelsPage.tsx`：
  - `useEffect` 挂载调 `getModels()` → 渲染列表。
  - 类型 enum 对齐：契约小写 `llm/embedding/rerank` ↔ 显示大写 `LLM/Rerank/Embedding`。加 `NODE_LABEL` 映射常量。
  - 抽屉"接入"→ `createModel({type, provider, name, baseUrl, apiKey})`。
  - "测试连接"→ `testModel(id)`，按 `ok` 显示 ✓/✗ + 错误提示。
  - 启用开关 → `updateModel(id, {enabled})`。
  - "编辑"→ 抽屉回填（apiKey 不回填明文，留空表示不改；填了才更新）→ `updateModel`。
  - "删除"→ 确认 → `deleteModel(id)`。
- `apps/frontend/src/mocks/models.ts`：删 `LLM_ROWS`（mock 数据）；保留 `MODEL_TYPES`（UI 常量：provider 列表/baseUrl 默认/参数提示，抽屉 UX 用）；`ModelType` 改为 `z.infer<ModelTypeSchema>` 对齐契约。

## Intent / non-goals / forbidden shortcuts

**Intent（满足任务）**
- 真实 CRUD 持久化到 `model_providers` 表；API Key 加密存库、掩码返回；连通性测试真打外部 API；前端全交互接真后端。

**Non-goals（不做）**
- **不建 `trace.{llm,embeddings,rerank}` 语义封装**——M3 用 `withSpan` 直接打 + 手填 `gen_ai.*`；封装留给 M8（chat 路径首个消费方）。
- **不做 chat/embed/rerank 调用接口**——port 只暴露 `testConnection`；真正的 chat/embed/rerank 调用由 M4（embedding）、M8（chat）扩展 port。
- **不引入 `axios`/`openai` SDK**——用 Node 22 全局 `fetch`。
- **不做 provider→baseUrl 自动推断**——`baseUrl` 必填（D3），用户手填，adapter 直接用。
- **不做 RBAC**（M12）；所有端点保持 `JwtAuthGuard` 保护。
- **不做软删除**——`DELETE` 硬删（greenfield，无历史数据）。

**Forbidden shortcuts（禁止）**
- 不得把明文 apiKey 存库或返回给前端（必须 `enc.encrypt` + `enc.maskApiKey`）。
- 不得软化 `skeleton.e2e.spec.ts` 的 models 断言来"过"测试——改测试体加 apiKey、断言掩码字段，是契约演进的合法更新（非软化）。
- 不得在 e2e 里真打外部 API（DeepSeek/OpenAI）——必须 `overrideProvider(MODEL_PROVIDER_PORT)` 注入 mock。
- 不得为"过测试"跳过 GCM authTag 校验。

## Acceptance criteria

1. `POST /api/models` 提交 `{type, provider, name, baseUrl, apiKey, enabled?}` → 201，响应含 `apiKeyMasked`、**不含**明文 apiKey；DB `model_providers.api_key_enc` 存的是 `enc.encrypt()` 输出（非明文、非掩码）。
2. `GET /api/models` → 200，每项 `apiKeyMasked` 形如 `sk-****cdef`，无明文。
3. `POST /api/models/:id/test` → 真实调用 OpenAI 兼容端点（POST chat/embeddings/rerank 真路径）；成功返回 `{ok:true, latencyMs, model}`，失败返回 `{ok:false, error}`（不抛 500）。
4. `PATCH /api/models/:id` `{enabled:false}` → 200，列表反映开关；`PATCH` 带 `apiKey` → 更新加密密钥。
5. `DELETE /api/models/:id` → 204，列表移除。
6. 前端 `ModelsPage`：接入→测试→开关→编辑→删除 全链路接真后端，无本地 mock 数据残留。
7. `pnpm db:migrate` 生成并应用 `model_providers` 表迁移。
8. `pnpm test` 全绿；`pnpm lint` 0 边界违规；`pnpm build` ok。
9. `.env.example` 含 `MODEL_API_KEY_ENCRYPTION_KEY` 占位 + 生成说明；真值不进 git。
10. OpenAPI `/api/docs-json` 含 `PATCH/DELETE /api/models/{id}` 新端点。

## Test plan

### 新增
- `packages/contracts/src/models.test.ts`（或扩 `m2-schemas.test.ts`）：
  - `CreateModelRequestSchema` 拒绝无 apiKey / apiKey < 8 字符 / 缺 baseUrl。
  - `CreateModelRequestSchema` 接受 `{type:"llm",provider:"DeepSeek",name:"x",baseUrl:"https://a",apiKey:"sk-12345678",enabled:true}`。
  - `ModelProviderSchema` 拒绝含明文 apiKey 字段的响应（response 不得有 apiKey）。
  - `UpdateModelRequestSchema` 全字段 optional。
- `apps/backend/src/platform/security/encryption.spec.ts`：`EncryptionService`（real key）encrypt→decrypt 往返一致；同明文两次加密密文不同（随机 iv）；maskApiKey 边界（<4 全 ****、4-8 `**末2`、>8 `首3****末4`、空串）；错误 key 解密抛错（GCM auth 失败）。
- `apps/backend/src/modules/models/models.service.spec.ts`：mock repo + mock `MODEL_PROVIDER_PORT` + real `EncryptionService`（或 `overrideProvider(ENCRYPTION)` 注入固定 key 实例）；验证 create 调 `enc.encrypt` 后 repo.insert 收到 `apiKeyEnc`（以非明文）、list 返回掩码无明文、test 调 port 并返回其结果、update 带 apiKey 重新加密 / 不带则不改。
- `apps/backend/src/modules/models/openai-compat.adapter.spec.ts`：mock global `fetch`；llm→POST `{baseUrl}/chat/completions` body 含 `max_tokens:1`、2xx → `{ok:true,latencyMs}`、500 → `{ok:false,error}`；embedding→`/embeddings` body `input:"ping"`；rerank→`/rerank` body `query+documents+top_n`；网络错（fetch reject）→ `{ok:false,error}` 不抛。
- `apps/backend/test/models.e2e.spec.ts`（或更新 `skeleton.e2e.spec.ts` 的 models 块）：
  - `overrideProvider(MODEL_PROVIDER_PORT).useValue({ testConnection: async () => ({ok:true, latencyMs:5, model:"gpt-4o"}) })`。
  - `overrideProvider(ModelsRepository).useValue(inMemoryRepo)`（DB-free，对齐 skeleton.e2e 现状）——优先 inMemoryRepo（最小改动）。
  - POST 带 apiKey → 201；GET 列表含掩码无明文；PATCH enabled；DELETE 204；test → `{ok:true}`。

### 更新（非软化）
- `skeleton.e2e.spec.ts:109-120` POST 体加 `apiKey:"sk-test123456"` + `baseUrl`，断言 `res.body.apiKeyMasked` 存在、`res.body.apiKey` 为 undefined。
- `skeleton.e2e.spec.ts:121-127` test 端点：`overrideProvider(MODEL_PROVIDER_PORT)` 注入 mock（否则真打外网）。

### 不破坏
- `m2-schemas.test.ts` 中 `CreateModelRequestSchema` 正反例需更新（契约变了：baseUrl 必填、加 apiKey）。

## Risks / unknowns

1. **e2e DB 策略（已定）**：选 in-memory mock repo（DB-free，对齐 `skeleton.e2e.spec.ts` 现状 + `traces.repository.spec.ts` mock-client 约定——diff D2 验证：该文件实为 mock ClickHouse client，非真 PG，无真 PG repo spec 先例）。真实加密/映射集成验证放 service spec（mock repo + real `EncryptionService`）+ encryption spec（real key）覆盖。drizzle 查询正确性靠 TS 类型推断（Drizzle 从 schema 推列类型，列名拼错编译失败）+ 手动 `pnpm db:migrate` 运行兜底，与 `users.repository` 现状一致。若 M3 后发现 e2e 覆盖不足，再加独立真 PG 集成测试（revisit）。
2. **baseUrl 必填（已定，D3 conceded）**：用户手填，adapter 直接用 `row.baseUrl`，无默认表。未知/自部署 provider 用户填其 baseUrl（正确行为）。
3. **rerank 端点形状**：Cohere `/rerank`、Jina `/rerank`、TEI `/rerank` 三家 payload 字段名略有差异（`documents` vs `texts`、`top_n` vs `topN`）。M3 adapter 用 `{ model, query:"ping", documents:["a"], top_n:1 }`（最通用），404/400 一律视为 `{ok:false}`。完整多 provider 兼容可 M5（检索）消费时再细化——M3 只要"能验活"。
4. **掩码每行解密**：list 每行 decrypt 一次。≤50 行可接受；超大列表加缓存或冗余掩码列（revisit，非 M3）。
5. **trace.llm/embeddings 缺失（已定，D4 一致）**：M3 用 withSpan 手填 `gen_ai.*`；M8 建 `trace.{llm,embeddings,rerank}` 封装时回头统一 M3 的 testConnection span 属性（revisit，记入 004 trace 设计）。

## References

- 路线图：`docs/design/002-implementation-roadmap.md` M3 行（`:86`）
- 代码组织：`docs/design/003-code-organization.md` §端口/适配器落位（`:101`）、§通用 Telemetry SDK（`:220-276`）
- M2 产物：`docs/design/006-m2-app-shell-skeleton.md`；M2 dev-ledger Story 3（后端 skeleton）
- 同类范式：`apps/backend/src/modules/users/{schema,users.repository,users.service,users.controller,users.module}.ts`
- 原型：`CodeCrushBot.dc.html`（模型接入页）
