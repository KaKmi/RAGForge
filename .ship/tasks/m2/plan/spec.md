# M2 Spec — 前后端页面骨架（host 版，diff 后合并）

> 基于 `docs/design/006-m2-app-shell-skeleton.md`（arch-design）+ 代码现状调查 + peer diff 合并。
> arch-design 已完成 9 lens 自审与 8 项拒绝备选；peer diff 发现 006 对原型有事实性错误（start/dashboard 合并、evalreport 误列独立页），已在 diff-report.md 裁决，本 spec 反映合并后结论。003/006 文档修订作为前置 story。

## Problem / Motivation

M1 完成了用户认证（JWT + auth guard），但前端只有 2 个占位页（`HomePage` 健康检查、`LoginPage` 空 Card）。M2 要把原型 `CodeCrushBot 单文件版.html`（15 屏）1:1 还原为路由化 React 骨架 + 后端各域模块 skeleton，让全貌可见可点，为 M3+ 按依赖填真实逻辑铺路。

验收标准（002 M2 行）：**15 屏可点开、布局还原、跳转通、API 契约生成**。

## Design Approach

- **前端**：react-router-dom v7 声明式嵌套路由（替代原型的 state 切换），antd Layout 三栏管理台 + C 端问答三栏。mock 数据前端硬编码（从原型提取），按路由 lazy import（`React.lazy` + vite code splitting）避免 50KB 中文 mock 全打进主包。
- **后端**：10 个新域模块 skeleton（module/controller/service），引入 nestjs-zod 的 ZodValidationPipe 替代手动 safeParse，自动生成 OpenAPI。
- **契约**：contracts 扩展 11 个 Zod schema 文件（含 evalsets/evals 拆分）。
- **SSE**：后端 chat 桩返回 mock `text/event-stream`（假 token/citation/done 事件），客户端 `api/sse.ts` 骨架消费之——M2 即可端到端验证消费链路，M8 填真实 RAG 编排。

## Investigation Findings

### 后端模块模式（标准三件套）

从 `apps/backend/src/modules/users/users.module.ts:1-11` 确认：

```ts
@Module({
  controllers: [UsersController],
  providers: [UsersRepository, UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

skeleton 模块不需要 repository（无持久化），简化为 `controllers + providers: [Service]`。

### Controller 模式（M1 手动 → M2 管道）

`apps/backend/src/modules/users/users.controller.ts:26-27` 用手动 `Schema.safeParse(body)`：
```ts
const parsed = ChangeOwnPasswordRequestSchema.safeParse(body);
if (!parsed.success) throw new BadRequestException(parsed.error.issues);
```

`apps/backend/src/modules/traces/traces.controller.ts:18` 注释明确预告："M2 引入 nestjs-zod ZodValidationPipe 后可替换为管道校验。"

M2 新模块直接用 nestjs-zod 的 `@ZodBody(Schema)` 装饰器，不再手动 safeParse。

### 全局 Guard 注册

`apps/backend/src/modules/auth/auth.module.ts:22` 用 `APP_GUARD` 注册 `JwtAuthGuard`——新增模块的端点自动在保护圈内，无需额外配置。

### 后端依赖现状

`apps/backend/package.json:31` 已有 `zod: ^4.4.3`。需新增 `nestjs-zod`（peer 调查确认 5.4.0 支持 `zod ^3.25.0 || ^4.0.0`，兼容）。

### 前端现状

- `apps/frontend/src/main.tsx:8-17`：已配 `ConfigProvider`（`colorPrimary: #1677ff`）+ `BrowserRouter`
- `apps/frontend/src/app/App.tsx:1-34`：用 `Routes`/`Route`，只有 `/` 和 `/login` 两条路由
- `apps/frontend/src/api/client.ts:1-6`：只有 `getHealth()`，用 `fetch` + `Schema.parse`
- `apps/frontend/vite.config.ts:8`：proxy 只代理 `/health`，**需扩展**代理 `/api/*` 和 `/auth/*`

### 契约模式

`packages/contracts/src/users.ts:3-11` 标准：
```ts
export const UserProfileSchema = z.object({...});
export type UserProfile = z.infer<typeof UserProfileSchema>;
```

### App Module 注册

`apps/backend/src/app.module.ts:10-20` 当前 imports：`AppConfigModule, PersistenceModule, ClickHouseModule, HealthModule, TracesModule, UsersModule, AuthModule`。M2 新增 10 个模块需追加注册。

## Changes by File

### 1. 后端依赖

