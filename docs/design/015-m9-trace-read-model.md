---
title: "M9 Trace 追踪（完整版）读模型"
description: "M9 落地：根 span 补 session/agent/user 身份 → 纯 VIEW 读模型（列表/Session/详情）+ 只读 API + 前端四屏；out-flow 延后 M11。"
category: "design"
number: "015"
status: draft
services: [backend, frontend, observability]
related: ["design/002", "design/004", "design/013", "design/011", "design/012"]
last_modified: "2026-07-13"
---

# 015 — M9 Trace 追踪（完整版）读模型

## Status

`draft` — M9 里程碑设计。**承接 `004-trace-observability`（轻量 Trace 可观测）的完整落地**：004 定的架构边界（Session→Trace→Span 三层、OTLP「结束即写」、读侧只经自有 VIEW 防腐、大 payload offload、首期 VIEW-only 不落物化表）**全部不变**；本文只补 004 未细化的 M9 读侧形态。产品需求见 `docs/prd/b-trace.pdf`；UI 以原型 `RAG知识库问答系统设计/CodeCrushBot.dc.html` 的 Trace 四屏为 1:1 还原基准。落地对照代码后升 `current`。

**对抗强度：完整对抗**（架构性任务——新读模型 + ClickHouse VIEW schema 决策 + 跨写侧 delta；按 `CLAUDE.md` 分级）。

## Summary

M9 把 004 的读模型从「只有 `findByTraceId` 返回裸 span」补成完整的**列表 + Session + 详情**观测面。核心决策一句话：**给编排 chain 根 span 绑上身份属性（`session.id`、`gen_ai.agent.id/name`、`enduser.id`、`rag.fallback.used`），使 Trace 列表 / Session 视图 / 详情全部能纯 VIEW over `otel_traces` 投影出来，读侧零跨库 join**——这正是 004 Invariant 2（「会话视图 = 查 `WHERE session_id=X`」）预设、而 M8 写侧尚未补齐的部分。节点级富数据（`gen_ai.usage.*` / `rag.chunk.scores` / `rag.quality.*` / 脱敏 IO）M8 T3 已落，M9 不重造，只做读侧聚合与展示。**排查闭环出口（加入评测集 / 重放 / Badcase 池）延后 M11**（目标模块未建）；M9 交付「发现 → 下钻 → 归因」的观测读闭环 + OTLP JSON 导出 + 跳转 Prompt 版本。

## 现状与缺口（核对代码）

| 面 | 现状 | M9 缺口 |
|---|---|---|
| 写侧节点数据 | ✅ M8 T1–T3：每 span 带 `codecrush.span.kind`、`gen_ai.usage.*`、`rag.chunk.scores`、`rag.quality.*`(四布尔)、`rag.prompt.version_id`、`codecrush.io.input/output`，落库前 `RedactingSpanExporter` 脱敏 | — |
| 写侧根 span 身份 | ❌ `rag.pipeline` 根 span 只有 kind/prompt 版本/preview/io/质量信号/status，**无 session.id、无 agent 标识、无 user、无兜底标记** | **补身份 delta（W1）** |
| 读侧 VIEW | 仅 `codecrush_trace_spans`（flatten 单表，`infra/clickhouse/views/001-trace-views.sql`） | **加 traces / sessions 聚合 VIEW** |
| 读侧 API | 仅 `POST /traces/hello`、`GET /traces/:traceId`（裸 spans[]） | **list / summary / sessions / session 详情 / 详情 meta / OTLP 导出** |
| 前端 | `TracesPage`/`TraceDetailPage` 全跑 `mocks/traces.ts` | **接真 + Session 双视图 + 两级详情** |

Postgres `messages`(trace_id, convId, content, isFallback, citations) + `conversations`(agentId, userId) 亦有会话结构，但**按决策 A 不作为读源**（见取舍），仅保留 `message.trace_id` 作「从回答一键跳 trace」的跳入索引。

## 决策 A：读模型 = 纯 ClickHouse VIEW（写侧补身份）

Trace 列表、Session 列表、Session 详情、Trace 详情**全部**从 `otel_traces` 经自有 VIEW 投影，不 join Postgres。代价是回头给「已交付」的 M8 写侧补一小段根 span 身份富化——这段本就是 004 的原意，非新增职责。

### 写侧富化 delta（唯一改动 = `orchestration.service.ts` chain 根 span）

在 `rag.pipeline` 根 span 上补以下属性（`prepare()` 解析出 `validConvId` 后 `setAttribute`；根 span 手动生命周期、`end()` 在 `finally`，时序来得及）：

