---
title: "M5 检索"
description: "M5 设计：RetrieverPort 真实实现（pgvector 向量召回 + tsvector 关键词召回 + 加权融合 + 可选 rerank）与检索测试台。"
category: "design"
number: "008"
status: draft
services: [backend, frontend]
related: ["design/001", "design/002", "design/003", "design/007"]
last_modified: "2026-07-09"
---

# 008 — M5 检索

## Status

`draft` — 经 `/ship:arch-design` 完整对抗档（peer 独立调查 + diff + 真实 Postgres 容器实测校验）产出，7 项收敛决策、7 项拒绝备选、3 项 revisit 触发器。实现落地并对照代码校验后推进为 `current`。

## Summary

M5 把 M2 建好的检索测试台骨架（`RetrievalTestPage.tsx`，本地 mock 计算）与 `retrieval` 模块桩（`POST /retrieval/test` 返回硬编码一条 mock hit）换成真实实现：`RetrieverPort` 的第一个真实适配器 `PgHybridRetriever`，组合向量召回（pgvector HNSW，已在 migration `0006` 建好）+ 关键词召回（Postgres `tsvector`，新增 `chunks.tsv` 列 + 中文 bigram 预处理）+ 加权线性融合 + 可选 rerank（`ModelProviderPort` 新增 `rerank()`，复用 M3 已写好的 5 种协议探针请求/响应形状）。**检索测试台与未来 M8 chat 编排共用同一个 `RetrieverPort`，不实现两套检索逻辑。**

设计过程中用真实 Postgres 容器（`codecrush-postgres-1`）与 `eslint.config.mjs` 对多个假设做了实证校验（而非凭记忆假定），具体见下文 Design 与 Alternatives 各节标注「已实测」的结论。

## Boundaries

> 反漂移边界。任何实现若越过这些边界，应先回来改本文。

**In-scope**

- `RetrieverPort` 真实实现：向量召回（pgvector `<=>` cosine + HNSW）、关键词召回（`tsvector` + GIN，中文 bigram 预处理）、加权线性融合、可选 rerank、阈值过滤/排序/截断。
- `ModelProviderPort.rerank()` 新端口方法 + `RERANK_BUILDERS`（5 协议：self_hosted/openai_compat/cohere/jina/dashscope，镜像 `EMBED_BUILDERS` 模式，复用已有 rerank 探针的真实请求/响应形状）+ `ModelsService.rerankTexts()`。
- `chunks` 表新增 `tsv tsvector` 列（`GENERATED ALWAYS AS ... STORED`）+ GIN 索引 + 一次性自动回填（`ALTER TABLE` 触发全表重写，存量行自动生成，无需手写 `UPDATE` 回填语句）。
- `chunks` 模块新增查询方法（`ChunksRepository.searchByVector` / `searchByKeyword`，经 `ChunksService` barrel 暴露），`retrieval` 不直接碰 chunks 的 Drizzle 表。
- 新模块依赖边 `retrieval → knowledge-bases`（只读，取 `activeVersion`）——003 现有依赖图未列此边，本文档在此基础上增补。
- 检索测试台前端真实接入 `POST /retrieval/test`（替换 M2 的本地 mock 计算 `computeRtResults`）。
- `RetrievalTestRequestSchema` 契约补 `rerankThreshold` 字段（产品文档「Agent 管理与检索测试-产品设计文档」§3.2 第 7 点要求，当前契约缺失，已核实）。
- 检索 span：`gen_ai.operation.name` = `embeddings`/`keyword_recall`/`rerank`，`codecrush.span.kind` = `retrieval`/`rerank`，复用 `packages/otel-conventions` 已有的 `OTEL_OPERATIONS.RETRIEVE/RERANK/KEYWORD_RECALL` 与 `RAG.*` 属性；新增 `RAG.VEC_WEIGHT`（`rag.retrieval.vec_weight`）与 `RAG.RERANK_THRESHOLD`（`rag.rerank.threshold`）两个属性 key（增量不破坏）。

**Out-of-scope（写明原因）**