`apps/backend/package.json`：新增 `nestjs-zod`（+ `@nestjs/swagger` 用于 Swagger UI 托管）。

### 2. 后端全局配置

`apps/backend/src/main.ts`：
- `setGlobalPrefix("api", { exclude: ["health"] })`（health 保持 `/health` 不变，其余统一切 `/api/*`）
- 启用 `SwaggerModule.setup('api/docs', ...)`（从 nestjs-zod 生成的 OpenAPI document），`/api/docs`（UI）+ `/api/docs-json`（JSON），标 `@Public()`
- 注册 `ZodValidationPipe` 为全局管道 + `ZodSerializerInterceptor` 为全局拦截器

`apps/backend/src/app.module.ts`：imports 追加 10 个新模块；providers 追加 `{provide: APP_PIPE, useClass: ZodValidationPipe}`、`{provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor}`。

### 3. 后端新模块（10 个）

每个模块 = `module.ts` + `controller.ts` + `service.ts`，用 nestjs-zod 的 `createZodDto` + `@Body`/`@Query`/`@Param` 装饰器（替代手动 safeParse）。端点返回 mock/空态，无 Drizzle 表。

| 模块 | 路由前缀 | 端点（skeleton） | 返回 |
|------|---------|------|------|
| models | `/api/models` | `GET /`, `GET /:id`, `POST /`, `POST /:id/test` | `[]` / mock / 201 / `{ok:true}` |
| knowledge-bases | `/api/knowledge-bases` | `GET /`, `GET /:id`, `POST /` | `[]` / mock / 201 |
| documents | `/api/documents` | `GET /?kbId=`, `GET /:id`, `POST /`（上传桩） | `[]` / mock / 202 |
| ingestion | `/api/documents/:id/ingest` | `POST /`（触发桩）, `GET /ingestion-status` | 202 / mock status |
| chunks | `/api/chunks` | `GET /:docId`, `PATCH /:id`（启用/禁用） | `[]` / 200 |
| retrieval | `/api/retrieval` | `POST /test` | `{hits:[]}` mock |
| agents | `/api/agents` | `GET /`, `GET /:id`, `POST /`, `PATCH /:id` | `[]` / mock / 201 / 200 |
| prompts | `/api/prompts` | `GET /`, `GET /:id`, `GET /:id/versions`, `POST /:id/versions` | `[]` / mock / `[]` / 201 |
| chat | `/api/chat` | `POST /`（mock SSE 流 `text/event-stream`） | 假 token/citation/done 事件 |
| conversations | `/api/conversations` | `GET /`, `GET /:id`, `GET /:id/messages` | `[]` / mock / `[]` |

**chat 桩行为**：`POST /api/chat` 返回 `Content-Type: text/event-stream`，按 100ms 间隔 flush 假 `token` 事件（拼成一句问候语），末尾 `citation` + `done` 事件。前端 `api/sse.ts` 消费并按 `ChatStreamEventSchema` parse。无真实 RAG 编排（M8）。chat 桩带 JWT（复用 M1 鉴权，不 `@Public`）。

### 4. 契约扩展（packages/contracts/src/）

新增 11 个文件 + 更新 `index.ts`（evalsets/evals 拆分）：

- `models.ts`：`ModelProviderSchema`, `ModelTypeSchema`（llm/embedding/rerank）
- `knowledge-bases.ts`：`KnowledgeBaseSchema`
- `documents.ts`：`DocumentSchema`, `DocumentStatusSchema`（upload/ingest/ready/failed）
- `chunks.ts`：`ChunkSchema`
- `retrieval.ts`：`RetrievalTestRequestSchema`, `RetrievalHitSchema`
- `agents.ts`：`AgentSchema`, `AgentConfigSchema`
- `prompts.ts`：`PromptSchema`, `PromptVersionSchema`
- `chat.ts`：`ChatRequestSchema`, `ChatStreamEventSchema`（union: token/citation/done/error）
- `conversations.ts`：`ConversationSchema`, `MessageSchema`
- `evalsets.ts`：`EvalSetSchema`（id/name/desc/caseCount）
- `evals.ts`：`EvalRunSchema`（id/setId/agentId/total/time/metrics[]/cases[]）
- `pagination.ts`：`PaginatedResponseSchema<T>`（通用）

### 5. 前端路由 + 布局

`apps/frontend/src/app/App.tsx`：扩展路由表为 14 条路由（diff 后从 13 调整：start/dashboard 拆分 + evalsets/evals 拆分，评测报告并入 evaluations 子路由）。

