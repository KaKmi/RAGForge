# M2 — 前后端页面骨架（Peer Spec）

> 独立调查产出。未参考任何已存在的 M2 spec/plan/arch-design 文档。所有结论均引用实际读过的 `file:line`。

## Problem / Motivation

M0–M1 已落地工程地基、可观测最小闭环与用户/认证。当前前端只有两个占位页（`apps/frontend/src/pages/HomePage.tsx:13` "快速开始（M0 骨架）"、`apps/frontend/src/pages/LoginPage.tsx:4` "登录（占位，M1 实现）"），后端只有 `auth/users/traces/health` 四个域模块（`apps/backend/src/app.module.ts:11-19`）。

产品存在一份完整的低代码导出原型 `CodeCrushBot 单文件版.html`（约 15 屏 UI + mock 数据，`docs/design/001-rag-platform-architecture.md:48`、`:196`）。M2 的任务是把这份原型 **1:1 还原为 React+antd 路由化骨架**，同时把后端各域模块的 **skeleton + REST 脚手架 + OpenAPI 自动生成** 一次性搭出，让全貌可见可点；真实业务逻辑在 M3+ 按依赖顺序填入（`docs/design/002-implementation-roadmap.md:33` "骨架与逻辑分离"）。

**验收锚点**（`docs/design/002-implementation-roadmap.md:80`）：15 屏可点开、布局还原；跳转通；API 契约生成。

## Design approach

1. **前端：路由化 app shell + 逐屏 mock。** 用 `react-router-dom` v7（已在依赖中，`apps/frontend/package.json:18`）的嵌套路由 + `Outlet`，把原型的 `section`（chat/admin）+ `adminPage`（10 个管理页）映射为路由树。mock 数据从原型的 class 字段（`KB_DOCS`/`AGENTS`/`TRACES`/`SPANSETS`/`REPORTS` 等）抽取到 `apps/frontend/src/mock/`，逐屏 1:1 还原布局与空态。SSE 客户端骨架先行（chat 页消费），真流式留 M8。
2. **后端：域模块 skeleton + 全局 Zod 管道 + OpenAPI。** 为缺失的 10 个域（models/knowledge-bases/documents/ingestion/chunks/retrieval/agents/prompts/chat/conversations）建 `<m>.module/controller/service` 三件套，controller 暴露 REST 列表/详情桩端点（返回 mock 或空态），无 Drizzle 表（表随 M3+ 按依赖落地）。引入 `nestjs-zod` 5.4.0（明确支持 `zod ^3.25.0 || ^4.0.0`，见 Investigation）作全局 `ZodValidationPipe` + `ZodSerializerInterceptor`，替换现有手写 `safeParse`（`apps/backend/src/modules/users/users.controller.ts:26-27`、`apps/backend/src/modules/auth/auth.controller.ts:14-15`、`apps/backend/src/modules/traces/traces.controller.ts:19` 注释已预告）。
3. **契约：Zod schema 单一来源。** 在 `packages/contracts/src/` 为每个新域加 Zod schema（list/detail DTO），镜像原型 mock 数据形状。前后端共用 `z.infer` 类型，OpenAPI 由后端自动生成。
4. **OpenAPI 自动生成。** 用 `nestjs-zod` 自带的 `@nestjs/swagger` 集成（`cleanupOpenApiDoc`），挂载 `/api/docs`。**与 `docs/design/003-code-organization.md:143` "OpenAPI 由 zod-to-openapi 生成" 存在偏差**——见 Risks 决策。

## Investigation findings（带 file:line 证据）

### 1. 原型结构（`CodeCrushBot 单文件版.html` → 解码后 `/tmp/ccb_app.js`，1191 行）

原型是打包单文件：`<script type="__bundler/template">` 内是 JSON 编码的完整 HTML 字符串（221834 字符），解码后内含 `<script type="text/x-dc" data-dc-script>` 包裹的实际 React 风格 class 组件（78727 字符）。

