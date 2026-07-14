---
title: "RAG 平台实现路线图（模块级）"
description: "按依赖排序的模块级实现路线图：地基→可观测→用户/骨架→可配置域→问答/追踪，逐波用 /ship:design 拆细 spec。"
category: "design"
number: "002"
status: draft
services: [backend, frontend, observability, deploy]
related: ["design/001", "design/004", "design/005", "design/006", "design/007", "design/008", "design/009", "design/010", "design/011", "design/012", "design/013", "design/014"]
last_modified: "2026-07-13"
---

# 002 — RAG 平台实现路线图（模块级）

## Status

`draft` — 大块模块级路线图，承接 `001-rag-platform-architecture` 的架构决策，用于统筹执行顺序。**每一波再用 `/ship:design` 拆成可执行 spec + plan**，细粒度产物记入各自 `.ship/tasks/<task>/`。

**进度维护约定**：本文的「交付状态总览」是里程碑进度的**唯一权威视图**——每波 handoff 收口时必须回写对应行（哪波已交付 + PR / 哪波待做），详见 `CLAUDE.md`。历史决策变更记录在文末「变更记录」。

## Summary

把 001 的架构拆成 M0–M12 主里程碑，并在真实需求出现后插入 M4.1 文档处理与 M8.0 NodeContract 两个兼容增强，**严格按依赖先行排序**。核心策略：**M2 先把所有页面骨架（含首页、应用配置）1:1 布局搭出（空态/mock），让全貌可见可点；M3+ 再按依赖顺序往骨架里填真实逻辑**。最没底的 OTLP→ClickHouse 链路在 M0.5 第一个验证掉。

## 交付状态总览

> ✅ 已交付　🔄 进行中（分波，见备注）　⬜ 未开始　图标 = 主状态；「下一步」看第一个非 ✅ 行。

| # | 模块 | 状态 | 备注 / 分波进度 | 设计文档 |
|---|---|---|---|---|
| **M0** | 工程地基 | ✅ | | 001 / 003 |
| **M0.5** | 可观测最小闭环 | ✅ | | 004 |
| **M1** | 用户 / 认证 | ✅ | | 005 |
| **M2** | 前后端页面骨架 | ✅ | 15 屏骨架 | 006 |
| **M3** | 模型接入 | ✅ | | — |
| **M6** | Prompt 管理 | ✅ | | 012 |
| **M4** | 知识库 / 文档 / 切片 / 入库 | ✅ | | 007 |
| **M4.1** | 文档处理 Profile | 🔄 | Rollout 1–4 已落地；**Docling / OCR / 结构块 = M4.1b 待做** | 010 |
| **M5** | 检索 | ✅ | | 008 |
| **M7a** | 应用配置基础 | ✅ | | 009 |
| **M8.0** | Prompt 组装 / NodeContract | ✅ | | 011 |
| **M7b** | 应用发布闭环 | ✅ | | 009 |
| **M8** | 问答 / RAG 编排 | ✅ | 四波全交付：**T1**（PR #16）/ **T2**（PR #18）/ **T3**（PR #19）/ **T4**（PR #20，C 端问答页真实化 + markdown）——见附录 A | 013 / 014 |
| **M9** | Trace 追踪（完整版） | 🔄 | W1+W2（#21）/P1 修复（#22）/每节点面板（#23）已合并；**W3a Session 详情**（#25）+ 路线图回写（#24）待合；**cost 真算按用户决策移出首期**（先算 token）——见附录 A | 015 |
| **M10** | 运行看板 | ⬜ | 里程碑 2；**读模型地基 + 看板已设计（016），后端/前端 plan 已拟（`.ship` 本地）、未实现** | 016 |
| **M11** | 评测集 / 管理 / 报告 | ⬜ | 里程碑 2（首期不做） | — |
| **M12** | RBAC 权限 | ⬜ | 里程碑 2（首期不做） | — |

**当前下一步**：**M9 首期基本收口**——W1+W2（#21）/P1（#22）/每节点面板（#23）已合并，W3a Session 详情（#25）+ 路线图回写（#24）待合。cost 真算（W3b）按用户决策移出首期（先算 token，需从零建定价体系，延后单独拆）。M9 之后即进里程碑 2（M10 运行看板等，首期不做）。

## Boundaries

> 反漂移边界 + 排序不变量。改顺序/范围先改本文。

