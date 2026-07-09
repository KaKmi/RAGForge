# M4 入库管线与知识库管理 — Spec（host）

Branch: `main` @ `6a9112c8f2b069ce794b49fb5187f75a33e1889b`

## Problem / Motivation

M2 把知识库三屏做成了纯前端 mock（`apps/frontend/src/mocks/knowledge-bases.ts`）+ 后端内存桩（`knowledge-bases.service.ts` 等，注释自陈"M2 桩：仅回显，不持久化"）。M4 要把它换成真实实现：Postgres+pgvector 落库、BlobStore 落文件、pg-boss 异步四阶段管线（解析→清洗→分块→向量化）。产品侧同期做了知识库管理大改（切片删除制取代启用/禁用、分块模板库级可配置且改模板触发全库重建、文档元数据、四格式全支持），已写入权威设计 [docs/design/007-m4-ingestion-pipeline.md](../../../docs/design/007-m4-ingestion-pipeline.md)（含 Boundaries / 4 条不变量 / 4 项用户拍板）。本 spec 把 007 落成工程规格。

## Design approach

复用 M3 models 模块已验证的模式（这是最佳参照，逐条对应）：
- **repository + service 分层**：`models.repository.ts:1-41` 的 `find/findById/insert/update/delete` 薄封装 → 新 `KnowledgeBasesRepository`/`DocumentsRepository`/`ChunksRepository` 同构。
- **域内 schema.ts 零 service 引用**：`models/schema.ts:1-23` → 新 `knowledge-bases/schema.ts`、`documents/schema.ts`、`chunks/schema.ts`，经 `src/db/schema.ts` barrel 导出（现有 `export * from "../modules/models/schema"` 模式）。
- **端口 + DI token，拿端口不拿适配器**：`model-provider.constants.ts:1`（`Symbol("MODEL_PROVIDER_PORT")`）+ `models.module.ts:13-16`（`{ provide: TOKEN, useClass: Adapter }`，`exports: [Service, TOKEN]`）→ 新 `BLOB_STORE` token（`platform/storage`）、`INGESTION_QUEUE` token（`platform/queue`）、`INGESTION_PIPELINE_PORT` token（`ingestion` 域）。
- **协议分发注册表模式**：`protocol-dispatch.adapter.ts:25-39`（`PROBE_BUILDERS` 按 `type:protocol` 查表，缺项走"契约层已收口，此分支不可达"防御分支）→ 复用两处：(a) `DocumentParserPort` 按 `DocumentType` 查表分发 pdf-parse/mammoth/纯文本；(b) `ChunkerPort` 按 `ChunkTemplate` 查表分发 通用/问答。
- **前端真实页面替换 mock，API client 补全**：`ModelsPage.tsx` 是范式（`useEffect` 拉取 + 本地 state + 抽屉表单，`api/client.ts:131-161` 的 get/post/patch/delete 全套）。`api/client.ts:164-177` 目前只有只读 GET 桩（`getKnowledgeBases/getDocuments/getIngestionStatus/getChunks`），且**当前页面并未调用它们**（`KnowledgeBasesPage.tsx:3` 直接 `import { KB_ROWS } from "../../mocks/..."`）——M4 要把页面从 mock 切到这套 client，并补齐写操作（create/upload/patch/delete/batch-delete）。

## Investigation findings

### 现状：M2 骨架的三层 mock（将被 M4 整体替换）