**导航与页面枚举**（`/tmp/ccb_app.js`）：
- 顶层 `section`：`chat` | `admin`（`:5` state 初值 `section: 'chat'`），外加 `loggedIn` 登录门（`:4`）。
- `NAV`（`:257-265`）7 项：start(快速开始) / llm(模型接入) / kb(知识库) / prompts(Prompt 管理) / agents(Agent 管理) / retrieval(检索测试) / traces(Trace 追踪)。
- `adminPage` 实际分支（`:1008-1012`）共 10 个：start / dashboard / agents / kb / prompts / evalsets / evals / traces / llm / retrieval（dashboard/evalsets/evals 不在侧栏，从首页或子链接进入）。
- 加上 login + chat = **12 主路由**；含详情/抽屉子视图（trace 详情、评测报告、切片视图、KB 详情、Agent/Prompt/Model 抽屉）约 15 屏，与 `001:48` "约 15 屏" 一致。

**关键 mock 数据形状**（`/tmp/ccb_app.js`）：
- `KB_DOCS`（`:47-73`）：`{kbName: [{name,type,chunks,st,tag,updated}]}`，文档状态 `已索引/解析中/排队中/解析失败`，tag `green/gold/gray/red`。
- `STAGE_DEFS`（`:75-79`）：三阶段 `upload/ingest/ready`。
- `AGENTS`（`:151-155`）：`{id,name,desc,color,kbs[]}`。
- `CONVS`（`:157-162`）、`CITES`（`:164-198`，含 before/text/after/score）、`BASEMSGS`（`:200-239`，消息 `{r,t}`/`{r:'a',conf,cover,p:[{t}|{c}]}`，引用角标 `{c:'k1'}`）。
- `TRACES`（`:267-274`）：`{id,time,q,agent,st,tag,dur,tok}`，状态 `成功/兜底/失败`。
- `NODES`（`:276-286`）、`NODE_DETAIL`（`:288-334`）、`SPANSETS`（`:340-369`，OTLP 风格 `{sid,pid,name,kind,start,dur,status,tin,tout,cost}`，kind `retriever/reranker/llm/embedding/tool/chain`，`KIND_C`/`KIND_LABEL` `:337-338`）。
- `REPORTS`（`:103-148`）：`{id,set,agent,total,time,metrics[],cases[]}`。
- `PROMPT_BODIES`（`:81-87`）：`{name: body含{var}}`，4 节点 `rewrite/intent/reply/fallback`。
- `DF_DEFAULT`（`:92-95`）：Agent 表单字段（kbs/genModel/lightModel/rerankModel/prompt*/topK/topN/threshold/multi/fallback）。
- Trace 详情有瀑布图（`:732-744` waterfall 构建）+ OTLP JSON 导出（`:775` `traceJson`、`:783` 复制）。
- Chat 有 typing 流式态（`:7` `typing`）、引用角标 `[n]`、反馈 up/down、转人工（`:643-645`）。
- 侧栏深色主题（`:660` 白字透明底，选中 `#1677ff`），与现 frontend 浅色 sider（`apps/frontend/src/app/App.tsx:12` `theme="light"`）不同。

### 2. 前端现状

- `apps/frontend/src/app/App.tsx:1-34`：`Layout+Sider(light)+Menu+Routes`，仅 `/`、`/login` 两路由。
- `apps/frontend/src/main.tsx:1-18`：`BrowserRouter` + `ConfigProvider(zhCN, colorPrimary #1677ff, borderRadius 6)`——主题 token 已对齐原型。
- `apps/frontend/src/api/client.ts:1-6`：仅 `getHealth()`，`fetch` + `HealthResponseSchema.parse`。
- `apps/frontend/vite.config.ts:7-9`：dev proxy **仅 `/health`** → `:3000`；M2 需扩展 proxy 覆盖 `/api`、`/auth`、SSE 等。
- `apps/frontend/src/app/App.test.tsx:1-18`：`MemoryRouter` + `render`，断言品牌字 "CodeCrushBot"。
- 依赖：`antd ^6.5.0`、`react ^19.2.7`、`react-router-dom ^7.18.1`、`@ant-design/icons ^6.3.2`（`apps/frontend/package.json:13-18`）——**无需新增前端依赖**即可还原原型。

