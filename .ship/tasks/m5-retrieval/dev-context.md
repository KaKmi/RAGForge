# Dev Context — m5-retrieval

## Test Command

- 全量回归:`pnpm test`(turbo,改动后必跑,AGENTS.md)
- 后端单包:`pnpm --filter @codecrush/backend test`(Jest + @swc/jest,匹配 `apps/backend/test/**/*.spec.ts`)
- 契约单包:`pnpm --filter @codecrush/contracts test`(vitest)
- lint:`pnpm lint`(必须 0 违规)

## Code Conduct

- TypeScript strict;Prettier(semi、双引号、printWidth 100、trailingComma all)。
- Conventional Commits,按 story/小步提交;commit 尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`(CLAUDE.md)。
- 跨域模块只走对方 barrel 导出的 service/端口;不得直接 import `adapters/`(DI 注入)。
- 域内 `schema.ts` 纯表定义,零 service 引用。
- 不软化测试断言来「过」测试——修代码。
- 注释只写代码本身表达不了的约束,密度对齐周边代码(中文注释为主)。
- 前端组件优先用 antd(用户拍板 2026-07-08),自定义 style 仅用于 antd 覆盖不到的视觉细节。

## Pattern References

### Story 1: models 域 rerank 能力(plan Tasks 1-4)
- Reference: `apps/backend/src/modules/models/adapters/embed-builders.ts`
  - Why analogous: RERANK_BUILDERS 镜像 EMBED_BUILDERS 的「(protocol)→纯函数 builder 表 + parseResponse」模式
  - Mirror: 查表分发、`as Record<string, X>` 收尾 cast、注释说明不在表内的协议走防御分支
  - Deviations: builder 多一个 `query` 与可选 `topN` 参数
- Reference: `apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts:100-151`(embed 方法)
  - Mirror: AbortController 超时、redactSecret/upstreamError 脱敏、非 2xx 抛错
  - Deviations: 超时用 RERANK_TIMEOUT_MS=5s(非 embed 的 60s——rerank 在交互路径上)
- Reference: `apps/backend/test/embed-builders.spec.ts`、`apps/backend/test/protocol-dispatch.adapter.spec.ts:176-233`(embed describe 块含 fake-timer 超时用例)、`apps/backend/test/models.service.spec.ts`(makeRepo/enc fixture)
  - Mirror: 表完整性断言、`cfg()` 工厂、`jest.useFakeTimers()`+abort 监听超时手法、`svc.create()` 灌行

### Story 2: chunks tsv 列 + 检索查询(plan Tasks 5-7)
- Reference: `apps/backend/drizzle/0006_curly_krista_starr.sql`(手写 HNSW 索引先例)
  - Why analogous: drizzle-kit 推导不出的 DDL(生成列/自定义函数/特殊索引)走手写迁移
- Reference: `apps/backend/src/modules/chunks/chunks.repository.ts`(现有 sql<number> 用法、Drizzle 查询构造)
- Reference: `apps/backend/src/platform/persistence/pgvector-type.ts`(customType 声明先例,tsv 列仿此)

### Story 3: retrieval 编排 + 接线 + e2e(plan Tasks 8-10)
- Reference: `apps/backend/src/modules/models/models.module.ts`(`MODEL_PROVIDER_PORT` Symbol token 绑定 useClass 的 DI 模式)
- Reference: `apps/backend/src/modules/knowledge-bases/knowledge-bases.module.ts`(模块 imports 装配注释风格)
- Reference: `apps/backend/test/chunks.service.spec.ts`(service 层 mock 依赖测试模式)
- Reference: `apps/backend/test/skeleton.e2e.spec.ts:223-337`(fakeModelProviderPort / inMemory*Repo 扩展点)

### Story 4: 前端检索测试台(plan Task 11)
- Reference: `apps/frontend/src/pages/admin/KnowledgeBasesPage.tsx`
  - Why analogous: 同为 M4 已完成的 antd 化管理页(antd 组件 + api/client 调用 + errMsg helper)
  - Mirror: antd import 风格、`errMsg`、loading/error state 处理
- Reference: `apps/frontend/src/api/client.ts:349-351`(testRetrieval 已存在,直接消费)

## Waves(全部单 story 顺序执行,host 直接实现)

plan.md 的 12 个 Task 归并为 4 个 review story(Task 粒度太细,逐 Task 派发 review 开销不成比例;每个 story 是一个有意义的验收单元,独立 peer review):

- Wave 1 = Story 1: models 域 rerank 能力(Tasks 1-4:契约字段/otel 属性 + RERANK_BUILDERS + adapter.rerank + rerankTexts)
- Wave 2 = Story 2: chunks tsv + 搜索查询(Tasks 5-7:迁移 + searchByVector/searchByKeyword + service 透传)
- Wave 3 = Story 3: retrieval 编排(Tasks 8-10:RetrieverPort/PgHybridRetriever + service/module 接线 + skeleton e2e 扩展)
- Wave 4 = Story 4: 前端(Task 11:RetrievalTestPage antd 重写 + 删 mock)
- plan Task 12(手动 QA)不属于 dev,移交 /ship:qa。

依赖:S1 ∥ S2(无文件交集)→ S3(依赖两者)→ S4(仅依赖 S1 的契约字段)。虽 S1/S2 可并行,但 plan 已含完整代码,host 顺序实现比派发 subagent 更省;全部走单 story wave。

## Peer Review 说明

Codex 无额度(用户确认 2026-07-09),peer review 回退为全新 Agent 会话(同 provider,独立性弱于跨模型,记入报告)。
