# M2 Plan — 前后端页面骨架

> 基于 diff 后的 `spec.md`。轻量对抗模式（CLAUDE.md）：跳过 execution drill，host 自查代替。
> 8 个 story，按依赖顺序。每个 story 内 TDD（先红后绿）。`pnpm test` + `pnpm lint` 每个 story 收尾必跑。

---

## Story 0 — 修订 003/006 设计文档（前置）

> AGENTS.md「改架构先改文档」。diff 发现 006 对原型有事实性错误 + 003 OpenAPI 工具链需更新。先改文档再写代码。

### 步骤

- [ ] **改 `docs/design/003-code-organization.md`**：找到「OpenAPI 由 zod-to-openapi 生成」一处（约 L143），改为「OpenAPI 由 nestjs-zod 自带 `@nestjs/swagger` 集成生成（`cleanupOpenApiDoc`），zod-to-openapi 不再单独引入」。理由：nestjs-zod 5.4.0 已含 swagger 集成，与 `createZodDto` 同源，少一个依赖。
- [ ] **改 `docs/design/006-m2-app-shell-skeleton.md` 15 屏表**（L98-114）：
  - 第 3 行「控制台 adminPage='start'」拆为两行：`#3 快速开始 adminPage='start'`、`#4 运行看板 adminPage='dashboard'`（原型 `ccb_app2.js:1008,1010` 确认独立）。
  - 删除第 12 行「评测报告 adminPage='evalreport'」——原型无此 adminPage 值，评测报告是 `evals` 的子视图（`ccb_app2.js:1120` `evalReportView: !!S.reportId`）。
  - 屏数仍记 15（login/chat/start/dashboard/agents/kb/kbdoc/chunk/retrieval/prompts/evalsets/evals(+report子视图)/traces/tracedetail/llm）。
- [ ] **改 `docs/design/006` 路由表**（L188-204）：
  - `/admin` index → `StartPage`（快速开始）
  - 新增 `/admin/dashboard` → `DashboardPage`
  - `/admin/evaluations` 拆为 `/admin/evalsets` + `/admin/evaluations`（含 `:reportId` 子路由）
  - 路由数 13 → 14
- [ ] **改 `docs/design/006` 后端模块表**（L214-225）：chat 行 `POST / → 501` 改为 `POST / → mock SSE 流`。
- [ ] **改 `docs/design/006` Alternatives 表**（L327）：评测页「3 屏合一」改为「evalsets + evals 2 页（报告为 evals 子视图）」。
- [ ] **改 `docs/design/006` Requirements 表**（L144）：`zod-to-openapi` 改为 `nestjs-zod 自带 swagger`。新增 contracts schema 数 10 → 11。
- [ ] 提交：`docs(design): revise 003/006 for M2 — openapi tooling, route split, prototype fix`

**验证**：`git diff docs/design/` 人工审查；006 路由表与 spec.md 路由表一致。

---

## Story 1 — 后端全局配置 + nestjs-zod 迁移 + M1 测试修复

> 引入 nestjs-zod，全局 Zod 管道 + OpenAPI；迁移 M1 手写 safeParse；修复 API 前缀破坏面。这是破坏性变更，最先做。

### 步骤

- [ ] **装依赖**：`pnpm --filter @codecrush/backend add nestjs-zod @nestjs/swagger`。验证 `nestjs-zod` peer 要求 `zod ^3.25.0 || ^4.0.0`（后端 zod ^4.4.3 满足）。
- [ ] **红**：写 `apps/backend/test/openapi.e2e.spec.ts`——`GET /api/docs-json` 返回 200 且 `paths` 含 `/api/auth/login`、`/api/users/me`。先跑应失败（无 swagger）。
- [ ] **红**：写 `apps/backend/test/zod-pipe.e2e.spec.ts`——`POST /api/agents`（端点尚不存在，先占位用 `/api/auth/login` 送畸形 body）期望 400 且响应来自 ZodValidationPipe。先跑应失败。
- [ ] **改 `apps/backend/src/main.ts`**：
  ```ts
  app.setGlobalPrefix("api", { exclude: ["health"] });
  app.useGlobalPipes(app.get(ZodValidationPipe)); // 或 APP_PIPE 注册
  const doc = SwaggerModule.createDocument(app, nestjsZodOpenApi());
  SwaggerModule.setup("api/docs", app, doc);
  ```
  参考 nestjs-zod readme（`createZodDto` + `nestjsZodOpenApi()` 或 `extendZodWithOpenApi`）。
