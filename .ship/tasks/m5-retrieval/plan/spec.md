# Spec — M5 检索(Retrieval)实现

Task ID: `m5-retrieval` · 分支: `feat/m5-retrieval` · HEAD: `72f7ab443dce67686664b948aa37de5252eb2ecd`

## Problem / Motivation

`retrieval` 模块目前是 M2 桩:`RetrievalService.test()`(`apps/backend/src/modules/retrieval/retrieval.service.ts:1`)无条件返回一条硬编码的 mock hit,不读数据库、不调模型。前端 `RetrievalTestPage.tsx`(`apps/frontend/src/pages/admin/RetrievalTestPage.tsx:1`)是手写 `<select>`/`<input>` DOM 元素,用本地函数 `computeRtResults`(`apps/frontend/src/mocks/retrieval.ts`)在浏览器里现算分数,不调后端 API,也没用 antd。

本任务把这两者换成真实实现,依据已定稿的架构设计 [`docs/design/008-m5-retrieval.md`](../../../docs/design/008-m5-retrieval.md)(下称"008")——**本 spec 不重新讨论 008 里已经拍板的架构决策(加权线性融合公式、中文 bigram 分词方案、rerank 端口协议形状、阈值语义、模块边界),只负责把这些决策转成可执行的文件级改动。**

## Design approach

原样采用 008 的设计,不做变更。核心组件:

1. `ModelProviderPort` 新增 `rerank()`,`RERANK_BUILDERS` 镜像 `EMBED_BUILDERS` 模式。
2. `chunks` 表新增 `tsv` 生成列 + GIN 索引(新迁移),`ChunksRepository` 新增 `searchByVector`/`searchByKeyword`。
3. `retrieval` 模块新增 `RetrieverPort` + `PgHybridRetriever` 适配器,`RetrievalService` 改为调用真实端口而非返回硬编码值。
4. `packages/contracts/src/retrieval.ts` 补 `rerankThreshold` 字段。
5. `RetrievalTestPage.tsx` 改用 antd 组件 + 真实 `POST /retrieval/test`。

## Investigation findings

### 现状代码(逐条读过,非猜测)

