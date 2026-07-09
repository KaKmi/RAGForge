# Dev Ledger — M7 Agent 配置与管理

分支：feat/m7-agent-config · plan：`.ship/tasks/m7-agent-management/plan/plan.md`
恢复时优先信本文件与 `git log`，勿重复实现。

| # | Task | Commit | 偏差 |
|---|------|--------|------|
| 0 | 设计文档 008 落库（前置，非 plan 任务） | 3af1eb2 | — |
| 1 | 契约层重写 agents.ts + m2-schemas.test.ts | 164cefc | 无。86/86 契约测试绿。注：本机 node_modules 缺失，先跑了 `pnpm install` |
| 2 | agents 三表 schema + 迁移 0008 | 86228ce | 偏差：额外改 `src/db/schema.ts` 加 barrel export（drizzle.config 只读该文件，plan 漏列）；`.env` 从 example 复制（本机原缺）。三表已在真实 Postgres 验证 |
| 3 | 联动补丁 prompts/models/kb-repo | 751eed5 | 偏差：models.service.spec 一处断言旧文案，同步改（plan 已预告此可能）；额外补一条 delete 非 FK 错误透传用例。19+8 测试绿 |
| 4 | AgentsRepository | 448ee8f | 无 |
| 5 | AgentsService TDD（22 用例先红后绿） | c0f6554 | 偏差：比 plan 多补 5 个用例（同名 409/禁用模型 400/kb 不存在 404/evalRun 非 draft 409/派生 status） |
| 6 | Controller + Module 接线 | 5bf1e1c | 偏差：backend 单包 build 因 @codecrush/otel 未先构建而报错，改跑根 `pnpm build`（turbo 依赖序）通过 |
| 7 | skeleton e2e agents 块重写（59/59 绿） | 103de36 | 偏差：给 inMemoryKbsRepo 补 `findByIds`（spec 已预判 AgentsService 依赖它，plan 的 e2e 步骤漏列此项）；补 PATCH enabled=false→archived 断言 |
| 8 | 前端 API client | b323980 | 无。eval-run/publish/rollback 抽成共用 postAgentVersionAction |
| 9 | AgentsPage antd 重写 + 运行时验证 | d2d2b8c | 真实后端冒烟（scratchpad/smoke-m7.mjs）+ 浏览器 preview 全流程走查均通过：建 Agent→v1 exempt→配置版本预填→跑Eval→发布(v1归档)→回滚。环境偏差：本机 .env 加密 key 需与旧 RAGForge 项目一致（共享同一 Postgres，旧模型行用旧 key 加密）；杀掉了旧项目遗留的 3000/5173 进程。Alert message→title 修 antd v6 废弃警告 |
| 10a | App.test.tsx agents 用例改真实 API 空态断言（spec 漏查的第 3 个测试消费者） | 823d7ee | 全量 test/lint/build 绿 |
| 10b | 收尾 review 修复：kbIds 去重防 23505 裸 500 + 改名撞唯一名 409（含回归测试，24 单测绿） | b7b3817 | review 另记录 2 条不修观察：list N+1（管理台量级可接受）、冲突文案未含模型名（有意简化） |
| 10c | 008 设计文档推进 current + 索引重生成 | 2f77ff7 | — |

## 收尾校验记录（2026-07-09）
- `pnpm test` 8/8 包全绿（契约 89 / 后端含 24 agents 单测 + 59 skeleton e2e / 前端 40）
- `pnpm lint` 0 错误（含依赖边界规则）
- `pnpm build` 5/5 包编译通过
- 真实 Postgres 冒烟（migration 0008 实跑 + 全流程 API）+ 浏览器 preview 全流程 DOM 断言通过
- 一次性全量 diff review（轻量对抗档收尾）：2 修复 2 记录，详见上表 10b