- 后端内存桩：[knowledge-bases.service.ts](../../../apps/backend/src/modules/knowledge-bases/knowledge-bases.service.ts)（`MOCK_KBS` 数组，`create()` 直接回显不持久化）、[documents.service.ts](../../../apps/backend/src/modules/documents/documents.service.ts)（`MOCK_DOCS`）、[chunks.service.ts](../../../apps/backend/src/modules/chunks/chunks.service.ts)（`MOCK_CHUNKS`，`setEnabled` 原地改内存对象）、[ingestion.service.ts](../../../apps/backend/src/modules/ingestion/ingestion.service.ts)（`trigger/status` 返回固定值）。四个 controller 同目录，路由已定（`ingestion.controller.ts:1-15` 挂在 `documents/:id/ingest` 和 `documents/:id/ingestion-status` 下，注释自陈"M4 会独立扩展（队列 worker）"）。
- 契约现状（`packages/contracts/src/{knowledge-bases,documents,chunks}.ts`）：`Chunk` 有 `enabled: boolean`（chunks.ts:10）需整体移除；`Document` 五字段之外无 `metadata`/`lifecycle`/无 `chunkVersion`（documents.ts:9-19，`status` 枚举只有 4 值 `upload/ingest/ready/failed`，007 要求 5 值 `pending/queued/processing/failed/ready`）；`KnowledgeBase` 无 `chunkTemplate`/`activeVersion`/`buildingVersion`，`embeddingModelId` 创建后需锁定但契约当前无此约束（knowledge-bases.ts:4-15）；`CreateDocumentRequestSchema`（documents.ts:26-32）是 `DocumentSchema.omit(...)`，其形状假设"客户端直接传 blobKey"——**M4 改为 multipart 上传，此 Zod schema 不再是请求体**（改走 multer `UploadedFiles` + 独立字段）。
- 前端现状：三个页面（`KnowledgeBasesPage.tsx`/`DocumentsPage.tsx`/`ChunksPage.tsx`）全部 `import` 本地 mock 文件 `mocks/knowledge-bases.ts`（`KB_ROWS`/`KB_DOCS`/`STAGE_DEFS`/`CHUNK_OPTS` 等），**不调用** `api/client.ts` 里已存在的只读桩。`ChunksPage.tsx:203-204` 有"◉ 启用 / ◍ 禁用"批量按钮 + 每卡片开关（`chunkOff` state, line 96-103）——按 007 全部改为批量删除单一操作。`DocumentsPage.tsx:207-233` 上传抽屉的"分块策略"三选项（`CHUNK_OPTS = ["按语义分块","定长 512","按标题"]`，`mocks/knowledge-bases.ts:188`）是文档级选择——007 改为**库级**（创建 KB 时选，文档上传不再选）。

### 现状：测试断言将失效（需在 plan 中逐条改写）

- [packages/contracts/src/m2-schemas.test.ts](../../../packages/contracts/src/m2-schemas.test.ts)：`ChunkSchema` 相关断言（L162:`enabled` 隐含在 `valid.chunk` fixture 里、L316 `expect(created.enabled).toBe(true)`、L356-358 `UpdateChunkEnabledRequestSchema` 整段）、`DocumentSchema`（L158-159/224-225 五值枚举/type 校验）、`CreateDocumentRequestSchema`（L335-341，`.omit` 形状）、`KnowledgeBaseSchema`（L152-156 `status/progress` 对齐，需扩到 `chunkTemplate`）——这个文件是**改动最大的测试**，需要整体重写而非局部改。
- [apps/backend/test/skeleton.e2e.spec.ts:380-438](../../../apps/backend/test/skeleton.e2e.spec.ts)：`knowledge-bases`/`documents + ingestion`/`chunks` 三个 `describe` 块整体基于内存桩假设（如 L389 `POST /api/knowledge-bases` 直接传 `embeddingModelId: "m2"` 无需真实存在的模型；L406 `POST /api/documents` 直传 JSON body 含 `blobKey` 而非 multipart；L430-436 `PATCH /api/chunks/c1 {enabled:false}`）——M4 后这些端点行为、请求形状、状态机全变，需重写整个三段 + `openapi.e2e.spec.ts` 里对应路径断言（若有，见下）。
- [apps/backend/test/openapi.e2e.spec.ts](../../../apps/backend/test/openapi.e2e.spec.ts) 未见对 KB/document/chunk 路径的具体断言（只测 `/api/docs-json` 返回合法 OpenAPI 文档），无需改，但新增/变更的路由会被自动收进生成的 spec，不会破坏此测试本身。

### 现状：需要新增的基础设施（均未安装/未建）

