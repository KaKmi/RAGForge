# Dev Ledger — M6 Prompt 管理

> 轻量对抗模式：host 直接实现每 story，不做每 story peer review；收尾跑一次 `/ship:review` 覆盖全量 diff。
> 基线分支：`design/m3-m6` @ `feat/m2-app-shell` (75e9b61)。

## 已完成

### Story 1 — 契约修订 + 共享纯逻辑 + 测试
- Commit: `4951718` `feat(contracts): evolve prompt schemas + add shared prompt-template pure functions for M6`
- 改动：
  - `packages/contracts/src/prompt-template.ts`（NEW）：`extractVars`/`renderTemplate`/`diffPromptBodies`（003 §Isomorphic 双端共享纯逻辑，零 zod 依赖）。
  - `packages/contracts/src/prompt-template.test.ts`（NEW）：10 vitest 用例。
  - `packages/contracts/src/prompts.ts`：`PromptSchema.currentVersionId` 改 nullable + 补 `updatedAt/updatedBy`；`PromptVersionSchema.body` min(1) + `author` 必填 + 补 `createdAt`；新增 `CreatePromptRequestSchema` / `PublishPromptVersionResponseSchema`；`CreatePromptVersionRequestSchema` 简化为 `{ body, note? }`（删 variables/author，D5/D6）。
  - `packages/contracts/src/index.ts`：追加 `export * from "./prompt-template";`。
  - `packages/contracts/src/m2-schemas.test.ts`：补 currentVersionId:null 正例、nullable/必填字段负例、CreatePrompt(Request|Version) DTO 用例。
- 验证：contracts 67 tests passed，build OK，lint 0。

### Story 2 — DB schema + 迁移
- Commit: `8554d62` `feat(backend): add prompts + prompt_versions tables with unique/index + updatedBy`
- 改动：
  - `apps/backend/src/modules/prompts/schema.ts`（NEW）：`prompts`（uuid pk, name unique, node, current_version_id nullable, updated_by, created_at/updated_at）+ `prompt_versions`（uuid pk, prompt_id FK cascade, version int, body text, variables jsonb default '[]', note, author notnull, status default 'draft', created_at）+ `unique(prompt_id, version)` + `index(prompt_id, status)`。
  - `apps/backend/src/db/schema.ts`：barrel 追加 `export * from "../modules/prompts/schema";`。
  - `apps/backend/drizzle/0002_vengeful_chronomancer.sql`（生成）：建两表 + FK + unique/index。
- 验证：迁移应用成功；psql 验证 `prompt_versions` 表结构与索引/外键一致（jsonb variables、unique(prompt_id,version)、index(prompt_id,status)、FK cascade）。
- 注：tsc 此时红（M2 prompts.service mock 数据不满足 Story 1 新契约），属契约演进级联，Story 3 修。

### Story 3 — PromptsRepository + PromptsService 重写 + service spec
- Commit: `48c4cf8` `feat(backend): rewrite PromptsService with extractVars/actorEmail/promote + repository`
- 改动：
  - `apps/backend/src/modules/prompts/prompts.repository.ts`（NEW）：`@Inject(DRIZZLE) db: DB` + findPrompts/findPromptById/insertPrompt/findVersions/findVersionById/insertVersion/findProdVersion（保留供 M7/M8）/`publishVersion` 单事务（archive 旧 prod → set 新 prod → 更新 prompt.currentVersionId/updatedBy/updatedAt）。
  - `apps/backend/src/modules/prompts/prompts.service.ts`（重写）：注入 repo（不注入 db，createPrompt 无 tx 走两步 repo 调用，对齐 users.service 范式）；`extractVars(req.body)` 抽变量、`actorEmail` 填 author/updatedBy；`createVersion` max+1 + unique 撞号 retry 一次（D8）；`promote` 委托 repo.publishVersion，已 prod → 409（D15），版本不存在/不属于 → 404。`toPrompt/toVersion` Date → ISO。
  - `apps/backend/test/prompts.service.spec.ts`（NEW）：12 用例覆盖 createPrompt/createVersion（retry 成功/失败/非 unique）/promote（draft→prod/已 prod 409/不属于/不存在）/toPrompt/toVersion ISO/D5D6 不读请求体。
  - `apps/backend/src/modules/prompts/prompts.module.ts`：providers 加 PromptsRepository。
- 决策：
  - createPrompt 无 tx（测试支配，对齐 users.service）；原子性风险（v1 失败留孤儿 prompt）记入 concerns。
  - plan 的 createVersion retry 逻辑有 bug（第二次 unique 冲突会 throw 原始错误而非 ConflictException），修正为第二次 unique 冲突 → ConflictException。
  - service 不注入 db（dev-context 决策：createPrompt 无 tx 走 repo，promote 事务在 repo 内）。
