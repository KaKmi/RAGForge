# Spec — M7 Agent 配置与管理

Branch: `feat/m7-agent-config` · HEAD: `72f7ab443dce67686664b948aa37de5252eb2ecd`
Upstream design: `docs/design/008-m7-agent-management.md`（已定稿，4 项分歧点已用户拍板）

## Problem / Motivation

`apps/backend/src/modules/agents/` 当前是 M2 内存 mock（`MOCK_AGENTS` 数组，`agents.service.ts:1-53`），无 schema、无持久化、无版本化、无 Eval 门槛。`apps/frontend/src/pages/admin/AgentsPage.tsx` 同样是纯本地 state（`mocks/agents.ts` 数据），未接后端，且用手写 div 而非 antd。M7 要把这一整块换成真实实现，落地 008 设计文档的三表模型（`agents`/`agent_config_versions`/`agent_config_version_kbs`）与四项拍板决策。

## Design Approach

复刻 M6 `prompts` 模块已验证的「版本 + `promote()` 单一入口」范式（`prompts.service.ts`），三处关键差异：

1. Agent 有**三张表**而非两张——知识库绑定要素被拆到独立的 `agent_config_version_kbs`（多对多，随版本走），而不是像 prompt 那样版本表本身承载所有字段。
2. Eval 门槛是 agents 独有的新状态机分支（prompts 没有），`publish`/`rollback` 前必须校验 `eval_status ∈ {passed, exempt}`。
3. 首个版本（v1）**创建即发布**（`status='published'`, `eval_status='exempt'`），不像 prompt 的 v1 默认是 draft——因为 008 文档 §Status 决策 4：v1 豁免 Eval，Agent 建好就该立刻可服务。

## Investigation Findings

### 版本化范式源（完整复刻对象）

- `apps/backend/src/modules/prompts/schema.ts:6-46` — `prompts`(currentVersionId 可空 FK 到 `prompt_versions`) + `prompt_versions`(unique(promptId,version) + index(promptId,status))。**Agent 的三表设计直接沿用这个双表核心 + 新增第三张 `agent_config_version_kbs`**。
- `apps/backend/src/modules/prompts/prompts.repository.ts:123-153` — `publishVersion()` 事务：archive 旧 prod → set 新 prod → 回写父表 `currentVersionId`。**`agents.repository.ts` 的 `promote()` 要复刻这个三步事务**，额外多一步（无，因为 kb 快照是版本级只读，不需要在 promote 时改）。
- `apps/backend/src/modules/prompts/prompts.service.ts:69-90` — `createVersion()` 的 `max+1 + unique 撞号重试（attempt<2）`模式。**`agent_config_versions` 的 version 号生成直接复刻**。
- `apps/backend/src/modules/prompts/prompts.service.ts:94-105` — `promote()` 校验：版本不存在或不属于该 prompt → 404；已是 prod → 409。**Agent 的 publish/rollback 要多一条 Eval 门槛校验**（008 Invariant 2），其余校验逻辑相同。
- `apps/backend/src/modules/prompts/prompts.controller.ts:56-75` — publish 和 rollback 两个路由委托同一个 `service.promote()`。**Agent 端点复刻同一模式**。

### 强约束双重防线源

- `packages/contracts/src/knowledge-bases.ts:36-44` — `UpdateKnowledgeBaseRequestSchema` 用 `z.strictObject`故意不含 `embeddingModelId`，注释明确写"strictObject 直接拒绝未知键...service 层的显式 400 检查保留作为纵深防御"。
- `apps/backend/src/modules/knowledge-bases/knowledge-bases.service.ts:85-89` — service 层再显式检查一次 `req.embeddingModelId !== undefined → 400`。**`UpdateAgentRequestSchema` 要同样改成 `z.strictObject({name,desc,enabled})`，`agents.service.ts:update()` 要有同等的显式防御检查**。
- `apps/backend/src/modules/knowledge-bases/knowledge-bases.service.ts:62-69` — `create()` 里校验引用的 `embeddingModelId` 必须 `type==='embedding' && enabled`，模式是 `this.models.get(id)` 拿到行后手动判 `type`/`enabled`，不满足抛 `BadRequestException`。**Agent 的 `genModelId`/`lightModelId`/`rerankModelId` 校验直接复刻这个模式**（`type==='llm'`/`type==='rerank'`）。