### 3. 后端现状与模块模板

- `apps/backend/src/app.module.ts:10-20`：已 imports `AppConfigModule/PersistenceModule/ClickHouseModule/HealthModule/TracesModule/UsersModule/AuthModule`。**无全局 pipe、无 swagger**。
- `apps/backend/src/main.ts:7-13`：`NestFactory.create` + `enableCors()` + `listen`。无 `useGlobalPipes`、无 `SwaggerModule.setup`。
- 模块模板（`apps/backend/src/modules/users/users.module.ts:6-11`）：`@Module({controllers,providers,exports?})`，`users` 导出 `UsersService` 供 `auth` 跨域消费（`apps/backend/src/modules/auth/auth.module.ts:12` imports `UsersModule`）。
- Controller 模板：`@Controller("x")`，手写 `Schema.safeParse(body)` + `throw BadRequestException`（`users.controller.ts:26-27`、`auth.controller.ts:14-15`）。
- Service 模板：`@Injectable()`，返回 contract 类型（`users.service.ts:28-32`）。
- Repository 模板：`@Inject(DRIZZLE) db` + drizzle 查询（`users.repository.ts:8-26`）。
- `schema.ts` 纯表定义（`users/schema.ts:3-11`，`pgTable` + `$inferSelect`）——M2 新模块暂不需要表。
- `traces.controller.ts:19` 注释："M2 引入 nestjs-zod ZodValidationPipe 后可替换为管道校验"——**M2 应落地此重构**。
- 鉴权：全局 `JwtAuthGuard`（`auth.module.ts:22` `APP_GUARD`），`@Public()` 装饰器放行（`jwt-auth.guard.ts:23-27`），`AuthenticatedUser={id,email}`。M2 新管理端默认走鉴权，chat SSE 桩按需 `@Public` 或带 token。

### 4. 契约现状

- `packages/contracts/src/index.ts:1-4`：barrel re-export `health/traces/users/auth`。
- 标准写法（`users.ts:3-11`、`auth.ts:4-15`、`traces.ts:6-29`、`health.ts:3-7`）：`export const XSchema = z.object({...}); export type X = z.infer<typeof XSchema>;`，Zod 4 特性已用（`z.coerce`、`z.string().datetime()`、`z.record(z.string(), z.unknown())`、`z.literal`）。
- `packages/contracts/package.json:18` 依赖 `zod ^4.4.3`——与后端一致（`apps/backend/package.json:31`）。

### 5. 技术兼容性验证（红队）

- **nestjs-zod + Zod 4 + NestJS 11：✓ 兼容。** npm registry 显示 `nestjs-zod 5.4.0`（约 15–24 天前发布），readme 明确 `npm install nestjs-zod # Note: zod ^3.25.0 || ^4.0.0 is also required`。提供 `ZodValidationPipe` / `ZodSerializerInterceptor` / `createZodDto` / OpenAPI（与 `@nestjs/swagger` 集成，`cleanupOpenApiDoc`）。注：一篇 2025-06 的博客称旧版不兼容 Zod 4，但当前 5.4.0 已正式支持，该结论已过时。
- **react-router-dom v7 嵌套路由 + Outlet：✓。** 现有代码已用 v7.18.1 的 `<Routes>/<Route>` 组件 API（`App.tsx:26-29`），v7 该 API 原生支持 `<Outlet />` 嵌套布局，无需切到 `createBrowserRouter`。
- **OpenAPI 路径偏差：** `003:143` 写 "OpenAPI 由 zod-to-openapi 生成"，但 nestjs-zod 5.4.0 自带 swagger 集成。两者二选一——见 Risks。

### 6. ESLint 边界现状（`eslint.config.mjs`）

- `:19-38` 强制 frontend 不得 import backend / `@codecrush/otel`。
- `:41-58` contracts 不得 import apps / `@opentelemetry/*`。
- `:61-85` otel-conventions 纯常量。
- `:88-111` `@codecrush/otel` 不得 import contracts/clickhouse/apps。
- **注意：** 当前 **无后端跨域 barrel-only 规则**（`003:137-139` 要求的"跨域只走 barrel"未 lint 焊死）。M2 新增 10 个域模块时，跨域依赖靠人工遵守 003 的 DAG（`003:122-133`），不引入违规 import。