| 属性 key | 值 | 用途 |
|---|---|---|
| `session.id` | `convId`（= 会话 id） | Session 分组键（004 Inv 2） |
| `gen_ai.agent.id` | `agentId`（应用标识） | 列表/详情 Agent 归属、按 Agent 筛选 |
| `gen_ai.agent.name` | agent 名称**快照** | 列表 Agent 列、Session Agent 列（快照避免改名回填历史） |
| `enduser.id` | `userId`（可空） | Session 列表「用户」列 |
| `rag.fallback.used` | `prep.isFallback` | 区分「兜底」状态（OK 但走兜底话术） |

新增常量登记到 `@codecrush/otel-conventions`（`SESSION_ID`、`GEN_AI.AGENT_ID/AGENT_NAME` 已有、`ENDUSER_ID`、`RAG.FALLBACK_USED` 已有常量）。**生成模型名 / token 总量 / cost 不上根 span**——由 VIEW 从子 span 聚合（结束即写，不回改根）。

## 决策 B：VIEW 分层（扩展 `001-trace-views.sql`）

三个 VIEW，全部 over `otel_traces`，读侧防腐（004 Inv 5）：

```
codecrush_trace_spans   （已有，保留/补列）
  每 span 一行：trace_id, span_id, parent_span_id, name, kind,
  start_time, duration_ms, status_code, attributes,
  + 便捷列：gen_ai.usage.input/output_tokens、rag.cost.usd（从 attributes 取，供聚合）

codecrush_traces        （新增，按 root span 聚合 = WHERE parent_span_id IS NULL 且 kind='chain'）
  trace_id, session_id, agent_id, agent_name, user_id,
  user_input(codecrush.io.input), output(codecrush.io.output),
  start_time, total_duration_ms(根 span dur),
  total_input_tokens/total_output_tokens(Σ 子 generation span usage),
  total_cost(Σ 子 span rag.cost.usd，全 null → null),
  status(OK/ERROR + fallback_used → 成功/兜底/失败),
  quality: low_recall/no_citations/refusal/timeout(根 span 四布尔),
  prompt_version_id, preview(rag.preview)

codecrush_sessions      （新增，按 session_id 聚合 root spans）
  session_id, user_id, agent_id, agent_name,
  round_count(trace 数), first_question(最早 root 的 io.input),
  first_ts/last_ts,
  status(任一轮 ERROR→含失败 / 无失败但任一兜底→含兜底 / 否则正常)
```

- **preview 隔离**（012）：`rag.preview=true`（试运行）默认从列表/概览排除，API 按 flag 过滤，不污染成功率/延迟统计。
- **状态映射**：`失败` = root status ERROR；否则 `rag.fallback.used` → `兜底`；否则 `成功`。
- Postgres 侧 `message.trace_id`、`conversations` 保持索引，只用于「回答 → trace」跳入，不参与读聚合。

