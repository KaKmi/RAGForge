# M6 Plan — Prompt 管理

> 基于 diff 后的 `spec.md`（含 D2/D5/D6/D8/D9/D15/D16 应用）。轻量对抗模式（CLAUDE.md）：跳过 execution drill，host 自查代替。
> 6 个 story，按依赖顺序。每个 story 内 TDD（先红后绿）。`pnpm test` + `pnpm lint` 每个 story 收尾必跑。
> 基线分支：`design/m3-m6` @ `feat/m2-app-shell` (75e9b61)。

---

## Story 1 — 契约修订 + 共享纯逻辑（contracts）+ 测试

> 前后端单一来源。schema 演进（`currentVersionId` nullable、`author` 必填来自 JWT、读侧加 `updatedAt/updatedBy/createdAt`、新增 `CreatePromptRequestSchema` + publish/rollback 响应）；共享纯函数（`extractVars/renderTemplate/diffPromptBodies`）落 contracts 内（003 §Isomorphic 双端锁一致）。后端 skeleton 与前端 mock 都依赖它，最先做。

### 步骤

- [ ] **红**：写 `packages/contracts/src/prompt-template.test.ts`（vitest）：
  ```ts
  import { describe, expect, it } from "vitest";
  import { diffPromptBodies, extractVars, renderTemplate } from "./prompt-template";

  describe("extractVars", () => {
    it("去重保序", () => {
      expect(extractVars("{question} {context} {question}")).toEqual(["question", "context"]);
    });
    it("空串 → []", () => {
      expect(extractVars("")).toEqual([]);
    });
    it("无占位符 → []", () => {
      expect(extractVars("没有变量")).toEqual([]);
    });
    it("支持字母数字下划线", () => {
      expect(extractVars("{var_1} {var2}")).toEqual(["var_1", "var2"]);
    });
  });

  describe("renderTemplate", () => {
    it("用值替换占位符", () => {
      expect(renderTemplate("Hi {name}", { name: "X" })).toBe("Hi X");
    });
    it("缺变量保留占位符", () => {
      expect(renderTemplate("Hi {name}", {})).toBe("Hi {name}");
    });
    it("多变量", () => {
      expect(renderTemplate("{a}/{b}", { a: "1", b: "2" })).toBe("1/2");
    });
  });

  describe("diffPromptBodies", () => {
    it("行级 LCS", () => {
      expect(diffPromptBodies("a\nb", "a\nc")).toEqual([
        { type: "same", text: "a" },
        { type: "del", text: "b" },
        { type: "add", text: "c" },
      ]);
    });
    it("完全相同 → all same", () => {
      expect(diffPromptBodies("x\ny", "x\ny")).toEqual([
        { type: "same", text: "x" },
        { type: "same", text: "y" },
      ]);
    });
    it("新增行 → add", () => {
      expect(diffPromptBodies("a", "a\nb")).toEqual([
        { type: "same", text: "a" },
        { type: "add", text: "b" },
      ]);
    });
  });
  ```
  先跑应失败（文件未建）。
- [ ] **绿**：写 `packages/contracts/src/prompt-template.ts`（spec §2 + 迁自 mocks/prompts.ts:180-210 lineDiff 逐字照搬）：
  ```ts
  const VAR_RE = /\{(\w+)\}/g; // {var_name}，字母数字下划线

  /** 解析 body 中的 {var} 占位符（去重，保序）。 */
  export function extractVars(body: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of body?.matchAll?.(VAR_RE) ?? []) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    return out;
  }

  /** 用值替换 {var} 占位符；缺变量保留占位符。 */
  export function renderTemplate(body: string, vars: Record<string, string>): string {
    return body.replace(VAR_RE, (_, k) => vars[k] ?? `{${k}}`);
  }

  export type DiffLine = { type: "same" | "add" | "del"; text: string };

  /** 行级 LCS diff（迁自前端 mocks/prompts.ts lineDiff，前后端共用）。 */
  export function diffPromptBodies(a: string, b: string): DiffLine[] {
    const A = (a || "").split("\n");
    const B = (b || "").split("\n");
    const m = A.length;
    const n = B.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (A[i] === B[j]) {
        out.push({ type: "same", text: A[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: "del", text: A[i] });
        i++;
      } else {
        out.push({ type: "add", text: B[j] });
        j++;
      }
    }
    while (i < m) out.push({ type: "del", text: A[i++] });
    while (j < n) out.push({ type: "add", text: B[j++] });
    return out;
  }
  ```
- [ ] **红**：改 `packages/contracts/src/m2-schemas.test.ts`：
  - `valid.prompt` 加 `updatedAt: "2026-07-01T00:00:00.000Z"` + `updatedBy: "demo@codecrush.local"`（D16）。
  - `valid.promptVersion` 加 `createdAt: "2026-07-01T00:00:00.000Z"`（D16）+ 确认 `author` 已存在（现有 fixture 有 `author:"admin"`，D6 后必填，保留）。
  - 正例："PromptSchema accepts currentVersionId:null"：`expect(PromptSchema.parse({ ...valid.prompt, currentVersionId: null }).currentVersionId).toBeNull()`。
  - 正例："PromptSchema accepts currentVersionId undefined? 不"——`currentVersionId` 改 nullable 但仍 required（`.nullable()` 非 `.optional()`）：`expect(() => PromptSchema.parse({ ...valid.prompt, currentVersionId: undefined })).toThrow()`。
  - 反例："PromptSchema rejects missing updatedAt/updatedBy"（D16）：`expect(() => PromptSchema.parse({ id:"p", name:"n", node:"rewrite", currentVersionId:null })).toThrow()`。
  - 反例："PromptVersionSchema rejects missing createdAt"（D16）。
  - 新增 `valid.createPromptReq = { name:"新 Prompt", node:"rewrite", body:"你好 {query}", note:"test" }`。
  - 正例："CreatePromptRequestSchema accepts"：`expect(CreatePromptRequestSchema.parse(valid.createPromptReq).name).toBe("新 Prompt")`。
  - 反例："CreatePromptRequestSchema rejects missing body/name/node"：各缺一次 throw。
  - 改现有 "CreatePromptVersionRequestSchema omits id/promptId/version/status"（L323-336）：`rest` 改用 `{ body:"新版本...", note:"n" }`（删 `variables` 与 `author`——D6/D5：variables 服务端抽、author 服务端填）。断言 `parsed.body` 存在 + `(parsed as Record<string, unknown>).variables` undefined + `(parsed as Record<string, unknown>).author` undefined（请求 schema 不含此二字段）。
  先跑应失败（schema 未改）。