## Changes by file

### A. 契约扩展（`packages/contracts/src/`）

新增文件，每域 list/detail DTO，镜像原型 mock 形状，沿用 `users.ts:3-11` 写法：

- `models.ts` — `ModelProviderSchema`（id/type[llm|embedding|rerank]/provider/name/baseUrl/apiKeyMasked/enabled），`ModelProviderListResponseSchema`。
- `knowledge-bases.ts` — `KnowledgeBaseSchema`（id/name/desc/embeddingModelId/docs/chunks/status），列表 + 详情。
- `documents.ts` — `DocumentSchema`（id/kbId/name/type/size/status[upload|ingest|ready|failed]/stage/error/blobKey/updatedAt），生命周期 `STAGE_DEFS` 对齐（`ccb_app.js:75-79`）。
- `chunks.ts` — `ChunkSchema`（id/docId/kbId/seq/text/tokenCount/section/enabled），列表 + 启用/禁用响应。
- `retrieval.ts` — `RetrievalTestRequestSchema`（query/kbId/embedModelId/topK/threshold/multi/weights/rerankModelId/topN）、`RetrievalHitSchema`（chunkId/docId/text/section/vecScore/kwScore/rerankScore/finalScore，对齐 `001:95` `Hit`）、`RetrievalTestResponseSchema`。
- `agents.ts` — `AgentSchema`（id/name/desc/status/kbs[]/genModelId/lightModelId/rerankModelId/promptRewriteVerId/promptIntentVerId/promptReplyVerId/promptFallbackVerId/topK/topN/threshold/multi/vecWeight/fallbackHuman），对齐 `DF_DEFAULT`（`ccb_app.js:92-95`）与 `001:85` agents 表。
- `prompts.ts` — `PromptSchema`（id/name/node[rewrite|intent|reply|fallback]/currentVersionId）、`PromptVersionSchema`（id/promptId/version/body/variables/note/author/status[draft|prod|archived]）。
- `conversations.ts` — `ConversationSchema`（id/agentId/userId/title）、`MessageSchema`（id/convId/role/content/traceId/confidence/citations，对齐 `001:89`）。
- `chat.ts` — `ChatRequestSchema`（convId/agentId/query）、SSE 事件 schema：`ChatStreamEventSchema`（union: `token`/`citation`/`done`/`error`），为 M8 预留形状。
- `evalsets.ts` — `EvalSetSchema`（id/name/desc/caseCount）。
- `evals.ts` — `EvalRunSchema`（id/setId/agentId/total/time/metrics[]/cases[]），对齐 `REPORTS`（`ccb_app.js:103-148`）。
- `index.ts` — 追加 re-export 全部新域。

### B. 后端 skeleton（`apps/backend/src/`）

**全局接线：**
- `app.module.ts` — imports 追加 10 个新域模块；providers 追加 `{provide:APP_PIPE,useClass:ZodValidationPipe}`、`{provide:APP_INTERCEPTOR,useClass:ZodSerializerInterceptor}`。
- `main.ts` — 新增 `app.setGlobalPrefix("api", { exclude: ["health"] })`（health 保持 `/health` 不变，其余统一切 `/api/*`）；`SwaggerModule.setup("api/docs", app, cleanupOpenApiDoc(document))`（UI 挂 `/api/docs`，JSON 挂 `/api/docs-json`）。前缀策略见 Risks #2。
- 现有 controller 去掉手写 `safeParse`，改用 `createZodDto` / `@Body` 直接收契约类型（users/auth/traces 三处）。