### FK 违反捕获 — 两个已知实现，一个有 bug

- `apps/backend/src/modules/models/models.service.ts:177-185` — `isForeignKeyViolation(e)` 检查 **`e.cause.code === '23503'`**（不是 `e.code`），注释明确写"实测验证：直接查 e.code 永远查不到，需下钻 e.cause.code 才是真正的 pg SQLSTATE"。这是**验证过的正确实现**。
- `apps/backend/src/modules/models/models.service.ts:78-91` — `remove()` 用上面这个函数 catch 住 knowledge_bases 的 FK RESTRICT，转 409。
- **发现一个既有 bug**：`apps/backend/src/modules/prompts/prompts.service.ts:145-152` 的 `isUniqueViolation(e)` 检查的是 **`e.code === '23505'`**（顶层，不下钻 `.cause`），与 models.service.ts 记录的"实测验证"结论矛盾——如果这个结论对 unique violation 同样成立（Postgres 错误都经同一个 drizzle 包装路径，没有理由 unique violation 和 FK violation 走不同的错误结构），`prompts.service.ts:createVersion()` 里 `attempt<2` 的撞号重试分支（`prompts.service.ts:84-85`）可能从未真正触发过，是死代码路径。**这不在 008 设计文档范围内，本次不修（超出任务边界），但记入 Risks，且我方新写的 `agents.service.ts` 一律用 `e.cause.code` 这个已验证正确的模式，不复用 `isUniqueViolation` 现成函数**。

### Agent 当前桩与需要新建的文件

- `apps/backend/src/modules/agents/agents.controller.ts:1-37` — 现有 4 个端点（list/get/create/update）全部要重写为真实实现；无 `schema.ts`、无 `repository.ts`。
- `apps/backend/src/modules/agents/agents.module.ts:1-9` — 只 provide `AgentsController`+`AgentsService`，不 import 任何其他模块。要改成 `imports: [ModelsModule, PromptsModule, KnowledgeBasesModule]`（比对 `knowledge-bases.module.ts:14-24` 的写法）。
- `apps/backend/src/app.module.ts:20` — `AgentsModule` 已注册，无需改 app.module.ts。

### 跨模块依赖边界确认

- `apps/backend/src/modules/prompts/prompts.module.ts:6-11` — `PromptsModule` 只 `exports: [PromptsService]`，**不导出 `PromptsRepository`**。`agents` 模块按 AGENTS.md 依赖边界规则 5（"跨域模块只走对方 barrel 导出的 service/端口"）**只能用 `PromptsService`，不能直接 import `PromptsRepository`**。
- **需要在 `PromptsService` 新增一个方法**：现有方法（`get`/`listVersions`/`createVersion`/`promote`/`delete`）都要求先知道 `promptId`，但 Agent 建/改配置版本时只有 4 个 `prompt_*_ver_id`（version id），需要反查其 `promptId` + 所属 `node`（用于校验"该版本所属 prompt 的 node 与字段对应节点一致"，008 文档 In-scope 项）。契约层 `PromptVersion` 类型（`packages/contracts/src/prompts.ts:24-35`）本身没有 `node` 字段（`node` 在父 `Prompt` 上，见 `prompts.ts:11-20`）。**新增 `PromptsService.getVersionMeta(versionId): Promise<{promptId:string; node:PromptNode}|null>`**，内部用 `repo.findVersionById` + `repo.findPromptById`（两次内部仓储读取，不新增契约）。
- `apps/backend/src/modules/knowledge-bases/knowledge-bases.module.ts:20-26` — `KnowledgeBasesModule` 导出 `KnowledgeBasesRepository` 和 `KnowledgeBasesService`。`agents` 模块可以直接注入 `KnowledgeBasesRepository`（批量按 id 查 kb 校验 embedding 一致性用 repository 更直接，或复用 `KnowledgeBasesService.get()` 循环调用——**决定用 repository 批量查**，需要检查 `KnowledgeBasesRepository` 是否已有按 id 数组批量查的方法）。
- `apps/backend/src/modules/models/models.module.ts` — 需确认 `ModelsService` 已 exports（`knowledge-bases.module.ts:14` 已 import 用过，确认可用）。

### 既有 e2e 测试会被本次改动破坏（第一遍投资调查漏掉，第二遍补上）