- [ ] **改 `apps/backend/src/app.module.ts`**：providers 追加 `{ provide: APP_PIPE, useClass: ZodValidationPipe }`、`{ provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }`。
- [ ] **迁移 `users.controller.ts`**：`changeOwnPassword` 的手动 `safeParse` 改为 `@Body(new ZodValidationPipe(ChangeOwnPasswordRequestSchema))` 或 `createZodDto`。删除 `BadRequestException(parsed.error.issues)` 手写逻辑。
- [ ] **迁移 `auth.controller.ts`**：`login` 的手动 `safeParse` 同样迁移。
- [ ] **迁移 `traces.controller.ts`**：`getTrace` 的 hex id 校验——用 `@Param('traceId', new ZodValidationPipe(TraceIdSchema))` 或保留 controller 内防御性校验（见下）。**注意**：`traces.controller.spec.ts:47-55` 直调方法断言 throw 会失效。
- [ ] **改 `test/traces.controller.spec.ts`**：将「rejects malformed trace ids」单测改为 e2e（supertest `GET /api/traces/not-a-hex-id` 期望 400）。保留断言强度（400 + 不调 service），不软化。或：保留 controller 内 `safeParse` 作防御性双保险（pipe + controller 都校验），单测不变。**推荐后者**——pipe 是声明式校验，controller 防御性校验不冲突，单测无需改。
- [ ] **改 `test/auth.e2e.spec.ts`**：路径 `/auth/login` → `/api/auth/login`、`/users/me` → `/api/users/me`（L83, L97）。断言不变。
- [ ] **改 `test/traces.controller.spec.ts`**：若保留 controller 防御性校验，无需改路径（单测不经过前缀）。若有 e2e traces 测试，路径加 `/api`。
- [ ] **绿**：跑 `pnpm --filter @codecrush/backend test`。OpenAPI + zod-pipe e2e 应通过。
- [ ] **验证前端**：`apps/frontend/src/api/client.ts` 的 `getHealth()` 仍 fetch `/health`（不变）。后续 story 扩展 client 走 `/api/*`。
- [ ] 提交：`feat(backend): add nestjs-zod global pipe + openapi + migrate M1 controllers`

**验证**：`curl http://localhost:3000/api/docs-json | jq '.paths | keys'` 含 `/api/auth/login`、`/api/users/me`、`/api/traces/:id`、`/health`。`pnpm lint` 0 违规。

---

## Story 2 — 契约扩展（11 个新 schema 文件）

> 前后端共用的单一来源。先写契约，后端 skeleton 和前端 mock 都依赖它。

### 步骤

- [ ] **红**：为每个新 schema 写正反例 vitest（`packages/contracts/src/__tests__/`）。先写测试，再写 schema。
- [ ] 写 `packages/contracts/src/models.ts`：
  ```ts
  import { z } from "zod";
  export const ModelTypeSchema = z.enum(["llm", "embedding", "rerank"]);
  export const ModelProviderSchema = z.object({
    id: z.string(),
    type: ModelTypeSchema,
    provider: z.string(),
    name: z.string(),
    baseUrl: z.string().url().optional(),
    apiKeyMasked: z.string().optional(),
    enabled: z.boolean(),
  });
  export const ModelProviderListResponseSchema = z.array(ModelProviderSchema);
  export type ModelProvider = z.infer<typeof ModelProviderSchema>;
  ```