**新域模块**（每个三件套 `module/controller/service`，controller 暴露 list/detail 桩，service 返回 mock 或空数组，无 repository/schema 表）：
- `modules/models/` — `GET /api/models`、`GET /api/models/:id`、`POST /api/models`、`POST /api/models/:id/test`（连通性测试桩）。
- `modules/knowledge-bases/` — `GET /api/knowledge-bases`、`GET /api/knowledge-bases/:id`。
- `modules/documents/` — `GET /api/knowledge-bases/:kbId/documents`、`GET /api/documents/:id`、`POST /api/documents`（上传桩，blob 留 M4）。
- `modules/ingestion/` — `POST /api/documents/:id/ingest`（触发桩）、`GET /api/documents/:id/ingestion-status`。
- `modules/chunks/` — `GET /api/documents/:docId/chunks`、`PATCH /api/chunks/:id`（启用/禁用）。
- `modules/retrieval/` — `POST /api/retrieval/test`（返回 mock hits，真检索 M5）。
- `modules/agents/` — `GET /api/agents`、`GET /api/agents/:id`、`POST /api/agents`、`PATCH /api/agents/:id`。
- `modules/prompts/` — `GET /api/prompts`、`GET /api/prompts/:id`、`GET /api/prompts/:id/versions`、`POST /api/prompts/:id/versions`。
- `modules/conversations/` — `GET /api/conversations`、`GET /api/conversations/:id/messages`。
- `modules/chat/` — `POST /api/chat`（SSE 桩：返回 mock token 事件流，`text/event-stream`；真编排 M8）。

**依赖新增**（`apps/backend/package.json`）：`nestjs-zod ^5.4.0`、`@nestjs/swagger ^11.x`。

### C. 前端骨架（`apps/frontend/src/`）

**app shell 重写：**
- `app/App.tsx` — 改为嵌套路由：根 `<Route element={<AdminLayout/>}>` 含 `Outlet`，侧栏深色主题对齐原型（`ccb_app.js:660`），10 个 admin 子路由；`/chat` 独立布局；`/login` 裸页。Menu items 映射 `NAV` 7 项（`ccb_app.js:257-265`），dashboard/evalsets/evals 走首页/子链接。
- `app/AdminLayout.tsx`（新）— Sider + Header(pageTitle) + Content(Outlet)，pageTitle 从 `NAV` 查（`ccb_app.js:686`）。
- `app/ChatLayout.tsx`（新）— C 端问答布局（会话列表 + 消息流 + 引用面板）。
- `main.tsx` — 保留 ConfigProvider；可加一个轻量路由守卫（未登录跳 `/login`，读 localStorage token；M1 已有 JWT）。
- `api/client.ts` — 扩展为 typed client：每域一个 `getXxx`/`createXxx`，`fetch` + 契约 `parse`，沿用 `getHealth` 模式（`client.ts:3-6`）。带 `Authorization: Bearer` 头（从 localStorage）。
- `api/sse.ts`（新）— `openChatStream(req): AsyncIterable<ChatStreamEvent>` 骨架，封装 `EventSource`/`fetch+ReadableStream`，按 `chat.ts` 契约 parse 事件。M2 接 mock，M8 接真流。
- `mock/`（新目录）— 从原型抽取 `agents.ts/kbs.ts/traces.ts/spansets.ts/reports.ts/prompts.ts/messages.ts`，作为 M2 页面数据源（M3+ 逐步切真 API）。

**页面**（`pages/`，每屏一个文件，1:1 还原布局 + mock/空态）：
- `LoginPage.tsx` — 真表单（email/password），调 `POST /api/auth/login`，成功存 token 跳 `/admin/start`。
- `ChatPage.tsx` — 会话列表 + 消息流（引用角标 `[n]` + 反馈 + 转人工）+ 引用侧栏，接 `BASEMSGS`/`CITES` mock；typing 流式用 `sse.ts` mock。
- `admin/StartPage.tsx` — 5 步快速开始（`ccb_app.js:663-669` startRaw）。
- `admin/DashboardPage.tsx` — 运行看板占位（stats/agentDist/hotQs，M10 真聚合）。
- `admin/ModelsPage.tsx` — 模型列表 + 新建/测试抽屉。
- `admin/KnowledgeBasesPage.tsx` — KB 列表 → KB 详情（文档表）→ 切片视图；上传抽屉 + 生命周期抽屉。
- `admin/PromptsPage.tsx` — Prompt 列表 + 编辑抽屉 + 版本 diff 抽屉。
- `admin/AgentsPage.tsx` — Agent 列表 + 配置抽屉（绑 KB/模型/Prompt/检索参数）。
- `admin/RetrievalPage.tsx` — 检索测试台（query → 三种分数命中表）。
- `admin/TracesPage.tsx` — Trace 列表 + 详情（瀑布图 + span 树 + OTLP JSON 导出）。
- `admin/EvalSetsPage.tsx` — 评测集列表（M11 真逻辑，M2 仅壳）。
- `admin/EvalsPage.tsx` — 评测运行列表 + 报告详情（metrics + cases）。
- `components/`（新）— 共享 `PageHeader`、`StatusTag`（对齐 `TAGS` `ccb_app.js:247-255`）、`EmptyState`。

