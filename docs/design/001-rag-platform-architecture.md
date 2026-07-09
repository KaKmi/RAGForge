---
title: "CodeCrushBot RAG 平台架构"
description: "通用 RAG 平台的系统架构：NestJS 薄编排 + Postgres/pgvector + OTel→Collector→ClickHouse 可观测，本地优先、阿里云就绪。"
category: "design"
number: "001"
status: draft
services: [backend, frontend, observability, deploy]
related: ["design/007"]
last_modified: "2026-07-08"
---

# 001 — CodeCrushBot RAG 平台架构

## Status

`draft` — 架构决策已通过 `/ship:arch-design` 完成（9/9 lens、6 项拒绝备选、6 项假设、7 项 revisit 触发器），尚未开始实现。实现启动后逐屏落地时，将本文相关章节推进为 `current`，并对照代码校验。
2026-07-08：随知识库产品重设计做 M4 修订（管线四阶段可插拔、分块双模板、切片版本化蓝绿重建、切片删除制、文档元数据），详见 007。

## Summary

CodeCrushBot 是一个**通用 RAG 平台**（课程问答只是示例 mock 数据）。它把一次问答拆成可配置、可追踪、可优化的流水线：模型接入 → 知识库/切片（固定语义策略）→ Agent 配置 → 问答/检索 → **Trace 追踪**。核心技术抉择：后端 NestJS 自研薄编排；数据面 Postgres+pgvector 单库；**可观测走 OpenTelemetry SDK → Collector → ClickHouse 导出器的标准 OTLP 链路**，从而"标准化、可迁移"（日后换 Jaeger/Tempo/SLS/ARMS 零改应用）。本地 docker-compose 优先，阿里云托管服务（Tier B）设计就绪、择期落地。

## Boundaries

> 反漂移边界。任何实现若越过这些边界，应先回来改本文，而不是让代码与设计各说各话。

**In-scope（首期核心主链路）**
- 模型接入（LLM/Embedding/Rerank 按**协议格式**注册：不绑厂商、只做协议适配层；密钥加密、连通性测试、按类型的可编辑默认参数）
- 知识库 / 文档 / 切片：**四阶段可插拔管线**（解析→清洗→分块→向量化；分块模板「通用/问答」库级二选一），切片查看/搜索/批量删除，文档级元数据，切片版本化蓝绿重建，生命周期状态（详见 007）
- Agent 配置（绑定 KB、三类模型、4 个 Prompt、检索参数、兜底转人工）
- 问答/检索：RAG 编排 + 检索测试台
- Trace 追踪：每次问答一条 OTLP trace，落 ClickHouse，列表 + 详情

**Out-of-scope（首期明确不做，schema 不堵死）**
- 评测集 / 评测管理 / 评测报告（里程碑 2）
- 运行看板聚合图表（里程碑 2）
- 多租户 / RBAC（当前单角色 admin + demo 用户）
- **通用数据处理工程 / 按内容类型细分的模板矩阵**（分块只开放「通用/问答」两模板，解析/清洗固定默认实现；管线各阶段已端口化，扩展留位——产品刻意约束，非遗漏。~~切片固定为语义策略~~ 2026-07-08 M4 修订为双模板）
- HA / 水平扩展 / 多区域

**Invariants（不可违反的不变量）**
1. **埋点绝不进入问答关键路径**：可观测组件（Collector/ClickHouse）故障不得导致问答失败或增加用户可感延迟。
2. **应用只吐 OTLP，从不直写 ClickHouse**；通用 trace SDK 不感知物理存储，ClickHouse 表结构由 Collector 导出器拥有，读侧只经由自有 VIEW 防腐层访问。
3. **一切外部依赖藏在端口/连接串背后**（`ModelProviderPort` / `RetrieverPort` / `BlobStore`），保证本地自建 ↔ 阿里云托管服务可零改动切换。
4. **模型 API Key 永不明文回传前端**，存储加密。
5. `messages.trace_id` 外键必须写入，保证每条回答可一键回溯其 trace。

