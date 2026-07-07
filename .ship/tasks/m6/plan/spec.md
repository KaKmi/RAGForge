# M6 — Prompt 管理 Spec

> Host spec（独立调查产物）。Peer spec 见 `peer-spec.md`，分歧见 `diff-report.md`。
> 基线：分支 `design/m3-m6` @ `feat/m2-app-shell` (75e9b61)。M2 skeleton 已就位。

## Problem / Motivation

M2 把 `prompts` 模块建成了 skeleton：`PromptsService` 用硬编码 `MOCK_PROMPTS` + `MOCK_VERSIONS`（`prompts.service.ts:8-60`），`createVersion` 仅回显（`:79-92`），无发布/回滚/diff/变量抽取。前端 `PromptsPage.tsx` 用本地 mock（`mocks/prompts.ts` `PROMPT_ROWS`/`PROMPT_BODIES`/`PROMPT_VERS`）渲染，所有交互本地态。

M6 要把 Prompt 管理做成真实可用：建 Prompt（自动起 v1 草稿）、出新版本、两版本 diff、发布上线（draft→prod，旧 prod→archived）、回滚（把旧 archived 版本重新设 prod），`{var}` 变量抽取前后端用同一份纯逻辑（前端预览 == 后端渲染）。

**路线图验收（002 M6 行）**：建 Prompt、出新版本、diff、发布切生产、回滚到旧版本。

## Investigation findings

### 现有 skeleton（M2 产物）

- `packages/contracts/src/prompts.ts:1-41` —
  - `PromptNodeSchema = z.enum(["rewrite","intent","reply","fallback"])`（英文，4 节点）。
  - `PromptVersionStatusSchema = z.enum(["draft","prod","archived"])`（3 态）。
  - `PromptSchema`: `{id, name, node, currentVersionId: z.string().min(1)}`——**问题**：`currentVersionId` 必填，但未发布的 prompt（只有 draft）应允许 null。
  - `PromptVersionSchema`: `{id, promptId, version, body, variables: string[], note?, author?, status}`。
  - `CreatePromptVersionRequestSchema = PromptVersionSchema.omit({id, promptId, version, status})` = `{body, variables, note?, author?}`——**问题**：variables 不应由客户端决定，应由 body 自动抽取（防前后端不一致）。
- `apps/backend/src/modules/prompts/prompts.service.ts:1-92` — mock 桩。**注意 `createVersion:82` 用 `reduce max+1`**（M2 review P3-1 已锁定，M6 不得倒退回 `length+1`）。
- `apps/backend/src/modules/prompts/prompts.controller.ts:1-39` — `GET /`、`GET /:id`、`GET /:id/versions`、`POST /:id/versions`（201）。**无 `POST /`（建 prompt）、无发布端点**。
- `apps/backend/src/modules/prompts/prompts.module.ts` — 仅 controller + service。
- `apps/backend/src/app.module.ts:18,39` — PromptsModule 已注册。

### 同类范式（users 真实 CRUD）

- `users/schema.ts:1-11`、`users.repository.ts:1-27`、`users.service.ts:1-60`、`users.module.ts:1-11`——M6 照搬：`prompts/schema.ts`（两表）、`prompts.repository.ts`、`prompts.service.ts` 重写。
- `db/schema.ts:1-9` barrel：追加 `export * from "../modules/prompts/schema";`。
- `drizzle.config.ts:5` `schema: "./src/db/schema.ts"`——新表自动纳入迁移生成。

### 前端现状（必读，决定契约映射）

- `apps/frontend/src/pages/admin/PromptsPage.tsx:1-883` — 完全本地态：
  - `useState(PROMPT_ROWS)` / `useState(PROMPT_BODIES)`（`:85-86`）。
  - 新建/编辑抽屉（`:347-606`）：表单 `PromptDraft`（`mocks/prompts.ts:120-131`）含 name/node/body/note/varExamples。
  - "保存为新版本"（`:600`）本地 push。
  - 版本管理抽屉（`:608-880`）：左侧版本列表 + 右侧 diff/bind tab。
  - **diff 本地算**：`lineDiff(bodyOf(prodRaw), bodyOf(selRaw))`（`:223`，函数在 `mocks/prompts.ts:180-210`）。
  - **发布/回滚同一动作**："发布上线"/"回滚到此版本"都调 `setProd(prev => ({...prev, [pvName]: v.ver}))`（`:217,249`）——验证回滚语义选 Option A（见 Design）。
  - "绑定 Agent" tab（`:811-873`）展示 `ver.bind`（mock）——**M7 领地**，M6 桩空。