**vite proxy 扩展**（`vite.config.ts:7-9`）：统一前缀后只需代理 `/api` 与 `/health` → `http://localhost:3000`（现有 `/health` proxy 保留）。SSE（`/api/chat`）需确认 vite proxy 不缓冲流式响应（默认支持，必要时显式关 `ws`/加 `selfHandleResponse`）。

## Acceptance criteria

1. **12 路由可点开**：`/login`、`/chat`、`/admin/start|dashboard|models|knowledge-bases|prompts|agents|retrieval|traces|evalsets|evals` 全部渲染，无白屏。
2. **布局 1:1 还原原型**：侧栏深色 + 7 项菜单；每屏的卡片/表格/抽屉结构与原型一致；空态/mock 数据可见。Trace 详情有瀑布图 + span 树；Chat 有引用角标 + 反馈。
3. **跳转通**：侧栏菜单切换、首页 5 步"去配置"跳转、KB→文档→切片下钻、Trace 列表→详情、评测列表→报告，全部可达。
4. **API 契约生成**：`pnpm --filter @codecrush/backend build` 后启动，访问 `/api/docs` 出现完整 OpenAPI（含全部新域 list/detail 端点）。
5. **全局 Zod 管道生效**：`POST /api/agents` 等 body 校验走 `ZodValidationPipe`；现有 users/auth/traces 三处手写 `safeParse` 已移除（`traces.controller.ts:19` 注释兑现）。
6. **SSE 客户端骨架**：`api/sse.ts` 可消费 chat 桩端点的 mock 事件流，按 `ChatStreamEventSchema` parse。
7. **lint/边界 0 违规**：`pnpm lint` 通过；frontend 不 import backend/`@codecrush/otel`；contracts 无平台依赖（`eslint.config.mjs:19-58`）。
8. **测试**：前端 `pnpm --filter @codecrush/frontend test` 绿（含 App shell 渲染 + 至少 3 屏路由渲染断言）；后端 `pnpm --filter @codecrush/backend test` 绿（含 OpenAPI 生成 + ZodValidationPipe 拒绝非法 body 的 e2e）；contracts 新 schema 有正反例 vitest。

## Test plan

**前端（vitest + @testing-library/react，沿用 `App.test.tsx:1-18` MemoryRouter 模式）：**
- `App.test.tsx` 扩展：渲染后断言侧栏 7 项菜单文案、品牌字。
- 每个路由用 `MemoryRouter initialEntries=["/admin/xxx"]` 渲染断言关键元素（如 Traces 页有 "Trace 追踪" 标题、列表非空）。
- `api/sse.ts` 单测：喂 mock `EventSource`，断言产出符合 `ChatStreamEventSchema`。
- `mock/*` 不单测（纯数据）。

**后端（jest + supertest，沿用 `test/auth.e2e.spec.ts` 模式）：**
- e2e：`GET /api/models` 200 返回 mock 列表且符合 `ModelProviderListResponseSchema`。
- e2e：`POST /api/agents` 非法 body → 400 且错误来自 ZodValidationPipe。
- e2e：`GET /api/docs-json` 返回 OpenAPI JSON，`paths` 含全部新域端点（UI 在 `/api/docs` 可达）。
- e2e：`POST /api/chat`（SSE 桩）返回 `text/event-stream`，事件可解析。
- 单测：新域 service 返回 mock 形状符合契约。

