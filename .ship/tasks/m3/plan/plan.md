# M3 Plan — 模型接入（Model Integration）

> 基于 diff 后的 `spec.md`。轻量对抗模式（CLAUDE.md）：跳过 execution drill，host 自查代替。
> 7 个 story，按依赖顺序。每个 story 内 TDD（先红后绿）。`pnpm test` + `pnpm lint` 每个 story 收尾必跑。
> 基线分支：`design/m3-m6` @ `feat/m2-app-shell` (75e9b61)。

---

## Story 1 — 契约修订（contracts/models.ts）+ 测试

> 前后端单一来源。写侧加明文 `apiKey`、读侧保 `apiKeyMasked`、`baseUrl` 必填、补 `deploymentId`、新增 `UpdateModelRequestSchema` / `TestModelResponseSchema`。后端 skeleton 与前端 mock 都依赖它，最先做。

### 步骤

- [ ] **红**：改 `packages/contracts/src/m2-schemas.test.ts`：
  - `valid.model` 加 `deploymentId: "dep-1"`（对齐新 schema 可选字段）。
  - 新增 `valid.createModelReq = { type:"llm", provider:"DeepSeek", name:"deepseek-v3", baseUrl:"https://api.deepseek.com", apiKey:"sk-12345678", enabled:true }`。
  - 正例："CreateModelRequestSchema accepts valid req" → `expect(CreateModelRequestSchema.parse(valid.createModelReq).apiKey).toBe("sk-12345678")`。
  - 反例："CreateModelRequestSchema rejects missing apiKey / short apiKey / missing baseUrl"：
    ```ts
    expect(() => CreateModelRequestSchema.parse({ ...valid.createModelReq, apiKey: "sk-1" })).toThrow(); // <8
    expect(() => CreateModelRequestSchema.parse({ ...valid.createModelReq, apiKey: undefined })).toThrow();
    expect(() => CreateModelRequestSchema.parse({ ...valid.createModelReq, baseUrl: undefined })).toThrow();
    expect(() => CreateModelRequestSchema.parse({ ...valid.createModelReq, baseUrl: "not-a-url" })).toThrow();
    ```
  - 反例："ModelProviderSchema rejects plaintext apiKey field in response"——构造含 `apiKey:"sk-..."` 的对象，断言 `parse` 后 `apiKey` 为 undefined（zod 默认 strip，但显式断言防止后续误加字段）：`expect((ModelProviderSchema.parse({ ...valid.model, apiKey: "sk-plaintext" }) as Record<string, unknown>).apiKey).toBeUndefined()`。
  - "UpdateModelRequestSchema is partial"：`expect(UpdateModelRequestSchema.parse({ enabled: false }).enabled).toBe(false)` + `expect(UpdateModelRequestSchema.parse({}).apiKey).toBeUndefined()`。
  - 改现有 "CreateModelRequestSchema omits id, keeps enabled" 用例（L268-273）：`rest` 改用 `valid.createModelReq`（不再从 `valid.model` omit，因 `valid.model` 含 `apiKeyMasked` 不含 `apiKey`），断言 `.apiKey` 存在 + `.apiKeyMasked` undefined。
  - 先跑应失败（schema 未改）。
- [ ] **绿**：改 `packages/contracts/src/models.ts`：
  ```ts
  import { z } from "zod";

  export const ModelTypeSchema = z.enum(["llm", "embedding", "rerank"]);
  export type ModelType = z.infer<typeof ModelTypeSchema>;

  export const ModelProviderSchema = z.object({
    id: z.string().min(1),
    type: ModelTypeSchema,
    provider: z.string().min(1),
    name: z.string().min(1),
    baseUrl: z.string().url(),
    apiKeyMasked: z.string().optional(),
    deploymentId: z.string().optional(),
    role: z.string().optional(),
    enabled: z.boolean(),
  });
  export type ModelProvider = z.infer<typeof ModelProviderSchema>;

  export const ModelProviderListResponseSchema = z.array(ModelProviderSchema);
  export type ModelProviderListResponse = z.infer<typeof ModelProviderListResponseSchema>;

  // 写侧：明文 apiKey（min 8 防误填），不含 apiKeyMasked / id
  export const CreateModelRequestSchema = ModelProviderSchema.omit({
    id: true,
    apiKeyMasked: true,
  }).extend({ apiKey: z.string().min(8) });
  export type CreateModelRequest = z.infer<typeof CreateModelRequestSchema>;

  // PATCH：全可选；apiKey 不传则不改
  export const UpdateModelRequestSchema = CreateModelRequestSchema.partial();
  export type UpdateModelRequest = z.infer<typeof UpdateModelRequestSchema>;

  export const TestModelResponseSchema = z.object({
    ok: z.boolean(),
    latencyMs: z.number().int().nonnegative().optional(),
    model: z.string().optional(),
    error: z.string().optional(),
  });
  export type TestModelResponse = z.infer<typeof TestModelResponseSchema>;
  ```
- [ ] **绿**：`pnpm --filter @codecrush/contracts test` 全绿。
- [ ] **绿**：`pnpm --filter @codecrush/contracts build` 成功（后端/前端能 import）。
- [ ] 提交：`feat(contracts): evolve model schemas for M3 — plaintext apiKey write, masked read, deploymentId, update/test schemas`

**验证**：`pnpm lint` 0 违规（contracts 无平台依赖，只依赖 zod）。新反例覆盖 apiKey 长度/url/缺失。

---

## Story 2 — 加密服务 + SecurityModule + env/config + app.module 接线

> AES-256-GCM `EncryptionService`（backend-only，Node crypto）+ `SecurityModule`（@Global，对齐 PersistenceModule/ClickHouseModule 约定）+ env fail-fast + app.module 显式注册。可测（`overrideProvider(ENCRYPTION)`）+ API 干净。

