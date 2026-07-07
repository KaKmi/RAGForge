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
- Commit: （本提交）
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

### 数据丢失与恢复（事故记录）
- 另一 M3 开发窗口暂停时跑了一次 `git reset`（reflog `HEAD@{0}: reset: moving to HEAD`），把 Story 1 全部未提交工作（prompts.ts/index.ts/m2-schemas.test.ts 改动 + 新建 prompt-template.ts/test）连同 M3 WIP 一起冲掉，且未建 stash。
- 未跟踪文件不在 git 对象库，无法 fsck 恢复。从对话上下文完整重建 4 文件 + 5 处 m2-schemas 编辑，重新验证 67 tests/build/lint 全绿后立即提交锁定。
- 教训：多窗口并行开发同一仓库时，提交节奏要快（每 story 完成立即 commit），避免长时间持留未提交改动。