- [ ] **绿**：改 `packages/contracts/src/prompts.ts`（spec §1 完整代码，逐字照搬）：
  ```ts
  import { z } from "zod";

  export const PromptNodeSchema = z.enum(["rewrite", "intent", "reply", "fallback"]);
  export type PromptNode = z.infer<typeof PromptNodeSchema>;

  export const PromptVersionStatusSchema = z.enum(["draft", "prod", "archived"]);
  export type PromptVersionStatus = z.infer<typeof PromptVersionStatusSchema>;

  export const PromptSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    node: PromptNodeSchema,
    currentVersionId: z.string().min(1).nullable(),
    updatedAt: z.string().datetime(),
    updatedBy: z.string().min(1),
  });
  export type Prompt = z.infer<typeof PromptSchema>;

  export const PromptVersionSchema = z.object({
    id: z.string().min(1),
    promptId: z.string().min(1),
    version: z.number().int().positive(),
    body: z.string().min(1),
    variables: z.array(z.string()),
    note: z.string().optional(),
    author: z.string().min(1),
    status: PromptVersionStatusSchema,
    createdAt: z.string().datetime(),
  });
  export type PromptVersion = z.infer<typeof PromptVersionSchema>;

  export const PromptVersionListResponseSchema = z.array(PromptVersionSchema);
  export type PromptVersionListResponse = z.infer<typeof PromptVersionListResponseSchema>;

  export const PromptListResponseSchema = z.array(PromptSchema);
  export type PromptListResponse = z.infer<typeof PromptListResponseSchema>;

  export const CreatePromptRequestSchema = z.object({
    name: z.string().min(1),
    node: PromptNodeSchema,
    body: z.string().min(1),
    note: z.string().optional(),
  });
  export type CreatePromptRequest = z.infer<typeof CreatePromptRequestSchema>;

  export const CreatePromptVersionRequestSchema = z.object({
    body: z.string().min(1),
    note: z.string().optional(),
  });
  export type CreatePromptVersionRequest = z.infer<typeof CreatePromptVersionRequestSchema>;

  export const PublishPromptVersionResponseSchema = PromptVersionSchema;
  export type PublishPromptVersionResponse = z.infer<typeof PublishPromptVersionResponseSchema>;
  ```
- [ ] 改 `packages/contracts/src/index.ts`：追加 `export * from "./prompt-template";`。
- [ ] **绿**：`pnpm --filter @codecrush/contracts test` 全绿（含 prompt-template.test.ts + m2-schemas.test.ts 更新）。
- [ ] **绿**：`pnpm --filter @codecrush/contracts build` 成功。
- [ ] 提交：`feat(contracts): evolve prompt schemas + add shared prompt-template pure functions for M6`

**验证**：`pnpm lint` 0 违规（prompt-template 是纯函数零 zod 依赖；prompts.ts 仅 zod）。`extractVars` 去重保序；`diffPromptBodies` 行级 LCS 对齐原前端 lineDiff。

---

## Story 2 — DB schema + 迁移（prompts + prompt_versions 两表）

> 真实持久化地基。`variables` jsonb（001:88）+ `unique(promptId,version)`（D8）+ `index(promptId,status)` + `updated_by`（D16）。

### 步骤

- [ ] 写 `apps/backend/src/modules/prompts/schema.ts`（spec §3 完整代码）：
  ```ts
  import { integer, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

  export const prompts = pgTable("prompts", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    node: text("node").notNull(),
    currentVersionId: uuid("current_version_id"),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  });

  export const promptVersions = pgTable(
    "prompt_versions",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      promptId: uuid("prompt_id").notNull().references(() => prompts.id, { onDelete: "cascade" }),
      version: integer("version").notNull(),
      body: text("body").notNull(),
      variables: jsonb("variables").notNull().default([]).$type<string[]>(),
      note: text("note"),
      author: text("author").notNull(),
      status: text("status").notNull().default("draft"),
      createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (t) => ({
      uniqPromptVersion: uniqueIndex("prompt_versions_prompt_id_version_idx").on(t.promptId, t.version),
      promptStatusIdx: index("prompt_versions_prompt_id_status_idx").on(t.promptId, t.status),
    }),
  );
  export type PromptRow = typeof prompts.$inferSelect;
  export type NewPrompt = typeof prompts.$inferInsert;
  export type PromptVersionRow = typeof promptVersions.$inferSelect;
  export type NewPromptVersion = typeof promptVersions.$inferInsert;
  ```
  **域内 schema 零 service 引用（003 不变量 5/AGENTS.md 不变量 8）。**
- [ ] 改 `apps/backend/src/db/schema.ts` barrel：追加 `export * from "../modules/prompts/schema";`。
- [ ] 生成迁移：`pnpm db:generate` → 生成 `apps/backend/drizzle/<ts>_*.sql`，内容含 `CREATE TABLE "prompts" (...)` + `CREATE TABLE "prompt_versions" (...)` + `CREATE UNIQUE INDEX "prompt_versions_prompt_id_version_idx"` + `CREATE INDEX "prompt_versions_prompt_id_status_idx"`。人工 review SQL。
- [ ] 启动依赖并应用迁移：
  ```bash
  docker compose -f infra/docker-compose.yml --profile infra up -d --wait
  pnpm db:migrate
  ```
- [ ] **验证 TS**：`pnpm --filter @codecrush/backend exec tsc --noEmit` 0 错误。
- [ ] 提交：`feat(backend): add prompts + prompt_versions tables with unique/index + updatedBy`

