# Peer Spec — M0 工程地基脚手架（独立第二份）

> **WARNING: Second spec was self-generated, not independent.**
> harness 规则限制未 spawn 子代理；本文为对抗性二次推导（placeholder / contradiction / coverage / ambiguity 四扫描），用于与 `spec.md` diff。

从 `docs/design/003` 独立重推 M0，结论与 host spec 大体一致（monorepo 布局、NestJS 骨架、Zod 契约、Drizzle、compose、边界 lint）。以下仅记**分歧/补强点**。

## D1 — 健康检查实现方式
Host spec 手写 `/health` + DB ping。**独立结论**：应使用 NestJS 官方 `@nestjs/terminus`（`HealthCheckService` + 自定义 DB indicator ping Drizzle），这是 boring/标准选项，少写自定义代码、输出格式标准。→ 采纳 terminus。

## D2 — 边界规则用哪个插件（重要）
Host spec 主推 `eslint-plugin-boundaries`。**独立结论**：ESLint 9 flat config 下 `eslint-plugin-boundaries` 的 `elements/rules` 配置在"后端模块尚不存在"的 M0 属于空转；M0 真正要焊死的只有两条硬边界（FE 不碰 BE、contracts 无反向依赖）。用 **`eslint-plugin-import` 的 `import/no-restricted-paths`**（或 `no-restricted-imports`）更稳、可立即验证。完整 `eslint-plugin-boundaries`（域模块间 barrel-only）**推迟到 M1 模块出现时**再上。→ M0 采纳 `import/no-restricted-paths` 落两条硬边界；boundaries 插件延后。

## D3 — 前端调用后端的 CORS/代理（host spec 遗漏）
Host 验收第 7 条"前端演示调用 /health"未说明跨域。5173→3000 会触发 CORS。→ 补：**Vite dev server `proxy`**（`/health`、未来 `/api` 代理到 `http://localhost:3000`），前端只请求相对路径；避免硬编码后端 host，也免 CORS。

## D4 — config Zod env 的必填/可选边界（host spec 未枚举）
必须明确 env 清单且 **M0.5 的变量（CLICKHOUSE_URL / OTEL_EXPORTER_OTLP_ENDPOINT）在 M0 为可选**，否则 M0 启动会因缺 M0.5 变量而 fail-fast，自相矛盾。→ 补：M0 必填仅 `DATABASE_URL`、`PORT`、`NODE_ENV`；CH/OTLP 变量 `.optional()`。

## D5 — pgvector 镜像（隐含依赖显式化）
`init.sql` 里 `CREATE EXTENSION vector` 只有在镜像自带扩展二进制时才成立。→ 明确 compose 用 **`pgvector/pgvector:pg16`** 镜像，而非官方 `postgres`。M0 示例表**不含 vector 列**（先跑通迁移），扩展仍装好供 M4。

## D6 — Turbo dev 持久任务配置（host spec 未细化）
`turbo dev` 跑长驻 dev server 需在 `turbo.json` 对 `dev` 任务设 `"persistent": true` + `"cache": false`；`build/lint/test` 才用缓存 + `dependsOn`。→ 补进 turbo pipeline。

## D7 — 包命名规范（host spec 未统一）
统一 scope：`@codecrush/contracts`、`@codecrush/backend`、`@codecrush/frontend`、`@codecrush/eslint-config`、`@codecrush/tsconfig`。workspace 协议 `workspace:*` 引用。→ 明确写入。

## D8 — Drizzle 脚本齐备
需要 `db:generate`（drizzle-kit 生成 SQL 迁移）与 `db:migrate`（应用迁移）两条，host spec 只强调 migrate。→ 两条都要，且迁移文件入库（committed）。

## 一致确认（无分歧）
monorepo=pnpm+Turborepo；后端=NestJS 模块化单体 + platform/{config,persistence}；契约=Zod in packages/contracts；DB=Postgres+pgvector via Drizzle，ClickHouse 不进 Drizzle；compose infra profile（CH/Collector 仅定义不接线）；测试 Jest(be)+Vitest(fe/contracts)；M0 不写业务逻辑、不接 OTel（留 M0.5）。