### 步骤

- [ ] **红**：写 `apps/backend/src/platform/security/encryption.spec.ts`：
  ```ts
  import { EncryptionService } from "./encryption";

  // 32 字节 base64 = 44 字符（openssl rand -base64 32 输出）
  const KEY = Buffer.from("a".repeat(32)).toString("base64");
  const svc = new EncryptionService(KEY);

  describe("EncryptionService", () => {
    it("encrypt → decrypt 往返一致", () => {
      const enc = svc.encrypt("sk-deepseek-abcdef");
      expect(svc.decrypt(enc)).toBe("sk-deepseek-abcdef");
    });
    it("同明文两次加密密文不同（随机 iv）", () => {
      expect(svc.encrypt("sk-x")).not.toBe(svc.encrypt("sk-x"));
    });
    it("密文是 base64（非明文、非掩码）", () => {
      const enc = svc.encrypt("sk-deepseek-abcdef");
      expect(enc).not.toContain("sk-deepseek");
      expect(() => Buffer.from(enc, "base64")).not.toThrow();
    });
    it("maskApiKey 边界", () => {
      expect(svc.maskApiKey("")).toBe("****");
      expect(svc.maskApiKey("ab")).toBe("****"); // <4
      expect(svc.maskApiKey("abcd")).toBe("**cd"); // 4-8
      expect(svc.maskApiKey("abcdefgh")).toBe("**gh"); // =8
      expect(svc.maskApiKey("sk-deepseek-abcdef")).toBe("sk-****abcdef"); // >8
    });
    it("错误 key 解密抛错（GCM auth 失败）", () => {
      const other = new EncryptionService(Buffer.from("b".repeat(32)).toString("base64"));
      const enc = svc.encrypt("sk-x");
      expect(() => other.decrypt(enc)).toThrow();
    });
    it("密文被篡改抛错", () => {
      const enc = svc.encrypt("sk-x");
      const tampered = enc.slice(0, -2) + "AA";
      expect(() => svc.decrypt(tampered)).toThrow();
    });
  });
  ```
- [ ] **绿**：写 `apps/backend/src/platform/security/encryption.ts`（spec §2 完整代码，逐字照搬）：
  ```ts
  import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
  import { Injectable } from "@nestjs/common";

  @Injectable()
  export class EncryptionService {
    constructor(private readonly masterKeyB64: string) {}

    private get key(): Buffer {
      return Buffer.from(this.masterKeyB64, "base64");
    }

    encrypt(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]).toString("base64");
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

    maskApiKey(plaintext: string): string {
      if (plaintext.length < 4) return "****";
      if (plaintext.length <= 8) return `**${plaintext.slice(-2)}`;
      return `${plaintext.slice(0, 3)}****${plaintext.slice(-4)}`;
    }
  }
  ```
- [ ] **绿**：写 `apps/backend/src/platform/security/security.constants.ts`：
  ```ts
  export const ENCRYPTION = Symbol("ENCRYPTION");
  ```
- [ ] **绿**：写 `apps/backend/src/platform/security/security.module.ts`（spec §2 完整代码）：
  ```ts
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
- [ ] 改 `apps/backend/src/platform/config/config.schema.ts`：envSchema 追加 `MODEL_API_KEY_ENCRYPTION_KEY: z.string().min(44)`（32 字节 base64 = 44 字符；fail-fast：缺/过短启动崩）。
- [ ] 改 `apps/backend/src/platform/config/config.service.ts`：追加 getter
  ```ts
  get modelApiKeyEncryptionKey(): string {
    return this.config.get("MODEL_API_KEY_ENCRYPTION_KEY", { infer: true });
  }
  ```
- [ ] 改 `apps/backend/.env.example`：追加 `MODEL_API_KEY_ENCRYPTION_KEY=` + 注释 `# 生成：openssl rand -base64 32（32 字节 base64 = 44 字符）`。
- [ ] 改 `apps/backend/src/app.module.ts`：imports 紧挨 `ClickHouseModule` 加 `SecurityModule`（@Global platform 模块须在 root imports 触发 provider 注册——D14）。
- [ ] 改 `apps/backend/test/jest.config.e2e`（若 e2e 用独立 env 注入）或 `apps/backend/test/setup-env.ts`（若有）：确保测试环境注入 `MODEL_API_KEY_ENCRYPTION_KEY`。若无统一 setup，在 `skeleton.e2e.spec.ts` 的 `beforeAll` 内 `process.env.MODEL_API_KEY_ENCRYPTION_KEY = Buffer.from("a".repeat(32)).toString("base64")` 临时注入（envSchema 在 AppConfigService 构造时校验，需在 TestingModule compile 前设）。**优先**：检查 `apps/backend/test/` 是否有全局 env setup 文件；若有则改它，避免每个 e2e 重复。
- [ ] **绿**：`pnpm --filter @codecrush/backend test` 全绿（含 encryption.spec.ts）。
- [ ] 提交：`feat(backend): add AES-256-GCM EncryptionService + SecurityModule with env fail-fast`

**验证**：`maskApiKey("sk-deepseek-abcdef")` === `"sk-****abcdef"`；encrypt 输出非明文；错误 key 解密抛错。`pnpm lint` 0 违规（SecurityModule 在 platform 层，依赖朝下）。

---

## Story 3 — DB schema + 迁移（model_providers 表）

> 真实持久化的地基。列名对齐 001:81（`api_key_enc` / `deployment_id`）。

### 步骤