- 验证：`pnpm --filter @codecrush/backend exec jest prompts.service` → 12 passed。
- 注：tsc 仍红（M2 controller 调 2-arg createVersion，签名变了），e2e prompts 块红（inMemoryRepo 未 override + 依赖 mock p1），属级联，Story 4 修。

### Story 4 — Controller 扩展 + e2e 重写
- Commit: `f30cacc` `feat(backend): wire PromptsController with create/publish/rollback endpoints + AuthedRequest`
- 改动：
  - `apps/backend/src/modules/prompts/prompts.controller.ts`（重写）：加 `POST /`（createPrompt）、`POST /:id/versions/:versionId/publish`、`POST /:id/versions/:versionId/rollback` 三端点（D2 双端点委托同一 promote）；`@Req() req: AuthedRequest`（`{ user: AuthenticatedUser }`）取 `req.user.email` 传 service（D6）；所有方法改 async/Promise。
  - `apps/backend/test/skeleton.e2e.spec.ts`：overrideProvider(PromptsRepository).useValue(inMemoryPromptsRepo)（DB-free）；inMemoryPromptsRepo 维护两数组 + 8 方法（含 publishVersion 单事务语义：archive 旧 prod → set 新 prod → 刷 prompt.currentVersionId/updatedBy/updatedAt）；prompts 块重写为 7 测试（建 prompt → v1 draft → publish v1 → 已 prod 409 → v2 publish + v1 archived + updatedBy 推进 → rollback v1 → D6 拒绝伪造 author）；OpenAPI 块加 `POST /api/prompts`、`publish`、`rollback` 三 path 断言。
  - `apps/backend/src/modules/prompts/prompts.module.ts`：无改（Story 3 已加 PromptsRepository providers）。
- 决策：
  - inMemoryRepo insertPrompt/insertVersion 显式构造 row（不 spread），避免 plan 的 `...row` 覆盖 id/createdAt 风险。
  - D6 测试：body 带 `author:"forged@evil.com"`，ZodValidationPipe strip 未知字段，service 用 JWT email → res.body.author === PRINCIPAL.email。
  - AuthedRequest = `{ user: AuthenticatedUser }`（最小结构类型，guard 保证 user 已挂）。
- 验证：tsc 0 errors；jest 14 suites / 76 passed（含 prompts 块 7 + service spec 12 + OpenAPI 断言）；lint 0。
- 级联红全修复：Story 3 的 tsc/e2e 红在 Story 4 清零。

### Story 5 — 前端接通（client + PromptsPage + mocks 清理）
- Commit: `25ba8e9` `feat(frontend): wire PromptsPage to real backend + shared prompt-template functions`
- 改动：
  - `apps/frontend/src/api/client.ts`：加 `createPrompt` / `createPromptVersion` / `publishPromptVersion` / `rollbackPromptVersion` 四写函数（请求体无 author，D6 服务端从 JWT 填）。
  - `apps/frontend/src/mocks/prompts.ts`（重写）：删 mock 数据（PROMPT_ROWS/BODIES/V/VERS）+ 本地纯函数（detectVars/previewBody/lineDiff/bodyOf，迁 contracts）；保留 UI 常量 NODE_TAGS/NODE_META/VAR_PH/STV；`PromptNode`/`PromptVersionStatus` 改 `z.infer` 对齐契约英文 enum；加 `NODE_LABEL`（rewrite→问题改写…）/`STATUS_LABEL`（draft→草稿…）中文映射；删 `审批中/灰度中`（契约无）。
  - `apps/frontend/src/pages/admin/PromptsPage.tsx`（重写）：`useEffect(getPrompts)` 挂载调真 API；新建抽屉 → `createPrompt`；编辑抽屉 → `getPromptVersions` 取 prod body → `createPromptVersion`（出新 draft）；版本管理抽屉 → `getPromptVersions` + `diffPromptBodies`（共享）+ `publishPromptVersion`/`rollbackPromptVersion`；变量识别 `extractVars` + 预览 `renderTemplate`（共享）；列表列改 `NODE_LABEL[node]` + 状态徽标（currentVersionId!=null→生产中/草稿）+ `updatedBy · formatDateTime(updatedAt)`；"绑定 Agent" tab 空态"M7 接入后展示"。
  - `apps/frontend/src/app/App.test.tsx`：+1 测试 `loads PromptsPage from real /api/prompts`（mock fetch 返 []，断言挂载调 `/api/prompts` + 空列表态）。
