---
title: "M4 入库管线与知识库管理"
description: "M4 设计：四阶段可插拔入库管线(解析→清洗→分块→向量化)、切片版本化蓝绿重建、BlobStore 本地卷、pg-boss 异步、切片删除制。"
category: "design"
number: "007"
status: draft
services: [backend, frontend]
related: ["design/001", "design/002", "design/003", "design/010"]
last_modified: "2026-07-10"
---

# 007 — M4 入库管线与知识库管理

## Status

`draft` — 经 `/ship:arch-design` 9 lens 自审完成（8 项拒绝备选、5 项假设、4 项 revisit 触发器），4 个产品分歧点已由用户当场拍板（2026-07-08）：切片**删除制**（无启用/禁用开关）、文档元数据**纳入 M4**、PDF/Word/MD/TXT **四格式全做**、全库重建失败文档**切换后暂缺**。实现落地并对照代码校验后推进为 `current`。
2026-07-10：M4 基础实现已出现 `general / qa / custom` 三种分块器，真实 PDF/文章来源需求进一步触发 010。本文保留原 M4 决策历史；“固定解析/清洗、无 OCR、仅库级分块模板”的边界由 010 的版本化 Processing Profile 受控扩展。

## Summary

M4 把 M2 的知识库三屏 mock 换成真实现：`knowledge_bases`/`documents`/`chunks` 三张表落 Postgres+pgvector，`platform/storage`（BlobStore 端口 + LocalFs 适配器）与 `platform/queue`（pg-boss 同进程 worker）两块平台件就位，`ingestion` 模块实现解析→清洗→分块→向量化管线。核心机制是**切片版本化蓝绿重建**：`chunks.version` + `knowledge_bases.active_version/building_version`，支撑「处理配置改变触发全库重建、重建期间检索用旧版本、完成后原子切换」。010 在此基础上增加 Processing Profile、Canonical Document、不可变处理 Run、版面解析与 OCR，不改变本设计的蓝绿切换和检索不空窗语义。

## Boundaries

> 反漂移边界。任何实现若越过这些边界，应先回来改本文。

**In-scope**
- KB CRUD：新建（名称查重 / 描述 / 文档处理 Profile / Embedding 从已启用模型任选）、编辑（默认 Profile 可改，显式应用到旧文档时触发全库重建，Embedding 创建后锁定）、列表卡片精简态（常态无状态标签，重建中蓝色呼吸点+百分比）、详情页流水线配置摘要行。原 `chunkTemplate` 在 010 迁移期保留兼容。
- 文档：单文件/文件夹批量上传（PDF/Word/Markdown/TXT，文件夹模式带相对路径）、「上传后立即解析」开关（关→待解析+手动开始）、三态宏观生命周期（上传→解析入库→就绪）+ 失败原因 + 重试、文档级键值元数据（jsonb）、删除。
- 管线：解析→清洗→分块→向量化四阶段，每阶段端口化；整条 pipeline 亦为可替换端口。当前分块器为通用、问答、课程/公众号专属三种；010 由 Profile 组合这些组件并增加 Run Snapshot。
- 切片：左右分栏查看（原文 + 卡片）、无限滚动（20/页）、关键词搜索、全文/省略切换、勾选 + **批量删除**。
- 版本化蓝绿重建与「重建期检索不空窗」不变量（M5 检索必须按 `chunks.version = kb.active_version` 过滤）。

**Out-of-scope（产品文档第七节原样继承 + 本轮拍板）**
- 「知识库→数据源→文档」三层架构；~~按内容类型细分模板矩阵、单文件覆盖库默认模板~~（2026-07-10 由 010 的受控 Profile + 文档覆盖取代）；用户脚本/任意清洗规则 UI、父子分块/Small-to-big、分块样例预览闭环、编辑时更换 Embedding 模型仍不做。
- ~~OCR / 扫描件识别（解析失败给明确原因）~~（2026-07-10 由 010 纳入受限异步解析；图片多模态检索仍不做）。
- 切片 `enabled` 启用/禁用开关（已拍板删除制，契约同步移除；误删经重新解析恢复）。
- KB 删除（原型无入口，API 也不留）。
- 关键词 FTS 列（`tsv`）延到 M5：关键词召回归 M5，届时 `UPDATE` 回填，无需重新解析。
- 元数据的检索过滤消费（M5）。

**Invariants**
1. **重建期检索不空窗**：检索侧恒读 `version = kb.active_version` 的切片；单文档重解析用末端单事务 delete+insert 交换。
2. **向量维度平台统一 1024**：创建 KB 时对所选模型探针校验（合并 `dimensions:1024` 请求参数），非 1024 维拒绝并明示。
3. **入库任务幂等**：任意阶段重跑不产生重复切片/向量（末端事务交换 + pg-boss singletonKey=documentId）。
4. **blob key 服务端生成**（`kb/{kbId}/{docId}/original.{ext}`），不接受客户端路径，杜绝目录穿越。
5. **处理配置快照不可变**（010）：队列任务执行冻结的 `profileSnapshot`；Profile 更新不得改变已排队任务。