- `apps/backend/test/skeleton.e2e.spec.ts:879-909` — `describe("agents (AC 10: 非法 body → 400)")` 整块基于**当前的 M2 mock 行为**编写：`validCreateAgent`（78-93 行）是旧扁平契约形状（`status`/`kbs`/`threshold` 等直接摊平在顶层，无 `nodeParams`/无版本概念），且 `PATCH /api/agents/aftersale`（901-908 行）依赖 `MOCK_AGENTS` 里硬编码的 `"aftersale"` id。
- 这个测试文件（顶层 `describe`，`beforeAll` 在 356-397 行）是**完全 DB-free 的 e2e**：`PromptsRepository`/`ModelsRepository`/`KnowledgeBasesRepository`/`DocumentsRepository`/`ChunksRepository` 全部用 `.overrideProvider(...).useValue(inMemoryXxxRepo)` 换成内存假实现（`DATABASE_URL` 是占位符，从不真连，注释见 71-74 行）。`AgentsModule` 已在 357-373 行的 `imports` 里，但**目前不需要覆盖任何 provider**，因为现有 `AgentsService` 本身就是纯内存 mock，没有 DB 依赖——这正是这个测试至今能跑通的原因。
- **本次改动一旦给 `agents` 域加上真实 `AgentsRepository`（`@Inject(DRIZZLE)`），这个测试树在 `beforeAll` 阶段就会因缺少 provider override 而失败**（除非补一个 `inMemoryAgentsRepo` override，对齐 Prompts/Models/KnowledgeBases/Documents/Chunks 的既有模式）。
- 即使补了 override，`validCreateAgent` 的字段形状与新契约完全不兼容（新契约需要真实存在的 `kbIds`/`genModelId`/4 个 `prompt*VerId`，且要满足 embedding 一致性 + type/enabled + node 归属校验），`PATCH .../aftersale` 更是无法通过（新实现下不存在的 id 会 404，且 PATCH 契约收窄后 `{name:"..."}` 是唯一允许的字段，凑巧还能过，但 id 本身就查不到）。
- **测试文件里已有的可复用 fixture 模式**：`embeddingModelId`（547 行声明于外层 describe 作用域，跨嵌套 describe 共享）+ `ensureEmbeddingModel`（548 行起）负责保证有一个真实存在的 embedding 模型；`knowledge-bases` describe（564-661 行）演示了"先建模型 → 建 KB → 拿到 kbId"的完整链路。**「agents」describe 需要重写为自己的 `beforeAll`，创建一个 llm 类型模型（`embeddingModelId` 是 embedding 类型，不能复用做 `genModelId`）+ 复用/新建一个 kb + 建 4 个不同 node 的 prompt 并各自取一个 version id**，再执行 create/patch/config-version/eval-run/publish/rollback 全链路断言。
- 由于 `describe("prompts", ...)` 目前排在 `agents` **之后**（911 行起），且它创建的 `promptId`/`v1Id`/`v2Id` 是该 describe 内部局部变量、不对外共享，「agents」describe **不能依赖 `prompts` 块的副作用**，必须在自己的 `beforeAll` 里独立创建所需的 4 个 prompt version（通过真实 `POST /api/prompts` + `GET /api/prompts/:id/versions` 两步，而不是直接操作 `inMemoryPrompts`/`inMemoryVersions` 数组，保持这个文件里"通过真实 HTTP 端点铺垫 fixture"的一贯风格）。

### 前端现状

