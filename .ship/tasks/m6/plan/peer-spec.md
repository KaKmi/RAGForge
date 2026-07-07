# M6 Prompt 管理 — Peer Spec（独立调查）

> 独立调查产物。所有结论均标注 `file:line` 证据（已实际打开阅读）。本文不复制 host spec，仅给出本调查的发现与设计判断，供 host diff 比对。

## Problem / Motivation

M2 已建 prompts 模块 skeleton（mock 内存数据 + Zod 契约 + 前端页面），见 `docs/design/006-m2-app-shell-skeleton.md:228`（skeleton 端点 `GET /`→`[]`、`GET /:id/versions`→`[]`）。M6 要把 skeleton 填成真实逻辑：建表、版本管理、版本 diff、发布/回滚状态机、`{var}` 变量抽取与校验。

路线图验收（`docs/design/002-implementation-roadmap.md:87`）：建 Prompt、出新版本、两版本 diff、发布切生产、回滚到旧版本。

M6 是 M7 Agent 配置的前置（`002:97`：Agent 绑 4 个 Prompt 版本；`docs/design/003-code-organization.md:124`：`agents → ... prompts`）。M6 必须保证 `PromptVersion.id` 稳定可被 M7 外键引用。

## Investigation findings（file:line 证据）

### A. 入口与接线（已就位，M6 复用）

- `apps/backend/src/app.module.ts:18,39` — `PromptsModule` 已注册；`:45-47` 全局 `ZodValidationPipe`（APP_PIPE）+ `ZodSerializerInterceptor`（APP_INTERCEPTOR）。
- `apps/backend/src/app/app-bootstrap.ts:11` — 全局前缀 `/api`（排除 health）。故所有端点为 `/api/prompts*`。
- `apps/backend/src/modules/auth/auth.module.ts:22` — 全局 `APP_GUARD = JwtAuthGuard`；`@Public()` 仅 health（`apps/backend/src/modules/health/health.controller.ts:8`）与 auth login（`apps/backend/src/modules/auth/auth.controller.ts:13`）。**prompts 端点默认在 auth 保护圈内，无需额外加守卫。**
- `apps/backend/src/modules/auth/jwt-auth.guard.ts:41` — 验证后挂 `request.user = { id, email }`（类型 `apps/backend/src/platform/security/authenticated-user.ts:1` `AuthenticatedUser = { id; email }`）。**PromptVersion.author = `req.user.email`**（无 displayName 可用）。
- `apps/backend/src/platform/persistence/persistence.module.ts:8,10` — `DB = NodePgDatabase<typeof schema>`，`@Global()` 模块，导出 `DRIZZLE` token；`apps/backend/src/platform/persistence/drizzle.constants.ts:1` `DRIZZLE = Symbol("DRIZZLE")`。PromptsModule 可直接 `@Inject(DRIZZLE)`，无需 import PersistenceModule（全局）。
- `apps/backend/src/db/schema.ts:1-9` — 中央 barrel 仅 re-export `appMeta` + `users`。**M6 必须在此追加 `export * from "../modules/prompts/schema"`**，否则 drizzle-kit generate 看不到新表（`apps/backend/drizzle.config.ts:5` `schema: "./src/db/schema.ts"`）。
- `apps/backend/src/db/migrate.ts:9` — `migrate(db, { migrationsFolder: "./drizzle" })`，显式命令（满足不变量 6）。脚本：`apps/backend/package.json:11-12` `db:generate`(drizzle-kit generate) + `db:migrate`(tsx)。
- `apps/backend/src/db/seed.ts:4,16-19` — 现仅 seed demo user（`db.insert(users).values(...).onConflictDoNothing`）。**M6 可扩展** seed 4 个默认 Prompt（rewrite/intent/reply/fallback 各一条 v1 prod）以恢复 mock 演示数据。

### B. 同类 CRUD 范式（users 模块，照搬）