- **「从 Agent 加载」/「带入『Agent 名』新建配置版本」两个 UI 联动**——`agents.service.ts`（已核实）目前是纯内存 `MOCK_AGENTS` 数组、无 schema/persistence，M7 才有真 Agent CRUD 和配置版本 Eval 门槛。现在接这两个 affordance 等于对着会在 M7 被整体替换的假数据写 UI。检索测试台在 M5 独立可用，不依赖 Agent 数据。
- **`trace.retrieve()` / `trace.rerank()` 语义封装**——`@codecrush/otel`（已核实 `packages/otel/src/trace.ts`）目前只有通用 `withSpan()`，001/003 设想的 `trace.llm/retrieve/tool` profile 尚未构建。M5 直接调用 `withSpan()` 并传入既有的 operation/kind 常量即可；封装等 M8（chat 成为检索的第二个调用方）时再抽，避免为单一调用方过早抽象。
- **zhparser 中文分词扩展**——已用真实容器核实 `pgvector/pgvector:pg16` 镜像不含 zhparser/jieba（`pg_available_extensions` 只有 `pg_trgm`），引入意味着自建 Postgres 镜像（新 Dockerfile + 编译 + 词典维护），新增运维面，且阿里云 RDS PostgreSQL 是否支持该扩展未知（001 的云迁移就绪目标存在不确定性）。M5 用 app 层中文双字 bigram + `simple` 配置的轻量方案，效果不足再 revisit。
- **修正 003「后端域间依赖靠 ESLint 强制」的表述落差**——已用 `eslint.config.mjs` 核实：当前只有 4 条边界规则（FE↔contracts/otel-conventions、contracts 纯净性、otel-conventions 纯净性、otel 纯净性），**不含**后端域间 DAG（`retrieval → models/chunks/knowledge-bases` 等边）的 lint 强制，003 §依赖规则 = lint 规则 一节的表述与实际不符。本文档如实记录这个落差，但修 003 原文或补齐 lint 规则不是 M5 的任务（见 Revisit triggers）。

**Invariants**

1. **版本不空窗**：检索恒过滤 `chunks.version = kb.active_version`（继承 007 不变量 1），重建期间检索仍读旧版本。
2. **`finalScore` 语义单一**：恒为「最近一次实际执行阶段」产出的分数——未开多路召回 = `vecScore`；开多路召回未重排 = 融合分；重排成功 = `rerankScore`。**不像原型 mock 那样重排后仍对着融合分（`hybrid`）套阈值**——这是对原型 mock 已知简化行为的刻意修正，不是延续。
3. **非对称降级**：向量召回失败 = 硬失败（核心信号，无先例支持降级）；关键词召回失败 = 降级为纯向量继续（继承 001 既有先例）；rerank 失败/超时 = 降级为跳过重排、保留融合分继续。三者互不对称，各自独立判定。
4. **rerank 候选池有界**：恒为 `min(topK, rerankPoolCap)`，`rerankPoolCap` 是平台级常量，不随用户可自由输入的 `topK` 无界增长重排调用成本。

## Context

M2 已还原检索测试台页面骨架（`RetrievalTestPage.tsx`，纯本地 mock 计算 `computeRtResults`）与后端 `retrieval` 模块桩（`POST /retrieval/test` 返回一条硬编码 hit）。M4（007）已交付 `knowledge_bases`/`documents`/`chunks` 三表与 pgvector HNSW 索引，`ModelProviderPort.embed()` 已落地。M5 是这条链路里第一个把「检索」从纯 UI mock 变成真实数据库查询 + 模型调用的模块，也是 M7（Agent 配置）汇聚前最后一块可独立验证的能力域。

产品权威来源为 `RAG知识库问答系统设计/docs/Agent管理与检索测试-产品设计文档.md` 第三节「知识检索测试」与原型 `CodeCrushBot.dc.html`（检索测试屏 mock，约 line 3744-3775）——原型的打分算法（`hybrid = vec*w + kw*(1-w)`，阈值恒套 `hybrid` 即使已重排）仅作 UI/UX 布局参考，其简化的打分/阈值逻辑不作为实现依据（见 Invariant 2、Alternatives）。