## 决策 C：只读 API（扩展 `apps/backend/modules/traces`）

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /traces` | `{ items: TraceListRow[], total, summary }` | 列表 + 概览一次给全。query: `q`(问题/TraceID)、`agentId`、`status`、`quick`(全部/失败/慢请求/低分召回)、`from`/`to`(时间范围)、分页。`summary = { sampledTotal, failRate, failCount, p95Ms, timeoutCount }` 反映当前筛选集 |
| `GET /traces/sessions` | `SessionListRow[]` | Session 视图列表 |
| `GET /traces/sessions/:sessionId` | `{ session, turns: Turn[] }` | Session 详情：turns 从该 session root spans 还原（io.input=用户气泡、io.output=bot 气泡、每 bot 挂 `{ traceId, status, durationMs }` 溯源条）——纯 CH，无需 Postgres |
| `GET /traces/:traceId` | `{ traceId, meta, spans[] }` | 详情：`meta` = 头部六项（agent、生成模型+版本、prompt 版本、总耗时、tokens 入/出、cost）；`spans[]` = 规范化 span（含 typed attributes），前端据此建瀑布/树/面板 |
| `GET /traces/:traceId/otlp` | OTLP span JSON | 「复制 JSON」导出：该 trace 全部 span 的 OTLP 结构（从 CH raw 行拼） |

契约 DTO 落 `packages/contracts/src/traces.ts`：`TraceListRow`、`TraceListSummary`、`SessionListRow`、`SessionDetailResponse`、扩展 `TraceDetailResponse.meta`。质量信号数组 `qualitySignals: ('low_recall'|'no_citations'|'refusal'|'timeout')[]`。

## 决策 D：Cost 务实方案（不新建定价表）

`model_providers` 无定价列，但有 `params jsonb`(Record<string,string>)。**若模型 params 带单价**（如 `input_price_per_1k` / `output_price_per_1k`），写侧在 generation span 落 `rag.cost.usd`，VIEW `Σ` 聚合 `total_cost`；**未配定价则 span 不落 cost、UI 显示「—」**。避免为 cost 引入独立定价 schema 与迁移。见 Assumptions / Revisit。

## 前端四屏（1:1 还原原型，antd 优先）

原型锚点（`CodeCrushBot.dc.html`）：Trace 列表 `~L2182`、Session 列表 `~L2265`、Session 详情 `~L2285`、Trace 详情 `~L2346`。

1. **Trace 列表**（`TracesPage`）：概览四卡（采样数 / 失败率+失败条数红 / P95+超时熔断≥5s红 / 快捷排查预设 chip）+ 筛选行（关键词、Agent、状态、时间范围、重置）+ 分段控件切 Trace/Session + 表格（TraceID·时间·问题+质量信号内联标签·Agent·状态·总耗时·Tokens）+ 空态。接 `GET /traces`。
2. **Session 列表**：表格（SessionID·用户·Agent·轮次·首轮问题·会话级状态）。接 `GET /traces/sessions`。
3. **Session 详情**：1:1 还原 C 端聊天窗口（微信式绿气泡、Agent 头像/在线、装饰输入栏）+ 每条 bot 气泡下溯源条（状态+TraceID+耗时+「链路 →」）点击下钻。接 `GET /traces/sessions/:id`。
4. **Trace 详情**（`TraceDetailPage`）：头部用户问题 + 六项元信息 + 右上操作（**跳转 Prompt 版本**✅、**复制 JSON**✅、加入评测集/重放 = **占位/暂隐，M11**）；左栏调用链**时间轴（瀑布）/ 树**双视图（TRACE 根 + span，kind 颜色图例：检索/向量/重排/LLM/流程/工具；失败自动定位报错 span 标红、SKIP 灰化）；右栏 span 详情**按 kind 数据驱动**（ERROR 错误框 / 基础 meta / 根节点 Scores 卡[占位] / 检索命中分表 向量·关键词·Rerank·结果 Rerank≥0.65绿 / 引用来源 角标↔分块 / 输入「已脱敏」+ 输出）。瀑布偏移 = `span.start − root.start`，前端算。

## Boundaries

> 反漂移边界。改读模型形态 / 写侧身份 delta / VIEW 分层先改本文；架构级边界改 004。

**In-scope（M9）**
- 写侧 chain 根 span 身份富化 delta（5 属性，见决策 A）。
- 三 VIEW 读模型（trace_spans 补列 + traces + sessions）。
- 只读 API：list+summary / sessions / session 详情 / trace 详情 meta / OTLP 导出。
- 前端四屏接真（Trace 列表 / Session 列表 / 两级详情），1:1 还原原型。
- 跳转 Prompt 版本（M6 已建）、复制 OTLP JSON。
- Cost 务实聚合（模型带定价才算，否则 —）。

**Out-of-scope（M9 不做）**
- **排查闭环出口目标模块**：加入评测集、重放（带参跳效果评测）、Badcase 池汇入——目标 = M11 评测域，未建；M9 按钮占位或暂隐，不落库、不建 schema。
- **用户行为质量信号**：`用户点踩`（feedback 未落库）、`连续追问`（需会话分析）——属 Badcase 池范畴，随出口延后 M11。M9 列表质量标签 = 四个系统自动信号（已在 span）。
- **物化表 / worker / 流式 upsert / 看进行中 trace**（004 Out-of-scope，M9 仍 VIEW-only）。
- **实时告警 / 阈值订阅、自定义指标看板、采样率&留存 UI、脱敏规则自定义**（PDF「明确不做」，均为既有 OTLP 模型上的后续扩展）。
- **agent/tools 埋点面板**（004 留口不落）。
- 图片/媒体渲染（`media_id` 预留）。

**Invariants（承 004，M9 强化）**
1. 读侧只经自有 VIEW，应用只吐 OTLP（004 Inv 5）——M9 新 VIEW 不破此界。
2. `session.id` 是唯一会话分组键，落在 root span 上（本文补齐 004 Inv 2 的写侧前提）。
3. 读查询绝不进入问答关键路径；埋点故障不致问答失败（004 Inv 3）。
4. Trace 列表/Session/详情**单一事实源 = ClickHouse**；Postgres 仅供跳入索引，不作读聚合（决策 A）。
5. preview（试运行）trace 默认不进正式统计与列表（012）。

## Trade-offs

| 决策 | 选择 | 拒绝 | 取舍 |
|---|---|---|---|
| 列表/Session 读源 | **纯 CH VIEW + 写侧补根 span 身份** | Postgres 列表 + CH join 指标/详情 | 单一事实源、零跨库 join、最贴 004 读侧防腐；代价 = 动一次已交付 M8 写侧（改动小、本属 004 原意）。拒绝方案状态/质量有两套源（Postgres isFallback vs CH quality）需收口，偏离 VIEW-pure |
| 聚合层 | **VIEW-only**（trace_spans/traces/sessions） | 首期落物化表 / normalizer worker | ≤10qps 够用、组件最少（004 演进路径第 1 档）；性能不足再演进物化表 |
| 生成模型名/token 总量/cost | **VIEW 从子 span 聚合** | 冗余回写根 span | 不破「结束即写、不回改」；代价 = 详情查询多一层子 span 聚合（单 trace，量小） |
| Cost 定价源 | **模型 params 带价才算，否则 —** | 新建定价表 + 迁移 | 不膨胀 schema；代价 = 未配价的模型无 cost |
| 排查闭环出口 | **延后 M11、按钮占位** | M9 顺带做 Badcase/评测集最小实现 | 不提前引入 M11 数据模型、避免返工；代价 = M9 出口暂不可用 |

## Assumptions

1. 规模 ≤10qps（001/004）：VIEW-only + 单 ClickHouse 足够，无需物化/分片。
2. `convId` 在 `prepare()` 内解析完成、早于根 span `end()`——`session.id` 可在 span 存活期内补写（新会话亦然）。
3. Cost 仅当模型 `params` 配置单价时可算；无价 → cost null → UI「—」。
4. Trace ~2-3s 延迟出现可接受（结束即写，无进行中视图，004 假设）。
5. Session 详情用脱敏后的 `io.input/output` 还原对话（运维视角，输入带「已脱敏」标记）——不回 Postgres 取原文。
6. otel_traces schema 由 Collector `clickhouseexporter` 掌控；新 VIEW 只读投影，不依赖其内部列改名（防腐层吸收）。

## Revisit triggers

- 列表/聚合筛选变复杂或 VIEW 性能不足 → 落 `traces`/`sessions` 物化表（004 演进第 2 档）。
- 需用户点踩/连续追问信号、Badcase 自动聚类、加入评测集/重放 → M11 评测域落地时接（feedback 落库 + 会话分析 + 效果评测 schema）。
- 需实时告警 / 进行中 trace → 引入队列 + ReplacingMergeTree（走向 Langfuse 式，004 Revisit）。
- 出现独立成本压力 → 采样率/留存 UI + 定价表。
- 上 agent/tools → 启用 SDK `trace.tool/agent` 原语 + 面板（数据模型不变，004 Revisit）。

## 建议分波（交 `/ship:design` 细化）

> 每波一个 design→dev 闭环、完整对抗档；顺序按依赖。

- **W1 — 读模型地基**：写侧根 span 身份 delta（`orchestration.service.ts` + conventions 常量）+ `traces`/`sessions` VIEW + 后端 `GET /traces`(list+summary) / `GET /traces/sessions` + 契约 DTO + 前端 Trace 列表 / Session 列表接真。验收：真实问答后列表/概览/Session 出真数据、按 Agent/状态/快捷筛选生效、preview 不入统计。
- **W2 — Trace 详情下钻**：`GET /traces/:traceId` 补 `meta` 聚合 + 规范化 spans + `GET /traces/:traceId/otlp`；前端详情（瀑布/树双视图 + span 面板数据驱动 + 命中分表 + 引用 + 脱敏 IO + 错误框/SKIP + 跳转 Prompt + 复制 JSON）。验收：从列表点行开详情、失败自动定位报错 span、命中分/引用/tokens 齐全、JSON 导出可用。
- **W3 — Session 详情 + cost 收尾**：`GET /traces/sessions/:id` + 前端 C 端还原 + 溯源条下钻；cost 聚合（模型带价）+ 空态/时间范围/边界态打磨。验收：Session 气泡流还原、溯源条一键跳 trace、cost 有价则显示。

（cost 若 W2 更顺可前移；分波最终以 `/ship:design` 为准。）

## References

- 轻量 Trace 可观测架构（本文承接）：`004-trace-observability`
- 实现路线图（M9 范围与验收）：`002-implementation-roadmap`
- M8 RAG 编排（写侧 span 来源）/ 意图路由：`013-m8-rag-orchestration`、`014-intent-routing`
- NodeContract / Prompt 组装（node span 属性）：`011-prompt-assembly-node-contracts`、`012-prompt-management-redesign`
- 通用 Telemetry SDK 与包边界：`003-code-organization`
- 产品设计：`docs/prd/b-trace.pdf`
- UI 原型：`RAG知识库问答系统设计/CodeCrushBot.dc.html`（Trace 四屏）
