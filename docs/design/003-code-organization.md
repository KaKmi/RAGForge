---
title: "代码组织与工程架构（M0）"
description: "monorepo 布局、NestJS 模块边界与依赖规则、端口/适配器、Zod 契约、Drizzle/ClickHouse 分工、docker-compose 与约定。"
category: "design"
number: "003"
status: draft
services: [backend, frontend, tooling, deploy]
related: ["design/001", "design/002"]
last_modified: "2026-07-05"
---

# 003 — 代码组织与工程架构（M0）

## Status

`draft` — 承接 `001`(系统架构) 与 `002`(路线图) 的 M0 代码组织决策，尚无实现代码。M0 落地后对照真实目录/lint 配置校验，推进为 `current`。

## Summary

定义整个仓库的代码组织:**pnpm + Turborepo 管理的 TS monorepo**，`apps/{backend,frontend}` + `packages/contracts`(Zod 单一契约源) + `packages/otel-conventions` / `packages/otel`(通用 trace 语义与 Node 发射层) + `infra/`。后端 **NestJS 模块化单体**，按 001 的域切模块 + 端口/适配器(DI 注入);**模块依赖规则用 ESLint 焊死**(不是口头约定);Drizzle 只管 Postgres DDL，ClickHouse DDL 归 Collector + 手写 VIEW;dev 用"infra 进 compose、应用跑主机热更"。

## Boundaries

> 反漂移边界 + 依赖不变量。任何实现越过这些，先改本文。

**In-scope(M0)**:monorepo 布局、目录结构、NestJS 模块边界与依赖规则、端口/适配器落位、Zod 契约包、config/env、docker-compose、Drizzle 迁移、lint/测试约定。**只搭骨架 + 基础设施 + 约定,不写业务逻辑**(业务在 M1+)。

**Out-of-scope(M0)**:任何业务逻辑;CI/CD 与生产 Dockerfile/k8s(上云延后);微服务拆分。

**依赖不变量(不可违反)**
1. **依赖方向朝下、无环(DAG)**:`chat`(顶点) → … → `platform` → `contracts`(基座)。
2. **跨模块只走对方 barrel 导出的 service/端口**,禁止深 import 内部文件;**任何地方不得直接 import `adapters/`**(只能 DI)。
3. **`apps/frontend` 只能 import `packages/contracts`**,碰不到 `apps/backend` 内部。
4. **`chat` 与 `traces` 无直接代码依赖**:chat 写(OTLP→Collector→ClickHouse)、traces 读(ClickHouse),经存储解耦。
5. **域内 `schema.ts` 是纯表定义**,零 service 引用(防循环 import)。
6. **迁移是显式命令**,不在应用启动时静默执行。
7. 上述 1–3 由 ESLint(`eslint-plugin-boundaries` / `import/no-restricted-paths`)在 lint 期强制,违规即 CI 红。
8. **共享包保持纯净**：`@codecrush/contracts`、`@codecrush/otel-conventions` 只可依赖 `zod`（或零依赖），严禁引入 Node-only（`pg`/`fs`/`@opentelemetry/*`）或浏览器-only 依赖——否则前端打包会拉入 Node 依赖而炸。（见 §「通用 Telemetry SDK 与包边界」）

## Context

Repo 为 greenfield(仅原型 HTML + docs)。M0 的所有选择都是全新决策,依据 001 的技术栈(NestJS · React+Vite+antd · Postgres+pgvector · ClickHouse · OTel Collector · pg-boss · Drizzle · 全 TS)与 002 的模块划分/波次。

## Goals / Non-goals

**Goals**:一套能撑起 M1–M9 的目录与边界;`pnpm dev` 一条命令起全套;把 002 的依赖 DAG 变成**可被 lint 拦住**的规则;前后端契约单一来源不漂移;`docker compose up` 可复现本地环境。

**Non-goals**:业务逻辑、CI/CD、生产镜像、微服务(见 Boundaries)。

## Requirements & 数字

- 规模:**2 应用 + ~12 后端域模块 + ~2 共享包 + ~13 张 Postgres 表**。
- 该模块数 × ≤10 qps → **模块化单体(单进程)**;拆微服务 = 为 ≤10qps 养 12 套部署/追踪,纯负债。跨模块走进程内 DI,零网络开销。
- 构建预算:Turborepo 增量缓存,全量 build <30s、增量 <5s(2 应用规模可达)。