**验证**：`docker compose exec postgres psql -U postgres -d codecrush -c '\d prompt_versions'` 显示 `variables jsonb` + unique index + status index。

---

## Story 3 — PromptsRepository + PromptsService 重写 + service spec

> repo 持久化（含 `publishVersion` 事务 + `updated_by` 刷新）；service 用 `extractVars` 抽变量、`actorEmail` 填 author/updatedBy、`promote` 委托事务、已 prod → 409、并发撞号 retry 一次。

### 步骤

- [ ] 写 `apps/backend/src/modules/prompts/prompts.repository.ts`：
  ```ts
  import { Inject, Injectable } from "@nestjs/common";
  import { and, eq, ne } from "drizzle-orm";
  { /* drizzle queries */ }
  ```
  完整实现：
  ```ts
  import { Inject, Injectable } from "@nestjs/common";
  import { and, eq, ne } from "drizzle-orm";
  import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
  import type { DB } from "../../platform/persistence/persistence.module";
  import { prompts, promptVersions, type NewPrompt, type NewPromptVersion, type PromptRow, type PromptVersionRow } from "./schema";

  @Injectable()
  export class PromptsRepository {
    constructor(@Inject(DRIZZLE) private readonly db: DB) {}

    async findPrompts(): Promise<PromptRow[]> {
      return await this.db.select().from(prompts);
    }
    async findPromptById(id: string): Promise<PromptRow | undefined> {
      const rows = await this.db.select().from(prompts).where(eq(prompts.id, id)).limit(1);
      return rows[0];
    }
    async insertPrompt(row: NewPrompt): Promise<PromptRow> {
      const rows = await this.db.insert(prompts).values(row).returning();
      return rows[0];
    }
    async findVersions(promptId: string): Promise<PromptVersionRow[]> {
      return await this.db.select().from(promptVersions).where(eq(promptVersions.promptId, promptId));
    }
    async findVersionById(versionId: string): Promise<PromptVersionRow | undefined> {
      const rows = await this.db.select().from(promptVersions).where(eq(promptVersions.id, versionId)).limit(1);
      return rows[0];
    }
    async insertVersion(row: NewPromptVersion): Promise<PromptVersionRow> {
      const rows = await this.db.insert(promptVersions).values(row).returning();
      return rows[0];
    }
    async findProdVersion(promptId: string): Promise<PromptVersionRow | undefined> {
      const rows = await this.db
        .select()
        .from(promptVersions)
        .where(and(eq(promptVersions.promptId, promptId), eq(promptVersions.status, "prod")))
        .limit(1);
      return rows[0];
    }
    // 发布事务：archive 旧 prod + set 新 prod + 更新 prompt.currentVersionId + updatedBy + updatedAt（D16）
    async publishVersion(
      promptId: string,
      versionId: string,
      actorEmail: string,
    ): Promise<PromptVersionRow> {
      return await this.db.transaction(async (tx) => {
        await tx
          .update(promptVersions)
          .set({ status: "archived" })
          .where(and(eq(promptVersions.promptId, promptId), eq(promptVersions.status, "prod")));
        await tx.update(promptVersions).set({ status: "prod" }).where(eq(promptVersions.id, versionId));
        await tx
          .update(prompts)
          .set({ currentVersionId: versionId, updatedBy: actorEmail, updatedAt: new Date() })
          .where(eq(prompts.id, promptId));
        const rows = await tx
          .select()
          .from(promptVersions)
          .where(eq(promptVersions.id, versionId))
          .limit(1);
        return rows[0];
      });
    }
  }
  ```
  **注意**：`findProdVersion` 暂未用（service 在 promote 内直接读 version by id 判 status）——若 lint 报 unused，删之或保留供未来查询。**优先保留**（M7/M8 列版本可能用）。若 ESLint workspace 规则禁 unused method，加 `// eslint-disable-next-line` 或删除。dev 时按 lint 调整。`ne` import 若不用也删。
- [ ] **红**：写 `apps/backend/src/modules/prompts/prompts.service.spec.ts`：mock repo（`jest.fn()` per method）+ real `extractVars`（纯函数直接 import）。
  ```ts
  import { ConflictException, NotFoundException } from "@nestjs/common";
  import { extractVars } from "@codecrush/contracts";
  { /* mock repo */ }
  ```
  用例：
  - "createPrompt → repo.insertPrompt 收到 updatedBy=actorEmail + currentVersionId:null；repo.insertVersion 收到 variables=extractVars(body) + author=actorEmail + status:'draft' + version:1"。
  - "createVersion → max+1（mock repo.findVersions 返 [v1,v3] → next=4）"。
  - "createVersion 并发撞 unique → retry 一次成功"：mock `insertVersion` 首次抛 `{ code: "23505" }`、第二次返 row，断言返成功 + `insertVersion` 调 2 次。
  - "createVersion retry 仍冲突 → ConflictException"：mock `insertVersion` 两次均抛 `{ code: "23505" }`，断言 throw ConflictException。
  - "createVersion 非 unique 错误 → 直接抛（不 retry）"：mock 抛 `Error("boom")`，断言 throw 且 `insertVersion` 调 1 次。
  - "promote draft→prod → repo.publishVersion 收到 (promptId, versionId, actorEmail)"：断言 mock `publishVersion` 调用参数。
  - "promote 已 prod → ConflictException"：mock `findVersionById` 返 `{ status: "prod", promptId }`，断言 throw。
  - "promote 版本不属于该 prompt → NotFoundException"：mock `findVersionById` 返 `{ promptId: "other" }`。
  - "promote 版本不存在 → NotFoundException"：mock `findVersionById` 返 undefined。
  - "toPrompt 把 updatedAt.toISOString() + updatedBy 映射"：mock repo 返 row 含 `updatedAt: new Date("2026-07-01")`，断言 list 结果 `updatedAt === "2026-07-01T00:00:00.000Z"`。
  - "toVersion 把 createdAt.toISOString() 映射"。
  - "createPrompt/createVersion 不接受请求体 author/variables"（D6/D5 防回归）：service 调 `extractVars(req.body)` 而非 `req.variables`；断言 `insertVersion` 收到的 variables === `extractVars(body)` 而非 req 传入值。
  先跑应失败（service 未改）。
