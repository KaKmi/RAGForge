---
title: "文档处理 Profile 与结构化入库管线"
description: "用版本化 Profile 编排解析、清洗与分块，统一输出可溯源 Markdown，并支持 PDF 版面解析与 OCR。"
category: "design"
number: "010"
status: draft
services: [backend, frontend, ingestion, deploy]
related: ["design/001", "design/002", "design/003", "design/007"]
last_modified: "2026-07-10"
---

# 010 — 文档处理 Profile 与结构化入库管线

## Status

`draft` — 2026-07-10 经 `/ship:arch-design` 完成 9/9 lens 自审（6 项拒绝备选、6 项假设、5 项 revisit 触发器）。本设计扩展 007 的 M4 入库管线；001/002/003/007 已同步标注新边界，代码落地并完成真实文档验收前不得推进为 `current`。

**第一波（Rollout 1–4）已实现（2026-07-10，`/ship:design`+`/ship:dev`）**：版本化 Profile 注册表（`general-v1 / faq-v1 / course-wechat-v1`）、`document_processing_runs` 表 + 冻结 Profile Snapshot、Canonical Document（Markdown + paragraph blocks + 页码溯源）、三段质量门、Run 编排（createRun/processRun/retry/僵尸兜底/409）、双队列迁移窗口 + 特性开关 `PROCESSING_PROFILES_ENABLED`、蓝绿重建 scope（inherited/all）、REST 端点（processing-profiles / processing-runs / rebuild）、前端 Profile 选择（创建/编辑/上传覆盖/处理历史/重解析）。现有 `general/qa/custom` 分块经 golden 用例验证无损迁移。首期 auto 仅快速解析（`pdf-parse` 逐页），Blocks 类型恒 paragraph。**版面解析（Docling）与 OCR（Rollout 5–6）、表格/图片结构块、资源 BlobStore 归档待 M4.1b**；真实文档验收与真 pg-boss/迁移回放留 QA 波。

## Summary

前端只向用户暴露**文档处理方案（Processing Profile）**，不直接暴露 `pdf-parse`、Docling、OCR 等底层实现。Profile 是一份服务端注册、显式版本化的处理配方，完整指定解析策略、清洗步骤和现有 `general / qa / custom` 分块器；每次执行先冻结不可变快照，再异步完成 `Parse → Clean → Canonical Document → Chunk → Embed`。

所有格式统一产出**可溯源 Markdown**：Markdown 是展示和分块表面，结构块保留标题、表格、图片、页码和资源引用。Profile 必须显式选择；首期“自动”只在 Profile 内选择快速解析、版面解析或 OCR，不自动猜测课程、财报、论文等业务类型。

## Boundaries

> 本节是反漂移边界。实现若越过以下范围，应先修改本文及 001/007，再修改代码。

**In-scope**

- 知识库默认 Profile、上传批次覆盖、单文档重新解析时覆盖；前端以业务名称和适用场景展示。
- 服务端版本化 Profile 注册表；Profile 组合解析策略、清洗器链和一个分块器，不允许客户端提交可执行代码。
- 每次处理创建不可变 `document_processing_runs` 快照，队列只传 `processingRunId`，消除配置在排队期间漂移。
- PDF 快速解析、版面增强解析和 OCR；Word、Markdown、TXT 继续复用同一 Profile 契约。
- Canonical Document：Markdown + 有序结构块 + 页码 + 图片资源引用 + 解析警告和统计。
- 表格保持行列结构；大表按行分块并重复表头；图片保存原资源，文本型图片可 OCR，图像语义描述留扩展点。
- Profile 变更可显式应用到已有文档并复用 007 的版本化蓝绿重建；重新解析失败不得替换旧切片。
- 解析阶段的耗时、引擎、Profile 版本、页数、表格数、OCR 页数、警告和错误可查询、可观测。

**Out-of-scope**