- `apps/frontend/src/mocks/prompts.ts:1-215` — 本地 mock + **纯函数**：
  - `PromptNode = "问题改写"|"意图识别"|"回复生成"|"兜底"`（**中文**，与契约英文 enum 不一致）。
  - `PromptVersionStatus = "生产中"|"审批中"|"灰度中"|"已归档"|"草稿"`（5 态，契约 3 态——`审批中/灰度中` 不在契约，M6 删除或映射）。
  - `detectVars(body)`（`:164-166`）：`/\{[a-zA-Z_]+\}/g` 去重保序。
  - `previewBody(body, examples)`（`:169-177`）：用示例值替换 `{var}`。
  - `lineDiff(a, b)`（`:180-210`）：行级 LCS，返回 `{type:"same"|"add"|"del", text}[]`。
  - **003 §Isomorphic 明确要求**：Prompt `{var}` 抽取/渲染（前端预览 == 后端渲染）属"高价值共享纯逻辑"，落 contracts 内纯函数。

### 现有测试（会被改动）

- `apps/backend/test/skeleton.e2e.spec.ts:247-269` — prompts 3 个测试：
  - `POST /api/prompts/p1/versions` 发 `{body, variables}`（`:263`）→ 201。M6 改契约为 `{body, note?, author?}`（variables 服务端抽）→ 测试体改 `{body}`，断言 `res.body.variables` 含抽取结果。
- `packages/contracts/src/m2-schemas.test.ts` — `CreatePromptVersionRequestSchema` 正反例需更新；新增 `CreatePromptRequestSchema` / `currentVersionId nullable` 用例。

## Design approach

### 1. 契约修订（`packages/contracts/src/prompts.ts`）

> diff 应用：D6 `author` 由服务端从 `req.user.email` 填（请求 schema 删 author，存储必填）。
> diff 应用：D16 读 DTO 暴露时间戳/更新人（前端 PromptsPage:297 "更新人 / 时间"、:592 "上次更新" 消费）。

```ts
export const PromptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  node: PromptNodeSchema,
  currentVersionId: z.string().min(1).nullable(), // null = 仅有 draft
  // D16：读侧暴露（前端列"更新人 / 时间"消费）；对齐 UserProfileSchema 的 ISO datetime 约定
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1),
});

// 版本 status 仍 draft/prod/archived；author 必填（D6：服务端恒填 JWT email）
export const PromptVersionSchema = z.object({
  id: z.string().min(1),
  promptId: z.string().min(1),
  version: z.number().int().positive(),
  body: z.string().min(1),
  variables: z.array(z.string()),
  note: z.string().optional(),
  author: z.string().min(1),            // D6：必填（来自 JWT）
  status: PromptVersionStatusSchema,
  createdAt: z.string().datetime(),      // D16：版本创建时间（版本历史展示）
});

// 建版本：body + note?；author / variables 由服务端填（D6：客户端不传 author）
export const CreatePromptVersionRequestSchema = z.object({
  body: z.string().min(1),
  note: z.string().optional(),
});

// 建 Prompt：起 v1 draft；author / variables 服务端填
export const CreatePromptRequestSchema = z.object({
  name: z.string().min(1),
  node: PromptNodeSchema,
  body: z.string().min(1),
  note: z.string().optional(),
});

// 发布结果：返回该版本（status=prod）
export const PublishPromptVersionResponseSchema = PromptVersionSchema;
```

### 2. 共享纯逻辑（`packages/contracts/src/prompt-template.ts` NEW）

003 §Isomorphic：双端必须锁一致。纯函数，零 zod 依赖（可放 contracts，contracts 只依赖 zod 不矛盾——纯函数不引依赖）。

```ts
const VAR_RE = /\{(\w+)\}/g; // {var_name}，字母数字下划线
export function extractVars(body: string): string[] {
  const out: string[] = []; const seen = new Set<string>();
  for (const m of body?.matchAll?.(VAR_RE) ?? []) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(VAR_RE, (_, k) => vars[k] ?? `{${k}}`);
}
export type DiffLine = { type: "same" | "add" | "del"; text: string };
export function diffPromptBodies(a: string, b: string): DiffLine[] {
  // 行级 LCS（迁自 mocks/prompts.ts:180-210 lineDiff，逐字照搬）
}
```