- `platform/storage`、`platform/queue` 目录不存在（`find apps/backend/src/platform -maxdepth 1 -type d` 只有 `clickhouse/config/security/persistence`）。
- 依赖缺失：`multer`（虽 `@nestjs/platform-express` 传递依赖里有 `node_modules/.pnpm/node_modules/multer`，但 `apps/backend/package.json` 无直接声明、无 `@types/multer`，`FileInterceptor`/`FilesInterceptor` 需要类型）、`pg-boss`、`pdf-parse`、`mammoth`。均需加入 `apps/backend/package.json` dependencies。
- pgvector：docker-compose 镜像已是 `pgvector/pgvector:pg16`（[infra/docker-compose.yml:4](../../../infra/docker-compose.yml)），但 drizzle schema 里尚无任何 `vector(...)` 列类型使用先例——需要 drizzle `customType`（`drizzle-orm/pg-core` 的 `customType<{data:number[]}>` 手写，或引入 `pgvector` npm 包的 drizzle helper）。迁移需手写 `CREATE EXTENSION IF NOT EXISTS vector;` 和 HNSW 索引 SQL（drizzle-kit 目前不知道 vector 类型，需要在生成的 migration 后手工加 raw SQL，参照 `apps/backend/drizzle/` 现有 6 个迁移文件的编号延续 `0006_*`）。
- `AppConfigService`/`envSchema`（`config.schema.ts:1-16`）需加 `BLOB_STORE_PATH`（本地卷路径）等新变量。

### 现状：ESLint 边界（已核实哪些会/不会命中新代码）

- [eslint.config.mjs:14-124](../../../eslint.config.mjs)：只有 4 条 `no-restricted-imports` 边界（frontend→backend/otel 禁止、contracts→app/otel 禁止、otel-conventions→otel/codecrush/node 内建禁止、otel→contracts/clickhouse/apps 禁止）。**没有**对 AGENTS.md 第 5 条"任何地方不得直接 import adapters/"的 ESLint 强制——这是约定但未被 lint 规则收口，M4 新增的 `ingestion/adapters/*`（parser/chunker 实现）只能靠代码评审自律，不会被 CI 挡下。新模块（`platform/storage`、`platform/queue`）不落在任何现有边界规则的 `files` glob 里，天然不受限——符合预期（它们是基座，不是 frontend/contracts/otel）。

### 未验证 / 假设

- pgvector HNSW 索引在 drizzle-kit generate 流程下是否能被追踪（增量 diff）未经验证；本 spec 假设**手写 raw SQL migration**（不依赖 drizzle-kit 生成 vector 索引），plan 会用 `drizzle-kit generate` 生成表结构骨架，再手工 patch vector 列 + 索引 + extension 语句到生成的 `.sql` 文件。
- `pdf-parse` 对复杂 PDF（图片、多栏）的抽取质量未测；007 已把"扫描件识别失败"列为预期行为（Out-of-scope: OCR），plan 只需保证抛出可读错误、不需保证抽取质量。
- 007 里 embed 批处理大小 `params.batch_size` 默认 10——`ModelProviderPort.embed()` 尚不存在（`models/ports/model-provider.port.ts:23-25` 只有 `testConnection`），M4 要新增该方法，为非破坏性接口扩展（新增方法不影响现有 `testConnection` 调用方）。

## Changes by file

