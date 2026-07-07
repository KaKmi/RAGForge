# M3 Dev Ledger

> WAVE_BASE_SHA: 3b55109（main 合入点）；plan artifacts 提交：37b7819

Story 1: "契约修订（contracts/models.ts）+ 契约测试" — complete
  Commits: bad1653
  Files: packages/contracts/src/models.ts, packages/contracts/src/models.test.ts, packages/contracts/src/m2-schemas.test.ts
  Produces: ModelProviderSchema/ModelProvider（读侧含 apiKeyMasked 必填、deploymentId?、无 role/apiKey）；CreateModelRequestSchema（+apiKey min8、enabled default true）；UpdateModelRequestSchema（全 partial，注意不可由 Create.partial() 派生——zod v4 default 注入问题已修）；TestModelRequestSchema（Create 去 enabled）；TestModelResponseSchema {ok, latencyMs?, statusCode?, error?}
  Concerns: none（实现时发现并修复 zod v4 partial+default 语义 bug，plan 自查已预警）
  Review: 跳过（轻量对抗档）

Story 2: "加密服务 + SecurityModule + env/config 接线" — complete
  Commits: bc18f3c, eb9f4bd（fix：零长明文 envelope）
  Files: apps/backend/src/platform/security/{encryption.ts,security.constants.ts,security.module.ts}, platform/config/{config.schema.ts,config.service.ts}, app.module.ts, .env.example, test/{encryption.spec.ts,config.schema.spec.ts}
  Produces: EncryptionService{encrypt→"v1:iv:tag:ct", decrypt, maskApiKey}；ENCRYPTION Symbol token（security.constants.ts）；@Global SecurityModule；AppConfigService.modelApiKeyEncryptionKey；env MODEL_API_KEY_ENCRYPTION_KEY min(44)
  Concerns: none
  Review: peer（Codex）单独审——round 1 FAIL（空明文 envelope 被拒，真 bug），fix 后 round 2 PASS

Story 3: "DB schema + 迁移 + ModelsRepository" — complete
  Commits: 6366c74
  Files: apps/backend/src/modules/models/{schema.ts,models.repository.ts}, src/db/schema.ts, drizzle/0003_reflective_matthew_murdock.sql（+meta）
  Produces: modelProviders 表（无 role 列）；ModelProviderRow/NewModelProvider；ModelsRepository{find,findById,insert,update(自动刷 updatedAt),delete}
  Concerns: none（迁移已对本地 PG 实跑）
  Review: 跳过（轻量对抗档，收尾全量审覆盖）

Story 4: "ModelProviderPort + OpenAiCompatAdapter" — complete
  Commits: 75e67d3
  Files: apps/backend/src/modules/models/{ports/model-provider.port.ts,model-provider.constants.ts,adapters/openai-compat.adapter.ts}, test/openai-compat.adapter.spec.ts
  Produces: ModelProviderPort{testConnection}；ModelCallConfig（含 deploymentId?）；TestModelResult；MODEL_PROVIDER_PORT token；TEST_CONNECTION_TIMEOUT_MS=10000
  Concerns: none
  Review: 跳过（同上）

Story 5: "Service 重写 + Controller 扩展 + Module + e2e" — complete
  Commits: 32d4020
  Files: apps/backend/src/modules/models/{models.service.ts,models.controller.ts,models.module.ts}, test/{models.service.spec.ts,skeleton.e2e.spec.ts}
  Produces: HTTP 面 GET/POST /api/models、GET/PATCH/DELETE /api/models/:id、POST /api/models/test（ad-hoc）、POST /api/models/:id/test；ModelsModule exports [ModelsService, MODEL_PROVIDER_PORT]
  Concerns: none（后端全量 110/110）
  Review: 跳过（同上）

协议化改造（原型变更后的 arch-design 落地，2026-07-07）— complete
  Commits: 8226efd（契约+后端）, 8ae0545（前端+导航+docs）, 2df2535（review 三项修复）
  Files: contracts/models.ts（ModelProtocolSchema/PROTOCOLS_BY_TYPE/isValidProtocol/params/TestModelOverrideSchema）,
    backend models（schema protocol+params 列、迁移 0004 回填版+0005、ProtocolDispatchAdapter + adapters/protocols/* 12 探针 builder、service 合并校验+testById override）,
    frontend（ModelsPage 协议 UI/可编辑参数/key 不回显、mocks PROTOCOL_OPTIONS+一致性测试、AdminLayout 分组导航、GapsPage 壳、App 路由/测试）,
    docs/design/001-003 协议化修订
  Produces: (type, protocol) 路由键契约；MODEL_PROVIDER_PORT 的 ModelCallConfig{type,protocol,name,baseUrl,apiKey,deploymentId?,params?}；
    POST /api/models/test（ad-hoc）与 POST /api/models/:id/test（可带不含 key 的 override）
  Review: peer（Codex）全量 diff 审——round 1 FAIL（迁移非空表阻塞/PATCH 组合洞/编辑态测旧配置），修复后 round 2 PASS
  Concerns: self_hosted=TEI 形状为假设（首个真实自建接入时验证）；GapsPage 仅壳（M10 波 1:1）

Story 6: "前端接通（client + ModelsPage + mocks + App.test）" — complete
  Commits: 6861e89
  Files: apps/frontend/src/{api/client.ts,pages/admin/ModelsPage.tsx,mocks/models.ts,app/App.test.tsx}
  Produces: createModel/updateModel/deleteModel/testModel/testModelConfig；mocks/models.ts 改为纯 UI 常量（TYPE_LABEL/MODEL_TYPES/MODEL_TABS/ModelDraft），LLM_ROWS 已删
  Concerns: 前端 build 依赖 contracts 先 build（turbo 全仓 build 会按依赖序处理）
  Review: 跳过（同上）

Story 7: "收尾验证" — complete
  Commits: 58fca00（收尾 review 修复：error message 擦除回显 apiKey）
  Files: apps/backend/src/modules/models/adapters/openai-compat.adapter.ts, test/openai-compat.adapter.spec.ts
  Produces: 无新接口
  Concerns: none
  验证记录：pnpm test/lint/build 全绿（backend 111/contracts 79/frontend 18）；pnpm db:migrate 幂等；
    OpenAPI docs-json 含全部 4 个 models 路径；运行时冒烟（真后端+真 PG）：201 掩码响应、
    DB api_key_enc 为 v1: 密文、不可达端点测试优雅 {ok:false}、PATCH 无泄漏、DELETE 204。
  Review: 收尾全量 diff peer 审（Codex）——round 1 FAIL（上游 error message 可回显明文 key，
    真安全洞），fix 58fca00 后 round 2 PASS。