## Context

M2 已按旧原型还原知识库三屏（mock）；2026-07-08 用户对知识库管理做了大幅产品重设计（原型目录《RAG知识库问答系统设计/》，含产品设计文档与最新 `CodeCrushBot.dc.html`），核心变化：分块模板成为库级可配置项、改模板触发全库重建（重建期检索用旧版）、Embedding 创建后锁定、文档元数据、状态标签「常态不展示」原则、切片管理由开关制改删除制、文档生命周期展示简化为三宏观阶段。`screenshots/kb-chunks*.png` 为迭代过程旧图（仍有启用/禁用与分页），**不作为依据**；以 `.dc.html` 源码 + 产品设计文档为准。

## Goals / Non-goals

**Goals**：传 PDF/Word/MD/TXT 走到「就绪」且切片可见可删；改分块模板全库重建、重建期检索不空窗、完成自动切换；失败文档可见原因可重试；管线四阶段可插拔为后续扩展留位。

**Non-goals**：见 Boundaries Out-of-scope。核心是不做通用数据工程、不预置未出现场景的模板。

## Requirements & 关键数字

| 维度 | 值 | 依据 |
|---|---|---|
| 切片规模 | 1000 文档 × 100 切片 = 10 万 | vector(1024)×4B ≈ 400MB + HNSW 同量级 → 单 PG 足够（001:64 既定） |
| 重建峰值存储 | 新旧两版并存 ≈ 2× ≈ 1.2GB | 可接受；切换后异步分批清理旧版 |
| 单文档入库 | 解析 <1s + 100 切片 ÷ 批 10 ≈ 10 次 embed × ~300ms ≈ 3–4s | 秒级到就绪，匹配原型时间线 |
| 全库重建 | 10 万 embed ÷ 批 10 = 1 万次调用，并发 4 ≈ 8–12 min | 异步 + 百分比进度；批大小 `params.batch_size` 可调 |
| 上传限制 | 单文件 ≤20MB、单批 ≤100 文件 | multer 内存态落 BlobStore |

010 新增增强解析容量预算：平均 20 页/文档时，版面解析按规划假设 1–3 秒/页、OCR 3–10 秒/页；因此仍走异步队列，并增加 500 页、Canonical Document 50MB 和分模式超时限制。真实语料基准覆盖该规划假设。

规模 10× 低估（100 万切片）时触发 001 既有 revisit（>5M 向量换专用向量库、>100 doc/min 换 BullMQ）。

## Design

### 存储 schema（Postgres + pgvector）

```
knowledge_bases(id, name unique, desc, chunk_template['general'|'qa'],
                embedding_model_id → model_providers, status['ready'|'building'|'failed'],
                active_version int default 1, building_version int null,
                created_at, updated_at)

documents(id, kb_id fk cascade, name(含相对路径), type['pdf'|'word'|'markdown'|'text'],
          size, blob_key, parsed_text text null, metadata jsonb default '{}',
          status['pending'|'queued'|'processing'|'failed'|'ready'],
          chunk_version int null,          -- 该文档切片当前所在版本
          lifecycle jsonb,                 -- [{stage,status,startedAt,endedAt,error}] 供生命周期抽屉
          error text null, uploaded_at, updated_at)

chunks(id, doc_id fk cascade, kb_id, version int, seq int,
       text, token_count, section, embedding vector(1024),
       unique(doc_id, version, seq))
  + HNSW 索引 (embedding vector_cosine_ops)
```

- 维度统一 1024（Invariant 2）：pgvector HNSW 要求列定维；bge-m3 / text-embedding-v4 / jina v3 / cohere v3 / OpenAI v3 系列均原生或经 `dimensions` 参数支持。
- `parsed_text` 存列（TOAST 承载 MB 级），切片页左栏原文一次 GET。
- `metadata` jsonb：M4 只编辑与随切片返回；M5 做过滤时再加 GIN。
- 文档状态 UI 映射：pending=待解析、queued=排队中、processing=处理中（宏观「解析入库」阶段）、failed=失败、ready=已就绪。

### 平台件与模块端口

- `platform/storage`：`BlobStore` 端口（put/get/delete），首个适配器 `LocalFsBlobStore`（Docker 卷）；日后 `OssBlobStore` 换注入零改业务（003:101 既定）。
- `platform/queue`：pg-boss 封装，与后端同进程跑 worker（10 qps 规模），Nest 生命周期启停，任务持久在 PG，`singletonKey=documentId`、`retryLimit=1`（任务幂等敢重跑）。
- `ingestion` 模块拥有管线端口（复用 M3 注册表分发习语）：

