# M2 Diff Report — host spec vs peer spec

> Phase 4 产出。逐项对比 `spec.md`（host）与 `peer-spec.md`（peer），用代码证据裁决。
> 裁决类型：`patched`（host 据证据更新）/ `proven-false`（peer 论断错）/ `conceded`（peer 说服 host）/ `escalated`（需用户裁决）。

## 裁决总览

| # | 分歧 | 裁决 | 依据 |
|---|------|------|------|
| 1 | start 与 dashboard 是否合并 | **conceded** | 原型代码 `adminPage === 'start'` 与 `=== 'dashboard'` 是两个独立分支 |
| 2 | 评测页 1 个占位 vs 2 个独立页 | **conceded** | 原型 `evalsets`/`evals` 是独立 adminPage 值 |
| 3 | chat 端点 501 vs mock SSE 流 | **conceded** | mock 流可让 SSE 骨架端到端验证，更贴合验收标准 |
| 4 | OpenAPI 文档先改 vs 后改 003 | **conceded** | AGENTS.md「改架构先改文档」 |
| 5 | API 前缀 exclude 写法 | **patched** | peer 更精确，host 补 exclude 语法 |
| 6 | 后端跨域 barrel-only lint 缺失 | **patched** | `eslint.config.mjs` 确认无后端跨域规则 |
| 7 | nestjs-zod 迁移影响 M1 测试 | **patched** | `traces.controller.spec.ts:47-55` 直调方法断言 throw，迁管道后失效 |
| 8 | mock 数据懒加载 | **patched** | peer 给出具体方案（路由级 dynamic import） |
| 9 | 后端端点 REST 面更丰富 | **patched** | peer 的 `GET /:id`、`PATCH`、子资源路由更贴合原型 |
| 10 | contracts 拆 evalsets/evals | **patched** | 随 #2 一致 |

无 `escalated` 项。

---

## 1. start 与 dashboard 是否合并

- **host spec**：`/admin` index → `DashboardPage`（合并快速开始 + 运行看板，对应 006 路由表 line 192）。
- **peer spec**：`/admin/start` 与 `/admin/dashboard` 两个独立路由（peer-spec.md:131,141-142）。
- **代码证据**：`/tmp/ccb_app2.js`（从原型 `<script type="__bundler/template">` 解码后的 app JS，78727 字符）：
  - L1008: `pgStart: S.adminPage === 'start',`
  - L1010: `pgDash: S.adminPage === 'dashboard',`
  - L257-265 `NAV` 数组只含 `start`（label「快速开始」），**不含 `dashboard`**——dashboard 从 start 页或首页入口进入，不在侧栏。
  - state 初值 `adminPage: 'start'`（L5）。
- **结论**：原型 `start`（快速开始 6 步引导）与 `dashboard`（运行看板：stats/agentDist/hotQs）是**两个独立页面**。006 arch-design 的 15 屏表（006:102）把两者合并为「控制台」是**事实性错误**。
- **裁决**：**conceded**。host spec 更新为两个独立路由 `/admin/start`（index）+ `/admin/dashboard`。006 arch-design 需同步修订（见 #4）。

## 2. 评测页 1 个占位 vs 2 个独立页

- **host spec**：单个 `EvaluationPage.tsx` 占位（3 屏合一，spec.md:142；006:170,199）。
- **peer spec**：`EvalSetsPage.tsx` + `EvalsPage.tsx` 两个独立页（peer-spec.md:149-150）。
- **代码证据**：`/tmp/ccb_app2.js`：
  - L1011: `pgEvalsets: S.adminPage === 'evalsets', pgEvals: S.adminPage === 'evals',`
  - L1120: `evalListView: !S.reportId, evalReportView: !!S.reportId`——评测报告是 `evals` 页的子视图（由 `reportId` state 切换），**不是独立 adminPage**。
  - 无 `evalreport` adminPage 值（全量搜索确认）。
