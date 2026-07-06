---
title: "M2 前后端页面骨架"
description: "M2 把原型 15 屏 1:1 还原为 React+antd 路由化骨架 + NestJS 各域模块 skeleton + Zod 契约扩展 + OpenAPI 自动生成 + SSE 客户端骨架；mock 前端硬编码，真实逻辑 M3+ 按依赖填入。"
category: "design"
number: "006"
status: draft
services: [backend, frontend]
related: ["design/001", "design/002", "design/003", "design/005"]
last_modified: "2026-07-06"
---

# 006 — M2 前后端页面骨架

## Status

`draft` — 承接 001(系统架构) / 002(路线图 M2 行) / 003(代码组织) / 005(M1 auth)，经 `/ship:arch-design` 9 lens 自审完成。M2 落地后对照真实路由表与模块目录校验，推进为 `current`。

## Summary

M2 把原型 `CodeCrushBot 单文件版.html`（15 屏，低代码 `DCLogic` 单文件组件、`state.section`+`state.adminPage` 切页）**1:1 还原为路由化 React 骨架**：react-router-dom v7 声明式嵌套路由替代原型的 state 切换；antd `Layout`/`Sider`/`Content` 三栏管理台 + C 端问答三栏布局；**mock 数据前端硬编码**（从原型 `KB_DOCS`/`DOC_CONTENT`/`GENERIC_CHUNKS` 等提取），后端各域模块只建 **skeleton**（返回空数组/占位），真实逻辑 M3+ 按依赖填入。后端引入 **nestjs-zod** 的 `ZodValidationPipe` 替代 M1 的手动 `safeParse`（`traces.controller.ts:18` 注释已预告），并自动生成 OpenAPI spec。SSE 客户端建 `api/sse.ts` 骨架，M8 填真实流式逻辑。

## Boundaries

> 反漂移边界。任何实现越过这些，先改本文。

**In-scope（M2）**

* 前端 15 屏骨架（1:1 还原原型布局/导航/空态/mock 数据）

  * 登录页（接 M1 `/auth/login`）

  * C 端问答页（三栏布局壳：会话列表 + 聊天 + 引用原文）

  * 管理后台 shell（Sider 导航 + Header + Content）+ 13 个管理页

* 后端 10 个新域模块 skeleton（module/controller/service，返回空态/占位）

* contracts 扩展：10 个新 Zod schema 文件（models/kb/documents/chunks/retrieval/agents/prompts/chat/conversations + 通用分页）

* OpenAPI 自动生成（nestjs-zod → `/api/openapi.json` + Swagger UI）

* SSE 客户端骨架（`api/sse.ts`，封装 `EventSource`，不实现真实流式）

* 前端 AuthGuard（token 检查 + 401 重定向）

**Out-of-scope（M2 明确不做）**

* 任何真实业务逻辑（CRUD 真实持久化、检索、RAG 编排）—— M3+

* SSE 流式问答实现 —— M8

* Agent 配置功能（M2 只建壳，M7 填逻辑）

* 检索功能（M5）

* 评测功能（M11，M2 只建占位页）

* 运行看板真实数据（M10，M2 只建占位）

* 状态管理库（Redux/Zustand）—— 骨架不需要

* MSW 或 mock 服务 —— 前端硬编码 mock 已够

**Invariants（不可违反）**

1. **路由全覆盖**：原型 15 屏每一屏都必须有对应路由，无死链。
2. **mock 与契约类型一致**：前端 mock 数据必须满足 contracts 的 Zod schema 类型（`z.infer`），M3+ 接真实 API 时形状不漂移。
3. **后端 skeleton 端点默认在 M1 auth guard 保护圈内**：新增路由不得标 `@Public()`（除非有明确理由，如 OpenAPI JSON 端点）。
4. **前端不直接 import 后端**：只经 `@codecrush/contracts` 拿类型（003 不变量 3，ESLint 强制）。
5. **骨架页面无真实 API 调用**：M2 前端只用 mock 数据渲染；后端 skeleton 端点存在但不被前端依赖（为 OpenAPI 契约而建）。
6. **不引入新运行时依赖**（除 nestjs-zod + zod-to-openapi，003 已预告）—— 不加 Redux/Zustand/MSW/axios。