## Context / 背景

来源是一份低代码导出的单文件 UI 原型（`CodeCrushBot 单文件版.html`，约 15 屏），设计了完整的 RAG 平台管理台 + C 端问答页。原型自带 mock 数据，产品定位是**通用 RAG 平台**，重点三词：**可配置、可追踪、可优化**。用户特别指定：可追踪部分用 **ClickHouse** 存储，数据要**标准化、可迁移、符合 OTLP**。原型的 Trace 详情已画出 span 树（问题改写→意图识别→多路召回[向量+关键词]→重排→命中→生成），每个 span 带 `kind / tokens-in / tokens-out / cost / status`，并有"OTLP Span JSON"导出——与 OpenTelemetry GenAI 语义约定几乎 1:1。

## Goals / Non-goals

**Goals**：跑通一条"配置 → 问答 → 可追踪"的完整主链路；可观测数据标准化可迁移；前端 1:1 还原原型 UI；本地一键起、日后平滑上阿里云。

**Non-goals**：见 Boundaries 的 Out-of-scope。核心是**不做通用数据工程**、不做高可用/高并发。

## Requirements & 关键数字

| 维度 | 值 | 依据 |
|---|---|---|
| 峰值 QPS | 持续 ≤10 / 突发 ≤50 | mock「近7日 1,284」≈180/天≈0.002 qps 均值，取 5000× 余量 |
| 问答延迟 | p50 ~2–3s（生成 1.7s + 召回 0.35s 主导），30s 熔断 | mock span 耗时 + 失败样本 30.0s |
| 平台自身开销 | <50ms，埋点异步 | Invariant 1 |
| Trace 量 | ~10 span/问答；满负荷 ≈8.6M span/天 | ClickHouse 轻松，TTL 30 天 |
| 向量规模 | ~100k 向量 × 1024 维 ≈ 400MB | 1000 文档 × 100 分块估算 → pgvector 足够 |
| 一致性 | 配置事务（Postgres）/ trace 追加分析（ClickHouse） | 见数据模型 |

结论：低 qps → **单实例后端 + 单 Postgres + 单 ClickHouse + 单 Collector 全部够用**，不上集群。

## Design

### 组件与模块（NestJS）

`auth`（JWT）· `models`（模型注册 + `ModelProviderPort`，首个适配器 OpenAI 兼容，覆盖 DeepSeek/Qwen/GPT/Claude/vLLM）· `knowledge-bases` · `documents`（上传/生命周期）· `ingestion`（worker：解析→清洗→分块→向量化，四阶段端口化可插拔，整条 pipeline 亦为可替换端口，见 007）· `chunks` · `retrieval`（`RetrieverPort`：向量+关键词多路召回→融合→重排，**chat 与检索测试台共用**）· `agents` · `prompts`（版本/diff/发布/回滚/变量抽取）· `chat`（RAG 编排 + SSE 流式，产出完整 OTLP trace）· `traces`（只读 ClickHouse）· `conversations`。

编排采用**自研薄编排**：每个流水线阶段 = 一个显式 span，不引入 LangChain.js（见 Alternatives）。

### 数据模型

**控制面 — Postgres + pgvector（单库，事务）**