### `packages/contracts/src/`
- `knowledge-bases.ts`：`KnowledgeBaseSchema` 加 `chunkTemplate: z.enum(["general","qa"])`、`activeVersion: z.number().int().positive()`、`buildingVersion: z.number().int().positive().nullable()`；`CreateKnowledgeBaseRequestSchema` 保持 omit 派生但需确认 `chunkTemplate` 必填、`embeddingModelId` 必填（创建后端不可再改——契约层不禁止 PATCH 携带该字段，由 service 层拒绝，契约留一条注释说明"锁定在 service 层强制，非契约层"）；`UpdateKnowledgeBaseRequestSchema` 新增（PATCH 用，允许 `desc`/`chunkTemplate`，不允许 `embeddingModelId`）。
- `documents.ts`：`DocumentStatusSchema` 改 5 值 `["pending","queued","processing","failed","ready"]`；`DocumentSchema` 加 `metadata: z.record(z.string(), z.string()).default({})`、`lifecycle` 数组 schema（`stage/status/startedAt/endedAt/error` 各项）、`chunkVersion: z.number().int().positive().nullable()`；**删除** `CreateDocumentRequestSchema`（不再是 JSON body，上传走 multipart，契约层不建模 multipart body，controller 直接用 `@UploadedFiles()` + 独立 DTO 校验非文件字段如 `autoParse`）；新增 `UpdateDocumentMetadataRequestSchema`。
- `chunks.ts`：**删除** `enabled` 字段、**删除** `UpdateChunkEnabledRequestSchema`；`ChunkSchema` 加 `version: z.number().int().positive()`；新增 `ChunkBatchDeleteRequestSchema { ids: z.array(z.string().min(1)).min(1) }`；新增分页响应 `ChunkPageResponseSchema { items: Chunk[], total: number, hasMore: boolean }`（无限滚动需要 total 或 hasMore，取 007 的 offset/limit 语义）。
- 新增 `packages/contracts/src/m2-schemas.test.ts` 之外，**重写**该文件中所有 KB/Document/Chunk 相关断言（不是新建文件，是编辑既有文件）；同时决定：M4 的新契约测试可以留在 `m2-schemas.test.ts`（历史命名，实际测的是通用契约层）或拆到新文件 `ingestion-schemas.test.ts`——**决策：拆分**，把 KB/Document/Chunk 相关的 it block 从 `m2-schemas.test.ts` 移到新文件 `packages/contracts/src/knowledge-schemas.test.ts`，`m2-schemas.test.ts` 保留其余域（agents/prompts/retrieval/conversations 等）不动。理由：`m2-schemas.test.ts` 当前已混合 8+ 个域的断言在一个文件，M4 改动量大，拆分降低这一个文件的 diff 噪音，且以后 M5/M7 迭代 KB 相关契约不用碰这个大文件。

### `apps/backend/src/platform/`（新增两个平台件）
- `storage/blob-store.port.ts`：`interface BlobStore { put(key, buffer): Promise<void>; get(key): Promise<Buffer>; delete(key): Promise<void>; }`；`storage/blob-store.constants.ts`：`export const BLOB_STORE = Symbol("BLOB_STORE")`；`storage/local-fs-blob-store.adapter.ts`：基于 `AppConfigService` 新增的 `blobStorePath` 落盘，key 含 `/` 时按需 `mkdir -p` 子目录；`storage/storage.module.ts`：`@Global()` 或按需 import，`exports: [BLOB_STORE]`。**[diff-report 附注]** 本地 dev 后端是宿主机直连进程（`infra/docker-compose.yml:56-58` 只有 `pgdata`/`chdata` 两个卷），`LocalFsBlobStore` 直接写宿主机路径即可，不需要新增 compose volume；后端容器化后才需要补 blob 卷，记为 M4 之外的 revisit 项。
- `queue/`：`pg-boss` 封装。`queue.module.ts` 用 `OnModuleInit`/`OnModuleDestroy` 启停 boss 实例（复用 `DATABASE_URL`，pg-boss 自建 `pgboss` schema）；`queue.constants.ts` 导出 `INGESTION_QUEUE` token；对外暴露最小接口（`publish(jobName, data, opts)`/`subscribe(jobName, handler)`），不直接把 `PgBoss` 实例导出给消费方（端口化）。
- `config/config.schema.ts` 加：`BLOB_STORE_PATH: z.string().default("./.data/blobs")`（本地卷路径，dev 默认相对路径）。`config.service.ts` 加 `get blobStorePath()`。