- `apps/frontend/src/pages/admin/AgentsPage.tsx` 全文（607 行）是纯手写 div + 内联样式，没有一处 antd import。**需要整页重写**，参照 `apps/frontend/src/pages/admin/PromptsPage.tsx`（antd `Drawer`/`Table`/`Popconfirm`/`Select`/`Tag`/`Space`/`Alert` 组合，版本历史左栏 + 右栏 Tabs 布局，`PromptsPage.tsx:784-1000` 的版本管理抽屉结构可直接作为 Agent 配置版本抽屉的骨架参照）。
- `apps/frontend/src/api/client.ts:141-145` 已有 `getAgents`/`getAgent` 两个占位函数，用旧的 `AgentListResponseSchema`/`AgentSchema`（M2 扁平契约）——**contracts 重写后这两个函数的 schema 引用要跟着换**，并新增 create/update/config-versions 系列函数（对齐 `client.ts:301-337` 的 prompts 写操作模式）。
- `apps/frontend/src/mocks/agents.ts` 全文是 M2 静态 mock 数据（`AGENT_ROWS`/`DF_DEFAULT`/`ALL_KBS` 等）。真实接入后，静态选项列表（`GEN_MODELS`/`RERANK_MODELS`/`PROMPT_*_OPTS`）要换成从 `getModels()`/`getPrompts()` 真实拉取，`ALL_KBS` 换成 `getKnowledgeBases()`（需确认该函数已存在于 client.ts）。
- `PromptsPage.tsx:978-993` 的"绑定 Agent" Tab 目前是占位文案"M7 Agent 管理接入后展示绑定关系"——**明确不在本次范围内实现**（008 设计文档没有要求这个反向关联视图），维持占位不动。

## Intent / Non-goals / Forbidden Shortcuts

**必须满足的行为**（不是"测试通过就行"，而是实际语义）：
- 编辑 Agent（`PATCH /api/agents/:id`）在 HTTP 层之外（例如直接构造 service 调用）也必须拒绝写入版本化字段——契约 `strictObject` + service 显式检查两道防线都要有，不能只做一道就declare完成。
- 知识库 embedding 一致性、模型 type/enabled、prompt node 归属这三类校验必须在**创建 Agent** 和**新建配置版本**两条路径都生效（不能只做其中一条就当作完成，因为两条路径共用同一批字段）。
- Eval stub（`eval-run`）允许硬编码返回 passed，但 `eval_pass_rate` **禁止编造具体数字**（008 Trade-offs 表格明确禁止），必须是 `null`。

**禁止的捷径**：
- 不要为了让测试通过而把知识库/模型/Prompt 校验放松成"不存在也放行"。
- 不要把 `agent_config_versions` 的业务字段做成可变更（008 Invariant 1：一旦创建不可变，改必须走新版本）。
- 不要在 `PATCH /agents/:id` 里偷偷放行除 `name`/`desc`/`enabled` 外的任何字段，哪怕前端暂时不用。

**Non-goals**（与 008 文档 Out-of-scope 一致，此处不重复展开）：真实 Eval 引擎、RetrieverPort 内部实现、Agent 删除、`agent_kbs` 镜像表、M9 Trace 过滤实现、RBAC。

## Changes by File

### 契约层

- `packages/contracts/src/m2-schemas.test.ts` — **含 8 处直接断言旧扁平 `AgentSchema`/`CreateAgentRequestSchema`/`UpdateAgentRequestSchema` 形状的用例**（118-119/164-165/221-238/255-263 行，`valid.agent` fixture 定义在 54 行起），`agents.ts` 契约重写后这些用例全部编译期/运行期失败，必须同步删除或改写成对新 `Agent`/`CreateAgentRequestSchema`/`AgentConfigVersionSchema` 的断言（第一遍投资扫描漏查了 `packages/` 目录本身，只查了 `apps/`，第二遍补上）。`chatReq`/`conv` fixture 里的 `agentId: "aftersale"` 字符串字面量（93-100 行）与 Agent schema 本身无关（那是 `ChatRequestSchema`/`ConversationSchema` 的字段，类型是普通 `z.string()`），不用动。
- `packages/contracts/src/agents.ts` — **完全重写**：
  - `AgentSchema`（身份+派生 status，不含版本化字段）
  - `AgentConfigVersionSchema`（含 `nodeParams`/检索参数/eval 字段/kbIds）
  - `NodeParamsSchema` / `NodeConfigSchema`（4 节点 jsonb 形状）
  - `CreateAgentRequestSchema`（合并身份字段 + v1 版本字段，一次性提交）
  - `UpdateAgentRequestSchema`（`z.strictObject({name?, desc?, enabled?})`）
  - `CreateAgentConfigVersionRequestSchema`（版本字段，不含 status/eval，note 可选）
  - `EvalRunResponseSchema` / `PublishAgentConfigVersionResponseSchema`

### 后端 — schema / migration

- `apps/backend/src/modules/agents/schema.ts` — **新建**：`agents`/`agentConfigVersions`/`agentConfigVersionKbs` 三张 Drizzle 表，字段与索引对齐 008 文档「数据模型」章节。
- `pnpm --filter @codecrush/backend db:generate` 生成迁移 SQL（drizzle-kit，见 `apps/backend/package.json:11`），随代码一并提交。

