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
| **M9** | Trace 追踪（完整版） | 🔄 | W1+W2（#21）/P1 修复（#22）/每节点面板（#23）/**W3a Session 详情（#25）**/路线图回写（#24）**均已合并 main**；**cost 真算按用户决策移出首期**（先算 token）——见附录 A | 015 |
| **M10** | 运行看板 | 🔄 | **W-a 后端 + W-b 前端已交付（PR #28 已合并）**：读模型汇总层 + D-metrics + `/metrics/*` + 看板前端（6 卡/趋势/质量信号/下钻）。4 前端测试待收尾（见 PR #28 描述）；cost 真算延后 | 016 |
| **M11** | 评测集 / 管理 / 报告 | 🔄 | 原列「里程碑 2 不做」，实际已按**评测飞轮 E-W 波次**推进：**E-W1 在线质量**（PR #31）+ **E-W2a 离线 run/评测集**（[PR #32](https://github.com/KaKmi/RAGForge/pull/32)，含运行时 QA 修复）+ **E-W2b-0 worker 拆进程**（[PR #35](https://github.com/KaKmi/RAGForge/pull/35)，019/018 缺口 19）已交付；**E-W2b**（重放/对比屏4/检索层指标）待做；~~E-W2c 思考 token 治理~~ **已由换模型解决、波次取消**（2026-07-17 实测）——见附录 A「评测飞轮（E-W）分波交付进度」 | 017 / 018 / 019 |
| **M12** | RBAC 权限 | ⬜ | 里程碑 2（首期不做） | — |