```ts
IngestionPipelinePort.run(ctx: {document, kb, targetVersion})   // 整条管线可替换
// 默认实现组合四个阶段端口：
DocumentParserPort.parse(buffer, type) -> { text }              // 按 type 注册表分发（pdf-parse / mammoth / 原文）
TextCleanerPort.clean(text) -> text                             // 默认：去控制符、压空行
ChunkerPort.chunk(text, {template}) -> {seq,text,section,tokenCount}[]  // 按模板注册表分发
// 向量化不设新端口——经 models 模块 barrel：
ModelsService.embedTexts(modelId, texts) -> number[][]          // 密钥解密留在 models 域内
```

> 2026-07-10 扩展：上述 `{ text }` 与运行时读取 `chunkTemplate` 是 M4 初始契约。010 将其演进为版本化 Profile、`CanonicalDocument { markdown, blocks, warnings, stats }` 与 `document_processing_runs.profile_snapshot`；队列只传 `processingRunId`。Parser/Normalizer/Chunker 注册表必须经 DI 装配，不由 Pipeline 直接 import adapters。

- `ModelProviderPort` 加必选 `embed()`（001:96 终态既定），`ProtocolDispatchAdapter` 按 `(embedding, protocol)` 加 request builder，与 testConnection 探针同表同模式。

### REST 契约（`@codecrush/contracts` 同步修订）

| 端点 | 说明 |
|---|---|
| `GET/POST /api/knowledge-bases`，`GET/PATCH /:id` | PATCH 含 chunkTemplate，变更即触发重建（返回 building 态）；重建中再改模板 → 409 |
| `POST /api/knowledge-bases/:id/documents` | multipart 多文件 + autoParse + 每文件 relativePath；响应 Document[]；autoParse=false → pending |
| `POST /api/documents/:id/parse` | 手动开始 / 失败重试，幂等入队 |
| `GET /api/documents/:id/lifecycle` | 生命周期抽屉（三宏观阶段 + 各段耗时/时间/失败原因） |
| `PATCH /api/documents/:id/metadata` · `DELETE /:id` · `GET /:id/content` | 元数据 Modal / 删除（连删 blob+chunks）/ 原文 |
| `GET /api/documents/:id/chunks?offset&limit&q` | 无限滚动 20/页 + ILIKE 搜索 |
| `POST /api/chunks/batch-delete {ids}` | 删除制 |

010 增加 `GET /api/processing-profiles`、处理历史与显式重建端点；上传和重新解析请求可覆盖知识库默认 Profile。前端“分块模板”主选择升级为“文档处理方案”，现有 `general / qa / custom` 作为 Profile 内部 Chunker 保留。

契约破坏性修订（M2 桩无真实消费，改而不迁）：Chunk 去 `enabled`、去 `UpdateChunkEnabledRequest`；Document status 改五值枚举 + metadata + lifecycle；KB 加 chunkTemplate / status / progress。

### 版本化蓝绿重建（核心机制）

- **单文档入库/重试**：目标版本 = `building_version ?? active_version`。切片先算好（含向量），最后**单事务** delete 旧 + insert 新——无空窗、天然幂等。
- **全库重建**（改模板触发）：`building_version = active_version + 1`，全量文档逐个入队；期间检索继续读 `active_version`；所有文档到达终态后单事务切换（`active_version = building_version`），随后**异步分批**清理旧版切片（大删不进切换事务）。
- **失败文档**：切换照走，无新版切片即暂缺，状态失败可重试，重试成功回到检索（已拍板）。
- **重建中新上传**：入 building 版本，切换后才可检索（不双写）。
- **进度**：`到达 building 版本终态的文档数 / 总数`，一条 SQL；前端 3s 轮询。

### 分块模板

- **通用**：按 Markdown 标题层级切段、段内贪心合并至 ~512 token 上限、无 overlap，`section` 记标题路径；PDF/Word/TXT 无标题结构退化为段落合并。
- **问答**：最低级标题=问、正文=答，或 `Q:/A:`（`问：/答：`）显式对，一对一切片。
- token 计数用 CJK 感知估算（展示用途，不引 tokenizer 依赖）。

### 前端（三屏按最新原型重做）

`KnowledgeBasesPage`（卡片精简态 + 新建 Modal）、`DocumentsPage`（配置摘要行 + 编辑 Modal + 文档表 + 生命周期抽屉 + 上传抽屉 + 元数据 Modal）、`ChunksPage`（分栏 + 无限滚动 + 搜索 + 全文/省略 + 批量删除）。原型残留的「启用后才能被检索」为过时文案，不还原。

## Failure modes

