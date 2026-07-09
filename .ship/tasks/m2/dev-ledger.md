# M2 Dev Ledger

Story 0: "修订 003/006 设计文档" — complete
  Commits: 8b6a435
  Files: docs/design/003-code-organization.md, docs/design/006-m2-app-shell-skeleton.md
  Produces: 003 OpenAPI tooling revised; 006 route table 14 routes, 15-screen table fixed
  Concerns: none

Story 1: "后端全局配置 + nestjs-zod 迁移 + M1 测试修复" — complete (peer reviewed)
  Commits: 9762985 (impl) + 8ed6a42 (review fixes)
  Peer review: PASS_WITH_CONCERNS — 0 P1 / 3 P2 (all fixed in 8ed6a42) / 4 P3 (accepted, inert-by-design)
  Deps added: nestjs-zod@5.4.0, @nestjs/swagger@11.4.5 (backend)
  Files:
    - apps/backend/src/app/app-bootstrap.ts (NEW: applyGlobalConfig + setupSwagger helpers)
    - apps/backend/src/main.ts (wire prefix + swagger)
    - apps/backend/src/app.module.ts (APP_PIPE ZodValidationPipe + APP_INTERCEPTOR ZodSerializerInterceptor)
    - apps/backend/src/modules/auth/auth.controller.ts (createZodDto, drop manual safeParse)
    - apps/backend/src/modules/users/users.controller.ts (createZodDto, drop manual safeParse)
    - apps/backend/src/modules/traces/traces.controller.ts (keep defensive TRACE_ID_RE; comment corrected — pipe skips non-ZodDto @Param, regex is the actual validation)
    - apps/backend/test/auth.e2e.spec.ts (APP_PIPE + applyGlobalConfig; paths → /api/*)
    - apps/backend/test/openapi.e2e.spec.ts (NEW: GET /api/docs-json paths assertions)
    - apps/backend/test/zod-pipe.e2e.spec.ts (NEW: ZodValidationPipe 400 shape)
    - apps/backend/scripts/verify-observability.mjs (paths → /api/*)
    - docs/design/005-user-auth.md, 006, README.md (path refs → /api/*)
  Produces: global /api prefix (health excluded); Swagger UI at /api/docs + JSON at /api/docs-json; ZodValidationPipe global; M1 controllers migrated to createZodDto
  Tests: 12 suites / 33 tests green; lint 0; build ok
  Breaking change: API prefix /auth/login→/api/auth/login, /users/me→/api/users/me, /traces/*→/api/traces/* (/health unchanged)
  Concerns: none

Story 2: "契约扩展（11 个 schema 文件）" — complete (no individual review — non-security; covered by final review)
  Commits: a811276
  Files (NEW):
    - packages/contracts/src/models.ts (ModelType/ModelProvider)
    - packages/contracts/src/knowledge-bases.ts (KnowledgeBase + status enum)
    - packages/contracts/src/documents.ts (Document + status/type enums)
    - packages/contracts/src/chunks.ts (Chunk)
    - packages/contracts/src/retrieval.ts (RetrievalTestRequest/Hit/Response)
    - packages/contracts/src/agents.ts (Agent + status enum)
    - packages/contracts/src/prompts.ts (Prompt + PromptVersion + node/status enums)
    - packages/contracts/src/chat.ts (ChatRequest + ChatStreamEvent discriminatedUnion: token/citation/done/error)
    - packages/contracts/src/conversations.ts (Conversation + Message + role enum)
    - packages/contracts/src/evalsets.ts (EvalSet)
    - packages/contracts/src/evals.ts (EvalRun + EvalMetric + EvalCaseResult)
    - packages/contracts/src/pagination.ts (PaginatedResponseSchema generic factory)
    - packages/contracts/src/index.ts (barrel: +12 re-exports)
    - packages/contracts/src/m2-schemas.test.ts (NEW: 31 tests, positive+negative+union+generic)
  Produces: 12 contract schema files; clean numeric/enum field types (prototype display strings → numbers/enums, mapped in Story 5); ChatStreamEvent as discriminatedUnion; generic PaginatedResponseSchema factory
  Tests: contracts 41 tests green (31 new); full repo 8/8 tasks green; lint 0; contracts build ok
  Design notes:
    - Schemas use clean API field names (docsCount/chunksCount/topK/threshold as numbers); Story 5 mock data will adapt prototype display strings ("86"/"3,412"/"0.20") to these.
    - Excluded UI-only fields (tag/color) from contracts — frontend maps status→color.
    - evals metrics/cases keep display strings (matches prototype REPORTS); M11 will refine.
  Concerns: none

Story 3: "后端 10 个 skeleton 模块" — complete (no individual review — non-security; covered by final review)
  Commits: 0fff948
  Contracts additions (request DTOs, 单一来源):
    - packages/contracts/src/models.ts (+CreateModelRequestSchema = omit id)
    - packages/contracts/src/knowledge-bases.ts (+CreateKnowledgeBaseRequestSchema = omit id/counts/status/updatedAt)
    - packages/contracts/src/documents.ts (+CreateDocumentRequestSchema, +IngestionStatusSchema)
    - packages/contracts/src/chunks.ts (+UpdateChunkEnabledRequestSchema)
    - packages/contracts/src/agents.ts (+CreateAgentRequestSchema omit id, +UpdateAgentRequestSchema = partial)
    - packages/contracts/src/prompts.ts (+PromptListResponseSchema, +PromptVersionListResponseSchema, +CreatePromptVersionRequestSchema omit id/promptId/version/status — 后端分配 version+status)
    - packages/contracts/src/m2-schemas.test.ts (+8 request-schema tests)
  Backend modules (NEW, each module/controller/service):
    - apps/backend/src/modules/models/        (GET / GET/:id POST / POST/:id/test)
    - apps/backend/src/modules/knowledge-bases/ (GET / GET/:id POST /)
    - apps/backend/src/modules/documents/      (GET /?kbId= GET/:id POST / →202)
    - apps/backend/src/modules/ingestion/      (@Controller("documents/:id"): POST /ingest→202, GET /ingestion-status)
    - apps/backend/src/modules/chunks/         (GET /:docId PATCH /:id toggle)
    - apps/backend/src/modules/retrieval/      (POST /test)
    - apps/backend/src/modules/agents/         (GET / GET/:id POST / PATCH /:id)
    - apps/backend/src/modules/prompts/        (GET / GET/:id GET/:id/versions POST /:id/versions)
    - apps/backend/src/modules/chat/           (POST / → text/event-stream mock; @Res 手写 SSE, SseResponse 结构类型避免 @types/express)
    - apps/backend/src/modules/conversations/  (GET / GET/:id GET/:id/messages)
  Modified:
    - apps/backend/src/app.module.ts (imports +10 modules)
    - eslint.config.mjs (+@typescript-eslint/no-unused-vars argsIgnorePattern "^_" for stub params; 放在 recommended 之后覆盖; 边界规则不动)
  Test (NEW): apps/backend/test/skeleton.e2e.spec.ts (24 tests: auth guard 401, 每域 GET/POST schema 合规, AC10 agents 非法 body→400, AC9 chat SSE 事件 ChatStreamEventSchema parse, AC4 OpenAPI paths 含全部新域端点)
  Produces: 10 域 skeleton 端点（mock/空态，JWT 保护，全局 ZodValidationPipe 生效）；OpenAPI /api/docs-json 含全部新域路径；chat mock SSE 流（token×N → citation → done）
  Tests: backend 13 suites / 60 tests green (24 new skeleton); contracts 49 tests green (8 new); full repo 8/8 tasks green; lint 0; build ok
  Design notes:
    - 请求 DTO 一律在 contracts（单一来源）；create schema 用 entity.omit({id, ...后端分配字段})
    - prompts create 版本：version/status 由后端分配（新建一律 draft），客户端只发 body/variables/note/author
    - chat SSE 用 @Res() 手写（非 @Sse()）：POST + 显式 header 控制，便于 e2e 断言；M8 改 AsyncGenerator
    - SseResponse 结构类型兼容 Express Response，避免引入 @types/express 依赖
    - ingestion 单独成模块（@Controller("documents/:id")）：异步管线关注点，M4 独立扩展
  Concerns:
    - zod-pipe.e2e.spec.ts 在并行全量跑时偶发 404（POST /api/auth/login 路由未就绪），单跑/ --runInBand 稳定通过。非本 story 引入（auth 未改动），疑似 NestJS TestingModule + supertest 在并行 worker 下的初始化竞态。若 CI 复现需单独排查（jest maxWorkers 或 beforeAll 路由就绪等待）。

Story 4: "前端 app shell（布局 + 路由 + AuthGuard）" — complete (no individual review — non-security; covered by final review)
  Commits: 46fffa4
  Files (NEW):
    - apps/frontend/src/app/AuthGuard.tsx (token 检查 → Navigate /login)
    - apps/frontend/src/app/AdminLayout.tsx (Layout + Sider dark 7 项导航 + Header 退出 + Outlet)
    - apps/frontend/src/app/ChatLayout.tsx (三栏空壳：会话列表/聊天/引用)
    - apps/frontend/src/components/PagePlaceholder.tsx (通用占位)
  Modified:
    - apps/frontend/src/app/App.tsx (14 admin 嵌套路由 + /login + /chat + 通配重定向；子路由全指 PagePlaceholder)
    - apps/frontend/src/app/App.test.tsx (3 tests: /admin 未登录重定向、认证后侧栏 7 项+品牌、/chat AuthGuard)
    - apps/frontend/src/test/setup.ts (+matchMedia + ResizeObserver mock for antd 6 jsdom)
  Deleted:
    - apps/frontend/src/pages/HomePage.tsx (功能并入 StartPage，Story 5 实现)
  Produces: 前端 14 路由骨架可点开跳转；AuthGuard 保护 /admin + /chat；AdminLayout 侧栏 7 项（快速开始/模型接入/知识库/Prompt 管理/Agent 管理/检索测试/Trace 追踪）；ChatLayout 三栏壳；PagePlaceholder 占位待 Story 5 填充
  Tests: frontend 3/3 green; 全量 8/8 tasks green (backend 60 / contracts 49); lint 0; build ok (185KB gzip)
  Design notes:
    - admin 子路由暂用 PagePlaceholder 直接渲染（未 React.lazy）——占位页无分包价值，Story 5 引入真实页面时改 lazy
    - 菜单 selectedKeys 用前缀匹配高亮父级（kb/prompts/traces 子路由高亮顶级项）；dashboard/evalsets/evaluations 不在侧栏
    - 认证测试用 /admin/dashboard 渲染以避免页面标题与菜单文案重复匹配
    - matchMedia/ResizeObserver mock 消除 antd 6 在 jsdom 的 act 警告
    - 未加菜单图标（@ant-design/icons 已装但 Story 4 未要求；Story 5 视觉打磨再加）
  Concerns: none

Story 5: "前端 13 个页面 + mock 数据" — complete (no individual review — non-security; covered by final review)
  Commits: ee761e1
  Files (NEW mocks, 9 个, z.infer 类型标注):
    - apps/frontend/src/mocks/agents.ts (MOCK_AGENTS 3 条)
    - apps/frontend/src/mocks/knowledge-bases.ts (MOCK_KNOWLEDGE_BASES 3 + MOCK_DOCUMENTS 3 + MOCK_CHUNKS 3)
    - apps/frontend/src/mocks/models.ts (MOCK_MODELS 4：llm/embedding/rerank)
    - apps/frontend/src/mocks/prompts.ts (MOCK_PROMPTS 4 节点 + MOCK_PROMPT_VERSIONS 3 版本)
    - apps/frontend/src/mocks/conversations.ts (MOCK_CONVERSATIONS 3 + MOCK_CITATIONS 2 + MOCK_MESSAGES 2)
    - apps/frontend/src/mocks/traces.ts (本地 TraceListItem 接口 + MOCK_TRACES 3 + MOCK_TRACE_DETAIL 5 span + MOCK_TRACE_NODES)
    - apps/frontend/src/mocks/evals.ts (MOCK_EVAL_SETS 2 + MOCK_EVAL_RUNS 2 含 metrics/cases)
    - apps/frontend/src/mocks/dashboard.ts (本地 DashboardStats/AgentDistribution + MOCK_DASHBOARD + MOCK_AGENT_DIST)
    - apps/frontend/src/mocks/retrieval.ts (MOCK_RETRIEVAL_HITS 3)
  Files (NEW components):
    - apps/frontend/src/components/StatusTag.tsx (状态枚举→antd Tag color/中文文案映射)
  Files (NEW pages, 15 个, 默认导出供 React.lazy):
    - apps/frontend/src/pages/login/LoginPage.tsx (真表单 + POST /api/auth/login + LoginResponseSchema.parse + 存 token 跳 /admin)
    - apps/frontend/src/pages/chat/ChatPage.tsx (三栏 ChatLayout slot 注入 mock 会话/消息/引用)
    - apps/frontend/src/pages/admin/StartPage.tsx (6 步快速开始引导)
    - apps/frontend/src/pages/admin/DashboardPage.tsx (Statistic + 热门问题表 + Agent 分布表)
    - apps/frontend/src/pages/admin/AgentsPage.tsx (列表 + 编辑 Drawer 壳)
    - apps/frontend/src/pages/admin/KnowledgeBasesPage.tsx (KB 列表 + 跳文档页)
    - apps/frontend/src/pages/admin/DocumentsPage.tsx (文档列表 + 上传 + 生命周期 StatusTag)
    - apps/frontend/src/pages/admin/ChunksPage.tsx (切片列表 + 启用/禁用 Switch 本地态)
    - apps/frontend/src/pages/admin/RetrievalTestPage.tsx (测试台：query+参数+结果表，mock 命中)
    - apps/frontend/src/pages/admin/PromptsPage.tsx (4 节点列表 + 版本管理 Drawer)
    - apps/frontend/src/pages/admin/EvalSetsPage.tsx (评测集列表占位)
    - apps/frontend/src/pages/admin/EvalsPage.tsx (运行列表 + :reportId 报告详情子视图)
    - apps/frontend/src/pages/admin/TracesPage.tsx (列表 + query/agent/status 筛选)
    - apps/frontend/src/pages/admin/TraceDetailPage.tsx (span 树 + 瀑布图 + OTLP JSON 导出)
    - apps/frontend/src/pages/admin/ModelsPage.tsx (模型列表 + 测试连接 + 新接入 Drawer)
  Modified:
    - apps/frontend/src/app/App.tsx (React.lazy + Suspense 包裹；14 admin 路由 + /chat 全指真实页面；/chat 改 ChatPage)
    - apps/frontend/src/app/App.test.tsx (7 tests：未登录重定向、侧栏 7 项、Traces/Agents/Chat 三屏路由渲染、/chat 守卫、登录提交存 token)
    - apps/frontend/src/app/ChatLayout.tsx (重构为 slot 模式：conversations/messages/citations ReactNode props)
    - apps/frontend/src/pages/admin/AgentsPage.tsx (修 TableProps 导入：antd 而非 contracts)
  Deleted:
    - apps/frontend/src/pages/LoginPage.tsx (旧占位，迁至 pages/login/LoginPage.tsx 真表单)
  Produces: 15 屏真实页面 + 9 个 mock 文件；React.lazy 分包（每页独立 chunk，build 产物可见）；登录走契约校验存 token；ChatLayout slot 化供 ChatPage 注入
  Tests: frontend 7/7 green；全量 8/8 tasks green (backend 60 / contracts 49 / frontend 7)；lint 0；build ok (index 156KB gzip 51KB，每页独立 chunk)
  Design notes:
    - mock 数据用 z.infer<Schema> 标注，形状由契约保证；原型显示字符串（"86"/"3,412"）已映射为契约的 number/enum
    - Trace 列表项无契约 schema（M9 读模型未定）：mocks/traces.ts 本地定义 TraceListItem 接口，M9 落 contracts
    - ChatLayout 重构为 slot 模式（接受 ReactNode），ChatPage 注入 mock 内容；M8 接 SSE 时 messages slot 改流式
    - LoginPage 用 LoginResponseSchema.parse 校验响应 + inline error state（避免 antd message 静态方法）；表单初值 demo@codecrush.bot/demo12345
    - EvalsPage 同组件处理列表 + :reportId 详情（useParams 分支）
    - TraceDetailPage 瀑布图用 div 比例条（startTime 偏移 + durationMs 占比），OTLP JSON 导出用 Blob+URL.createObjectURL
    - 测试文案冲突规避：Traces 页断言独有查询「这款产品支持防水吗」避开菜单「Trace 追踪」；Agents 页断言「售后客服 Agent」避开卡片标题「Agent 管理」
    - 登录提交测试：jsdom 不在点击 submit 时触发 form submit（已知限制），用 fireEvent.submit(form)；mock user.id 须为合法 UUID（UserProfileSchema.id 是 z.string().uuid()）
  Concerns:
    - antd 6 deprecation 警告：Drawer `width`（建议 size）与 List 组件（下个大版本移除）。非阻塞，M3+ 视觉打磨时替换 List 为自定义列表、Drawer 改 size。
    - TraceDetailPage 的 detail 直接用 MOCK_TRACE_DETAIL（按 traceId 取真实读模型留 M9）；当前所有 traceId 都映射到同一条 mock 详情。

Story 5 Review follow-up — complete
  Scope: `git diff 46fffa4..HEAD`（Story 5 impl ee761e1 + docs SHA）
  Peer review report: .ship/tasks/m2/review.md
  Findings: 0 P1 / 0 P2 / 1 P3 (Story 5 范围内) + 1 P3 (测试运行暴露的 Story 4 遗留)
  Fixes:
    - P3-1 登录测试未断言导航落点（App.test.tsx:88-119）：补 findByText("CodeCrushBot")，commit f15e895
    - P3-2 StartPage 链接列表重复 key（StartPage.tsx:24，步骤 2/3 同 to）：改 key={s.title}，commit 349a2b4
  Tests: frontend 7/7 green（修复后），重复 key 警告消失；剩余 stderr 均为 antd 6 弃用警告（非本任务范围）
  Open Questions（M9 收口，非阻塞）：TraceDetailPage 瀑布图分母用 max(durationMs) 而非 maxEnd-rootStart；buildDepth 无环保护；spans[0] 假定为最早。M9 接真实读模型前修。

Story 6: "前端 API client + SSE 骨架" — complete (no individual review — non-security; covered by final review)
  Commits: 69bc1c7
  Files (NEW):
    - apps/frontend/src/api/sse.ts (openChatStream: fetch + ReadableStream async generator，按 \n\n 切帧，仅解析 data: 行；非 EventSource 因需带 Authorization)
    - apps/frontend/src/api/sse.test.ts (7 tests: 跨 chunk 拼接 / token 序列 / Authorization 头 / 无 token / 非 2xx 抛错 / 跳过注释与 event 字段 / AbortSignal 透传 / 非法 payload Zod 拒绝)
    - apps/frontend/src/pages/chat/ChatPage.test.tsx (2 tests: 流式渲染 token+citation+输入框清空 / 流失败显示 error)
  Files (MODIFIED):
    - apps/frontend/src/api/client.ts (apiFetch: Bearer token 自动注入 + 401 清 token 跳 /login；getJson/postJson + Zod 校验；9 域 13 个 typed client 函数：agents/models/knowledge-bases/documents/ingestion/chunks/conversations/prompts/retrieval；getHealth 保留 /health 不带鉴权)
    - apps/frontend/src/pages/chat/ChatPage.tsx (接 openChatStream：发送 → token 累积渲染 + citation 流式入右栏 + done 写 traceId/confidence；Enter 发送 / Shift+Enter 换行；卸载 abort)
  Contracts additions (单一来源，前端不直接 import zod):
    - packages/contracts/src/documents.ts (+DocumentListResponseSchema)
    - packages/contracts/src/chunks.ts (+ChunkListResponseSchema)
    - packages/contracts/src/conversations.ts (+MessageListResponseSchema)
    - packages/contracts/src/m2-schemas.test.ts (+3 list schema 正反例测试)
  Produces: 通用 apiFetch 封装（鉴权 + 401 重定向）+ 9 域 typed client（M3+ 调用，M2 页面仍用 mock）+ openChatStream async generator（消费后端 mock SSE 流，ChatPage 发送消息即流式渲染 token/citation/done）
  Tests: frontend 16/16 green（+9 新增：7 sse + 2 ChatPage）；contracts 52/52 green（+3）；全量 8/8 tasks green；lint 0；build ok
  Design notes:
    - 前端不直接 import zod（AGENTS.md 边界：前端只 import contracts + otel-conventions）。client.ts 用本地 ZodSchema<T> 接口（结构兼容 zod schema 的 .parse），避免引入 zod 依赖。documents/chunks/messages 之前无 ListResponseSchema——在 contracts 补齐（与其它域一致），前端直接用现成 schema 而非 z.array()。
    - sse.ts 按 SSE 规范解析：帧以 \n\n 分隔，一帧内多行 data: 用 \n 拼接为 payload；忽略注释行（: keep-alive）与 event:/retry: 等字段。后端 mock 流末尾可能无 \n\n，flush 残留 buf。
    - ChatPage 卸载时 abort 进行中的流（useEffect cleanup + AbortController ref），避免 setState on unmounted。
    - typed client 不含 evalsets/evals（后端无 skeleton，M11 才有）；不含 chat（SSE 在 sse.ts 单独处理）。
    - antd 6 Button 给中文加字间距（"发 送"），ChatPage.test 用 /发\s*送/ regex 兼容。
  Concerns:
    - typed client 函数 M2 未被任何页面调用（页面用 mock），仅 sse 被 ChatPage 调用。M3+ 接真实后端时首次验证路径与 schema 形状。
    - ChatPage 流式渲染每 token setState（10 次/mock 流），M8 真实编排 token 多时考虑批量或 requestAnimationFrame（非 M2 范围）。

Story 7: "Vite proxy + 集成验证" — complete (no individual review — non-security; covered by final review)
  Commits: 0f1c6ff
  Files (MODIFIED):
    - apps/frontend/vite.config.ts (proxy 追加 /api → :3000；resolve.alias 将 @codecrush/contracts 指向 packages/contracts/src/index.ts——修 dev 下 CJS barrel 命名导出失败：Vite dev 直接服务 dist/index.js 的 __exportStar CJS，浏览器原生 ESM 报 "does not provide an export named 'LoginResponseSchema/ChatRequestSchema'"，导致 LoginPage/ChatPage 白屏。alias 到源码后 Vite 逐文件编译 ESM TS，命名导出可见；backend 仍消费 dist)
    - apps/frontend/src/pages/login/LoginPage.tsx (initialValues demo@codecrush.bot/demo12345 → demo@codecrush.local/CodeCrushDemo123!——对齐 backend seed.ts，原默认凭据登录 401)
    - apps/frontend/src/pages/admin/AgentsPage.tsx (Drawer width→size；Space direction→orientation)
    - apps/frontend/src/pages/admin/DocumentsPage.tsx (Space direction→orientation)
    - apps/frontend/src/pages/admin/ModelsPage.tsx (Drawer width→size)
    - apps/frontend/src/pages/admin/PromptsPage.tsx (Drawer width→size；Space direction→orientation)
    - apps/frontend/src/pages/admin/StartPage.tsx (Steps direction→orientation；items.description→content)
    - apps/frontend/src/pages/chat/ChatPage.tsx (antd List 弃用→原生 ul/li 渲染会话列表与引用列表)
    - .ship/tasks/m2/qa/qa-script.mjs (chromium.launch({channel:"chrome"}) 避免上海网络拉 playwright CDN)
  Files (NEW):
    - .ship/tasks/m2/qa/login-check.mjs (AC2 端到端 login 浏览器验证：未登录重定向 + 表单渲染 + 提交凭据 → 存 token → 跳 /admin)
    - .ship/tasks/m2/handoff-story7.md (Story 7 上下文交接文档)
  Produces: Vite proxy /api 转发后端（SSE 直通无缓冲）；contracts CJS interop 修复（dev 下 LoginPage/ChatPage 可用）；antd 6 弃用 API 全部迁移（QA 0 console error）；LoginPage 默认凭据对齐后端 seed
  Tests: 全量 8/8 tasks green (frontend 16 / backend 60 / contracts 52)；lint 0；build ok
  Manual acceptance (10 AC 全验证):
    - AC1 15 屏渲染：QA 18/18 passed（Playwright 逐屏点开 + console 错误检查，0 issue）
    - AC2 login → token → /admin：login-check.mjs 浏览器端到端通过（redirectUrl=/login, emailInputRendered=1, afterLoginUrl=/admin, tokenStored=JWT, brandRendered=1）
    - AC3 未登录重定向：QA + login-check 双重验证
    - AC4 OpenAPI：curl :5173/api/docs-json（经 proxy）返回 27 paths，含全部新域端点（agents/models/knowledge-bases/documents/chunks/retrieval/prompts/chat/conversations）
    - AC5 lint 0 boundary 违规
    - AC6 test 全绿
    - AC7 Sider 7 项导航：QA 点击「模型接入」→ /admin/models
    - AC8 Chat 三栏：QA 验证会话列表/聊天/引用三栏渲染
    - AC9 SSE 端到端：curl :5173/api/chat（经 proxy，Bearer JWT）返回 token×10 → citation → done 事件流，无缓冲
    - AC10 Zod 管道 400：backend e2e zod-pipe.e2e.spec.ts + skeleton.e2e.spec.ts（Story 3 已覆盖）
  Design notes:
    - contracts CJS interop 选 resolve.alias（指向源码）而非 optimizeDeps.include：前者 dev/build/test 一致消费 ESM 源码，HMR 对 contracts 改动即时生效；后者仅 dev 预打包转换，build 仍走 rollup CJS 互操作（虽能工作但两套路径）。backend 不受影响（NestJS CJS 互作正常）。
    - antd 6 Drawer size prop 接受 number|string|sizeType（Drawer.d.ts:17），width→size={480} 合法保留自定义宽度。Steps/Space orientation 为 'horizontal'|'vertical' 枚举。List 弃用改原生 ul/li（M3+ 视觉打磨可换 Table/自定义列表）。
    - LoginPage 默认凭据对齐 seed.ts 默认值（demo@codecrush.local / CodeCrushDemo123!，见 .env.example DEMO_USER_PASSWORD）。
  Concerns:
    - /favicon.ico 返回 404（项目无 favicon，浏览器自动请求，非 AC、非阻塞）。M3+ 视觉打磨可补。
    - typed client（getAgents 等）M2 仍无页面调用（M3+ 接真后端首次验证）。
    - 工作树中部分修复（antd 弃用迁移、vite alias、qa-script chrome channel）为本会话期间并行出现并经我核验一致后纳入 Story 7 提交（test/lint/build/QA 全绿）。

Final review (轻量对抗档收尾，覆盖全量 diff):
  Artifacts: .ship/tasks/m2/review.md
  Verdict: DONE — 0 P1 / 0 P2 / 4 P3（全部已修复）
  Findings + fixes:
    - P3-1 prompts.service.ts:82 版本号 length+1 → reduce max+1（防倒退/撞号）
    - P3-2 knowledge-bases.ts omit 漏 progress → 加 progress:true；m2-schemas.test.ts:274 加强断言锁定 strip
    - P3-3 PagePlaceholder.tsx 死代码 → 删除
    - P3-4 006 文档 OpenAPI 路径漂移（line 40 /api/openapi.json、line 301 curl /api/docs）→ /api/docs-json
  Gates: lint 0 / test 8/8 (backend 60 + frontend 16 + contracts 52) / build 5/5
  M2 收尾完成，可交付。