- [ ] 写 `apps/backend/src/modules/models/schema.ts`（spec §4 完整代码）：
  ```ts
  import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

  export const modelProviders = pgTable("model_providers", {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEnc: text("api_key_enc").notNull(),
    deploymentId: text("deployment_id"),
    role: text("role"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  });
  export type ModelProviderRow = typeof modelProviders.$inferSelect;
  export type NewModelProvider = typeof modelProviders.$inferInsert;
  ```
  **域内 schema 零 service 引用（003 不变量 5/AGENTS.md 不变量 8）。**
- [ ] 改 `apps/backend/src/db/schema.ts` barrel：追加 `export * from "../modules/models/schema";`。
- [ ] 生成迁移：`pnpm db:generate` → 生成 `apps/backend/drizzle/<ts>_*.sql`，内容含 `CREATE TABLE "model_providers" (...)`。人工 review SQL（列名 `api_key_enc` / `base_url` / `deployment_id` 正确，`enabled` 默认 `true`）。
- [ ] 启动依赖并应用迁移：
  ```bash
  docker compose -f infra/docker-compose.yml --profile infra up -d --wait
  pnpm db:migrate
  ```
  验证控制台无错误。
- [ ] **验证 TS**：`pnpm --filter @codecrush/backend exec tsc --noEmit` 0 错误（Drizzle 从 schema 推列类型，列名拼错编译失败）。
- [ ] 提交：`feat(backend): add model_providers table schema + migration`

**验证**：`psql` 或 `docker compose exec postgres psql -U postgres -d codecrush -c '\d model_providers'` 显示表结构含 `api_key_enc` / `base_url` / `deployment_id`。

---

## Story 4 — ModelProviderPort + OpenAiCompatAdapter + 测试

> 端口/适配器（003 §端口/适配器落位）。port 仅暴露 `testConnection`（chat/embed/rerank 留 M4/M8）。adapter 用 Node 22 全局 `fetch`，POST 真路径验 model name 可用，失败统一 `{ok:false}` 不抛。

### 步骤

- [ ] **红**：写 `apps/backend/src/modules/models/openai-compat.adapter.spec.ts`：mock 全局 `fetch`（`vi.stubGlobal("fetch", vi.fn())` 或 jest 默认 `global.fetch = jest.fn()`）；每个用例后 `jest.restoreAllMocks()`。
  ```ts
  import { OpenAiCompatAdapter } from "./openai-compat.adapter";

  const adapter = new OpenAiCompatAdapter();
  const baseConfig = {
    type: "llm" as const,
    provider: "DeepSeek",
    name: "deepseek-v3",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-x",
  };

  function mockFetch(ok: boolean, body: unknown, status = 200) {
    const fetchMock = jest.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response);
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  describe("OpenAiCompatAdapter.testConnection", () => {
    afterEach(() => jest.restoreAllMocks());

    it("llm → POST {baseUrl}/chat/completions with max_tokens:1, 2xx → {ok:true}", async () => {
      const fm = mockFetch(true, { choices: [{ message: { content: "hi" } }] });
      const r = await adapter.testConnection(baseConfig);
      expect(r.ok).toBe(true);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      expect(fm).toHaveBeenCalledTimes(1);
      const [url, init] = fm.mock.calls[0];
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.model).toBe("deepseek-v3");
      expect(body.max_tokens).toBe(1);
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer sk-x",
        "Content-Type": "application/json",
      });
    });

    it("embedding → POST /embeddings with input:'ping'", async () => {
      const fm = mockFetch(true, { data: [{ embedding: [0.1] }] });
      const r = await adapter.testConnection({ ...baseConfig, type: "embedding" });
      expect(r.ok).toBe(true);
      const [url, init] = fm.mock.calls[0];
      expect(url).toBe("https://api.deepseek.com/embeddings");
      expect(JSON.parse((init as RequestInit).body as string).input).toBe("ping");
    });

    it("rerank → POST /rerank with query+documents+top_n", async () => {
      const fm = mockFetch(true, { results: [{ index: 0, relevance_score: 0.9 }] });
      const r = await adapter.testConnection({ ...baseConfig, type: "rerank" });
      expect(r.ok).toBe(true);
      const [url, init] = fm.mock.calls[0];
      expect(url).toBe("https://api.deepseek.com/rerank");
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.query).toBe("ping");
      expect(body.documents).toEqual(["a"]);
      expect(body.top_n).toBe(1);
    });

    it("HTTP 500 → {ok:false, error}", async () => {
      mockFetch(false, { error: "boom" }, 500);
      const r = await adapter.testConnection(baseConfig);
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    });

    it("网络错（fetch reject）→ {ok:false, error} 不抛", async () => {
      (global as { fetch: typeof fetch }).fetch = jest
        .fn()
        .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
      const r = await adapter.testConnection(baseConfig);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("ECONNREFUSED");
    });

    it("超时 10s → {ok:false, error:'timeout'}", async () => {
      jest.useFakeTimers();
      (global as { fetch: typeof fetch }).fetch = jest.fn().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const sig = (init as RequestInit | undefined)?.signal;
            sig?.addEventListener("abort", () => reject(new Error("timeout")));
          }),
      ) as unknown as typeof fetch;
      const promise = adapter.testConnection(baseConfig);
      jest.advanceTimersByTime(10000);
      const r = await promise;
      expect(r.ok).toBe(false);
      expect(r.error).toContain("timeout");
      jest.useRealTimers();
    });
  });
  ```
  先跑应失败（adapter 未写）。
- [ ] **绿**：写 `apps/backend/src/modules/models/ports/model-provider.port.ts`（spec §6）：
  ```ts
  import type { ModelType } from "@codecrush/contracts";

  export interface ModelCallConfig {
    type: ModelType;
    provider: string;
    name: string;
    baseUrl: string;
    apiKey: string;
  }
  export interface TestModelResult {
    ok: boolean;
    latencyMs?: number;
    model?: string;
    error?: string;
  }
  export interface ModelProviderPort {
    testConnection(config: ModelCallConfig): Promise<TestModelResult>;
  }
  ```