## Context / 背景

### 原型分析（`CodeCrushBot 单文件版.html`，236KB template）

原型是低代码工具导出的单文件 HTML，核心是一个继承 `DCLogic` 的 React 类组件，用 `state.section`（`'chat'`/`'admin'`）和 `state.adminPage` 切换页面，**无 react-router**。关键 state 字段（`CodeCrushBot 单文件版.html` Script 1，78727 字符）：

```js
state = {
  loggedIn: false, email: '', pwd: '', loginErr: '',     // 登录
  section: 'chat', adminPage: 'start',                    // 页面切换
  agentId: 'aftersale', convId: 'c1', citeId: null,       // C 端问答
  rightOpen: null, draft: '', typing: false, extras: {},
  feedback: {}, handoff: {}, copied: null,
  traceId: null, traceNode: 'rw',                         // Trace
  agentDrawer: false, df: null,                           // Agent 编辑抽屉
  promptDrawer: false, pf: null, pvSelVer: null, pvTab: 'diff', // Prompt 版本
  kbViewName: null, kbUpload: false, chunk: '按语义分块',  // 知识库
  llmTab: '全部', modelDrawer: false, mf: null, mfTested: false, // 模型
  trQuery: '', trAgent: '全部', trStatus: '全部',          // Trace 列表筛选
  rtKb: '售后服务知识库', rtThreshold: '0.20', rtMulti: true, // 检索测试
};
```

### 15 屏清单（从原型 labels + state 推断）

| #  | 屏         | 原型 adminPage     | 原型关键内容                                     |
| -- | --------- | ---------------- | ------------------------------------------ |
| 1  | 登录        | (loggedIn=false) | 邮箱+密码+演示账号                                 |
| 2  | C 端问答     | section='chat'   | 三栏：会话列表+聊天+引用原文，可信度/兜底/转人工                 |
| 3  | 控制台       | 'start'          | 快速开始 6 步引导 + 运行看板（今日问答量/平均耗时/兜底率/热门问题）     |
| 4  | Agent 管理  | 'agent'          | 列表(名称/简介/状态/更新时间) + 编辑抽屉(模型设置/绑定KB/Prompt) |
| 5  | 知识库管理     | 'kb'             | 知识库列表                                      |
| 6  | 知识库文档     | 'kbdoc'          | 文档列表+上传，入库流程(解析→切片→向量化→索引)                 |
| 7  | 文档切片      | 'chunk'          | 切片查看+启用/禁用                                 |
| 8  | 检索测试      | 'retrieval'      | 测试台(查询/阈值/多路召回/重排/结果)                      |
| 9  | Prompt 管理 | 'prompt'         | 列表+版本管理+diff+发布/回滚                         |
| 10 | 评测集       | 'evalset'        | **占位**（原型文字："评测集与评测管理已在规划中"）               |
| 11 | 评测管理      | 'evaladmin'      | **占位**                                     |
| 12 | 评测报告      | 'evalreport'     | **占位**                                     |
| 13 | Trace 追踪  | 'trace'          | 列表(采样/失败率/P95/筛选)                          |
| 14 | Trace 详情  | 'tracedetail'    | span 树/瀑布图(改写→意图→召回→重排→生成)                 |
| 15 | 模型调用管理    | 'llm'            | 模型列表+测试连接+新接入                              |

### 现有代码现状

* **前端**（`apps/frontend/src/`）：极简，`App.tsx` 用 react-router-dom v7 的 `Routes`/`Route`，只有 `HomePage`（M0 健康检查占位）+ `LoginPage`（占位 Card）。`main.tsx` 已配 `ConfigProvider`（`colorPrimary: #1677ff`）+ `BrowserRouter`。`api/client.ts` 只有 `getHealth()`。

* **后端**（`apps/backend/src/`）：已有 `health`/`traces`/`users`/`auth` 4 模块。controller 用手动 `Schema.safeParse(body)`（`users.controller.ts:26`），`traces.controller.ts:18` 注释明确 "M2 引入 nestjs-zod ZodValidationPipe 后可替换为管道校验"。