- 用户编写脚本、上传插件或在前端自由拖拽编排任意 Pipeline。
- 首期由 LLM 自动判断课程、财报、论文等业务 Profile；误判会触发破坏性清洗，不接受该风险。
- 首期的图片多模态向量检索、图表数值精确还原和视觉问答；只保存资源、OCR 文本及已有描述。
- 对所有 PDF 表格、公式和阅读顺序作百分之百正确承诺；质量必须由真实语料基准验证。
- 在前端分别暴露解析器、清洗器和分块器三个独立选择器；普通用户只选择 Profile。
- 首期允许运营人员无部署创建新 Profile；新增或修改 Profile 仍需代码、测试和发布。

**Invariants**

1. **执行配置不可变**：任务创建后只执行 Run 中冻结的 `profileSnapshot`，不得在 Worker 执行时读取最新 Profile 定义替换它。
2. **旧检索结果不空窗**：解析、清洗、分块、向量化全部成功后才原子交换；失败 Run 不删除或覆盖当前活动切片。
3. **Profile 与实现解耦**：前端和 API 认 `profileId + profileVersion`，不以 Docling、`pdf-parse` 等库名作为产品契约。
4. **Canonical Document 可溯源**：每个可检索结构块至少关联文档和页码范围；图片/表格可关联 BlobStore 资源。
5. **特殊清洗不得静默误删**：清洗前后必须执行质量门；异常删减、空文本和零切片均失败并保留旧版本。
6. **不可信文件隔离执行**：重型 PDF/OCR 解析器在受限进程或容器中运行，不与 NestJS API 进程共享无界资源。

## Context

当前实现已经有三种分块器：`CHUNKER_REGISTRY` 注册 `general / qa / custom`，其中 `custom` 实际承载课程/公众号来源的特殊清洗与切分；但对外名称“定制”过于宽泛。PDF 解析器只返回 `{ text }`，默认管线直接调用按文件类型注册的 parser、固定 `cleanText()` 和库级 `chunkTemplate`，无法保留页码、表格、图片和解析器版本。

现有队列数据只有 `{ documentId, targetVersion }`，Worker 执行时重新读取知识库配置。Profile 可编辑后，这会产生“入队时选择 A、执行时却运行 B”的不可复现问题。现有 `documents.lifecycle` 也只能描述一条扁平生命周期，无法同时表达“旧版本仍可检索，但最新重解析失败”。

007 曾明确把 OCR、内容类型 Profile、单文件覆盖和清洗配置排除在 M4 外；本设计是经真实内容需求触发的受控扩展，不开放通用数据工程或任意编排。

## Goals / Non-goals

**Goals**

- 让用户用一个 Profile 选择表达“这类文档应该怎样解析、清洗、分块”。
- 提升 PDF 标题、表格、多栏、扫描件进入 RAG 后的结构质量，同时保留快速路径。
- 让每次处理可复现、可重试、可比较，并与现有蓝绿重建和检索版本过滤兼容。
- 新增文章来源的专属规则时，只增加版本化 Profile/组件，不修改 Pipeline 主流程。

**Non-goals**

- 不把 RAGForge 扩展成任意 ETL 平台、低代码数据工程平台或通用 OCR 产品。
- 不改变 M5 检索读取 `kb.activeVersion` 的一致性语义。
- 不要求 Profile、解析器和 Canonical Document 类型进入 `@codecrush/otel`；它们属于 ingestion 域与公共 API 契约。

## Requirements & 关键数字

| 维度 | 设计值 | 依据与影响 |
|---|---:|---|
| 文档/切片规模 | 1000 文档 × 100 切片 = 10 万 | 沿用 001/007，Postgres+pgvector 足够 |
| 平均页数假设 | 20 页/文档，共 2 万页 | 用于解析容量规划；真实样本需校准 |
| 快速解析预算 | `<1s/文档`，1000 文档约 17 CPU 分钟 | 沿用 007 的文本型文档假设 |
| 版面解析预算 | `1–3s/页`，2 万页约 5.6–16.7 CPU 小时 | 规划假设，决定必须异步和限并发 |
| OCR 预算 | `3–10s/页`，2 万页约 16.7–55.6 CPU 小时 | 规划假设，禁止所有文档无条件 OCR |
| 上传限制 | 20MB/文件、100 文件/批 | 沿用 007；新增 500 页/文件上限 |
| 处理产物限制 | Canonical Document ≤50MB、结构块 ≤100000 | 防止异常 PDF 撑爆内存/存储 |
| 超时 | 快速 60s、版面 10min、OCR 15min | 超时只失败当前 Run，旧切片继续服务 |