## Goals / Non-goals

**Goals**：检索测试台输入问题、调整参数，能从真实知识库召回真实命中分块并展示三种分数（向量/关键词/最终）；`RetrieverPort` 成为 M8 chat 编排可直接复用的同一套实现，不留技术债；中文内容的关键词召回在无额外 Postgres 扩展的前提下可用。

**Non-goals**：见 Boundaries Out-of-scope。核心是不做 Agent 联动 UI、不做语义化 trace 封装、不引入新 Postgres 扩展。

## Requirements & 关键数字

| 维度 | 值 | 依据 |
|---|---|---|
| 向量规模 | ~10 万 × 1024 维 | 001 既定估算，HNSW 已建好（migration `0006`） |
| 召回延迟预算 | ~0.35s（001 既定，源自原型 mock trace 展示时长，**非实测**） | 见 Revisit：rerank 接入真实供应商后大概率突破此预算 |
| 峰值 QPS | 持续 ≤10 / 突发 ≤50（001 既定） | 检索是问答关键路径的一环，不单独重估 |
| rerank 候选池上限 | `rerankPoolCap` 建议 50–100（工程判断，非实测） | 防止用户自由输入的 `topK` 让重排调用成本无界增长 |
| rerank 超时 | 5s（工程判断，非实测） | 介于「测试连接」10s 探针与「chat 30s 熔断」之间，留生成阶段余量；见 Revisit |

结论：规模与延迟预算沿用 001 既定数字，无需重新估算；rerank 相关的两个数字（候选池上限、超时）是本设计新引入且明确标注为**待真实供应商接入后校准**的工程估计值。

## Design

### 数据流程图

一次检索请求（检索测试台或未来 M8 chat 编排，共用同一 `RetrieverPort`）从输入到 `Hit[]` 输出的完整链路：

```
检索请求(检索测试台 或 未来 M8 chat 编排, 共用同一 RetrieverPort)
  query + {kbId, embedModelId, topK, threshold, multi, vecWeight,
           rerankModelId?, rerankThreshold?, topN}
                              │
                              ▼
                 KnowledgeBasesService.get(kbId)
                 → activeVersion  (007 不空窗不变量: 检索恒读此版本)
                              │
                              ▼
              ModelsService.embedTexts(embedModelId, [query])
              → queryVector[1024]        gen_ai.operation.name=embeddings
              (失败 → 硬失败: 没有查询向量则无法检索)
                              │
              ┌───────────────┴────────────────┐
              │ multi = true (并行发起)          │ multi = false
              ▼                                  ▼
  ┌──────────────────────┐  ┌──────────────────────┐   (关键词分支整段跳过,
  │ 向量召回               │  │ 关键词召回              │    finalScore 直接取 vecScore)
  │ ChunksRepository       │  │ ChunksRepository       │
  │ .searchByVector        │  │ .searchByKeyword       │
  │ WHERE kb_id=? AND      │  │ WHERE kb_id=? AND      │
  │  version=activeVersion │  │  version=activeVersion │
  │ ORDER BY embedding     │  │ tsv @@ bigram_tsquery  │
  │  <=> queryVector       │  │ ORDER BY ts_rank_cd    │
  │  (HNSW 索引)            │  │  (..,32) (GIN 索引)     │
  │ LIMIT poolSize         │  │ LIMIT poolSize         │
  │ → vecScore=1-cos距离    │  │ → kwScore=归一化 rank   │
  └──────────┬─────────────┘  └──────────┬─────────────┘
             │ 失败→硬失败(核心信号)         │ 失败→降级: 丢弃本路继续(001 既定先例)
             └────────────────┬────────────┘
                               ▼
                    按 chunkId 去重合并 + 融合(加权线性和)
              finalScore = vecWeight·vecScore + (1-vecWeight)·kwScore
                    (multi=false 时 finalScore = vecScore)
                               │
                     相似度阈值过滤: finalScore ≥ threshold
                               │
              按 finalScore 降序, 截断 min(topK, rerankPoolCap)
                               │
              ┌────────────────┴─────────────────┐
              │ rerank 启用                        │ rerank 未启用
              ▼                                    │
  ModelsService.rerankTexts(rerankModelId,          │
    query, candidates.text[])                       │
  gen_ai.operation.name=rerank, 超时 5s               │
  失败/超时 → 降级: 跳过, finalScore 不变(span 打ERROR) │
              │                                    │
  成功 → finalScore 覆盖为 rerankScore                │
  Rerank 分数阈值过滤: rerankScore ≥ rerankThreshold    │
              └────────────────┬─────────────────┘
                               ▼
                按 finalScore 降序排序, 截断前 topN 条
                               ▼
                    JOIN documents 取 docName
                               ▼
        RetrievalHit[] {chunkId, docId, docName, text, section,
                vecScore, kwScore?, rerankScore?, finalScore}
```