### 后端 — agents 模块

- `apps/backend/src/modules/agents/agents.repository.ts` — **新建**：list 聚合查询（join 当前版本摘要，避免 N+1，参照 `prompts.repository.ts:26-45` 的 `PROMPT_AGG_SELECT` 子查询模式）、`insertAgent`/`insertVersion`/`insertVersionKbs`/`findVersions`/`findVersionById`/`promote`（事务，参照 `prompts.repository.ts:123-153`）。
- `apps/backend/src/modules/agents/agents.service.ts` — **重写**：`list`/`get`/`create`（建 agents+v1 单事务）/`updateBase`（PATCH，仅 name/desc/enabled）/`listVersions`/`createVersion`/`evalRun`（stub）/`publish`/`rollback`（`promote()` 复用，Eval 门槛校验）。
- `apps/backend/src/modules/agents/agents.controller.ts` — **重写**：对齐 API 端点草案（008 文档「API 端点」表格）。
- `apps/backend/src/modules/agents/agents.module.ts` — **改**：`imports: [ModelsModule, PromptsModule, KnowledgeBasesModule]`。

### 后端 — 联动补丁

- `apps/backend/src/modules/prompts/prompts.service.ts` —
  1. `delete()`（108-115 行）补 FK 违反捕获：`catch(isForeignKeyViolation) → ConflictException`，`isForeignKeyViolation` 用 `e.cause.code`（复刻 `models.service.ts:177-185`，不是本文件已有的、可能有 bug 的 `isUniqueViolation`）。
  2. 新增 `getVersionMeta(versionId): Promise<{promptId:string; node:PromptNode} | null>` 方法（组合 `repo.findVersionById` + `repo.findPromptById`，供 agents 模块跨域调用）。
- `apps/backend/src/modules/prompts/prompts.module.ts` — 若 `getVersionMeta` 只用 `PromptsService`（已导出），无需改 exports。
- `apps/backend/src/modules/models/models.service.ts:87` — 错误文案 `"model {id} 仍被知识库引用，无法删除"` 改为 `"model {id} 仍被知识库或 Agent 配置引用，无法删除"`。
- `apps/backend/src/modules/knowledge-bases/knowledge-bases.repository.ts` — 新增 `findByIds(ids: string[]): Promise<KnowledgeBaseRow[]>`（批量查，供 agents 域校验 embedding 一致性用，避免 N 次单查）。
- `apps/backend/src/modules/knowledge-bases/knowledge-bases.module.ts` — 确认 `KnowledgeBasesRepository` 已在 `exports`（`knowledge-bases.module.ts:25` 已导出，agents 模块可直接注入，无需改这个文件）。

### 前端

- `apps/frontend/src/api/client.ts` — 重写 agents 相关函数（141-145 行现有占位起），新增 create/updateBase/listConfigVersions/createConfigVersion/evalRun/publish/rollback，import 改用新契约类型。
- `apps/frontend/src/pages/admin/AgentsPage.tsx` — **整页重写**为 antd 组件（`Table`/`Drawer`/`Form`/`Select`/`Tag`/`Popconfirm`/`Alert`/`message`），参照 `PromptsPage.tsx` 的整体结构：列表 + 新建/编辑抽屉 + 配置版本管理抽屉（左侧版本历史列表 + 右侧详情/Eval stub 按钮/发布回滚）。
- `apps/frontend/src/mocks/agents.ts` — 精简为纯展示常量（色板/标签映射），移除会被真实数据替代的 `AGENT_ROWS`/`DF_DEFAULT` 等（或整体删除，视重写后前端是否还需要这些引用）。

## Acceptance Criteria

