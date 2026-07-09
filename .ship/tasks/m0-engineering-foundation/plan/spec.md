# Spec — M0 工程地基脚手架

- **Task ID**: m0-engineering-foundation
- **Scope mode**: full
- **Repo state**: greenfield（非 git 仓库；仅有 `CodeCrushBot 单文件版.html` 与 `docs/design/001,002,003`）
- **承接**: `docs/design/001`（系统架构）、`002`（路线图）、`003`（代码组织，权威依据）
- **HEAD SHA**: N/A（非 git 仓库）

## 1. 目标（What）

搭出整个仓库的**工程地基骨架**：一个 `pnpm + Turborepo` 管理的 TS monorepo，含后端 NestJS 模块化单体骨架、前端 React+Vite+antd 骨架、共享 Zod 契约包、Postgres+pgvector（Drizzle 迁移）、docker-compose(infra profile)、以及把 003 的模块依赖规则固化成的 ESLint 边界规则与测试脚手架。

**只搭骨架 + 基础设施 + 约定，不写任何业务逻辑。**

## 2. 明确不做（Non-goals / 留给后续波次）

- **M0.5**：OTel SDK 应用侧接线、Collector→ClickHouse 写入、ClickHouse 读 VIEW、hello-span 端到端。（M0 的 compose 只放 ClickHouse/Collector 的**服务定义**，不接线。）
- **M1+**：任何业务模块逻辑（auth/models/kb/… 只在后续波次实现；M0 不建这些模块目录的实现，仅建 `platform/*` 与后端应用骨架）。
- **M2**：15 屏页面骨架（M0 前端仅 app shell + 少量占位路由）。
- CI/CD、生产 Dockerfile/k8s、上云（阿里云延后）。

## 3. 交付物（Deliverables，按 003 目录结构）

### 3.1 Monorepo 根
- `package.json`（root，`packageManager: pnpm`，workspace 脚本：`dev/build/lint/test/format/db:*`）
- `pnpm-workspace.yaml`（`apps/*`、`packages/*`）
- `turbo.json`（pipeline：build/lint/test/dev）
- `tsconfig.base.json`（strict、路径别名）
- `eslint.config.mjs`（flat config：typescript-eslint + prettier + **`import/no-restricted-paths`** 落 003 Boundaries 的 FE/BE/contracts 两条硬边界；完整 `eslint-plugin-boundaries` 延到 M1，见 §9/D2）
- `.prettierrc`、`.gitignore`、`.env.example`、`.nvmrc`（Node 22）
- `README.md`（一键起步命令）

### 3.2 `packages/contracts`
- Zod schema 契约源 + OTLP 属性常量（`gen_ai.*` / `rag.*` key）；M0 放最小占位：一个健康检查响应 schema + OTLP 常量对象 + 一个契约单测。

### 3.3 `infra/`
- `docker-compose.yml`：profiles `infra`（默认）+ `full`（占位）；services：`postgres`(pgvector 镜像)、`clickhouse`(仅定义)、`otel-collector`(仅定义)。healthcheck + 命名卷 + 挂载。
- `infra/postgres/init.sql`：`CREATE EXTENSION IF NOT EXISTS vector;`
- `infra/collector/config.yaml`：最小 OTLP receiver → debug exporter（不接 CH，M0.5 再改）
- `infra/clickhouse/init/.gitkeep`（读 VIEW 留 M0.5）

### 3.4 `apps/backend`（NestJS 模块化单体骨架）
- `package.json` / `tsconfig.json` / `nest-cli.json`
- `src/main.ts`（bootstrap；M0 **暂不**接 OTel，但 main 结构预留 M0.5 的 `-r tracing` 入口注释）
- `src/app.module.ts`
- `src/platform/config/`（`@nestjs/config` + Zod env 校验，缺失 fail-fast）
- `src/platform/persistence/`（Drizzle client provider + module）
- `src/modules/health/`（**手写** `GET /health` → 200 + `SELECT 1` ping Drizzle，返回 `HealthResponse`，见 §9/D1）
- `drizzle.config.ts` + `src/db/schema.ts`（中央 barrel；M0 放一张最小示例表以验证迁移，如 `app_meta`）+ 首个迁移
- 测试：Jest 配置 + `health` e2e/单测（断言 200）

### 3.5 `apps/frontend`（React+Vite+antd 骨架）
- `package.json` / `vite.config.ts` / `tsconfig.json` / `index.html`
- `src/main.tsx`（antd `ConfigProvider`，主题 token 对齐 mock 主色 `#1677ff`）
- `src/app/`（Router shell：`/`(控制台占位) + `/login`(占位)，仅布局壳，不实现业务）
- `src/api/`（类型化 fetch 客户端，import `@codecrush/contracts`，调用 `/health` 演示打通）
- 测试：Vitest 配置 + 一个渲染 smoke 测试

## 4. 依赖边界（必须由 ESLint 强制，见 003 不变量 1–3 / 7）

- `apps/frontend` 只能 import `@codecrush/contracts`，不得 import `apps/backend/**`。
- 后端跨模块只能走对方 barrel（`index.ts`）导出的 service/端口，禁止深 import 内部文件。
- 任何地方不得直接 import `**/adapters/**`。
- 违规 = `pnpm lint` 报错（CI 红）。M0 至少落地"FE 不碰 BE 内部"与"contracts 无反向依赖"两条硬规则 + barrel-only 约定（域模块 M0 尚少，规则先就位）。