## Design

### 目录结构

```
rag-service/
├─ apps/
│  ├─ backend/                      # NestJS 模块化单体
│  │  ├─ src/
│  │  │  ├─ main.ts                 # bootstrap(tracing 已由 -r 预加载)
│  │  │  ├─ tracing.ts              # OTel NodeSDK, 必须最先执行
│  │  │  ├─ app.module.ts
│  │  │  ├─ platform/               # 横切基础设施
│  │  │  │  ├─ config/              # @nestjs/config + Zod env 校验(fail-fast)
│  │  │  │  ├─ persistence/         # Drizzle client + 迁移入口
│  │  │  │  ├─ queue/               # pg-boss 封装
│  │  │  │  ├─ storage/             # BlobStore 端口 + LocalFs 适配器
│  │  │  │  └─ observability/       # Nest provider wrapper, 调用 @codecrush/otel
│  │  │  └─ modules/                # 业务域(001 划分)
│  │  │     ├─ auth/ users/ models/ knowledge-bases/ documents/
│  │  │     ├─ ingestion/ chunks/ retrieval/ agents/
│  │  │     └─ prompts/ chat/ traces/ conversations/
│  │  │        每个: <m>.module.ts / .controller.ts / .service.ts
│  │  │              schema.ts(Drizzle 表) / repository.ts
│  │  │              ports/ + adapters/(拥有端口时)
│  │  ├─ drizzle/                   # 迁移文件
│  │  └─ test/                      # 集成/e2e(打 compose infra)
│  └─ frontend/                     # React + Vite + antd
│     └─ src/ app/(shell/路由) pages/(逐屏 mirror mock) components/
│              api/(契约类型化 client + SSE) theme/(antd token 对齐 #1677ff)
├─ packages/
│  ├─ contracts/                    # Zod schema = 前后端唯一 API 契约源
│  ├─ otel-conventions/             # 前后端共享：OTel/GenAI/rag 属性 key、operation、span 类型
│  ├─ otel/                         # 仅后端：NodeSDK 接线、withSpan、trace.llm/retrieve/tool
│  └─ tsconfig/ eslint-config/      # 共享预设
├─ infra/
│  ├─ docker-compose.yml            # profiles: infra(默认) / full
│  ├─ postgres/init.sql             # create extension vector
│  ├─ clickhouse/views/             # 读 VIEW SQL(防腐层，M0.5 后置/lazy 执行)
│  └─ collector/config.yaml         # otlp receiver → clickhouseexporter
├─ docs/  pnpm-workspace.yaml  turbo.json  .env.example
```

### 端口 / 适配器落位

端口(interface)归"需要它的域模块"所有:`models` 拥有 `ModelProviderPort`、`retrieval` 拥有 `RetrieverPort`、`platform/storage` 拥有 `BlobStore`。适配器实现之,经 **NestJS DI token → 实现** 注入(如 `OpenAiCompatProvider`/`PgVectorRetriever`/`LocalFsBlobStore`,日后 `OssBlobStore`)。**拿端口,不拿适配器**——保证本地自建 ↔ 阿里云托管零改动切换(呼应 001)。

### 模块依赖分层(代码/运行时 import 依赖，`A → B` = A 依赖 B)

> 注意:这与 002 的 DAG 不同——002 是**建造顺序**,这里是**代码 import 依赖**。两者一致但视角不同。

```
① 编排        chat 问答编排 ─────────── (虚线: 经 OTLP/CH, 无代码依赖) ┄┄► traces 追踪(只读 CH)
                  │  依赖 ↓
② 配置·会话   agents 配置 · conversations 会话
                  │
③ 能力域      retrieval 检索 · ingestion 入库 · documents 文档
                  │
④ 域叶子      models 模型 · prompts · kb 知识库 · chunks 切片 · auth 认证(横切)
                  │
⑤ 基座        platform: config · persistence · queue · storage · observability
                  │
⑥ 契约        contracts: Zod DTO；otel-conventions: trace 语义常量(前后端共用)
```