**检索管线执行顺序（9 步）**：① 解析 `kb.activeVersion` → ② 查询向量化 → ③ 并行向量/关键词召回 → ④ 按 `chunkId` 去重合并 → ⑤ 加权融合 → ⑥ 相似度阈值过滤 → ⑦ 排序截断候选池（`min(topK, rerankPoolCap)`）→ ⑧ 可选 rerank + rerank 阈值过滤 → ⑨ 最终排序、截断 `topN`、JOIN `documents` 取 `docName`。

### 加权融合算法

```
finalScore = vecWeight · vecScore + (1 - vecWeight) · kwScore
```

**为什么不是产品文档字面提到的 RRF**：`packages/contracts/src/retrieval.ts` 的 `RetrievalHitSchema.finalScore` 已经是代码定死的 `z.number().min(0).max(1)` 约束。标准 RRF（`Σ 1/(k+rank)`，k 通常取 60）的分数量级天然不落在 `[0,1]`（两路求和上限约 0.03），要满足契约还得再套一层归一化——RRF「基于排名、免归一化」的核心优势被这层额外归一化抵消。产品文档「两路结果经 RRF 融合」按松散术语处理为「rank/分数融合」的统称，实际选型为加权线性和，与原型 mock 的公式一致（唯一从原型继承的算法，因为它恰好也是能满足 `[0,1]` 契约、且已被产品经检索测试台反复验证过直觉的方案）。

### `kwScore` 归一化

用 Postgres `ts_rank_cd` 的内置归一化选项：

```sql
ts_rank_cd(tsv, tsquery, 32)   -- 归一化方式 32 = rank / (rank + 1) ∈ [0, 1)
```

不用候选池内 min-max 归一化——min-max 会导致同一文档的 `kwScore` 随每次候选池里还有谁而漂移，不利于检索测试台「调参 → 对比结果」的核心使用场景（同一文档在不同参数组合下的分数应该可比）。`ts_rank_cd(...,32)` 对 `(文档, 查询)` 是确定性的，不依赖候选池组成。

### 中文分词方案

`chunks.tsv` 列类型在 001/007 已定为 `tsvector`（本设计不重新讨论表结构），但 Postgres 默认 `simple` 配置对连续中文字符**只切出一个 token**——已用真实容器核实：

```sql
SELECT to_tsvector('simple', '测试中文分词效果');
--  '测试中文分词效果':1        ← 整串八个字被当成一个 token，关键词召回失效
```

采用 app 层中文双字 bigram 预处理，已用真实容器核实产出合理切分：

```sql
SELECT cjk_bigram_text('测试中文分词效果');
--  测试 试中 中文 文分 分词 词效 效果 果      ← 相邻中文字符两两重叠切分
```

两个 SQL 函数（均 `IMMUTABLE`，一次迁移里建好，索引侧与查询侧共用，避免 TS 与 SQL 两处重复分词逻辑而漂移）：