- [ ] 写 `knowledge-bases.ts`：`KnowledgeBaseSchema`（id/name/desc/embeddingModelId/docs count/chunks count/status）。
- [ ] 写 `documents.ts`：`DocumentStatusSchema`（z.enum upload/ingest/ready/failed）、`DocumentSchema`（id/kbId/name/type/size/status/stage/error/blobKey/updatedAt）。
- [ ] 写 `chunks.ts`：`ChunkSchema`（id/docId/kbId/seq/text/tokenCount/section/enabled）。
- [ ] 写 `retrieval.ts`：`RetrievalTestRequestSchema`（query/kbId/embedModelId/topK/threshold/multi/weights/rerankModelId/topN）、`RetrievalHitSchema`（chunkId/docId/text/section/vecScore/kwScore/rerankScore/finalScore）、`RetrievalTestResponseSchema`（hits array）。
- [ ] 写 `agents.ts`：`AgentSchema`（id/name/desc/status/kbs[]/genModelId/lightModelId/rerankModelId/promptRewriteVerId/promptIntentVerId/promptReplyVerId/promptFallbackVerId/topK/topN/threshold/multi/vecWeight/fallbackHuman）。
- [ ] 写 `prompts.ts`：`PromptSchema`（id/name/node: rewrite|intent|reply|fallback/currentVersionId）、`PromptVersionSchema`（id/promptId/version/body/variables/note/author/status: draft|prod|archived）。
- [ ] 写 `chat.ts`：`ChatRequestSchema`（convId?/agentId/query）、`ChatStreamEventSchema`（union: token/citation/done/error，用 `z.discriminatedUnion`）。
- [ ] 写 `conversations.ts`：`ConversationSchema`（id/agentId/userId/title）、`MessageSchema`（id/convId/role/content/traceId?/confidence?/citations?）。
- [ ] 写 `evalsets.ts`：`EvalSetSchema`（id/name/desc/caseCount）。
- [ ] 写 `evals.ts`：`EvalRunSchema`（id/setId/agentId/total/time/metrics[]/cases[]）。
- [ ] 写 `pagination.ts`：`PaginatedResponseSchema`（generic，用 `z.object({items, total, page, pageSize})`）。
- [ ] 改 `packages/contracts/src/index.ts`：追加 re-export 全部新 schema。
- [ ] **绿**：`pnpm --filter @codecrush/contracts test` 全绿。
- [ ] **绿**：`pnpm --filter @codecrush/contracts build` 成功（前端能 import）。
- [ ] 提交：`feat(contracts): add 11 new domain schemas for M2 skeleton`

**验证**：每个 schema 至少 1 正例 + 1 反例（必填缺失/枚举非法）。`pnpm lint` 0 违规（contracts 无平台依赖）。

---

## Story 3 — 后端 10 个 skeleton 模块

> 每模块 module/controller/service 三件套。controller 用 `createZodDto` + `@Body`，service 返回 mock/空态。无 Drizzle 表。

### 步骤

按依赖顺序（被依赖者先），可并行无依赖者：

- [ ] **红**：写 `test/skeleton.e2e.spec.ts` 框架——对每个新域端点写 supertest 断言（`GET /api/models` 200 + body 符合 schema、`POST /api/agents` 非法 body 400、`POST /api/chat` 返回 text/event-stream）。
- [ ] **models 模块**：`modules/models/{module,controller,service}.ts`。`GET /` → `[]`，`GET /:id` → mock 一个，`POST /` → 201，`POST /:id/test` → `{ok:true}`。
- [ ] **knowledge-bases 模块**：`GET /` → `[]`，`GET /:id` → mock，`POST /` → 201。
- [ ] **documents 模块**：`GET /?kbId=` → `[]`，`GET /:id` → mock，`POST /` → 202（上传桩）。
- [ ] **ingestion 模块**：路由挂在 documents 下——`POST /api/documents/:id/ingest` → 202，`GET /api/documents/:id/ingestion-status` → mock status。或在 ingestion controller 用 `@Controller('documents/:id/ingest')`。**决策**：放 ingestion 模块，controller 前缀 `documents/:id/ingest` + `documents/:id/ingestion-status`。
- [ ] **chunks 模块**：`GET /api/chunks/:docId` → `[]`，`PATCH /api/chunks/:id` → 200（启用/禁用桩）。
- [ ] **retrieval 模块**：`POST /api/retrieval/test` → `{hits:[]}` mock。
- [ ] **agents 模块**：`GET /` → `[]`，`GET /:id` → mock，`POST /` → 201，`PATCH /:id` → 200。
- [ ] **prompts 模块**：`GET /` → `[]`，`GET /:id` → mock，`GET /:id/versions` → `[]`，`POST /:id/versions` → 201。
- [ ] **chat 模块**：`POST /api/chat` → mock SSE 流。controller 用 `@Sse()` 或手动 `res.setHeader('Content-Type', 'text/event-stream')` + 定时 `res.write('data: ...\n\n')`。service 产假事件（token x3 → citation → done）。带 JWT（不 `@Public`）。
- [ ] **conversations 模块**：`GET /` → `[]`，`GET /:id` → mock，`GET /:id/messages` → `[]`。
- [ ] **改 `app.module.ts`**：imports 追加 10 个新模块。
- [ ] **绿**：`pnpm --filter @codecrush/backend test` 全绿（含 skeleton e2e）。
- [ ] **绿**：`curl /api/docs-json | jq '.paths | keys'` 含全部新域端点。
- [ ] 提交：`feat(backend): add 10 domain skeleton modules with mock endpoints`

