# Dev Ledger — M4 (27 stories, 10 waves; base 42fe004) — ✅ 全部完成

Story T22: "skeleton.e2e 重写" — complete (PASS after P3 fix, Codex 跨模型评审)
  Commits: f5fad12, 6d0f7fc
  Files: apps/backend/test/skeleton.e2e.spec.ts
  Produces: M4 三域 e2e（jest.mock pg-boss ESM 桩 + AppConfigModule + env 兜底 + 五个 override：三仓储/BLOB_STORE/INGESTION_QUEUE）；探针明文/重名409/strictObject 400/空库直切/building+409/整批校验无部分提交/幂等入队 opts/生命周期/元数据/内容/级联删/分页空页/limit 400/批删真实计数；OpenAPI 新旧路由断言
  Concerns: batch-delete 断言 201（landed T20 无 @HttpCode，Nest POST 默认；brief 样例 200 系笔误）。

Story T1: "契约重写 — chunks.ts" — complete (PASS)
  Commits: 3090eb4
  Files: packages/contracts/src/chunks.ts, packages/contracts/src/knowledge-schemas.test.ts, packages/contracts/src/m2-schemas.test.ts
  Produces: ChunkSchema（含 version，无 enabled）、ChunkPageResponseSchema{items,total,offset,limit,hasMore}、ChunkListQuerySchema{offset,limit≤100,q?}（coerce+defaults 0/20）、ChunkBatchDeleteRequestSchema{ids:string[] min1}、ChunkBatchDeleteResponseSchema{deletedCount}
  Concerns: 契约破坏使 3 个后续重写目标暂时编译不过（chunks.controller.ts / 前端 client.ts / skeleton.e2e.spec.ts）——由 T20/T23/T22 重写解决；contracts 包自身测试全绿。

Story T4: "后端依赖 + 配置新增" — complete (PASS_WITH_CONCERNS)
  Commits: 5b476b4
  Files: apps/backend/package.json, pnpm-lock.yaml, apps/backend/src/platform/config/config.schema.ts, apps/backend/src/platform/config/config.service.ts, apps/backend/.env.example, apps/backend/test/config.schema.spec.ts
  Produces: AppConfigService.blobStorePath（默认 "./.data/blobs"）、AppConfigService.ingestionEmbedBatchSize（env INGESTION_EMBED_BATCH_SIZE，默认 10，正整数校验）；依赖 pg-boss/pdf-parse(^2.4.5)/mammoth/@types/multer 已装
  Concerns: 见 concerns.md（pdf-parse v2 与 @types/pdf-parse v1 版本错位，T13 需验证 import 兼容）。

Story T7: "pgvector 列类型 helper" — complete (PASS)
  Commits: 549afb3
  Files: apps/backend/src/platform/persistence/pgvector-type.ts, apps/backend/test/pgvector-type.spec.ts
  Produces: vector1024(columnName) — Drizzle customType，SQL 类型 "vector(1024)"，number[] ↔ pgvector 文本格式 "[x,y,...]" 往返
  Concerns: brief 测试构造方式经 pgTable 修正（行为等价，评审确认）。

Story T12: "ModelProviderPort 加 embed() + EMBED_BUILDERS" — complete (PASS after fix round 1)
  Commits: 737fd9a, 368bc1a
  Files: apps/backend/src/modules/models/ports/model-provider.port.ts, apps/backend/src/modules/models/adapters/embed-builders.ts, apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts, apps/backend/src/modules/models/models.service.ts, apps/backend/test/embed-builders.spec.ts, apps/backend/test/protocol-dispatch.adapter.spec.ts
  Produces: ModelProviderPort.embed(config, texts): Promise<{vectors: number[][]}>；ModelsService.embedTexts(modelId, texts): Promise<number[][]>（域内解密；embed 结果强校验：count==texts.length、逐向量数字数组、维度==1024，按 data[].index 重排序）
  Concerns: embedTexts 不校验模型 type/enabled——T15/T18 消费方负责（T18 评审须确认）。

Story T2: "契约重写 — documents.ts" — complete (PASS)
  Commits: 7dc3e4d
  Files: packages/contracts/src/documents.ts, packages/contracts/src/knowledge-schemas.test.ts, packages/contracts/src/m2-schemas.test.ts
  Produces: DocumentStatusSchema(5值 pending/queued/processing/failed/ready)、DocumentSchema{+metadata record<string,string> default{}, +chunkVersion int+ nullable}、DocumentLifecycleStageSchema{stage,status,startedAt,endedAt,error}、DocumentLifecycleResponseSchema{stages}、UpdateDocumentMetadataRequestSchema、DocumentContentResponseSchema、UploadDocumentsResponseSchema；已删除 CreateDocumentRequestSchema/IngestionStatusSchema
  Concerns: none（消费方破坏属计划内，由 T19/T22/T23 重写）。