### `apps/backend/src/modules/knowledge-bases/`
- `schema.ts`（新建）：`knowledgeBases` 表，字段见 007 Design 章节；`chunkTemplate` 用 `text` + 应用层枚举校验（同 `models/schema.ts:9` 的 `type`/`protocol` 处理方式：db 是 text，契约层收口合法值）。
- `knowledge-bases.repository.ts`（新建）：CRUD + `findByName`（查重）+ `updateVersions(id, {activeVersion?, buildingVersion?, status?})` 专用方法（版本切换需要原子更新，避免走通用 `update` 时误覆盖其它字段）。
- `knowledge-bases.service.ts`（重写）：`create` 校验名称唯一 + 校验 `embeddingModelId` 指向已启用的 embedding 类型模型（跨模块调用 `ModelsService`，经其 barrel 导出）+ 探针校验输出维度=1024（Invariant 2，调用新 `ModelProviderPort.embed()` 单条探针文本）；`update` 允许改 `desc`/`chunkTemplate`，改 `chunkTemplate` 时触发全库重建（发布 pg-boss 任务，`building_version = active_version+1`，同时正在 building 中再次 PATCH → 409）；不允许 PATCH 携带 `embeddingModelId`（有则 400/字段被忽略——**决策：显式 400**，契约层允许传但 service 拒绝更清楚地告知用户"锁定"而非静默丢弃）。
- `knowledge-bases.module.ts`：imports `ModelsModule`（拿 `ModelsService` + `MODEL_PROVIDER_PORT`）、`StorageModule`、`QueueModule`。

### `apps/backend/src/modules/documents/`
- `schema.ts`（新建）：`documents` 表（见 007）。
- `documents.repository.ts`（新建）：CRUD + `findByKb(kbId)` + `updateLifecycle(id, stage, status, error?)`（append 到 `lifecycle` jsonb 数组）。
- `documents.service.ts`（重写）：`upload(files, kbId, opts)` 用 multer 内存 buffer → `BlobStore.put` → insert row(status=pending or queued) → 若 `autoParse` 发布 ingestion 任务；`triggerParse(id)`（手动开始/重试，幂等 upsert 任务，`singletonKey=documentId`）；`getContent(id)` 返回 `parsedText`；`updateMetadata`/`remove`（删除级联 blob + chunks，`remove` 先 `BlobStore.delete` 再 DB delete，blob 删除失败不阻塞 DB 删除但记 warn 日志——**决策**：孤儿 blob 属于可接受的轻量代价，好过因对象存储瞬时故障导致文档删不掉）。
- `documents.controller.ts`（重写）：`POST /api/knowledge-bases/:kbId/documents`（`FilesInterceptor`，字段 `autoParse` bool、`relativePath[]` 与文件一一对应）——**注意**：007 契约表里写的是 `POST /api/knowledge-bases/:id/documents`，与当前 `DocumentsController` 挂在独立 `documents` 路径不同，需要迁移路由前缀（旧 `GET /api/documents?kbId=` query 参数风格 → 新 RESTful 嵌套路径风格）；`GET /api/documents/:id/lifecycle`、`PATCH /api/documents/:id/metadata`、`DELETE /api/documents/:id`、`GET /api/documents/:id/content`、`POST /api/documents/:id/parse`。