- `apps/backend/src/modules/users/schema.ts:1-12` — 纯 `pgTable` 定义 + `$inferSelect` 类型，零 service 引用（满足不变量 8）。列范式：`uuid("id").primaryKey().defaultRandom()`、`text`、`timestamp("created_at").notNull().defaultNow()`、`unique`。
- `apps/backend/src/modules/users/users.repository.ts:8-26` — `@Injectable()` + `@Inject(DRIZZLE) db: DB`，drizzle `eq`/`select`/`update().set().where()`，返回 `Row | undefined`。
- `apps/backend/src/modules/users/users.service.ts:11-20` — `toProfile(row)` 映射器：DB Row（`Date` 时间戳）→ 契约 ISO 字符串。service 注入 repo，业务异常用 `NotFoundException`。
- `apps/backend/src/modules/users/users.controller.ts:11,20` — DTO 用 `class XDto extends createZodDto(Schema)`；`@Req() req: AuthedRequest` 取 principal。
- `apps/backend/src/modules/users/users.module.ts:6-10` — `providers: [Repo, Service]`，`exports: [Service]`。

### C. 现有 M2 prompts skeleton（将被替换）

- `apps/backend/src/modules/prompts/prompts.service.ts:8-92` — **纯内存 mock**（`MOCK_PROMPTS` 4 条 + `MOCK_VERSIONS` 5 条）。方法：`list/get/listVersions/createVersion`。
  - `:82` 版本号 `existing.reduce((m, v) => Math.max(m, v.version), 0) + 1` —— **M2 review 已锁定的 max+1 策略，M6 不得倒退为 length+1**。
  - `:90` 新建版本一律 `status: "draft"`（后端分配，客户端不可指定）。
  - `:83` 注释 "M2 桩：仅回显，不持久化。M6 接 Prompt 版本管理与 diff"。
- `apps/backend/src/modules/prompts/prompts.controller.ts:12-39` — 4 个路由：`GET /`、`GET /:id`、`GET /:id/versions`、`POST /:id/versions`。**缺：建 Prompt（POST /）、diff、publish、rollback。**
- `apps/backend/src/modules/prompts/prompts.module.ts:5-8` — 仅 `providers: [PromptsService]`。**M6 追加 `PromptsRepository`**（PersistenceModule 全局，无需 import）。

### D. 契约现状（`packages/contracts/src/prompts.ts`）

- `:3` `PromptNodeSchema = z.enum(["rewrite","intent","reply","fallback"])` —— 4 节点，与 `001:87` 一致。
- `:6` `PromptVersionStatusSchema = z.enum(["draft","prod","archived"])` —— **3 态**，与 `001:88` 一致。前端 mock 的 5 态（`apps/frontend/src/mocks/prompts.ts:79` 生产中/审批中/灰度中/已归档/草稿）是原型-only，M6 不引入审批/灰度。
- `:9-14` `PromptSchema { id, name, node, currentVersionId: z.string().min(1) }` —— **无时间戳/作者**，但前端列表"更新人/时间"列需要（`apps/frontend/src/pages/admin/PromptsPage.tsx:297`）。
- `:17-26` `PromptVersionSchema { id, promptId, version:int+, body, variables:string[], note?, author?, status }` —— **无 createdAt**，但前端版本抽屉显示 time（`PromptsPage.tsx:686`）。
- `:32-37` `CreatePromptVersionRequestSchema = omit(id, promptId, version, status)` → 客户端发 `{ body, variables, note?, author? }`；后端分配其余。
- `packages/contracts/src/index.ts:11` re-export prompts。若在 contracts 内加纯函数，自动导出。

### E. 架构数据模型（权威）

- `docs/design/001-rag-platform-architecture.md:87` — `prompts(id, name, node[rewrite/intent/reply/fallback], current_version_id)`。
- `docs/design/001-rag-platform-architecture.md:88` — `prompt_versions(id, prompt_id, version, body, variables jsonb, note, author, status[draft/prod/archived])`。**variables 用 jsonb**。
- `003:124` `agents → knowledge-bases, models, prompts`（M7 绑定 4 个 PromptVersion id）。
- `003:129` `prompts` 是叶子模块（无域依赖，仅 persistence）。
- `003:257` **关键**：Prompt `{var}` 抽取/渲染是"高价值共享纯逻辑"（保证前端预览 == 后端渲染），落点为 `@codecrush/prompt`（纯逻辑包）**或 contracts 内纯函数**。M6 的核心设计决策之一。