* **契约**（`packages/contracts/src/`）：已有 `health.ts`/`traces.ts`/`users.ts`/`auth.ts`，每个文件 `z.object({...})` + `export type = z.infer<...>`。

* **依赖**（`apps/frontend/package.json`）：react 19 / antd 6 / react-router-dom 7 / vite 8 已就位，无需新增前端依赖。

## Goals / Non-goals

**Goals**：原型 15 屏 1:1 路由化骨架可点开、跳转通、布局还原；后端 10 个新域模块 skeleton + REST 脚手架 + OpenAPI 契约生成；SSE 客户端骨架；前端登录接 M1。

**Non-goals**：见 Boundaries Out-of-scope。核心是**不写业务逻辑**、不做真实数据流。

## Requirements & 关键数字

| 维度                  | 值                                                                                    | 依据                         |
| ------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| 屏数                  | 15                                                                                   | 原型 labels + state          |
| 新增前端文件              | \~40（15 页 + 5 共享组件 + 3 API + mocks + theme）                                          | 逐屏 mirror                  |
| 新增后端 skeleton 模块    | 10（models/kb/documents/chunks/ingestion/retrieval/agents/prompts/chat/conversations） | 003 §模块依赖图                 |
| 新增 contracts schema | \~10                                                                                 | 每模块一个                      |
| 新增后端文件              | \~30（每模块 3 文件）                                                                       | module/controller/service  |
| 路由数                 | 13（含嵌套）                                                                              | 见路由表                       |
| 前端打包预算              | < 500KB gzipped                                                                      | antd 6 tree-shake + 15 页骨架 |
| 增量构建                | < 5s                                                                                 | 003 构建预算                   |
| 新运行时依赖              | nestjs-zod + zod-to-openapi（后端 only）                                                 | 003 已预告                    |

结论：规模中等，单 milestone 可完成。

## Design

### 前端目录结构

```
apps/frontend/src/
  app/
    App.tsx                 # 路由根（已存在，扩展路由表）
    AdminLayout.tsx          # 管理后台 shell：Sider(导航) + Header(用户) + Content(Outlet)
    ChatLayout.tsx           # C 端问答 shell：三栏（会话列表 + 聊天 + 引用面板）
    AuthGuard.tsx            # 登录守卫：无 token → 重定向 /login
  pages/
    login/LoginPage.tsx      # 登录页（接 M1 /auth/login）
    chat/ChatPage.tsx        # C 端问答页
    admin/
      DashboardPage.tsx              # 控制台（快速开始 + 运行看板占位）
      AgentsPage.tsx                 # Agent 管理（列表 + 编辑抽屉壳）
      KnowledgeBasesPage.tsx         # 知识库管理
      DocumentsPage.tsx              # 知识库文档
      ChunksPage.tsx                 # 文档切片
      RetrievalTestPage.tsx          # 检索测试
      PromptsPage.tsx                # Prompt 管理（版本 + diff 壳）
      EvaluationPage.tsx             # 评测占位（3 屏合一：原型文字"已在规划中"）
      TracesPage.tsx                 # Trace 追踪列表
      TraceDetailPage.tsx            # Trace 详情（span 树壳）
      ModelsPage.tsx                 # 模型调用管理
  components/
    PagePlaceholder.tsx     # 通用占位（"功能开发中，见 Mx"）
    EmptyState.tsx          # 空态
  api/
    client.ts               # 已有，扩展：fetch 封装 + Bearer token 自动注入
    sse.ts                  # SSE 客户端骨架（createSSEClient，M8 填真实逻辑）
  mocks/
    data.ts                 # 从原型提取的 mock 数据（KB_DOCS/DOC_CONTENT/agents/traces 等）
  theme/
    tokens.ts               # antd token 常量（colorPrimary: #1677ff, borderRadius: 6）
```

### 路由表