- `packages/contracts/src/retrieval.ts:1-31` — `RetrievalTestRequestSchema` 已有 `query/kbId/embedModelId/topK/threshold/multi/vecWeight?/rerankModelId?/topN?`,**没有 `rerankThreshold`**(008 已指出的契约缺口,需补)。`RetrievalHitSchema` 已有 `vecScore/kwScore?/rerankScore?/finalScore`,均 `.min(0).max(1)`。
- `apps/backend/src/modules/chunks/schema.ts:1-27` — `chunks` 表无 `tsv` 列;`chunks_kb_version_idx` 是 btree(kbId,version)。migration `0006_curly_krista_starr.sql:49` 手写了 `CREATE INDEX IF NOT EXISTS "chunks_embedding_hnsw_idx" ... USING hnsw ("embedding" vector_cosine_ops)`(HNSW 已就位,不用建)。
- `apps/backend/src/modules/chunks/chunks.repository.ts:1-97` — 现有方法:`findPage/countByDocs/countByKbVersions/replaceVersion/batchDelete/deleteByVersion`,均是纯 Drizzle 查询,**没有任何方法有独立单测**(单测只测 `ChunksService`,repository 被 mock)。
- `apps/backend/src/modules/models/ports/model-provider.port.ts:1-31` — `ModelProviderPort` 只有 `testConnection()`/`embed()`,无 `rerank()`。
- `apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts:31-45` — `PROBE_BUILDERS` 已含 5 个 `rerank:*` 探针(`self_hosted/openai_compat/cohere/jina/dashscope`),都是最小 ping payload(`{query:"ping",documents:["ping","pong"],top_n:1}` 或等价),真实 `RERANK_BUILDERS` 要把这些换成接收真实 `documents: string[]` 的版本。
- `apps/backend/src/modules/models/adapters/protocols/*.ts` — 5 个协议的 rerank 探针函数与响应形状(008 已列表,与代码一致,已核对):`self_hosted`(TEI,顶层数组 `[{index,score}]`)、`cohere`/`jina`(`{results:[{index,relevance_score}]}`)、`openai_compat`(`/reranks`,`{results:[...]}`或`{data:[...]}`)、`dashscope`(`{output:{results:[...]}}`)。
- `apps/backend/src/modules/models/adapters/embed-builders.ts:1-81` — `EMBED_BUILDERS: Record<ModelProtocol, EmbedBuilder>`,`EmbedBuilder = (config, texts) => {url,headers,body,parseResponse}`,`RERANK_BUILDERS` 要镜像这个形状但多一个 `query` 参数。
- `apps/backend/src/modules/models/models.service.ts:117-132` — `embedTexts(modelId, texts)` 的模式:`mustFind(modelId)` 查行 → 解密 key → 调 `this.provider.embed(config, texts)`。`rerankTexts` 要镜像此模式。
- `apps/backend/src/modules/models/models.module.ts:1-14` — `MODEL_PROVIDER_PORT` token 绑定 `ProtocolDispatchAdapter`,模块导出 `ModelsService, MODEL_PROVIDER_PORT`。
- `apps/backend/src/modules/knowledge-bases/schema.ts:1-23` — `activeVersion: integer().notNull().default(1)`。`knowledge-bases.service.ts:51-53` — `get(id)` 返回含 `activeVersion` 的完整行(经 `withCounts` 包装)。
- `apps/backend/src/modules/knowledge-bases/knowledge-bases.module.ts:1-30` — `exports: [KnowledgeBasesRepository, KnowledgeBasesService]`;模块内直接 `providers: [ChunksRepository, ...]` 而不 `import ChunksModule`,注释明确写明原因是"避免与 ChunksModule→DocumentsModule→KnowledgeBasesModule 的既有边形成环"。**`retrieval` 没有这个环风险**(没有任何模块 import `RetrievalModule`),可以直接 `imports: [ChunksModule, ModelsModule, KnowledgeBasesModule]`,不需要复刻这个绕过手法。
- `apps/backend/src/modules/chunks/chunks.module.ts:1-15` — `imports: [DocumentsModule]`,`exports: [ChunksRepository, ChunksService]`。
- `apps/backend/src/modules/retrieval/retrieval.module.ts:1-8` — 目前只 `providers: [RetrievalService]`,无 imports。
- `apps/backend/src/modules/retrieval/retrieval.controller.ts:1-17` — `POST /retrieval/test` 已经用 `createZodDto(RetrievalTestRequestSchema)` + `RetrievalService.test()`,**控制器本身不用改**,只要 `RetrievalService.test()` 签名不变(仍是 `(req: RetrievalTestRequest) => Promise<RetrievalTestResponse>` 或同步——现在是同步返回,真实实现要接 DB/网络调用,必须改成 `async`,controller 的 `test()` 方法要加 `async`/`await` 或依赖 NestJS 自动 await Promise 返回值——需确认 NestJS 是否自动 await 非 Promise 类型返回值的 controller 方法:NestJS 对 controller 方法的返回值,如果是 Promise 会自动 await,这是框架标准行为,无需额外处理,但 controller 方法签名的 TS 类型注解 `RetrievalTestResponse` 需要改成 `Promise<RetrievalTestResponse>`)。
- `packages/otel-conventions/src/index.ts:14-37` — `OTEL_OPERATIONS.RETRIEVE/RERANK/KEYWORD_RECALL` 与 `RAG.RETRIEVAL_TOP_K/TOP_N/THRESHOLD/MULTI_RECALL/CHUNK_SCORES` 已存在;`RAG.VEC_WEIGHT`/`RAG.RERANK_THRESHOLD` 不存在,需新增(008 已定)。
- `packages/otel/src/trace.ts:1-77` — 只有通用 `withSpan()`,无 `trace.retrieve/rerank` 语义封装(008 已定:M5 不建,直接用 `withSpan`)。
- Postgres 容器(`codecrush-postgres-1`,`pgvector/pgvector:pg16`)已在架构设计阶段实测:`to_tsvector('simple', body)` 可用于 `GENERATED ALWAYS AS ... STORED`;`pg_available_extensions` 里没有 zhparser/jieba,只有 `pg_trgm`(未安装)。

### 前端现状

- `apps/frontend/src/pages/admin/RetrievalTestPage.tsx` — 手写 `<select>`/`<input type="range">`/`<textarea>`,内联 style 对象(`card/cardHead/fieldLabel/selectStyle`),本地 state 驱动 `computeRtResults()`(纯前端计算,不调 API)。**没有 rerank 阈值输入、没有按来源文件筛选、没有"带入 Agent"底部操作栏**(这些在 008 里已判定为 out-of-scope 或需要接后端)。
- `apps/frontend/src/pages/admin/KnowledgeBasesPage.tsx`、`ChunksPage.tsx`、`DocumentsPage.tsx`、`PromptsPage.tsx` 均已用 antd(`import ... from "antd"`),是本任务前端重写要对齐的参考对象——需要在写 plan 前专门读一遍这几个页面里 `Select`/`Slider`/`Switch`/`InputNumber` 的用法惯例(**本 spec 未读,留给 plan 阶段第一个 story 去读**,标记为已知缺口)。
- `apps/frontend/package.json` — `antd: "^6.5.0"`,已装,无需新增依赖。