### F. 前端现状（M2 mock 驱动）

- `apps/frontend/src/pages/admin/PromptsPage.tsx:22` — 注释 "M6 接真实 /api/prompts"。
- `apps/frontend/src/pages/admin/PromptsPage.tsx:127` —— 变量正则 `body.match(/\{[a-zA-Z_]+\}/g)`（**无数字**，内联）。
- `apps/frontend/src/mocks/prompts.ts:165` —— `detectVars(body)` 正则 `/\{[a-zA-Z_]+\}/g`，去重保序（与 `:127` 一致，是同一规则的两处副本 —— 漂移风险）。
- `apps/frontend/src/mocks/prompts.ts:169-177` —— `previewBody(body, examples)` 用 `split().join()` 替换 `{var}`。
- `apps/frontend/src/mocks/prompts.ts:180-210` —— `lineDiff(a, b)` LCS 行级 diff，输出 `{type:"same"|"add"|"del", text}[]`。
- `apps/frontend/src/pages/admin/PromptsPage.tsx:217,249` —— "发布上线"与"回滚到此版本"两个按钮**都调用 `setProd(...)`**（把选中版本设为生产）→ 确认 **Option A**：回滚 = 把旧版本再标 prod，不新建版本。
- 原型 `CodeCrushBot.dc.html:1027` —— "确认变更后可直接发布上线，原生产版本将自动归档，可随时回滚" —— 与 Option A 一致。
- `apps/frontend/src/mocks/prompts.ts:5` —— mock `PromptNode` 是中文标签；契约是英文 enum。映射 rewrite↔问题改写/intent↔意图识别/reply↔回复生成/fallback↔兜底，属前端展示层（`NODE_TAGS`/`NODE_META` 留在前端 mock）。
- 版本抽屉有 "版本 Diff" + "绑定 Agent" 两个 tab（`PromptsPage.tsx:715-719`）。**"绑定 Agent" tab 是 M7 范畴**（agents 反向查询），M6 不做。

### G. 测试现状（M6 将影响）

- `packages/contracts/src/m2-schemas.test.ts:108,159-164` —— PromptSchema/PromptVersionSchema 正例 fixture（`{id:"p1",...,currentVersionId:"pv1"}` / `{id:"pv1",promptId:"p1",version:7,body,variables:["query"],note,author:"admin",status:"prod"}`）。
- `packages/contracts/src/m2-schemas.test.ts:323-336` —— `CreatePromptVersionRequestSchema` 测试，断言 `status`/`version` 被 strip（后端分配）。**M6 必须保留此不变量。**
- `apps/backend/test/skeleton.e2e.spec.ts:247-269` —— **prompts 段会破裂**：断言 mock id `p1`/`pv1`、`POST /api/prompts/p1/versions`→201 且 `res.body.promptId==="p1"`。该测试模块（`:59-77`）**不含 PersistenceModule**，DB-backed PromptsService 无法实例化。**M6 必须重构此段**（见 Test plan）。
- `apps/backend/test/skeleton.e2e.spec.ts:332` —— OpenAPI 断言 `/api/prompts/{id}/versions` 存在。M6 保留此端点 + 新增路径，此断言仍通过（可扩展）。
- `apps/backend/test/users.service.spec.ts:38-46` —— 单测范式：`jest.fn()` mock repo + `new Service(repo)`。M6 `prompts.service.spec.ts` 照搬。

### H. 依赖

- `apps/backend/package.json:28-29` —— `drizzle-orm ^0.45.2`、`nestjs-zod ^5.4.0`、`zod ^4.4.3`。**无 `diff` 库** → lineDiff 必须是共享纯函数（无新依赖，满足 006 不变量 6）。

## Design approach

### 1. 共享纯逻辑落点：contracts 内纯函数（非新包）

`003:257` 给出两个合法落点。M6 选 **contracts 内纯函数**（`packages/contracts/src/prompts.ts` 追加，或新文件 `packages/contracts/src/prompt-logic.ts` 并在 `index.ts` re-export）：