精确依赖边:
- `chat` → `agents`、`retrieval`、`prompts`、`models`、`conversations`、`observability`
- `conversations` → `agents`
- `agents` → `knowledge-bases`、`models`、`prompts`
- `retrieval` → `models`、`chunks`
- `ingestion` → `documents`、`chunks`、`models`、`storage`、`queue`
- `documents` → `knowledge-bases`、`storage`、`queue`
- `knowledge-bases` → `models`
- `models` / `prompts` / `chunks` → 无域依赖(叶子),仅 `persistence`
- `auth` → `users`、`config`(横切:全局 guard,别的模块不 import 它;@Public()/principal 类型在 platform/security)
- `users` → `persistence`(叶子;user 实体归属地,供 auth 校验凭据、未来 conversations.user_id 外键引用)
- `traces` → `chunks`(读正文) + ClickHouse 读客户端;**与 `chat` 零代码依赖**
- 所有域模块 → `platform` → `contracts`

四条要点:①无环、方向朝下;②破环靠端口 + DI(如 `ingestion` 依赖 `ModelProviderPort` 而非 models 内部);③关键解耦 chat 写/traces 读经 ClickHouse → M9 可在 M8 后独立开发,且埋点挂了不影响问答;④`platform`/`contracts` 是地基,人人依赖、不依赖任何域。

### 依赖规则 = lint 规则

`eslint-plugin-boundaries` / `import/no-restricted-paths` 强制 Boundaries 的第 1–3 条:FE 只能碰 contracts;跨域只走 barrel 的 service/端口;禁止直接 import `adapters/`。→ 002 的 DAG 被 lint 期焊死,不靠 code review 口头把关。

### 契约

REST DTO 全部是 `packages/contracts` 的 Zod schema。后端控制器用 `ZodValidationPipe`(nestjs-zod),前端 `z.infer` 拿类型,OpenAPI 由 `nestjs-zod` 自带的 `@nestjs/swagger` 集成生成（`cleanupOpenApiDoc`，不再单独引入 `zod-to-openapi`）。**一份 schema 同时喂"校验 + 类型 + 文档"**。OTLP 属性名(`gen_ai.*`/`rag.*`)放在 `packages/otel-conventions`，前端 Trace UI、后端埋点与 ClickHouse VIEW 共享同一词典防拼错。

### 持久化

表定义**按域 co-locate**(`modules/<m>/schema.ts`,纯表定义),中央 `db/schema.ts` barrel re-export 给 drizzle-kit;迁移在 `apps/backend/drizzle/`。pgvector 用 drizzle `vector({dimensions:1024})` + HNSW 索引。**ClickHouse 不进 Drizzle**:表由 Collector 导出器建,VIEW SQL 由 `infra/clickhouse/views` 手写；因 exporter 表可能晚于 ClickHouse 容器启动创建，VIEW 由 M0.5 的显式初始化/懒加载步骤执行。

### config / 可观测接线

`@nestjs/config` + Zod 在启动时校验 env(缺失 fail-fast)。密钥不进 env(按 001 加密存库,env 只放主加密密钥 + 连接串)。OTel NodeSDK 在 `tracing.ts`,通过 `node -r ./dist/tracing.js dist/main.js` **在 Nest bootstrap 前预加载**(否则自动埋点静默失效,见 Red-team)。**SDK 与共享约定的包化（`@codecrush/otel` + `@codecrush/otel-conventions`）见 §「通用 Telemetry SDK 与包边界」——该节修订了"可观测留后端模块"这一早期判断。**

### Trace 包与物理层边界

Trace 相关能力分两层，不合成一个大包：

```
通用语义/发射层:
  packages/otel-conventions  # 属性 key、operation、span/observation 类型
  packages/otel              # NodeSDK 初始化、withSpan、trace.llm/retrieve/tool，发 OTLP

物理存储/读模型层:
  infra/collector/config.yaml       # OTLP receiver -> ClickHouse exporter
  infra/clickhouse/views/*.sql      # otel_traces 上的 VIEW SQL
  apps/backend/src/modules/traces   # ClickHouse 只读查询 + Session/Trace/Observation API
```

**边界规则**：`@codecrush/otel` 只知道 OTel/OTLP，不 import ClickHouse client、不知道 `otel_traces` 表名、不拼前端 Trace API DTO；`traces` 模块可以依赖 `otel-conventions` 解释属性，但不依赖 `chat`。如果后续需要 trace-normalizer worker，再单独抽 `packages/trace-normalizer` 或独立 worker 进程，复用 `otel-conventions`，不要把它塞回 SDK。

### docker-compose