**契约（vitest，沿用 `auth.test.ts` 模式）：**
- 每个新 schema：正例 parse 通过、反例抛错（必填缺失/枚举非法/类型错）。

## Risks / unknowns

1. **OpenAPI 工具链偏差（需先改文档）。** `003:143` 指定 `zod-to-openapi`，但 `nestjs-zod@5.4.0` 自带 `@nestjs/swagger` 集成（`cleanupOpenApiDoc`），二者选一会重复。**建议**：用 nestjs-zod 自带 swagger（少一个依赖、与 `createZodDto` 同源），并据此更新 `003:143`。按 `AGENTS.md` "改架构先改文档"，实现前需同步修订 003。若团队坚持 zod-to-openapi，则需为每域手写 OpenAPI 注册，工作量更大。
2. **API 前缀策略（已定，但有破坏面）。** 现有端点无前缀（`/health`、`/users/me`、`/auth/login`、`/traces/:id`）。M2 采用 `setGlobalPrefix("api", { exclude: ["health"] })`：health 保持 `/health`（`@Public`、前端 `client.ts:4` fetch `/health` 不变），其余统一切到 `/api/*`（auth→`/api/auth/login`、users→`/api/users/me` 等）。**破坏面**：M1 e2e（`test/auth.e2e.spec.ts`、`test/traces.controller.spec.ts`）的请求路径需同步更新；`apps/frontend/src/api/client.ts` 的 `getHealth` 保留 `/health`，其余新 client 走 `/api/*`。这不是软化断言，而是路径迁移——改测试路径而非弱化校验。
3. **后端跨域依赖无 lint 焊死。** `eslint.config.mjs` 只有 FE/contracts/otel 边界，无后端跨域 barrel-only 规则（`003:137-139` 要求但未落地）。M2 新增 10 域，若 service 间直接深 import 易破 DAG。**缓解**：M2 仅靠人工遵守 003 DAG；跨域只走 barrel `exports`（如 `agents` import `knowledge-bases` 只走 `KnowledgeBasesModule` 导出的 service）。是否在本波补 lint 边界规则——scope 外，建议单列后续任务。
4. **原型 mock 数据体量大。** `BASEMSGS`/`CITES`/`SPANSETS` 等约 50KB 中文 mock；1:1 搬入 `mock/` 会增加前端包体。**缓解**：M2 仅搬页面渲染必需的子集；其余用空态。或动态 import 按路由分包（react-router v7 + vite 天然支持）。
5. **SSE 桩 vs 真流式。** M2 chat 端点返回 mock 事件流（`text/event-stream` + 定时 flush 假 token），仅验证前端 `sse.ts` 消费链路。真 RAG 编排 + OTLP trace 在 M8，M2 不做。需明确 chat 桩是否 `@Public`（M2 无 C 端鉴权设计）——建议 M2 桩带 JWT，复用 M1。
6. **evalsets/evals/dashboard 的范围边界。** 这三屏对应 M10/M11（`002:28` 里程碑 2），但 M2 行明确要求"所有管理页"壳子（`002:80`）。M2 仅做布局 + mock，**不写**真聚合/评测逻辑，避免越界。
7. **nestjs-zod 与现有手写 pipe 的迁移面。** 替换 users/auth/traces 三处 `safeParse` 后，需确认错误响应形状不变（M1 e2e 可能断言 `parsed.error.issues`）。`ZodValidationException` 默认返回的 issue 结构需对齐现有测试，否则需调测试（按 `AGENTS.md` "不要软化测试断言"——改代码/适配层而非弱化断言）。

## Out of scope

- 任何域的真实业务逻辑（M3+ 按依赖填入）。
- 新模块的 Drizzle 表/迁移（随 M3 models、M4 kb/documents 等按依赖落地）。
- 真实 SSE 流式 + RAG 编排 + OTLP trace（M8）。
- 运行看板真聚合（M10）、评测真逻辑（M11）、RBAC（M12）。
- 后端跨域 barrel-only 的 ESLint 规则补全（建议单列任务）。
- CI/CD、生产镜像。