若平均页数或解析时间低估 10 倍，单 Worker 的增强解析排队不可接受，必须按 Revisit 触发器拆独立 Worker 并横向扩容。

## Design

### 处理流程

```text
上传文件
  → 解析有效 Profile（知识库默认或文档覆盖）
  → 创建 document_processing_run 与不可变 Profile Snapshot
  → 队列发布 processingRunId
  → Parse
  → Normalize / Clean
  → Canonical Document（Markdown + Blocks + Assets）
  → Chunk（general / qa / custom）
  → Embed
  → 末端事务写入目标版本并更新 Run 终态
  → 单文档交换或知识库蓝绿切换
```

### Profile 模型

Profile 定义保存在 ingestion 域的服务端版本化注册表中，不新建可任意编辑的 `processing_profiles` 数据表。旧版本只要仍被 Run 引用就不得删除；客户端只能读取公开描述并提交合法的 `profileId + profileVersion`。

```ts
interface ProcessingProfileDefinition {
  id: string;
  version: number;
  label: string;
  description: string;
  supportedTypes: DocumentType[];
  parser: { mode: "fast" | "layout" | "ocr" | "auto" };
  normalizers: Array<{ id: string; config: Record<string, unknown> }>;
  chunker: {
    id: "general" | "qa" | "custom";
    config: Record<string, unknown>;
  };
}
```

首批 Profile 映射：

| Profile | 解析策略 | 清洗策略 | 分块器 |
|---|---|---|---|
| `general-v1` | 自动选择快速/版面/OCR | 基础 Markdown 规范化 | `general` |
| `faq-v1` | 自动选择快速/版面/OCR | 基础规范化 | `qa` |
| `course-wechat-v1` | 自动选择快速/版面/OCR | 公众号导航、推广、图片链接和课程结构处理 | `custom` |
| `layout-document-v1` | 强制版面解析 | 页眉页脚、阅读顺序和表格规范化 | `general` |
| `scanned-document-v1` | 强制 OCR | OCR 后段落和版面规范化 | `general` |

“自动”仅选择解析实现：优先快速解析，文本密度过低、缺少文本层或质量门不通过时升级版面/OCR。它不得自动切换到 `course-wechat-v1` 等带破坏性清洗的业务 Profile。

### Canonical Document

```ts
interface CanonicalDocument {
  markdown: string;
  blocks: Array<{
    type: "heading" | "paragraph" | "table" | "image" | "list" | "code";
    markdown: string;
    pageStart: number;
    pageEnd: number;
    assetKey?: string;
  }>;
  warnings: string[];
  stats: {
    pages: number;
    tables: number;
    images: number;
    ocrPages: number;
  };
}
```

- Markdown 是统一展示和分块表面；标题、列表、引用、代码和表格不得在清洗时压平成 TXT。
- Blocks 是溯源与类型边界；Chunker 可继续消费 Markdown，但产出的 Chunk 必须继承覆盖到的页码和内容类型。
- Canonical Document 与图片资源写 BlobStore：`kb/{kbId}/{documentId}/runs/{runId}/canonical.json` 与 `.../assets/*`。Postgres 只保存键、统计和状态；`parsed_text` 在迁移期作为兼容字段保留。
- 小表整表成块；大表按数据行分片，每片重复标题和表头。装饰图片忽略，文字截图 OCR；流程图/图表只保存原图和已有描述，首期不调用外部视觉模型。

### 组件与模块归属

