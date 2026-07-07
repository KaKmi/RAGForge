# M3 — 模型接入（Model Integration）Implementation Plan

> **For agentic workers:** Use /ship:dev to implement this plan task-by-task. Steps use checkbox syntax for tracking.
> 对抗强度：**轻量对抗**（CLAUDE.md 2026-07-05 拍板）——dev 不做每 story 审，任务收尾跑一次 review 覆盖全量 diff；Story 2（加密，安全敏感）建议单独审。

**Goal:** 把 M2 的 models mock 骨架变成真实功能：model_providers 持久化 CRUD、API Key AES-256-GCM 加密存库 + 掩码回传、连通性测试真打 OpenAI 兼容端点（LLM/Embedding/Rerank），前端 ModelsPage 全交互接真后端。

**Architecture:** 照搬 prompts（M6）范式：域内 Drizzle schema + Repository + Service + createZodDto Controller；加密落 `platform/security`（@Global SecurityModule + `ENCRYPTION` token）；连通性测试走 `ModelProviderPort`（003:101 归 models 域）+ `OpenAiCompatAdapter`（DI token 注入，Node fetch）；e2e 用 in-memory repo + fake port（skeleton.e2e 现状范式）。

**Tech Stack:** NestJS + nestjs-zod、Drizzle/Postgres、zod v4（contracts）、Node 22 全局 fetch、Node crypto（AES-256-GCM）、@codecrush/otel `withSpan` + otel-conventions 常量、jest（backend）/ vitest（contracts、frontend）。

## Global Constraints

- 明文 apiKey 不得落库、不得出现在任何响应 / 日志 / span 属性 / error message。
- 响应侧（ModelProviderSchema）永不含 `apiKey` 字段，只有 `apiKeyMasked`。
- 掩码规则：`len≥8 → 首3+"****"+末4`；`len<8 → "****"`。
- 密文 envelope：`v1:<ivB64>:<tagB64>:<ciphertextB64>`（iv 12B，authTag 16B，AES-256-GCM）。
- env 新增 `MODEL_API_KEY_ENCRYPTION_KEY`（32 字节 base64，`z.string().min(44)` fail-fast）；真值不进 git。
- 不引 axios / openai SDK / undici——用 Node 22 全局 `fetch`。
- e2e 不得真打外部 API——`overrideProvider(MODEL_PROVIDER_PORT)` 注 fake。
- 不得软化 skeleton.e2e / config.schema.spec / m2-schemas.test 既有断言——按新契约更新测试体是合法演进。
- 跨模块只走 barrel 导出的 service/端口，禁止 import `adapters/`（eslint 边界，`pnpm lint` 0 违规）。
- DB 表形状对齐 001:81：`model_providers(id,type,provider,name,base_url,api_key_enc,deployment_id,enabled)` + createdAt/updatedAt 簿记列；**无 role 列**。
- 超时固定 10s 常量（`TEST_CONNECTION_TIMEOUT_MS = 10_000`），不加 env。
- Commit 用 Conventional Commits，结尾 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`；仅提交，不推送。

---

### Story 1: 契约修订（contracts/models.ts）+ 契约测试

**Files:**
- Modify: `packages/contracts/src/models.ts`
- Modify: `packages/contracts/src/m2-schemas.test.ts:35-45`（valid.model fixture）、`:310-314`（Create 断言）
- Create: `packages/contracts/src/models.test.ts`

**Interfaces:**
- Produces（后续所有 story 消费）：`ModelProviderSchema`/`ModelProvider`（读侧：id,type,provider,name,baseUrl,apiKeyMasked,deploymentId?,enabled——**无 role、无 apiKey**）、`CreateModelRequestSchema`/`CreateModelRequest`（写侧：+`apiKey: min(8)`、`enabled` 默认 true）、`UpdateModelRequestSchema`（Create.partial()）、`TestModelRequestSchema`（Create.omit enabled）、`TestModelResponseSchema`/`TestModelResponse`（`{ok, latencyMs?, statusCode?, error?}`）。

**Tier:** mechanical

- [ ] **Step 1: 写失败测试** — `packages/contracts/src/models.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  CreateModelRequestSchema,
  ModelProviderSchema,
  TestModelRequestSchema,
  TestModelResponseSchema,
  UpdateModelRequestSchema,
} from "./index";

const validCreate = {
  type: "llm",
  provider: "DeepSeek",
  name: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test12345678",
};

