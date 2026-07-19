---
title: "代码组织与工程架构（M0）"
description: "monorepo 布局、NestJS 模块边界与依赖规则、端口/适配器、Zod 契约、Drizzle/ClickHouse 分工、docker-compose 与约定。"
category: "design"
number: "003"
status: draft
services: [backend, frontend, tooling, deploy]
related: ["design/001", "design/002", "design/007", "design/009", "design/010", "design/011", "design/012"]
last_modified: "2026-07-19"
---

# 003 — 代码组织与工程架构（M0）

## Status

`draft` — 承接 `001`(系统架构) 与 `002`(路线图) 的 M0 代码组织决策，尚无实现代码。M0 落地后对照真实目录/lint 配置校验，推进为 `current`。
2026-07-10：补充 010 的 ingestion Profile/Run 组织边界；Profile 公开描述归 contracts，具体定义、解析器/清洗器/分块器注册和 Run Snapshot 归 backend ingestion，Docling/OCR 只作为端口适配器存在。
2026-07-10：补充 011 的 `node-runtime` 能力域；Prompt 素材库保持叶子，预览/Agent 激活/chat 共用版本化 NodeContract 和执行器，避免 prompts↔chat 循环依赖与两套 Prompt 组装逻辑。
2026-07-11：目标业务域由 `agents` 改为 `applications`，拥有不可变配置版本、单一 production 指针、异步 ReleaseCheck 和 `ApplicationConfigResolver`。当前代码目录仍是 `agents`，迁移完成前本文保持 `draft`，详见 009。

## Summary

定义整个仓库的代码组织:**pnpm + Turborepo 管理的 TS monorepo**，`apps/{backend,frontend}` + `packages/contracts`(Zod 单一契约源) + `packages/otel-conventions` / `packages/otel`(通用 trace 语义与 Node 发射层) + `infra/`。后端 **NestJS 模块化单体**，按 001 的域切模块 + 端口/适配器(DI 注入);**模块依赖规则以本文的精确依赖边表为准**(lint 只覆盖其中一部分,见「依赖规则的真实强制力」);Drizzle 只管 Postgres DDL，ClickHouse DDL 归 Collector + 手写 VIEW;dev 用"infra 进 compose、应用跑主机热更"。

## Boundaries

> 反漂移边界 + 依赖不变量。任何实现越过这些，先改本文。

**In-scope(M0)**:monorepo 布局、目录结构、NestJS 模块边界与依赖规则、端口/适配器落位、Zod 契约包、config/env、docker-compose、Drizzle 迁移、lint/测试约定。**只搭骨架 + 基础设施 + 约定,不写业务逻辑**(业务在 M1+)。

**Out-of-scope(M0)**:任何业务逻辑;CI/CD 与生产 Dockerfile/k8s(上云延后);微服务拆分。

**依赖不变量(不可违反)**
1. **依赖方向朝下、无环(DAG)**:`gaps`(顶点，E-W4 B2a) → `eval-runs`(E-W2a) → `chat` → … → `platform` → `contracts`(基座)。
2. **跨模块只走对方 barrel 导出的 service/端口**,禁止深 import 内部文件;**任何地方不得直接 import `adapters/`**(只能 DI)。
3. **`apps/frontend` 只能 import `packages/contracts`**,碰不到 `apps/backend` 内部。
4. **`chat` 与 `traces` 无直接代码依赖**:chat 写(OTLP→Collector→ClickHouse)、traces 读(ClickHouse),经存储解耦。
5. **域内 `schema.ts` 是纯表定义**,零 service 引用(防循环 import)。
6. **迁移是显式命令**,不在应用启动时静默执行。
7. **lint 只覆盖上述不变量的一部分**(2026-07-19 逐条实测,勿凭印象):
   - **第 2 条**(只走 barrel、禁止直接 import `adapters/`)—— **完全没有** lint 兜底。
   - **第 1 条**(模块级 DAG)—— 只有 Boundary ⑤ 强制其中**一个点**「无人 import `gaps`」,其余方向不拦。
   - **第 3、8 条**(前端白名单 / 共享包纯净)—— **部分**拦:现有规则都是**黑名单**,只列了几个禁止项,
     不等于不变量本身。典型漏洞:`packages/contracts` 里 `import "pg"` 当前 lint 是绿的。
   - **`eslint-plugin-boundaries` / `eslint-plugin-import` 均未安装**,勿据其存在做判断。

   ⇒ **任何一条都不能以「`pnpm lint` 通过」推断合规**。逐条覆盖范围见下方「依赖规则的真实强制力」。
