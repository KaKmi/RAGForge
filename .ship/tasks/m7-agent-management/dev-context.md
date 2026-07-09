# Dev Context — M7 Agent 配置与管理

## Test Command
- 全量：`pnpm test`（根 turbo）
- 后端单文件：`pnpm --filter @codecrush/backend test -- <spec 名>`
- 契约包：`pnpm --filter @codecrush/contracts test`
- Lint：`pnpm lint`（依赖边界必须 0）
- 构建：`pnpm build`

## Code Conduct
- TypeScript strict；Prettier（semi、双引号、printWidth 100、trailingComma all）。
- 契约唯一来源 `packages/contracts`（只依赖 zod）；前端只 import contracts/otel-conventions。
- 跨域只走对方 barrel 导出的 service/端口，不直接 import adapters/。
- 域内 `schema.ts` 纯表定义，零 service 引用。
- Conventional Commits，结尾 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`（CLAUDE.md 规定格式）。
- 前端组件优先 antd（用户拍板 2026-07-08）。

## Pattern References
### Task 1（契约）: `packages/contracts/src/prompts.ts` + `knowledge-bases.ts`
- Mirror: schema+type 成对导出、`z.strictObject` 拒绝未知键的注释写法（knowledge-bases.ts:36-44）。
### Task 2（schema）: `apps/backend/src/modules/prompts/schema.ts`
- Mirror: uniqueIndex/index 命名（`<table>_<cols>_idx`）、`.$type<T>()` jsonb 断言、循环 FK 注释。
### Task 3-5（service/repo）: `apps/backend/src/modules/prompts/prompts.{service,repository}.ts`
- Mirror: `PROMPT_AGG_SELECT` 相关子查询显式限定外层表名；publishVersion 三步事务；max+1 撞号重试。
- Deviation: FK/unique 违反检测一律用 `e.cause.code`（models.service.ts:177-185 已验证正确），不用 prompts 的顶层 `e.code`（疑似死代码 bug，不修）。
### Task 6（controller）: `apps/backend/src/modules/prompts/prompts.controller.ts`
- Mirror: createZodDto、AuthedRequest 类型声明、publish/rollback 双端点。
### Task 7（e2e）: `apps/backend/test/skeleton.e2e.spec.ts` 既有 inMemoryXxxRepo 模式。
### Task 8-9（前端）: `apps/frontend/src/pages/admin/PromptsPage.tsx` + `api/client.ts` prompts 区块。
- Mirror: antd Table/Drawer/Popconfirm 组合、refreshList/loading/listErr 状态管理、postJson/apiFetch 封装。

## Waves
全部 sequential（Task N+1 依赖 Task N 的产物）：契约 → schema → 联动补丁 → repo → service → controller → e2e → client → 页面 → 收尾。
轻量对抗档：无逐 story peer review；Task 10 一次 /code-review 全量 diff。