- `extractVars(body: string): string[]` —— 正则 `/\{[a-zA-Z_]+\}/g`（无数字，对齐 `mocks/prompts.ts:165`），去重保序。
- `renderBody(body: string, values: Record<string, string>): string` —— 替换 `{var}`（对齐 `mocks/prompts.ts:169`）。
- `diffBodies(a: string, b: string): LineDiff[]` —— LCS 行级 diff（对齐 `mocks/prompts.ts:180`），`LineDiff = { type: "same"|"add"|"del"; text: string }`。

理由：① 共 ~40 行零依赖纯逻辑，新建 `@codecrush/prompt` 包的 workspace/tsconfig/lint 边界开销不成比例；② 前端 `mocks/prompts.ts` 已有同款副本，M6 把它们迁入 contracts，前端改 `import { extractVars, renderBody, diffBodies } from "@codecrush/contracts"`，消除 `:127` 与 `:165` 两处正则漂移；③ 满足 `003:257` "前端预览 == 后端渲染"（后端 diff 端点用同一 `diffBodies`）。

**Revisit**：若 prompt 逻辑增长（多消息模板、条件变量、渲染引擎），抽 `@codecrush/prompt` 包。

> contracts 仅依赖 zod（`003:38` 不变量 8）；纯函数零依赖，不违反"contracts 是 Zod schema 单一契约源"的精神（`003:257` 明文允许 contracts 内纯函数）。

### 2. 数据模型（Drizzle 表）

新增 `apps/backend/src/modules/prompts/schema.ts`（纯表定义，零 service 引用，不变量 8）：

```
prompts
  id           uuid PK defaultRandom
  name         text notNull
  node         text notNull   -- "rewrite"|"intent"|"reply"|"fallback"（应用层 enum 校验，DB 不加 CHECK 以便 drizzle-kit 生成干净）
  currentVersionId uuid  nullable  -- FK → prompt_versions.id（可 null：尚无 prod 版本）
  createdAt    timestamp notNull defaultNow
  updatedAt    timestamp notNull defaultNow
  unique(name)  -- 同名不允许（前端 mock `PromptsPage.tsx:123` 已校验"该名称已存在"）

prompt_versions
  id           uuid PK defaultRandom
  promptId     uuid notNull  -- FK → prompts.id ON DELETE CASCADE
  version      integer notNull
  body         text notNull
  variables    jsonb notNull default '[]'::jsonb  -- string[]
  note         text
  author       text notNull   -- 后端恒从 JWT email 填充（jwt-auth.guard.ts:38-40 保证非空）
  status       text notNull  -- "draft"|"prod"|"archived"
  createdAt    timestamp notNull defaultNow
  unique(promptId, version)   -- 防撞号；并发 create 冲突时 retry
  index(promptId, status)     -- 列版本/prod 查询
```

与 `001:87-88` 对齐；额外加 `createdAt`/`updatedAt`/`unique(name)`/`unique(promptId,version)`（架构文档是最小集，M6 合理扩展以支撑 UI"更新人/时间"列与并发安全）。

**循环 FK 注意**：`prompts.current_version_id → prompt_versions.id` 与 `prompt_versions.prompt_id → prompts.id` 互为外键（循环）。`currentVersionId` nullable 解决插入顺序：先 insert prompt（currentVersionId=null）→ insert version（promptId=prompt.id）→ update prompt.currentVersionId。drizzle-kit 生成迁移时两向 FK 约束需谨慎（可用 `DEFERRABLE INITIALLY DEFERRED` 或应用层保证顺序，不强依赖 DB 约束）；若 drizzle-kit 对循环 FK 生成有困难，退路是只对 `prompt_versions.prompt_id` 建 FK，`prompts.current_version_id` 不建 DB 级 FK（仅应用层校验）。

`currentVersionId` 设为 **nullable**：新建 Prompt 时若有初始 body 则同时建 v1 draft，`currentVersionId` 仍为 null（v1 是 draft 非 prod）；首次 publish 后才指向 prod 版本。这与 mock（`prompts.service.ts:9-13` currentVersionId 指向 prod 版本）语义一致。

迁移：新增 `apps/backend/drizzle/0002_*.sql`（`pnpm --filter @codecrush/backend db:generate` 生成）。

### 3. 契约扩展（`packages/contracts/src/prompts.ts`）