- `model_providers(id, type[llm/embedding/rerank], protocol[openai_compat/anthropic/gemini/cohere/jina/dashscope/self_hosted], name, base_url, api_key_enc, deployment_id, params jsonb, enabled)` — **无 provider（厂商）字段**：平台只做协议适配，`(type, protocol)` 是运行期请求构造的路由键，Base URL 决定打到谁家；合法组合由契约层 `PROTOCOLS_BY_TYPE` 收口（llm: openai_compat/anthropic/gemini；embedding: self_hosted/openai_compat/gemini/cohere/jina；rerank: self_hosted/openai_compat/cohere/jina/dashscope——rerank 的 openai_compat 指 `/v1/reranks` 扁平体生态形态，如阿里云百炼 compatible-api 的 qwen3-rerank；dashscope 为原生 text-rerank 形态）。`params` 为按类型的默认调用参数（llm: temperature/max_tokens；embedding: dimensions/batch_size；rerank: top_n/threshold），下游调用时合并
- `knowledge_bases(id, name unique, desc, chunk_template[general/qa], embedding_model_id, status[ready/building/failed], active_version, building_version)` — Embedding 创建后锁定；改 chunk_template 触发全库版本化蓝绿重建（007）
- `documents(id, kb_id, name, type, size, status[pending/queued/processing/failed/ready], blob_key, parsed_text, metadata jsonb, chunk_version, lifecycle jsonb, error, uploaded_at, updated_at)`
- `chunks(id, doc_id, kb_id, version, seq, text, token_count, section, embedding vector(1024), tsv tsvector[M5 回填])` — 向量(pgvector HNSW) + 关键词(FTS) 同表；~~enabled~~ 已改删除制（007）；检索恒过滤 `version = kb.active_version`
- `agents(id, name, desc, status, gen_model_id, light_model_id, rerank_model_id, prompt_*_ver_id×4, top_k, top_n, threshold, multi_recall, vec_weight, fallback_human, updated_at)`
- `agent_kbs(agent_id, kb_id)`
- `prompts(id, name, node[rewrite/intent/reply/fallback], current_version_id)`
- `prompt_versions(id, prompt_id, version, body, variables jsonb, note, author, status[draft/prod/archived])`
- `conversations(id, agent_id, user_id, title)` · `messages(id, conv_id, role, content, trace_id, confidence, citations jsonb)` — **`trace_id` 是可追踪关键外键**

**分析面 — ClickHouse**：`otel_traces`（Collector 的 `clickhouseexporter` 建的标准表：TraceId/SpanId/ParentSpanId/SpanName/SpanKind/Duration/StatusCode/SpanAttributes(Map)/ResourceAttributes/Events…）+ **我们自有的读 VIEW**（隔离导出器 schema 漂移）。RAG 数据以属性承载：LLM span 用官方 `gen_ai.*`（`gen_ai.request.model` / `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` / `gen_ai.system`），RAG 专有用自定义 `rag.*`（`rag.retrieval.top_k` / `rag.chunk.scores` / `rag.citation.ids` / `rag.cost.usd` / `rag.prompt.version_id`）。命中分块/引用用 **span events + 只存 chunk_id 引用**，详情页回 Postgres 取正文——避免大段正文塞进 span 撑爆 trace。

### 契约（先定契约，后写内部）

- `RetrieverPort.retrieve(query, {kb, embedModel, topK, threshold, multi, weights, rerankModel, topN}) -> Hit[]`，`Hit = {chunkId, docId, text, section, vecScore, kwScore, rerankScore, finalScore}`
- `ModelProviderPort`: `chat() / embed() / rerank()`（M3 先落 `testConnection()`）——下游只认"模型类型 + model_id"，协议差异全部被适配层吸收：单一 DI 适配器内按 `(type, protocol)` 查纯函数 request builder 表分发（认证差异内聚在 builder：openai_compat/cohere/jina/dashscope 用 Bearer；anthropic 用 `x-api-key`+`anthropic-version`；gemini 用 `x-goog-api-key` 头，不用 `?key=` 查询参数防日志泄漏）
- `BlobStore`: `put/get/delete`（本地卷 ↔ OSS 可换）
- REST（对齐各屏资源）+ **SSE**（问答 token 流式）
- **OTLP** = 可观测契约：应用 → Collector → ClickHouse；`@codecrush/otel*` 只负责 trace 语义与 OTLP 发射，ClickHouse VIEW / Trace API 留在 `infra/` 与 `traces` 模块。

### 可观测数据流（核心）