```
/login                                              → LoginPage（公开）
/chat                                               → ChatPage（AuthGuard 保护）
/admin                                              → AdminLayout（AuthGuard 保护，嵌套路由）
  index    /admin                                   → DashboardPage
           /admin/agents                            → AgentsPage
           /admin/knowledge-bases                   → KnowledgeBasesPage
           /admin/knowledge-bases/:kbId/documents   → DocumentsPage
           /admin/knowledge-bases/:kbId/documents/:docId/chunks → ChunksPage
           /admin/retrieval-test                    → RetrievalTestPage
           /admin/prompts                           → PromptsPage
           /admin/evaluations                       → EvaluationPage（占位）
           /admin/traces                            → TracesPage
           /admin/traces/:traceId                   → TraceDetailPage
           /admin/models                            → ModelsPage
*                                                   → 重定向到 /admin
```

13 条路由，覆盖 15 屏（评测 3 屏合一占位页）。

**路由深度决策**：`/admin/knowledge-bases/:kbId/documents/:docId/chunks` 是 4 层嵌套——这是有意的，因为原型里"知识库→文档→切片"是逐级下钻的导航路径，深层路由让 URL 可分享、可回退。其他管理页保持 1-2 层。

### 后端 skeleton 模块

每个新模块遵循已有 `users`/`traces` 模式（`module.ts` + `controller.ts` + `service.ts`），但用 **nestjs-zod** 的 `ZodValidationPipe` 替代手动 `safeParse`：

| 模块              | 路由前缀               | skeleton 端点（返回空态/占位）                                            |
| --------------- | ------------------ | --------------------------------------------------------------- |
| models          | `/models`          | `GET /` → `[]`，`POST /` → 201 占位，`POST /:id/test` → `{ok:true}` |
| knowledge-bases | `/knowledge-bases` | `GET /` → `[]`，`POST /` → 201 占位                                |
| documents       | `/documents`       | `GET /?kbId=` → `[]`，`POST /` → 202 占位（上传异步占位）                  |
| chunks          | `/chunks`          | `GET /:docId` → `[]`                                            |
| ingestion       | `/ingestion`       | `POST /` → 202 占位（触发解析占位）                                       |
| retrieval       | `/retrieval`       | `POST /test` → `{hits:[]}` 占位                                   |
| agents          | `/agents`          | `GET /` → `[]`，`POST /` → 201，`GET /:id` → 404 占位               |
| prompts         | `/prompts`         | `GET /` → `[]`，`GET /:id/versions` → `[]`                       |
| chat            | `/chat`            | `POST /` → 501（SSE 未实现），`GET /conversations` → `[]`             |
| conversations   | `/conversations`   | `GET /` → `[]`，`GET /:id` → 404                                 |

已有模块不改动（health/traces/users/auth），但 `traces.controller.ts` 的手动校验可顺手迁到 `ZodValidationPipe`（`traces.controller.ts:18` 注释预告）。

### 契约扩展（packages/contracts/src/）

新增 10 个文件，每个遵循 `users.ts` 模式（`z.object` + `export type`）：

```
packages/contracts/src/
  models.ts              # ModelProviderSchema, ModelTypeSchema(llm/embedding/rerank)
  knowledge-bases.ts     # KnowledgeBaseSchema
  documents.ts           # DocumentSchema, DocumentStatusSchema
  chunks.ts              # ChunkSchema
  retrieval.ts           # RetrievalRequestSchema, RetrievalHitSchema
  agents.ts              # AgentSchema, AgentConfigSchema
  prompts.ts             # PromptSchema, PromptVersionSchema
  chat.ts                # ChatRequestSchema, SSEEventSchema（M8 用）
  conversations.ts       # ConversationSchema, MessageSchema
  pagination.ts          # PaginatedResponseSchema<T>（通用）
  index.ts               # 追加 re-export 全部新 schema
```

### OpenAPI 自动生成

引入 `nestjs-zod`（提供 `ZodValidationPipe` + `createZodDto` + OpenAPI 注册）+ `@nestjs/swagger`（Swagger UI 托管）：

* 后端 `main.ts` 启用 `SwaggerModule.setup('/api/docs', app, document)`

* OpenAPI document 由 `nestjs-zod` 从 Zod schema 自动生成（`zod-to-openapi` 底层）