```
PromptSchema 扩展：
  currentVersionId: z.string().min(1).nullable()   // 由 min(1) 改 nullable
  updatedAt: z.string().datetime()                 // 新增
  updatedBy: z.string()                             // 新增（denormalized，便于列表"更新人/时间"列）

PromptVersionSchema 扩展：
  author: z.string()                  // 由 optional 改 required（后端恒从 JWT 填）
  createdAt: z.string().datetime()   // 新增

新增 schema：
  CreatePromptRequestSchema = z.object({ name: z.string().min(1), node: PromptNodeSchema,
                                          body: z.string(), variables: z.array(z.string()).optional(),
                                          note: z.string().optional() })
  CreatePromptResponseSchema = PromptSchema   // 返回建好的 Prompt（含 v1 draft 的 currentVersionId=null）
  PromptVersionDiffSchema = z.object({
    from: PromptVersionSchema, to: PromptVersionSchema,
    lines: z.array(z.object({ type: z.enum(["same","add","del"]), text: z.string() })),
    adds: z.number().int(), dels: z.number().int() })
  PromotePromptVersionResponseSchema = z.object({ prompt: PromptSchema, version: PromptVersionSchema })
```

> 这些是 M2 skeleton 契约的合理演进（M2 契约本就是占位）。`m2-schemas.test.ts` 的 PromptSchema/PromptVersionSchema fixture（`:108,109`）需相应补 `updatedAt/updatedBy/createdAt` 字段 —— 这是**修测试 fixture 以匹配新契约**，不是软化断言（遵守 CLAUDE.md"不软化测试断言"）。`currentVersionId: "pv1"` 在 nullable 下仍合法。

### 4. 状态机 + 回滚语义（Option A）

不变量：**同一 Prompt 同时至多一个 `prod` 版本**。

- `publish(promptId, versionId)`：若目标版本已是 `prod` → `ConflictException`（幂等拒绝）；否则事务内：① 旧 prod 版本 → `archived`；② 目标版本（draft/archived）→ `prod`；③ `prompts.currentVersionId` → versionId；④ `prompts.updatedAt/updatedBy` 刷新。
- `rollback(promptId, versionId)`：**与 publish 同一实现**（promote 一个非 prod 版本到 prod）。语义上"回滚"= 把旧/归档版本再标 prod，不新建版本（对齐前端 `PromptsPage.tsx:217,249` 与原型 `CodeCrushBot.dc.html:1027`）。
- 暴露 **两个端点**（委托同一 service 方法 `promote()`），匹配前端两个按钮 + 使 AC#4/#5 各自可独立验收：
  - `POST /api/prompts/:id/versions/:versionId/publish`（draft → prod）
  - `POST /api/prompts/:id/versions/:versionId/rollback`（archived/prod → prod）
- 审计：版本 `author`/`createdAt` 记录"谁在何时创建该版本"；promote 不改版本自身审计字段，只改 `status` 与 `prompts.currentVersionId/updatedAt/updatedBy`。**M6 不引入额外 audit 表**（超范围）。

### 5. 版本号策略

`max(existing versions) + 1`（继承 M2 review 修复 `prompts.service.ts:82`）。DB 实现：`SELECT COALESCE(MAX(version),0)+1 FROM prompt_versions WHERE prompt_id=?`。并发撞 `unique(promptId,version)` 时 retry 一次（应用层）。**不得改回 length+1**。

### 6. 变量抽取与校验

- 抽取：`extractVars(body)`（contracts 纯函数，正则 `/\{[a-zA-Z_]+\}/g`）。
- 校验：`POST /:id/versions` 与 `POST /` 时，若客户端未传 `variables` 或与 body 不一致，**后端以 body 实抽为准**（`variables = extractVars(body)`），忽略客户端 `variables`（防止漂移）。若客户端传了 `variables` 且与实抽不符，可记 warning 但以实抽为准（与 mock `PromptsPage.tsx:128` `[...new Set(found)].join(" ") || pf.vars` 行为一致 —— 实抽优先）。
- 渲染：`renderBody(body, values)`（contracts 纯函数）。M6 不实现"渲染端点"（M8 编排时在 chat 模块内调用 `renderBody` + 加载 prod 版本）；M6 只保证纯函数可用 + 前端编辑器预览用同一函数。