- [ ] **绿**：写 `apps/backend/src/modules/models/model-provider.constants.ts`：
  ```ts
  export const MODEL_PROVIDER_PORT = Symbol("MODEL_PROVIDER_PORT");
  ```
- [ ] **绿**：写 `apps/backend/src/modules/models/adapters/openai-compat.adapter.ts`：
  ```ts
  import { Injectable } from "@nestjs/common";
  import type { ModelCallConfig, TestModelResult } from "../ports/model-provider.port";

  @Injectable()
  export class OpenAiCompatAdapter implements ModelProviderPortLike {
    async testConnection(config: ModelCallConfig): Promise<TestModelResult> {
      const t0 = Date.now();
      try {
        if (config.type === "rerank") return await this.testRerank(config);
        if (config.type === "embedding") return await this.testEmbedding(config);
        return await this.testChat(config);
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, error: errMsg(e) };
      }
    }

    private async call(
      config: ModelCallConfig,
      path: string,
      payload: Record<string, unknown>,
    ): Promise<TestModelResult> {
      const t0 = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const url = `${trimSlash(config.baseUrl)}/${path}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: config.name, ...payload }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await safeText(resp);
          return { ok: false, latencyMs: Date.now() - t0, error: `HTTP ${resp.status}: ${text}` };
        }
        return { ok: true, latencyMs: Date.now() - t0, model: config.name };
      } finally {
        clearTimeout(timer);
      }
    }

    private async testChat(c: ModelCallConfig): Promise<TestModelResult> {
      return this.call(c, "chat/completions", {
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
    }
    private async testEmbedding(c: ModelCallConfig): Promise<TestModelResult> {
      return this.call(c, "embeddings", { input: "ping" });
    }
    private async testRerank(c: ModelCallConfig): Promise<TestModelResult> {
      return this.call(c, "rerank", { query: "ping", documents: ["a"], top_n: 1 });
    }
  }

  // 接口实现：用结构类型对齐 ModelProviderPort（避免 import 循环）
  import type { ModelProviderPort } from "../ports/model-provider.port";
  interface ModelProviderPortLike extends ModelProviderPort {}
  ```

  **简化（去冗余）**：上面 `ModelProviderPortLike` 间接层是给示例用的；实际直接 `implements ModelProviderPort` 即可：
  ```ts
  import type { ModelCallConfig, ModelProviderPort, TestModelResult } from "./ports/model-provider.port";

  @Injectable()
  export class OpenAiCompatAdapter implements ModelProviderPort {
    // ... 同上 testConnection / call / testChat / testEmbedding / testRerank
  }
  ```
  路径相应调整（`./ports/model-provider.port`）。**实现时用这版，去掉 ModelProviderPortLike**。
- [ ] 写 `apps/backend/src/modules/models/adapters/util.ts`（小工具，避免 adapter 臃肿）：
  ```ts
  export function trimSlash(s: string): string {
    return s.endsWith("/") ? s.slice(0, -1) : s;
  }
  export function errMsg(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
  }
  export async function safeText(resp: Response): Promise<string> {
    try {
      return await resp.text();
    } catch {
      return "";
    }
  }
  ```
  adapter import `{ trimSlash, errMsg, safeText }` from `"./util"`。
- [ ] **绿**：`pnpm --filter @codecrush/backend test` 全绿（含 adapter spec）。
- [ ] 提交：`feat(backend): add ModelProviderPort + OpenAiCompatAdapter with real-path connectivity test`

**验证**：`pnpm lint` 0 违规（adapter 在域内，import contracts + Node 全局 fetch，无平台违规）。adapter 不引 axios/openai SDK。

---

## Story 5 — ModelsRepository + ModelsService 重写 + Controller 扩展 + Module 接线 + e2e

> 全链路接通：repo 持久化、service 加解密 + 掩码 + 调 port、controller PATCH/DELETE、module 注入 port。

### 步骤

- [ ] 写 `apps/backend/src/modules/models/models.repository.ts`（照搬 users.repository.ts 模式）：
  ```ts
  import { Inject, Injectable } from "@nestjs/common";
  import { eq } from "drizzle-orm";
  import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
  import type { DB } from "../../platform/persistence/persistence.module";
  import { modelProviders, type ModelProviderRow, type NewModelProvider } from "./schema";

  @Injectable()
  export class ModelsRepository {
    constructor(@Inject(DRIZZLE) private readonly db: DB) {}

    async find(): Promise<ModelProviderRow[]> {
      return await this.db.select().from(modelProviders);
    }
    async findById(id: string): Promise<ModelProviderRow | undefined> {
      const rows = await this.db
        .select()
        .from(modelProviders)
        .where(eq(modelProviders.id, id))
        .limit(1);
      return rows[0];
    }
    async insert(row: NewModelProvider): Promise<ModelProviderRow> {
      const rows = await this.db.insert(modelProviders).values(row).returning();
      return rows[0];
    }
    async update(id: string, patch: Partial<NewModelProvider>): Promise<void> {
      await this.db
        .update(modelProviders)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(modelProviders.id, id));
    }
    async delete(id: string): Promise<void> {
      await this.db.delete(modelProviders).where(eq(modelProviders.id, id));
    }
  }
  ```
- [ ] **红**：写 `apps/backend/src/modules/models/models.service.spec.ts`：mock repo + mock `MODEL_PROVIDER_PORT` + real `EncryptionService`（注入固定 key 实例，不走 SecurityModule useFactory）。
  ```ts
  import { NotFoundException } from "@nestjs/common";
  import { EncryptionService } from "../../platform/security/encryption";
  { /* mock repo via jest.fn() */ }
  ```
  用例：
  - "create → enc.encrypt 后 repo.insert 收到 apiKeyEnc（非明文）"：断言 `repo.insert` 收到 `apiKeyEnc` 且不含原 apiKey 明文 + 不含 `apiKey` 字段。
  - "list → 返回掩码无明文"：每项 `apiKeyMasked` 形如 `sk-****...`、`apiKey` undefined。
  - "test → 调 port 并返回其结果"：mock port `testConnection` 返 `{ok:true, latencyMs:5, model:"x"}`，断言 service.test 返同样。
  - "update 带 apiKey → 重新加密；不带 → 不改 key"：传 `{apiKey:"sk-new123"}` 断言 `repo.update` 收到 `apiKeyEnc`（非明文）；传 `{enabled:false}` 断言 patch 不含 `apiKeyEnc`。
  - "get 不存在 → NotFoundException"。
  - "toModelProvider 解密→掩码"：注入 repo 返回固定 row（apiKeyEnc = enc.encrypt("sk-deepseek-abcdef")），断言 list 结果 `apiKeyMasked === "sk-****abcdef"`。
  先跑应失败（service 未改）。
- [ ] **绿**：改 `apps/backend/src/modules/models/models.service.ts`（spec §7 完整代码，逐字照搬）：
  ```ts
  import { Inject, Injectable, NotFoundException } from "@nestjs/common";
  import type {
    CreateModelRequest,
    ModelProvider,
    TestModelResponse,
    UpdateModelRequest,
  } from "@codecrush/contracts";
  import { withSpan } from "@codecrush/otel";
  import { ENCRYPTION } from "../../platform/security/security.constants";
  import { EncryptionService } from "../../platform/security/encryption";
  import { ModelsRepository } from "./models.repository";
  import { MODEL_PROVIDER_PORT } from "./model-provider.constants";
  import type { ModelProviderPort } from "./ports/model-provider.port";

  @Injectable()
  export class ModelsService {
    constructor(
      private readonly repo: ModelsRepository,
      @Inject(ENCRYPTION) private readonly enc: EncryptionService,
      @Inject(MODEL_PROVIDER_PORT) private readonly provider: ModelProviderPort,
    ) {}

    async list(): Promise<ModelProvider[]> {
      return (await this.repo.find()).map((r) => this.toModelProvider(r));
    }
    async get(id: string): Promise<ModelProvider> {
      const r = await this.repo.findById(id);
      if (!r) throw new NotFoundException(`model ${id} not found`);
      return this.toModelProvider(r);
    }
    async create(req: CreateModelRequest): Promise<ModelProvider> {
      const apiKeyEnc = this.enc.encrypt(req.apiKey);
      const { apiKey: _apiKey, ...rest } = req;
      void _apiKey;
      const row = await this.repo.insert({ ...rest, apiKeyEnc });
      return this.toModelProvider(row);
    }
    async update(id: string, req: UpdateModelRequest): Promise<ModelProvider> {
      const patch: Record<string, unknown> = { ...req };
      if (req.apiKey) patch.apiKeyEnc = this.enc.encrypt(req.apiKey);
      delete patch.apiKey;
      await this.repo.update(id, patch);
      return this.get(id);
    }
    async remove(id: string): Promise<void> {
      await this.repo.delete(id);
    }
    async test(id: string): Promise<TestModelResponse> {
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundException(`model ${id} not found`);
      const apiKey = this.enc.decrypt(row.apiKeyEnc);
      return withSpan(
        "model.test_connection",
        {
          attributes: {
            "gen_ai.operation.name": row.type === "llm" ? "chat" : row.type,
            "gen_ai.system": row.provider,
            "gen_ai.request.model": row.name,
            "codecrush.span.kind": "tool",
          },
        },
        async () => {
          const r = await this.provider.testConnection({
            type: row.type,
            provider: row.provider,
            name: row.name,
            baseUrl: row.baseUrl,
            apiKey,
          });
          return { ok: r.ok, latencyMs: r.latencyMs, model: r.model, error: r.error };
        },
      );
    }
    private toModelProvider(row: ModelProviderRow): ModelProvider {
      return {
        id: row.id,
        type: row.type,
        provider: row.provider,
        name: row.name,
        baseUrl: row.baseUrl,
        deploymentId: row.deploymentId ?? undefined,
        role: row.role ?? undefined,
        enabled: row.enabled,
        apiKeyMasked: this.enc.maskApiKey(this.enc.decrypt(row.apiKeyEnc)),
      };
    }
  }
  ```
- [ ] 改 `apps/backend/src/modules/models/models.controller.ts`（扩展 PATCH/DELETE/test 返回类型）：
  ```ts
  import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
  import { createZodDto } from "nestjs-zod";
  import {
    CreateModelRequestSchema,
    type ModelProvider,
    TestModelResponseSchema,
    type TestModelResponse,
    UpdateModelRequestSchema,
  } from "@codecrush/contracts";
  import { z } from "zod";
  import { ModelsService } from "./models.service";

  class CreateModelRequestDto extends createZodDto(CreateModelRequestSchema) {}
  class UpdateModelRequestDto extends createZodDto(UpdateModelRequestSchema) {}
  // test 端点响应 schema（OpenAPI 用）
  const TestModelResponseDto = createZodDto(TestModelResponseSchema);

  @Controller("models")
  export class ModelsController {
    constructor(private readonly modelsService: ModelsService) {}

    @Get()
    list(): Promise<ModelProvider[]> {
      return this.modelsService.list();
    }

    @Get(":id")
    get(@Param("id") id: string): Promise<ModelProvider> {
      return this.modelsService.get(id);
    }

    @Post()
    @HttpCode(201)
    create(@Body() body: CreateModelRequestDto): Promise<ModelProvider> {
      return this.modelsService.create(body);
    }

    @Patch(":id")
    update(@Param("id") id: string, @Body() body: UpdateModelRequestDto): Promise<ModelProvider> {
      return this.modelsService.update(id, body);
    }

    @Delete(":id")
    @HttpCode(204)
    async remove(@Param("id") id: string): Promise<void> {
      await this.modelsService.remove(id);
    }

    @Post(":id/test")
    @HttpCode(200)
    test(@Param("id") id: string): Promise<TestModelResponse> {
      return this.modelsService.test(id);
    }
  }
  ```
  **注意**：`TestModelResponseDto` 若 nestjs-zod 不需在 controller 直接引用可省略；保留为 OpenAPI 元数据用（若 `setupSwagger` 自动扫描需 DTO 类）。如 lint 报 unused，删之并依赖 schema 直接导出。`z` import 若 unused 删之。
- [ ] 改 `apps/backend/src/modules/models/models.module.ts`（注入 port + 导出供 M4/M5/M8）：
  ```ts
  import { Module } from "@nestjs/common";
  import { ModelsController } from "./models.controller";
  import { ModelsService } from "./models.service";
  import { ModelsRepository } from "./models.repository";
  import { MODEL_PROVIDER_PORT } from "./model-provider.constants";
  import { OpenAiCompatAdapter } from "./adapters/openai-compat.adapter";

  @Module({
    controllers: [ModelsController],
    providers: [
      ModelsRepository,
      ModelsService,
      { provide: MODEL_PROVIDER_PORT, useClass: OpenAiCompatAdapter },
    ],
    exports: [ModelsService, MODEL_PROVIDER_PORT],
  })
  export class ModelsModule {}
  ```
- [ ] **红**：改 `apps/backend/test/skeleton.e2e.spec.ts` models 块（非软化，是契约演进的合法更新）：
  - TestingModule `providers` 追加 `overrideProvider(ModelsRepository).useValue(inMemoryRepo)` + `overrideProvider(MODEL_PROVIDER_PORT).useValue({ testConnection: async () => ({ ok: true, latencyMs: 5, model: "gpt-4o" }) })`。或保留 `ModelsModule` 并在其后 `.overrideProvider(...)` 链式调用。
  - inMemoryRepo（DB-free，对齐 skeleton.e2e 现状 + traces.repository.spec mock-client 约定）：
    ```ts
    const inMemoryModels: ModelProviderRow[] = [];
    const inMemoryRepo = {
      find: async () => inMemoryModels,
      findById: async (id: string) => inMemoryModels.find((r) => r.id === id),
      insert: async (row: NewModelProvider) => {
        const row2 = { id: `m${inMemoryModels.length + 1}`, ...row, createdAt: new Date(), updatedAt: new Date() } as ModelProviderRow;
        inMemoryModels.push(row2);
        return row2;
      },
      update: async (id: string, patch: Partial<NewModelProvider>) => {
        const r = inMemoryModels.find((x) => x.id === id);
        if (r) Object.assign(r, patch, { updatedAt: new Date() });
      },
      delete: async (id: string) => {
        const i = inMemoryModels.findIndex((x) => x.id === id);
        if (i >= 0) inMemoryModels.splice(i, 1);
      },
    };
    ```
  - 改 "GET /api/models → 200" 用例（L99-104）：不再断言 `length > 0`（inMemoryRepo 起空），改为 `expect(Array.isArray(res.body)).toBe(true)`。**或** 在 beforeAll 内 seed 一条（POST create 一条）使列表非空——选后者保语义。**决策**：在 models 块 `beforeAll` 或首个用例内先 POST 创建一条，保留 `length > 0` 断言强度。
  - 改 "POST /api/models → 201"（L109-120）：body 加 `baseUrl` + `apiKey`：
    ```ts
    .send({
      type: "llm",
      provider: "OpenAI",
      name: "gpt-4o",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test123456",
      enabled: true,
    })
    .expect(201);
    ```
    断言追加：`expect(res.body.apiKeyMasked).toMatch(/^\*{2}|sk-\*{4}/); expect((res.body as Record<string, unknown>).apiKey).toBeUndefined();`
  - 改 "POST /api/models/m1/test"（L121-127）：mock port 已注入，断言 `expect(res.body).toEqual({ ok: true, latencyMs: 5, model: "gpt-4o" })`（对齐 mock 返回）。
  - 新增："PATCH /api/models/:id → 200 + enabled 切换"：先 POST 创建，再 PATCH `{enabled:false}`，再 GET 列表断言该项 enabled===false。
  - 新增："DELETE /api/models/:id → 204 + 列表移除"：先 POST 创建，DELETE，GET 列表断言不含该 id。
  - 新增："PATCH 带 apiKey → 更新加密 key（掩码变化）"：POST → 记录 apiKeyMasked → PATCH `{apiKey:"sk-newkey123"}` → GET 断言 apiKeyMasked 变化（掩码末 4 位变）。
  - 新增："test 端点不真打外网"（防回归）：mock port 已注入，断言 `fetch` 未被调用（无需断言，mock port 本就不调 fetch；但保留该 mock 防止未来误删 override）。
  - **注意**：TestingModule 需注入 `ENCRYPTION` token（真 EncryptionService + 固定 key），否则 ModelsService 注入失败。在 `overrideProvider(ENCRYPTION).useValue(new EncryptionService(Buffer.from("a".repeat(32)).toString("base64")))` 或依赖 SecurityModule（若 app.module 已加且 env 已设）。**优先**：`overrideProvider(ENCRYPTION).useValue(...)` 显式注入固定 key，避免依赖 env。
  先跑应失败（service/repo 未接 / 测试体旧）。
- [ ] **绿**：`pnpm --filter @codecrush/backend test` 全绿（含 service spec + e2e models 块）。
- [ ] **绿**：`curl http://localhost:3000/api/docs-json | jq '.paths | keys'` 含 `/api/models/{id}` PATCH/DELETE。
- [ ] 提交：`feat(backend): wire ModelsService with encryption + port/adapter, add PATCH/DELETE endpoints`