* 暴露端点：`GET /api/docs`（Swagger UI）+ `GET /api/docs-json`（OpenAPI JSON）

* `/api/docs` 端点标 `@Public()`（文档需无 token 访问，理由：契约文档不敏感）

### SSE 客户端骨架

`api/sse.ts`：

```typescript
// M2 骨架：封装 EventSource，M8 填真实流式逻辑
export function createSSEClient(url: string, onEvent: (data: unknown) => void): () => void {
  const es = new EventSource(url, { withCredentials: true });
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  return () => es.close(); // 返回 cleanup
}
```

**注意 005 Revisit 1**：`EventSource` 不能带 `Authorization` 头，M8 必须解决 SSE 鉴权（query-token 或 cookie）。M2 只建骨架，不接真实 chat 端点。

## Failure modes

| 故障                   | 影响                | 行为                               |
| -------------------- | ----------------- | -------------------------------- |
| 前端路由未匹配              | 用户看到空白            | `*` 路由重定向 `/admin`               |
| 后端 skeleton 未启动      | 前端页面显示空态          | 前端用 mock 数据渲染，不依赖后端（Invariant 5） |
| token 过期/缺失          | 用户访问受保护页          | AuthGuard 重定向 `/login`           |
| OpenAPI 生成失败         | 文档不可用             | 不影响运行时（只影响 `/api/docs`）          |
| mock 与契约不一致          | M3+ 接真实 API 时类型报错 | M3+ 修正（Invariant 2 要求类型一致）       |
| 后端 skeleton 端点返回 501 | chat 端点 SSE 未实现   | 前端不调用（M2 不依赖后端）                  |

## Rollout & operations

**迁移路径**：M1 的 2 页（HomePage 占位 + LoginPage 占位）扩展为 15 屏。`HomePage` 重命名为 `DashboardPage` 并移到 `pages/admin/`，`LoginPage` 重写为真实登录表单。

**"在工作"信号**：

* `pnpm --filter @codecrush/frontend dev` → 浏览器打开 → 15 屏可点开、跳转通

* `pnpm --filter @codecrush/backend dev` → `curl /api/docs` 返回 OpenAPI JSON

* `pnpm lint` → 0 boundary 违规

* `pnpm test` → 全绿

* 登录页用 demo 账号登录成功 → 重定向 `/admin` → token 存 localStorage

**回滚**：git revert（greenfield，无数据迁移）。

## Security

沿用 M1（005）的信任边界，无新跨越：

* 后端 skeleton 端点默认在 `JwtAuthGuard` 保护圈内（default-deny）

* 前端 AuthGuard 检查 localStorage token，401 重定向

* `/api/docs` 标 `@Public()`（文档不敏感，需无 token 访问）

* SSE 鉴权延后到 M8（005 Revisit 1）

* mock 数据不含真实密钥/PII（从原型提取的课程问答示例数据）

## Alternatives considered

| 决策      | 选择                                    | 拒绝                      | 放弃                                    |
| ------- | ------------------------------------- | ----------------------- | ------------------------------------- |
| 前端路由    | react-router-dom v7（已装）               | 状态切换（原型方式）              | 原型的简单性 —— 换 URL 可分享/可回退/嵌套            |
| mock 策略 | 前端硬编码 mock（从原型提取）                     | MSW / 后端 mock           | mock 与 API 一致性自动保证 —— 换零新依赖、M3+ 逐步替换  |
| 后端校验    | nestjs-zod `ZodValidationPipe`        | 手动 `safeParse`（M1 方式）   | 灵活性 —— 换声明式 + 自动 OpenAPI（003 已定方向）    |
| OpenAPI | nestjs-zod 自动生成                       | `@nestjs/swagger` 手动装饰器 | 装饰器细粒度 —— 换"一份 schema 喂校验+类型+文档"（003） |
| 状态管理    | 纯 React hooks                         | Redux/Zustand           | 全局状态管理 —— 骨架不需要，M7+ 按需                |
| 评测页     | 单个占位页（3 屏合一）                          | 3 个独立路由                 | 路由精度 —— M11 再拆，原型本身是占位                |
| C 端问答页  | M2 建布局壳                               | M2 跳过                   | 骨架完整性 —— 路线图要求 15 屏可点开                |
| 路由深度    | kb/:kbId/documents/:docId/chunks（4 层） | 扁平化 + query param       | URL 简洁 —— 换可分享/可回退的导航路径               |