- [ ] **绿**：写 `apps/backend/src/modules/prompts/prompts.service.ts`（spec §5 完整代码，逐字照搬 + D16 应用）：
  ```ts
  import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
  import { extractVars, type Prompt, type PromptVersion } from "@codecrush/contracts";
  import type {
    CreatePromptRequest,
    CreatePromptVersionRequest,
  } from "@codecrush/contracts";
  import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
  import type { DB } from "../../platform/persistence/persistence.module";
  import { PromptsRepository } from "./prompts.repository";
  import type { PromptRow, PromptVersionRow } from "./schema";

  @Injectable()
  export class PromptsService {
    constructor(
      @Inject(DRIZZLE) private readonly db: DB,
      private readonly repo: PromptsRepository,
    ) {}

    async list(): Promise<Prompt[]> {
      return (await this.repo.findPrompts()).map(toPrompt);
    }
    async get(id: string): Promise<Prompt> {
      const r = await this.repo.findPromptById(id);
      if (!r) throw new NotFoundException(`prompt ${id} not found`);
      return toPrompt(r);
    }
    async createPrompt(req: CreatePromptRequest, actorEmail: string): Promise<Prompt> {
      const p = await this.repo.insertPrompt({
        name: req.name,
        node: req.node,
        currentVersionId: null,
        updatedBy: actorEmail,
      });
      await this.repo.insertVersion({
        promptId: p.id,
        version: 1,
        body: req.body,
        variables: extractVars(req.body),
        note: req.note,
        author: actorEmail,
        status: "draft",
      });
      return toPrompt(p);
    }
    async listVersions(promptId: string): Promise<PromptVersion[]> {
      await this.get(promptId);
      return (await this.repo.findVersions(promptId)).map(toVersion);
    }
    async createVersion(
      promptId: string,
      req: CreatePromptVersionRequest,
      actorEmail: string,
    ): Promise<PromptVersion> {
      await this.get(promptId);
      for (let attempt = 0; attempt < 2; attempt++) {
        const next = (await this.repo.findVersions(promptId)).reduce(
          (m, v) => Math.max(m, v.version),
          0,
        ) + 1;
        try {
          const row = await this.repo.insertVersion({
            promptId,
            version: next,
            body: req.body,
            variables: extractVars(req.body),
            note: req.note,
            author: actorEmail,
            status: "draft",
          });
          return toVersion(row);
        } catch (e) {
          if (isUniqueViolation(e) && attempt === 0) continue;
          throw e;
        }
      }
      throw new ConflictException("version 冲突，重试失败");
    }
    async promote(
      promptId: string,
      versionId: string,
      actorEmail: string,
    ): Promise<PromptVersion> {
      const v = await this.repo.findVersionById(versionId);
      if (!v || v.promptId !== promptId) throw new NotFoundException(`version ${versionId} not found`);
      if (v.status === "prod") throw new ConflictException("该版本已是生产版本");
      return toVersion(await this.repo.publishVersion(promptId, versionId, actorEmail));
    }
  }

  function toPrompt(row: PromptRow): Prompt {
    return {
      id: row.id,
      name: row.name,
      node: row.node as Prompt["node"],
      currentVersionId: row.currentVersionId ?? null,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }

  function toVersion(row: PromptVersionRow): PromptVersion {
    return {
      id: row.id,
      promptId: row.promptId,
      version: row.version,
      body: row.body,
      variables: row.variables,
      note: row.note ?? undefined,
      author: row.author,
      status: row.status as PromptVersion["status"],
      createdAt: row.createdAt.toISOString(),
    };
  }

  function isUniqueViolation(e: unknown): boolean {
    return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "23505";
  }
  ```
  **注意**：`createPrompt` 不用 `db.transaction`（spec 原文用，但简化为两步 insert 也可——若需原子性保留 transaction）。**优先保留 transaction**：改 `createPrompt` 用 `this.db.transaction(async (tx) => { ... })`，repo 方法接受可选 tx 参数或 service 直调 `tx.insert`。**简化决策**：M6 `createPrompt` 用 `db.transaction` 包两步 insert 保证原子（建 prompt + v1 draft 同生共死）。dev 时若 repo 方法不支持 tx 参数，service 内直调 `this.db.transaction(async (tx) => { const p = await tx.insert(prompts)...; await tx.insert(promptVersions)...; return p; })`（绕过 repo，仅此一处）。**plan 推荐**：service 内 transaction 直调 drizzle（不绕 repo），repo 仅暴露非事务方法。
- [ ] **绿**：`pnpm --filter @codecrush/backend test` 全绿（含 service spec）。
- [ ] 提交：`feat(backend): rewrite PromptsService with extractVars/actorEmail/promote + repository`

**验证**：`pnpm lint` 0 边界违规（repository/service 在域内 import platform DRIZZLE + contracts，依赖朝下）。service spec 覆盖 D6/D8/D15/D16 全部分歧点。

---

## Story 4 — Controller 扩展 + Module 接线 + e2e

> 接通 HTTP 层：建 Prompt、publish、rollback 三新端点 + `@Req() req: AuthedRequest` 取 author/actorEmail。

### 步骤