1. **`cjk_bigram_text(text) RETURNS text`**：中文字符两两重叠切分，非中文字符（ASCII 词/标点）原样保留。
2. **查询侧 helper**：把 bigram 结果用 `|`（OR，非 `&`/AND）拼接成 `tsquery` 表达式——用 OR 而非 AND，是因为 AND 语义下任何一个字符差异（同义替换、错别字、分词边界）都会导致零命中；OR 语义让 `ts_rank_cd` 天然按「命中 bigram 数量」区分相关度，更适合作为向量召回的补充信号而非精确匹配。

`tsv` 列声明为 `GENERATED ALWAYS AS (to_tsvector('simple', cjk_bigram_text(text))) STORED`——已用真实容器核实 `to_tsvector` 配合显式字面量 config（如 `'simple'`）可以用于 `GENERATED ALWAYS AS STORED`（Postgres 只排除依赖会话级 `default_text_search_config` 的单参数形式，不排除显式双参数形式）：

```sql
CREATE TABLE tsv_probe (
  id serial primary key,
  body text,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED
);
-- CREATE TABLE 成功，无报错
```

`ALTER TABLE chunks ADD COLUMN tsv ...` 会触发一次全表重写，为存量行自动计算 `tsv`，无需额外手写 `UPDATE` 回填语句（001/007 提到的「M5 回填」由 DDL 本身完成）。

### Rerank 端口设计

```ts
// models/ports/model-provider.port.ts 新增
rerank(
  config: ModelCallConfig,
  query: string,
  documents: string[],
  topN?: number,
): Promise<{ results: { index: number; score: number }[] }>;
```

`adapters/rerank-builders.ts` 新增 `RERANK_BUILDERS: Record<ModelProtocol, RerankBuilder>`，镜像 `embed-builders.ts` 的 `EMBED_BUILDERS` 模式，复用已在 `adapters/protocols/*.ts` 的 `testConnection` 探针里验证过的真实请求/响应形状（不是重新设计，是把探针的最小 ping payload 换成真实批量 `documents`）：

| 协议 | 请求体 | 响应形状 |
|---|---|---|
| `self_hosted`（TEI） | `{query, texts}` → `POST /rerank` | 顶层数组 `[{index, score}]` |
| `cohere` / `jina` | `{model, query, documents, top_n}` → `POST /rerank` | `{results: [{index, relevance_score}]}` |
| `openai_compat` | `{model, query, documents, top_n}` → `POST /reranks` | `{results: [...]}` 或 `{data: [...]}` |
| `dashscope` | `{model, input:{query,documents}, parameters:{top_n}}` → `POST /services/rerank/text-rerank/text-rerank` | `{output: {results: [{index, relevance_score}]}}` |

`ProtocolDispatchAdapter.rerank()` 集中 fetch/超时/密钥擦除（同 `embed()` 的分工），超时 **5s**（明确标注：无真实供应商实测支撑，是介于「测试连接」`TEST_CONNECTION_TIMEOUT_MS=10s` 探针预算与 chat 端 30s 熔断之间的工程估计，见 Revisit）。`ModelsService.rerankTexts(modelId, query, texts, topN?)` 镜像 `embedTexts()` 的模式（域内解密 key、查行、调端口）。失败/超时在 `RetrievalService` 层捕获降级，不向上抛出（Invariant 3）。

### 模块边界

pgvector/`tsvector` 的实际 SQL 查询新增在 `ChunksRepository`（`searchByVector(kbId, version, embedding, limit)` / `searchByKeyword(kbId, version, query, limit)`），经 `ChunksService` barrel 暴露给 `retrieval` 调用——`retrieval` 不直接 import `chunks` 的 Drizzle 表（`schema.ts`），符合 003 「跨模块只走对方 barrel 导出的 service」的既有规则，`chunks` 本来就拥有这张表。