### `apps/backend/src/modules/ingestion/`（重写为真实四阶段管线）
- `ports/`：`document-parser.port.ts`（`parse(buffer, type): Promise<{text: string}>`）、`text-cleaner.port.ts`（`clean(text): string`，同步纯函数不需要端口其实——**决策**：清洗阶段不做成 DI 端口，做成 `ingestion/pipeline/clean-text.ts` 纯函数（007 说"整条管线可替换端口"，但清洗默认实现在 007 里只有一种、无注册表分发需求，做成端口徒增样板；解析和分块因为按类型/模板分发才需要注册表模式）、`chunker.port.ts`（`chunk(text, template): ChunkDraft[]`）、`ingestion-pipeline.port.ts`（顶层 `run(ctx)`，默认实现 `DefaultIngestionPipeline` 组合上述三步 + 调用 `ModelsService.embed`）。
- `adapters/parsers/`：`pdf-parser.ts`（`pdf-parse` 库）、`word-parser.ts`（`mammoth`）、`text-parser.ts`（markdown/txt 原样返回，注意 `.md` 需要先跑清洗但不需要"解析"库，直接 buffer.toString('utf-8')）、`parser-registry.ts`（`Record<DocumentType, DocumentParserPort>` 查表，模式同 `PROBE_BUILDERS`）。
- `adapters/chunkers/`：`general-chunker.ts`（标题层级切段 + 贪心合并 ~512 token，CJK 感知计数：中文按字符计 1、英文按 4 字符≈1 token 估算——07 已定"CJK 感知估算"但未给出精确公式，**决策**：`estimateTokens(text) = Math.ceil(cjkCharCount + nonCjkCharCount/4)`，简单可测试）、`qa-chunker.ts`（按最低级标题或 `Q:/A:`/`问：/答：` 配对切片）、`chunker-registry.ts`。
- `ingestion.service.ts`（重写）：`runForDocument(documentId, targetVersion)` = 解析→清洗→分块→批量向量化（`ModelsService.embed`，批大小从 kb 所属 embedding model 的 `params.batch_size` 读取，缺省 10）→ 组装 `ChunkDraft[]` → 单事务 `chunksRepository.replaceVersion(docId, targetVersion, drafts)`（delete where docId+version=target, insert new）→ 更新 document status=ready + chunkVersion。失败：捕获阶段异常，写 `documents.status=failed` + `error` + lifecycle 追加失败项，不重试（重试由用户手动触发 `POST .../parse`）。
- `ingestion.processor.ts`（新建，pg-boss subscribe handler，`QueueModule` 提供的 `subscribe` 接口注册，`singletonKey: documentId`，`retryLimit: 1`）。
- `kb-rebuild.service.ts`（新建，专责全库重建）：`startRebuild(kbId)` = 设 `building_version=active+1`，为 kb 下每个文档发布以 `targetVersion=buildingVersion` 的 ingestion 任务；`checkRebuildProgress` 或事件驱动（**决策**：轮询查询——每个文档任务完成后（无论成功失败）检查该 kb 下是否所有文档都已到终态（ready 或 failed 但已重试放弃——**决策**：只要文档到达 ready 或 failed 都算"终态"，不因为个别文档失败卡住整体重建），全部终态则原子 `activeVersion=buildingVersion, buildingVersion=null, status=ready`，随后**异步**（发一个 cleanup 任务，不在这个事务里）批量删除旧版本切片。用文档级任务完成后的回调触发检查，比后台轮询更即时、无需额外定时器。

### `apps/backend/src/modules/models/`
- `ports/model-provider.port.ts`：`ModelProviderPort` 加 `embed(config: ModelCallConfig & {texts: string[]}): Promise<{vectors: number[][]}>` 必选方法（非破坏——新增方法，`ProtocolDispatchAdapter` 需要实现，否则 TS 编译报错，强制同步实现；`testConnection` 现有调用方不受影响）。
- `adapters/protocol-dispatch.adapter.ts`：新增 `embed()` 实现，按 `(type=embedding, protocol)` 复用 `PROBE_BUILDERS` 同款查表思路，但探针 builder 返回的是"测试请求"不是"真实 embed 请求"——**决策**：新增独立 `EMBED_BUILDERS` 表（复用 `protocols/*.ts` 里已有的 base request 构造逻辑，抽出公共部分），而不是复用 `PROBE_BUILDERS`（探针请求体是最小 mock 输入，真实 embed 需要传入变长 `texts` 数组）。

### `apps/backend/src/db/schema.ts`
- 加三行 `export * from "../modules/knowledge-bases/schema"` 等（同现有 users/prompts/models 模式）。

### `apps/backend/src/app.module.ts`
- imports 数组里 `KnowledgeBasesModule`/`DocumentsModule`/`IngestionModule`/`ChunksModule` 已存在，改为从"M2 域骨架"注释块移出（单独注释这四个已是"M4 真实实现"），新增 `StorageModule`/`QueueModule` 到 `PersistenceModule` 附近的平台件区块。