- `index.ts` 追加 `export * from "./prompt-template";`。
- 前端 `mocks/prompts.ts` 删本地 `detectVars/previewBody/lineDiff`，改 import 共享版。
- 后端 `PromptsService.createVersion/createPrompt` 用 `extractVars` 抽变量存库。

### 3. DB schema（`apps/backend/src/modules/prompts/schema.ts` NEW）

> diff 应用：D5 `variables` 用 jsonb + `.$type<string[]>()`（对齐 001:88 + 保 TS 类型）；D8 `unique(promptId, version)` 防并发撞号 + `index(promptId, status)` 查询性能；D6 `author` notNull；D16 `prompts.updatedBy` 记最后操作者（createPrompt / promote 刷新）。

```ts
import { integer, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const prompts = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  node: text("node").notNull(), // rewrite|intent|reply|fallback
  currentVersionId: uuid("current_version_id"), // nullable；FK 仅应用层（循环 FK 见 Risks）
  // D16：updatedBy 记最后操作者（建 Prompt = 创建者；发布/回滚 = 操作者）。notNull（建时恒填）
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
    variables: jsonb("variables").notNull().default([]).$type<string[]>(), // D5：jsonb + TS cast
    note: text("note"),
    author: text("author").notNull(), // D6：服务端恒填 JWT email
    status: text("status").notNull().default("draft"), // draft|prod|archived
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    // D8：防并发撞号 + 列版本/prod 查询加速
    uniqPromptVersion: uniqueIndex("prompt_versions_prompt_id_version_idx").on(t.promptId, t.version),
    promptStatusIdx: index("prompt_versions_prompt_id_status_idx").on(t.promptId, t.status),
  }),
);
export type PromptRow = typeof prompts.$inferSelect;
export type PromptVersionRow = typeof promptVersions.$inferSelect;
```

- `db/schema.ts` barrel 追加 `export * from "../modules/prompts/schema";`。
- 迁移：`drizzle-kit generate` → `pnpm db:migrate`。

### 4. PromptsRepository（`prompts.repository.ts` NEW）

```ts
@Injectable()
export class PromptsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}
  async findPrompts(): Promise<PromptRow[]>
  async findPromptById(id: string): Promise<PromptRow | undefined>
  async insertPrompt(row): Promise<PromptRow>
  async findVersions(promptId: string): Promise<PromptVersionRow[]>
  async findVersionById(versionId: string): Promise<PromptVersionRow | undefined>
  async insertVersion(row): Promise<PromptVersionRow>
  // 发布事务：archive 旧 prod + set 新 prod + 更新 prompt.currentVersionId + updatedBy + updatedAt（D16）
  async publishVersion(promptId: string, versionId: string, actorEmail: string): Promise<PromptVersionRow> // 用 db.transaction
}
```

- `publishVersion` 在单事务内：`UPDATE prompt_versions SET status='archived' WHERE prompt_id=? AND status='prod'` → `UPDATE ... SET status='prod' WHERE id=?` → `UPDATE prompts SET current_version_id=?, updated_by=?, updated_at=now() WHERE id=?`（D16：`updated_by` 刷为操作者）。保证"一个 prompt 同时只有一个 prod"（`uniqueIndex(promptId, version)` 防撞号由 DB 兜底，service 层 retry 见 §5）。

### 5. PromptsService（重写）

> diff 应用：D6 `author` 从 `actorEmail`（controller 传 `req.user.email`）填；D8 createVersion 捕获 unique 冲突 retry 一次；D15 `promote()` 先查 status，已 prod → `ConflictException`。