**In-scope（首期 M0–M9）**：工程地基、可观测最小闭环、用户/认证、前后端骨架、模型接入、Prompt 管理、知识库/切片/入库、检索、应用配置与发布、问答/RAG 编排、Trace 追踪完整版。

**Out-of-scope（里程碑 2，M10–M12，schema 不堵死）**：运行看板聚合、评测集/管理/报告、RBAC 权限。

**排序不变量（不可违反）**
1. **M0 → M0.5 最先**：无地基与埋点，其余模块无处依附；OTLP/ClickHouse 风险最高，必须第一个端到端验证。
2. **依赖先行**：M4 在 M3 后（需 embedding 模型）；M5 在 M4 后（需向量/切片）；M7a 在 M3/M4/M5/M6 后先落应用身份与不可变配置；M8.0 在 M3/M6 后落 NodeRuntime；M7b 汇聚 M7a/M8.0 实现 ReleaseCheck 与 production；M8 在 M7b 后，M9 在 M8 后。
3. **骨架与逻辑分离**：页面 1:1 布局在 M2 一次性出壳；真实逻辑在 M3+ 按依赖填入。应用页在 M7a 具备保存/历史/测试骨架，在 M7b 才具备真实上线闭环。
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
        M7a 应用配置基础  (不可变版本，暂不上线)
               │                 M8.0 NodeContract / Prompt 组装
               └──────────────────┬───────────────────┘
                                  ▼
        M7b 应用 ReleaseCheck / production 发布闭环
               │
               ▼
        M8 问答 / RAG 编排  (只消费 typed output，产出完整 OTLP trace) ◄── M0.5 埋点地基
               │
               ▼
        M9 Trace 追踪(完整版)
──────────────────── 里程碑 2(首期不做, schema 预留) ────────────────────
        M10 运行看板    ·    M11 评测集/管理/报告    ·    M12 RBAC 权限