### 测试惯例(关键,决定测试怎么写)

- 所有后端测试在 `apps/backend/test/`(**不是**和 `src/modules/**` colocate),命名 `*.spec.ts`,Jest + `@swc/jest`(`apps/backend/jest.config.js:1-23`)。
- **模式 A(纯函数/协议 builder)**:`apps/backend/test/embed-builders.spec.ts` 直接构造 `ModelCallConfig`,断言 `EMBED_BUILDERS[protocol](cfg, texts)` 返回的 `{url,body}` 与 `parseResponse(mockJson)`——不碰网络、不碰 DB。`RERANK_BUILDERS` 要照此镜像。
- **模式 B(service,仓储被 mock)**:`apps/backend/test/chunks.service.spec.ts` 用 `jest.fn()` 手工构造 `ChunksRepository`/`DocumentsRepository` 的最小接口子集,注入进真实 `ChunksService`,断言调用参数与返回值映射。**`ChunksRepository` 本身没有任何一个方法有直接单测**——`searchByVector`/`searchByKeyword` 延续这个先例,不必单独测,由更上层(`PgHybridRetriever`/`RetrievalService`)以 mock 掉 `ChunksRepository` 的方式测融合/降级/阈值这些真正的业务逻辑。
- **模式 C(e2e,repository/port 用内存假实现覆盖)**:`apps/backend/test/skeleton.e2e.spec.ts:355-402` 用 `Test.createTestingModule` 装真实 `*Module`,再 `.overrideProvider(XxxRepository).useValue(inMemoryXxxRepo)` 把仓储换成内存假实现,`MODEL_PROVIDER_PORT` 换成 `fakeModelProviderPort`(jest.fn 组成)。**已有 `POST /api/retrieval/test` 的两个用例(第 854-877 行)**,用假 `kbId:"kb1"` 断言 200+schema 与 400。M5 落地后这两个用例仍要能过,但 `RetrievalService` 会真的去调 `ChunksRepository.searchByVector/searchByKeyword`(现在 `inMemoryChunksRepo` 大概率没有实现这两个新方法)与 `KnowledgeBasesService.get()`——**需要扩展 `inMemoryChunksRepo`/新增 `fakeModelProviderPort.rerank`,否则这两个既有用例会因为调用了 mock 上不存在的方法而报错**。这是本次实现必须处理的既有测试维护点,不是新增测试。
- **没有任何测试连接真实 Postgres**(`grep DRIZZLE/DATABASE_URL/persistence.module` 命中的 4 个文件里,DB 相关 provider 全部被 `.overrideProvider` 替换成内存假实现;`process.env.DATABASE_URL` 只是给 `AppConfigModule` 校验用的占位连接串,不会被真正连接)。**这意味着 `searchByVector`/`searchByKeyword` 里 pgvector `<=>` 排序、`tsv`/`ts_rank_cd` 匹配这些真实数据库行为,不会被任何自动化测试验证**——这是本 spec 明确接受的空白,依赖 `/ship:qa` 阶段对着真实 docker-compose Postgres 跑一遍检索测试台手动验证(与本项目现有测试文化一致,而不是发明一个新的"连真实 DB 的集成测试"套路)。**这是一个需要向用户明确确认的决策,不是默认可以自行拍板的**,见 Risks 一节。

### Migration 编号

`apps/backend/drizzle/` 最新是 `0007_wide_giant_girl.sql`(`apps/backend/drizzle/meta/_journal.json` 确认 idx 7 是最后一条)。`db:generate` 用 `drizzle-kit generate`(`apps/backend/package.json:11`)——**`tsv` 生成列 + `cjk_bigram_text` 函数 + GIN 索引,`drizzle-kit generate` 从 schema.ts 的变更推导不出生成列表达式与自定义 SQL 函数**,需要走 drizzle-kit 的自定义迁移(`drizzle-kit generate --custom` 或手写 `.sql` 文件 + 手动登记 `_journal.json`)——具体走哪条路径留给 plan 阶段验证 `drizzle-kit` 版本支持情况。

## Changes by file