```
 NestJS 后端                    OTel Collector                 ClickHouse
┌──────────────┐   OTLP/gRPC  ┌──────────────────┐  插入   ┌────────────────┐
│ @codecrush/  │ ───────────► │ batch / 重试 /    │ ──────► │ otel_traces 表 │
│ otel 发 spans │  (标准协议)   │ 脱敏 / 导出器      │         │ (导出器建, 标准) │
└──────────────┘              └────────┬─────────┘         └───────┬────────┘
   gen_ai.*/rag.* 属性                 │ 换导出器即可                │ traces 模块只读
                                       └──► Jaeger/Tempo/SLS/ARMS    ▼ 自有 VIEW(防腐层)
                                            (零改应用代码)         Trace 列表/详情 API
```

"标准化、可迁移"的落地含义：应用只按 OTLP 吐数据，存储/后端由 Collector 的 exporter 决定，日后换观测后端只在 Collector 加/换 exporter，**应用代码零改动**。

包边界：`@codecrush/otel-conventions` 保存 `gen_ai.*` / `rag.*` 属性 key 与 observation 类型；`@codecrush/otel` 提供 Node 侧 `withSpan` / `trace.llm` / `trace.retrieve` 等原语并发出 OTLP。二者不 import ClickHouse、不知道 `otel_traces`/VIEW schema；物理存储和查询由 `infra/clickhouse` 与 `apps/backend/modules/traces` 拥有。

> **观测子系统的完整设计**（自研轻量 Langfuse：Session>Trace>Observation 模型、trace=一轮、结束即写、大 payload offload、VIEW 读模型、两级 UI）见 `004-trace-observability`。本版一等公民为 RAG 节点，agent/tools 留口不落地。

## Failure modes

- **生成超时 30s → 熔断**：trace 标 ERROR，返回兜底/转人工；transient 5xx 仅对幂等阶段（改写/embed）重试 1 次，生成不重试（省钱）。
- **Collector / ClickHouse 挂**：SDK BatchSpanProcessor 有界队列 + Collector 磁盘持久队列重试；满则丢 span，**问答照常成功**（Invariant 1）。
- **一路召回失败**（关键词挂）→ 降级纯向量、span 打标、继续。
- **重新解析幂等**：切片先算好（含向量），末端单事务 delete+insert 交换，检索无空窗；全库重建走版本化蓝绿（building_version 完成后原子切 active_version，见 007）；pg-boss singletonKey 保证单文档单 worker，杜绝重复向量。
- **Postgres 挂** = 控制面不可用、chat 取不到配置 → 硬失败（单点，首期接受，见 Revisit）。

## Rollout & operations

**本地（优先，dev + 可作廉价 staging）**：`docker-compose up` 起 Postgres+pgvector · ClickHouse · OTel Collector · MinIO(可选，先本地卷) · backend · frontend。控制面迁移用 Drizzle；ClickHouse 表由导出器自动建 + 自有读 VIEW 初始化 SQL。

**阿里云（Tier B，设计就绪、择期落地）**：本地自建组件 → 阿里云托管服务，仅改环境变量（Invariant 3）。

```
                    公网 443/TLS
              ┌──────▼───────┐
              │   ALB (WAF)  │  唯一公网入口
              └──────┬───────┘
      ┌──────────────┴──────── VPC 内网 ────────────────┐
   ┌──▼───────────────┐  OTLP  ┌────────────────────┐   │
   │ ECS/SAE          ├───────►│ OTel Collector(容器) │   │
   │  NestJS(容器,ACR) │        └───┬──────────┬─────┘   │
   └──┬────────┬──────┘        ┌────▼────┐ ┌───▼───────┐ │
   ┌──▼──┐  ┌──▼──┐           │ApsaraDB │ │(可选)SLS/  │ │
   │RDS  │  │ OSS │           │ClickHouse│ │ARMS(零改)  │ │
   │PG+  │  │文档  │           └─────────┘ └───────────┘ │
   │pgvec│  └─────┘   KMS 加密 API Key, RAM 角色免密访问   │
   └─────┘   前端静态 → OSS 托管 + CDN                     │
      └───────────────────────────────────────────────────┘
```