**当前下一步**：**E-W2b 功能波**（重放 / 版本对比屏4 / 检索层 gold-docs 指标）——范围见附录 A 的 E-W2b 行与 `018` §1「OUT（W2b 及以后）」。**注意**：2026-07-17 用户连插两个小波（`E-W2b-0` worker 拆进程 [PR #35](https://github.com/KaKmi/RAGForge/pull/35)、`E-W1 屏1 口径修复`），故 E-W2b 功能波**尚未开工**，仍从 main 开新分支。另有 **`游标语义收口`** 设计已过对抗但未实现（产物在 `.ship/`，**跨会话不可见**，范围与状态见附录 A 同名行）。

已收口：**M9 首期**（#21/#22/#23/#24/#25 全合；cost 真算按用户决策移出首期）· **M10 运行看板**（#28 合）· **M11 的 E-W1**（#31 合）**与 E-W2a**（#32 合）· **E-W2b-0 worker 拆进程**（#35）· **E-W1 屏1 口径修复**。

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

> 提示（给后续会话）：M9 **W1+W2（#21）+ P1（#22）+ 每节点面板（#23）+ W3a Session 详情（#25）+ 本回写（#24）全部已合并 main**。**M9 首期到此基本收口**——余下仅 cost 真算，已按用户决策移出首期（先算 token）。运行时 QA（真 ClickHouse trace）需起 docker + `pnpm start`/`dev`（dev 现也落 trace）；本地测试全绿但运行时验收待人工。

### 评测飞轮（E-W）分波交付进度

设计见 017（在线）/ 018（离线）。产品权威 `docs/design/assets/eval-flywheel-product-design.html`。

| 波 | 范围 | 状态 |
|---|---|---|
| **E-W1** | 在线答案质量评测：PG 控制面 + 周期抽样 + reference-free 三指标 Judge + `rag.eval` → ClickHouse 读模型 + `/eval/quality/*` + Trace 质量列 + `/admin/quality` 总览。全程 chat 零改动 | **已交付**（PR #31） |
| **E-W2a** | 离线评测：gold 题库 CRUD（软删/不可变版本/CSV 逐行回执）+ `eval-runs` 顶点模块 + run 引擎（发起/停止/预算熔断/租约 + 僵尸回收）+ 屏3 报告。**核心不变量：离线分数只落 Postgres，绝不发 `rag.eval` span**；指标 4/8 | **已交付**（[PR #32](https://github.com/KaKmi/RAGForge/pull/32)）；运行时 QA 抓 1×P1 + 1×P2 + 4×P3，**已修**（见下方「E-W2a QA 修复」） |
| **E-W2b-0 worker 拆进程** | **插入波（用户 2026-07-17 临时改向，优先于下方功能波）**：把 `eval-run` + `online-eval` 两个 pg-boss 消费者从 API 进程拆到独立 worker 部署物——同一份代码按 `PROCESS_ROLE=api\|worker\|all`（默认 all = 现行为）分流，租约/判分/编排**零改动**。设计见 [`019`](019-eval-worker-split.md)，收口 018 §12 缺口 19，触发 003:256/:322 的既有预埋 | **已交付**（[PR #35](https://github.com/KaKmi/RAGForge/pull/35)）。QA 真 infra 实测跨进程闭环：api 角色发起 run 入队 → **api 不消费**（job 停 `created` 25s）→ 起 worker → 30s 内取走、50s 跑完 2 用例出真分。QA 抓 1×P1（`dev:worker` 用 tsx → esbuild 不发装饰器元数据 → NestJS DI 崩；**仅本地 dev，生产走 dist 从未受影响**）**已修**（改 `nest start --watch` + 独立 outDir） |
| **E-W1 屏1 口径修复** | **插入波（用户 2026-07-17 截图提出）**：收口 018 §12 缺口 20 的 (a)(c)——屏1「已评测 0 / 可评测 32 · 待处理 1」三个数来自三套不同口径却被拼成一句话。(a) 分母改「窗口内」+ 新增 `evaluableCount`（窗口内 ∩ 游标之后），「已错过」由三者相减派生；(c) `countBacklog` 改用与 `listCandidates` 同源的严格元组游标（原含端 `>=` 把水位线自己那条数成待处理 ⇒ 静默超 `LAG_BUFFER` 即永久「评测滞后」），并删死字段 `lagSeconds`（前端从未渲染）。外加两条同屏收口：GET 不再调 `getOrCreateWatermark`（读路径播种游标 ⇒ 打开一次屏1 即钉死历史，019 拆分后尤易踩）；新增 `worker_stalled` 状态（019 后 worker 独立进程、无 HTTP、无健康探针、compose 无其服务 ⇒「只起了 api」是安静常态，而没流量时 `backlog=0` 会把它伪装成 healthy）。**(b) 未做**——其前提被实测证伪，改由「游标语义收口」波次处理 | **已交付**。**受控实测**（起 `PROCESS_ROLE=worker`、游标拨回一格只放行 1 条）：全链路通——worker→裁判→span→OTLP→ClickHouse→物化视图→读模型，评出 `faithfulness=100/relevancy=30/precision=0`，`ServiceName=codecrush-worker`（**019 D3+A3 实测生效**，读模型不按 ServiceName 过滤）。实测同时**证伪 018 缺口 20 的三处记述**（已回写 018）。测试：后端 913 绿、前端 207 绿、contracts 244 绿、lint 0、`test:db` **44 绿（真库，非静默跳过）**、`evaluations.clickhouse.spec` 14 绿（`RUN_CLICKHOUSE_TESTS=1`，含 2 条真库游标回归） |
| **游标语义收口** | **待做**：018 §12 缺口 20(b) 的**重新定义**（原诊断已证伪）+ 缺口 21（`processed_failed` 永久跳过）。四条同源：① 冷启动播种（`now−24h`，`017:26` 明文设计但不可见不可配 ⇒ 改 env 可配、**默认仍 24h**，用户 2026-07-17 裁定不动 017）；② 推进语义（8 种 outcome 里 6 种推进、4 种没分数——**用户裁定不翻转**，靠账本留证）；③「已看过但没评」账本（新 PG 表，与游标推进同事务；死结在于 `sampled_out` 不推进会让水位线卡在第一条没抽中的 trace 上 ⇒ worker 死锁，故不是「别推进」而是拆成两份记录）；④ 游标移动审计（**唯一论据是实测本身**：用完整代码+DB 访问仍解释不了游标为何停在 `c4669188`——它是高风险必抵裁判必发 span，而当时全库零 span） | **设计已过对抗**（spec + peer-spec + diff-report 在 `.ship/tasks/eval-cursor-semantics/`，**未提交**）。6 处分歧：3 证据判定 / 1 host 认输（漏查 `forceFlushTelemetry` 是 best-effort 吞导出失败）/ 2 用户裁定。**plan 未写**——用户决定先实测，而实测结果削弱了账本的紧迫性（flush 丢包理论被证伪：span 投递实测正常）。**接续时先读 diff-report** |
| **E-W2b** | 重放、版本对比屏4、检索层 gold-docs 指标（Recall/NDCG/命中率）、Citation、每题重复聚合、配置版本引用保护、`timeoutMs` 硬中断（需 plumb AbortSignal）、doc→chunk 级 gold 选择器 | **待做**。范围见 018 §1「OUT（W2b 及以后）」+ §12 缺口 3/9/13/14/15/18。**先做功能，018 的技术债缺口按用户指示后修**。<br/>⚠️ 状态订正（2026-07-17）：本行原写「进行中，从 main(`137cce2`) 开新分支」——**该波实际未开工**，用户当天改向先做上方 `E-W2b-0` worker 拆分（018 缺口 19）。功能波仍在原点 |
| **E-W2c 思考 token 治理** | **慢的真正根因，实测驱动、独立成波**（018 §12 缺口 17）：`qwen3.6-flash` 是 hybrid thinking 且**默认开**，全仓**零** thinking 控制（`enable_thinking`/`reasoning_effort`/`no_think` 全无命中），adapter 只发 `response_format`。实测 `rewrite` 均 **8.4s / 637 out-tok**、`intent` 均 **7.3s / 745 out-tok**（30 天全量、**线上真实用户**，非评测专属）⇒ **每次提问干等 ~15.7s**；单 trace 更达 rewrite 16.06s/1759 tok + intent 11.65s/1322 tok（应为 ~30 / ~5 tok）。叠加 ~20% 结构化调用因必填字段缺失而重试一次（供应商 `json_schema` **未真正强制 schema**）。收益：单用例 ~36s → ~10s，**线上问答快 3 倍以上** | **✅ 取消（2026-07-17 实测解决）**——用户把四节点从 `qwen3.6-flash` 换成 `deepseek-v4-flash`（管理学 v9 / 售后 v5）。**同 prompt、同 schema、同代码**实测：rewrite **16.06s/1759 tok → 3.3s/121 tok**、intent **11.65s/1322 tok → 2.6s/92 tok**（均 **~14.5×**），`rag.pipeline` **36–59s → 18.9–21.5s**，且**重试归零**（deepseek 的 92–121 tok 正是该 schema 应有的量，反证 qwen 多出的 1200–1600 tok 确为思考过程）。⇒ **根因是模型选型不是代码**：无需 thinking 开关、无需动 adapter、无需碰 chat 关键路径。若日后再用 hybrid thinking 模型跑这四个节点，本条重新生效 |

> 提示（给后续会话）：120s 超时**当初**只是安全网——真正的根因是思考 token。**该根因已于 2026-07-17 由「换用 deepseek-v4-flash」消除**（见上行实测），超时余量随之从 2× 变 **5.6×**（120s vs 21.5s）。**教训留档**：这类「慢」先查模型的 output token 数（一次改写吐 1759 token = 思考没关），再考虑改代码——本例中改代码是错的路。

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

- **2026-07-17**：**E-W1 屏1 口径修复交付（分支 `ship/quality-overview-caliber`）+ 018 §12 缺口 20 按实测订正**——用户截图提出屏1「已评测 0 / 可评测 32 · 待处理 1」不对劲。**三个数来自三个独立查询、三套口径**，被一个 `/` 和一个 `·` 拼成一句读者必然当作可比的话，而每一部分都错：32 是「窗口内非 preview trace 总数」（查询从没问过「还评得了吗」）；0 是「一条都没评过」；1 是**水位线自己**（`countBacklog` 复用 `countEligible` 的含端 `start_time >= lastTs`，而 `listCandidates` 用严格元组游标 ⇒ `finishCycle` 把水位线压在最后一条处理过的 trace 上后，那条被永远数成待处理 ⇒ 静默超 `LAG_BUFFER` 即 `backlog` 恒 ≥1 ⇒ `status` 恒 `lagging`）。**已修**：分母改「窗口内」+ 新增 `evaluableCount`、backlog 谓词与 `listCandidates` 同源、删死字段 `lagSeconds`（后端在算、契约在校验、**前端从未渲染**——缺口 20(c) 正是据它误判归因）。**外加两条调查中发现的**：① **GET 曾播种游标**——读路径 `getOverview` 调 `getOrCreateWatermark`（播种 `now−24h`）且不看 `enabled` ⇒ **评测关着时打开一次屏1 就把更早历史永久钉死**，改为只读 `findWatermark`；② 新增 `worker_stalled` 状态——019 拆分后 worker 无 HTTP、无健康探针、compose 无其服务，「只起了 api」是安静常态，而没流量时 `backlog=0` 会把它伪装成 `healthy`（**本机实测印证**：13:20 时 `last_run_at` 停在 03:15、同期 chat span 持续在进）。**受控实测**（起 `PROCESS_ROLE=worker`、游标拨回一格只放行 `c4669188`）：一轮即评出真分，`ServiceName=codecrush-worker`，物化视图收走、读模型可见 ⇒ **全链路通，019 D3+A3 实测生效**。**实测同时证伪 018 缺口 20 的三处记述并已回写**：(b)「被 10% 抽样刷掉」——**假**（31 条里 16 条高风险，`classifyRisk` 命中即完全豁免抽样，`processor.ts:138`）；排除论证 ③「`consecutive_failures=0` ⇒ 不是 worker 失败」——**推理无效**（`finishCycle` 覆盖该字段，且**空轮也走 finishCycle** ⇒ 错误历史被下一个空轮擦掉，只描述最后一轮）；(c) 的归因——**错**（`lagSeconds` 不渲染）。**新增缺口 21**（`processed_failed` 也推进游标 ⇒ 裁判暂态故障时前 5 条永久丢、第 6 条起才被熔断保住，同一病因两种命运；用户裁定不翻转、靠账本留证）**与缺口 22**（`FaithfulnessEvaluator` 空 claims → 100 分**从假设变实测**：`fallback + no_citations=1` 的兜底回答拿到 `faithfulness=100`，且走**在线**路径直接进屏1 的 avg）。**仍未解释**：游标为何停在 `c4669188`——它高风险必抵裁判必发 span，而当时全库零 span；**用完整代码+DB 访问查不出，因为游标移动零审计**——这是「游标语义收口」波次「审计」需求的唯一论据。后端 913 绿、前端 207 绿、contracts 244 绿、lint 0、`test:db` **44 绿（真库门控，非静默跳过）**、`evaluations.clickhouse.spec` 14 绿（含 2 条真库游标回归）。**未做**：那 31 条的历史回补（用户裁定不补，屏1 显示「已错过 31」即可）；缺口 20(b) 的账本（设计已过对抗、见附录 A「游标语义收口」行，**产物在 `.ship/` 跨会话不可见**）。
- **2026-07-17**：**E-W2b-0 评测 worker 拆独立部署物交付（[PR #35](https://github.com/KaKmi/RAGForge/pull/35)，分支 `ship/eval-worker-split`）**——设计 [`019`](019-eval-worker-split.md)，收口 018 §12 缺口 19，**用户临时插入、优先于 E-W2b 功能波**。`eval-run` + `online-eval` 两个 pg-boss 消费者从 API 进程拆出：同一份代码、同一构建产物，按 `PROCESS_ROLE=api|worker|all`（**默认 all = 现行为**，未设 env 的既有部署零变化，亦即回滚路径）分流。**租约/判分/run 状态机/编排一行未改**——019 论证并经 peer 独立复核：租约原语全是 DB 条件更新，单进程下经异步交错已有同形竞态，跨进程只改时序分布、**不引入新竞态类别**；「全局最多 1 个 run」的保证从「单进程内 pg-boss 串行」平移为「**worker 单副本内串行**」（`boss.work()` 不传并发参数 → 默认 `batchSize=1`），018 缺口 13 的「单实例部署前提」由 019 Boundary 5 改写为「worker 单副本」，语义等价。**门控落点**：设计原写「4 个 processor 各自守卫」，实现阶段改为 **QueueModule 的 token 工厂**包 `RoleGatedQueueAdapter`（019 D1 修订记录）——① 与 Boundary 1「processor 不得自带角色判断」自洽；② 咽喉点强制，新消费者拿不到未登记角色的 Queue 实例；③ **4 个 processor 与其 7 处既有测试构造点零改动**。`publish` 恒不设防（Boundary 3，worker 的 lease_busy 重投依赖它）。**QA 真 infra + 真 LLM 实测跨进程闭环**：api 角色 `POST /eval/runs` 入队成功 → 等 25s，pg-boss job 停在 `state=created`/`started_on=NULL`、run 停 `queued`（**api 确不消费**；同队列历史 job 为 `completed` 作对照）→ 起 worker → 30s 内 job 转 `active`、run 转 `running` 持租 → 50s 后 `done`/2 用例出真分（42s、37s，与 018 实测 20~46s 吻合）。**QA 抓 1×P1 已修**：`dev:worker` 原用 `tsx watch`，而 tsx 基于 esbuild **不支持 `emitDecoratorMetadata`** ⇒ 不发 `design:paramtypes` ⇒ NestJS DI 启动即 `UndefinedDependencyException`；差分证实与角色无关（裸 `tsx src/main.ts` 同崩）、**生产走 `node dist/main.js` 从未受影响**——改为 `nest start --watch --path tsconfig.worker.json`（零新依赖）+ 独立 `outDir: dist-worker`（因 `nest-cli.json` 的 `deleteOutDir: true` 会让两个共用 dist 的 watch **互删产物**），连带 `dist-worker/` 进 `.gitignore` 与 eslint ignores（后者不加会让 `pnpm lint` 从 0 变 **1273 错**）。后端 905 绿（+27：process-role/role-gated-adapter/queue-consumer-roles/config.schema）、前端 203 绿、lint 0。**已知不可测**：SIGTERM → `boss.stop()` 优雅停机在 Windows 无法验证（探针实证：Node on Windows 不投递 SIGTERM 给 handler，`kill -TERM` = 硬杀）——生产 Linux/Docker 不受影响，静态接线已过 peer review。**未做**：worker 多副本（须先收口 018 缺口 13 的活跃槽位原子守卫）、worker health 端点（019 A1）、compose/生产接线（019 D6，留上线波）、API 进程的优雅停机（既有债务，019 A2）。
- **2026-07-16**：**E-W2a 运行时 QA 修复（分支 `ship/eval-w2a`）**——4 次真实 run（2 个应用）暴露 **P1：30s 单用例超时让本功能一个分都出不来**（100% `verdict=timeout`；`rewrite`+`intent` 在生成开始前即吃掉 27.7s/30s，整条用例 36~46s）。**非逻辑 bug**——超时处理符合设计（记 NULL 不记 0），错在 30s 是从**在线熔断**继承的：它约束的是「人在等」，而离线批跑无人等待。已按用户决策改为 `EVAL_RUN_CASE_TIMEOUT_MS` env 配置（**离线默认 120s**，走 `config.schema.ts` → `AppConfigService` 既有模式；在线口径未动），**主动偏离原型 §6 并记入 018 缺口 16**。另修：**P2** 屏2 对「跑过 5 次 run 但没出分」的集合显示「未运行」= **断言假事实**（契约加 `hasCompletedRun` 消歧位，两态分词「未运行」/「未出分」，NULL 仍绝不退化成 0——同 018 缺口 2 在屏3 解决过、屏2 漏掉的同类问题）；**P3-1** 发起 Modal 硬编码「3~6 分钟」而原型那句是**对 50 条说的** → 按用例数线性缩放（50 条仍逐字复现原型，§19.2 的固定 toast 未动）；**P3-3** antd v6 `Drawer width` → `size`（全仓仅此两处）；**P3-4** 任何加载失败都渲染「评测报告不存在」，与真 404 无法区分（QA 实际误诊）→ 新增带状态码的 `ApiError`，仅 404 才说「不存在」，其余报加载失败 + 透出原始错误 + 重试。**未改**：faithfulness 逐条「支持/不支持」（E-W1 在线代码，改 evidence 即改解析契约 → 触发 017 的 `judgeVersion` 升版要求 → 在线分数断代，属产品决策，记 018 缺口 18）。后端 881 绿（+5）、contracts 244、前端 203 绿（隔离；全量并行 flake 为既有，**基线 04f9926 实测同样 6 红**）、lint 0、build 5/5。**根因另案**：`rewrite`/`intent` 被思考 token 拖垮（018 缺口 17 / 002 附录 A「E-W2c」）——**超时调大只是安全网，不是解药**。
- **2026-07-16**：**E-W2a 离线评测 run 与评测集交付（[PR #32](https://github.com/KaKmi/RAGForge/pull/32)）**——设计见 018，8 story / 6 波全绿。范围：gold 题库 CRUD（软删 + 不可变版本 + CSV 前端解析逐行回执）→ 新增 `eval-runs` 顶点模块（依赖 chat 编排 + evaluations 判分 + applications 版本解析，图无环）→ run 引擎（发起/停止/预算熔断/全局串行租约 + 续租心跳 + 僵尸回收）→ 屏3 报告（antd）。**核心不变量：离线分数只落 Postgres，绝不发 `rag.eval` span**（`codecrush_eval_targets_mv` 只按 `SpanName` 过滤、不看 preview → 发了即污染屏1；有 infra-gated 污染回归测试守，且反证「标 preview 救不了你」，推翻原型 §15 E2）。指标 **4/8**（Faithfulness/AnswerRelevancy/ContextPrecision 复用 + 新增 Correctness）；检索层 Recall/NDCG/命中率 + Citation 显式空态「—/未标 gold docs」，延 **W2b**。编排为**加性重构**（抽 `runWithConfig`、加 `runForEvaluation`，线上问答行为逐字节不变，既有 chat/evaluations 测试一个未改全绿）；`EvaluationJudgeService.score()` 一行未动、在线 `judgeVersion` 仍 `online-v1`、`003-eval-views.sql` 未改（E-W1 基线零回归）。完整对抗档：per-story peer review（fallback fresh-Agent，独立性弱于跨 provider 但均执行复现），累计抓 3 个 P1（correctness 空响应写 0 分、run 异常路径回收器失效致功能死锁、回收漏清 lease_owner）+ 多个 P2/P3 并全修，含新增真库租约测试（因租约语义活在 SQL 三值逻辑上、fake 复刻不出）。后端 875 测试绿（+9 DB 门控 +4 infra 门控）、前端 195 绿（隔离跑；全量并行是既有 JSDOM flake，与本波无关）、lint 0、build 5/5。**W2b 待做**（见 018 §12 已知取舍：重放、版本对比屏4、检索层 gold-docs 指标、Citation、每题重复聚合、配置版本引用保护、`timeoutMs` 硬中断需 plumb AbortSignal、faithfulness 空 claims→100 的离线口径裁决、failed run 屏2/屏3 得分口径裁决）。
- **2026-07-16**：**E-W1 在线答案质量评测闭环交付（PR #31）**——契约/OTel 语义 → PG 控制面+周期调度 → 原文输入+三指标 reference-free Judge → worker 分层抽样+`rag.eval` → ClickHouse 去重读模型+`/eval/quality/*` → Trace 质量列/筛选/只读面板 → `/admin/quality` 总览，全程 chat 零改动，基线见 017。落地 QA 修三缺陷：`getLowSamples` 列名限定叠 USING 致 `targetTraceId` 恒 undefined 崩总览（列显式别名）、`getByAgent` 空 `agent_id` 幽灵行违 min(1) 契约（过滤空值）、chat 根 span 写原始 agentId 致分应用聚合按 slug/UUID 碎片化（改写规范 `cfg.applicationId`，行为中性、历史不回填）。答案质量页重构为 antd + 共享 echarts `MetricChart`。后端 792 测试绿、lint 0、build 绿。**applicationId 全统一（API 字段/旧 `agents` 表/历史回填）留作独立决策；下一步 E-W2（评测集/报告/重放）。**
- **2026-07-15**：冻结 E-W1 在线答案质量评测实施基线（017）。交付顺序为共享契约与语义 → PG 控制面/周期调度 → 原文输入与三指标 Judge → worker/抽样/`rag.eval` → ClickHouse/API → Trace 联动 → 质量总览与设置；每一阶段保持 chat 零改动、可独立验证与回滚。

- **2026-07-14**：**016 W-b 前端看板已实现（PR #28，已合并）**——DashboardPage 接 `/metrics/overview|apps`（6 指标卡/双线趋势/质量信号/应用分布/坏样本下钻/阈值染色，删 M2 mock），TracesPage URL 水合支持看板深链下钻预选筛选；后端单应用响应补六阶段 P50/P95/样本数（现算 `codecrush_trace_spans`）+ 检索降级信号埋点。lint 绿、后端/契约测试绿；**4 前端测试待收尾**（CSV/Session 文案、单应用 TTFT 范围、SessionDetail 引用气泡疑似回归），owner 本波判为次要、随 PR 带出。cost 真算仍延后。
- **2026-07-14**：**016 指标读模型 W-a 后端已交付**——`otel_traces` 上新增 `AggregatingMergeTree` 汇总层（物化视图只读根 chain span）+ **D-metrics 写侧**（trace 级 token 总和 + 生成模型标签落根 span）+ 守卫历史回填 + `/metrics/*` 只读 API。D2′ 使用单 `dur_tdigest` state 并由仓库直接 `xxxMerge`，不建 finalize VIEW。运行时 QA 修复 series 别名与旧数据回填，随后 review 补齐 trace 详情防重复计数及失败/中断 usage 汇总。**前端看板仍待 `metrics-dashboard-frontend` plan；cost 真算继续独立延后**。
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