- 决策：
  - 列表"当前版本"列显状态徽标（生产中/草稿）而非版本号：`Prompt` 契约无 version 字段，版本号在版本抽屉显；避免 N+1 拉 versions。
  - 编辑抽屉基于 prod 版本 body 起新 draft（`createPromptVersion`），非原地改；与后端"出新版本"语义一致。
  - `actOnVersion` 统一 draft→publish / archived→rollback，版本列表项与 diff 底部按钮共用；从 useMemo 移出 `onPublishSel` 避免 exhaustive-deps 警告。
- 验证：tsc 0 errors；frontend 17 tests passed（+1 M6）；lint 0；build OK（PromptsPage chunk 21.04 kB）。
- 跨 story 回归：`pnpm test` 93 passed（backend 76 + frontend 17）+ `pnpm lint` 0 + `pnpm build` 5/5 successful。

### Story 6 — 收尾验证 + seed + review
- Commit: `eebe80e` `chore(m6): seed default prompts + document dc.html prototype + review pass`
- 改动：
  - `apps/backend/src/db/seed.ts`：扩展加 4 默认 Prompt（rewrite/intent/reply/fallback 各 v1 prod，D9 optional）；`onConflictDoNothing({target: prompts.name}).returning()` → 已存在跳过；新建则 insert v1 prod + update currentVersionId（保 demo 连续性，对齐 M2 mock 4 prod 版本）。
  - `.gitignore`：加 `CodeCrushBot.dc.html`（前端 UI 原型 HTML，不进仓库/打包）。
  - `AGENTS.md`：新增「原型参考（CodeCrushBot.dc.html）」节，说明作用 + 不进仓库/打包。
  - `CLAUDE.md`：高频提醒加一条指向 AGENTS.md「原型参考」。
  - `.ship/tasks/m6/review.md`（NEW）：轻量对抗收尾审，覆盖 `feat/m2-app-shell...HEAD` 全量 diff。
- review 结论：1 P3（`createPrompt` 无事务，dev-ledger Story 3 已记 trade-off，非阻塞），无 P1/P2。AC 1-12 均有测试或代码覆盖。关键路径（publishVersion 事务/createVersion retry/D2 回滚/D6 author 不可伪造/D16 时间戳/共享纯逻辑双端锁/e2e 非假绿）审查无问题。
- 决策：
  - seed v1 设 `status:"prod"` + `currentVersionId`（非 draft）：保 demo 连续性，plan L753 选后者。
  - dc.html 文档化进 AGENTS.md/CLAUDE.md + .gitignore，而非进仓库（256KB 非源码易变）。
- 验证：backend tsc 0 + frontend tsc 0 + lint 0；seed 编译通过（未跑实际 seed，需 docker compose 起 postgres）。
- 未做（deferred）：手动集成验收（docker compose + dev server 全链路 curl/浏览器）——需用户本地起依赖服务执行，AC 9 的 `pnpm test/lint/build` 已绿。

### 数据丢失与恢复（事故记录）
- 另一 M3 开发窗口暂停时跑了一次 `git reset`（reflog `HEAD@{0}: reset: moving to HEAD`），把 Story 1 全部未提交工作（prompts.ts/index.ts/m2-schemas.test.ts 改动 + 新建 prompt-template.ts/test）连同 M3 WIP 一起冲掉，且未建 stash。
- 未跟踪文件不在 git 对象库，无法 fsck 恢复。从对话上下文完整重建 4 文件 + 5 处 m2-schemas 编辑，重新验证 67 tests/build/lint 全绿后立即提交锁定。
- 教训：多窗口并行开发同一仓库时，提交节奏要快（每 story 完成立即 commit），避免长时间持留未提交改动。

