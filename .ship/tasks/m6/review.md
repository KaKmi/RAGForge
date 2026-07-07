# M6 Code Review

> Scope: `feat/m2-app-shell...HEAD` + worktree（Story 6 未提交：.gitignore / AGENTS.md / CLAUDE.md / seed.ts / dev-ledger）。
> Spec: `.ship/tasks/m6/plan/spec.md`（AC 1-12）。
> 模式：轻量对抗收尾审（CLAUDE.md），覆盖全量 diff。
> 已读全量改动文件：contracts（prompts/prompt-template/index/tests）、backend（schema/repository/service/controller/module/e2e/spec/seed）、frontend（client/mocks/PromptsPage/test）、迁移 SQL。

## Findings

### P3: `createPrompt` 未包事务，偏离 spec §5 设计意图
- File: `apps/backend/src/modules/prompts/prompts.service.ts:27-44`
- Trigger: `createPrompt` 先 `repo.insertPrompt(...)` 再 `repo.insertVersion(...)`，两步无事务边界。service 构造函数只注入 `repo`（不注入 `db`，`:14`），无法自开事务。
- Observation: spec §5（`plan/spec.md:207-214`）明确 `db.transaction(async tx => { insertPrompt; insertVersion })`；实现选"对齐 users.service 范式"无 tx。dev-ledger L35 已记为有意识 trade-off（"createPrompt 无 tx（测试支配，对齐 users.service）；原子性风险（v1 失败留孤儿 prompt）记入 concerns"）。
- Impact: 若 `insertPrompt` 成功但 `insertVersion` 失败（DB 故障/连接断），留下孤儿 prompt（无 v1 draft，`currentVersionId:null`）。后续 `createVersion` 的 `max+1` 仍工作（读 0 → v1），但 `list` 会显示一个无版本的 prompt。影响窄：greenfield + 单用户 + v1 首版本无 unique 冲突，仅 DB 故障才触发。
- Fix direction（可选，不阻塞 M6）：给 `PromptsService` 注入 `db: DB`，`createPrompt` 包 `db.transaction`，repo 方法接 `tx | db` 参数（或在 repo 加 `createPromptWithFirstVersion` 单事务方法）。若维持现状，确保文档化已做（dev-ledger）。

## 已审查无问题的关键路径

- **`publishVersion` 事务正确**（`prompts.repository.ts:65-93`）：单事务内 archive 旧 prod（`WHERE promptId=? AND status='prod'`）→ set 新 prod（`WHERE id=versionId`）→ 更新 `prompts.currentVersionId/updatedBy/updatedAt` → re-select + guard。service.promote 预校验 `v.status==='prod' → 409`（D15）+ `v.promptId!==promptId → 404`，故事务内 versionId 不会是当前 prod。单 prod 不变量保证。
- **`createVersion` retry**（`prompts.service.ts:58-78`）：`max+1` + `unique(promptId,version)` 兜底；attempt 0 撞 23505 → attempt 1 重算 max（读到并发写入）→ 递增；二次失败 → 409。与 spec §5 一致。
- **回滚语义 Option A**（D2）：`promote()` 既处理 draft→prod 也处理 archived→prod，controller `/publish` 与 `/rollback` 双端点委托同一方法。e2e 验证 rollback v1（archived）→ v1 prod + v2 archived + currentVersionId 回到 v1（`skeleton.e2e.spec.ts:401-422`）。
- **D6 author 不可伪造**：controller `@Req() req: AuthedRequest` 取 `req.user.email`（`prompts.controller.ts`）；请求 schema `CreatePromptVersionRequestSchema`/`CreatePromptRequestSchema` 不含 author，`ZodValidationPipe` strip 未知字段。e2e "D6 不接受请求体 author"（send forged author，断言 `res.body.author === PRINCIPAL.email`）。
- **D16 时间戳/更新人**：schema `prompts.updatedBy/updatedAt` + `promptVersions.createdAt/author`；`createPrompt` 设 `updatedBy=actorEmail`；`publishVersion` 刷 `updatedBy=actorEmail, updatedAt=now()`；`toPrompt/toVersion` Date→ISO。e2e 断言 `updatedBy===JWT email` + `updatedAt` 推进。
- **共享纯逻辑双端锁一致**（003 §Isomorphic）：`extractVars/renderTemplate/diffPromptBodies` 在 `packages/contracts/src/prompt-template.ts`，backend service + frontend PromptsPage 同 import。单一真相，前端预览 == 后端渲染。
- **前端接通**（`PromptsPage.tsx`）：`useEffect(getPrompts)` 挂载；新建/编辑/版本抽屉接 create/createVersion/publish/rollback；diff 用 `diffPromptBodies`；变量识别 `extractVars` + 预览 `renderTemplate`。`actOnVersion` 统一 draft→publish / archived→rollback，从 useMemo 移出避免 exhaustive-deps。`canPublishSel = !!selVersion && selStatus !== "prod"` 防 versions 空时渲染空按钮。
- **seed**（`seed.ts`）：`onConflictDoNothing({target: prompts.name}).returning()` → conflict 时 `prompt=undefined → continue` 跳过已存在；新建则 insert v1 prod + update currentVersionId。幂等可重跑。
- **e2e 非假绿**：inMemoryRepo `publishVersion`（`skeleton.e2e.spec.ts:97-113`）语义与真实 repo 一致（archive 旧 prod → set 新 prod → 刷 currentVersionId/updatedBy/updatedAt），7 测试覆盖 AC 1/3/4/5/10/11/12 + D6。
- **依赖边界**：frontend 只 import `@codecrush/contracts`（client + prompt-template + NODE_LABEL），不 import backend/otel；ESLint 0。

## Open questions

- 无。createPrompt 无事务是唯一 finding，且为已记录的 trade-off，非阻塞。

## 结论

M6 全量 diff 审查通过。1 个 P3（createPrompt 无事务，已知 trade-off，dev-ledger 已记），无 P1/P2。AC 1-12 均有测试或代码覆盖。建议：若后续 M7/M8 依赖 prompts 原子创建，再补事务；M6 可维持现状。
