---
title: "RAG 平台实现路线图（模块级）"
description: "按依赖排序的模块级实现路线图：地基→可观测→用户/骨架→可配置域→问答/追踪，逐波用 /ship:design 拆细 spec。"
category: "design"
number: "002"
status: draft
services: [backend, frontend, observability, deploy]
related: ["design/001", "design/007"]
last_modified: "2026-07-08"
---

# 002 — RAG 平台实现路线图（模块级）

## Status

`draft` — 大块模块级路线图，承接 `001-rag-platform-architecture` 的架构决策。用于统筹执行顺序；**每一波再用 `/ship:design` 拆成可执行 spec + plan**。随各波落地，将对应模块状态在本文更新，并把细粒度产物记入各自 plan。

## Summary

把 001 的架构拆成 12 个模块（首期 M0–M9，里程碑 2 为 M10–M12），**严格按依赖先行排序**。核心策略：**M2 先把所有页面骨架（含首页、Agent 配置）1:1 布局搭出（空态/mock），让全貌可见可点；M3+ 再按依赖顺序往骨架里填真实逻辑**。最没底的 OTLP→ClickHouse 链路在 M0.5 第一个验证掉。

## Boundaries

> 反漂移边界 + 排序不变量。改顺序/范围先改本文。

**In-scope（首期 M0–M9）**：工程地基、可观测最小闭环、用户/认证、前后端骨架、模型接入、Prompt 管理、知识库/切片/入库、检索、Agent 配置、问答/RAG 编排、Trace 追踪完整版。

**Out-of-scope（里程碑 2，M10–M12，schema 不堵死）**：运行看板聚合、评测集/管理/报告、RBAC 权限。

**排序不变量（不可违反）**
1. **M0 → M0.5 最先**：无地基与埋点，其余模块无处依附；OTLP/ClickHouse 风险最高，必须第一个端到端验证。
2. **依赖先行**：M4 在 M3 后（需 embedding 模型）；M5 在 M4 后（需向量/切片）；M7 在 M3/M4/M5/M6 全部之后（Agent 是"绑定"一切的汇聚点）；M9 在 M8 后（M8 才产出真 trace）。
3. **骨架与逻辑分离**：页面 1:1 布局在 M2 一次性出壳；真实逻辑在 M3+ 按依赖填入。Agent 配置页壳子在 M2，功能在 M7。
4. 一波一个 `design → dev` 闭环，不一次性规划全部（见 001 及 /ship:design 质量门）。

## 依赖总览（DAG，箭头 = 依赖方向）

```
M0 工程地基 ─┬─► M0.5 可观测最小闭环 ──────────────────────────────┐
             ├─► M1 用户/认证 ──┐                                   │
             └─────────────────┴─► M2 前后端骨架(全页面壳 + 首页 + 登录)
                                          │
        ┌──────────────┬──────────────────┼
        ▼              ▼                   (骨架已就位, 逐块填真实逻辑)
   M3 模型接入      M6 Prompt 管理
        │              │
        ▼              │
   M4 知识库/文档/切片/入库
        │              │
        ▼              │
   M5 检索 ────────────┤
        │              │
        └──────┬───────┘
               ▼
        M7 Agent 配置  (汇聚 M3 模型 / M4 知识库 / M5 检索 / M6 Prompt)
               │
               ▼
        M8 问答 / RAG 编排  (产出完整 OTLP trace) ◄── M0.5 埋点地基
               │
               ▼
        M9 Trace 追踪(完整版)
──────────────────── 里程碑 2(首期不做, schema 预留) ────────────────────
        M10 运行看板    ·    M11 评测集/管理/报告    ·    M12 RBAC 权限
```

## 模块清单（按执行顺序）

### 波次 A — 地基

| # | 模块 | 大块内容 | 依赖 | 验收（可证伪） |
|---|---|---|---|---|
| **M0** | 代码架构 / 工程地基 | monorepo(NestJS 后端 + React 前端)；env/config 管理；端口抽象(`ModelProviderPort`/`RetrieverPort`/`BlobStore`)；docker-compose(Postgres+pgvector、ClickHouse、OTel Collector)；Drizzle 迁移；lint/日志 | — | `docker-compose up` 全绿；`/health` 200；迁移能跑 |
| **M0.5** | 可观测最小闭环 | NestJS 接 OTel SDK；Collector 配 `clickhouseexporter`；ClickHouse raw `otel_traces`；自有读 VIEW；traces 读模块骨架 + 一条 hello span 端到端。**首期不做 trace worker / 独立 observations 宽表** | M0 | 手动打一条 span → Collector → ClickHouse → traces API 读出。最没底链路先验掉 |