`retrieval` 新增对 `KnowledgeBasesService`（只读 `.get(kbId)` 取 `activeVersion`）的依赖——**这是在 003 现有依赖图基础上的增补**：003 §模块依赖分层只列了 `retrieval → models、chunks`，未列 `retrieval → knowledge-bases`，但 `RetrieverPort.retrieve()` 必须知道读哪个版本的切片，这条边是必需的，且不违反 003 的 DAG 方向（`knowledge-bases` 与 `models`/`chunks` 同属「④ 域叶子」层，`retrieval` 依赖它不产生环）。**已用 `eslint.config.mjs` 核实**：这条新边（以及 003 里列出的所有后端域间边）目前不受 lint 强制——现有边界规则只覆盖 4 类（FE↔contracts/otel-conventions、contracts 纯净性、otel-conventions 纯净性、otel 纯净性），不含 `apps/backend/src/modules/**` 域间 DAG 检查，003 §依赖规则 = lint 规则 一节「上述 1–3 由 ESLint...强制」的表述与代码现状不符。本文档如实记录这个落差（见 Revisit triggers），修复不是 M5 的任务。

### 阈值语义（Invariant 2 的具体化）

两个独立旋钮，顺序生效，不混用：

- **相似度阈值**（`threshold`）：过滤进入 rerank 阶段前的分数——未开多路召回时对 `vecScore`，开启时对融合分。
- **Rerank 分数阈值**（`rerankThreshold`，仅当启用 rerank 时生效）：rerank 完成后对 `rerankScore` 再过滤一次。

`finalScore`/最终排序键恒为「最后实际执行阶段」的产出——rerank 跑了就是 `rerankScore`，没跑就是融合分/`vecScore`。这明确拒绝了原型 mock 「重排后仍对 `hybrid` 融合分套阈值」的简化行为。

## Failure modes

| 故障 | 行为 |
|---|---|
| 查询向量化失败（embedding 服务 5xx/超时） | 硬失败，1 次幂等重试（单条查询文本，同 001 既定改写/embed 重试策略） |
| 向量召回失败（pgvector 查询异常） | 硬失败——向量是核心信号，无先例支持降级 |
| 关键词召回失败（tsquery 构造异常/查询超时） | 降级为纯向量继续，span 打标（继承 001「一路召回失败→降级纯向量」既定先例） |
| rerank 调用失败/超时（>5s） | 降级为跳过重排，保留融合分作为 `finalScore`，span 打 ERROR，继续返回结果 |
| 知识库无候选切片（空库/版本刚切换尚无切片） | 返回空 `Hit[]`，非错误 |
| `kb.activeVersion` 解析失败（`knowledge-bases` 服务异常） | 硬失败——无法确定读哪个版本的切片，检索请求整体失败 |

检索 span 覆盖 `embeddings`/`keyword_recall`/`rerank` 三个 `gen_ai.operation.name`，不在问答关键路径外增加同步开销（001 Invariant 1，各阶段 span 本身就在关键路径内，与生成阶段一样正常计入延迟，但埋点导出失败不得拖垮检索——沿用现有 `withSpan`/`forceFlushTelemetry` best-effort 语义）。

## Rollout & operations

- 一个 Drizzle 迁移（`00XX_m5_retrieval.sql`，紧接现有 `0007`）：`ALTER TABLE chunks ADD COLUMN tsv ...`（含 `cjk_bigram_text` 函数定义）+ `CREATE INDEX ... USING gin(tsv)`；存量行随 `ALTER TABLE` 自动回填，无需单独的回填脚本或分批处理（10 万行规模的一次性 DDL 重写是秒级操作，与 007 的向量化回填不同——不涉及外部 API 调用）。
- 后端 `models`/`chunks`/`retrieval` 三个模块同批改动；前端 `RetrievalTestPage.tsx` 从本地 mock 计算切到真实 API 调用。
- 「在工作」信号：检索测试台输入问题、点击「运行」，能从真实知识库召回命中分块，展示向量/关键词/最终三种分数；关闭多路召回只出向量分；启用 rerank 出「已重排」标签与 rerank 分。

## Security

- 沿用既有信任边界：检索请求在 JWT 全局 guard 内；rerank 出站调用与 `embed()` 同级（密钥沿用 `api_key_enc` 信封加密，解密不出 `models` 域）。
- 检索测试台的测试参数不落库、无副作用（产品文档 §3.3 明确要求），与 Agent 生产配置隔离。
- span 属性不含切片原文全文（复用 001 既有的「命中分块用 span events + 只存 chunk_id 引用」策略，不新增泄漏面）。