- `ingestion` 拥有 Profile 注册表、Profile 解析器、`DocumentParserPort`、`DocumentNormalizerPort`、`ChunkerPort`、Run 编排和质量门。
- `documents` 拥有上传、文档元数据和文档级 Profile 覆盖；只经 ingestion 导出的 service 创建 Run，不直接 import parser/normalizer adapters。
- `knowledge-bases` 拥有默认 Profile 引用；改变默认值不静默改变已存在 Run。
- `platform/storage` 继续只提供 `BlobStore`；`platform/queue` 继续只提供 `Queue`。
- Docling/OCR 是 ingestion 拥有的 parser adapter，通过内部 HTTP 或进程协议调用受限服务；NestJS 主进程不加载 Python/模型运行时。
- `@codecrush/contracts` 只包含 Zod DTO、Profile 公共描述和请求枚举，不包含 parser 实现、Node Buffer 或运行时依赖。

Profile、Parser、Normalizer、Chunker 注册表必须经 NestJS DI 装配。业务服务不得直接 import `adapters/`；这同时修正当前默认管线直接 import parser/chunker registry 与 003 边界不完全一致的问题。

### 数据模型

```text
knowledge_bases
  + default_profile_id text
  + default_profile_version int

documents
  + profile_override_id text null
  + profile_override_version int null

document_processing_runs
  id uuid pk
  document_id uuid fk cascade
  target_version int
  profile_id text
  profile_version int
  profile_snapshot jsonb
  parser_engine text null
  parser_version text null
  canonical_blob_key text null
  status queued|running|succeeded|failed
  warnings jsonb
  metrics jsonb
  error text null
  started_at / ended_at / created_at

chunks
  + processing_run_id uuid
  + content_type text
  + page_start int null
  + page_end int null
  + asset_key text null
```

`profile_snapshot` 是服务端生成的可信配置，不接受客户端 JSON 透传。`document_processing_runs` 一行代表一次尝试，解决旧 `lifecycle jsonb` 无法同时表达活动版本和失败重试的问题；迁移期继续写旧 lifecycle 供现有 UI 使用。

### 选择、版本与重建语义

1. 知识库保存默认 `profileId + profileVersion`；文档覆盖为空时继承，非空时使用覆盖。
2. 上传或重新解析时解析有效 Profile 并立即写入 Run Snapshot；队列只发布 `{ processingRunId }`。
3. Profile 发布新版本不自动升级知识库或旧文档，必须由管理员显式选择，避免同名 Profile 行为漂移。
4. “重试”复用失败 Run 的 Snapshot；“重新解析”默认使用当前有效 Profile，也允许显式改用其他 Profile。
5. 修改知识库默认 Profile 只影响未来 Run；若要处理旧文档，前端必须再次确认并调用重建命令。重建范围可选 `inherited`（只处理未覆盖文档）或 `all`。
6. 单文档 Run 成功后在末端事务交换；全库重建仍按 007 写 building version，全部到达终态后切 active version。失败 Run 不删除旧版本。

### REST 契约

| 端点 | 说明 |
|---|---|
| `GET /api/processing-profiles?documentType=pdf` | 返回可选 Profile 描述、版本、适用格式和处理摘要 |
| `POST/PATCH /api/knowledge-bases` | 创建/修改默认 `processingProfileId + processingProfileVersion` |
| `POST /api/knowledge-bases/:id/documents` | multipart 增加可选 Profile 覆盖；缺省继承知识库 |
| `POST /api/documents/:id/parse` | 创建新 Run；可提交 Profile 引用，缺省使用当前有效 Profile |
| `GET /api/documents/:id/processing-runs` | 返回处理历史、状态、引擎、统计、警告和错误 |
| `GET /api/documents/:id/content` | 默认返回活动版本 Markdown；迁移期保留 `text` 兼容字段 |
| `POST /api/knowledge-bases/:id/rebuild` | 显式把新默认 Profile 应用到 `inherited` 或 `all` 文档 |

### 前端

- 知识库创建/编辑把“分块模板”升级为“文档处理方案”下拉框；Profile 数量可增长，不再使用三项固定 Segmented。
- 每个选项显示业务名称、适用场景和只读摘要，例如“自动 PDF 解析 · 基础清洗 · 标题结构分块”。底层库名仅在处理详情展示。
- 上传抽屉默认显示“继承知识库：通用文档”，允许本批覆盖，不分别展示 Parser/Cleaner/Chunker。
- 文档列表保持紧凑；处理详情/生命周期抽屉展示 Profile、实际解析器、页数、表格数、OCR 页数、Chunk 数和警告。
- “重试”不弹配置选择；“重新解析”Modal 允许使用当前方案或更换 Profile。
- 当前 `custom` 的用户文案改为“课程/公众号文章”，避免让用户误以为它是任意自定义规则。