```ts
@Injectable()
export class PromptsService {
  constructor(@Inject(DRIZZLE) private readonly db: DB, private readonly repo: PromptsRepository) {}
  async list(): Promise<Prompt[]> { return (await repo.findPrompts()).map(toPrompt) }
  async get(id): Promise<Prompt> { const r = await repo.findPromptById(id); if (!r) throw new NotFoundException(); return toPrompt(r); }
  async createPrompt(req: CreatePromptRequest, actorEmail: string): Promise<Prompt> {
    return db.transaction(async tx => {
      const p = await repo.insertPrompt({ name: req.name, node: req.node, currentVersionId: null, updatedBy: actorEmail }); // D16：updatedBy = 创建者
      await repo.insertVersion({ promptId: p.id, version: 1, body: req.body, variables: extractVars(req.body), note: req.note, author: actorEmail, status: "draft" });
      // 不自动发布 v1：currentVersionId 留 null（draft 不算生产）
      return toPrompt(p);
    });
  }
  async listVersions(promptId): Promise<PromptVersion[]> { await this.get(promptId); return (await repo.findVersions(promptId)).map(toVersion) }
  async createVersion(promptId, req: CreatePromptVersionRequest, actorEmail: string): Promise<PromptVersion> {
    await this.get(promptId); // 校验存在
    // D8：并发撞 unique(promptId,version) 时 retry 一次
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = (await repo.findVersions(promptId)).reduce((m, v) => Math.max(m, v.version), 0) + 1; // max+1（M2 review P3-1 锁定）
      try {
        const row = await repo.insertVersion({ promptId, version: next, body: req.body, variables: extractVars(req.body), note: req.note, author: actorEmail, status: "draft" });
        return toVersion(row);
      } catch (e) {
        if (isUniqueViolation(e) && attempt === 0) continue;
        throw e;
      }
    }
    throw new ConflictException("version 冲突，重试失败");
  }
  // D2：publish 与 rollback 委托同一 promote()；D15：已 prod → 409；D16：actorEmail 刷 prompts.updatedBy
  async promote(promptId: string, versionId: string, actorEmail: string): Promise<PromptVersion> {
    const v = await repo.findVersionById(versionId);
    if (!v || v.promptId !== promptId) throw new NotFoundException();
    if (v.status === "prod") throw new ConflictException("该版本已是生产版本");
    return toVersion(await repo.publishVersion(promptId, versionId, actorEmail));
  }
}
```

- `toPrompt(row)`: `{id, name, node, currentVersionId: row.currentVersionId ?? null, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy}`（D16）。
- `toVersion(row)`: `{id, promptId, version, body, variables, note?, author, status, createdAt: row.createdAt.toISOString()}`（D16）。
- `isUniqueViolation(e)`：识别 PG `23505` unique_violation（drizzle 透传 `code`）。
- **回滚语义 Option A（D2）**：`promote()` 既用于"发布 draft→prod"也用于"回滚 archived→prod"——同一 service 方法，controller 暴露 `/publish` 与 `/rollback` 两端点委托它。不新建版本（审计留痕弱，记 Risks；M11 评测/审计可补 audit 表，非 M6）。

### 6. Controller（扩展）

> diff 应用：D2 加 `POST /:id/versions/:versionId/rollback`（委托 `promote()`）；D6 `@Req() req: AuthedRequest` 取 `req.user.email` 作 author。

```ts
@Get() list()
@Get(":id") get()
@Post() @HttpCode(201) createPrompt(@Body() dto: CreatePromptRequestDto, @Req() req: AuthedRequest) // NEW；author = req.user.email
@Get(":id/versions") listVersions()
@Post(":id/versions") @HttpCode(201) createVersion(@Body() dto: CreatePromptVersionRequestDto, @Req() req: AuthedRequest) // author = req.user.email
// D2：publish 与 rollback 双端点委托同一 service.promote()；D16：传 req.user.email 刷 prompts.updatedBy
@Post(":id/versions/:versionId/publish") @HttpCode(200) publish(@Param() p, @Req() req: AuthedRequest) { return service.promote(p.id, p.versionId, req.user.email) } // NEW 发布 draft→prod
@Post(":id/versions/:versionId/rollback") @HttpCode(200) rollback(@Param() p, @Req() req: AuthedRequest) { return service.promote(p.id, p.versionId, req.user.email) } // NEW 回滚 archived→prod
```

- diff：**无后端 `/diff` 端点**——前端用共享 `diffPromptBodies(a,b)` 本地算（D4 proven-false，见 diff-report）。
- "绑定 Agent" tab：M6 不接（M7），前端显示空态或"M7 接入后可用"。
- `AuthedRequest = { user: AuthenticatedUser }`（`apps/backend/src/modules/users/users.controller.ts:13` 范式）；`req.user.email` 来自 JWT（`jwt-auth.guard.ts:41`）。