```

## 模块清单（按执行顺序 · 验收标准）

> 状态见上方「交付状态总览」；本节只列每个里程碑的范围与可证伪验收。分波进度与需求记录见附录 A。

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
| **M4** | 知识库/文档/切片/入库 | KB CRUD(名称查重、分块模板 通用/问答/定制、绑 M3 embedding 创建后锁定)、文档上传(BlobStore 本地卷、单文件/文件夹批量、自动/手动解析)、四阶段管线(解析→清洗→分块→向量化，pg-boss 异步)、切片版本化蓝绿重建、切片查看/搜索/批量删除、文档元数据(jsonb)、生命周期状态——设计见 007 | M3 | 传 PDF 走到"就绪"；切片可见可删（2026-07-08：由开关制改为删除制）；改分块模板全库重建且重建期检索不空窗；失败可重试 |
| **M4.1** | 文档处理 Profile | 知识库默认 Profile + 文档覆盖；版本化 Profile Snapshot；Canonical Document(Markdown+Blocks+Assets)；处理 Run 历史；快速/版面/OCR PDF；表格、图片和页码溯源；前端 Profile 选择——设计见 010 | M4 | 现有 general/qa/custom 无损迁移；排队任务配置不漂移；扫描 PDF 可 OCR；重解析失败旧切片仍可检索 |
| **M5** | 检索 | `RetrieverPort`:向量召回 + 关键词召回 + 融合 + 重排；检索测试台(与 chat 共用) | M4, M3 | 测试台输入问题出命中分块 + 三种分数 |

> M3 与 M6 独立、可并行；M4 在 M3 后；M5 在 M4 后。M4.1 是 M4 的兼容增强，不反向阻塞已落地 M5；其 Chunk 仍遵守 `version = kb.activeVersion` 的既有检索契约。

### 波次 D — 汇聚 & 可追踪

| # | 模块 | 大块内容 | 依赖 | 验收 |
|---|---|---|---|---|
| **M7a** | 应用配置基础 | application CRUD；不可变配置版本；版本级知识库/四节点模型/4 个 Prompt/检索参数快照；版本历史、载入编辑与未上线版本对话测试骨架；从旧 agents schema 开始迁移——设计见 009 | M3,M4,M5,M6 | 新建 v1 默认未上线；保存只追加版本；Prompt 标签变化不影响应用 |
| **M8.0** | Prompt 组装 / NodeContract | 独立 `node-runtime`；四节点版本化 Contract；Prompt 三层组装；字段编译；Structured Output；Prompt 试运行；真实样例预演接口；运行时校验、修复一次与 Fallback——设计见 011 | M3,M6 | 无字段模板仍可运行；非法 JSON/越权 routeId 不进入编排；预览/预演/chat 共用执行器 |
| **M7b** | 应用发布闭环 | 单一 production 指针；异步真实 NodeRuntime ReleaseCheck；fingerprint/过期；问题跳 Prompt 试运行；passed check + CAS 上线/回滚；停用/恢复与删除——设计见 009 | M7a,M8.0 | 检查失败不改变线上；并发发布冲突可见；停用优先于 production |
| **M8** | 问答 / RAG 编排 | 编排:改写→意图→多路召回→重排→生成→引用→兜底；所有 LLM 节点只消费 NodeRuntime typed output；SSE 流式；会话/消息；C 端问答页；每阶段一个 span，产出完整 OTLP trace——设计见 013/014，分波见附录 A | M7b,M8.0,M5,M3,M6 | 问一句带引用回答；非法节点输出可观测并降级；ClickHouse 出现完整 span 树；`message.trace_id` 写入 |
| **M9** | Trace 追踪(完整版) | 列表(采样/失败率/P95/筛选) + 详情(瀑布图/Span 树、命中分块及分数、引用溯源、token/cost、OTLP JSON 导出、重放、跳 Prompt 版本) | M8, M0.5 | 从一条回答一键跳其 trace 详情，信息齐全 |

### 里程碑 2（首期不做，数据模型预留不堵死）

| # | 模块 | 说明 |
|---|---|---|
| **M10** | 运行看板 | 问答量/应用分布/热门问题等聚合图表 |
| **M11** | 评测集 / 管理 / 报告 | 召回命中率、回答准确率、引用正确率、耗时 |
| **M12** | RBAC 权限 | 多角色/多团队，承接 M1 用户体系 |

## 各波交付方式

每一波 = 一次 `/ship:design`（产出该波的 `spec.md` + `plan.md`）→ `/ship:dev`（按 plan 落地 + 测试 + 提交）→ handoff（回写本文「交付状态总览」）。**第一波 = M0 + M0.5**（地基 + 可观测最小闭环）。

---

## 附录 A — 里程碑需求记录

主清单只列范围与验收；以下是范围较大、分波或有暂停点的里程碑的详细记录。

### M8 分波交付进度

M8 按 013 拆四波（T2/T3/T4 = 013「非目标」节列出的三块），逐波 design→dev 闭环，非一次做完：

| 波 | 范围 | 状态 |
|---|---|---|
| **T1** | 后端编排内核 `OrchestrationService`（改写→意图→检索→生成/兜底，非流式返回完整结果）+ 会话/消息 greenfield 持久化 + production(slug/id) 解析 + chain 根 span + 意图路由（014：大分类 enum + KB 外挂 `intent_key` 绑定）+ 前端 KB 意图 Select | **已交付**（PR #16，2026-07-13 合并） |
| **T2** | SSE 逐 token 真流式：`run()` 改 `AsyncGenerator<ChatStreamEvent>`，reply 逐 token flush；流式 span 生命周期（013 §4 P1-①，需跨 yield 存活） | **已交付**（PR #18，2026-07-13） |
| **T3** | trace 写侧富化：检索 span 三拆（embedding/rerank）、LLM `gen_ai.usage.*`（token；cost 延后 M9）、命中分表 `rag.chunk.scores`、质量信号四布尔 `rag.quality.*`、落库 PII 脱敏 `RedactingSpanExporter`（跨模块，013 §11 登记） | **已交付**（PR #19，2026-07-13） |
| **T4** | C 端问答页（`/chat/:agentId` 真实接 `/api/chat`）：三栏、行内角标 ⇄ 右栏原文、可信度/引用完整度、兜底卡、复制/反馈、未上线占位、markdown 渲染（先 1:1 读原型再还原） | **已交付**（PR #20，2026-07-13） |

> 提示（给后续会话）：M8 **四波全交付（T1/T2/T3/T4）**——编排内核 + SSE 流式 + trace 写侧富化 + C 端问答页。**M8 已完结**，下一大里程碑为 **M9（Trace 追踪完整版）**。

### M9 分波交付进度

M9 按 015 拆三波（见 015「建议分波」），逐波闭环：

| 波 | 范围 | 状态 |
|---|---|---|
| **W1** | 读模型地基：根 span 身份富化（session.id/agent.id/name/enduser.id/fallback.used）+ `codecrush_traces`/`codecrush_sessions` VIEW + `GET /traces`(list+summary)/`GET /traces/sessions` + 前端 Trace/Session 双列表接真 | **已交付**（分支 m9-trace-read-model-w1；完整对抗：peer 调查+diff+drill+每波 review） |
| **W2** | 详情下钻：`GET /traces/:traceId` 补 meta 聚合 + `StatusMessage` 投影 + span 规范化；写侧 D1（chunk.scores 加 doc/section）+ D2（根 span 落 `rag.citation.ids`）；前端 TraceDetailPage 脱 mock（时间轴/树双视图 + 数据驱动 span 面板 + 命中分表/引用/脱敏 IO + 失败自动定位 + 复制 OTLP JSON，前端构建不建 /otlp 端点）；e2e `traces.e2e.spec.ts` | **已交付**（PR #21；peer diff 6 conceded + drill 9/9 + dev-peer PASS_WITH_CONCERNS 2 fidelity 已修） |
| **P1 修复** | 运行时 QA 抓到：HttpInstrumentation 给每请求加 POST server 根 span → `ParentSpanId='' AND kind=chain` 认根失效、读模型对真实 trace 全空。修复=改按 `kind='chain'` 认根（VIEW + repo + 前端 rootSpanOf），详情瀑布 scope 到 chain 子树排除 HTTP/PG span | **已交付**（PR #22） |
| **每节点面板增量** | 让点每节点都「有料」：批 A 铺料（buildSpanMeta 按 kind 铺 LLM/检索/向量/重排参数）+ 原型没有的排查视角——#1 NodeContract 校验链、#3 耗时占比、#4 降级/异常置顶、#2 意图→KB 路由（落 intent 节点 span，executeStructured 加 `spanEnrich` 钩子 + `rag.intent`/`rag.route.kb_names`）；附带 dev 落 trace（OTel 引导移 main.ts 首条 import，prod/dev 统一）。非 015 硬范围的加分增强 | **已交付**（PR #23；直接写码不走 spec，用户手动 QA） |
| **W3a** | Session 详情：1:1 还原 C 端聊天窗口（用户/bot 气泡回放）+ 每 bot 气泡挂 Trace 溯源条下钻该轮详情。`GET /traces/sessions/:sessionId` 复用现成 `codecrush_traces` VIEW（零 schema/VIEW 改动），`SessionDetailResponse` 契约 + 前端 `SessionDetailPage` | **已交付**（PR #25；直接写码不走 spec，用户手动 QA） |
| **W3b cost 真算** | ~~模型 params 带单价 → generation span 落 `rag.cost.usd`，VIEW 聚合~~ | **移出 M9 首期**（用户决策 2026-07-14：非"接数据源"而是从零建定价体系——模型加单价字段 + 配置 UI + 算 cost + VIEW；先只算 token，cost 恒 `—`，延后再单独拆） |

> 提示（给后续会话）：M9 **W1+W2（#21）+ P1（#22）+ 每节点面板（#23）已合并 main；W3a Session 详情（#25）+ 本回写（#24）待合**。**M9 首期到此基本收口**——余下仅 cost 真算，已按用户决策移出首期（先算 token）。运行时 QA（真 ClickHouse trace）需起 docker + `pnpm start`/`dev`（dev 现也落 trace）；本地测试全绿但运行时验收待人工。

### M4.1 需求记录与暂停点

**状态：第一波（Rollout 1–4）已落地，Docling/OCR 待 M4.1b。** 2026-07-10 经 `/ship:design`+`/ship:dev` 实现：Profile 注册表、`document_processing_runs` + 冻结快照、Canonical Document（Markdown + paragraph blocks + 页码溯源）、三段质量门、Run 编排（含 retry/僵尸兜底/409）、双队列迁移窗口 + 特性开关、蓝绿重建 scope、REST 端点、前端 Profile 选择（创建/编辑/上传覆盖/处理历史/重解析）；现有 `general/qa/custom` golden 无损迁移。首期 auto 仅快速解析（`pdf-parse` 逐页）。**版面解析（Docling）、OCR、表格/图片结构块、资源归档（Rollout 5–6）留 M4.1b**；真实文档验收与真 pg-boss/迁移回放留 QA 波。详见 010 Status。

需求范围：

1. 前端以“文档处理方案（Profile）”作为主要选择，不直接让用户组合解析器、清洗器和分块器。
2. Profile 版本化组合 `Parse + Clean + Chunk`，复用现有 `general / qa / custom`，其中 `custom` 的展示名称改为“课程/公众号文章”。
3. 知识库保存默认 Profile，上传批次和单文档重新解析可以覆盖；特殊业务 Profile 必须显式选择，首期不由 LLM 自动猜测。
4. 每次执行创建不可变 `document_processing_run` 与 Profile Snapshot，队列只传 `processingRunId`，确保排队期间配置不漂移。
5. 所有文件统一产出 Canonical Document：Markdown 用于展示和分块，Blocks/Assets 保留表格、图片、内容类型和页码溯源。
6. PDF 保留快速解析路径，并按 Profile 支持 Docling 版面解析与 OCR；重型处理继续异步执行且受文件、页数、产物、超时和资源上限约束。
7. 重新解析失败不得替换旧活动切片；显式应用新 Profile 到已有文档时复用 M4 蓝绿重建。
8. 前端补充知识库默认 Profile、上传覆盖、重新解析选择和处理详情；后端记录实际解析器、版本、耗时、统计、警告与错误。

恢复实施前的最小验收语料：普通单栏 PDF、带表格/多栏 PDF、扫描 PDF、FAQ、课程/公众号文章各至少 3 份；必须比较 Canonical Markdown、表格结构、页码、Chunk 和总耗时，不能只以“任务到 ready”作为通过标准。

### M8.0 需求记录

**状态：已交付。** 正式设计见 011；`docs/design/proposals/m8-node-contract-design.md` 作为产品/技术输入保留，但其“运行当前 Contract”版本策略不再作为权威结论。

1. 管理员只编辑节点策略 Instructions；平台固定职责、输入/输出 Schema、保留数据、动态校验和 Fallback。
2. `query/history/availableRoutes` 等 Runtime Data 始终由平台注入；管理员无占位符时仍可运行。
3. 合法字段可重复引用；未知/语法错误/保留字段冲突不阻止保存新的不可变版本，但必须阻断应用 ReleaseCheck。
4. PromptVersion 固定 ContractVersion，ApplicationConfigVersion 固定 PromptVersion；旧 Contract 只要仍被任一应用版本引用就不能删除。
5. Prompt 预览、应用 production 预演和 C 端调用共用 NodeRuntime，不允许各自拼接 Prompt。
6. rewrite/intent 走严格结构化输出和动态值域校验；reply/fallback 至少保证非空，并具有代码级最终 Fallback。
7. 结构失败最多修复一次；仍失败降级，非法原始输出不得流入检索、路由或最终回答。
8. Trace 记录 PromptVersion、ContractVersion、校验错误、结构化输出模式、修复次数和 Fallback。

---

## 变更记录

- **2026-07-14**：**016 指标读模型设计**（喂 M10 运行看板）——在 `otel_traces` 上加 `AggregatingMergeTree` 汇总层（物化视图增量卷积、只读根 chain span）+ **D-metrics 写侧**（trace 级 token 总和 + 生成模型 id 落根 span）+ `/metrics/*` 只读 API + 管理台运行看板前端（接 `/metrics`、三层下钻、阈值染色、坏样本预览）。两 plan 已拟（`.ship` 本地）：后端 `metrics-rollup-dashboard`（完整对抗：peer 调查+diff+drill）/ 前端 `metrics-dashboard-frontend`（轻量对抗：peer 调查+diff）。**cost 真算仍移出首期**（无定价源，`RAG.COST_USD` 尚为 dead constant，汇总表留 `cost_usd` 恒 0）。**尚未实现**——分支 `feat/m10-metrics-rollup`，交由 Codex 实现。
- **2026-07-13**：M9 设计（015）+ W1/W2 交付（分支 m9-trace-read-model-w1，未合并）。M9 拆三波：W1 读模型地基（根 span 身份 delta + traces/sessions VIEW + list/summary/sessions API + 前端双列表）、W2 详情下钻（detail meta + StatusMessage + 写侧 chunk.scores doc/citation.ids + 前端 TraceDetailPage 真数据 + e2e）。决策：读模型单一事实源=ClickHouse（决策 A，不 join Postgres，doc 名/引用走写侧富化）；OTLP JSON 前端构建不建端点（收敛 015 决策 C）；cost/Session 详情延后 W3；评测集/重放/Badcase 出口延后 M11。完整对抗档全程（peer 调查+diff+drill+per-story review）。运行时 QA 待人工起 docker。**下一步 W3**。
- **2026-07-13**：M8 T4（C 端问答页真实化）交付（PR #20）——`/chat/:agentId` 真接 `POST /chat` SSE 逐 token、单 Agent 信息卡（删 M2 切换器）、行内 `[n]` 角标 ⇄ 右栏真实原文（`ChatCitation.text`）、可信度/引用完整度/兜底来自 `done`、未上线占位（`resolvePublic` 404）、markdown 渲染（`react-markdown` + 自定义 `[n]` 角标插件）。后端最小改动：citation 带 `text`、`done` 带 `convId`、会话读接口 `agentId`+`userId` 归属过滤（IDOR）。完整对抗档：peer 独立调查 + diff（4 分歧证据消解）+ execution drill + 每波 peer review。真实 infra+LLM 浏览器 QA 验证逐 token/角标联动/可信度/未上线占位/markdown。QA 反馈修正：撑满视口高、可信度仅真引用时展示、移除转人工。**M8 四波（T1–T4）全交付、M8 完结，下一步 M9。**
- **2026-07-13**：M8 T3（trace 写侧富化）交付（PR #19）——检索 span 三拆（`retrieval.embedding`/`retrieval.rerank` 子 span 自动挂父，rerank 失败标 ERROR 不破降级）、LLM `gen_ai.usage.*`（三协议 builder 取数 + node-runtime 累计，reply 流式末帧 usage）、命中分表 `rag.chunk.scores`、质量信号四布尔 `rag.quality.*` + 通用 `codecrush.io.input/output`、`@codecrush/otel` 导出前 `RedactingSpanExporter` PII 脱敏（Luhn 防误伤 + `codecrush.redacted`）。完整对抗档：每 story peer review + T5 信任边界单独审。真实 infra+LLM QA（deepseek/qwen3-rerank/text-embedding-v4 + 39 文档 KB）验证 5 项写侧数据全部 ClickHouse 落库、PII 0 泄漏、端到端产出带引用回答。下一步 T4。
- **2026-07-13**：M8 T2（SSE 逐 token 真流式）交付（PR #18）——`run()` 改 AsyncGenerator 逐 token、`streamTextChunks` + 首 token 熔断、`@codecrush/otel` 手动 span 原语跨 yield、controller 逐帧 flush + 断连级联取消。真实 infra+LLM QA 验证逐 token/完整 span 树/`message.trace_id` 对齐。下一步 T3。
- **2026-07-13**：M8 T1（编排内核 + 持久化 + production 解析 + 意图路由）交付合并（PR #16）；新增「交付状态总览」与「变更记录」，需求记录归并附录 A；约定每波 handoff 回写本文进度（`.ship/` 仍本地忽略，跨会话进度以本文为准）。
- **2026-07-12**：M8 意图路由重设计（014）——意图节点只输出大分类 enum，路由靠 KB 外挂 `intent_key` 绑定，取代 013 的 KB-UUID 路由。
- **2026-07-11**：M7 产品语义改为“应用管理”：移除配置版本发布状态机和 Eval stub，新增不可变版本、单一 production 指针、异步真实 ReleaseCheck、停用/恢复与删除，详见 009。旧 M7 已实现代码作为迁移输入重做。
- **2026-07-10**：在 M8 前新增 M8.0 NodeContract 地基：PromptVersion 固定 ContractVersion，预览/Agent 激活/C 端共用 NodeRuntime，非法模型输出不得进入编排，详见 011。
- **2026-07-10**：在已落地 M4 基础上新增 M4.1 文档处理 Profile，不阻塞既有 M5；先复用现有解析/分块行为完成兼容迁移，再接版面解析与 OCR，详见 010。

## References

- 架构设计：`001-rag-platform-architecture`
- 原型：`CodeCrushBot 单文件版.html`