## Failure modes

| 故障 | 系统行为 | 用户可见结果 |
|---|---|---|
| Run 引用的 Profile 版本不存在 | 不回退最新版本，Run 失败 `PROFILE_VERSION_UNAVAILABLE` | 明示配置版本不可用；旧切片继续检索 |
| Docling/OCR 挂或超时 | 当前 Run 失败；仅 `auto` 可按 Snapshot 中的策略降级 | 首次处理显示失败；重解析时旧版仍可用 |
| Parser 返回空文本/乱码/超大产物 | 质量门拒绝，不进入 Embed | 显示解析质量错误和警告 |
| 清洗后正文减少超过 80% | 默认失败 `CLEAN_SUSPICIOUS`；Profile 可在 Snapshot 中收紧但不得静默关闭 | 提示清洗规则可能不匹配文档 |
| Chunk 为 0 或单块超过硬上限 | Run 失败，不交换版本 | 显示分块错误，可换 Profile 重试 |
| 同一文档并发创建活动 Run | 数据库约束或 service 返回 409 | 提示已有任务处理中 |
| Worker 崩溃/重复投递 | pg-boss 续跑；`singletonKey=runId`，末端写入幂等 | 状态继续更新，不出现重复 Chunk |
| 重建部分文档失败 | 沿用 007：失败亦为终态，切换后该文档新版暂缺；旧全库版本在切换前一直可用 | 失败文档可单独重试 |
| 文档在 Run 中被删除 | Run 取消并清理孤儿产物；FK cascade 兜底 | 文档消失，不产生全局错误 |

质量门至少检查：文件页数/大小、Markdown 非空、清洗删减比例、结构块数量、单块 token 上限、Chunk 数和 Canonical Document 大小。所有阈值进入 Profile Snapshot 或平台只读配置，确保可复现。

## Rollout & operations

1. 先加 `document_processing_runs`、Profile 引用和 Chunk 溯源列，全部可空；保留 `chunk_template / parsed_text / lifecycle`。
2. 注册 `general-v1 / faq-v1 / course-wechat-v1`，分别映射当前 `general / qa / custom`，先用现有 parser 跑通 Profile 与 Run Snapshot，不改变内容结果。
3. 前端切换为 Profile 选择；旧 `chunkTemplate` API 继续双写一段迁移窗口，支持旧前端回滚。
4. 引入 Canonical Document 与 BlobStore 产物，更新 Chunk 页码/类型；验证后停止依赖 `parsed_text`。
5. 以可选基础设施 Profile 接入 Docling 版面解析，再接 OCR；服务不可用时不影响现有快速 Profile。
6. 真实语料验收通过后停止读取旧字段；删除旧字段另开迁移，不与首轮发布绑定。

回滚采用特性开关 `PROCESSING_PROFILES_ENABLED=false` 与旧字段双写：旧镜像继续读取 `chunk_template / parsed_text / lifecycle`；所有数据库变更先加后用，不做破坏性回滚。

**在工作信号**

- 上传普通 PDF 能看到 Profile Snapshot、实际 parser、Canonical Markdown 和带页码 Chunk。
- 扫描 PDF 经 OCR 产生非空 Markdown；Docling 下线时只失败相关 Run。
- Profile 在任务排队后发布新版本，已排队 Run 的 Snapshot 与产出不改变。
- 重解析失败后，检索仍命中旧 active version；成功后才切换。
- 指标至少包含 `profile_id/version`、`parser_engine/version`、阶段耗时、页数、OCR 页数、表格/图片/Chunk 数、警告和错误码。

## Security