- [ ] 改 `apps/backend/src/modules/prompts/prompts.controller.ts`（spec §6 完整代码，逐字照搬 + D16 应用）：
  ```ts
  import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
  import { createZodDto } from "nestjs-zod";
  import {
    CreatePromptRequestSchema,
    CreatePromptVersionRequestSchema,
    type Prompt,
    type PromptVersion,
  } from "@codecrush/contracts";
  import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
  import { PromptsService } from "./prompts.service";

  class CreatePromptRequestDto extends createZodDto(CreatePromptRequestSchema) {}
  class CreatePromptVersionRequestDto extends createZodDto(CreatePromptVersionRequestSchema) {}

  type AuthedRequest = { user: AuthenticatedUser };

  @Controller("prompts")
  export class PromptsController {
    constructor(private readonly promptsService: PromptsService) {}

    @Get()
    list(): Promise<Prompt[]> {
      return this.promptsService.list();
    }

    @Get(":id")
    get(@Param("id") id: string): Promise<Prompt> {
      return this.promptsService.get(id);
    }

    @Post()
    @HttpCode(201)
    createPrompt(@Body() body: CreatePromptRequestDto, @Req() req: AuthedRequest): Promise<Prompt> {
      return this.promptsService.createPrompt(body, req.user.email);
    }

    @Get(":id/versions")
    listVersions(@Param("id") id: string): Promise<PromptVersion[]> {
      return this.promptsService.listVersions(id);
    }

    @Post(":id/versions")
    @HttpCode(201)
    createVersion(
      @Param("id") id: string,
      @Body() body: CreatePromptVersionRequestDto,
      @Req() req: AuthedRequest,
    ): Promise<PromptVersion> {
      return this.promptsService.createVersion(id, body, req.user.email);
    }

    @Post(":id/versions/:versionId/publish")
    @HttpCode(200)
    publish(@Param("id") id: string, @Param("versionId") versionId: string, @Req() req: AuthedRequest): Promise<PromptVersion> {
      return this.promptsService.promote(id, versionId, req.user.email);
    }

    @Post(":id/versions/:versionId/rollback")
    @HttpCode(200)
    rollback(@Param("id") id: string, @Param("versionId") versionId: string, @Req() req: AuthedRequest): Promise<PromptVersion> {
      return this.promptsService.promote(id, versionId, req.user.email);
    }
  }
  ```
- [ ] 改 `apps/backend/src/modules/prompts/prompts.module.ts`：
  ```ts
  import { Module } from "@nestjs/common";
  import { PromptsController } from "./prompts.controller";
  import { PromptsService } from "./prompts.service";
  import { PromptsRepository } from "./prompts.repository";

  @Module({
    controllers: [PromptsController],
    providers: [PromptsRepository, PromptsService],
    exports: [PromptsService],
  })
  export class PromptsModule {}
  ```
- [ ] **红**：改 `apps/backend/test/skeleton.e2e.spec.ts` prompts 块（非软化，是契约演进的合法更新）：
  - TestingModule `providers` 追加 `overrideProvider(PromptsRepository).useValue(inMemoryPromptsRepo)`（DB-free，对齐 skeleton.e2e 现状）。
  - inMemoryPromptsRepo（维护 `prompts` + `promptVersions` 两数组 + `updatedAt/updatedBy/createdAt` 字段以支持 D16 断言）：
    ```ts
    const inMemoryPrompts: PromptRow[] = [];
    const inMemoryVersions: PromptVersionRow[] = [];
    const inMemoryPromptsRepo = {
      findPrompts: async () => inMemoryPrompts,
      findPromptById: async (id: string) => inMemoryPrompts.find((p) => p.id === id),
      insertPrompt: async (row: NewPrompt) => {
        const r = { id: `p${inMemoryPrompts.length + 1}`, currentVersionId: null, createdAt: new Date(), updatedAt: new Date(), ...row } as PromptRow;
        inMemoryPrompts.push(r);
        return r;
      },
      findVersions: async (promptId: string) => inMemoryVersions.filter((v) => v.promptId === promptId),
      findVersionById: async (id: string) => inMemoryVersions.find((v) => v.id === id),
      insertVersion: async (row: NewPromptVersion) => {
        const r = { id: `pv${inMemoryVersions.length + 1}`, createdAt: new Date(), ...row } as PromptVersionRow;
        inMemoryVersions.push(r);
        return r;
      },
      publishVersion: async (promptId: string, versionId: string, actorEmail: string) => {
        // archive 旧 prod
        for (const v of inMemoryVersions) {
          if (v.promptId === promptId && v.status === "prod") v.status = "archived";
        }
        const v = inMemoryVersions.find((x) => x.id === versionId)!;
        v.status = "prod";
        const p = inMemoryPrompts.find((x) => x.id === promptId)!;
        p.currentVersionId = versionId;
        p.updatedBy = actorEmail;
        p.updatedAt = new Date();
        return v;
      },
    };
    ```
  - 改 "POST /api/prompts/p1/versions → 201"（L259-268）：body 改 `{body:"新版本..."}`（删 `variables` + `author`，D6/D5），断言 `res.body.variables` 非空含抽取 var + `res.body.author === PRINCIPAL.email` + `res.body.status === "draft"` + `res.body.version` 是 number。
  - 改 "GET /api/prompts/p1/versions"（L252-257）：若依赖 mock 数据 p1，现 inMemoryRepo 起空 → 先 POST 创建 prompt 再 GET versions。**改测试顺序**：先 POST /api/prompts 建一个 prompt（含 v1 draft），再测 GET versions / POST versions / publish / rollback。
  - 新增："POST /api/prompts → 201 + currentVersionId:null + updatedBy=JWT email"：
    ```ts
    const res = await request(app.getHttpServer())
      .post("/api/prompts")
      .set(auth())
      .send({ name: "测试 Prompt", node: "rewrite", body: "你好 {query}", note: "n" })
      .expect(201);
    expect(res.body.currentVersionId).toBeNull();
    expect(res.body.updatedBy).toBe(PRINCIPAL.email);
    expect(res.body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const promptId = res.body.id;
    ```
  - 新增："GET /api/prompts/:id/versions → v1 draft（variables 含 query）"：用上 promptId，GET versions → 至少 1 项，`v.status === "draft"` + `v.variables` 含 `"query"` + `v.author === PRINCIPAL.email` + `v.createdAt` 是 ISO datetime。
  - 新增："POST publish v1 → 200 + v1 prod + currentVersionId 指向 v1"：POST publish v1 → 200，`res.body.status === "prod"`，GET prompt → `currentVersionId` 非 null。
  - 新增："POST publish v1（已 prod）→ 409"（D15）。
  - 新增："建 v2 draft → POST publish v2 → 200 + v2 prod + v1 archived + updatedBy 推进"（D2 + D16）：建 v2，publish v2，断言 v2.status==="prod"、GET versions 里 v1.status==="archived"、GET prompt `currentVersionId` === v2.id、`updatedAt` 晚于建 prompt 时。
  - 新增："POST rollback v1（archived）→ 200 + v1 prod + v2 archived"（D2）：rollback v1，断言 v1.status==="prod"、v2.status==="archived"、`currentVersionId` === v1.id。
  - 新增："D6 不接受请求体 author"：POST versions 时 body 带 `author:"forged@evil.com"`，断言 `res.body.author === PRINCIPAL.email`（非 forged）。
  先跑应失败（controller 未改 / 测试体旧）。
