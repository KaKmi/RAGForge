# EvalRag · CodeCrushBot RAG 平台

一个**通用 RAG 平台**：以「配置 → 验证 → 上线 → 追踪」为主链路，强调**可配置、可追踪、可优化**。数据处理与切片策略固定（非通用数据工程），把精力放在检索/生成的可观测与可优化上。

> 可追踪采用 **OpenTelemetry → Collector → ClickHouse** 的标准 OTLP 链路，标准化、可迁移（换 Jaeger/Tempo/阿里云 SLS/ARMS 零改应用代码）。

## 状态

- ✅ **M0 工程地基**已完成（monorepo、后端/前端骨架、契约包、docker-compose、迁移、CI 约定）。
- ✅ **M0.5 可观测最小闭环**已完成（OTel SDK→Collector→ClickHouse→防腐 VIEW→traces API，见下方验证）。
- ⏭ 下一步 **M1 用户与鉴权**（见路线图波次 B）。
- 完整路线图见 [`docs/design/002-implementation-roadmap.md`](docs/design/002-implementation-roadmap.md)（M0–M12）。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | NestJS（模块化单体）+ TypeScript，自研薄 RAG 编排 |
| 前端 | React + Vite + Ant Design（1:1 还原设计稿）|
| 数据 | PostgreSQL + pgvector（配置 + 向量 + 关键词 FTS）|
| 可观测 | OpenTelemetry SDK → OTel Collector → ClickHouse |
| 契约 | Zod（前后端单一契约源 `@codecrush/contracts`）|
| 异步入库 | pg-boss（跑在 Postgres 上）|
| 工程 | pnpm workspace + Turborepo |

## 目录结构

```
apps/
  backend/            NestJS 后端（platform/{config,persistence,clickhouse} + modules/{health,traces}）
  frontend/           React + Vite + antd 控制台骨架
packages/
  contracts/          Zod API DTO（前后端唯一契约源，仅依赖 zod）
  otel-conventions/   OTLP/GenAI/rag 属性常量（前后端共用，零运行时依赖）
  otel/               通用 Node 遥测 SDK（NodeSDK 接线 / withSpan，仅后端）
infra/
  docker-compose.yml  postgres+pgvector / clickhouse / otel-collector（infra profile）
  clickhouse/views/   codecrush_trace_spans 防腐 VIEW SQL（otel_traces 由 exporter 建）
docs/design/          001 架构 · 002 路线图 · 003 代码组织 · 004 trace 可观测（权威设计）
.ship/                Ship 工作流产物（spec/plan/ledger）
```

## 快速开始

**前置**：Node ≥ 22、pnpm 9、Docker（含 compose）。

```bash
# 1. 安装依赖
pnpm install

# 2. 起依赖服务（Postgres+pgvector / ClickHouse / OTel Collector）
docker compose -f infra/docker-compose.yml --profile infra up -d --wait

# 3. 后端 env + 迁移
cp apps/backend/.env.example apps/backend/.env
pnpm db:migrate

# 4. 启动
pnpm --filter @codecrush/backend start     # http://localhost:3000/health
pnpm --filter @codecrush/frontend dev       # http://localhost:5173
```

打开 http://localhost:5173 ，首页会显示「后端健康：ok · db:up」。

## M0.5 可观测验证

```bash
docker compose -f infra/docker-compose.yml --profile infra up -d --wait
cp apps/backend/.env.example apps/backend/.env
pnpm build
pnpm --filter @codecrush/backend start    # node -r ./dist/tracing.js dist/main.js（OTel 预加载）
pnpm observability:verify                 # 另开终端
```

期望输出形如 `{"status":"ok","traceId":"<32位hex>","attempts":N}`。该验证走完整链路：
`manual.hello` span → OTel Collector → ClickHouse `otel_traces`（exporter 建表）→
`codecrush_trace_spans` 防腐 VIEW → `GET /traces/:traceId`；不能由内存或 Postgres 伪造。
Collector/ClickHouse 不可用时后端与 `/health` 不受影响（埋点只降级、不阻塞）。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm build` | Turborepo 全量构建（contracts→backend→frontend）|
| `pnpm test` | 全量测试（contracts/backend/frontend）|
| `pnpm lint` | ESLint（含依赖边界规则）|
| `pnpm db:generate` / `pnpm db:migrate` | 生成 / 应用 Drizzle 迁移 |
| `pnpm observability:verify` | M0.5 可观测闭环冒烟（需 infra + 后端已启动）|
| `docker compose -f infra/docker-compose.yml down` | 停依赖服务（保留卷）|

## 文档

- [`docs/design/001-rag-platform-architecture.md`](docs/design/001-rag-platform-architecture.md) — 系统架构、可观测、失败模式、取舍
- [`docs/design/002-implementation-roadmap.md`](docs/design/002-implementation-roadmap.md) — 模块级路线图（依赖有序）
- [`docs/design/003-code-organization.md`](docs/design/003-code-organization.md) — monorepo 布局、依赖边界、通用 Telemetry SDK 与包边界
- 面向 AI 协作者：见 [`AGENTS.md`](AGENTS.md) 与 [`CLAUDE.md`](CLAUDE.md)

## 许可

内部项目，暂未指定 License。