- **结论**：原型有 `evalsets`（评测集列表）和 `evals`（评测运行列表 + 报告详情子视图）两个独立页。006 把「评测报告」列为独立 adminPage `evalreport`（006:111）是**事实性错误**。
- **裁决**：**conceded**。host spec 拆为 `/admin/evalsets` + `/admin/evaluations`（含 `:reportId` 子路由显示报告）。006 同步修订。

## 3. chat 端点 501 vs mock SSE 流

- **host spec**：`POST /api/chat` → 501（spec.md:103；006:224）。
- **peer spec**：返回 mock `text/event-stream` 事件流（peer-spec.md:123,190）。
- **代码证据**：无代码（设计决策）。但 peer 的验收标准 6（peer-spec.md:162）「SSE 客户端骨架可消费 chat 桩端点的 mock 事件流，按 `ChatStreamEventSchema` parse」——这要求后端有可消费的流，501 无法满足。
- **结论**：mock 事件流让 `api/sse.ts` 骨架在 M2 即可端到端验证（前端 fetch → 后端 mock 流 → 按 schema parse），仍是「骨架」（无真实 RAG 编排），不越界 M8。
- **裁决**：**conceded**。host spec 更新 `POST /api/chat` 返回 mock SSE 流（定时 flush 假 token/citation/done 事件）。

## 4. OpenAPI 文档先改 vs 后改 003

- **host spec**：Risk 4「后续同步修订 003 文档」（spec.md:185）。
- **peer spec**：Risk 1「需先改文档」，引 AGENTS.md「改架构先改文档」（peer-spec.md:186）。
- **代码证据**：`AGENTS.md`（always_applied_workspace_rules）首段：「改架构/顺序/约定，先改对应文档，再改代码」。`003-code-organization.md:143` 写「OpenAPI 由 zod-to-openapi 生成」，与 M2 决策（用 nestjs-zod 自带 swagger 集成）冲突。
- **结论**：peer 正确。003 必须在实现前修订。
- **裁决**：**conceded**。host spec 更新：003 修订（OpenAPI 工具链改为 nestjs-zod 自带）作为**前置 story**。同时 006 arch-design 的路由表与 15 屏表（#1、#2 的事实错误）也需同步修订。

## 5. API 前缀 exclude 写法

- **host spec**：`setGlobalPrefix("api")`，`/health` 除外（spec.md:83）。
- **peer spec**：`setGlobalPrefix("api", { exclude: ["health"] })`（peer-spec.md:110）。
- **代码证据**：NestJS `setGlobalPrefix` 第二参数支持 `exclude: string[]`。
- **裁决**：**patched**。host spec 补 explicit exclude 语法。意图一致，仅精度差异。

## 6. 后端跨域 barrel-only lint 缺失

- **host spec**：未提及。
- **peer spec**：Risk 3 指出 `eslint.config.mjs` 无后端跨域 barrel-only 规则（`003:137-139` 要求但未落地），建议 M2 人工遵守 + 单列后续任务（peer-spec.md:188）。
- **代码证据**：`eslint.config.mjs` 全文 113 行，只有 4 条 boundary 规则：frontend（:19-38）、contracts（:41-58）、otel-conventions（:61-85）、otel（:88-111）。**无后端跨域规则**。
- **裁决**：**patched**。host spec Risks 追加：M2 靠人工遵守 003 DAG，barrel-only lint 规则单列后续任务（scope 外）。

## 7. nestjs-zod 迁移影响 M1 测试