- [ ] **绿**：`pnpm --filter @codecrush/backend test` 全绿（含 e2e prompts 块）。
- [ ] **绿**：`curl http://localhost:3000/api/docs-json | jq '.paths | keys'` 含 `POST /api/prompts`、`POST /api/prompts/{id}/versions/{versionId}/publish`、`POST .../rollback`。
- [ ] 提交：`feat(backend): wire PromptsController with create/publish/rollback endpoints + AuthedRequest`

**验证**：AC 1-5 + 11 满足。`pnpm lint` 0 边界违规（controller 在域内 import contracts + platform security 类型）。

---

## Story 5 — 前端接通（client + PromptsPage + mocks 清理）

> PromptsPage 从本地 mock 切到真后端。建 Prompt → 出新版本 → diff → 发布 → 回滚全链路；`{var}` 抽取/预览/diff 用共享纯函数。

### 步骤

- [ ] **红**：改 `apps/frontend/src/api/client.ts`，补 typed client：
  ```ts
  import {
    // ... 现有 imports
    CreatePromptRequestSchema,
    type CreatePromptRequest,
    CreatePromptVersionRequestSchema,
    type CreatePromptVersionRequest,
    PromptSchema,
    type Prompt,
    PromptVersionSchema,
    type PromptVersion,
  } from "@codecrush/contracts";

  // prompts — @Controller("prompts")
  export const getPrompts = (): Promise<PromptListResponse> =>
    getJson("/api/prompts", PromptListResponseSchema);
  export const getPromptVersions = (promptId: string): Promise<PromptVersionListResponse> =>
    getJson(`/api/prompts/${encodeURIComponent(promptId)}/versions`, PromptVersionListResponseSchema);

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
  export async function publishPromptVersion(promptId: string, versionId: string): Promise<PromptVersion> {
    const resp = await apiFetch(
      `/api/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(versionId)}/publish`,
      { method: "POST" },
    );
    if (!resp.ok) throw new Error(`publish failed: ${resp.status}`);
    return PromptVersionSchema.parse(await resp.json());
  }
  export async function rollbackPromptVersion(promptId: string, versionId: string): Promise<PromptVersion> {
    const resp = await apiFetch(
      `/api/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(versionId)}/rollback`,
      { method: "POST" },
    );
    if (!resp.ok) throw new Error(`rollback failed: ${resp.status}`);
    return PromptVersionSchema.parse(await resp.json());
  }
  ```
  请求体不含 `author`（D6：服务端从 JWT 填）。
- [ ] **红**：扩 `apps/frontend/src/app/App.test.tsx`（或 PromptsPage 专属测试）：mock `getPrompts` 返空数组，断言 PromptsPage 挂载调 `getPrompts()`。先跑应失败（页面仍用本地 mock）。
- [ ] **绿**：改 `apps/frontend/src/mocks/prompts.ts`：
  - 删 `PROMPT_ROWS` / `PROMPT_BODIES` / `PROMPT_V` / `PROMPT_VERS`（mock 数据）。
  - 删本地 `detectVars` / `previewBody` / `lineDiff` / `bodyOf`（迁共享 `@codecrush/contracts`）。
  - 保留 `NODE_TAGS` / `NODE_META` / `VAR_PH` / `STV`（UI 常量：颜色/hint/示例值/状态色板）。
  - `PromptNode` 改为 `z.infer<PromptNodeSchema>` 对齐契约英文 enum；加 `NODE_LABEL: Record<PromptNode, string>` 映射 `rewrite→"问题改写", intent→"意图识别", reply→"回复生成", fallback→"兜底"`。
  - `PromptVersionStatus` 改为 `z.infer<PromptVersionStatusSchema>`；`STATUS_LABEL` 映射 `draft→"草稿", prod→"生产中", archived→"已归档"`（删 `审批中/灰度中`，契约无）。
- [ ] **绿**：改 `apps/frontend/src/pages/admin/PromptsPage.tsx`：
  - `useEffect(() => { getPrompts().then(setRows).catch(...) }, [])` 挂载调真 API。
  - `useState(PROMPT_ROWS)` → `useState<Prompt[]>([])`；`useState(PROMPT_BODIES)` 删（body 在 version 内）。
  - 列表渲染：`r.node` 经 `NODE_LABEL` 映射显中文；`r.updatedBy` + `r.updatedAt`（格式化）显"更新人 / 时间"列（PromptsPage:297）；`r.currentVersionId` 显当前版本号（GET versions 后映射）。
  - 新建抽屉"创建 Prompt"→ `createPrompt({name, node, body, note})`（无 author，D6），成功后刷新列表。
  - 编辑抽屉"保存为新版本"→ `createPromptVersion(id, {body, note})`（无 author/variables，D6/D5）。
  - 版本管理抽屉：`getPromptVersions(id)` 加载版本列表；diff 用共享 `diffPromptBodies`（`import { diffPromptBodies, extractVars, renderTemplate } from "@codecrush/contracts"`），删本地 `lineDiff` 调用。
  - "发布上线"→ `publishPromptVersion(id, versionId)`，"回滚到此版本"→ `rollbackPromptVersion(id, versionId)`（D2 双端点）；成功后刷新版本列表 + prompt 列表（currentVersionId 更新）。
  - 变量识别 + 预览：用共享 `extractVars(body)` 列变量 + `renderTemplate(body, examples)` 预览（删本地 `detectVars/previewBody`）。
  - "上次更新"文案（PromptsPage:592）：`pf.updatedBy` + `pf.updatedAt` 格式化（D16 消费）。
  - "绑定 Agent" tab：空态"M7 接入后展示"。