8. **共享包保持纯净**：`@codecrush/contracts`、`@codecrush/otel-conventions` 只可依赖 `zod`（或零依赖），严禁引入 Node-only（`pg`/`fs`/`@opentelemetry/*`）或浏览器-only 依赖——否则前端打包会拉入 Node 依赖而炸。（见 §「通用 Telemetry SDK 与包边界」）

## Context

Repo 为 greenfield(仅原型 HTML + docs)。M0 的所有选择都是全新决策,依据 001 的技术栈(NestJS · React+Vite+antd · Postgres+pgvector · ClickHouse · OTel Collector · pg-boss · Drizzle · 全 TS)与 002 的模块划分/波次。

## Goals / Non-goals

**Goals**:一套能撑起 M1–M9 的目录与边界;`pnpm dev` 一条命令起全套;把 002 的依赖 DAG 落成**明确可查的边表**(lint 只覆盖其中一部分,逐条见「依赖规则的真实强制力」);前后端契约单一来源不漂移;`docker compose up` 可复现本地环境。

**Non-goals**:业务逻辑、CI/CD、生产镜像、微服务(见 Boundaries)。

## Requirements & 数字

- 规模:**2 应用 + ~13 后端域模块 + ~2 共享包 + ~14 张 Postgres 表**（010/011 增强后估算）。
- 该模块数 × ≤10 qps → **模块化单体(单进程)**;拆微服务 = 为 ≤10qps 养 12 套部署/追踪,纯负债。跨模块走进程内 DI,零网络开销。
- 构建预算:Turborepo 增量缓存,全量 build <30s、增量 <5s(2 应用规模可达)。

## Design

### 目录结构