### `apps/frontend/src/`
- `mocks/knowledge-bases.ts`：**删除**（不再需要，页面改走真实 API）。若 `mocks/agents.ts` 的 `tagOf`/`TagKey` 仍被其它页面（agents 页）用到则保留 `mocks/agents.ts` 本身，只删 `knowledge-bases.ts`。
- `api/client.ts`：改写 `getKnowledgeBases`（不变签名）、新增 `createKnowledgeBase`/`updateKnowledgeBase`；`getDocuments(kbId)` 路径改为嵌套 `/api/knowledge-bases/:kbId/documents`（若采纳该路由方案）；新增 `uploadDocuments(kbId, files, opts)`（`FormData`，不能走现有 `postJson` 的 JSON 序列化路径，需要新的 multipart helper）、`triggerParse(docId)`、`getDocumentLifecycle(docId)`、`updateDocumentMetadata(docId, metadata)`、`deleteDocument(docId)`、`getDocumentContent(docId)`；`getChunks` 加分页参数（`offset/limit/q`）、新增 `batchDeleteChunks(ids)`。
- `pages/admin/KnowledgeBasesPage.tsx`（重写）：`useEffect` 拉真实列表 + 建库 Modal（名称/描述/`chunkTemplate` 单选/`embeddingModelId` 下拉——下拉数据源调用现有 `getModels()` 过滤 `type==="embedding" && enabled`）。
- `pages/admin/DocumentsPage.tsx`（重写）：真实文档表 + 编辑 KB Modal（`chunkTemplate` 可改，触发重建给出确认提示）+ 上传抽屉（去掉文档级分块策略选择，加 `autoParse` 开关）+ 元数据 Modal + 生命周期抽屉（宏观 3 阶段，对齐现有 `STAGE_DEFS` UI 结构但数据源换真实 `lifecycle`）。
- `pages/admin/ChunksPage.tsx`（重写）：去掉启用/禁用两个批量按钮和每卡片开关，只留批量删除；无限滚动替代当前"全量渲染 + 假分页按钮"（当前 L373-378 的 `pageBtn` 三个 div 是纯装饰，未接分页逻辑——确认：`onClick` 均未绑定，是原型残留的静态装饰）。

## Intent / Non-goals / Forbidden shortcuts

- **必须真正落库、落盘、真实调用 embedding 模型**——不能满足"契约测试通过"就算数；用 `docker-compose --profile infra up` 起 Postgres+pgvector 后，`pnpm --filter backend test` 之外还需可手动 curl 验证一次完整链路（上传 PDF → 状态到 ready → 查得到切片），这是 007 的验收标准，plan 要留一个可执行的 verify 步骤。
- **不做**：KB 删除端点（007 Out-of-scope 明示，原型无入口）；切片 `enabled`（已删除制）；OCR；父子分块；文档级覆盖分块模板；编辑时更换 embedding；关键词 FTS 列的检索消费（tsv 列可以想加可以不加，但**不实现**关键词检索本身，那是 M5）。
- **禁止的抄近路**：不能为了让 `chunkTemplate` 改动测试通过而把"全库重建"简化成同步循环阻塞 HTTP 请求——必须走 pg-boss 异步，PATCH 立即返回 building 态。不能为了避免装 `pg-boss`/`pdf-parse`/`mammoth` 而用手写轮询表或纯文本忽略 PDF/Word 解析——四格式（PDF/Word/MD/TXT）全做是用户拍板事项，任何简化都需要先问用户。

## Acceptance criteria

1. `POST /api/knowledge-bases` 创建库需要 `chunkTemplate` + 已存在且 `type=embedding` 的 `embeddingModelId`；名称重复 → 409；embedding 模型探针非 1024 维 → 400。
2. `POST /api/knowledge-bases/:kbId/documents` 支持多文件（含 pdf/word/markdown/text），`autoParse=false` 时文档停在 `pending`，需手动 `POST /:id/parse` 才会真正入队解析。
3. 一份 PDF 端到端：上传 → （若 autoParse）状态经 `queued→processing→ready`；`GET /:id/chunks` 能查到切片，切片有 `version` 字段等于所属文档当前 `chunkVersion`。
4. `PATCH /api/knowledge-bases/:id { chunkTemplate: "qa" }` 触发全库重建：响应态为 `building`；重建期间 `GET .../chunks` 仍返回旧版本切片（不空窗）；重建完成后 `activeVersion` 递增且新切片对应新模板产物；重建中再次 PATCH 同库 → 409。
5. `POST /api/chunks/batch-delete { ids }` 物理删除给定切片；契约层无任何 `enabled` 字段残留（grep 确认 `Chunk`/`chunks` 表定义均无 enabled）。
6. 前端三页面不再 import `mocks/knowledge-bases.ts`（该文件被删除），三页面均走 `api/client.ts` 真实请求。
7. `pnpm test` 全绿（含重写后的 contracts 测试与 backend e2e 测试）；`pnpm lint` 边界规则 0 违规。