- [ ] **绿**：`pnpm --filter @codecrush/frontend test` 全绿。
- [ ] 提交：`feat(frontend): wire PromptsPage to real backend + shared prompt-template functions`

**验证**：启动后端 + 前端，浏览器 PromptsPage：建 Prompt（填 name/node/body）→ 列表显"更新人/时间" → 出新版本 → diff 显 +/- 行级标注 → 发布 → 回滚 → 变量识别 + 预览一致。`pnpm lint` 0 违规（frontend 只 import contracts）。

---

## Story 6 — 收尾验证（含 seed 可选）

> 全量测试 + lint + build + 手动验收 + seed 4 默认 Prompt（D9 optional）。

### 步骤

- [ ] **（optional, D9）扩展 `apps/backend/src/db/seed.ts`**：seed 4 个默认 Prompt（rewrite/intent/reply/fallback 各 v1 prod），恢复 demo 演示数据。沿用 seed.ts 现有 pattern（`db.insert(prompts).values(...).onConflictDoNothing()` + `db.insert(promptVersions)...`）。**非 AC**——若时间紧跳过，记入 dev-ledger "deferred"。约 30 行：
  ```ts
  // seed 4 default prompts (D9, optional)
  const defaultPrompts = [
    { name: "问题改写-通用", node: "rewrite", body: "你是一个问题改写器，请将用户问题改写为更利于检索的形式。问题：{query}" },
    { name: "意图识别-通用", node: "intent", body: "请识别用户意图，输出意图标签。问题：{query}" },
    { name: "回复生成-通用", node: "reply", body: "基于以下检索结果回答用户问题。问题：{query}\n上下文：{context}" },
    { name: "兜底回复-通用", node: "fallback", body: "抱歉，未找到相关信息，已转人工。" },
  ];
  for (const dp of defaultPrompts) {
    const [p] = await db.insert(prompts).values({
      name: dp.name, node: dp.node, currentVersionId: null, updatedBy: "system@codecrush.local",
    }).onConflictDoNothing({ target: prompts.name }).returning();
    if (p) {
      const [v] = await db.insert(promptVersions).values({
        promptId: p.id, version: 1, body: dp.body, variables: extractVars(dp.body),
        author: "system@codecrush.local", status: "draft",
      }).returning();
      // 不自动发布（v1 draft）；demo 可手动 publish 或 seed 时直接 prod
    }
  }
  ```
  **决策**：seed 时 v1 设 `status:"draft"`（对齐 spec "不自动发布 v1"），demo 体验需手动 publish。或 seed 时直接 `status:"prod"` + `currentVersionId`——**选后者保 demo 连续性**（M2 mock 有 4 个 prod 版本）。dev 时按 demo 需求定。
- [ ] **全量测试**：`pnpm test`（前端 + 后端 + 契约全绿）。
- [ ] **lint**：`pnpm lint`（0 边界违规）。
- [ ] **build**：`pnpm build`（turbo 全量构建成功）。
- [ ] **手动验收**（记录到 dev-ledger）：
  - `docker compose -f infra/docker-compose.yml --profile infra up -d --wait` + `pnpm --filter @codecrush/backend dev` + `pnpm --filter @codecrush/frontend dev`
  - 浏览器 PromptsPage：建 Prompt → 出新版本 → diff → 发布 → 回滚 全链路通
  - `curl http://localhost:3000/api/docs-json | jq '.paths | keys'` 含 `POST /api/prompts`、`POST .../publish`、`POST .../rollback`
  - DB 检查：`docker compose exec postgres psql -U postgres -d codecrush -c "SELECT id, name, current_version_id, updated_by, updated_at FROM prompts;"` + `... FROM prompt_versions;` → `variables` 是 jsonb、`author` 非空、`unique(prompt_id, version)` 约束存在
  - 验证"一个 prompt 同时只有一个 prod"：手动 SQL 插两个 prod → 应失败（或应用层保证）；正常流程 publish v2 后 v1 自动 archived
- [ ] 提交：`chore(m6): integration verification + seed default prompts`

**验证**：全部 12 条 Acceptance Criteria 满足（见 spec.md AC 1-12）。

---

## Host 自查（代替 execution drill）

> 轻量对抗模式（CLAUDE.md）：跳过 peer execution drill，host 自查 plan 可执行性。