### 7. PromptsModule

```ts
@Module({
  controllers: [PromptsController],
  providers: [PromptsRepository, PromptsService],
  exports: [PromptsService],
})
```

### 8. 前端接通

- `apps/frontend/src/api/client.ts`：补 `createPrompt(req)`、`getPromptVersions(id)`、`createPromptVersion(id, req)`、`publishPromptVersion(id, versionId)`、`rollbackPromptVersion(id, versionId)`（D2；M2 已有 getPrompts，确认签名）。请求体不含 `author`（D6：服务端从 JWT 填）。
- `apps/frontend/src/pages/admin/PromptsPage.tsx`：
  - `useEffect` 挂载调 `getPrompts()`。
  - node 映射：契约英文 ↔ 显示中文（`rewrite→问题改写, intent→意图识别, reply→回复生成, fallback→兜底`）。加 `NODE_LABEL` 常量。
  - status 映射：`draft→草稿, prod→生产中, archived→已归档`（删 `审批中/灰度中`，契约无）。
  - 新建抽屉"创建 Prompt"→ `createPrompt({name, node, body, note})`（无 author，D6）。
  - 编辑抽屉"保存为新版本"→ `createPromptVersion(id, {body, note})`（无 author，D6）。
  - 版本管理抽屉：`getPromptVersions(id)` 加载；diff 用共享 `diffPromptBodies`（导入 `@codecrush/contracts`）；"发布上线"→ `publishPromptVersion(id, versionId)`，"回滚到此版本"→ `rollbackPromptVersion(id, versionId)`（D2）。
  - 变量识别 + 预览：用共享 `extractVars` + `renderTemplate`（删本地副本）。
  - "绑定 Agent" tab：空态"M7 接入后展示"。
- `apps/frontend/src/mocks/prompts.ts`：删 `PROMPT_ROWS/PROMPT_BODIES/PROMPT_V/PROMPT_VERS`（mock 数据）；删 `detectVars/previewBody/lineDiff/bodyOf`（迁共享）；保留 `NODE_TAGS/NODE_META/VAR_PH/STV`（UI 常量：颜色/hint/示例值/状态色板），`PromptNode` 改为 `z.infer<PromptNodeSchema>` 对齐契约英文 enum（NODE_LABEL 做显示映射）。

## Intent / non-goals / forbidden shortcuts

**Intent**
- 真实 CRUD：prompts + prompt_versions 两表；建 Prompt 起 v1 draft；出新版本（max+1）；diff（前端共享纯函数）；发布/回滚（事务，单 prod 不变量）；`{var}` 抽取/渲染前后端共享纯逻辑。

**Non-goals**
- **不做 diff 后端端点**——前端用共享 `diffPromptBodies` 算（YAGNI；M9"跳 Prompt 版本"如需再补）。
- **不做"绑定 Agent"功能**——M7；M6 前端 tab 显空态。
- **不做版本审计日志**（谁在何时回滚）——Option A 回滚不新建版本，审计弱；M11 评测/审计再补 audit 表。
- **不做灰度/审批状态**——契约 status 仅 draft/prod/archived；mock 的 `审批中/灰度中` 删除（YAGNI）。
- **不做变量类型校验**（如 `{n:int}`）——`{var}` 统一当字符串插值；结构化输出靠 Prompt body 自约束。
- **不做软删除**——删 Prompt 硬删（cascade prompt_versions）。M6 是否做 DELETE /prompts？原型无删除按钮，**M6 不做 DELETE**（建/改/版本/发布/回滚即满足 AC）。

**Forbidden shortcuts**
- 不得把 `variables` 交给客户端决定——必须服务端 `extractVars(body)` 抽取（防前后端漂移）。
- 不得把 `author` 交给客户端决定——必须服务端从 `req.user.email`（JWT）填（D6；防伪造审计）。
- 不得软化 `skeleton.e2e.spec.ts` prompts 断言——改测试体（`{body}` 替 `{body, variables, author}`），断言 `variables` 含抽取结果 + `author` 来自 JWT，是契约演进的合法更新。
- 不得在 `createVersion` 用 `length+1`——必须 `reduce max+1`（M2 review P3-1 锁定）；并发撞 `unique(promptId,version)` 时 retry 一次（D8）。
- 发布不得跳过事务——必须 `db.transaction` 保证"archive 旧 prod + set 新 prod + 更新 currentVersionId"原子。
- 不得绕过共享 `extractVars`——前后端必须 import 同一份 `@codecrush/contracts` 的纯函数（003 §Isomorphic 双端锁一致）。