**验证**：每端点返回符合契约 schema 的 mock/空态。chat SSE 事件可被 `ChatStreamEventSchema` parse。`pnpm lint` 0 违规（跨域只走 barrel，人工遵守 003 DAG）。

---

## Story 4 — 前端 app shell（布局 + 路由 + AuthGuard）

> 管理后台 shell + C 端问答 shell + 登录守卫 + 14 条路由。页面先用 `PagePlaceholder` 占位，下一 story 填真实内容。

### 步骤

- [ ] **红**：扩展 `apps/frontend/src/app/App.test.tsx`——断言侧栏 7 项菜单文案（快速开始/模型接入/知识库/Prompt 管理/Agent 管理/检索测试/Trace 追踪）、品牌字「CodeCrushBot」、未登录访问 `/admin` 重定向 `/login`。
- [ ] 写 `apps/frontend/src/app/AuthGuard.tsx`：检查 `localStorage.getItem('token')`，无则 `<Navigate to="/login" replace />`。
- [ ] 写 `apps/frontend/src/app/AdminLayout.tsx`：antd `Layout` + `Sider`（dark 主题，对齐原型 `ccb_app2.js:660`）+ `Menu` items 映射 NAV 7 项 + `Header`（用户信息/退出）+ `Content`（`<Outlet/>`）。Menu item key 映射路由。
- [ ] 写 `apps/frontend/src/app/ChatLayout.tsx`：三栏（会话列表 + 聊天 + 引用面板），先空壳。
- [ ] 写 `apps/frontend/src/components/PagePlaceholder.tsx`：通用占位（「{title} — 功能开发中，见 Mx」）。
- [ ] 改 `apps/frontend/src/app/App.tsx`：路由表扩展为 14 条（见 spec.md 路由表）。`/admin` 嵌套路由用 `<Route element={<AdminLayout/>}>` + `<Outlet/>`。所有 admin 子路由用 `React.lazy` 懒加载。先全部指向 `PagePlaceholder`。
- [ ] 删除 `apps/frontend/src/pages/HomePage.tsx`（功能并入 StartPage）。
- [ ] **绿**：`pnpm --filter @codecrush/frontend test` 通过（App shell 渲染 + 菜单断言）。
- [ ] 提交：`feat(frontend): add app shell with 14 routes, admin/chat layout, auth guard`

**验证**：`pnpm --filter @codecrush/frontend dev` → 浏览器访问 `/admin` 未登录跳 `/login`；侧栏 7 项可点击切换路由（页面显示占位）。

---

## Story 5 — 前端 13 个页面 + mock 数据

> 逐屏 1:1 还原原型布局。mock 数据从原型提取。按原型 adminPage 顺序实现。

### 步骤

按原型页面顺序（先有导航入口的）：