| 故障 | 行为 |
|---|---|
| Embedding 服务 5xx/超时 | 批内指数退避重试 ×2；仍败 → 文档 failed + 原因入 lifecycle，其余文档不受影响 |
| Worker 进程崩溃 | pg-boss 任务持久，重启续跑；末端事务交换保证无半成品可见 |
| 扫描件/空文本 PDF | M4 初始行为为 fail；010 启用时按 Profile 进入受限 OCR，失败 Run 不替换旧切片 |
| 文档在入库中被删 | 任务开头与交换前查存在性，不存在则静默完成；FK cascade 兜底 |
| 上传批次部分失败 | 逐文件建档，失败文件单独标 failed，不连坐 |
| PG 挂 | 控制面整体不可用（001 既定单点） |

管线各阶段以 `withSpan` 打 ingestion spans（`gen_ai.*` embeddings + 自定义阶段 span）；异步队列内，不碰问答关键路径。

## Rollout & operations

- 一个 Drizzle migration：`CREATE EXTENSION vector`（pgvector 镜像支持）+ 三表 + HNSW/unique 索引。回滚 = 回退迁移（M4 前无真实数据）。
- blob 目录 Docker 卷挂载（env 指定路径），不静态服务。
- 「在工作」信号：上传 PDF → 文档表状态流转到已就绪 + 切片可见；改模板 → 卡片蓝点百分比走到消失。

## Security

- 上传在既有 JWT 全局 guard 内；扩展名 + magic bytes 双校验，20MB/文件上限。
- **新增出站信任面**：切片文本发往 embedding 厂商（与 chat 同级）；密钥沿用 `api_key_enc` 信封加密。
- blob key 服务端生成（Invariant 4）；文件内容只经鉴权 API 出。

## Alternatives considered

| 决策 | 选择 | 拒绝 | 代价 |
|---|---|---|---|
| 重建语义 | 版本化蓝绿 + 整库原子切换 | 原地重建（检索空窗）/ 每文档逐个切换（重建中新旧模板混检） | 峰值 2× 存储 |
| 向量维度 | 平台统一 1024 + 创建探针校验 | 每库自选维度（HNSW 定维 → 多列/多表） | 拒收无法输出 1024 维的模型 |
| Worker 部署 | 与后端同进程（pg-boss） | 独立 worker 进程 | 重建高峰与 API 抢 CPU；001 已有升级触发器 |
| 切片管理 | 删除制（最新原型） | enabled 开关（旧契约）/ 两者并存 | 误删需重新解析恢复 |
| FTS 列 | 延到 M5 UPDATE 回填 | M4 就位（提前引入中文分词依赖决策） | M5 多一次回填 |
| token 计数 | CJK 感知估算 | tiktoken 精确计数 | 展示用途，误差无害 |
| 解析器（M4 初始） | ~~pdf-parse + mammoth 纯文本抽取~~ | ~~OCR/版面识别引擎~~ | 2026-07-10 被 010 的快速路径 + 按需版面/OCR 取代；保留旧实现作兼容与回滚 |
| 元数据存储 | documents.metadata jsonb | 独立表 | M5 过滤时加 GIN 即可 |

## Assumptions

1. 分块阈值（~512 token 上限、无 overlap、问答对识别规则）dev 期可调，推翻改 spec 不改架构。
2. 单文件 ≤20MB、单批 ≤100 文件；embed 批默认 10（`params.batch_size` 覆盖）。
3. 重建中禁止再次改模板（409），排队式重建不做。
4. 前端轮询 3s（列表/详情同）。
5. 失败重试 = 重新入队该文档（同一目标版本）。

010 修订：失败“重试”复用失败 Run Snapshot；“重新解析”才解析当前有效或用户新选的 Profile。Profile 默认改变不静默重建旧文档，应用到旧文档需显式确认。

## Revisit triggers

- 切片 >500 万或全库重建 >30 min → 专用向量库 / 独立 worker（001 既有触发器的 M4 具体化）。
- 出现必须接入的非 1024 维模型 → 每库维度 + 分表。
- ~~真实内容出现邮件/表格类 → 分块注册表加模板~~（已由 010 触发并升级为 Profile + Canonical Document）；Profile >10 或需运营无部署配置时再设计声明式 Profile。
- 误删切片投诉 → 回收站/软删（当前逃生舱：重新解析恢复）。

## References

- 产品权威（本地原型目录，不进仓库）：`RAG知识库问答系统设计/知识库模块-产品设计.dc.html`（2026-07-08）、`CodeCrushBot.dc.html`（最新版；`screenshots/kb-chunks*.png` 为迭代旧图不作依据）
- 001（系统架构，本文对其数据模型/管线描述做了 M4 修订）· 002（路线图 M4/M4.1）· 003（代码组织：`platform/storage`/`queue` 与 ingestion Profile/Run 归属）· 010（文档处理 Profile、Canonical Document、版面解析/OCR 与迁移）
- pgvector HNSW、pg-boss、pdf-parse、mammoth