映射：Postgres+pgvector→RDS PG(开 pgvector) · ClickHouse→ApsaraDB ClickHouse · 本地卷→OSS · 环境变量密钥→KMS · 入口→ALB · 镜像→ACR · 前端→OSS+CDN。

**发布/回滚**：ACR 推镜像 → 滚动更新；数据服务独立于发布；回滚=切回旧镜像 tag；DB 迁移前向兼容（先加列后用）。**"在工作"信号**：/health 全绿 + 测试问答 N 秒内出现在 Trace 列表 + 上传文档能走到 ready。

## Security

- 信任边界：浏览器↔后端（JWT + admin 接口鉴权）；后端↔LLM 厂商（出站，API Key=密钥）；后端↔存储（内网）。
- 密钥：`api_key_enc` 应用层加密（阿里云用 KMS），返回前端掩码，永不回传明文（Invariant 4）。
- **Trace 脱敏**：query/prompt/召回内容可能含 PII，导出前属性脱敏，Collector 层再加一道 redaction processor。
- 阿里云：全服务 VPC 内网，仅 ALB 出公网；backend 用 RAM 角色免密访问 OSS/KMS。

## Alternatives considered

| 决策 | 选择 | 拒绝 | 放弃了什么 |
|---|---|---|---|
| 可观测 | OTel SDK→Collector→CH 导出器 | 应用直写 CH / 托管 APM(Langfuse) | 多一组件、读模型耦合导出器 schema（VIEW 防腐）—— 换标准可迁移 |
| RAG 编排 | 自研薄编排 | LangChain.js / LlamaIndex.TS | 部分现成 loader —— 换干净可追踪 span + 全控 |
| 数据存储 | Postgres+pgvector 单库 | Qdrant/Milvus / OpenSearch | 大规模 ANN/hybrid 极致性能 —— 换最小运维面 + 事务一致 + 可移植 SQL |
| 异步入库 | pg-boss(跑在 PG) | BullMQ+Redis / 进程内 | Redis 生态 —— 换不加服务 + 持久 + 幂等 |
| 前端 | React+Vite+TS+Ant Design | Vue / 保留低代码单文件 | —（自定义标签难维护） |
| 流式 | SSE | WebSocket / 无 | 双向能力（用不上） |

## Assumptions

1. 前端 = React + Vite + TS + Ant Design（已确认）
2. 规模 ≤10 qps 内部工具（已确认）；若转多租户 SaaS(×100) → 重估向量库 + HA
3. 首个模型适配器 = OpenAI 兼容；dev 期可用 mock provider，真 key 由用户提供
4. 评测 + 看板延到里程碑 2，schema 预留不堵死
5. 对象存储先本地卷，后续换 MinIO/OSS
6. span 保留 TTL 30 天（可配）
7. 部署：本地 docker-compose 优先，阿里云 Tier B 择期落地

## Revisit triggers

- pgvector → 专用向量库：>5M 向量或 hybrid 召回质量不达标
- 单机 → HA/多实例(SAE/ACK)：引入可用性 SLA
- pg-boss → BullMQ/Kafka：入库 >100 doc/min
- Collector 单点 → 网关集群：>50k span/s
- 无 RBAC → 加：多团队
- 分块模板仅「通用/问答」→ 扩充模板 / 开放数据工程：真实内容出现邮件/表格类（分块阶段已端口化，加模板不动对象模型）
- otel_traces schema 漂移 → VIEW 防腐层吸收；锁定 Collector 版本

## References

- 原型：`CodeCrushBot 单文件版.html`（15 屏 UI + mock 数据）
- OpenTelemetry GenAI 语义约定（`gen_ai.*`）
- OpenTelemetry Collector `clickhouseexporter`
- 阿里云：RDS PostgreSQL(pgvector) / ApsaraDB for ClickHouse / OSS / KMS / ALB / ACR / SLS / ARMS
