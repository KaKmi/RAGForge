# AGENTS.md

面向任何 AI 编码助手的工作指南。先读本文与 `docs/design/001–003`，再动代码。

## 这是什么

通用 RAG 平台（monorepo）。重点：可配置、可追踪、可优化；数据处理/切片固定。**设计文档 `docs/design/` 是权威**——改架构/顺序/约定，先改对应文档，再改代码。

- `001-rag-platform-architecture` — 系统架构、可观测（OTLP→Collector→ClickHouse）、失败模式、取舍
- `002-implementation-roadmap` — 模块级路线图 M0–M12（依赖有序）
- `003-code-organization` — monorepo 布局、依赖边界、通用 Telemetry SDK 与 isomorphic 包边界

## 环境与命令

前置：Node ≥ 22、pnpm 9、Docker。

```bash
pnpm install
docker compose -f infra/docker-compose.yml --profile infra up -d --wait   # 依赖服务
cp apps/backend/.env.example apps/backend/.env && pnpm db:migrate           # 迁移
pnpm build        # turbo 全量构建
pnpm test         # 全量测试（改动后必跑）
pnpm lint         # ESLint + 包级依赖边界 + Boundary ⑤（必须 0；模块级 DAG 不在其覆盖内，见「依赖边界」）
```

单包：`pnpm --filter @codecrush/{backend|frontend|contracts} <script>`。

## 结构

```
apps/backend             NestJS 模块化单体：platform/{config,persistence,queue,storage,observability} + modules/<域>
apps/frontend            React + Vite + antd
packages/contracts       Zod API DTO（前后端唯一契约源，只依赖 zod）
packages/otel-conventions OTLP/GenAI/rag 属性 key + span/observation 类型（前后端共用，零运行时依赖）
packages/otel            仅后端：NodeSDK 接线、withSpan、trace.llm/retrieve/tool，发 OTLP
infra/                   docker-compose（postgres+pgvector / clickhouse / otel-collector）+ clickhouse/views(读 VIEW SQL)
```

## 依赖边界（不可违反；**lint 只覆盖其中一部分**）

> ⚠️ 2026-07-19 订正：此前标题写「ESLint 强制」，实测 **`eslint-plugin-boundaries` / `eslint-plugin-import` 并未安装**。
> 现有规则**全是黑名单**（列举几个禁止的 import），**不等于**不变量本身。逐条实测：
>
> | 不变量 | lint 覆盖 | 漏什么 |
> |---|---|---|
> | 1 模块级 DAG | ⚠️ 仅一个点 | Boundary ⑤ 只拦「后端模块 import `gaps`」；其余方向全不拦 |
> | 2 前端只碰 contracts | ⚠️ 部分 | 拦 `@codecrush/backend*` / `@codecrush/otel*`；**相对路径爬进 backend（`../../../backend/src/...`）不拦** |
> | 3 共享包只依赖 zod | ⚠️ 部分 | contracts 只拦 `@codecrush/backend|frontend` 与 `@opentelemetry/*`；**`pg` / `fs` / `node:*` 不拦**（otel-conventions 额外拦了 `node:*`） |
> | 4 `@codecrush/otel` 仅后端 | ✅ 拦 | — |
> | 5 只走 barrel、禁 `adapters/` | ❌ **完全不拦** | 无任何相关规则 |
>
> ⇒ **任何一条都不能以「`pnpm lint` 过了」推断合规。** 尤其：在 `packages/contracts` 里
> `import { Pool } from "pg"` 当前是**绿的**，而第 3 条正是点名要禁它。
> 逐条覆盖范围与已知缺口见 `docs/design/003`「依赖规则的真实强制力」。

1. **依赖方向朝下、无环**：`gaps`(顶点，E-W4 B2a) → `eval-runs`(E-W2a) → `chat`(问答顶点) → … → `platform` → `contracts` / `otel-conventions`(基座)。详见 `docs/design/021` 与 `018`。
   **任何模块不得 import `gaps`**（Boundary ⑤ 机械强制；`eval-runs → gaps` 会成环）。
2. `apps/frontend` 只能 import `@codecrush/contracts` 与 `@codecrush/otel-conventions`（纯常量）；**不得** import `apps/backend` 或 `@codecrush/otel`（Node-only，进前端打包炸）。
3. `packages/contracts` / `@codecrush/otel-conventions` 是地基，**只能依赖 `zod`**（或零依赖）；严禁 Node-only（`pg`/`fs`/`@opentelemetry/*`）或浏览器-only 依赖，否则前端打包会炸。
4. `@codecrush/otel` 仅后端运行时：只依赖 `@opentelemetry/*` 与 `@codecrush/otel-conventions`；**不得** import `@codecrush/contracts`、ClickHouse client 或 backend 模块（只返回中性 `SpanIdentity`，DTO 转换留在 `traces` 模块）。
5. 跨域模块只走对方 barrel 导出的 service/端口；**任何地方不得直接 import `adapters/`**（只能 DI）。
6. `chat` 与 `traces` 无直接代码依赖：chat 写（OTLP）、traces 读（ClickHouse），经存储解耦。
7. **埋点绝不进入问答关键路径**：可观测组件故障不得导致问答失败或增加用户可感延迟。
8. 域内 `schema.ts` 是纯表定义，零 service 引用（防循环 import）。
9. 迁移是显式命令（`pnpm db:migrate`），不在应用启动时静默执行。**迁移一律手写**（`drizzle/00NN_*.sql` + `drizzle/meta/_journal.json`）；`drizzle-kit generate` 已停用（快照链断在 0021，跑它会产出破坏性迁移）——详见 `apps/backend/drizzle/README.md`。

## 约定

- TypeScript strict；Prettier（`semi`, 双引号, printWidth 100, trailingComma all）。
- 前后端契约走 `packages/contracts` 的 Zod schema（单一来源）。
- 数据面 Drizzle 只管 Postgres；ClickHouse 由 Collector 导出器建表，读侧走自有 VIEW。
- 端口/适配器：域模块拥有端口（interface），适配器经 NestJS DI token 注入；换实现（本地↔云）只改注入。
- **Conventional Commits**，按 story/小步提交。
- 提交或推送仅在被要求时进行；默认分支上先开分支。

## 原型参考（CodeCrushBot.dc.html）

- 仓库根的 `CodeCrushBot.dc.html` 是前端 UI 原型（单文件 HTML，~256KB），仅供页面视觉/交互 1:1 还原参考。M2 已据此还原 15 屏，后续 M7/M10 等页面继续参考。
- **不进仓库**（已在 `.gitignore`）：体积大、非源码、易变；开发者本地持有即可。
- **不进打包/构建**：纯参考文件，`apps/frontend` 代码不得 import 或引用它。

## 已知工程细节（M0 实装）

- 版本较新：Zod 4 / TS 6 / NestJS 11 / antd 6 / Vite 8 / ESLint 10 / drizzle 0.45。
- TS 6：`tsconfig` 用 `ignoreDeprecations: "6.0"`（node10 解析）+ 显式 `rootDir`；后续迁移 `nodenext`。
- 后端测试用 `@swc/jest`（TS6 + Nest 装饰器）；前端/契约用 vitest。
- 工作区依赖用 `workspace:*`（根 `.npmrc` 开 `link-workspace-packages`）。

## 不要做

- 不要在 `contracts` 里引入运行时/平台依赖。
- 不要在问答关键路径上同步等待埋点。
- 不要绕过 `docs/design/` 直接改架构决策。
- 不要软化测试断言来「过」测试——修代码。