### 波次 B — 用户 & 骨架

| # | 模块 | 大块内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **M1** | 用户 / 认证 | 登录(JWT)、user 实体、auth guard。RBAC 留到 M12 | M0 | demo 账号登录；无 token 接口 401 |
| **M2** | 前后端页面骨架 | React+antd app shell、路由、管理台导航(分组：配置/验证&观测/数据飞轮，含知识缺口/评测集/效果评测入口)；登录页、首页(快速开始+运行看板占位)、及所有管理页(模型/知识库/切片/Agent 配置/Prompt/Trace/评测/知识缺口壳)的 1:1 布局壳子(数据 mock/空态)；后端各模块 skeleton + REST 脚手架 + OpenAPI；SSE 客户端 | M0, M1 | 15 屏可点开、布局还原；跳转通；API 契约生成 |

### 波次 C — 可配置域

| # | 模块 | 大块内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **M3** | 模型接入 | model_providers CRUD、密钥加密、连通性测试、**协议适配层**(LLM: OpenAI 兼容/Anthropic/Gemini；Embedding: 自部署/OpenAI 兼容/Gemini/Cohere/Jina；Rerank: 自部署/OpenAI 兼容(/v1/reranks)/Cohere/Jina/DashScope 原生；`(type,protocol)` 为请求构造路由键)、按类型可编辑参数(params jsonb) | M2 | 注册模型并"测试"通过；key 前端掩码、只写不回显 |
| **M6** | Prompt 管理 | prompts + 版本 + diff + 发布/回滚 + 变量抽取(`{var}`) | M2 | 建 Prompt、出新版本、diff、发布切生产、回滚 |
| **M4** | 知识库/文档/切片/入库 | KB CRUD(名称查重、分块模板 通用/问答、绑 M3 embedding 创建后锁定)、文档上传(BlobStore 本地卷、单文件/文件夹批量、自动/手动解析)、四阶段可插拔管线(解析→清洗→分块→向量化，pg-boss 异步)、切片版本化蓝绿重建(改模板全库重建、重建期检索用旧版)、切片查看/搜索/批量删除、文档元数据(jsonb)、生命周期状态——设计见 007 | M3 | 传 PDF 走到"就绪"；切片可见可删~~可开关~~(2026-07-08 改删除制)；改分块模板全库重建且重建期检索不空窗；失败可重试 |
| **M5** | 检索 | `RetrieverPort`:向量召回 + 关键词召回 + 融合 + 重排；检索测试台(与 chat 共用) | M4, M3 | 测试台输入问题出命中分块 + 三种分数 |

> M3 与 M6 独立、可并行；M4 在 M3 后；M5 在 M4 后。

### 波次 D — 汇聚 & 可追踪

| # | 模块 | 大块内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **M7** | Agent 配置 | agent CRUD:绑知识库(M4)、三类模型(M3)、4 个 Prompt(M6)、检索参数(topK/topN/阈值/多路/权重)、兜底转人工 | M3,M4,M5,M6 | 建 Agent 绑齐上述、保存生效 |
| **M8** | 问答 / RAG 编排 | 编排:改写→意图→多路召回→重排→生成→引用→兜底；SSE 流式；会话/消息；C 端问答页(引用角标/可信度/反馈/转人工)；每阶段一个 span，产出完整 OTLP trace | M7,M5,M3,M6 | 问一句带引用回答；ClickHouse 出现完整 span 树；`message.trace_id` 写入 |
| **M9** | Trace 追踪(完整版) | 列表(采样/失败率/P95/筛选) + 详情(瀑布图/Span 树、命中分块及分数、引用溯源、token/cost、OTLP JSON 导出、重放、跳 Prompt 版本) | M8, M0.5 | 从一条回答一键跳其 trace 详情，信息齐全 |

### 里程碑 2（首期不做，数据模型预留不堵死）

| # | 模块 | 说明 |
|---|---|---|
| **M10** | 运行看板 | 问答量/Agent 分布/热门问题等聚合图表 |
| **M11** | 评测集 / 管理 / 报告 | 召回命中率、回答准确率、引用正确率、耗时 |
| **M12** | RBAC 权限 | 多角色/多团队，承接 M1 用户体系 |

## 各波交付方式

每一波 = 一次 `/ship:design`（产出该波的 `spec.md` + `plan.md`）→ `/ship:dev`（按 plan 落地 + 测试 + 提交）。**第一波 = M0 + M0.5**（地基 + 可观测最小闭环）。

## References

- 架构设计：`001-rag-platform-architecture`
- 原型：`CodeCrushBot 单文件版.html`