## Acceptance criteria

1. `POST /api/prompts` `{name, node, body, note?}` → 201，返回 Prompt（`currentVersionId:null`）；DB 同时生成 v1 PromptVersion（status=draft, variables=extractVars(body), author=`req.user.email`）。
2. `GET /api/prompts` → 200，Prompt[] 合 schema（`currentVersionId` 可 null）。
3. `POST /api/prompts/:id/versions` `{body, note?}` → 201，`version=max+1`、`status="draft"`、`variables` 含从 body 抽取的 `{var}` 列表、`author`=`req.user.email`。
4. `POST /api/prompts/:id/versions/:versionId/publish` → 200，该版本 `status="prod"`，原 prod 版本 `status="archived"`，`prompt.currentVersionId` 指向新 prod。同一 prompt 同时只有一个 prod（事务保证）。
5. 回滚（D2）：对一个 `archived` 版本调 `POST /api/prompts/:id/versions/:versionId/rollback` → 200，该版本回 prod，当前 prod→archived，`prompt.currentVersionId` 回到该版本。与 publish 委托同一 `promote()`，但走独立 `/rollback` 端点。
6. diff：前端用 `diffPromptBodies`（`@codecrush/contracts`）算两版本 diff，显示 +/-/空 行级标注。
7. `extractVars`/`renderTemplate`/`diffPromptBodies` 前后端 import 同一份（contracts），前端预览与后端渲染一致。
8. `pnpm db:migrate` 生成并应用 prompts + prompt_versions 表迁移（含 `unique(promptId,version)` + `index(promptId,status)`）。
9. `pnpm test` 全绿；`pnpm lint` 0；`pnpm build` ok。
10. OpenAPI `/api/docs-json` 含 `POST /api/prompts`、`POST .../publish`、`POST .../rollback` 新端点。
11. 幂等拒绝（D15）：对已是 `prod` 的版本调 `/publish` → 409 `ConflictException`。
12. 时间戳/更新人（D16）：`PromptSchema` 含 `updatedAt`/`updatedBy`，`PromptVersionSchema` 含 `createdAt`。建 Prompt 后 `updatedBy` = 创建者；发布/回滚后 `updatedBy` = 操作者、`updatedAt` 推进。前端"更新人 / 时间"列与"上次更新"文案有数据可显。

## Test plan

### 新增
- `packages/contracts/src/prompt-template.test.ts`：
  - `extractVars("{question} {context} {question}")` → `["question","context"]`（去重保序）。
  - `extractVars("")` → `[]`。
  - `renderTemplate("Hi {name}", {name:"X"})` → `"Hi X"`；缺变量保留 `{name}`。
  - `diffPromptBodies("a\nb","a\nc")` → `[{same:"a"},{del:"b"},{add:"c"}]`。
- 扩 `m2-schemas.test.ts`：
  - `PromptSchema` 接受 `currentVersionId:null`、拒绝 undefined；含 `updatedAt`(datetime)/`updatedBy`（D16）。
  - `PromptVersionSchema` 含 `createdAt`(datetime)（D16）。
  - `CreatePromptRequestSchema` 拒绝缺 body/name/node。
  - `CreatePromptVersionRequestSchema` 拒绝缺 body、接受无 variables（variables 不在请求里）。
- `apps/backend/src/modules/prompts/prompts.service.spec.ts`：mock repo；验证：
  - `createPrompt`/`createVersion` 用 `actorEmail` 填 `author`（D6）、`extractVars` 抽 variables；`createPrompt` 同时把 `updatedBy=actorEmail` 写入 prompts row（D16）。
  - `createVersion` max+1（M2 review P3-1）；D8 模拟 repo.insertVersion 首次抛 unique_violation → retry 后成功，第二次仍抛 → `ConflictException`。
  - `promote` 状态机：draft→prod、旧 prod→archived、`currentVersionId` 更新；已 prod → `ConflictException`（D15）；D16 验证 `repo.publishVersion` 收到的 `actorEmail` 透传（断言 mock 调用参数含 actorEmail）。
  - `toPrompt`/`toVersion` 把 `updatedAt`/`updatedBy`/`createdAt` 的 `Date` 序列化为 ISO datetime 字符串（D16）。