### 后端

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/retrieval.ts` | `RetrievalTestRequestSchema` 加 `rerankThreshold: z.number().min(0).max(1).optional()` |
| `packages/otel-conventions/src/index.ts` | `RAG` 常量加 `VEC_WEIGHT: "rag.retrieval.vec_weight"`、`RERANK_THRESHOLD: "rag.rerank.threshold"` |
| `apps/backend/src/modules/models/ports/model-provider.port.ts` | `ModelProviderPort` 加 `rerank(config, query, documents, topN?): Promise<{results:{index:number;score:number}[]}>` |
| `apps/backend/src/modules/models/adapters/rerank-builders.ts`(新建) | `RERANK_BUILDERS: Record<ModelProtocol, RerankBuilder>`,5 协议,镜像 `embed-builders.ts` |
| `apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts` | `ProtocolDispatchAdapter` 实现 `rerank()`,新增 `RERANK_TIMEOUT_MS = 5_000` 常量,复用 `redactSecret`/`upstreamError` |
| `apps/backend/src/modules/models/models.service.ts` | 新增 `rerankTexts(modelId, query, texts, topN?)`,镜像 `embedTexts` |
| `apps/backend/drizzle/000X_m5_retrieval.sql`(新建,编号紧接 0007) | `cjk_bigram_text` SQL 函数 + `chunks.tsv` 生成列 + GIN 索引 |
| `apps/backend/src/modules/chunks/schema.ts` | 加 `tsv` 列的 Drizzle 类型声明(供类型检查/查询构造用,DDL 由上面的手写迁移负责,不是 `drizzle-kit generate` 自动产出) |
| `apps/backend/src/modules/chunks/chunks.repository.ts` | 新增 `searchByVector(kbId, version, embedding, limit)`、`searchByKeyword(kbId, version, query, limit)`;两者都 `leftJoin documents` 直接带出 `docName`(`chunks.module.ts` 已 `imports: [DocumentsModule]`,`schema.ts` 已 import `documents` 表对象,不新增依赖边;`DocumentsRepository` 没有按 id 批量取名的方法,不新建,直接在这两个查询里 join 更省一次往返也不用新增跨模块依赖) |
| `apps/backend/src/modules/chunks/chunks.service.ts` | 新增薄透传方法 `searchByVector`/`searchByKeyword`,直接转调 repository 同名方法(008 已定:`retrieval` 经 `ChunksService` barrel 调用,不直接注入 `ChunksRepository`,即便 `ChunksModule` 的 `exports` 数组里两者都在) |
| `apps/backend/src/modules/retrieval/retriever.constants.ts`(新建) | `RETRIEVER_PORT = Symbol("RETRIEVER_PORT")`,镜像 `model-provider.constants.ts` 的单 Symbol 写法 |
| `apps/backend/src/modules/retrieval/ports/retriever.port.ts`(新建) | `RetrieverPort` 接口,对齐 008/001 的契约形状 |
| `apps/backend/src/modules/retrieval/adapters/pg-hybrid-retriever.adapter.ts`(新建) | `PgHybridRetriever implements RetrieverPort`:embed 查询 → 双路召回(Promise.allSettled)→融合→阈值→截断候选池→可选 rerank→阈值→排序截断 topN→JOIN 取 docName |
| `apps/backend/src/modules/retrieval/retrieval.service.ts` | `test()` 改 `async`,注入 `RETRIEVER_PORT` token,调用 `RetrieverPort.retrieve()` |
| `apps/backend/src/modules/retrieval/retrieval.controller.ts` | `test()` 方法签名改 `Promise<RetrievalTestResponse>` |
| `apps/backend/src/modules/retrieval/retrieval.module.ts` | `imports: [ChunksModule, ModelsModule, KnowledgeBasesModule]`,`providers` 加 `{ provide: RETRIEVER_PORT, useClass: PgHybridRetriever }`(镜像 `models.module.ts` 里 `MODEL_PROVIDER_PORT` 的绑定写法) |

### 测试

| 文件 | 改动 |
|---|---|
| `apps/backend/test/rerank-builders.spec.ts`(新建) | 镜像 `embed-builders.spec.ts`,5 协议表完整性 + 各协议请求体/响应解析 |
| `apps/backend/test/protocol-dispatch.adapter.spec.ts` | 加 `rerank()` 的成功/超时/降级用例 |
| `apps/backend/test/models.service.spec.ts` | 新增 `rerankTexts` 用例,镜像现有 `embedTexts` 用例的写法 |
| `apps/backend/test/retrieval.service.spec.ts`(新建) | mock `ChunksService`/`ModelsService`/`KnowledgeBasesService`,覆盖:multi 开关分支、rerank 开关分支、阈值语义(Invariant 2)、三种降级路径(向量硬失败/关键词降级/rerank 降级)、候选池上限 |
| `apps/backend/test/skeleton.e2e.spec.ts` | 扩展 `inMemoryChunksRepo` 加 `searchByVector`/`searchByKeyword`(含 `docName`);`fakeModelProviderPort` 加 `rerank`;确认现有两个 retrieval 用例仍过 |
| `packages/contracts/src/m2-schemas.test.ts` | 加 `rerankThreshold out of range` 拒绝用例(镜像第 161-163 行既有的 `threshold out of range` 写法);确认现有 `retrievalReq`/`retrievalHit` fixture 因 `rerankThreshold` 是 optional 而不受影响 |

### 前端

| 文件 | 改动 |
|---|---|
| `apps/frontend/src/pages/admin/RetrievalTestPage.tsx` | 整页重写:antd `Select`/`Slider`/`InputNumber`/`Switch`/`Button`/`Card`/`Tag` 替换手写 DOM;接 `POST /api/retrieval/test`;去掉本地 `computeRtResults` 依赖 |
| `apps/frontend/src/mocks/retrieval.ts` | 若 `RetrievalTestPage.tsx` 不再使用,评估是否删除(先确认无其他消费方) |
| `apps/frontend/src/api/client.ts` | **无需改动**——`testRetrieval(body): Promise<RetrievalTestResponse>` 已存在(`client.ts:349-351`,已接好 `RetrievalTestRequestSchema`/`RetrievalTestResponseSchema` 校验),`RetrievalTestPage.tsx` 直接 `import { testRetrieval }` 调用即可 |

## Non-goals(继承 008)

- 「从 Agent 加载」/「带入新建配置版本」UI 联动——M7 范围。
- `trace.retrieve()`/`trace.rerank()` 语义封装——延后到 M8,本任务直接用 `withSpan()`。
- zhparser——不引入,用 bigram。
- 修 003 的 lint 强制范围表述落差——不在本任务改动范围,只是既有落差的记录。

## Acceptance criteria

1. 检索测试台(真实浏览器)输入知识库中存在的问题,点击「运行」,展示真实召回的切片、向量分、关键词分(多路开启时)、最终分;关闭多路召回只出向量分;启用 rerank 出「已重排」标签与 rerank 分。
2. `POST /api/retrieval/test` 对合法 body 返回 200 + 契约 schema 合规,对缺字段返回 400。
3. `pnpm --filter @codecrush/backend test` 全绿,含新增的 `rerank-builders.spec.ts`/`retrieval.service.spec.ts`,以及扩展后的 `skeleton.e2e.spec.ts`。
4. `pnpm lint` 零边界违规(尤其 `retrieval` 新增的三个 module import 不触发任何前端/包纯净性规则——它们本来就只影响后端域间规则,当前不受 lint 强制,但仍要跑一遍确认不触发既有 4 类规则里的任何一类)。
5. `chunks.tsv` 列迁移可以 `pnpm db:migrate` 跑通,存量行(若有)自动生成 `tsv` 值。

## Risks / unknowns(需要用户确认,不是我自行拍板的空白)

1. ~~**`ChunksRepository.searchByVector`/`searchByKeyword` 没有自动化测试覆盖真实 pgvector/tsvector 行为**~~ **已由用户确认(2026-07-09):沿用本项目"仓储方法不单测"的既有先例,不新增集成测试基础设施,真实正确性靠 `/ship:qa` 手动跑一遍检索测试台验证。**
2. **`drizzle-kit generate` 能否处理生成列(`GENERATED ALWAYS AS ... STORED`)+ 自定义 SQL 函数**——历史上 drizzle-kit 对 generated column 与自定义函数的支持因版本而异,plan 阶段第一个 story 会先探测当前锁定的 drizzle-kit 版本行为,若自动生成不支持,退化为手写 SQL 迁移文件(参考 0006 手写 HNSW 索引的先例)。
3. **rerank 供应商的 `score`/`relevance_score` 是否保证落在 `[0,1]`**——008 未明确要求校验,若某供应商返回值域不同,`finalScore` 的 `.max(1)` 校验会在契约层报错。plan 阶段需要决定:要不要在 `ProtocolDispatchAdapter.rerank()` 里做一次 clamp(仿照 `embed()` 现有的维度校验模式,`embed-builders.ts` 那种失败即抛错的严格校验,还是静默 clamp),这是本 spec 未决的一个小分歧点,标记待 plan 阶段拍板。