| 检查项 | 结果 |
|--------|------|
| 每个 story 有 TDD 红绿步骤？ | ✅ Story 1（契约+纯函数）+ Story 3（service）+ Story 4（e2e）+ Story 5（前端）均先红后绿；Story 2（schema）靠 Drizzle TS 类型推断 + migrate 运行兜底，与 users.schema 现状一致 |
| 有 placeholder/TBD？ | ❌ 无。所有代码片段完整（含 prompt-template 三纯函数 + service promote 状态机 + e2e inMemoryRepo 含 D16 字段） |
| Story 间依赖清晰？ | ✅ 1（契约+纯函数）→ 2（DB）→ 3（repo+service）→ 4（controller+e2e）→ 5（前端）→ 6（收尾）。契约先于后端/前端；DB 先于 repo；repo+service 先于 controller/e2e |
| 破坏性变更有 story 覆盖？ | ✅ Story 1 契约演进（`currentVersionId` nullable、删 `author`/`variables` from 请求、加 `updatedAt/updatedBy/createdAt`）→ Story 4 e2e 测试体更新（非软化）；Story 2 schema 变更 |
| 文档先改？ | ✅ 无需改 001（架构权威已列 `prompt_versions(...,variables jsonb,...,author,status)` 001:88，对齐）；006 是 M2 产物不涉及 M6 |
| 验收标准全覆盖？ | ✅ AC 1-5 → Story 4；AC 6-7 → Story 1+5；AC 8 → Story 2；AC 9 → Story 6；AC 10 → Story 4；AC 11 → Story 4；AC 12 → Story 1+3+4（D16） |
| 契约演进破坏面？ | ✅ `currentVersionId` min(1) → nullable → m2-schemas.test fixture 更新（Story 1）；`CreatePromptVersionRequestSchema` 删 `variables/author` → 现有测试断言 `parsed.variables === ["query"]`（L331）需改（Story 1 覆盖）；前端 mock `PromptNode` 中文 → 契约英文 enum（Story 5 NODE_LABEL 映射） |
| 共享纯函数双端锁一致？ | ✅ Story 1 `prompt-template.ts` 在 contracts；Story 3 service import `extractVars` from contracts；Story 5 前端 import `extractVars/renderTemplate/diffPromptBodies` from contracts。单一真相 |
| `author` 来自 JWT 不被伪造？ | ✅ Story 4 controller `@Req() req: AuthedRequest` 取 `req.user.email`；Story 3 service `createPrompt/createVersion` 接 `actorEmail` 参数；Story 4 e2e "D6 不接受请求体 author" 断言 |
| `variables` 服务端抽取？ | ✅ Story 3 service `extractVars(req.body)`；Story 1 请求 schema 不含 variables；Story 4 e2e 断言 `res.body.variables` 含抽取 var |
| 单 prod 不变量 + 事务？ | ✅ Story 2 `unique(promptId,version)` + Story 3 `repo.publishVersion` 单事务（archive 旧 prod + set 新 prod + 更新 currentVersionId + updatedBy） |
| D8 并发撞号 retry？ | ✅ Story 3 service `createVersion` for-loop attempt 0/1 + `isUniqueViolation(e)` 判 `code==="23505"` + Story 3 service spec 覆盖 retry 成功/失败 |
| D15 已 prod → 409？ | ✅ Story 3 service `promote` 先查 status + Story 4 e2e "publish v1（已 prod）→ 409" |
| D16 时间戳/更新人？ | ✅ Story 1 schema（`updatedAt/updatedBy/createdAt`）+ Story 2 表（`updated_by` 列）+ Story 3 service（`createPrompt` 设 updatedBy、`promote` 刷 updatedBy、`toPrompt/toVersion` 映射 ISO datetime）+ Story 4 e2e（updatedBy=JWT email、updatedAt 推进）+ Story 5 前端（PromptsPage:297 列 + :592 文案消费） |
| e2e DB 策略？ | ✅ in-memory mock repo（DB-free，对齐 skeleton.e2e + traces.repository.spec mock-client 约定，diff D2 已验证） |
| OpenAPI 端点？ | ✅ Story 4 controller 用 `createZodDto`，nestjs-zod 自动生成；Story 6 验证 docs-json 含 create/publish/rollback |
| 前端边界？ | ✅ Story 5 frontend 只 import `@codecrush/contracts`（api client + prompt-template 纯函数 + NODE_LABEL）；不 import backend / otel |
| seed 默认 Prompt？ | ✅ Story 6 optional（D9），非 AC，标 deferred 风险 |

**自查结论**：plan 可执行。需实现时确认的点：
1. **Story 3 `createPrompt` 事务策略**：plan 推荐 service 内 `this.db.transaction` 直调 drizzle（绕 repo，仅此一处），避免给 repo 方法加 tx 参数（污染 repo 签名）。dev 时若选简化（两步 insert 不包事务），风险是建 prompt 成功但 v1 draft 失败时留孤儿 prompt——可接受（greenfield + 单用户），但优先 transaction。
2. **Story 3 `findProdVersion` 是否保留**：暂未用，ESLint workspace 规则若禁 unused method需删。dev 时按 lint 调整。
3. **Story 4 e2e 测试顺序重构**：原 skeleton.e2e prompts 块依赖 mock 数据 p1/pv1（inMemoryRepo 起空），需改测试顺序为「先 POST 建_prompt → 再测 GET versions / POST versions / publish / rollback」。plan 已标注，dev 时按此顺序重写 prompts describe 块。
4. **Story 6 seed v1 状态**：`status:"draft"`（对齐 spec"不自动发布"）vs `status:"prod"` + `currentVersionId`（保 demo 连续性）。plan 标注选后者，dev 时按 demo 需求定。
5. **Story 5 前端 `currentVersionId` 显版本号**：列表显"当前版本"需把 `currentVersionId` 映射到版本号——需先 GET versions 再映射，或 Prompt 读 DTO 加 `currentVersionNumber`（契约未加，YAGNI）。**优先**：前端 GET versions 后本地 build `id→version` map 映射，不改契约。plan 默认此路径。

**自查发现的潜在风险**（记入 dev 关注）：
1. **`currentVersionId` nullable 影响消费方**：前端 PromptsPage 显"当前版本"需处理 null（显"—"或"草稿"）。Story 5 覆盖。agents 模块 M7 绑定 `promptVersionId` 非 `currentVersionId`，不受影响（spec Risk 2 已记）。
2. **D8 retry 与事务边界**：`createVersion` retry 在 service 层（非事务内），`unique(promptId,version)` 由 DB 兜底。两并发请求同时读 max=3 → 均 insert v4 → 一成功一撞 23505 → retry 读 max=4 → insert v5 成功。正确。但极端情况两请求同时撞 + 同时 retry 仍可能撞 v5 → 第二次仍 23505 → ConflictException 409。可接受（用户重试即可）。Story 3 spec 覆盖。
3. **回滚审计弱**（Option A，spec Risk 1）：`updatedBy` 刷新留痕（D16）+ 双端点（publish/rollback）为未来 audit 区分事件类型留口。M11 加 `prompt_publish_events` 表补事件级审计。M6 记入 revisit。
4. **variables jsonb 类型 cast**：`.$type<string[]>()` 仅 TS 层断言，运行时仍是 jsonb。Drizzle 读出是 `unknown` 需 cast——`.$type` 处理了。`toVersion` 直接 `variables: row.variables`（已是 `string[]`）。Story 3 覆盖。