### 7. API 面（`prompts.controller.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/prompts` | 列全部 Prompt（含 currentVersionId/updatedAt/updatedBy） |
| GET | `/api/prompts/:id` | 单个 Prompt |
| POST | `/api/prompts` | 建 Prompt（+ 隐式建 v1 draft；body 必填） |
| GET | `/api/prompts/:id/versions` | 列版本（按 version desc） |
| POST | `/api/prompts/:id/versions` | 出新版本（draft，version=max+1） |
| GET | `/api/prompts/:id/versions/:versionId` | 单版本（含 body） |
| GET | `/api/prompts/:id/versions/:fromId/diff/:toId` | 两版本 diff（`PromptVersionDiffSchema`，后端用 `diffBodies`） |
| POST | `/api/prompts/:id/versions/:versionId/publish` | 发布（draft→prod，旧 prod→archived） |
| POST | `/api/prompts/:id/versions/:versionId/rollback` | 回滚（旧版本→prod） |

全部继承全局 `ZodValidationPipe` + `JwtAuthGuard`（无需装饰器）。异常：`NotFoundException`（prompt/version 不存在）、`ConflictException`（已是 prod / 撞号 retry 失败）、`BadRequestException`（node 非法 —— 由 Zod enum 在 pipe 层 400）。

### 8. 前端接线（高层，本 spec 后端为主）

- `api/client.ts`（`006:180` 已有 fetch + Bearer 封装）加 prompts 端点方法。
- `PromptsPage.tsx` 改为从 `@codecrush/contracts` 导入 `extractVars/renderBody/diffBodies`（替换 `mocks/prompts.ts` 副本），数据从 `/api/prompts*` 拉取。
- "版本 Diff" tab 调 `/diff` 端点（或前端用 `diffBodies` 本地算 —— M6 推荐**调端点**，单一真相）。
- "绑定 Agent" tab：M6 不实现（M7），前端保留 mock 或显示"M7 接入"占位。
- `NODE_TAGS`/`NODE_META`/`VAR_PH`（中文标签/示例）留前端 `mocks/prompts.ts`（UI 展示层，非契约）。