## Assumptions

1. 前端硬编码 mock 数据能满足 M2 的"布局还原"验收（原型本身就用 mock）。
2. nestjs-zod 与 Zod 4 / NestJS 11 兼容（需验证；若不兼容退回手动 safeParse + `@nestjs/swagger`）。
3. 评测 3 屏合一个占位页可接受（原型本身就是占位文字）。
4. C 端问答页的 SSE 骨架不需要真实鉴权（M8 解决）。
5. react-router-dom v7 的嵌套路由 + `Outlet` 模式适用于 AdminLayout。
6. 后端 skeleton 端点返回空数组/501 即可满足"API 契约生成"验收。

## Revisit triggers

* **状态管理 → Zustand/Redux**：页面间共享状态变复杂（M7 Agent 配置可能触发，Agent 编辑抽屉需跨页状态）。

* **mock → MSW**：需要模拟网络延迟/错误/分页时（M3+ 接真实 API 时）。

* **评测页拆分**：M11 开始做评测时，拆为 3 个独立路由。

* **SSE 鉴权方案**：M8 必须解决 `EventSource` 不能带 Authorization 头（005 Revisit 1）。

* **路由扁平化**：若 4 层嵌套（kb→documents→chunks）让导航/面包屑复杂度上升。

* **前端按域分组**：页面数 > 20 后 flat 的 `pages/admin/` 难维护，改为 `pages/admin/{agents,kb,...}/` 子目录。

* **OpenAPI 手动标注**：若自动生成的 spec 缺少业务描述（如示例值、deprecated 标记）。

## Red-team

**最先崩什么？**

1. **nestjs-zod 与 Zod 4 兼容性**：Zod 4 较新（`packages/contracts` 已用），nestjs-zod 可能尚未完全适配。**缓解**：M2 第一个 story 验证兼容性；若不兼容，退回 M1 的手动 `safeParse` + `@nestjs/swagger` 手动装饰器（两-way door，不阻塞骨架）。
2. **mock 与契约类型漂移**：前端 mock 数据手写，contracts schema 手写，两边可能不一致。M3+ 接真实 API 时才发现。**缓解**：mock 数据用 `z.infer<Schema>` 类型标注（Invariant 2），TS 编译期捕获形状不匹配。
3. **15 屏的导航层级混乱**：原型用 state 切换（扁平），改路由后 `kb/:kbId/documents/:docId/chunks` 4 层嵌套可能让面包屑/导航回退体验差。**缓解**：AdminLayout 的 Sider 始终高亮顶级项，深层页面用面包屑导航；若体验差，chunks 改为 `documents/:docId?view=chunks`。
4. **后端 skeleton 端点过多但无逻辑**：10 模块 × 3-5 端点 = 30-50 个空端点，手写枯燥易错。**缓解**：保持模式一致（每模块同一套 GET/POST/GET:id），用 contracts schema 驱动端点形状；不引入 CRUD generator（一致性 > 自动化）。

## References

* 原型：`CodeCrushBot 单文件版.html`（15 屏 UI + mock 数据，DCLogic 单文件组件）

* 系统架构：`001-rag-platform-architecture`（模块清单、契约、数据模型）

* 路线图：`002-implementation-roadmap`（M2 行：15 屏可点开、跳转通、API 契约生成）

* 代码组织：`003-code-organization`（目录结构、依赖边界、Zod 契约、OpenAPI）

* 用户认证：`005-user-auth`（M1 auth guard、登录页归 M2、SSE 鉴权 Revisit）

* 现有代码：`apps/frontend/src/app/App.tsx`（路由根）、`apps/backend/src/modules/users/users.controller.ts`（controller 模式）、`packages/contracts/src/users.ts`（schema 模式）