Story T5: "platform/storage BlobStore" — complete (PASS)
  Commits: 60d3a4d
  Files: apps/backend/src/platform/storage/blob-store.port.ts, blob-store.constants.ts, local-fs-blob-store.adapter.ts, storage.module.ts, apps/backend/test/local-fs-blob-store.spec.ts
  Produces: BLOB_STORE token、BlobStore{put(key,Buffer)/get(key)/delete(key)}；LocalFsBlobStore（blobStorePath 落盘、自动建子目录、拒绝 ..、绝对路径）；StorageModule exports [BLOB_STORE]
  Concerns: none（isAbsolute 加固经评审确认为合法强化）。

Story T13: "ingestion 解析器注册表" — complete (PASS_WITH_CONCERNS)
  Commits: 2b126c2
  Files: apps/backend/src/modules/ingestion/ports/document-parser.port.ts, adapters/parsers/{pdf,word,text}-parser.ts, adapters/parsers/parser-registry.ts, apps/backend/test/parser-registry.spec.ts
  Produces: DocumentParserPort.parse(buffer): Promise<{text}>；PARSER_REGISTRY: Record<DocumentType, DocumentParserPort>（pdf 用 pdf-parse v2 PDFParse 类、word 用 mammoth、md/text utf-8）；空文本（扫描件）抛可读错误（按 pages[].text 判定）
  Concerns: 见 concerns.md（PDF 真实 happy-path 无法在当前 Jest 配置下跑，T15 需补）。

Story T6: "platform/queue pg-boss 封装" — complete (PASS after fix round 1)
  Commits: 7d90bc6, d151b40
  Files: apps/backend/src/platform/queue/queue.port.ts, queue.constants.ts, pg-boss-queue.adapter.ts, queue.module.ts, apps/backend/test/pg-boss-queue.adapter.spec.ts
  Produces: INGESTION_QUEUE token、Queue{publish(jobName,data,opts{singletonKey?,retryLimit?})/subscribe(jobName,handler)}；pg-boss v12 命名导入 `import { PgBoss }`；adapter 内部 ensureQueue（createQueue 惰性幂等，in-flight Promise 缓存，失败驱逐重试）；QueueModule exports [INGESTION_QUEUE]
  Concerns: publish 默认 retryLimit ?? 0——T16 必须显式传 retryLimit:1；QueueModule 需 T21 挂入 AppModule。

Story T3: "契约重写 — knowledge-bases.ts" — complete (PASS)
  Commits: 8aee2f8
  Files: packages/contracts/src/knowledge-bases.ts, packages/contracts/src/knowledge-schemas.test.ts, packages/contracts/src/m2-schemas.test.ts
  Produces: ChunkTemplateSchema=z.enum(["general","qa"])、KnowledgeBaseSchema{+chunkTemplate,+activeVersion int+,+buildingVersion int+ nullable}、CreateKnowledgeBaseRequestSchema（chunkTemplate/embeddingModelId 必填）、UpdateKnowledgeBaseRequestSchema（name/desc/chunkTemplate，无 embeddingModelId，锁定注释在契约）
  Concerns: none.

Story T9: "documents 域 schema + repository" — complete (PASS_WITH_CONCERNS)
  Commits: 8e828ea
  Files: apps/backend/src/modules/documents/schema.ts, apps/backend/src/modules/documents/documents.repository.ts
  Produces: documents 表（uuid pk、kbId FK→knowledgeBases.id cascade、metadata jsonb default {}、status text default "pending"、chunkVersion int nullable、lifecycle jsonb default []、error、uploadedAt/updatedAt）；DocumentRow/NewDocument/LifecycleStageRow；DocumentsRepository{find/findById/findByKb/insert/update/appendLifecycleStage/delete}
  Concerns: appendLifecycleStage 为 RMW 非原子（plan-mandated，见 concerns.md）；schema.ts import ../knowledge-bases/schema——T8 落地前暂不编译（本波已知，W4 解决）。

Story T8: "knowledge-bases 域 schema + repository" — complete (PASS)
  Commits: 5c6d767
  Files: apps/backend/src/modules/knowledge-bases/schema.ts, apps/backend/src/modules/knowledge-bases/knowledge-bases.repository.ts
  Produces: knowledgeBases 表（id uuid pk、name unique、desc、chunkTemplate text、embeddingModelId uuid、status default "ready"、activeVersion int default 1、buildingVersion int nullable、createdAt/updatedAt）；KnowledgeBasesRepository{find/findById/findByName/insert/update/updateVersions/delete}；updateVersions 仅接受 {activeVersion?,buildingVersion?,status?}（类型级限制）
  Concerns: none.