1. `POST /api/agents` 携带完整字段（含 ≥1 个 kbId、合法 genModelId、4 个合法 prompt version id）→ 201，返回的 Agent `status='active'`，其配置版本 `eval_status='exempt'`。
2. `POST /api/agents` 携带 kbIds 指向不同 embedding 模型的知识库 → 400，错误文案含冲突知识库名与两个 embedding 模型名。
3. `PATCH /api/agents/:id` body 携带 `topK` 等非 name/desc/enabled 字段 → 400（契约层拒绝）。
4. `POST /api/agents/:id/config-versions` 建草稿版本 → `eval_status='not_run'`；此时 `POST .../publish` → 409。
5. `POST /api/agents/:id/config-versions/:id/eval-run` → `eval_status='passed'`, `eval_pass_rate=null`；随后 `POST .../publish` → 200，旧生产版本转 `archived`，`agents.currentVersionId` 更新。
6. `POST /api/agents/:id/config-versions/:archivedId/rollback` → 200，目标版本转回 `published`，此前生产版本转 `archived`；对非 `archived` 状态版本调用 → 409。
7. Agent 引用一个不存在的 `promptRewriteVerId` → 404；引用一个 `node` 不匹配的 prompt version（如把 `intent` 节点的版本填进 `rewrite` 字段）→ 400。
8. 前端 AgentsPage 用 antd 渲染，列表/新建/编辑/配置版本抽屉走真实 API，无残留手写 div 布局。

## Test Plan

- **单元测试**（复刻 `prompts.service.spec.ts` 的 mock-repository 风格）：`apps/backend/test/agents.service.spec.ts` 覆盖 create（校验分支：kb 一致性/模型 type+enabled/prompt node 归属）、createVersion、evalRun stub、promote（publish 门槛拦截 + rollback）。
- **`apps/backend/test/skeleton.e2e.spec.ts` 必须重写**（不是"确认不受影响"——已确认会被破坏，见 Investigation Findings）：
  1. 补一个 `inMemoryAgentsRepo`（对齐 `inMemoryPromptsRepo`/`inMemoryKbsRepo` 等既有写法）+ `.overrideProvider(AgentsRepository).useValue(inMemoryAgentsRepo)` 加进 356-397 行的 testing module 装配。
  2. 重写 879-909 行的 `describe("agents", ...)`：自建 `beforeAll` 创建 1 个 llm 模型 + 复用/新建 1 个 kb + 4 个不同 node 的 prompt（各取一个 version id），再覆盖 008 文档 Acceptance Criteria 里列的 8 条场景（成功创建/embedding 冲突 400/PATCH 越权字段 400/draft 版本发布前 409/eval-run 后可发布/rollback 校验/prompt node 不匹配 400/引用不存在 prompt version 404）。
  3. 删除 `validCreateAgent`（78-93 行，旧扁平契约形状）常量，改为在新 `beforeAll` 内动态构造（依赖真实创建出的 id，无法再是静态字面量）。
- `prompts.service.ts` 补丁需要新增/扩展 `apps/backend/test/prompts.service.spec.ts` 用例：`delete()` 遇到 FK 冲突转 409、`getVersionMeta()` 返回正确的 `{promptId,node}`。
- 前端：暂无既有 AgentsPage 测试文件（检索 `find apps/frontend -iname "*agents*test*" -o -iname "*agents*spec*"` 确认），本次不强制新增前端单测（对齐 PromptsPage 现状——它也没有专门的组件测试），以手动 preview 验证为主。
- `pnpm lint`（含依赖边界 ESLint 规则，必须 0）与 `pnpm test` 全量必跑（AGENTS.md 高频提醒）。

## Risks / Unknowns

- **已核实**：`apps/backend/src/modules/knowledge-bases/knowledge-bases.repository.ts:1-69` 全部方法（`find`/`findById`/`findByName`/`insert`/`update`/`updateVersions`/`delete`）里**没有**按 id 数组批量查询的方法。`agents.repository.ts` 校验 kb embedding 一致性需要新增 `KnowledgeBasesRepository.findByIds(ids: string[])`，plan 里要包含这个新方法。
- `prompts.service.ts` 的 `isUniqueViolation`（145-152 行，检查 `e.code` 而非 `e.cause.code`）疑似死代码 bug，不在本次修复范围（不影响本任务功能，只是记录发现）。本任务新写的 FK 捕获一律用已验证正确的 `e.cause.code` 模式，不复用这个函数、也不修它。
- 008 文档「Assumptions」明确：模型/Prompt 变更后历史版本展示"跟随"当前内容——这意味着前端展示某个 archived 版本时看到的模型名/Prompt 内容可能与它发布时不同，这是设计接受的行为，不是 bug，写 plan 时要在验收标准里避免误判为回归。