`profiles: infra`(默认:Postgres+pgvector、ClickHouse、Collector、可选 MinIO)+ `full`(再加 backend/frontend 容器)。`depends_on: condition: service_healthy` 等健康检查;命名卷持久化;Collector config / ClickHouse init SQL / Postgres init(建 pgvector 扩展) 挂载。端口:PG 5432、CH 8123/9000、Collector 4317/4318、backend 3000、frontend 5173。

## Failure modes(M0 切面)

- **compose 依赖顺序**:backend 等 PG/CH healthcheck 通过再起。
- **迁移**:显式 `pnpm db:migrate`,不在启动时静默跑(避免多实例竞争)。
- **OTel 初始化失败不得拖垮应用**:tracing.ts 包裹降级。
- **端口冲突**:映射到 localhost,`.env` 可覆盖。

## Rollout & operations

命令面:`pnpm dev`(turbo 起 infra + 前后端热更) · `pnpm db:migrate` / `db:generate` · `pnpm test` · `pnpm lint` · `docker compose --profile infra up`。**"在工作"信号**:`docker compose ps` 全 healthy + backend `/health` 200 + 迁移成功 + `pnpm lint` 零 boundary 违规。回滚(greenfield)= git revert。

## Security(M0 切面)

`.env` gitignore、`.env.example` 无密钥;模型 API Key 不进 env(加密存库);compose 数据服务仅映射 localhost dev 端口,不对外。

## Alternatives considered

| 决策 | 选择 | 拒绝 | 放弃 |
|---|---|---|---|
| monorepo | pnpm + Turborepo | Nx / 裸 pnpm / npm-yarn | Nx 的强边界与生成器(过重) |
| 前后端契约 | Zod in contracts(→校验+类型+OpenAPI) | 手写双份类型 / OpenAPI-first / tRPC | tRPC 的端到端类型(001 定了 REST + 要 OpenAPI + chat 走 SSE) |
| 边界强制 | eslint-plugin-boundaries(FE/BE + barrel-only) | 仅靠约定 / Nx | 完整六边形强制(留到耦合变复杂再上) |
| 后端形态 | 模块化单体 | 微服务 | 独立伸缩(≤10qps 不需要) |
| 测试 runner | Jest(后端,Nest 原生)+ Vitest(前端,Vite 原生) | 全 Vitest / 全 Jest | 单一 runner(全 Vitest 会跟 Nest 装饰器较劲) |
| dev 拓扑 | infra 进 compose + 应用跑主机 | 全进 compose / 全主机 | 贴近生产(换热更速度) |

## Assumptions

1. 包管理器 = **pnpm**(团队习惯)
2. **Node LTS 22**
3. 后端 = **模块化单体**(非微服务)
4. **Jest(后端)+ Vitest(前端)** 双 runner 可接受
5. **Zod 契约**可接受(放弃部分 NestJS class-validator/Swagger 装饰器惯用法)

## Revisit triggers

- 模块化单体 → 抽服务:某模块(如 ingestion)需独立伸缩
- eslint 边界子集 → 完整六边形:模块耦合增长
- Jest+Vitest → 统一:双 runner 维护烦
- pnpm+Turbo → Nx:应用/包数量激增
- Zod 契约 → OpenAPI-first/codegen:出现外部 API 消费方

## Red-team

**最先崩**:OTel SDK **初始化时序**——若 tracing 不在 Nest bootstrap 前 `-r` 预加载,自动埋点(HTTP/Nest/pg)静默失效,M0.5 手动 span 看着通、自动 instrumentation 却死了。→ 预加载 + 集成测试**断言一次 HTTP 请求产出自动埋点的 span**。**循环 import**:域内 `schema.ts` 必须纯表定义(已列不变量 5)。

## 通用 Telemetry SDK 与包边界（2026-07-05 修订）

> **修订声明**：本节修订本文早前"可观测 SDK 留后端 `platform/observability` 模块、暂不成包"的判断。因产品要求 Telemetry **通用化**（不绑 RAG，直接支持 agent+tools 等 LLM 工作负载、可复用），改为**独立成包**。§config/可观测接线 的旧描述以本节为准。

### 通用性来源：建在 OTel GenAI 语义约定上

SDK **不以 RAG 阶段名（改写/意图/召回…）为基元**，而以 OpenTelemetry GenAI 通用 operation 为基元；阶段名由调用方传入：