## 5. 验收标准（可证伪）

1. `pnpm install` 成功。
2. `docker compose --profile infra up -d` 后 `docker compose ps` 中 `postgres` 为 healthy（clickhouse/collector 起来即可，不要求接线）。
3. `pnpm db:migrate` 成功创建示例表。
4. `pnpm --filter backend start`（或 `pnpm dev`）后 `curl localhost:3000/health` 返回 200 且 `db:"up"`。
5. `pnpm lint` 零 boundary 违规；故意加一条 `apps/frontend` → `apps/backend` 的 import 时，`pnpm lint` **报错**（边界规则确实生效）。
6. `pnpm test` 后端 health 测试 + 前端 smoke 测试 + contracts 单测全绿。
7. `pnpm --filter frontend dev` 打开首页 shell，能看到 antd 布局壳且演示调用 `/health` 成功。
8. 缺失必填 env 时后端启动 fail-fast 并打印明确缺失项。

## 6. 关键约定（版本/工具）

- Node **22 LTS**；包管理 **pnpm**；Node 版本经 `.nvmrc` 固定。
- 后端 **NestJS 11**、**Drizzle ORM**（pg）、**nestjs-zod**、**pg**（driver）。
- 前端 **React 19 + Vite 6 + antd 5**。
- 契约 **Zod**（`zod-to-openapi` 生成 OpenAPI 留 M1 接口出现后再启用，M0 仅装依赖）。
- 测试 **Jest**（后端）/ **Vitest**（前端 + contracts）。
- Lint **ESLint 9 flat config** + **typescript-eslint** + **eslint-plugin-boundaries** + **prettier**。
- 版本策略：plan 用 `pnpm add` 拉当前版本，不硬编码次版本号，避免过期。

## 7. 风险 / 已知坑（供 plan 规避）

- **eslint-plugin-boundaries flat config**：需正确声明 `settings['boundaries/elements']`，否则规则空转。plan 必须含一条"故意越界应报错"的验证步骤。
- **Drizzle + pgvector**：迁移需先在 DB 装 `vector` 扩展（compose 的 `init.sql` 负责），否则含 vector 列的迁移失败。M0 示例表可不含 vector 列以先跑通迁移；扩展安装仍在 init.sql 就位供 M4。
- **compose 启动顺序**：backend 若进 compose 需 `depends_on: service_healthy`；M0 后端跑主机，仅需 postgres healthy 后再迁移。
- **前后端类型共享**：`@codecrush/contracts` 需正确配置 `exports`/`types`，且被 backend(Node/tsc) 与 frontend(Vite) 双端解析——用 workspace 协议 + tsconfig paths。

## 8. Open questions

无阻塞项。第 6 节版本与第 4 节边界规则粒度为设计选择，已在 003 记录并被用户确认（pnpm/Node22/Jest+Vitest/Zod）。

## 9. 已应用的 diff 补丁（对 plan 具权威性，见 diff-report.md）

- **D1 健康检查**：**手写极简 health controller**（`SELECT 1` ping，返回 `@codecrush/contracts` 的 `HealthResponse`）。原拟用 `@nestjs/terminus`，因其 v10/v11 HealthIndicator API 有 breaking change、给 M0 添版本风险而无收益，故反转为手写（见 diff-report/D1）。terminus 延到需要富健康检查时。
- **D2 边界 lint**：M0 用 `eslint-plugin-import` 的 `import/no-restricted-paths` 落两条硬边界（① `apps/frontend` 禁 import `apps/backend`；② `packages/contracts` 禁 import `apps/**`）；完整 `eslint-plugin-boundaries`（域模块 barrel-only）延到 M1 域模块出现时。**这是对 003 的 M0 时序细化，不推翻 003 的最终形态。**
- **D3 跨域**：`apps/frontend` 的 `vite.config.ts` 配 `server.proxy`，把 `/health`（及未来 `/api`）代理到 `http://localhost:3000`；前端只请求相对路径，免 CORS、不硬编码 host。
- **D4 env 边界**：M0 必填 `DATABASE_URL`、`PORT`、`NODE_ENV`；`CLICKHOUSE_URL`、`OTEL_EXPORTER_OTLP_ENDPOINT` 在 M0 为 `.optional()`（留 M0.5 启用）。
- **D5 pgvector 镜像**：compose 用 `pgvector/pgvector:pg16`；M0 示例表 `app_meta` **不含 vector 列**（先跑通迁移），`init.sql` 仍装扩展供 M4。
- **D6 turbo**：`dev` 任务 `"persistent": true` + `"cache": false`；`build/lint/test` 用缓存 + `dependsOn`。
- **D7 命名**：统一 `@codecrush/*` scope（`contracts`/`backend`/`frontend`/`eslint-config`/`tsconfig`），workspace 内 `workspace:*` 引用。
- **D8 Drizzle 脚本**：`db:generate`（drizzle-kit 生成 SQL）+ `db:migrate`（应用），迁移文件入库。