```
/login                                              → LoginPage（公开）
/chat                                               → ChatPage（AuthGuard）
/admin                                              → AdminLayout（AuthGuard，嵌套路由）
  index    /admin                                   → StartPage（快速开始 6 步）
           /admin/dashboard                         → DashboardPage（运行看板占位）
           /admin/agents                            → AgentsPage
           /admin/knowledge-bases                   → KnowledgeBasesPage
           /admin/knowledge-bases/:kbId/documents   → DocumentsPage
           /admin/knowledge-bases/:kbId/documents/:docId/chunks → ChunksPage
           /admin/retrieval-test                    → RetrievalTestPage
           /admin/prompts                           → PromptsPage
           /admin/evalsets                          → EvalSetsPage（占位壳）
           /admin/evaluations                       → EvalsPage（列表 + 报告子视图）
           /admin/evaluations/:reportId             → EvalsPage（报告详情）
           /admin/traces                            → TracesPage
           /admin/traces/:traceId                   → TraceDetailPage
           /admin/models                            → ModelsPage
*                                                   → 重定向到 /admin
```

新增：
- `app/AdminLayout.tsx`：Sider（导航菜单 7 项：start/llm/kb/prompts/agents/retrieval/traces，对齐原型 NAV）+ Header（用户信息/退出）+ Content（`<Outlet/>`）。dashboard/evalsets/evals 不在侧栏，从首页或子链接进入。
- `app/ChatLayout.tsx`：三栏（会话列表 + 聊天 + 引用面板）
- `app/AuthGuard.tsx`：检查 localStorage token，无则 `<Navigate to="/login"/>`

### 6. 前端页面（13 个新文件）

`apps/frontend/src/pages/`：
- `login/LoginPage.tsx`（重写：邮箱+密码表单，调 `/api/auth/login`）
- `chat/ChatPage.tsx`（三栏布局壳 + mock 会话/消息）
- `admin/StartPage.tsx`（快速开始 6 步引导，原型 adminPage='start'）
- `admin/DashboardPage.tsx`（运行看板占位：stats/agentDist/hotQs，原型 adminPage='dashboard'）
- `admin/AgentsPage.tsx`（列表 + 编辑抽屉壳）
- `admin/KnowledgeBasesPage.tsx`（列表）
- `admin/DocumentsPage.tsx`（列表 + 上传按钮）
- `admin/ChunksPage.tsx`（切片列表 + 启用/禁用开关）
- `admin/RetrievalTestPage.tsx`（测试台壳）
- `admin/PromptsPage.tsx`（列表 + 版本/diff 壳）
- `admin/EvalSetsPage.tsx`（评测集列表占位，M11 真逻辑）
- `admin/EvalsPage.tsx`（评测运行列表 + 报告详情子视图，原型 reportId 切换）
- `admin/TracesPage.tsx`（列表 + 筛选）
- `admin/TraceDetailPage.tsx`（span 树壳 + 瀑布图壳）
- `admin/ModelsPage.tsx`（列表 + 测试连接 + 新接入抽屉）

删除旧 `pages/HomePage.tsx`（功能并入 StartPage）。

页面用 `React.lazy` 懒加载（vite 天然 code splitting），mock 数据随页面分包。

### 7. 前端 API client

`apps/frontend/src/api/client.ts`：扩展为通用 `apiFetch()` 封装（自动注入 Bearer token + 401 重定向）。

新增 `apps/frontend/src/api/sse.ts`：`createSSEClient()` 骨架。

### 8. 前端 mock 数据

`apps/frontend/src/mocks/`：从原型提取 mock 数据（KB_DOCS/AGENTS/TRACES/CONVERSATIONS/SPANSETS/REPORTS 等），按域分文件（`agents.ts`/`kbs.ts`/`traces.ts`/`messages.ts` 等），用 `z.infer<Schema>` 类型标注。页面用 `React.lazy` 懒加载，mock 随路由分包（避免 50KB 中文 mock 全打进主包）。

### 9. Vite proxy 扩展

`apps/frontend/vite.config.ts`：proxy 统一为 `/api` → `http://localhost:3000`（含 SSE），保留现有 `/health` proxy。SSE 需确认 vite proxy 不缓冲流式响应（默认支持）。

## Acceptance Criteria