| `gen_ai.operation.name` | 用途 | 关键属性 |
|---|---|---|
| `chat` / `text_completion` | LLM 生成 | `gen_ai.request.model`、`gen_ai.usage.input_tokens/output_tokens`、`gen_ai.system` |
| `embeddings` | 向量化 | model |
| `execute_tool` | **agent 调工具** | `gen_ai.tool.name`、`gen_ai.tool.call.id`、`gen_ai.tool.type` |
| `invoke_agent` / `create_agent` | **agent 调用** | `gen_ai.agent.name`、`gen_ai.agent.id` |
| （自定义）`retrieve` / `rerank` | RAG 检索 | `rag.retrieval.top_k`、`rag.chunk.scores`… |

→ RAG 问答（`retrieve→rerank→chat`）与 agent+tools（`invoke_agent→(chat→execute_tool→chat)*`）是**同一套 span 原语的不同编排**。

### 包结构（修订后）

```
@codecrush/otel-conventions   ← 共享(前+后)：operation/span-kind 枚举、属性 key 常量、
   dep: 仅 zod / 零依赖             Trace/Span 读侧 DTO。前端 Trace 详情 & 后端埋点共用同一词典
        ▲                    ▲
        │                    │
@codecrush/otel (Node SDK)   @codecrush/contracts (API DTO, 可 re-export Trace DTO)
   dep: @opentelemetry/* + otel-conventions
   —— 仅后端：NodeSDK 接线 + exporter + 通用 span 原语 + 脱敏钩子
```

- **前后端公用的是 `otel-conventions`**（纯类型/常量/枚举，零运行时）；SDK 运行时（`@codecrush/otel`）**仅后端**——前端从不发 span，只用 conventions 渲染。
- `rag.*` 属性 = 薄 profile；agent/tool = OTel 原生属性，无需自造。

### Isomorphic 边界（可前后端公用的判据）

**可共享三类**：① 类型/接口 ② 常量/枚举 ③ **纯函数**（无平台 API、无密钥）。**一旦碰平台专属运行时就留各自 app**：Node（`pg`/`fs`/`@opentelemetry/*`/`crypto`/密钥）→ 后端；DOM/React → 前端。共享包依赖必须极干净（见 Boundaries 不变量 8）。

- **高价值共享目标（双端必须锁一致的纯逻辑）**：Prompt `{var}` 抽取/渲染（保证**前端预览 == 后端渲染**）、引用角标 `[n]` 格式化/解析。这类比泛用 utils 有价值得多——不一致 = bug。落点：`@codecrush/prompt`（纯逻辑包）或 contracts 内纯函数。
- **避免**：泛用 `@codecrush/shared`/`utils` 垃圾桶包；过早的 `@codecrush/ui`（等 C 端与管理台拆成两个前端部署物再抽）；过早抽 tsconfig/eslint 预设包。

### 通用 SDK API 面（概览，仅后端）

`withSpan(op, opts, fn)` 为核心；语义封装 `trace.{ llm, embeddings, tool, agent, retrieve, custom }` 都只是它的 profile；`recordUsage(scope, { inputTokens, outputTokens, costUsd? })`；导出前 `redact` 脱敏钩子。RAG 与 agent 复用同一 `trace.*`，SDK 不改一行。

### 读侧与前端泛化

`traces` 读 API 与前端 Trace 详情**按 span kind 数据驱动渲染**（`llm`→prompt/token 面板、`tool`→输入/输出面板、`retriever`→命中分块面板），故 agent+tool 的 trace **免新 UI** 即可展示。

### 落地时点

- **M0.5 即建通用版**：原语覆盖 `llm/embeddings/tool/agent/retrieval/custom`（tool/agent 封装廉价，RAG 为首个消费方），将来上 agent 不重写。
- **M0 建包壳，M0.5 接线**：M0 可先建 `packages/otel-conventions` / `packages/otel` 的 package 边界与导出骨架；M0.5 再填完整词典、NodeSDK 初始化、OTLP exporter 与 `trace.*` 原语。`contracts` 不承载 OTLP 属性常量，只保留 API DTO。

### Revisit

- 出现第二个 Node 部署物（如 ingestion worker 拆进程）→ `@codecrush/otel` 包价值进一步凸显。
- VIEW 投影演进为 worker 后，抽 `packages/trace-normalizer` 复用 raw span → Observation/Trace 的转换，但仍不并入 `@codecrush/otel`。

## References

- 系统架构:`001-rag-platform-architecture`
- 实现路线图:`002-implementation-roadmap`
- 原型:`CodeCrushBot 单文件版.html`