Story T10: "chunks 域 schema + repository" — complete (PASS)
  Commits: 2f4edcd
  Files: apps/backend/src/modules/chunks/schema.ts, apps/backend/src/modules/chunks/chunks.repository.ts
  Produces: chunks 表（vector1024 embedding、version/seq/text/tokenCount/section、docId FK cascade、kbId FK cascade）；ChunkRow/NewChunk/ChunkDraft{seq,text,tokenCount,section,embedding}（无 id）；ChunksRepository{findPage(docId, version, {offset,limit,q?})、replaceVersion(docId, kbId, version, drafts) 单事务、batchDelete(ids)、deleteByVersion(kbId, version)}——注意签名含 version/kbId
  Concerns: q ILIKE 未转义通配符（plan-mandated，见 concerns.md）。

Story T23: "前端 api/client.ts" — complete (PASS)
  Commits: 423a50f
  Files: apps/frontend/src/api/client.ts, apps/frontend/src/api/client.test.ts
  Produces: apiFetch FormData 修复（instanceof 判断）；createKnowledgeBase/updateKnowledgeBase/uploadDocuments(multipart files+autoParse)/triggerParse/getDocumentLifecycle/updateDocumentMetadata/deleteDocument/getDocumentContent/getDocumentChunks(offset,limit,q)/batchDeleteChunks；getDocuments 仍为 /api/documents?kbId=（brief 定案）；id 全部 encodeURIComponent
  Concerns: contracts dist 过期会导致前端本地构建失败——需 `pnpm --filter @codecrush/contracts build`（T24-26 实现者注意）。

Story T11: "db barrel + M4 迁移" — complete (PASS)
  Commits: a943452
  Files: apps/backend/src/db/schema.ts, apps/backend/drizzle/0006_curly_krista_starr.sql, apps/backend/drizzle/meta/{0006_snapshot.json,_journal.json}
  Produces: 三张表已在真实 PG 落地并验证（vector(1024) 列、chunks_embedding_hnsw_idx (vector_cosine_ops)、chunks_doc_version_seq_unique、chunks_kb_version_idx、全部 cascade FK、kb.name unique）；HNSW 不进 snapshot 无 generate 漂移
  Concerns: none.

Story T15: "默认管线编排" — complete (PASS_WITH_CONCERNS)
  Commits: 83351bc
  Files: ingestion/ports/ingestion-pipeline.port.ts, ingestion/default-ingestion-pipeline.ts, test/default-ingestion-pipeline.spec.ts
  Produces: IngestionPipelinePort.run({documentId,kbId,docType,chunkTemplate,embeddingModelId,targetVersion,blob}): Promise<{chunkCount,parsedText}>；DefaultIngestionPipeline 构造参数 (modelsService, chunksRepository, embedBatchSize: number)——接线方须传 appConfig.ingestionEmbedBatchSize
  Concerns: chunkCount=0 时静默成功并清空 targetVersion——host 裁定 T16 须把 chunkCount===0 视为失败（见 concerns.md）。

Story T16: "队列 processor + IngestionService" — complete (PASS)
  Commits: c244e84
  Files: ingestion/{ingestion-job.constants.ts,ingestion.constants.ts,ingestion.service.ts,ingestion.processor.ts,ingestion.module.ts}, 删除 ingestion.controller.ts, test/ingestion.service.spec.ts
  Produces: IngestionService.enqueue(documentId, targetVersion)（置 queued + publish {singletonKey:documentId, retryLimit:1}）；IngestionService.processDocument(documentId)（queued→processing→ready/failed，chunkCount=0→failed，异常吞掉不重试，lifecycle 逐阶段记录）；INGEST_DOCUMENT_JOB 常量；IngestionModule imports Models/Queue/Storage 模块、直接 provide 三个 repo（避免循环依赖）、pipeline 工厂注入 embedBatchSize
  Concerns: 成功路径 ingest/running lifecycle 项不闭合（plan-mandated，UI 若按 lifecycle 渲染须以 status 为准——T25 注意）；QueueModule/StorageModule 由 IngestionModule 首次实例化（T21 仍应挂 AppModule 顶层）。

Story T24: "KnowledgeBasesPage 重写" — complete (PASS_WITH_CONCERNS)
  Commits: dd6dabc
  Files: apps/frontend/src/pages/admin/KnowledgeBasesPage.tsx
  Produces: 真实 getKnowledgeBases/createKnowledgeBase/getModels 接线；路由 /admin/knowledge-bases/:kbId(真实 id)/documents；building 态 3s 轮询
  Concerns: 双击可能双 POST（低危）；打开 Modal 前同步等 getModels（plan-mandated）；保留 mocks/agents 的 tagOf 纯配色 import（非数据 mock，T27 勿删 agents mock）。