### 验收修复轮 — 方案 A 后端 join 聚合 + antd 重写 + 变量预览 bug
- 触发：手动验收对照原型（`RAG知识库问答系统设计/`）发现 3 个差距——列设计与原型出入（5 列 vs 原型 6 列）、变量预览不替换、UI 未用 antd。
- 方案 A（用户拍板）：后端 list/get 端点 join 聚合 `currentVersionNumber`（nullable）+ `versionCount`，前端一次请求拿全，避免 N+1，契约单一来源。
- 改动：
  - `packages/contracts/src/prompts.ts`：`PromptSchema` 加 `currentVersionNumber: z.number().int().positive().nullable()` + `versionCount: z.number().int().nonnegative()`。
  - `packages/contracts/src/m2-schemas.test.ts`：fixture 加两字段 + 正例（未发布两字段 null）+ 2 反例（缺字段/负 versionCount）。
  - `apps/backend/src/modules/prompts/prompts.repository.ts`：新增 `PromptListRow` 类型 + `PROMPT_AGG_SELECT`（含 `sql<number|null>` 子查询取 currentVersionNumber + `sql<number>` COUNT 子查询取 versionCount）；`findPrompts`/`findPromptById` 改用 `.select(PROMPT_AGG_SELECT)` 返回 `PromptListRow`（含 createdAt 透传）。
  - `apps/backend/src/modules/prompts/prompts.service.ts`：`toPrompt(row: PromptListRow)` 透传两聚合字段；`createPrompt` insert + insertVersion 后调 `repo.findPromptById` 取聚合行（保证返回契约完整）。
  - `apps/backend/test/prompts.service.spec.ts`：引 `promptListRow` 常量；createPrompt 测加 `findPromptById` mock + 两字段断言；list 测加聚合断言。
  - `apps/backend/test/skeleton.e2e.spec.ts`：`inMemoryPromptsRepo` 加 `toListRow` 计算聚合；POST/publish/v2-publish 三测加 `currentVersionNumber`/`versionCount` 断言。
  - `apps/frontend/src/pages/admin/PromptsPage.tsx`：antd v6 重写（Table/Drawer/Button/Tag/Input/Select/Space/Popconfirm/Tabs/Alert）；8 列（Prompt 名称|所属节点|所属 agent|当前版本|状态|更新人|更新时间|操作）；「所属 agent」占位 `—`（M7 补真实关联）；操作列条件渲染（编辑恒显 / 版本历史 `versionCount>1` / 发布 `currentVersionId===null` 走 Popconfirm）；Drawer 用 `size={number}` 替代弃用的 `width`。
  - `apps/frontend/src/pages/admin/PromptsPage.tsx` 变量预览 bug 修复：`pfDetected = extractVars(pf.body)`（不带花括号，`["context"]`），与 `renderTemplate` 的 `vars["context"]` 查找一致；显示变量名用 `{${v}}`；`VAR_PH` key 带花括号故用 `{${v}}` 查。
  - `eslint.config.mjs`：ignores 加 `RAG知识库问答系统设计/**`（原型参考目录，非源码）。
- 验证：contracts 69 + backend 76 + frontend 17 测试通过；tsc 0 errors；lint 0 errors；build 5/5 successful。
- 未提交：待用户确认后按 Conventional Commits 提交。

### 验收修复轮（续）— versionCount=0 相关子查询列名遮蔽 bug

- 触发：浏览器验收 curl `GET /api/prompts` 发现 `currentVersionNumber: 1`（正确）但 `versionCount: 0`（应为 1+）。直接 psql `SELECT COUNT(*) FROM prompt_versions WHERE prompt_id = p.id` 返回 1，DB 数据正确，定位到 drizzle SQL 生成层。
- 根因（用 `.toSQL()` 诊断脚本确认）：drizzle 的 `sql` 模板里 `${prompts.id}` 渲染成**未限定的 `"id"`**，而非 `"prompts"."id"`。在相关子查询 `SELECT COUNT(*) FROM prompt_versions WHERE prompt_id = "id"` 中，内层 `prompt_versions` 也有 `id` 列，Postgres 把 `"id"` 解析到**内层** `prompt_versions.id`，于是条件变成 `prompt_versions.prompt_id = prompt_versions.id`（不同 UUID，恒 false）→ COUNT=0。
  - `currentVersionNumber` 侥幸正常：内层 `prompt_versions` 没有 `current_version_id` 列，Postgres 回退到外层 `prompts.current_version_id`，且内层 `"id"` 正好指 `prompt_versions.id`（恰为所需 join 条件）——纯运气。
- 修复：`prompts.repository.ts` 的 `PROMPT_AGG_SELECT` 两个子查询的外层引用显式限定为 `"prompts"."id"` / `"prompts"."current_version_id"`（raw 文本嵌入 `sql` 模板，因外层表恒为 `prompts`）。加注释说明原因。
- 验证：
  - 诊断脚本（临时 `scripts/diag-prompts-sql.ts`，验证后已删）确认生成 SQL 为 `WHERE "prompt_id" = "prompts"."id"`，返回 `versionCount: 1/2`（与实际一致）。
  - `curl GET /api/prompts`（带 demo token）返回 6 行，`currentVersionNumber` 与 `versionCount` 均正确。
  - backend 76 + frontend 17 测试通过；tsc 0；lint 0；build 5/5。
- 教训：drizzle `sql` 模板插值 `${table.col}` **不保证带表名限定**，相关子查询里若内外表有同名列必被内层遮蔽。相关子查询一律显式限定外层列引用，或改用 `alias` + `.from(alias)`。