- PDF/Office 文件均为不可信输入；继续校验扩展名与 magic bytes，并增加页数、产物、超时和结构块上限。
- Docling/OCR 服务只监听内网，使用内部 API Key 或等价服务身份；禁止客户端直接访问。
- 解析容器使用非 root、只读根文件系统、临时目录配额、CPU/内存限制，不挂载宿主文档目录，不接受用户提供 URL。
- 模型与 OCR 资源在镜像构建或启动阶段预置；处理用户文档时默认禁止外网出站。未来若接外部视觉模型，必须新增数据出境和密钥设计审查。
- `profileSnapshot` 只能由服务端注册表生成；客户端只提交 Profile 引用，防止任意命令、路径、正则灾难或资源参数注入。
- Canonical Document 和图片沿用文档鉴权，不提供静态公开 URL；错误日志不得记录完整正文。

## Alternatives considered

| 决策 | 选择 | 拒绝 | 放弃了什么 |
|---|---|---|---|
| 用户配置面 | 选择业务 Profile | 直接选择 `pdf-parse` / Docling / OCR | 少了底层自由组合，换来稳定产品语义 |
| Pipeline 配置 | Profile 打包 Parse+Clean+Chunk | 三个独立下拉框 | 少了任意组合，避免无效组合和配置爆炸 |
| 执行一致性 | 不可变 Run Snapshot | Worker 运行时读取最新 KB/Profile | 多存一份 JSON，换来可复现和无竞态 |
| 统一中间格式 | Markdown + Blocks + Assets | 仅 TXT / 仅 Markdown | 模型和存储更复杂，换来结构与页码溯源 |
| Profile 来源 | 服务端版本化代码注册 | DB 任意编辑 / 用户脚本 | 新增 Profile 需发布，换来测试与安全边界 |
| PDF 策略 | 快速路径 + 按需版面/OCR | 所有 PDF 统一 Docling/OCR | 多一个路由层，换来吞吐和成本可控 |
| 业务识别 | 用户显式选 Profile | LLM 自动猜课程/财报/论文 | 多一次用户选择，避免误判触发破坏性清洗 |

## Assumptions

1. 首期 Profile 数量不超过 10，且由开发人员维护；若运营必须无部署配置，需引入受约束的声明式 Profile 数据模型。
2. 单文件 20MB、单批 100 文件仍适用；500 页上限不会拒绝主要业务语料。
3. 平均 20 页、版面解析 1–3 秒/页、OCR 3–10 秒/页只是容量假设，上线前必须用真实样本测量。
4. 知识库默认 Profile 改动不应静默重建旧文档；应用到已有文档必须二次确认。
5. 首期问答仍是文本检索；图片保存、OCR 和文本描述足够，暂不需要视觉向量索引。
6. Docling/OCR 以本地或私有网络服务运行；若改为第三方云服务，安全与成本结论需要重做。

## Revisit triggers

- Profile 超过 10 个，或非开发管理员需要无部署新增 Profile → 设计受约束的声明式 Profile 表与校验器。
- 入库超过 100 文档/分钟，或增强解析排队 P95 超过 5 分钟 → 从 NestJS 同进程 Worker 拆独立队列与解析 Worker 池。
- 超过 20% 的问答需要理解流程图、图表或照片 → 增加视觉描述/多模态 embedding 与独立 image chunks。
- 手动覆盖 Profile 的文档超过 10%，或错误 Profile 选择超过 5% → 引入只推荐不自动执行的 Profile 分类器。
- Canonical Document 与资产超过 100GB → 增加压缩、保留期、对象存储生命周期和历史 Run 清理策略。

## References

- 001：平台总架构与通用 RAG 边界。
- 002：M4.1 文档处理 Profile 实施顺序。
- 003：ingestion 模块、端口/适配器和 contracts 依赖边界。
- 007：原 M4 入库、蓝绿重建、幂等和知识库管理设计；本文仅扩展文档处理配置与产物模型。
- 当前实现：`apps/backend/src/modules/ingestion/`、`apps/backend/src/modules/documents/`、`apps/backend/src/modules/knowledge-bases/`、`packages/contracts/src/knowledge-bases.ts`、`packages/contracts/src/documents.ts`。