- `apps/backend/test/prompts.e2e.spec.ts`（或更新 `skeleton.e2e.spec.ts` prompts 块）：
  - `overrideProvider(PromptsRepository).useValue(inMemoryRepo)`（DB-free，对齐 skeleton.e2e 现状）。inMemoryRepo 维护 `updatedAt`/`updatedBy`/`createdAt` 字段以支持 D16 断言。
  - POST /api/prompts → 201；GET versions → v1 draft；POST versions → v2 draft；POST publish v2 → 200，v2 prod、v1 archived。
  - D2：POST rollback v1（archived）→ 200，v1 回 prod、v2 archived。
  - D15：POST publish v1（已 prod）→ 409。
  - D6：建版本响应 `author` === JWT email（`PRINCIPAL.email`），不接受请求体 `author`（传了也被 strip/忽略）。
  - D16：建 Prompt 响应 `updatedBy` === JWT email、`updatedAt` 是合法 ISO datetime；发布后 `updatedBy` 不变（同 principal）但 `updatedAt` 推进（或换 principal 时 `updatedBy` 跟随）；版本响应含 `createdAt`。

### 更新（非软化）
- `skeleton.e2e.spec.ts:259-268` createVersion 测试体：发 `{body:"新版本..."}`（删 `variables` 与 `author`），断言 `res.body.variables` 非空含抽取 var、`res.body.author` === JWT email。

## Risks / unknowns

1. **回滚审计弱（Option A，已定）**：回滚 = 旧版本重标 prod，不新建版本，看不出"谁在何时回滚"——但 `prompts.updatedAt/updatedBy` 刷新留痕（D6 author 来自 JWT 可追溯操作者）。若需精细到"事件级"审计，M11 加 `prompt_publish_events` 表记录 actor/time/from/to。M6 记入 revisit。D2 双端点（publish/rollback）为未来 audit 区分事件类型留口。
2. **currentVersionId nullable 的契约影响（已定）**：改 `z.string().min(1)` → `.nullable()`，影响所有 `Prompt` 消费方（前端、agents 模块 M7 将绑定 `promptVersionId` 而非 `currentVersionId`，不受影响）。需更新 `m2-schemas.test.ts` fixture。可接受。
3. **diff 前端算 vs 后端端点（已定，D4 proven-false）**：选前端算（共享纯函数 `diffPromptBodies` 即单一真相）。M9"跳 Prompt 版本"只需读版本 body（已有 `GET /:id/versions/:versionId`），不需 diff 端点。若 M9+ 有程序化消费方再加 `GET /diff?from=&to=`——M6 YAGNI。
4. **variables jsonb（已定，D5 conceded）**：用 `jsonb().$type<string[]>()`（对齐 001:88 架构权威 + TS 类型 cast）。若架构升 `current` 时判定 text[] 更优，先改 001:88 再改列。
5. **建 Prompt 是否自动发布 v1（已定）**：选不自动（currentVersionId=null，v1=draft）。原型"建 Prompt"后列表显示版本，但首次需手动发布才上线——符合"草稿/生产分离"语义。
6. **seed 4 默认 Prompt（D9，optional）**：扩展 `db/seed.ts` seed 4 个默认 Prompt（rewrite/intent/reply/fallback 各 v1 prod）恢复 mock 演示数据。非 AC，nice-to-have，低成本（~30 行，沿用 seed.ts 现有 pattern）。

## References

- 路线图：`docs/design/002-implementation-roadmap.md` M6 行（`:87`）
- 代码组织：`docs/design/003-code-organization.md` §Isomorphic 边界（`:253-258`，Prompt {var} 抽取/渲染共享）
- M2 产物：`docs/design/006-m2-app-shell-skeleton.md`；M2 dev-ledger Story 3（prompts skeleton）、Final review P3-1（版本号 max+1 锁定）
- 同类范式：`apps/backend/src/modules/users/{schema,users.repository,users.service,users.controller,users.module}.ts`
- 原型：`CodeCrushBot.dc.html`（Prompt 管理页）