- [ ] **mock 数据**：写 `apps/frontend/src/mocks/`——从原型 `ccb_app2.js` 提取：`agents.ts`（AGENTS）、`kbs.ts`（KB_DOCS/KB_ROWS）、`traces.ts`（TRACES/NODES/SPANSETS）、`messages.ts`（CONVS/BASEMSGS/CITES）、`reports.ts`（REPORTS）、`prompts.ts`（PROMPT_BODIES）。每文件用 `z.infer<Schema>` 标注类型。
- [ ] **红**：扩展 `App.test.tsx`——至少 3 屏路由渲染断言（Traces 页有「Trace 追踪」标题且列表非空、Agents 页有 Agent 列表、Chat 页有三栏布局）。
- [ ] `pages/login/LoginPage.tsx`：真表单（email/password），调 `POST /api/auth/login`，成功存 token 跳 `/admin`。用 antd `Form`。
- [ ] `pages/chat/ChatPage.tsx`：三栏（会话列表 + 消息流 + 引用面板）。消息流用 mock BASEMSGS + 引用角标 `[n]` + 反馈 up/down + 转人工按钮。typing 流式用 `sse.ts` mock（下一 story）。
- [ ] `pages/admin/StartPage.tsx`：6 步快速开始引导（原型 `ccb_app2.js:663-669` startRaw），每步「去配置」按钮跳对应路由。
- [ ] `pages/admin/DashboardPage.tsx`：运行看板占位（stats/agentDist/hotQs 三块），用 mock 数据渲染，标题「运行看板」。
- [ ] `pages/admin/AgentsPage.tsx`：Agent 列表（mock AGENTS）+ 编辑抽屉壳（配置项：kbs/genModel/lightModel/rerankModel/prompt*/topK/topN/threshold，对齐 DF_DEFAULT）。
- [ ] `pages/admin/KnowledgeBasesPage.tsx`：KB 列表（mock KB_ROWS），点击进 `/admin/knowledge-bases/:kbId/documents`。
- [ ] `pages/admin/DocumentsPage.tsx`：文档列表（mock KB_DOCS）+ 上传按钮 + 生命周期状态 tag（已索引/解析中/排队中/解析失败）。
- [ ] `pages/admin/ChunksPage.tsx`：切片列表 + 启用/禁用开关（mock GENERIC_CHUNKS）。
- [ ] `pages/admin/RetrievalTestPage.tsx`：测试台壳（query 输入 + 阈值/multi/topK/topN 参数 + 结果表）。
- [ ] `pages/admin/PromptsPage.tsx`：Prompt 列表 + 版本管理抽屉壳 + diff 抽屉壳（4 节点 rewrite/intent/reply/fallback）。
- [ ] `pages/admin/EvalSetsPage.tsx`：评测集列表占位（「评测集与评测管理已在规划中，见 M11」）。
- [ ] `pages/admin/EvalsPage.tsx`：评测运行列表（mock REPORTS）+ 点击进 `/admin/evaluations/:reportId` 显示报告详情（metrics + cases）。
- [ ] `pages/admin/TracesPage.tsx`：Trace 列表（mock TRACES）+ 筛选（query/agent/status）。
- [ ] `pages/admin/TraceDetailPage.tsx`：span 树壳 + 瀑布图壳（mock NODES/SPANSETS）+ OTLP JSON 导出按钮。
- [ ] `pages/admin/ModelsPage.tsx`：模型列表 + 测试连接按钮 + 新接入抽屉（mock 模型数据）。
- [ ] 写 `apps/frontend/src/components/StatusTag.tsx`：状态 tag 组件（green/gold/gray/red，对齐原型 TAGS）。
- [ ] **绿**：`pnpm --filter @codecrush/frontend test` 全绿（含 3 屏路由渲染断言）。
- [ ] 提交：`feat(frontend): implement 13 pages with mock data from prototype`

**验证**：浏览器逐屏点开，布局与原型 1:1。`pnpm lint` 0 违规（frontend 不 import backend）。

---

## Story 6 — 前端 API client + SSE 骨架

> 通用 fetch 封装 + SSE 客户端骨架，接后端 chat mock 流。

### 步骤