describe("M3 model contracts", () => {
  it("CreateModelRequestSchema 接受合法体且 enabled 缺省 true", () => {
    const r = CreateModelRequestSchema.parse(validCreate);
    expect(r.enabled).toBe(true);
    expect(r.apiKey).toBe("sk-test12345678");
  });
  it("CreateModelRequestSchema 拒绝缺 apiKey / apiKey<8 / 缺 baseUrl", () => {
    const { apiKey: _k, ...noKey } = validCreate;
    expect(() => CreateModelRequestSchema.parse(noKey)).toThrow();
    expect(() => CreateModelRequestSchema.parse({ ...validCreate, apiKey: "short" })).toThrow();
    const { baseUrl: _b, ...noBase } = validCreate;
    expect(() => CreateModelRequestSchema.parse(noBase)).toThrow();
  });
  it("ModelProviderSchema 要求 apiKeyMasked、无 apiKey 字段", () => {
    const read = {
      id: "m1", type: "llm", provider: "DeepSeek", name: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1", apiKeyMasked: "sk-****5678", enabled: true,
    };
    expect(ModelProviderSchema.parse(read)).toEqual(read);
    const { apiKeyMasked: _m, ...noMask } = read;
    expect(() => ModelProviderSchema.parse(noMask)).toThrow();
    // 未知键（含 apiKey）被 strip，不进入解析结果
    expect(ModelProviderSchema.parse({ ...read, apiKey: "leak" })).not.toHaveProperty("apiKey");
  });
  it("UpdateModelRequestSchema 全字段可选、apiKey 出现时仍 min(8)", () => {
    expect(UpdateModelRequestSchema.parse({})).toEqual({});
    expect(UpdateModelRequestSchema.parse({ enabled: false }).enabled).toBe(false);
    expect(() => UpdateModelRequestSchema.parse({ apiKey: "short" })).toThrow();
  });
  it("TestModelRequestSchema 无 enabled；TestModelResponseSchema 形状", () => {
    const r = TestModelRequestSchema.parse({ ...validCreate, enabled: true });
    expect(r).not.toHaveProperty("enabled");
    expect(TestModelResponseSchema.parse({ ok: false, statusCode: 401, error: "HTTP 401" }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 验证失败** — Run: `pnpm --filter @codecrush/contracts test`，Expected: FAIL（`UpdateModelRequestSchema` 等未导出 / enabled 无默认）。

- [ ] **Step 3: 实现** — 重写 `packages/contracts/src/models.ts`：

```ts
import { z } from "zod";

export const ModelTypeSchema = z.enum(["llm", "embedding", "rerank"]);
export type ModelType = z.infer<typeof ModelTypeSchema>;

// 读侧：仅掩码，永不含明文 apiKey；role 不持久化（001:81 权威表无此列）
export const ModelProviderSchema = z.object({
  id: z.string().min(1),
  type: ModelTypeSchema,
  provider: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKeyMasked: z.string(),
  deploymentId: z.string().optional(),
  enabled: z.boolean(),
});
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelProviderListResponseSchema = z.array(ModelProviderSchema);
export type ModelProviderListResponse = z.infer<typeof ModelProviderListResponseSchema>;

// 写侧：明文 apiKey（HTTPS 内传输），enabled 缺省 true
export const CreateModelRequestSchema = ModelProviderSchema.omit({
  id: true,
  apiKeyMasked: true,
}).extend({
  apiKey: z.string().min(8),
  enabled: z.boolean().default(true),
});
export type CreateModelRequest = z.infer<typeof CreateModelRequestSchema>;

// PATCH：全可选；apiKey 不传 = 不改
export const UpdateModelRequestSchema = CreateModelRequestSchema.partial();
export type UpdateModelRequest = z.infer<typeof UpdateModelRequestSchema>;

// ad-hoc 连通性测试（抽屉保存前验活）
export const TestModelRequestSchema = CreateModelRequestSchema.omit({ enabled: true });
export type TestModelRequest = z.infer<typeof TestModelRequestSchema>;

export const TestModelResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  statusCode: z.number().int().optional(),
  error: z.string().optional(),
});
export type TestModelResponse = z.infer<typeof TestModelResponseSchema>;
```

同步更新 `m2-schemas.test.ts`：
  - `:35-45` `valid.model` 删 `role` 字段（保留 `apiKeyMasked: "sk-****1234"`，现为必填）。
  - `:310-314` 原 omit 断言改为：

```ts
it("CreateModelRequestSchema 要求明文 apiKey，读侧无 apiKey", () => {
  const { id: _id, apiKeyMasked: _m, ...rest } = valid.model;
  expect(() => CreateModelRequestSchema.parse(rest)).toThrow(); // 缺 apiKey
  const created = CreateModelRequestSchema.parse({ ...rest, apiKey: "sk-12345678" });
  expect(created.enabled).toBe(true);
  expect(() => CreateModelRequestSchema.parse({ ...rest, apiKey: "sk-12345678", type: "vision" })).toThrow();
});
```

  - 检查该文件其余 `valid.model` 引用处（`:149-150,218-219`）随 fixture 自然通过。

- [ ] **Step 4: 验证通过** — Run: `pnpm --filter @codecrush/contracts test`，Expected: PASS。注意此时 backend/frontend 尚未适配新契约，**不要**跑全仓 test/build（Story 5/6 恢复绿）。
- [ ] **Step 5: Commit** — `git add packages/contracts && git commit -m "feat(contracts): M3 模型契约读写分离（明文 apiKey 写侧/掩码读侧）"`

---

### Story 2: 加密服务 + SecurityModule + env/config 接线

**Files:**
- Create: `apps/backend/src/platform/security/encryption.ts`、`security.constants.ts`、`security.module.ts`
- Modify: `apps/backend/src/platform/config/config.schema.ts`、`config.service.ts`、`apps/backend/src/app.module.ts:23-26`、`apps/backend/.env.example`
- Test: Create `apps/backend/test/encryption.spec.ts`；Modify `apps/backend/test/config.schema.spec.ts:16-23`

**Interfaces:**
- Produces：`EncryptionService`（`encrypt(plaintext): string`（v1 envelope）、`decrypt(envelope): string`、`maskApiKey(plaintext): string`）；DI token `ENCRYPTION = Symbol("ENCRYPTION")`（`security.constants.ts`）；`AppConfigService.modelApiKeyEncryptionKey: string`。Story 5 以 `@Inject(ENCRYPTION)` 消费。

**Tier:** mechanical

**安全敏感 story——收尾 review 时单独过一遍此 diff。**

- [ ] **Step 1: 写失败测试** — `apps/backend/test/encryption.spec.ts`：

```ts
import { EncryptionService } from "../src/platform/security/encryption";

const KEY = Buffer.alloc(32, 7).toString("base64"); // 固定测试主密钥
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("EncryptionService (AES-256-GCM)", () => {
  const enc = new EncryptionService(KEY);

  it("encrypt→decrypt 往返一致，envelope 为 v1: 前缀", () => {
    const blob = enc.encrypt("sk-test12345678");
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("sk-test12345678");
    expect(enc.decrypt(blob)).toBe("sk-test12345678");
  });
  it("同明文两次加密密文不同（随机 iv）", () => {
    expect(enc.encrypt("same")).not.toBe(enc.encrypt("same"));
  });
  it("错误 key 解密抛错（GCM auth 失败）", () => {
    const blob = enc.encrypt("secret");
    expect(() => new EncryptionService(OTHER_KEY).decrypt(blob)).toThrow();
  });
  it("篡改密文抛错；非 v1 前缀抛错", () => {
    const blob = enc.encrypt("secret");
    const [v, iv, tag, ct] = blob.split(":");
    const tampered = [v, iv, tag, Buffer.from("xx" + Buffer.from(ct, "base64").toString("hex"), "hex").toString("base64")].join(":");
    expect(() => enc.decrypt(tampered)).toThrow();
    expect(() => enc.decrypt("v0:a:b:c")).toThrow();
  });
  it("主密钥非 32 字节 → 构造抛错", () => {
    expect(() => new EncryptionService(Buffer.alloc(16, 1).toString("base64"))).toThrow();
  });
  it("maskApiKey：≥8 → 首3****末4；<8 → ****；空串 → ****", () => {
    expect(enc.maskApiKey("sk-abcdef1234")).toBe("sk-****1234");
    expect(enc.maskApiKey("12345678")).toBe("123****5678");
    expect(enc.maskApiKey("1234567")).toBe("****");
    expect(enc.maskApiKey("")).toBe("****");
  });
});
```

- [ ] **Step 2: 验证失败** — Run: `pnpm --filter @codecrush/backend test -- encryption.spec`，Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现** —

`apps/backend/src/platform/security/encryption.ts`：

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";

/**
 * 模型 API Key 应用层加密（001:159）。AES-256-GCM，envelope `v1:<ivB64>:<tagB64>:<ctB64>`，
 * 版本前缀为日后 KMS 迁移留判别标识。主密钥 32 字节 base64（env MODEL_API_KEY_ENCRYPTION_KEY）。
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(masterKeyB64: string) {
    this.key = Buffer.from(masterKeyB64, "base64");
    if (this.key.length !== 32) {
      throw new Error("MODEL_API_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
  }

  decrypt(envelope: string): string {
    const [version, ivB64, tagB64, ctB64] = envelope.split(":");
    if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
      throw new Error("unsupported ciphertext envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  // len≥8 → 首3+****+末4（与 M2 展示格式 sk-****1234 一致）；否则 ****
  maskApiKey(plaintext: string): string {
    if (plaintext.length < 8) return "****";
    return `${plaintext.slice(0, 3)}****${plaintext.slice(-4)}`;
  }
}
```

`apps/backend/src/platform/security/security.constants.ts`：

```ts
export const ENCRYPTION = Symbol("ENCRYPTION");
```

`apps/backend/src/platform/security/security.module.ts`：

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
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new EncryptionService(config.modelApiKeyEncryptionKey),
    },
  ],
  exports: [ENCRYPTION],
})
export class SecurityModule {}
```

`config.schema.ts` 在 `JWT_EXPIRES_IN` 后加：

```ts
  // 模型 API Key 加密主密钥：32 字节 base64（44 字符），生成：openssl rand -base64 32
  MODEL_API_KEY_ENCRYPTION_KEY: z.string().min(44),
```

`config.service.ts` 加 getter：

```ts
  get modelApiKeyEncryptionKey(): string {
    return this.config.get("MODEL_API_KEY_ENCRYPTION_KEY", { infer: true });
  }
```

`app.module.ts` imports 在 `ClickHouseModule` 后加 `SecurityModule`（import 自 `./platform/security/security.module`）。

`.env.example` 在 JWT 段后加：

```
# 模型 API Key 加密主密钥（32 字节 base64）。生成：openssl rand -base64 32
MODEL_API_KEY_ENCRYPTION_KEY=REPLACE_ME_openssl_rand_base64_32_output_here
```

`config.schema.spec.ts` **合法演进更新**：`:16-23` 用例的 env 对象补 `MODEL_API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64")`；并新增两个用例：缺失 → fail、`"tooshort"` → fail（对齐 JWT fail-fast 风格）。前两个既有用例（`:8-14`）不含新 key 本就该 fail，不受影响。

- [ ] **Step 4: 验证通过** — Run: `pnpm --filter @codecrush/backend test -- encryption.spec config.schema.spec`，Expected: PASS。**同时**本地 `.env`（不进 git）加真实生成的 key，否则后端启动会 fail-fast。
- [ ] **Step 5: Commit** — `git add apps/backend && git commit -m "feat(backend): AES-256-GCM 模型密钥加密服务 + SecurityModule + env fail-fast"`

---

### Story 3: DB schema + 迁移 + ModelsRepository

**Files:**
- Create: `apps/backend/src/modules/models/schema.ts`、`apps/backend/src/modules/models/models.repository.ts`
- Modify: `apps/backend/src/db/schema.ts`（barrel）
- Create（生成）: `apps/backend/drizzle/0003_*.sql`

**Interfaces:**
- Produces：`modelProviders` 表、`ModelProviderRow`/`NewModelProvider` 类型；`ModelsRepository`（`find(): Promise<ModelProviderRow[]>`、`findById(id): Promise<ModelProviderRow | undefined>`、`insert(row: NewModelProvider): Promise<ModelProviderRow>`、`update(id, patch: Partial<NewModelProvider>): Promise<ModelProviderRow | undefined>`、`delete(id): Promise<void>`）。Story 5 消费；e2e 以此签名做 in-memory 替身。

**Tier:** mechanical

无独立单测（对齐 users/prompts schema 现状：Drizzle TS 类型推断 + migrate 实跑兜底；行为经 Story 5 service spec + e2e 覆盖）。

- [ ] **Step 1: schema** — `apps/backend/src/modules/models/schema.ts`：

```ts
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// 域内 schema：零 service 引用（003 不变量 5）。表形状对齐 001:81：
// model_providers(id, type[llm/embedding/rerank], provider, name, base_url, api_key_enc, deployment_id, enabled)
// created_at/updated_at 为工程簿记列（users/prompts 同例）；role 不落库（001:81 无此列）。
export const modelProviders = pgTable("model_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // "llm" | "embedding" | "rerank"
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc").notNull(), // EncryptionService v1 envelope，永不存明文
  deploymentId: text("deployment_id"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type ModelProviderRow = typeof modelProviders.$inferSelect;
export type NewModelProvider = typeof modelProviders.$inferInsert;
```

`apps/backend/src/db/schema.ts` 末尾追加：`export * from "../modules/models/schema";`

- [ ] **Step 2: 生成迁移** — Run: `pnpm db:generate`，Expected: 生成 `apps/backend/drizzle/0003_*.sql`，内容为 `CREATE TABLE "model_providers" (...)`，人工核对列名/类型与上述一致。

- [ ] **Step 3: 应用迁移** — 先 `docker compose -f infra/docker-compose.yml --profile infra up -d --wait`，Run: `pnpm db:migrate`，Expected: 退出码 0；`psql` 或再次 migrate 幂等无报错。

- [ ] **Step 4: repository** — `apps/backend/src/modules/models/models.repository.ts`：

```ts
import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import { modelProviders, type ModelProviderRow, type NewModelProvider } from "./schema";

@Injectable()
export class ModelsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async find(): Promise<ModelProviderRow[]> {
    return await this.db.select().from(modelProviders).orderBy(desc(modelProviders.createdAt));
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

  async update(id: string, patch: Partial<NewModelProvider>): Promise<ModelProviderRow | undefined> {
    const rows = await this.db
      .update(modelProviders)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(modelProviders.id, id))
      .returning();
    return rows[0];
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(modelProviders).where(eq(modelProviders.id, id));
  }
}
```

- [ ] **Step 5: 类型检查** — Run: `pnpm --filter @codecrush/backend build`，Expected: PASS（此时 models.service 仍是 mock，未引用新文件，编译应绿）。
- [ ] **Step 6: Commit** — `git add apps/backend && git commit -m "feat(backend): model_providers 表 + 迁移 + ModelsRepository"`

---

### Story 4: ModelProviderPort + OpenAiCompatAdapter + 单测

**Files:**
- Create: `apps/backend/src/modules/models/ports/model-provider.port.ts`、`apps/backend/src/modules/models/model-provider.constants.ts`、`apps/backend/src/modules/models/adapters/openai-compat.adapter.ts`
- Test: Create `apps/backend/test/openai-compat.adapter.spec.ts`

**Interfaces:**
- Produces：`ModelProviderPort { testConnection(config: ModelCallConfig): Promise<TestModelResult> }`；`ModelCallConfig { type: ModelType; provider: string; name: string; baseUrl: string; apiKey: string; deploymentId?: string }`；`TestModelResult { ok: boolean; latencyMs?: number; statusCode?: number; error?: string }`；token `MODEL_PROVIDER_PORT = Symbol("MODEL_PROVIDER_PORT")`；`TEST_CONNECTION_TIMEOUT_MS = 10_000`。Story 5 消费。
- 端口终态为 001:95 `chat()/embed()/rerank()`，M3 不预留可选空壳方法（diff D5）。

**Tier:** standard

- [ ] **Step 1: 写失败测试** — `apps/backend/test/openai-compat.adapter.spec.ts`：

```ts
import { OpenAiCompatAdapter } from "../src/modules/models/adapters/openai-compat.adapter";
import type { ModelCallConfig } from "../src/modules/models/ports/model-provider.port";

const cfg = (over: Partial<ModelCallConfig> = {}): ModelCallConfig => ({
  type: "llm", provider: "DeepSeek", name: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-test12345678", ...over,
});

const okJson = (json: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => json }) as unknown as Response;

describe("OpenAiCompatAdapter.testConnection", () => {
  const adapter = new OpenAiCompatAdapter();
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("llm → POST {base}/chat/completions，body 含 max_tokens:1，2xx+choices → ok:true", async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [] }));
    const r = await adapter.testConnection(cfg());
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: "deepseek-chat", max_tokens: 1 });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test12345678");
    expect(r).toMatchObject({ ok: true, statusCode: 200 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("model 参数取 deploymentId ?? name", async () => {
    fetchMock.mockResolvedValue(okJson({ choices: [] }));
    await adapter.testConnection(cfg({ deploymentId: "my-deploy" }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("my-deploy");
  });

  it("embedding → /embeddings，2xx 且 data[0].embedding 为数组才 ok", async () => {
    fetchMock.mockResolvedValue(okJson({ data: [{ embedding: [0.1] }] }));
    const r = await adapter.testConnection(cfg({ type: "embedding", baseUrl: "http://infra.internal:8080" }));
    expect(fetchMock.mock.calls[0][0]).toBe("http://infra.internal:8080/embeddings");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ input: "ping" });
    expect(r.ok).toBe(true);
  });

  it("rerank → /rerank，body 含 query+documents+top_n；results 或 data 数组 → ok", async () => {
    fetchMock.mockResolvedValue(okJson({ results: [] }));
    const r = await adapter.testConnection(cfg({ type: "rerank", baseUrl: "http://infra.internal:8080" }));
    expect(fetchMock.mock.calls[0][0]).toBe("http://infra.internal:8080/rerank");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ query: "ping", documents: ["ping", "pong"], top_n: 1 });
    expect(r.ok).toBe(true);
  });

  it("baseUrl 已含 canonical 后缀 → 不重复拼接；尾斜杠归一化", async () => {
    fetchMock.mockResolvedValue(okJson({ results: [] }));
    await adapter.testConnection(cfg({ type: "rerank", baseUrl: "http://infra.internal:8080/rerank" }));
    expect(fetchMock.mock.calls[0][0]).toBe("http://infra.internal:8080/rerank");
    fetchMock.mockResolvedValue(okJson({ choices: [] }));
    await adapter.testConnection(cfg({ baseUrl: "https://api.deepseek.com/v1/" }));
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("2xx 但形状不符 → ok:false", async () => {
    fetchMock.mockResolvedValue(okJson({ unexpected: true }));
    const r = await adapter.testConnection(cfg());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/shape/);
  });

  it("非 2xx → ok:false + statusCode + 脱敏 error（不含 apiKey）", async () => {
    fetchMock.mockResolvedValue(okJson({ error: { message: "Invalid API key" } }, 401));
    const r = await adapter.testConnection(cfg());
    expect(r).toMatchObject({ ok: false, statusCode: 401 });
    expect(r.error).toContain("401");
    expect(r.error).not.toContain("sk-test12345678");
  });

  it("网络错误（fetch reject）→ ok:false 不抛", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await adapter.testConnection(cfg());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });
});
```

- [ ] **Step 2: 验证失败** — Run: `pnpm --filter @codecrush/backend test -- openai-compat.adapter.spec`，Expected: FAIL（文件不存在）。

- [ ] **Step 3: 实现** —

`ports/model-provider.port.ts`：

```ts
import type { ModelType } from "@codecrush/contracts";

// 端口归 models 域（003:101）。终态为 001:95 chat()/embed()/rerank()，
// M3 只需连通性测试；M4/M8 按需加必选方法（非破坏扩展）。
export interface ModelCallConfig {
  type: ModelType;
  provider: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  deploymentId?: string;
}

export interface TestModelResult {
  ok: boolean;
  latencyMs?: number;
  statusCode?: number;
  error?: string;
}

export interface ModelProviderPort {
  testConnection(config: ModelCallConfig): Promise<TestModelResult>;
}
```

`model-provider.constants.ts`：

```ts
export const MODEL_PROVIDER_PORT = Symbol("MODEL_PROVIDER_PORT");
```

`adapters/openai-compat.adapter.ts`：

```ts
import { Injectable } from "@nestjs/common";
import type { ModelType } from "@codecrush/contracts";
import type {
  ModelCallConfig,
  ModelProviderPort,
  TestModelResult,
} from "../ports/model-provider.port";

export const TEST_CONNECTION_TIMEOUT_MS = 10_000;

const CANONICAL_PATH: Record<ModelType, string> = {
  llm: "/chat/completions",
  embedding: "/embeddings",
  rerank: "/rerank",
};

@Injectable()
export class OpenAiCompatAdapter implements ModelProviderPort {
  async testConnection(config: ModelCallConfig): Promise<TestModelResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_CONNECTION_TIMEOUT_MS);
    try {
      const resp = await fetch(buildUrl(config), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(config)),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const json: unknown = await resp.json().catch(() => undefined);
      if (!resp.ok) {
        return { ok: false, latencyMs, statusCode: resp.status, error: upstreamError(resp.status, json) };
      }
      if (!shapeOk(config.type, json)) {
        return { ok: false, latencyMs, statusCode: resp.status, error: "unexpected response shape" };
      }
      return { ok: true, latencyMs, statusCode: resp.status };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const error = controller.signal.aborted
        ? `timeout after ${TEST_CONNECTION_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      return { ok: false, latencyMs, error };
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildUrl(config: ModelCallConfig): string {
  const path = CANONICAL_PATH[config.type];
  const base = config.baseUrl.replace(/\/+$/, "");
  return base.endsWith(path) ? base : `${base}${path}`;
}

function buildBody(config: ModelCallConfig): Record<string, unknown> {
  const model = config.deploymentId ?? config.name;
  if (config.type === "embedding") return { model, input: "ping" };
  if (config.type === "rerank") {
    return { model, query: "ping", documents: ["ping", "pong"], top_n: 1 };
  }
  return { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 };
}

function shapeOk(type: ModelType, json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  const o = json as Record<string, unknown>;
  if (type === "llm") return Array.isArray(o.choices);
  if (type === "embedding") {
    const first = Array.isArray(o.data) ? (o.data[0] as Record<string, unknown> | undefined) : undefined;
    return Array.isArray(first?.embedding);
  }
  return Array.isArray(o.results) || Array.isArray(o.data);
}

// 脱敏：只取 status + 上游 message 截断，不含 headers/apiKey/完整 body
function upstreamError(status: number, json: unknown): string {
  let message = "";
  if (typeof json === "object" && json !== null) {
    const o = json as { error?: { message?: unknown }; message?: unknown };
    const raw = o.error?.message ?? o.message;
    if (typeof raw === "string") message = raw.slice(0, 200);
  }
  return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
}
```

- [ ] **Step 4: 验证通过** — Run: `pnpm --filter @codecrush/backend test -- openai-compat.adapter.spec`，Expected: PASS。
- [ ] **Step 5: Commit** — `git add apps/backend && git commit -m "feat(backend): ModelProviderPort + OpenAI 兼容适配器（三类连通性测试）"`

---

### Story 5: ModelsService 重写 + Controller 扩展 + Module 接线 + service spec + e2e 更新

**Files:**
- Modify: `apps/backend/src/modules/models/models.service.ts`（整体重写）、`models.controller.ts`、`models.module.ts`
- Test: Create `apps/backend/test/models.service.spec.ts`；Modify `apps/backend/test/skeleton.e2e.spec.ts`（models 块 `:197-227` 重写 + TestingModule 接线）

**Interfaces:**
- Consumes：Story 1 契约、Story 2 `ENCRYPTION`/`EncryptionService`、Story 3 `ModelsRepository`/`ModelProviderRow`/`NewModelProvider`、Story 4 `MODEL_PROVIDER_PORT`/`ModelProviderPort`/`ModelCallConfig`。
- Produces：`ModelsService`（`list/get/create/update/remove/testById/testConfig`）；HTTP 面：`GET /api/models`、`GET /api/models/:id`、`POST /api/models`(201)、`PATCH /api/models/:id`、`DELETE /api/models/:id`(204)、`POST /api/models/test`、`POST /api/models/:id/test`。Story 6 前端消费。

**Tier:** standard

- [ ] **Step 1: 写 service 失败测试** — `apps/backend/test/models.service.spec.ts`：

```ts
import { NotFoundException } from "@nestjs/common";
import { ModelsService } from "../src/modules/models/models.service";
import { EncryptionService } from "../src/platform/security/encryption";
import type { ModelsRepository } from "../src/modules/models/models.repository";
import type { ModelProviderPort } from "../src/modules/models/ports/model-provider.port";
import type { ModelProviderRow, NewModelProvider } from "../src/modules/models/schema";

const enc = new EncryptionService(Buffer.alloc(32, 7).toString("base64"));

function makeRepo(rows: ModelProviderRow[] = []) {
  return {
    rows,
    find: jest.fn(async () => rows),
    findById: jest.fn(async (id: string) => rows.find((r) => r.id === id)),
    insert: jest.fn(async (row: NewModelProvider): Promise<ModelProviderRow> => {
      const r: ModelProviderRow = {
        id: "m1", type: row.type, provider: row.provider, name: row.name,
        baseUrl: row.baseUrl, apiKeyEnc: row.apiKeyEnc,
        deploymentId: row.deploymentId ?? null, enabled: row.enabled ?? true,
        createdAt: new Date(), updatedAt: new Date(),
      };
      rows.push(r);
      return r;
    }),
    update: jest.fn(async (id: string, patch: Partial<NewModelProvider>) => {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, patch, { updatedAt: new Date() });
      return r;
    }),
    delete: jest.fn(async (id: string) => {
      const i = rows.findIndex((x) => x.id === id);
      if (i >= 0) rows.splice(i, 1);
    }),
  };
}

const port: jest.Mocked<ModelProviderPort> = {
  testConnection: jest.fn(async () => ({ ok: true, latencyMs: 5, statusCode: 200 })),
};

const createReq = {
  type: "llm" as const, provider: "DeepSeek", name: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-test12345678", enabled: true,
};

describe("ModelsService", () => {
  beforeEach(() => port.testConnection.mockClear());

  it("create：repo 收到密文（非明文），响应只有掩码", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    const created = await svc.create(createReq);
    const inserted = repo.insert.mock.calls[0][0];
    expect(inserted.apiKeyEnc.startsWith("v1:")).toBe(true);
    expect(inserted.apiKeyEnc).not.toContain("sk-test12345678");
    expect(inserted).not.toHaveProperty("apiKey");
    expect(created.apiKeyMasked).toBe("sk-****5678");
    expect(created).not.toHaveProperty("apiKey");
    expect(created).not.toHaveProperty("apiKeyEnc");
  });

  it("list：每行解密→掩码", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    await svc.create(createReq);
    const [m] = await svc.list();
    expect(m.apiKeyMasked).toBe("sk-****5678");
  });

  it("update：带 apiKey 重加密；不带则 key 不变", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    const created = await svc.create(createReq);
    const encBefore = repo.rows[0].apiKeyEnc;
    await svc.update(created.id, { enabled: false });
    expect(repo.rows[0].apiKeyEnc).toBe(encBefore);
    expect(repo.rows[0].enabled).toBe(false);
    await svc.update(created.id, { apiKey: "sk-newkey87654321" });
    expect(repo.rows[0].apiKeyEnc).not.toBe(encBefore);
    expect(enc.decrypt(repo.rows[0].apiKeyEnc)).toBe("sk-newkey87654321");
  });

  it("testById：解密后明文传给 port；不存在 → 404", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    const created = await svc.create(createReq);
    const r = await svc.testById(created.id);
    expect(r).toMatchObject({ ok: true, latencyMs: 5, statusCode: 200 });
    expect(port.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-test12345678", type: "llm" }),
    );
    await expect(svc.testById("nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("remove：不存在 → 404；存在 → 删除", async () => {
    const repo = makeRepo();
    const svc = new ModelsService(repo as unknown as ModelsRepository, enc, port);
    await expect(svc.remove("nope")).rejects.toBeInstanceOf(NotFoundException);
    const created = await svc.create(createReq);
    await svc.remove(created.id);
    expect(repo.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 验证失败** — Run: `pnpm --filter @codecrush/backend test -- models.service.spec`，Expected: FAIL（构造签名不符——现 mock service 无依赖）。

- [ ] **Step 3: 实现 service** — 重写 `models.service.ts`：

```ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  CreateModelRequest,
  ModelProvider,
  ModelType,
  TestModelRequest,
  TestModelResponse,
  UpdateModelRequest,
} from "@codecrush/contracts";
import { withSpan } from "@codecrush/otel";
import { CODECRUSH_SPAN_KIND, GEN_AI, OTEL_OPERATIONS } from "@codecrush/otel-conventions";
import { ENCRYPTION } from "../../platform/security/security.constants";
import { EncryptionService } from "../../platform/security/encryption";
import { ModelsRepository } from "./models.repository";
import { MODEL_PROVIDER_PORT } from "./model-provider.constants";
import type { ModelCallConfig, ModelProviderPort } from "./ports/model-provider.port";
import type { ModelProviderRow, NewModelProvider } from "./schema";

const OP_BY_TYPE: Record<ModelType, string> = {
  llm: OTEL_OPERATIONS.CHAT,
  embedding: OTEL_OPERATIONS.EMBEDDINGS,
  rerank: OTEL_OPERATIONS.RERANK,
};
const KIND_BY_TYPE: Record<ModelType, string> = {
  llm: CODECRUSH_SPAN_KIND.LLM,
  embedding: CODECRUSH_SPAN_KIND.EMBEDDINGS,
  rerank: CODECRUSH_SPAN_KIND.RERANK,
};

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
    return this.toModelProvider(await this.mustFind(id));
  }

  async create(req: CreateModelRequest): Promise<ModelProvider> {
    const { apiKey, ...rest } = req;
    const row = await this.repo.insert({ ...rest, apiKeyEnc: this.enc.encrypt(apiKey) });
    return this.toModelProvider(row);
  }

  async update(id: string, req: UpdateModelRequest): Promise<ModelProvider> {
    await this.mustFind(id);
    const { apiKey, ...rest } = req;
    const patch: Partial<NewModelProvider> = { ...rest };
    if (apiKey) patch.apiKeyEnc = this.enc.encrypt(apiKey);
    const row = await this.repo.update(id, patch);
    if (!row) throw new NotFoundException(`model ${id} not found`);
    return this.toModelProvider(row);
  }

  async remove(id: string): Promise<void> {
    await this.mustFind(id);
    await this.repo.delete(id);
  }

  async testById(id: string): Promise<TestModelResponse> {
    const row = await this.mustFind(id);
    return this.doTest({
      type: row.type as ModelType,
      provider: row.provider,
      name: row.name,
      baseUrl: row.baseUrl,
      deploymentId: row.deploymentId ?? undefined,
      apiKey: this.enc.decrypt(row.apiKeyEnc),
    });
  }

  async testConfig(req: TestModelRequest): Promise<TestModelResponse> {
    return this.doTest({ ...req });
  }

  // best-effort span：属性只含类型/供应商/模型名，永不含 apiKey
  private async doTest(config: ModelCallConfig): Promise<TestModelResponse> {
    return await withSpan(
      "model.test_connection",
      {
        attributes: {
          [GEN_AI.OPERATION_NAME]: OP_BY_TYPE[config.type],
          [GEN_AI.SYSTEM]: config.provider,
          [GEN_AI.REQUEST_MODEL]: config.deploymentId ?? config.name,
          "codecrush.span.kind": KIND_BY_TYPE[config.type],
        },
      },
      async () => {
        const r = await this.provider.testConnection(config);
        return { ok: r.ok, latencyMs: r.latencyMs, statusCode: r.statusCode, error: r.error };
      },
    );
  }

  private async mustFind(id: string): Promise<ModelProviderRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(`model ${id} not found`);
    return row;
  }

  private toModelProvider(row: ModelProviderRow): ModelProvider {
    return {
      id: row.id,
      type: row.type as ModelType,
      provider: row.provider,
      name: row.name,
      baseUrl: row.baseUrl,
      deploymentId: row.deploymentId ?? undefined,
      enabled: row.enabled,
      apiKeyMasked: this.enc.maskApiKey(this.enc.decrypt(row.apiKeyEnc)),
    };
  }
}
```

- [ ] **Step 4: 验证 service spec 通过** — Run: `pnpm --filter @codecrush/backend test -- models.service.spec`，Expected: PASS。

- [ ] **Step 5: Controller + Module** —

`models.controller.ts` 重写：

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  CreateModelRequestSchema,
  TestModelRequestSchema,
  UpdateModelRequestSchema,
  type ModelProvider,
  type TestModelResponse,
} from "@codecrush/contracts";
import { ModelsService } from "./models.service";

class CreateModelRequestDto extends createZodDto(CreateModelRequestSchema) {}
class UpdateModelRequestDto extends createZodDto(UpdateModelRequestSchema) {}
class TestModelRequestDto extends createZodDto(TestModelRequestSchema) {}

@Controller("models")
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Get()
  list(): Promise<ModelProvider[]> {
    return this.modelsService.list();
  }

  // 静态段 "test" 先于 ":id" 声明，避免被参数路由抢占
  @Post("test")
  @HttpCode(200)
  testConfig(@Body() body: TestModelRequestDto): Promise<TestModelResponse> {
    return this.modelsService.testConfig(body);
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
  remove(@Param("id") id: string): Promise<void> {
    return this.modelsService.remove(id);
  }

  @Post(":id/test")
  @HttpCode(200)
  test(@Param("id") id: string): Promise<TestModelResponse> {
    return this.modelsService.testById(id);
  }
}
```

`models.module.ts`：

```ts
import { Module } from "@nestjs/common";
import { ModelsController } from "./models.controller";
import { ModelsRepository } from "./models.repository";
import { ModelsService } from "./models.service";
import { MODEL_PROVIDER_PORT } from "./model-provider.constants";
import { OpenAiCompatAdapter } from "./adapters/openai-compat.adapter";

@Module({
  controllers: [ModelsController],
  providers: [
    ModelsRepository,
    ModelsService,
    { provide: MODEL_PROVIDER_PORT, useClass: OpenAiCompatAdapter },
  ],
  // M4 ingestion 拿 MODEL_PROVIDER_PORT（003:135），拿端口不拿适配器
  exports: [ModelsService, MODEL_PROVIDER_PORT],
})
export class ModelsModule {}
```

- [ ] **Step 6: 更新 skeleton.e2e** —

TestingModule 接线（`skeleton.e2e.spec.ts:154-176`）：imports 加 `SecurityModule`；链式 override 追加：

```ts
import { SecurityModule } from "../src/platform/security/security.module";
import { EncryptionService } from "../src/platform/security/encryption";
import { ENCRYPTION } from "../src/platform/security/security.constants";
import { ModelsRepository } from "../src/modules/models/models.repository";
import { MODEL_PROVIDER_PORT } from "../src/modules/models/model-provider.constants";
import type { ModelProviderRow, NewModelProvider } from "../src/modules/models/schema";
// contracts import 处追加 TestModelResponseSchema

// —— models in-memory repo（对齐 inMemoryPromptsRepo 范式）——
const inMemoryModels: ModelProviderRow[] = [];
const inMemoryModelsRepo = {
  find: async (): Promise<ModelProviderRow[]> => [...inMemoryModels],
  findById: async (id: string): Promise<ModelProviderRow | undefined> =>
    inMemoryModels.find((m) => m.id === id),
  insert: async (row: NewModelProvider): Promise<ModelProviderRow> => {
    const r: ModelProviderRow = {
      id: `m${inMemoryModels.length + 1}`,
      type: row.type, provider: row.provider, name: row.name, baseUrl: row.baseUrl,
      apiKeyEnc: row.apiKeyEnc, deploymentId: row.deploymentId ?? null,
      enabled: row.enabled ?? true, createdAt: new Date(), updatedAt: new Date(),
    };
    inMemoryModels.push(r);
    return r;
  },
  update: async (id: string, patch: Partial<NewModelProvider>): Promise<ModelProviderRow | undefined> => {
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
};
const testEncryption = new EncryptionService(Buffer.alloc(32, 7).toString("base64"));
```

```ts
      .overrideProvider(PromptsRepository).useValue(inMemoryPromptsRepo)
      .overrideProvider(ModelsRepository).useValue(inMemoryModelsRepo)
      .overrideProvider(ENCRYPTION).useValue(testEncryption)
      .overrideProvider(MODEL_PROVIDER_PORT).useValue(fakeModelProviderPort)
      .compile();
```

models 块（替换 `:197-227`）：

```ts
  describe("models", () => {
    let modelId: string;
    const createBody = {
      type: "llm", provider: "DeepSeek", name: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-test12345678",
    };

    it("POST /api/models 缺 apiKey → 400（ZodValidationPipe）", async () => {
      const { apiKey: _k, ...noKey } = createBody;
      await request(app.getHttpServer()).post("/api/models").set(auth()).send(noKey).expect(400);
    });

    it("POST /api/models → 201 + 掩码、无明文", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/models").set(auth()).send(createBody).expect(201);
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
        .get(`/api/models/${modelId}`).set(auth()).expect(200);
      expect(() => ModelProviderSchema.parse(res.body)).not.toThrow();
      await request(app.getHttpServer()).get("/api/models/nope").set(auth()).expect(404);
    });

    it("PATCH enabled:false → 生效；不带 apiKey 掩码不变", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/models/${modelId}`).set(auth()).send({ enabled: false }).expect(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.apiKeyMasked).toBe("sk-****5678");
    });

    it("PATCH 带 apiKey → 轮换掩码", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/models/${modelId}`).set(auth())
        .send({ apiKey: "sk-rotated9999" }).expect(200);
      expect(res.body.apiKeyMasked).toBe("sk-****9999");
    });

    it("POST /api/models/:id/test → 200 且 fake port 收到解密明文", async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/models/${modelId}/test`).set(auth()).expect(200);
      expect(() => TestModelResponseSchema.parse(res.body)).not.toThrow();
      expect(res.body.ok).toBe(true);
      expect(fakeModelProviderPort.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-rotated9999" }),
      );
      await request(app.getHttpServer()).post("/api/models/nope/test").set(auth()).expect(404);
    });

    it("POST /api/models/test（ad-hoc，保存前验活）→ 200", async () => {
      const { apiKey: _k, ...rest } = createBody;
      const res = await request(app.getHttpServer())
        .post("/api/models/test").set(auth())
        .send({ ...rest, apiKey: "sk-drafttest1234" }).expect(200);
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
```

OpenAPI 断言（`:574-594` describe 内）追加两行：

```ts
      expect(paths).toContain("/api/models/test");
      expect(paths).toContain("/api/models/{id}/test");
```

- [ ] **Step 7: 验证 e2e 通过** — Run: `pnpm --filter @codecrush/backend test`，Expected: 全 PASS（含 skeleton.e2e、encryption、adapter、service）。
- [ ] **Step 8: Commit** — `git add apps/backend && git commit -m "feat(backend): models 真实 CRUD + 密钥加密存储 + 连通性测试端点"`

---

### Story 6: 前端接通（client + ModelsPage + mocks 清理 + App.test）

**Files:**
- Modify: `apps/frontend/src/api/client.ts`、`apps/frontend/src/pages/admin/ModelsPage.tsx`、`apps/frontend/src/mocks/models.ts`、`apps/frontend/src/app/App.test.tsx`

**Interfaces:**
- Consumes：Story 5 的 HTTP 端点、Story 1 契约类型。
- Produces：`createModel(req: CreateModelRequest): Promise<ModelProvider>`、`updateModel(id, req: UpdateModelRequest): Promise<ModelProvider>`、`deleteModel(id): Promise<void>`、`testModel(id): Promise<TestModelResponse>`、`testModelConfig(req: TestModelRequest): Promise<TestModelResponse>`。

**Tier:** standard

- [ ] **Step 1: 写失败测试** — `App.test.tsx` 在 PromptsPage 用例（`:68-92`）后追加（同范式）：

```tsx
it("loads ModelsPage from real /api/models on /admin/models (M3)", async () => {
  localStorage.setItem("token", "fake-token");
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _opts?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.includes("/api/models")) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={["/admin/models"]}>
      <App />
    </MemoryRouter>,
  );
  // 空态出现 = 页面消费了 API 响应（不再渲染本地 LLM_ROWS）
  expect(await screen.findByText(/暂无模型/)).toBeInTheDocument();
  await waitFor(() => {
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => u.includes("/api/models"))).toBe(true);
  });
});
```

- [ ] **Step 2: 验证失败** — Run: `pnpm --filter @codecrush/frontend test`，Expected: 新用例 FAIL（页面渲染 LLM_ROWS mock，无"暂无模型"空态）。

- [ ] **Step 3: client.ts** — models 段（`:118-120`）扩为：

```ts
// models — @Controller("models")
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
export async function testModel(id: string): Promise<TestModelResponse> {
  const resp = await apiFetch(`/api/models/${encodeURIComponent(id)}/test`, { method: "POST" });
  if (!resp.ok) throw new Error(`test model failed: ${resp.status} ${resp.statusText}`);
  return TestModelResponseSchema.parse(await resp.json());
}
export const testModelConfig = (req: TestModelRequest): Promise<TestModelResponse> =>
  postJson("/api/models/test", req, TestModelRequestSchema, TestModelResponseSchema);
```

头部 import 追加：`CreateModelRequestSchema, type CreateModelRequest, ModelProviderSchema, type ModelProvider, TestModelRequestSchema, type TestModelRequest, TestModelResponseSchema, type TestModelResponse, UpdateModelRequestSchema, type UpdateModelRequest`。

- [ ] **Step 4: mocks/models.ts 改造** — 删除 `LLM_ROWS`、`LlmRow`、本地 `ModelType`；改为：

```ts
import type { ModelType } from "@codecrush/contracts";
import type { TagKey } from "./agents";

/** 模型接入页 UI 常量（非数据 mock）：类型文案 / provider 候选 / baseUrl placeholder / 参数提示。 */

export const TYPE_LABEL: Record<ModelType, string> = {
  llm: "LLM",
  embedding: "Embedding",
  rerank: "Rerank",
};

export interface ModelTypeDef {
  hint: string;
  tag: TagKey;
  provs: string[];
  namePh: string;
  base: string; // 根形态 URL；adapter 拼 canonical 路径（/chat/completions | /embeddings | /rerank）
  paramLabel: string;
  params: { k: string; v: string }[];
}

export const MODEL_TYPES: Record<ModelType, ModelTypeDef> = {
  llm: { hint: "生成 · 改写 · 意图", tag: "blue", provs: ["DeepSeek", "阿里云", "OpenAI", "智谱", "自部署"], namePh: "deepseek-chat", base: "https://api.deepseek.com/v1", paramLabel: "默认生成参数", params: [{ k: "temperature", v: "0.3" }, { k: "max_tokens", v: "2048" }] },
  rerank: { hint: "召回结果重排", tag: "purple", provs: ["自部署", "Jina", "Cohere", "阿里云"], namePh: "bge-reranker-v2-m3", base: "http://infra.internal:8080", paramLabel: "重排参数", params: [{ k: "top_n", v: "5" }, { k: "score 阈值", v: "0.65" }] },
  embedding: { hint: "文本向量嵌入", tag: "cyan", provs: ["自部署", "OpenAI", "Jina", "智谱"], namePh: "bge-m3", base: "http://infra.internal:8080", paramLabel: "向量参数", params: [{ k: "维度", v: "1024" }, { k: "归一化", v: "是" }] },
};

export const MODEL_TABS: Array<{ key: "all" | ModelType; label: string }> = [
  { key: "all", label: "全部" },
  { key: "llm", label: "LLM" },
  { key: "rerank", label: "Rerank" },
  { key: "embedding", label: "Embedding" },
];

/** 接入/编辑模型抽屉表单。 */
export interface ModelDraft {
  id?: string; // 有值 = 编辑模式
  type: ModelType;
  provider: string;
  name: string;
  baseUrl: string;
  apiKey: string; // 编辑模式留空 = 不改
}
```

- [ ] **Step 5: ModelsPage.tsx 重写数据层**（保持既有样式对象与布局 JSX 不动，替换状态与交互；参照 PromptsPage 范式 `PromptsPage.tsx:86-130`）。关键结构：

```tsx
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ModelProvider, ModelType, TestModelResponse } from "@codecrush/contracts";
import { createModel, deleteModel, getModels, testModel, testModelConfig, updateModel } from "../../api/client";
import { MODEL_TABS, MODEL_TYPES, TYPE_LABEL, type ModelDraft } from "../../mocks/models";
import { tagOf } from "../../mocks/agents";

export default function ModelsPage() {
  const [rows, setRows] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState("");
  const [tab, setTab] = useState<"all" | ModelType>("all");
  const [busyId, setBusyId] = useState<string | null>(null); // 行级开关/测试/删除防连点
  const [rowTest, setRowTest] = useState<Record<string, TestModelResponse>>({}); // 行内测试结果
  const [open, setOpen] = useState(false);
  const [mf, setMf] = useState<ModelDraft>({ type: "llm", provider: MODEL_TYPES.llm.provs[0], name: "", baseUrl: MODEL_TYPES.llm.base, apiKey: "" });
  const [editingMasked, setEditingMasked] = useState(""); // 编辑模式旁显掩码
  const [mfErr, setMfErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testErr, setTestErr] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setListErr("");
    try { setRows(await getModels()); }
    catch (e) { setListErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = rows.filter(r => tab === "all" || r.type === tab);

  const toggle = async (r: ModelProvider) => {
    setBusyId(r.id);
    try { await updateModel(r.id, { enabled: !r.enabled }); await refresh(); }
    catch (e) { setListErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusyId(null); }
  };

  const runRowTest = async (r: ModelProvider) => {
    setBusyId(r.id);
    try { setRowTest(prev => ({ ...prev, [r.id]: undefined as never })); const res = await testModel(r.id); setRowTest(prev => ({ ...prev, [r.id]: res })); }
    catch (e) { setRowTest(prev => ({ ...prev, [r.id]: { ok: false, error: e instanceof Error ? e.message : String(e) } })); }
    finally { setBusyId(null); }
  };

  const remove = async (r: ModelProvider) => {
    if (!window.confirm(`确认删除模型「${r.name}」？`)) return;
    setBusyId(r.id);
    try { await deleteModel(r.id); await refresh(); }
    catch (e) { setListErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusyId(null); }
  };

  const openCreate = () => { /* 重置 mf 为 llm 默认、editingMasked=""、testState=idle、open=true */ };
  const openEdit = (r: ModelProvider) => {
    setMf({ id: r.id, type: r.type, provider: r.provider, name: r.name, baseUrl: r.baseUrl, apiKey: "" });
    setEditingMasked(r.apiKeyMasked);
    setTestState("idle"); setMfErr(""); setOpen(true);
  };

  const drawerTest = async () => {
    // 编辑模式且未填新 key：走已存 key 的 testModel(id)；否则 ad-hoc testModelConfig
    if (!mf.name.trim()) { setMfErr("请填写模型名称 / 部署 ID"); return; }
    setTestState("testing"); setTestErr("");
    try {
      const res = mf.id && !mf.apiKey.trim()
        ? await testModel(mf.id)
        : await testModelConfig({ type: mf.type, provider: mf.provider, name: mf.name.trim(), baseUrl: mf.baseUrl.trim(), apiKey: mf.apiKey });
      setTestState(res.ok ? "ok" : "fail");
      if (!res.ok) setTestErr(res.error ?? "连接失败");
    } catch (e) { setTestState("fail"); setTestErr(e instanceof Error ? e.message : String(e)); }
  };

  const save = async () => {
    if (!mf.name.trim()) { setMfErr("请填写模型名称 / 部署 ID"); return; }
    if (!mf.id && mf.apiKey.trim().length < 8) { setMfErr("请填写 API Key（至少 8 位）"); return; }
    setSaving(true);
    try {
      if (mf.id) {
        await updateModel(mf.id, {
          type: mf.type, provider: mf.provider, name: mf.name.trim(), baseUrl: mf.baseUrl.trim(),
          ...(mf.apiKey.trim() ? { apiKey: mf.apiKey } : {}),
        });
      } else {
        await createModel({ type: mf.type, provider: mf.provider, name: mf.name.trim(), baseUrl: mf.baseUrl.trim(), apiKey: mf.apiKey, enabled: true });
      }
      setOpen(false);
      await refresh();
      setTab(mf.type);
    } catch (e) { setMfErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  // ...JSX：沿用原布局。改动点：
  // - tabs 遍历 MODEL_TABS（key/label），计数 rows.filter(r => t.key === "all" || r.type === t.key).length
  // - 行渲染：r.name / TYPE_LABEL[r.type]（tag 色 MODEL_TYPES[r.type].tag）/ r.provider /
  //   用途列 MODEL_TYPES[r.type].hint / 开关 r.enabled + onClick toggle / 行内 测试|编辑|删除
  // - 行内测试结果：rowTest[r.id] 显示 ✓ latencyMs 或 ✗ error（title 提示）
  // - loading 态与空态：`加载中…` / `暂无模型`（App.test 断言依赖"暂无模型"文案）
  // - listErr 顶部红条展示
  // - 抽屉：类型卡片 pickType 用 MODEL_TYPES[ty].base/provs 重置；编辑模式 API Key 字段
  //   placeholder=`不修改则留空（当前 ${editingMasked}）`；底部测试按钮按 testState 显示
  //   `⚡ 测试连接 | 测试中… | ✓ 连接正常 | ✗ ${testErr}`；「接入/保存」按钮 saving 防连点
}
```

- [ ] **Step 6: 验证通过** — Run: `pnpm --filter @codecrush/frontend test`，Expected: 全 PASS（新 ModelsPage 用例 + 既有用例）。再 Run: `pnpm --filter @codecrush/frontend build`，Expected: PASS（无残留 LLM_ROWS 引用——`grep -rn "LLM_ROWS\|LLM_TABS" apps/frontend/src` 应无命中）。
- [ ] **Step 7: Commit** — `git add apps/frontend && git commit -m "feat(frontend): ModelsPage 接真实 /api/models 全交互（接入/测试/开关/编辑/删除）"`

---

### Story 7: 收尾验证 + 文档

**Files:**
- Modify（如有出入）: `.ship/tasks/m3/dev-ledger.md`（由 /ship:dev 维护）
- Verify only: 全仓构建/测试/lint、OpenAPI、迁移

**Interfaces:** 无新接口；纯验证。

**Tier:** mechanical

- [ ] **Step 1: 全仓验证** — Run: `pnpm test && pnpm lint && pnpm build`，Expected: 全 PASS，lint 边界 0 违规。
- [ ] **Step 2: 迁移复核** — Run: `pnpm db:migrate`，Expected: 幂等通过（依赖 `docker compose -f infra/docker-compose.yml --profile infra up -d --wait`）。
- [ ] **Step 3: OpenAPI 冒烟** — 本地起后端（`.env` 已含真实 `MODEL_API_KEY_ENCRYPTION_KEY`），`curl -s localhost:3000/api/docs-json | node -e "const p=Object.keys(JSON.parse(require('fs').readFileSync(0)).paths); for (const k of ['/api/models','/api/models/{id}','/api/models/test','/api/models/{id}/test']) if (!p.includes(k)) { console.error('missing', k); process.exit(1); } console.log('openapi ok')"`，Expected: `openapi ok`。
- [ ] **Step 4: 手工验收（AC 1-6 冒烟）** — 前端起 dev，注册一个真实可达模型（如 DeepSeek），抽屉"测试连接"通过 → 接入 → 列表掩码显示 → 开关/编辑/删除各操作一遍。DB 里 `select api_key_enc from model_providers` 确认 `v1:` 密文。
- [ ] **Step 5: Commit（如有收尾改动）** — `git add -A && git commit -m "chore(m3): 收尾验证与文档"`

---

## Host 自查（轻量对抗——代替 execution drill，理由：M3 为配置型任务，CLAUDE.md 分级）

| 检查项 | 结论 |
|---|---|
| AC 全覆盖？ | AC1-5 → Story 5（e2e+service spec）；AC6 → Story 6；AC7 → Story 3；AC8 → Story 7；AC9 → Story 2；AC10 → Story 5 OpenAPI 断言 + Story 7 冒烟 |
| Story 依赖序 | 1（契约）→ 2（加密）→ 3（DB/repo）→ 4（port/adapter）→ 5（service/controller/e2e，汇聚 1-4）→ 6（前端，靠 1+5）→ 7（收尾）。无环 |
| 破坏性变更覆盖 | 契约演进 → Story 1 更新 m2-schemas；env 必填 → Story 2 更新 config.schema.spec；models e2e → Story 5 重写（非软化）。Story 1 后全仓短暂红（backend/frontend 未适配），Story 5/6 恢复——dev 按 story 顺序执行时仅跑本包测试即可 |
| 类型一致性 | `ModelCallConfig`/`TestModelResult`（Story 4）与 service 消费（Story 5）字段一致；`TestModelResponse` 契约（Story 1）与 service 返回映射一致；in-memory repo 签名与 `ModelsRepository`（Story 3）一致；掩码 `sk-test12345678`→`sk-****5678` 在 Story 2/5 测试断言中一致 |
| 加密不变量 | Story 2 spec 覆盖往返/随机 iv/错 key/篡改/非 v1/短主密钥；e2e 断言响应序列化不含明文；adapter error 脱敏断言（Story 4） |
| 不真打外网 | Story 4 mock 全局 fetch；Story 5 e2e override MODEL_PROVIDER_PORT |
| e2e ENCRYPTION 解析 | TestingModule imports SecurityModule（token 注册）+ overrideProvider(ENCRYPTION) 固定 key 实例（override 替换 factory，不再需要 AppConfigService） |
| 路由遮蔽 | `@Post("test")` 声明在参数路由前；GET/PATCH/DELETE `:id` 与 POST `test` 方法不同不冲突 |
| 边界 lint | 前端只 import contracts；跨模块只经 barrel/token；无 adapters/ 直接 import（Story 5 module 内 useClass 合法） |
| 已知妥协 | repo.findById 收非 uuid 字符串时 PG 报 22P02（500 而非 404）——与 prompts 现状一致，不在 M3 修；e2e 用 in-memory repo 不碰真 PG（与 skeleton.e2e 现状一致） |

**自查结论**：plan 可执行。实现时的两个确认点：① zod v4 下 `CreateModelRequestSchema.partial()` 对带 `.default(true)` 的 `enabled` 产生 optional 行为（预期 `{}` 合法）——Story 1 测试已覆盖，若 zod 行为有出入按测试修 schema 写法（如 Update 基于 omit(default 字段) 再 extend）；② jest mock `global.fetch` 在 Node 22 类型上需 `as unknown as typeof fetch` cast（Story 4 测试已带）。