## Alternatives considered

| 决策 | 选择 | 拒绝 | 代价 |
|---|---|---|---|
| 融合算法 | 加权线性和（归一化分数） | 加权 RRF（基于排名） | RRF 免归一化的优势被 `finalScore∈[0,1]` 的契约约束抵消，还是要额外套一层归一化 |
| `kwScore` 归一化 | `ts_rank_cd(...,32)` 内置归一化 | 候选池内 min-max 归一化 | 同一文档分数会随候选池组成漂移，不利于测试台复现对比调参 |
| 中文分词 | App 层 bigram + `simple` 配置 + Generated 列 | zhparser 分词扩展（自定义镜像） | 分词精度打折（bigram 是粗粒度近似，非真实语言学分词）；换来零新增运维面、阿里云可迁移性不确定性归零 |
| `tsv` 回填 | Generated 列（已实测可行） | `BEFORE INSERT/UPDATE` 触发器 | 触发器方案曾被认为是唯一可行路径（regconfig 版 `to_tsvector` 不能用于 Generated 列），已用真实容器证伪；Generated 列零应用代码改动更优 |
| rerank 候选池 | `min(topK, rerankPoolCap)` 平台常量上限 | 直接用用户 `topK` | 拒绝无界重排成本随用户输入增长 |
| 向量召回失败处理 | 硬失败 | 降级为纯关键词（对称于关键词降级） | 001 现有先例本身非对称（只允许关键词降级），向量是核心信号，不发明新对称规则 |
| `trace.retrieve` 封装 | 延后到 M8（直接用 `withSpan`） | M5 就抽象出语义封装 | 单一调用方过早抽象；等 chat（M8）成为第二个调用方，封装的价值才体现 |

## Assumptions

1. 检索测试台与生产 chat（M8）共用同一 `RetrieverPort`，不需要两套实现。
2. rerank 5s 超时、`rerankPoolCap`（建议 50–100）为工程判断的合理默认值，非实测结果，标注为待校准。
3. bigram 中文分词精度对「检索测试台调试用途」够用，不追求生产级分词精度。
4. 现有 5 种模型协议（self_hosted/openai_compat/cohere/jina/dashscope）覆盖首期 rerank 供应商需求，不需要新协议。

## Revisit triggers

- 关键词召回实测分词质量不足（明显漏召回目标关键词切片）→ 引入 zhparser，需先验证阿里云 RDS PostgreSQL 扩展支持情况（云可迁移性前提）。
- rerank 接入真实供应商后实测超时/延迟数据 → 校准 5s 超时与 001 的「召回 0.35s」预算（该预算源自原型 mock trace 展示时长，非实测，大概率会被真实 rerank 调用打破）。
- 003「后端域间依赖靠 ESLint 强制」表述与实际（仅前端/包边界被 lint）不符 → 未来若要真正锁死后端 DAG，需引入 `eslint-plugin-boundaries` 或等价规则覆盖 `apps/backend/src/modules/**`；本文档只记录落差，不在 M5 范围内修复。

## References

- 系统架构：`001-rag-platform-architecture`（`RetrieverPort` 契约、chunks 表结构、Invariants）
- 实现路线图：`002-implementation-roadmap`（M5 行：依赖 M3/M4，验收标准）
- 代码组织：`003-code-organization`（模块依赖规则、OTel 包边界；本文档增补了 `retrieval → knowledge-bases` 边并记录了 lint 强制范围的落差）
- M4 入库管线：`007-m4-ingestion-pipeline`（chunks/knowledge_bases/documents 表结构、版本化蓝绿重建，本文档只消费不重新设计）
- 产品设计：`RAG知识库问答系统设计/docs/Agent管理与检索测试-产品设计文档.md` 第三节「知识检索测试」
- 原型：`CodeCrushBot.dc.html`（检索测试屏 mock，仅作 UI/UX 参考，打分算法不采纳）
- Postgres 全文检索：`ts_rank_cd` 归一化选项、`GENERATED ALWAYS AS ... STORED`