- [ ] **红**：写 `apps/frontend/src/api/sse.test.ts`——喂 mock `ReadableStream`（模拟后端 `text/event-stream`），断言 `openChatStream()` 产出符合 `ChatStreamEventSchema` 的事件序列。
- [ ] 改 `apps/frontend/src/api/client.ts`：扩展为通用 `apiFetch(path, opts)`——自动注入 `Authorization: Bearer ${token}`（从 localStorage）+ 401 时 `window.location = '/login'`。保留 `getHealth()` 走 `/health`。
- [ ] 为每域加 typed client 函数：`getAgents()`、`getModels()` 等，用契约 schema `.parse()` 校验响应。M2 页面用 mock 不调这些，但为 M3+ 铺路。
- [ ] 写 `apps/frontend/src/api/sse.ts`：
  ```ts
  import type { ChatStreamEvent } from "@codecrush/contracts";
  import { ChatStreamEventSchema } from "@codecrush/contracts";

  export async function* openChatStream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamEvent> {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token")}` },
      body: JSON.stringify(req),
      signal,
    });
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6));
          yield ChatStreamEventSchema.parse(data);
        }
      }
    }
  }
  ```
  **注意 005 Revisit 1**：`EventSource` 不能带 Authorization 头，故用 `fetch + ReadableStream`（可带 header）。M8 解决 SSE 鉴权时复用此模式。
- [ ] 接 ChatPage：typing 流式用 `openChatStream()`（M2 接后端 mock 流，M8 接真编排）。
- [ ] **绿**：`pnpm --filter @codecrush/frontend test` 全绿（含 sse.test.ts）。
- [ ] 提交：`feat(frontend): add typed api client + sse skeleton consuming mock stream`

**验证**：启动后端 + 前端，ChatPage 发送消息 → 消费后端 mock SSE 流 → 显示假 token 流 + 引用。

---

## Story 7 — Vite proxy + 集成验证

> 收尾：proxy 扩展、全量测试、lint、build。

### 步骤

- [ ] 改 `apps/frontend/vite.config.ts`：proxy 追加 `/api` → `http://localhost:3000`。保留 `/health` proxy。SSE 经 `/api/chat` 走同一 proxy（vite 默认不缓冲流式）。
- [ ] **全量测试**：`pnpm test`（前端 + 后端 + 契约全绿）。
- [ ] **lint**：`pnpm lint`（0 boundary 违规）。
- [ ] **build**：`pnpm build`（turbo 全量构建成功）。
- [ ] **手动验收**（记录到 dev-ledger）：
  - `docker compose -f infra/docker-compose.yml --profile infra up -d --wait` + `pnpm --filter @codecrush/backend dev` + `pnpm --filter @codecrush/frontend dev`
  - 浏览器逐屏点开 15 屏，跳转通
  - 登录 → token 存 localStorage → 重定向 `/admin`
  - `curl http://localhost:3000/api/docs-json | jq '.paths | keys'` 含全部新域端点
  - ChatPage 发消息 → 消费 mock SSE 流
- [ ] 提交：`chore(m2): vite proxy + integration verification`

**验证**：全部 10 条 Acceptance Criteria 满足。

---

## Host 自查（代替 execution drill）

> 轻量对抗模式（CLAUDE.md）：跳过 peer execution drill，host 自查 plan 可执行性。

| 检查项 | 结果 |
|--------|------|
| 每个 story 有 TDD 红绿步骤？ | ✅ 每 story 先写测试再写实现 |
| 有 placeholder/TBD？ | ❌ 无。所有代码片段完整 |
| Story 间依赖清晰？ | ✅ 0→1→2→3（后端）+ 4→5→6（前端）+ 7（收尾）；2 在 3 之前（契约先）；1 在 3 之前（管道先于模块） |
| 破坏性变更有 story 覆盖？ | ✅ Story 1 处理 API 前缀 + M1 测试迁移 |
| 文档先改？ | ✅ Story 0 前置修订 003/006 |
| 验收标准全覆盖？ | ✅ AC 1-10 映射到 Story 4/5/6/7 |
| nestjs-zod API 用法准确？ | ⚠️ `nestjsZodOpenApi()`/`extendZodWithOpenApi` 具体 API 名需在 Story 1 实现时对照 readme 确认（plan 给了方向，非占位） |
| SSE 鉴权方案？ | ✅ 用 fetch+ReadableStream（可带 header），不用 EventSource（005 Revisit 1） |
| mock 数据量控制？ | ✅ Story 5 用 React.lazy 分包 |

**自查结论**：plan 可执行。唯一需实现时确认的点是 nestjs-zod 的 OpenAPI 具体 API 名（5.4.0 readme 为准），plan 已标注「参考 nestjs-zod readme」，非占位。