## Test plan

- **contracts**：新文件 `knowledge-schemas.test.ts` 覆盖新 schema 形状（`chunkTemplate` 合法值、`Chunk` 无 `enabled`、`ChunkBatchDeleteRequestSchema` 拒绝空数组、`DocumentStatusSchema` 5 值）；`m2-schemas.test.ts` 删除对应 it block。
- **backend unit**：`ingestion/*.spec.ts` 覆盖分块器（通用模板标题切段、问答模板 Q/A 配对、token 估算函数边界）、解析器 registry 分发（对每个 `DocumentType` 都能查到 builder，参照 `protocol-dispatch.adapter.spec.ts` 的"完整性断言"写法）；`knowledge-bases.service.spec.ts` 覆盖名称查重/维度校验/锁定 embedding/改模板触发重建/重建中再改 409（mock repository 同 `models.service.spec.ts:10-42` 的 `makeRepo` 写法）；`kb-rebuild.service.spec.ts` 覆盖版本切换的原子性与部分失败不卡住整体。
- **backend e2e**：重写 `skeleton.e2e.spec.ts:380-438` 三段为真实路由断言（需要真实测试数据库，检查现有 e2e 是否已在跑真实 PG——`auth.e2e.spec.ts`/`zod-pipe.e2e.spec.ts` 等已有先例，跟随其 test DB 设置方式）；新增 multipart 上传的 supertest 用例（`request(...).attach(...)`）。
- **frontend**：**[diff-report D2 已核实并修正]** 本仓库已有确立的"真实 API 挂载"测试模式：[apps/frontend/src/app/App.test.tsx:111-133](../../../apps/frontend/src/app/App.test.tsx) 的 `"loads ModelsPage from real /api/models on /admin/models (M3)"` 用例——mock `global.fetch`、以路由挂载页面、断言实际发出的请求 URL 列表包含目标端点，从而证明页面调用真实 API 而非本地 mock（同文件另有 PromptsPage 同款用例，line 85 起）。M4 三个 KB 页面重写后应在 `App.test.tsx` 里加同款用例：断言 `/admin/knowledge-bases` 挂载时调用 `/api/knowledge-bases`、文档页调用 `/api/knowledge-bases/:kbId/documents`、切片页调用 `/api/documents/:id/chunks`。这是具体可抄的模板，不是"对齐量级"的模糊指引。

## Risks / unknowns

- **[diff-report D1 已核实]** pgvector 扩展**已经**由 `infra/postgres/init.sql`（`CREATE EXTENSION IF NOT EXISTS vector;`，经 `infra/docker-compose.yml:13` 挂载到 `/docker-entrypoint-initdb.d/init.sql`）在容器初始化时启用，**不需要**在 M4 迁移里再建扩展。剩余真正的未知项收窄为：drizzle-kit 对 `vector(1024)` 列类型本身的生成流程（`customType` 写法）+ HNSW 索引语句仍需手工 patch 到 `drizzle-kit generate` 产出的 `.sql` 文件（drizzle-kit 不认识 `vector` 类型，只会生成它认识的列，索引需要手写 raw SQL append）。
- pg-boss 与现有 `PersistenceModule` 共用同一个 Postgres 连接池 vs 独立连接池，需要在 plan 里明确（pg-boss 有自己的 schema 迁移机制，可能与 Drizzle migration 顺序有交互，需要先起 pg-boss 建自身 schema 再或不影响业务表迁移——待验证）。
- 前端上传大文件（20MB）走 JSON POST 的 `postJson` helper 不适用（helper 固定 `Content-Type: application/json` + `JSON.stringify`），需要新的 multipart 专用函数，且 `apiFetch`（`client.ts:72-85`）本身不设 Content-Type 时用 FormData 自动带 boundary——需确认 `apiFetch` 对 FormData body 不会被误加 `Content-Type: application/json`（当前逻辑：`if (opts.body && !headers.has("Content-Type"))` 会给任何非空 body 加 JSON header，包括 FormData！**这是一个真实 bug 需要 plan 修复**：`apiFetch` 需要判断 body 类型，FormData 时不设 Content-Type 由浏览器自动带 boundary）。
