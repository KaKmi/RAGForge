# Dev Context — M4 入库管线

## Test Command
- Full suite (regression gate): `pnpm test`（baseline @42fe004 全绿）
- Lint gate: `pnpm lint`（边界规则必须 0）
- Per-package: `pnpm --filter @codecrush/{contracts|backend|frontend} test`

## Code Conduct
- TypeScript strict; Prettier: semi, 双引号, printWidth 100, trailingComma all.
- Conventional Commits, 按 story 小步提交，commit 尾部 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- 契约唯一来源 `packages/contracts`（只依赖 zod，严禁 Node-only 依赖）。
- 前端只 import `@codecrush/contracts` / `@codecrush/otel-conventions`。
- 任何地方不得直接 import `adapters/`（只走 DI token）——lint 不强制，评审自律。
- 域内 `schema.ts` 纯表定义，零 service 引用。
- 后端测试 `@swc/jest`（测试放 `apps/backend/test/*.spec.ts`）；contracts/前端 vitest。
- 不软化测试断言；迁移显式 `pnpm db:migrate`，不在启动时执行。

## Adversarial Tier
完整对抗（架构性任务，CLAUDE.md 判定）：每 story 独立 peer review（Codex 优先）。

## Pattern References（按任务类别分组）
- 契约 (T1-3): `packages/contracts/src/models.ts`（枚举+omit 派生模式）、`packages/contracts/src/m2-schemas.test.ts`（断言风格，vitest）。
- 域 schema/repository (T8-10): `apps/backend/src/modules/models/schema.ts`（text 列+应用层枚举收口）、`apps/backend/src/modules/models/models.repository.ts`（find/findById/insert/update/delete 薄封装）。
- 平台件 (T5-7): `apps/backend/src/platform/config/`（module+service 模式）、`apps/backend/src/modules/models/models.module.ts:13-16`（DI token provide/exports 模式）、`model-provider.constants.ts`（Symbol token）。
- 注册表分发 (T12-14): `apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts:25-39`（PROBE_BUILDERS 查表 + 不可达防御分支）、`apps/backend/test/protocol-dispatch.adapter.spec.ts`（完整性断言写法）。
- service/controller (T18-20): `apps/backend/src/modules/models/models.service.ts` + `models.controller.ts`（Zod DTO + ZodValidationPipe）、`apps/backend/test/models.service.spec.ts:10-42`（makeRepo mock 写法）。
- e2e (T22): `apps/backend/test/skeleton.e2e.spec.ts`（overrideProvider().useValue() 假仓储 + auth() helper——T22 必须先通读全文件再改）。
- 前端 client (T23): `apps/frontend/src/api/client.ts`（apiFetch/postJson 形态；:72-85 有 FormData Content-Type bug 待修）、`apps/frontend/src/api/sse.test.ts`（同目录测试先例）。
- 前端页面 (T24-26): `apps/frontend/src/pages/admin/ModelsPage.tsx`（useEffect 拉取+抽屉表单范式）。
- 接线测试 (T27): `apps/frontend/src/app/App.test.tsx:85-133`（mock global.fetch 断言真实 API URL 的既定模式）。

## Waves（依赖图按 plan Interfaces/Files 块推导）
- W1 (parallel): T1 契约chunks / T4 依赖+配置 / T7 pgvector helper / T12 embed()
- W2 (parallel): T2 契约documents（同测试文件承接T1）/ T5 storage（←T4）/ T6 queue（←T4 pg-boss）/ T13 parsers（←T4 pdf-parse,mammoth）
- W3 (parallel): T3 契约kb（同测试文件承接T2）/ T9 documents schema+repo（←T2）
- W4 (parallel): T8 kb schema+repo（←T3）/ T10 chunks schema+repo（←T1,T7,T9）/ T14 chunkers（←T3 ChunkTemplate）/ T23 前端client（←T1-3）
- W5 (parallel): T11 迁移（←T7-10, judgment）/ T15 pipeline（←T4,T10,T12,T13,T14）
- W6 (parallel): T16 processor+IngestionService（←T5,T6,T8,T9,T15）/ T24 KB页（←T23）
- W7 (parallel): T17 kb-rebuild（←T16 同文件 ingestion.service.ts, judgment）/ T25 Documents页（←T24）/ T26 Chunks页（←T24）
- W8 (parallel): T18 KB service/controller（←T17）/ T19 Documents service/controller（←T16）/ T20 Chunks service/controller（←T10）
- W9 (parallel): T21 app.module 接线 / T27 mock 清理+App.test
- W10 (single): T22 e2e 重写（←全部, judgment）

同文件约束：T1→T2→T3 共享 knowledge-schemas.test.ts 故跨波顺序；T16→T17 共享 ingestion.service.ts/module.ts 故跨波顺序。