```
rag-service/
├─ apps/
│  ├─ backend/                      # NestJS 模块化单体
│  │  ├─ src/
│  │  │  ├─ main.ts                 # bootstrap(首条 import "./tracing" 引导 OTel, prod/dev 统一)
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
│  │  │     ├─ ingestion/ chunks/ retrieval/ node-runtime/ applications/
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

端口(interface)归"需要它的域模块"所有:`models` 拥有 `ModelProviderPort`、`retrieval` 拥有 `RetrieverPort`、`platform/storage` 拥有 `BlobStore`。适配器实现之,经 **NestJS DI token → 实现** 注入(如 `ProtocolDispatchAdapter`/`PgVectorRetriever`/`LocalFsBlobStore`,日后 `OssBlobStore`)。**拿端口,不拿适配器**——保证本地自建 ↔ 阿里云托管零改动切换(呼应 001)。

**模型协议适配的内部组织**(001「协议格式为路由键」的落地):`ModelProviderPort` 始终只有**一个** DI 适配器 `ProtocolDispatchAdapter`(fetch/超时/latency/密钥擦除集中一处),请求构造与响应形状校验下沉为 `models/adapters/protocols/*.ts` **纯函数 builder**,按 `(type, protocol)` 查表分发;合法组合由 contracts 的 `PROTOCOLS_BY_TYPE` 单一事实源收口(前端候选渲染与后端校验共用)。新增协议 = 加一个 builder 文件 + 表项,不动端口与消费方。

**文档处理 Profile 的内部组织（010）**：`ingestion` 域拥有版本化 Profile 注册表、Run 编排、质量门以及 `DocumentParserPort` / `DocumentNormalizerPort` / `ChunkerPort`。Profile 只引用受信任组件 ID；NestJS Module 经 DI 把 parser/normalizer/chunker adapters 装配进注册表，Pipeline 与跨域 service 不得直接 import `adapters/`。队列消息只携带 `processingRunId`，运行配置从不可变 `document_processing_runs.profile_snapshot` 读取，不在 Worker 执行时重新解析知识库最新配置。

- `@codecrush/contracts`：只放 Profile 公共描述、选择请求和 Run 响应 Zod schema；不放 Node Buffer、Docling client、Profile 可执行定义或任意配置执行器。
- `apps/backend/src/modules/ingestion/ports/`：Canonical Document、parser/normalizer/chunker/profile resolver 的后端端口。
- `apps/backend/src/modules/ingestion/adapters/`：`pdf-parse`、Docling/OCR、具体 normalizer 与 chunker；仅由 `ingestion.module.ts` 装配。
- `apps/backend/src/modules/ingestion/profiles/`：版本化 Profile 定义和服务端校验；不得依赖 frontend。
- `apps/backend/src/modules/ingestion/runs/`：Run service/repository、状态机、Snapshot 与质量门；外部模块只走 ingestion barrel 导出的 service。
- `platform/storage` / `platform/queue`：继续提供中性 `BlobStore` / `Queue` 端口，不感知 Profile、Canonical Document 或 Docling。
- Docling/OCR 服务：独立运行时依赖，通过 ingestion-owned adapter 调用；其 URL、内部凭据、超时和资源限制由 `platform/config` 提供，不新建跨域业务模块。

**应用配置与发布的内部组织（009）**：`applications` 域拥有应用身份、不可变配置版本、production 指针、ReleaseCheck 状态/fingerprint/队列协调和 `ApplicationConfigResolver`。`chat` 只通过 applications barrel 取得已解析配置；不得直接访问 applications repository/schema。applications 调用 node-runtime 的 `compileAndSample(NodeSampleRequest)`，但不得自行拼接 Prompt 或解析模型输出。

**LLM 节点契约的内部组织（011）**：新增 `node-runtime` 能力域，拥有版本化 `NodeContractRegistry`、模板编译/严格渲染、三层消息组装、结构化输出归一化、Schema/动态值域校验、一次修复和 Fallback。Prompt 后台试运行、应用 ReleaseCheck 与 chat 运行时均调用同一 `NodeRuntimeService`；任何一方不得自行拼接 Prompt 或解析模型 JSON。

- `apps/backend/src/modules/node-runtime/contracts/`：rewrite/intent/reply/fallback 的版本化 Contract、固定 System、Fallback 与注册表。
- `apps/backend/src/modules/node-runtime/compiler/`：字段扫描、错误建议、`renderTemplateStrict`、Runtime Data envelope 和消息组装。
- `apps/backend/src/modules/node-runtime/executor/`：调用 `ModelProviderPort` structured output、归一化、Zod/动态校验、修复与 Fallback。
- `node-runtime` 不依赖 `prompts`、`applications`、`chat`、knowledge-bases 或 retrieval；调用方传入固定 PromptVersion body、modelId、modelParams、samples 和中性 RuntimeContext，避免循环依赖。
- ~~`prompts` 继续是 persistence 叶子；Prompt 页面直接调用 node-runtime preview API，后端 prompts 模块不反向依赖执行层。~~
  **已被下方 2026-07-11 条目部分取代**——试运行这一条路径改为 `prompts` 后端直接
  依赖 `NodeRuntimeService`，不是前端直连 node-runtime 新端点；`prompts` 仍是
  持久化叶子（无 repository 反查），但不再是"零域依赖"。
  2026-07-11（M8.0 落地）：实现阶段发现按此约束需要新端点 + 前端改调用路径，
  与 012 已实现并过 QA 的 try-run 端点（`POST /api/prompts/:id/versions/:version/
  try-run`，为避免二次破坏性改动而设计了 tagged union 响应形状）冲突，用户拍板
  （`/ship:design` AskUserQuestion）改为窄范围例外：`prompts.service.tryRun()`
  内部依赖 `NodeRuntimeService`（`prompts → node-runtime`），仅限单节点执行转发，
  不做 repository/数据查询访问，不产生依赖环（node-runtime 仍不反向依赖
  prompts，上一条约束不变）。理由与决策记录见
  `.ship/tasks/m80-node-runtime/plan/spec.md` Investigation Findings。
- `prompt_versions.contract_version` 固定 Contract；`@codecrush/contracts` 只承载公共字段/输出 DTO、编译错误与预览 API schema，不承载固定 System、Fallback 函数或模型运行时。

### 模块依赖分层(代码/运行时 import 依赖，`A → B` = A 依赖 B)

> 注意:这与 002 的 DAG 不同——002 是**建造顺序**,这里是**代码 import 依赖**。两者一致但视角不同。

```
⓪ 知识缺口    gaps 问题池 / 坏样本聚类(E-W4 B2a 新顶点，见 021)
                  │  依赖 ↓（eval-runs 进评测集 + evaluations 阈值 + models embedding）
① 评测编排    eval-runs 离线评测 run(E-W2a，见 018)
                  │  依赖 ↓（chat 编排 + evaluations 判分 + applications 版本解析）
                  ├────────────────────────────► evaluations 在线评测/判分(E-W1，见 017)
                  │                                  │ 依赖 ↓ conversations · chunks · models
② 编排        chat 问答编排 ─────────── (虚线: 经 OTLP/CH, 无代码依赖) ┄┄► traces 追踪(只读 CH)
                  │  依赖 ↓
③ 配置·会话   applications 配置/发布 · conversations 会话
                  │
④ 能力域      retrieval 检索 · ingestion 入库 · documents 文档 · node-runtime 节点执行
                  │
⑤ 域叶子      models 模型 · prompts · kb 知识库 · chunks 切片 · auth 认证(横切)
                  │
⑥ 基座        platform: config · persistence · queue · storage · observability
                  │
⑦ 契约        contracts: Zod DTO；otel-conventions: trace 语义常量(前后端共用)
```

精确依赖边:
- `gaps` → `eval-runs`(进评测集：批量建 draft 用例)、`evaluations`(阈值/judge 版本/embeddingModelId)、`models`(`ModelProviderPort`：聚类 embedding 与 gold 草拟)、`platform/{clickhouse,persistence,queue}`——E-W4 B2a 新顶点，见 021 决策 A；**任何模块不得 import `gaps`**（`eslint.config.mjs` 的 Boundary ⑤ 机械强制）。**无** `gaps → traces`（自持 CH 只读 repository，同 evaluations 先例）、**无** `gaps → chunks/retrieval/applications`
- `eval-runs` → `chat`(编排 `OrchestrationService`)、`evaluations`(判分 `EvaluationJudgeService`)、`applications`(`resolveForTest` 版本解析)——E-W2a，见 018 决策 A；反向依赖一律禁止（`chat`/`evaluations` 不感知 `eval-runs`）
- `chat` → `applications`、`retrieval`、`prompts`、`node-runtime`、`conversations`、`observability`（配置只经 `ApplicationConfigResolver`，LLM 调用经 node-runtime）
- `evaluations` → `conversations`、`chunks`、`models` + ClickHouse 读客户端（E-W1，见下方「E-W1 evaluations 域边界」；与 `traces` 互不 import，写侧经 OTLP `rag.eval` 解耦）
- `conversations` → `applications`
- `applications` → `knowledge-bases`、`models`、`prompts`、`node-runtime`（ReleaseCheck）
- `retrieval` → `models`、`chunks`
- `ingestion` → `documents`、`chunks`、`models`、`storage`、`queue`；Profile/Run/Canonical Document 均留在 ingestion 域内，不增加新的横向业务依赖
- `node-runtime` → `models`、`platform/observability`、`contracts`；不得反向依赖 prompts/applications/chat
- `documents` → `knowledge-bases`、`storage`、`queue`
- `knowledge-bases` → `models`
- `models` / `prompts` / `chunks` → 无域依赖(叶子),仅 `persistence`
  （`prompts` 例外：见上方 M8.0 补充说明，`prompts → node-runtime` 的窄范围转发依赖）
- `auth` → `users`、`config`(横切:全局 guard,别的模块不 import 它;@Public()/principal 类型在 platform/security)
- `users` → `persistence`(叶子;user 实体归属地,供 auth 校验凭据、未来 conversations.user_id 外键引用)
- `traces` → `chunks`(读正文) + ClickHouse 读客户端;**与 `chat` 零代码依赖**
- 所有域模块 → `platform` → `contracts`

四条要点:①无环、方向朝下;②破环靠端口 + DI(如 `ingestion` 依赖 `ModelProviderPort` 而非 models 内部);③关键解耦 chat 写/traces 读经 ClickHouse → M9 可在 M8 后独立开发,且埋点挂了不影响问答;④`platform`/`contracts` 是地基,人人依赖、不依赖任何域。

### 依赖规则的真实强制力（2026-07-19 订正）

> ⚠️ **本节此前失实**，原文称 `eslint-plugin-boundaries` / `import/no-restricted-paths` 把 002 的 DAG「lint 期焊死」。
> B2a 波实测：**这两个插件根本没有安装**（见根 `package.json` 的 devDependencies），仓库内也无架构测试。

逐条对照「依赖不变量」清单，实际强制力如下。
**注意每条规则都是黑名单（列举禁止的 import），不是白名单**——所以多数只覆盖不变量的一部分：

| 不变量 | 实际覆盖 | 拦得住什么 / 漏什么 |
|---|---|---|
| 1. 模块级 DAG（方向朝下、无环） | ⚠️ **仅一个点** | Boundary ⑤ 只拦「任何后端模块 import `gaps`」。其余所有跨模块方向（如 `chat → eval-runs` 这种反向边）**一律不拦** |
| 2. 只走 barrel、禁止直接 import `adapters/` | ❌ **完全不拦** | `eslint.config.mjs` 无任何 barrel / `adapters` 规则，纯靠 review |
| 3. 前端只能 import contracts / otel-conventions | ⚠️ **部分** | Boundary ① 拦 `@codecrush/backend*` 与 `@codecrush/otel*`。但它是**黑名单**：用相对路径爬进 `apps/backend`（`../../../backend/src/...`）、或引入其它 Node-only 包，**都不拦** |
| 8. 共享包纯净 | ⚠️ **部分** | Boundary ②（contracts）只拦 `@codecrush/backend`/`@codecrush/frontend`/`@opentelemetry/*`——**不拦 `pg`、`fs`、`node:*`**，而不变量 8 正是点名要禁它们。Boundary ③（otel-conventions）额外拦了 `node:*`、`@codecrush/*`，是四条里覆盖最全的。Boundary ④（otel）拦 contracts / ClickHouse client / apps |

> **已知缺口（不在 B2a 范围内，留待专门一波收）**：在 `packages/contracts/**` 里写 `import { Pool } from "pg"`
> 或 `import fs from "node:fs"` **当前 lint 是绿的**，而这正是不变量 8 明文要防、且一旦发生会让前端打包炸的情况。
> 要补就照 Boundary ③ 的写法给 Boundary ② 加 `node:*` 与具体 Node-only 包的 group。本波只如实记录，不顺手扩范围。

**Boundary ⑤ 的写法有个坑，记在这里免得重犯**：`no-restricted-imports` 的 `group` 走 gitignore 式匹配，
`"../gaps/*"` 这种写法**只匹配深度恰为 1 的相对路径**，`../../gaps/x` 会漏；
而 `"**/modules/gaps/*"` 对相对 import **根本不匹配**（import 字符串里没有 `modules/` 这一段）。
必须写成任意深度的 `["**/gaps", "**/gaps/**"]`。
本规则第一版正是踩了这个坑，且首次验证只植入了深度 1 的反例而误判通过——**验证反向规则时务必覆盖多个目录深度**。

⇒ 判断某处实现是否合规，**不能**以「`pnpm lint` 通过」为据——它对不变量 1、2 几乎不看，对 3、8 也只覆盖了各自的一部分。须对照本文的精确依赖边表。
若将来要把模块级 DAG 与 barrel 规则也焊死，需引入 `eslint-plugin-boundaries` 并为每个域声明 element type——那是一次独立的工程决策。

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
| 边界强制 | ESLint 核心 `no-restricted-imports`(若干条黑名单 + Boundary ⑤) | `eslint-plugin-boundaries` / 仅靠约定 / Nx | 插件版未落地(**当前未安装**);现有规则只覆盖各不变量的**一部分**,模块级 DAG 与 barrel 规则靠文档+review,见「依赖规则的真实强制力」 |
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
- ingestion 同进程 Worker → 独立解析服务：增强解析排队 P95 >5 分钟或入库 >100 文档/分钟；Profile/Run 契约保持不变，只替换 Queue 消费部署物
- eslint 边界子集 → 完整六边形:模块耦合增长
- Jest+Vitest → 统一:双 runner 维护烦
- pnpm+Turbo → Nx:应用/包数量激增
- Zod 契约 → OpenAPI-first/codegen:出现外部 API 消费方
- NodeContract 活跃版本 >3 或节点类型 >8 → 设计契约迁移助手/受约束插件；`node-runtime` 仍保持低于 chat/applications 的共享能力层

## Red-team

**最先崩**:OTel SDK **初始化时序**——若 tracing 不在被 instrument 的模块(HTTP/Nest/pg)import 前生效,自动埋点静默失效,M0.5 手动 span 看着通、自动 instrumentation 却死了。→ `main.ts` **首条** `import "./tracing"`(编译后 require 顺序先于 app.module),prod(`node dist/main.js`)与 dev(`nest start`)统一经此引导;集成测试**断言一次 HTTP 请求产出自动埋点的 span**。**循环 import**:域内 `schema.ts` 必须纯表定义(已列不变量 5)。

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

### E-W1 evaluations 域边界

- `apps/backend/src/modules/evaluations` 拥有在线评测设置、水位、租约、抽样、Judge 编排和质量 API；仅通过公开 service/port 读取 conversations、chunks、models。
- evaluations 与 traces 不直接 import；写侧通过 OTLP `rag.eval` 解耦，读侧分别查询 ClickHouse VIEW。
- 共享 API 形状放在 `@codecrush/contracts/quality`，属性 key 放在 `@codecrush/otel-conventions`；evidence 只使用 `CODECRUSH_IO.OUTPUT`，由 `@codecrush/otel` 统一脱敏。
- 周期任务注册在 platform queue，但业务状态机留在 evaluations；schedule adapter 不感知领域 schema。

### E-W2a eval-runs 域边界

- `apps/backend/src/modules/eval-runs` 拥有评测集/用例/用例版本/run/逐用例结果，以及 run 引擎（发起、停止、预算熔断、全局串行租约）。**它是新的依赖顶点**（`AGENTS.md` 边界 1 已同步）：run 引擎须同时驱动 chat 编排与 evaluations 判分，放进任一方都会耦死；置于两者之上则图仍无环。完整论证见 `018` 决策 A。
- 允许的依赖边**仅**：`eval-runs → chat`（`OrchestrationService.runForEvaluation`）、`eval-runs → evaluations`（`EvaluationJudgeService.scoreOffline`）、`eval-runs → applications`（`resolveForTest`，preview=true 的显式版本解析）。**`evaluations` 与 `chat` 均不反向依赖 `eval-runs`**——017 的 evaluations 域边界不变。
- 导出面最小化：`EvaluationsModule` 只导出 `EvaluationJudgeService` + `EvaluationsRepository`（E-W2b 重放判分复用在线设置）；`ChatModule` 只新增导出 `OrchestrationService`。
- **E-W2b 反向依赖解耦（缺口 5 收口）**：`applications` 暴露 `registerDeletionGuard(guard)` 注册端口，`eval-runs` 注册「活跃 run 引用检查器」——依赖方向仍 `eval-runs → applications`，applications 不知道 eval-runs（回调解耦，lint 边界 0）。重放端点 `POST /eval/replay` 归 `eval-runs`（它已依赖 chat/applications/evaluations，是唯一无新边的落点；原型 §12.3 的 `POST /traces/:id/replay` 是 API 草案，改此以守依赖图，UI 行为不变）。
- **离线 run 结果存 Postgres，绝不发 `rag.eval` span**：ClickHouse 的 `codecrush_eval_targets_mv` 只按 `SpanName='rag.eval'` 过滤、**不看 preview**，发 span 即污染屏1 在线总览。写侧隔离靠存储物理分离，不靠过滤条件。见 `018` 决策 B（附守护测试）。
- run 产生的 preview trace 照常经 OTLP 进 ClickHouse（`rag.pipeline`，`preview=true` + `rag.eval.run_id`）——给编排 trace 打标 ≠ 发评测 span，前者不进 MV。
- 队列 job 注册在 platform queue（`EVAL_RUN_QUEUE`），业务状态机留在 eval-runs；跨域引用（`application_id`/`config_version_id`/模型 id）只存 id、不建 FK。

## References

- 系统架构:`001-rag-platform-architecture`
- 实现路线图:`002-implementation-roadmap`
- 原型:`CodeCrushBot 单文件版.html`