Story T17: "kb-rebuild 蓝绿重建" — complete (PASS after fix round 1)
  Commits: d3610be, a5bfea1
  Files: ingestion/kb-rebuild.service.ts, ingestion.service.ts, ingestion.module.ts, test/{kb-rebuild.service,ingestion.service}.spec.ts
  Produces: KbRebuildService.startRebuild(kbId)（building=active+1+status building，全量 enqueue，空库直切；已在重建→BadRequestException）；onDocumentTerminal(kbId)（全终态→原子切换+异步 cleanup 旧版本）；DOCUMENT_TERMINAL_LISTENER token（useExisting 绑定）；终态回调完全隔离（单调用点在 try/catch 外+自吞异常，不双触发）
  Concerns: 多 worker 并发双切换竞态开放（单进程 pg-boss 顺序消费下不可达，见 concerns.md）；cleanup 失败仅 warn（孤儿旧切片待 GC）。

Story T25: "DocumentsPage 重写" — complete (PASS after fix round 1)
  Commits: 48330be, e2d671f
  Files: apps/frontend/src/pages/admin/DocumentsPage.tsx
  Produces: 真实文档表+KB摘要/编辑（改模板确认+409 提示）+上传抽屉（20MB/100 预检+autoParse）+元数据+生命周期抽屉（status 派生头部）+pending「开始解析」/failed「重试」+队列态 3s 轮询
  Concerns: failed 态两处按钮文案 重试/重新解析 不一致（P3 记录）。

Story T26: "ChunksPage 重写" — complete (PASS after fix round 1)
  Commits: 50fe971, d70a24f
  Files: apps/frontend/src/pages/admin/ChunksPage.tsx
  Produces: 无限滚动（IntersectionObserver+代际守卫防竞态）+300ms 防抖搜索+批量删除+原文查看
  Concerns: none.

Story T18: "KnowledgeBasesService+Controller" — complete (PASS after fix round 1)
  Commits: 0ac616b, c38279c
  Files: knowledge-bases.{service,controller,module}.ts, test/knowledge-bases.service.spec.ts, packages/contracts/src/knowledge-bases.ts(strictObject), knowledge-schemas.test.ts
  Produces: POST（重名409/type+enabled校验400/1024探针400）/GET/PATCH（strictObject: 未知键→400；改模板→startRebuild 异步；重建中→409）
  Concerns: 探针 catch-all→400（网络故障也 400）；重名竞态 unique 兜底裸 500；startRebuild 内部 400 vs service 409（不可达路径）——均记录。

Story T19: "DocumentsService+Controller multipart" — complete (PASS after fix round 1)
  Commits: b8be2dd, 4d48a35
  Files: documents.{service,controller,module}.ts, test/documents.service.spec.ts
  Produces: POST /api/knowledge-bases/:kbId/documents（multer interceptor 20MB/100、整批先校验后落副作用、blob key 服务端生成 kb/{kbId}/{docId}/original.{type}、autoParse 两态）；parse/lifecycle/metadata/delete（blob先删失败warn）/content/list?kbId=
  Concerns: multer 超限→500 无异常过滤器（F2）；GET /api/documents 缺 kbId 返回 []（F3）——记录。

Story T20: "ChunksService+Controller" — complete (PASS)
  Commits: b88c036
  Files: chunks.{service,controller,module}.ts, test/chunks.service.spec.ts
  Produces: GET /api/documents/:id/chunks（doc.chunkVersion 过滤、null→空页、404、hasMore）；POST /api/chunks/batch-delete；响应映射剔除 embedding
  Concerns: none.

Story T21: "app.module 接线" — complete (PASS)
  Commits: 550ff13
  Files: apps/backend/src/app.module.ts
  Produces: StorageModule/QueueModule 顶层接入；真实 boot 验证（/health 200 db up）
  Concerns: none.

Story T27: "mock 清理 + App.test 接线" — complete (PASS)
  Commits: acfcdc9
  Files: apps/frontend/src/app/App.test.tsx, 删除 apps/frontend/src/mocks/knowledge-bases.ts
  Produces: 三页面接线测试（fetch mock 断言真实端点）；IntersectionObserver 测试桩
  Concerns: none.

Story T14: "清洗+token估算+分块器" — complete (PASS after fix round 1)
  Commits: d7036ae, 7579ec9
  Files: ingestion/pipeline/{clean-text,estimate-tokens}.ts, ports/chunker.port.ts, adapters/chunkers/{general-chunker,qa-chunker,chunker-registry}.ts, test/{estimate-tokens,chunkers}.spec.ts
  Produces: cleanText(text)、estimateTokens(text)（CJK+非CJK/4 上取整）、ChunkerPort.chunk(text): {seq,text,section}[]、CHUNKER_REGISTRY{general,qa}（qa 无配对时回落 general）
  Concerns: MAX_TOKENS 是软上限（超长单段不再切，brief 设计如此）。