- **host spec**：未提及（只说「现有 controller 去掉手写 safeParse」）。
- **peer spec**：Risk 7 指出替换 safeParse 后错误响应形状可能变，M1 e2e 可能断言 `parsed.error.issues`（peer-spec.md:192）。
- **代码证据**：
  - `apps/backend/test/traces.controller.spec.ts:47-55`：**直调** `ctrl.getTrace("not-a-hex-id")` 断言 `rejects.toBeInstanceOf(BadRequestException)`。这是单元测试，校验逻辑在 controller 方法内（手动 `safeParse`）。若迁到全局 `ZodValidationPipe`，pipe 在 HTTP 层拦截，**controller 方法不再 throw**——此测试会失效，需改为 e2e（supertest）验证 400。
  - `apps/backend/test/auth.e2e.spec.ts:83`：`post("/auth/login").send({ email: "nope" }).expect(400)`——只断言状态码，**不断言 error.issues 形状**。pipe 迁移安全。
  - `auth.e2e.spec.ts:83,97`：路径 `/auth/login`、`/users/me`——`setGlobalPrefix("api")` 后需改 `/api/auth/login`、`/api/users/me`（#5 破坏面）。
- **结论**：peer 正确但具体风险点不同——不是 error.issues 形状（测试没断言），而是 `traces.controller.spec.ts` 的**单元测试模式**（直调方法断言 throw）在 pipe 迁移后失效。
- **裁决**：**patched**。host spec Risks 追加：`traces.controller.spec.ts:47-55` 需重写为 e2e（或保留 controller 内的防御性校验 + 加 pipe 双保险）。按 AGENTS.md「不要软化测试断言」——改测试模式而非弱化断言。

## 8. mock 数据懒加载

- **host spec**：Risk 3「可先提取结构代表性的子集」（spec.md:184）。
- **peer spec**：Risk 4 建议路由级 dynamic import 分包（peer-spec.md:189）。
- **裁决**：**patched**。host spec 补：mock 数据按路由 lazy import（`React.lazy` + vite 天然 code splitting），避免 50KB 中文 mock 全打进主包。

## 9. 后端端点 REST 面更丰富

- **host spec**：10 模块表，每模块 2-3 端点（spec.md:93-104）。
- **peer spec**：更丰富——`GET /:id`、`PATCH /:id`、子资源路由（`GET /api/knowledge-bases/:id`、`GET /api/documents/:id`、`POST /api/documents/:id/ingest`、`GET /api/documents/:id/ingestion-status`、`PATCH /api/chunks/:id`、`GET /api/prompts/:id/versions`、`POST /api/prompts/:id/versions`）（peer-spec.md:114-123）。
- **代码证据**：无代码（skeleton 设计）。peer 的 REST 面更贴合原型 mock 数据形状（如 `REPORTS` 按 id 查、`SPANSETS` 按 traceId 查、chunks 按 docId 查）。
- **裁决**：**patched**。host spec 端点表扩展，对齐 peer 的 REST 面。仍是 skeleton（返回 mock/空态），不增逻辑。

## 10. contracts 拆 evalsets/evals

- **host spec**：10 文件，无独立 evalsets/evals（spec.md:108-119）。
- **peer spec**：11 文件，独立 `evalsets.ts` + `evals.ts`（peer-spec.md:102-103）。
- **裁决**：**patched**。随 #2 一致，拆为两个文件。

---

## 对 006 arch-design 的影响

#1、#2、#4 揭示 006 有**事实性错误**（关于原型）与**流程违规**（未先改 003）：

1. **006:102** 15 屏表第 3 行「控制台」合并了 `start`+`dashboard`——原型是两屏。
2. **006:111** 列 `evalreport` 为独立 adminPage——原型无此值，评测报告是 `evals` 的子视图。
3. **006:199** 路由表 `/admin/evaluations` 单页——应拆 `/admin/evalsets` + `/admin/evaluations`。
4. **006:144,254」** 说「zod-to-openapi」——应改为 nestjs-zod 自带 swagger 集成，且 003 需先改。

**处理**：按 AGENTS.md「先改文档再改代码」，M2 第一个 story 修订 003 + 006，再开始实现。spec.md 已据此更新。

## 结论

零 `escalated`。10 项分歧全部用代码证据裁决（3 conceded + 6 patched + 1 conceded，其中 #4 同时触发 006 修订）。spec.md 已据此更新。