**验证**：AC 1-5 满足。`pnpm lint` 0 边界违规（ModelsRepository 在域内 import platform DRIZZLE，依赖朝下；adapter import contracts）。

---

## Story 6 — 前端接通（client + ModelsPage + mocks 清理）

> ModelsPage 从本地 mock 切到真后端。接入→测试→开关→编辑→删除全链路。

### 步骤

- [ ] **红**：改 `apps/frontend/src/api/client.ts`，补 typed client：
  ```ts
  import {
    // ... 现有 imports
    CreateModelRequestSchema,
    type CreateModelRequest,
    ModelProviderSchema,
    type ModelProvider,
    TestModelResponseSchema,
    type TestModelResponse,
    UpdateModelRequestSchema,
    type UpdateModelRequest,
  } from "@codecrush/contracts";

  // models — @Controller("models")
  export const getModels = (): Promise<ModelProviderListResponse> =>
    getJson("/api/models", ModelProviderListResponseSchema);

  export async function createModel(req: CreateModelRequest): Promise<ModelProvider> {
    return postJson("/api/models", req, CreateModelRequestSchema, ModelProviderSchema);
  }

  export async function updateModel(id: string, req: UpdateModelRequest): Promise<ModelProvider> {
    const resp = await apiFetch(`/api/models/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(UpdateModelRequestSchema.parse(req)),
    });
    if (!resp.ok) throw new Error(`updateModel failed: ${resp.status}`);
    return ModelProviderSchema.parse(await resp.json());
  }

  export async function deleteModel(id: string): Promise<void> {
    const resp = await apiFetch(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!resp.ok && resp.status !== 204) throw new Error(`deleteModel failed: ${resp.status}`);
  }

  export async function testModel(id: string): Promise<TestModelResponse> {
    const resp = await apiFetch(`/api/models/${encodeURIComponent(id)}/test`, { method: "POST" });
    if (!resp.ok) throw new Error(`testModel failed: ${resp.status}`);
    return TestModelResponseSchema.parse(await resp.json());
  }
  ```
  写 `apps/frontend/src/api/client.test.ts`（若存在）扩用例：mock fetch，断言 `createModel` 走 POST + body 含 apiKey、`testModel` 返 TestModelResponse。若无 client.test.ts，跳过（页面测试覆盖）。
- [ ] **红**：扩 `apps/frontend/src/app/App.test.tsx`（或 ModelsPage 专属测试）：mock `apiFetch`/`getModels` 返空数组，断言 ModelsPage 挂载调 `getModels()`（不爆）。先跑应失败（页面仍用本地 mock）。
- [ ] **绿**：改 `apps/frontend/src/mocks/models.ts`：
  - 删 `LLM_ROWS`（mock 数据，不再用）。
  - 保留 `MODEL_TYPES`（UI 常量：provider 列表 / baseUrl 默认 / 参数提示，抽屉 UX 用）。
  - `ModelType` 改为 `z.infer<ModelTypeSchema>` 对齐契约小写 enum；加 `TYPE_LABEL: Record<ModelType, string>` 映射 `llm→"LLM", embedding→"Embedding", rerank→"Rerank"`（显示用）。
  - `ModelDraft` 表单类型保留（type/prov/name/base/key），用于抽屉表单。
- [ ] **绿**：改 `apps/frontend/src/pages/admin/ModelsPage.tsx`：
  - `useEffect(() => { getModels().then(setRows).catch(...) }, [])` 挂载调真 API。
  - `useState(LLM_ROWS)` → `useState<ModelProvider[]>([])`。
  - 类型 enum 对齐：渲染用 `TYPE_LABEL[r.type]` 显示大写。
  - 抽屉"接入"→ `createModel({type, provider, name, baseUrl, apiKey, enabled: true})`，成功后 `setRows(prev => [...prev, m])` 或重新 `getModels()`。
  - "测试连接"→ `testModel(id)`，按 `ok` 显示 ✓/✗ + `error` 提示（本地 `tested` state 记录结果）。
  - 启用开关 → `updateModel(id, {enabled})`，乐观更新或成功后 `getModels()` 刷新。
  - "编辑"→ 抽屉回填（apiKey 留空表示不改；填了才更新）→ `updateModel(id, {...patch, ...(apiKey ? {apiKey} : {})})`。
  - "删除"→ 确认 → `deleteModel(id)` → `setRows(prev => prev.filter(r => r.id !== id))`。
  - 列表 `apiKeyMasked` 字段显示掩码（已有，确认字段名对齐契约）。
- [ ] **绿**：`pnpm --filter @codecrush/frontend test` 全绿。
- [ ] 提交：`feat(frontend): wire ModelsPage to real backend — create/test/toggle/edit/delete`

**验证**：启动后端 + 前端，浏览器 ModelsPage：接入（填 baseUrl + apiKey）→ 列表显示掩码 → 测试连接 ✓ → 开关切换 → 编辑 → 删除，全链路无本地 mock 残留。`pnpm lint` 0 违规（frontend 只 import contracts）。

---

## Story 7 — 收尾验证

> 全量测试 + lint + build + 手动验收。

### 步骤

- [ ] **全量测试**：`pnpm test`（前端 + 后端 + 契约全绿）。
- [ ] **lint**：`pnpm lint`（0 边界违规）。
- [ ] **build**：`pnpm build`（turbo 全量构建成功）。
- [ ] **手动验收**（记录到 dev-ledger）：
  - `docker compose -f infra/docker-compose.yml --profile infra up -d --wait` + `pnpm --filter @codecrush/backend dev` + `pnpm --filter @codecrush/frontend dev`
  - 浏览器 ModelsPage：接入真实 DeepSeek/OpenAI key → 测试连接 → ✓ → 开关 → 编辑 → 删除全链路通
  - `curl http://localhost:3000/api/docs-json | jq '.paths | keys'` 含 `PATCH/DELETE /api/models/{id}`、`POST /api/models/{id}/test`
  - DB 检查：`docker compose exec postgres psql -U postgres -d codecrush -c "SELECT id, provider, name, api_key_enc, enabled FROM model_providers;"` → `api_key_enc` 是密文（非明文、非掩码）
  - `.env` 含 `MODEL_API_KEY_ENCRYPTION_KEY` 真值（不进 git）