## Changes by file

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/contracts/src/prompts.ts` | 改 | currentVersionId→nullable；PromptVersion 加 createdAt、author→required；Prompt 加 updatedAt/updatedBy；新增 CreatePromptRequest/Diff/Promote schema + extractVars/renderBody/diffBodies 纯函数 |
| `packages/contracts/src/m2-schemas.test.ts` | 改 | Prompt/PromptVersion fixture 补新字段（修 fixture 非软化）+ 新增 nullable/diff/create-prompt 用例 |
| `apps/backend/src/modules/prompts/schema.ts` | 新建 | `prompts` + `prompt_versions` pgTable（纯表，零 service 引用） |
| `apps/backend/src/db/schema.ts` | 改 | `export * from "../modules/prompts/schema"` |
| `apps/backend/drizzle/0002_*.sql` | 生成 | `pnpm db:generate` 产出 |
| `apps/backend/src/modules/prompts/prompts.repository.ts` | 新建 | drizzle 查询：list/get/create/findVersions/createVersion/findVersion/maxVersion/promote（事务） |
| `apps/backend/src/modules/prompts/prompts.service.ts` | 改 | 替换 mock 为 repo；`toPrompt`/`toVersion` 映射器；createPrompt(+v1 draft 事务)/createVersion(max+1)/diff(用 diffBodies)/promote(publish+rollback) |
| `apps/backend/src/modules/prompts/prompts.controller.ts` | 改 | 加 POST /、GET /:id/versions/:versionId、GET diff、POST publish、POST rollback；DTO 用 createZodDto；`@Req()` 取 author email |
| `apps/backend/src/modules/prompts/prompts.module.ts` | 改 | providers 加 PromptsRepository |
| `apps/backend/test/prompts.service.spec.ts` | 新建 | 单测：mock repo，验证 max+1、promote 状态机（旧 prod→archived）、diff、变量抽取 |
| `apps/backend/test/prompts.e2e.spec.ts` | 新建 | e2e（打真实 PG）：AC 1-5 全流程 |
| `apps/backend/test/skeleton.e2e.spec.ts` | 改 | prompts 段（:247-269）迁移到 prompts.e2e.spec；保留 OpenAPI 路径断言并扩展新路径 |
| `apps/backend/src/db/seed.ts` | 改（可选） | seed 4 个默认 Prompt + v1 prod，恢复 mock 演示 |
| `apps/frontend/src/pages/admin/PromptsPage.tsx` | 改 | 接 `/api/prompts*`；纯函数改从 contracts 导入；"绑定 Agent" tab 留占位 |
| `apps/frontend/src/mocks/prompts.ts` | 改 | 删除 detectVars/previewBody/lineDiff（迁入 contracts）；保留 NODE_TAGS/NODE_META/VAR_PH；PROMPT_ROWS/BODIES/VERS 改为可选 fallback 或删 |

## Intent / Non-goals / Forbidden shortcuts

**Intent**：M6 把 prompts skeleton 填成真实持久化 + 版本管理 + diff + 发布/回滚 + 变量抽取，满足 5 条 AC，且为 M7 Agent 绑定预留稳定 `PromptVersion.id`。

**Non-goals**：
- 不做"绑定 Agent"反向查询（M7）。
- 不做审批/灰度状态（mock 5 态是原型 only，契约 3 态为准）。
- 不做 prompt 渲染端点（M8 chat 编排时调用 `renderBody`）。
- 不做 audit 表 / 操作日志表（promote 只刷 status + updatedAt/updatedBy）。
- 不做多语言 prompt / 版本对比 beyond 两版本（diff 仅二元）。

**Forbidden shortcuts**：
- 不得把版本号倒退为 `length+1`（M2 review 已锁 max+1）。
- 不得软化 `m2-schemas.test.ts` 断言来"过"测试 —— 改契约就改 fixture。
- 不得在 contracts 引入 Node-only 依赖（纯函数零依赖）。
- 不得直接 import `adapters/`（本模块无适配器，仅 repo）。
- 不得在应用启动时静默跑迁移（显式 `pnpm db:migrate`）。
- 不得让问答关键路径依赖 prompt 埋点（M6 不涉及埋点）。

## Acceptance criteria → AC 映射

| AC | 验收路径 |
|---|---|
| 1. 建 Prompt | `POST /api/prompts`（name+node+body）→ 201 Prompt；隐式建 v1 draft；`currentVersionId=null` |
| 2. 出新版本 | `POST /api/prompts/:id/versions`（body）→ 201 PromptVersion，`status="draft"`，`version=max+1`，`variables=extractVars(body)` |
| 3. 两版本 diff | `GET /api/prompts/:id/versions/:fromId/diff/:toId` → 200 `PromptVersionDiffSchema`，lines 用 `diffBodies`，adds/dels 计数正确 |
| 4. 发布切生产 | `POST /api/prompts/:id/versions/:versionId/publish` → 200，目标 version `status="prod"`，旧 prod `status="archived"`，`prompt.currentVersionId` 更新；再 publish 同一版本 → 409 |
| 5. 回滚到旧版本 | `POST /api/prompts/:id/versions/:oldVersionId/rollback`（oldVersionId 是 archived）→ 200，oldVersion `status="prod"`，当前 prod → `archived`，`prompt.currentVersionId` 回到 oldVersion |

## Test plan

**单测 `prompts.service.spec.ts`**（mock repo，仿 `users.service.spec.ts:38`）：
- createVersion：max+1（含已有 v3→新 v4；删 v3 后仍 max+1 不撞号）。
- promote/publish：draft→prod，旧 prod→archived，currentVersionId 更新；已是 prod→ConflictException。
- rollback：archived→prod，当前 prod→archived。
- diff：用 `diffBodies`，adds/dels 计数。
- 变量抽取：`{question}`/`{user_level}` 识别，`{q1}`（含数字）不识别（正则无数字）。

**契约测 `m2-schemas.test.ts`**：
- Prompt/PromptVersion fixture 补 `updatedAt/updatedBy/createdAt`。
- `currentVersionId: null` 合法（nullable）。
- `CreatePromptRequestSchema` 拒绝非法 node。
- `PromptVersionDiffSchema` 正反例。

**e2e `prompts.e2e.spec.ts`**（打真实 PG，仿 `traces.repository.spec.ts` 模式 —— 需 docker compose infra up）：
- AC 1-5 全流程串行：建 Prompt → 出 v2 draft → diff v1↔v2 → publish v2 → rollback v1 → 验证 currentVersionId 与 status。
- 鉴权：无 token → 401。
- 非法 body（node 非法）→ 400 + `Validation failed` + errors（对齐 `zod-pipe.e2e.spec.ts:45`）。

**`skeleton.e2e.spec.ts` 改造**：
- prompts 段（:247-269）移除（其 TestingModule :59-77 无 PersistenceModule，DB-backed service 无法实例化），迁入 `prompts.e2e.spec.ts`。
- OpenAPI 段（:319-336）扩展：新增 `/api/prompts`（POST）、`/diff`、`/publish`、`/rollback` 路径断言。

## Risks / unknowns

1. **`currentVersionId` nullable 的契约变更影响面**：改 `z.string().min(1)` → nullable 会影响所有 `Prompt` 消费方。已 grep：仅 `m2-schemas.test.ts:108` 与 `skeleton.e2e.spec.ts:248-251` 引用 `PromptSchema`，影响可控。但 M7 Agent 绑 prompt 版本（`agents.ts:15-18` `promptRewriteVerId` 等）—— 那是绑 `PromptVersion.id` 非 `Prompt.currentVersionId`，不直接受影响。**未决**：是否接受"Prompt 可无 prod 版本"的产品语义（一个从未发布的 prompt 出现在列表但 currentVersionId=null）。建议接受（与"草稿态 prompt"自然语义一致）。

2. **回滚是否应新建版本（Option B）**：本 spec 选 Option A（再标 prod，不新建版本），依据前端 mock `PromptsPage.tsx:217,249` 与原型 `:1027`。**未决**：审计视角下"回滚"是否需要留痕为一次新发布（Option B）。Option A 的留痕靠 `prompt_versions.status` 变更 + `prompts.updatedAt/updatedBy`，但版本自身 `author/createdAt` 不变 → 看不出"谁在何时回滚"。若审计要求强，需加 audit 表（超 M6 范围）。建议 M6 用 A，audit 表留 revisit。

3. **前端"绑定 Agent" tab 的 M6 处理**：该 tab 在版本抽屉里（`PromptsPage.tsx:715-719` "绑定 Agent"）。M6 不做 agents 反查（M7）。**未决**：M6 期间该 tab 显示什么 —— 保留 mock 数据（与真实 agents 不符，可能误导）、显示空态、还是"M7 接入"占位。建议显示空态 + "M7 接入"提示，避免 mock 数据与真实 prompt 版本 id 不一致造成混淆。

4. **diff 端点 vs 前端本地算**：本 spec 建议后端 `/diff` 端点为单一真相，但前端 mock 现状是本地 `lineDiff`（`PromptsPage.tsx:223`）。`diffBodies` 既在 contracts，前端也可本地算。**未决**：是否真需要后端 diff 端点（增加一个端点 + 测试），还是前端用 contracts 纯函数本地算即可满足 AC#3。倾向保留后端端点（程序化消费 + OpenAPI 自文档 + M9 "跳 Prompt 版本"可复用），但承认这是可辩论的。

5. **seed 是否扩展**：M6 是否要 seed 4 个默认 Prompt（恢复 mock 演示）。非 AC 要求，但"在工作"信号更友好。**未决**：纳入 M6 还是留 M7。建议纳入（轻量，`seed.ts` 已有 pattern）。

## Self-review

- 占位扫描：无 TBD/TODO/"similar to"。
- 内部一致：Option A 在 §4/AC#5/Risk#2 一致；max+1 在 §5/§2/Test 一致；纯函数落点在 §1/§6/§8 一致。
- 范围检查：未越界到 M7（agents 绑定）/M8（渲染端点）/审批灰度。
- 歧义检查：publish/rollback 委托同一 `promote()` 已说明；currentVersionId nullable 已说明动机。
- 完整性：所有 file:line 均为已读文件；无推测代码。