1. `pnpm --filter @codecrush/frontend dev` → 浏览器打开 → 15 屏可点开、跳转通
2. 登录页用 demo 账号登录成功 → token 存 localStorage → 重定向 `/admin`
3. 未登录访问 `/admin/*` → 重定向 `/login`
4. `pnpm --filter @codecrush/backend dev` → `curl /api/docs-json` 返回有效 OpenAPI JSON（含全部新域端点）
5. `pnpm lint` → 0 boundary 违规
6. `pnpm test` → 全绿
7. 管理后台 Sider 导航 7 项可点击跳转到对应页
8. C 端问答页三栏布局渲染（mock 数据）
9. **SSE 骨架端到端**：`POST /api/chat` 返回 mock 事件流，前端 `api/sse.ts` 消费并按 `ChatStreamEventSchema` parse 成功
10. **全局 Zod 管道生效**：`POST /api/agents` 非法 body → 400（来自 ZodValidationPipe）；现有 users/auth/traces 三处手写 safeParse 已移除

## Test Plan

- **前端**（vitest + @testing-library/react，沿用 `App.test.tsx` MemoryRouter 模式）：
  - AuthGuard（有/无 token 的重定向）、AdminLayout（侧栏 7 项菜单文案渲染）、LoginPage（表单提交 mock）
  - 至少 3 屏路由渲染断言（如 Traces 页有「Trace 追踪」标题、列表非空）
  - `api/sse.ts` 单测：喂 mock 事件流，断言产出符合 `ChatStreamEventSchema`
- **后端**（jest + supertest，沿用 `test/auth.e2e.spec.ts` 模式）：
  - e2e：`GET /api/models` 200 返回 mock 列表且符合 schema
  - e2e：`POST /api/agents` 非法 body → 400（ZodValidationPipe 拒绝）
  - e2e：`GET /api/docs-json` 返回 OpenAPI JSON，`paths` 含全部新域端点
  - e2e：`POST /api/chat` 返回 `text/event-stream`，事件可解析
  - 单测：新域 service 返回 mock 形状符合契约
- **契约**（vitest）：每个新 schema 正例 parse 通过、反例抛错（必填缺失/枚举非法/类型错）
- **集成**：`pnpm lint` 0 违规 + `pnpm build` 成功

## Risks / Unknowns

1. **nestjs-zod 与 Zod 4 兼容性**：peer 调查确认 5.4.0 支持 `zod ^4.0.0`，风险消除。若安装时遇 peer dependency 冲突，用 `--force` 或退回手动 safeParse。
2. **API 前缀 `/api`（破坏性变更）**：`setGlobalPrefix("api", { exclude: ["health"] })` 影响 M1 现有端点（`/auth/login`→`/api/auth/login`、`/users/me`→`/api/users/me`、`/traces/*`→`/api/traces/*`；`/health` 保持不变）。**破坏面**：`test/auth.e2e.spec.ts:83,97` 请求路径、`test/traces.controller.spec.ts` 需同步更新。前端 `client.ts` 新 client 走 `/api/*`，`getHealth` 保留 `/health`。在第一个 story 处理。
3. **003/006 文档修订（前置）**：按 AGENTS.md「改架构先改文档」，M2 第一个 story 修订 `003:143`（OpenAPI 工具链改为 nestjs-zod 自带 swagger）+ `006` 15 屏表/路由表（start/dashboard 拆分、evalreport 误列修正）。先改文档再写代码。
4. **`traces.controller.spec.ts` 单元测试模式失效**：`test/traces.controller.spec.ts:47-55` 直调 `ctrl.getTrace("not-a-hex-id")` 断言 `BadRequestException`。迁到全局 `ZodValidationPipe` 后，pipe 在 HTTP 层拦截，controller 方法不再 throw。**处理**：改为 e2e（supertest 验证 400），按 AGENTS.md「不软化测试断言」——改测试模式而非弱化断言。
5. **后端跨域 barrel-only lint 缺失**：`eslint.config.mjs` 只有 frontend/contracts/otel 边界，无后端跨域规则（`003:137-139` 要求但未落地）。M2 靠人工遵守 003 DAG（跨域只走 barrel `exports`）。barrel-only lint 规则补全单列后续任务（scope 外）。
6. **mock 数据量**：原型有约 50KB 中文 mock。用 `React.lazy` + 路由分包避免全打进主包；先提取结构代表性子集。

## Out of Scope

- 真实业务逻辑（CRUD 持久化、检索、RAG 编排）—— M3+
- SSE 流式问答实现 —— M8
- Agent 配置功能 —— M7
- 评测功能 —— M11
- 运行看板真实数据 —— M10
- 状态管理库 —— 不需要