- [ ] 提交：`chore(m3): integration verification`

**验证**：全部 10 条 Acceptance Criteria 满足（见 spec.md AC 1-10）。

---

## Host 自查（代替 execution drill）

> 轻量对抗模式（CLAUDE.md）：跳过 peer execution drill，host 自查 plan 可执行性。

| 检查项 | 结果 |
|--------|------|
| 每个 story 有 TDD 红绿步骤？ | ✅ 每 story 先写测试再写实现（Story 3 schema 无单测，靠 Drizzle TS 类型推断 + migrate 运行兜底，与 users.schema 现状一致） |
| 有 placeholder/TBD？ | ❌ 无。所有代码片段完整（含 adapter 三类真路径 + service 加解密 + e2e inMemoryRepo） |
| Story 间依赖清晰？ | ✅ 1（契约）→ 2（加密）→ 3（DB）→ 4（port/adapter）→ 5（service+controller+e2e）→ 6（前端）→ 7（收尾）。契约先于后端/前端；加密先于 service；DB 先于 repo；port 先于 service 注入 |
| 破坏性变更有 story 覆盖？ | ✅ Story 1 契约演进（apiKey 写侧）→ Story 5 e2e 测试体更新（非软化，是合法更新）；Story 2 env fail-fast（.env.example + 测试 env 注入） |
| 文档先改？ | ✅ 无需改 001（架构权威已列 `model_providers(id,...,api_key_enc,deployment_id,...)` 001:81，对齐）；006 是 M2 产物不涉及 M3 |
| 验收标准全覆盖？ | ✅ AC 1-3 → Story 5；AC 4-5 → Story 5；AC 6 → Story 6；AC 7 → Story 3；AC 8 → Story 7；AC 9 → Story 2/7；AC 10 → Story 5 |
| 契约演进破坏面？ | ✅ `CreateModelRequestSchema` 加 `apiKey` 必填 → skeleton.e2e + m2-schemas.test 需更新（Story 1 + Story 5 覆盖）；`baseUrl` optional→required → 前端 mock `MODEL_TYPES` baseUrl 默认值保留作 UX 提示（不影响契约） |
| 加密不变量？ | ✅ Story 2 spec 覆盖 GCM authTag 校验 + 错误 key 抛错 + 密文篡改抛错；master key 不进 git（.env.example 占位）；Story 5 e2e 用固定 key 注入 |
| e2e DB 策略？ | ✅ in-memory mock repo（DB-free，对齐 skeleton.e2e + traces.repository.spec mock-client 约定，diff D2 已验证）；真实加密集成靠 service spec（mock repo + real EncryptionService）+ encryption spec（real key）覆盖 |
| testConnection 不真打外网？ | ✅ Story 5 e2e `overrideProvider(MODEL_PROVIDER_PORT).useValue(mock)`；Story 4 adapter spec mock 全局 fetch |
| OpenAPI 端点？ | ✅ Story 5 controller 用 `createZodDto`，nestjs-zod 自动生成 OpenAPI；Story 7 验证 docs-json 含 PATCH/DELETE/test |
| 前端边界？ | ✅ Story 6 frontend 只 import `@codecrush/contracts`（api client + TYPE_LABEL）；不 import backend / otel |

**自查结论**：plan 可执行。唯一需实现时确认的点是 Story 5 controller 的 `TestModelResponseDto`/`z` import 是否被 nestjs-zod swagger 扫描需要——若 lint 报 unused 则删除（plan 已标注），非占位。Story 4 adapter 的超时测试用 `jest.useFakeTimers` + AbortController，实现时需确认 AbortSignal abort 事件触发路径（plan 已给 mock 实现，若 flaky 可改用 `jest.advanceTimersByTime` + 真实 setTimeout 包装）。

**自查发现的潜在风险**（记入 dev 关注）：
1. **Story 2 测试 env 注入**：若 `skeleton.e2e.spec.ts` 在 `Test.createTestingModule` compile 前未设 `process.env.MODEL_API_KEY_ENCRYPTION_KEY`，AppConfigService 构造时 envSchema 校验会崩。plan 已标注「优先 overrideProvider(ENCRYPTION).useValue(...)」规避，但若 TestingModule 用 `ModelsModule`（含 SecurityModule 依赖）而非 override，需确保 env 已设。dev 时优先用 override 注入固定 key。
2. **Story 5 e2e mock repo 类型**：`inMemoryRepo` 需满足 `ModelsRepository` 的方法签名（find/findById/insert/update/delete）。若 TS strict 报类型不匹配，用 `as unknown as ModelsRepository` cast 或扩 `Partial<ModelsRepository>`。plan 已用 `as ModelProviderRow` cast，dev 时按实际 lint 调整。
3. **Story 4 adapter `call` 方法签名**：`ModelCallConfig` import 自 port，adapter `implements ModelProviderPort` 需 port 接口先存在（Story 4 内同时建 port + adapter，顺序 OK）。
