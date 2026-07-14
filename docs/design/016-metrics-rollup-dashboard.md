---
title: "指标读模型：ClickHouse 汇总层 + 第一批运行看板"
description: "在 otel_traces 之上加一层 AggregatingMergeTree 预聚合（物化视图增量卷积）作为指标读模型；第一批 8 指标全部复用已有埋点，纯读侧增量；产品做总览→应用→样本三层下钻。触发 004 演进第 2 步，喂 M10 运行看板。"
category: "design"
number: "016"
status: draft
services: [backend, frontend, observability]
related: ["design/002", "design/004", "design/013", "design/015"]
last_modified: "2026-07-14"
---

# 016 — 指标读模型：ClickHouse 汇总层 + 第一批运行看板

## Status

`draft` — 指标读模型设计。**承接 `004-trace-observability`**：004 的存储分层（Session→Trace→Span、OTLP「结束即写」、读侧经自有 schema 防腐、大 payload offload）**全部不变**；004 第「演进路径」节明确规划「VIEW 投影 → ClickHouse Materialized View 宽表」两步（004 §读模型演进 step 2、Revisit「VIEW 性能不足 → 落物化表」），**本文就是那一步的落地**：不推翻既有 VIEW，在其旁增量加一层预聚合表，专供指标聚合与看板。

2026-07-14：**W-a 后端已落地**。实现采用 D2′：`codecrush_metrics_1m` 只存一列可合并 `dur_tdigest` state，窗口与趋势查询直接对该自有表执行 `xxxMerge`；不建会诱导跨桶/跨应用错误聚合的 finalize VIEW。cost 真算与前端看板拆为后续独立波。
2026-07-14：**W-b1 已落地**。前端总览、筛选、阈值染色与候选 Trace 下钻已接真实 API；单应用响应新增固定六阶段 P50/P95/样本数，直接从 `codecrush_trace_spans` 现算。cost 仍未启用。

**对抗强度：完整对抗**（架构性任务——新增 ClickHouse 存储 schema 决策 + 写侧根 span delta；按 `CLAUDE.md` 分级：碰存储 schema 取高档）。

## Summary

平台三词「可配置、可追踪、**可优化**」中，「可优化」目前最弱：trace 全量落了 ClickHouse，但没有度量优化效果的指标层与看板。本文补两块，**都在读侧增量、不改写侧关键路径**：

1. **指标读模型（存储/技术）**：在导出器建的 `otel_traces` 之上，用**物化视图（增量触发）**把热点指标按 `(分钟桶 × 应用 × 模型)` 卷积进一张 `AggregatingMergeTree` 汇总表 `codecrush_metrics_1m`；后端直接合并该自有表的聚合 state（秒回），每个数字可下钻回原始 trace（明细）。
2. **第一批看板（产品）**：后端 W-a 先交付问答量、兜底/失败/质量计数、P50/P95、token 与预留 cost 的契约/API；前端看板、cost 真算、分阶段耗时和可信度分布按独立后续波交付。产品最终仍做**总览 → 应用 → 样本**三层下钻。

指标信号分两条线：**产品/RAG 指标**从 trace 聚合（本文主体，线 A）；**平台自身健康**（Collector 队列、CH 写入、pg-boss 积压）跨请求、聚合不出来，走独立 OTel Metrics → Prometheus（线 B，本文只登记边界，落地延后）。

## Boundaries

> 反漂移边界。改架构/范围先改本文。

**In-scope（本文首波）**
- `codecrush_metrics_1m`（AggregatingMergeTree 汇总表）+ 增量物化视图；读侧直接对自有聚合 state 做 `xxxMerge`。
- 历史回填一次性 `INSERT … SELECT …State`（物化视图只捕获新 INSERT，需回填既有数据）。
- 写侧 delta **D-metrics**：根 chain span 落整条 trace 的 `gen_ai.usage.*` 汇总与生成模型标签（见下方「关键决策」）；cost 无定价源，本波不 emit。
- 只读 API：`GET /metrics/overview`、`GET /metrics/apps/:id`；下钻复用已有 `GET /traces`（带筛选）。

**Out-of-scope（本文不做，schema 不堵死）**
- 线 B 平台自监控 Metrics（Collector/CH/pg-boss/PG）→ Prometheus 与告警：单独一波。
- 热门问题聚类、问题归一（需 NLP，归 M10 深化）。
- 需要标准答案的检索命中率/引用正确率/回答准确率 → 离线评测集（M11），不进实时看板。
- TTFT（首 token 时间）、结构化输出修复率、单路召回降级率：需各补一个 span 属性，第三波。
- 前端：首页运行看板、阈值染色与样本下钻入口，走独立前端 plan。
- cost 真算、分阶段耗时与可信度分布，分别等待定价/额外聚合信号后落地。
- 多分辨率汇总表（1h/1d rollup 的 rollup）、冷热分层、CH 分片/副本：规模触发前不做（见 Revisit）。

**Invariants（不可违反）**
1. **指标绝不进入问答关键路径**（延续 004/001 Invariant 1）：物化视图、汇总表、看板查询全在读侧；物化视图即便报错也**不得阻塞 `otel_traces` 写入**（CH MV 失败默认不回滚源插入，需显式保持该行为，不加会抛的约束）。
2. **原始导出器表经防腐层读取**（延续 015）：常规查询不直接依赖 `otel_traces` schema；`codecrush_metrics_1m` 是平台自有派生表，后端可直接合并其聚合 state。建表与一次性回填是受控初始化例外。
3. **preview 不入正式统计**：试运行流量（`rag.preview='true'`）在物化视图 `WHERE` 处即排除（对齐 `codecrush_sessions`）。
4. **汇总表是派生数据、可重建**：`codecrush_metrics_1m` 任何时候可 `TRUNCATE` 后从 `otel_traces` 全量回填；它不是事实源，`otel_traces` 才是。

## 关键决策：为什么根 span 要在写侧带 trace 级汇总（D-metrics）

**问题**：ClickHouse 物化视图**按 INSERT 批次触发**，只能看到本批次的行。而一条 trace 的多个 span（根 chain + 各子 span）经 Collector 批处理后**分散在不同 INSERT 批次到达**。因此「跨同一 trace 的多个 span 求 token 和」在物化视图里**做不干净**（子 span 可能不在触发批次里）。

**否决的做法**：让物化视图对 `otel_traces` 全表按 `TraceId` GROUP BY 求 token——那是每批次重扫全表，违背增量卷积初衷，量大即崩。

**采用的做法（D-metrics 写侧 delta）**：让**根 chain span 在关闭时就带上整条 trace 的汇总**——`gen_ai.usage.input_tokens` / `output_tokens` 总和与 reply 的 `gen_ai.request.model` 标签。编排内核从 node-runtime 的真实 usage 累计；流式路径在终态 summary 之外同步观察已知累计值，保证失败/取消路径也尽量完整。cost 待定价基础设施落地后再接。这样：

- 物化视图**只读根 chain span**（`WHERE codecrush.span.kind='chain'`），**每行 = 一条 trace**，所有指标都是「单行投影 + 分组聚合」，无跨行 join，增量卷积干净且正确。
- 与既有架构一致：根 chain span 已经是「trace 级身份/质量/状态」的载体（015 W1），token/model 汇总落它是同一模式的自然延伸。

> D-metrics 是本文唯一的写侧改动，且是**加属性**（非破坏性）；`codecrush_traces` 现有 `LEFT JOIN 子 span 求 token` 的逻辑保留兼容，读根 span 的汇总属性优先、缺失回退 JOIN。

## Design — 存储/技术

### 分层（物理只有一张原始表，其余为派生/VIEW）

```
otel_traces (导出器建, 唯一事实源, 一 span 一行)
   │
   ├─(物化视图 增量触发, 只读根 chain span)──► codecrush_metrics_1m
   │                                            AggregatingMergeTree
   │                                            (分钟桶 × 应用 × 模型, 存聚合中间态)
   │                                                 │
   │                                                 │
   │                                            GET /metrics/*
   │                                            (直接 xxxMerge state) ──► 运行看板
   │
   └─(现算下钻)──► codecrush_traces (015 既有 VIEW) ──► GET /traces ──► trace 列表/详情
```

### 汇总表 schema（AggregatingMergeTree）

按 `(bucket, agent_id, gen_model)` 存**聚合中间态**（`AggregateFunction`），而非最终值——中间态可跨分钟桶再合并（算任意时间窗的 P95）。示意（最终签名实现时定稿）：

```sql
CREATE TABLE codecrush_metrics_1m
(
  bucket           DateTime,                               -- toStartOfMinute
  agent_id         LowCardinality(String),
  gen_model        LowCardinality(String),
  qa_count         AggregateFunction(count),
  fail_count       AggregateFunction(sum, UInt64),         -- countIf → sumState(0/1)
  fallback_count   AggregateFunction(sum, UInt64),
  low_recall_count AggregateFunction(sum, UInt64),
  no_cite_count    AggregateFunction(sum, UInt64),
  refusal_count    AggregateFunction(sum, UInt64),
  timeout_count    AggregateFunction(sum, UInt64),
  dur_tdigest      AggregateFunction(quantileTDigest, Float64),
  input_tokens     AggregateFunction(sum, UInt64),
  output_tokens    AggregateFunction(sum, UInt64),
  cost_usd         AggregateFunction(sum, Float64)
)
ENGINE = AggregatingMergeTree
ORDER BY (bucket, agent_id, gen_model);
```

> 分阶段耗时（改写/意图/召回/embedding/rerank/生成）粒度更细、需按 span name 分维，第一波先出**端到端 P50/P95**；分阶段 P95 作同表扩展列或姊妹表，第一波可先在详情页保留（已有 span duration），看板分阶段延后半波，避免维度爆炸。

### 增量物化视图（写侧触发器，只读根 span）

```sql
CREATE MATERIALIZED VIEW codecrush_metrics_1m_mv TO codecrush_metrics_1m AS
SELECT
  toStartOfMinute(Timestamp)                       AS bucket,
  SpanAttributes['gen_ai.agent.id']                AS agent_id,
  SpanAttributes['gen_ai.request.model']           AS gen_model,
  countState()                                     AS qa_count,
  sumState(toUInt64(StatusCode IN ('Error','STATUS_CODE_ERROR'))) AS fail_count,
  sumState(toUInt64(SpanAttributes['rag.fallback.used']    = 'true')) AS fallback_count,
  sumState(toUInt64(SpanAttributes['rag.quality.low_recall']  = 'true')) AS low_recall_count,
  sumState(toUInt64(SpanAttributes['rag.quality.no_citations']= 'true')) AS no_cite_count,
  sumState(toUInt64(SpanAttributes['rag.quality.refusal']  = 'true')) AS refusal_count,
  sumState(toUInt64(SpanAttributes['rag.quality.timeout']  = 'true')) AS timeout_count,
  quantileTDigestState(toFloat64(Duration) / 1000000)  AS dur_tdigest,
  sumState(toUInt64OrZero(SpanAttributes['gen_ai.usage.input_tokens']))  AS input_tokens,
  sumState(toUInt64OrZero(SpanAttributes['gen_ai.usage.output_tokens'])) AS output_tokens,
  sumState(toFloat64OrZero(SpanAttributes['rag.cost.usd']))              AS cost_usd
FROM otel_traces
WHERE SpanAttributes['codecrush.span.kind'] = 'chain'      -- 只读根，每行一 trace（依赖 D-metrics）
  AND SpanAttributes['rag.preview'] != 'true'              -- Invariant 3
GROUP BY bucket, agent_id, gen_model;
```

> `input/output_tokens` 依赖 D-metrics 已把 trace 级汇总落到根 span；未落地前该两列读根 span 会偏低（只有生成节点自身或空），故 **D-metrics 是本表 token/cost 准确的前置**。

### 读查询（D2′：直接合并中间态）

不建立按 `(bucket, agent, model)` finalize 的读 VIEW。窗口 P50/P95 必须跨分钟桶和应用维度合并 t-digest state；先 finalize 为标量后再聚合会产生统计错误。窗口查询直接从自有汇总表合并：

```sql
SELECT
  countMerge(qa_count)                       AS qa_count,
  sumMerge(fail_count)                       AS fail_count,
  sumMerge(fallback_count)                   AS fallback_count,
  sumMerge(low_recall_count)                 AS low_recall_count,
  sumMerge(no_cite_count)                    AS no_cite_count,
  sumMerge(refusal_count)                    AS refusal_count,
  sumMerge(timeout_count)                    AS timeout_count,
  quantileTDigestMerge(0.50)(dur_tdigest)    AS p50_ms,
  quantileTDigestMerge(0.95)(dur_tdigest)    AS p95_ms,
  sumMerge(input_tokens)                     AS input_tokens,
  sumMerge(output_tokens)                    AS output_tokens,
  sumMerge(cost_usd)                         AS cost_usd
FROM codecrush_metrics_1m
WHERE bucket >= {from:DateTime} AND bucket <= {to:DateTime};
```

趋势查询使用同一组 `xxxMerge` 并 `GROUP BY bucket`；筛选应用/模型仍作用于 state 合并前。`fallback_rate = sumMerge(fallback_count) / countMerge(qa_count)`。

### 历史回填

物化视图只捕获**新** INSERT。上线时对既有 `otel_traces` 一次性回填（与 MV 的 SELECT 同形，用 `xxxState`）：

```sql
INSERT INTO codecrush_metrics_1m
SELECT toStartOfMinute(Timestamp) AS bucket, … , countState() AS qa_count, …
FROM otel_traces
WHERE SpanAttributes['codecrush.span.kind']='chain' AND SpanAttributes['rag.preview']!='true'
GROUP BY bucket, agent_id, gen_model;
```

> 不用 `POPULATE`。W-a 采用「先建 MV，再在汇总表为空时回填」的单实例低 QPS 简化语义；空表守卫避免重启重复回填。MV 建成与回填间的极小并发窗口可能重复计入边界 trace，严格重建时使用 `TRUNCATE codecrush_metrics_1m` 后停写/按建 MV 时刻切分回填范围。

### 只读 API

- `GET /metrics/overview?from&to&agentId?&model?` → 时间窗内各指标 + 按时间桶的趋势序列。
- `GET /metrics/apps/:id?from&to` → 单应用维度（含分阶段耗时，读 `codecrush_trace_spans` 现算或后续入表）。
- 下钻**不新建端点**：看板点击 → 跳已有 `GET /traces`，带 `agentId/status/from/to/quality` 筛选（部分筛选项 015 已支持，缺的补 where）。

### W-b1 应用分阶段耗时口径（2026-07-14）

`GET /metrics/apps/:id` 在总览同形的 `window + series` 外增加 `stages`。阶段耗时首版直接从
`codecrush_trace_spans` 现算，只查询所选应用与时间窗的正式 trace；不改写侧、不新增物化表，避免在
问答关键路径引入任何成本。返回阶段固定为：

| stage | 中文 | span 识别规则 |
|---|---|---|
| `rewrite` | 问题改写 | `kind='llm' AND attributes['rag.node.name']='rewrite'` |
| `intent` | 意图识别 | `kind='llm' AND attributes['rag.node.name']='intent'` |
| `embedding` | 向量化 | `name='retrieval.embedding'` |
| `retrieval` | 检索总段 | `name='retrieval.retrieve'` |
| `rerank` | 重排 | `name='retrieval.rerank'` |
| `generation` | 回复生成 | `kind='llm' AND attributes['rag.node.name'] IN ('reply','fallback')` |

每阶段返回 `sample_count / p50_ms / p95_ms`，没有样本的阶段仍按固定顺序返回，计数为 0、分位值为
`null`，避免把“未执行”误写成 0ms。筛选身份与正式流量取同 trace 的 chain span：
`gen_ai.agent.id=:id`、chain `Timestamp` 落在 `from/to`、`rag.preview!='true'`；模型筛选使用 chain
上的 D-metrics `gen_ai.request.model`。阶段查询按 span 样本统计：多 KB 检索可能在一条 trace 中产生多个
`retrieval.retrieve` 样本，`sample_count` 因而不等于问答量。

`retrieval.retrieve` 是父 span，包含其 `retrieval.embedding` 与可选 `retrieval.rerank` 子 span；首版图表
展示各阶段独立 P50/P95，**不得相加**、不得画成暗示互斥分段的堆叠总耗时。前端仅在选定具体应用时
展示阶段面板；点击阶段携带相同 `agentId/from/to` 下钻 trace 列表，但现有 trace API 尚无 span-stage
筛选，故首版下钻是该应用同时间窗的候选样本而非精确阶段集合。

## Design — 指标清单（按域 · 优先级）

> 🟢 span 已埋，直接聚合　🟡 已有一半/需补属性　🔴 需新埋点或离线　★ 第一批必做

| 域 | 指标 | 来源 | 口径 |
|---|---|---|---|
| **质量** | ★兜底率 | 🟢 | `sum(fallback)/count`（`rag.fallback.used`）——**首选健康度单指标** |
| | ★低召回/无引用/拒答/超时率 | 🟢 | `rag.quality.*` 四布尔 |
| | 平均引用数、可信度分布 | 🟡 | citations 在 PG messages / `rag.citation.ids`；confidence 需回填进根 span |
| | 结构化输出修复率 | 🟡 | node-runtime 有 repair count，补根 span 属性 |
| **延迟** | ★端到端 P50/P95 | 🟢 | `total_duration_ms` 分位（quantileTDigest） |
| | ★分阶段耗时 | 🟢 | 各 span duration（第一波看板先详情页，看板扩展列） |
| | TTFT、生成 token/s | 🟡 | TTFT 需补 `rag.ttft_ms`（T2 已有首 token 检测） |
| **成本** | ★花费 $ | 🟡 | `rag.cost.usd`（W3 落地 + D-metrics 上根 span） |
| | ★token 量、单次均成本、按应用归因 | 🟢/🟡 | `gen_ai.usage.*`（T3 已埋，经 D-metrics 汇总） |
| **用量** | ★问答量/QPS | 🟢 | `count`，按 `agent_id`/`gen_model` |
| | 活跃会话/平均轮次/DAU | 🟢 | `codecrush_sessions`（round_count）、distinct `enduser.id` |
| | 热门问题 | 🔴 | 需聚类，延后 |
| **可靠性** | ★失败率、熔断率 | 🟢 | `status='failed'`、`rag.quality.timeout` |
| | 单路召回降级率、厂商错误率 | 🟡 | 补降级布尔 / 协议层埋 |
| **检索** | 命中分数分布、召回空率 | 🟢 | `rag.chunk.scores` |
| | 命中率/引用正确率/回答准确率 | 🔴 | 需 ground truth → 评测集 M11，离线 |

**W-a 后端已交付指标**：问答量、兜底/失败计数与率、四类质量计数、端到端 P50/P95、input/output token；`cost_usd` 列与响应字段预留且恒 0。前端展示、cost 真算与可信度分布后续交付。

## Design — 产品/看板

**核心原则：每个聚合数字都能下钻到具体样本 trace。** 这是本平台相对通用 metrics 系统（Grafana/Prometheus 只有数）的独有优势——「兜底率 8%」点得进那 8% 是哪些问答。三层，天然接上 015 已有的 trace 列表→详情。

**① 平台总览（首页运行看板，实体化 M10 占位）**
- 顶部指标卡：今日问答量 / 兜底率 / 端到端 P95 / 今日花费。
- 趋势图：问答量、兜底率、成本（时间序列，来自 overview 的桶序列）。
- 全局控件：**时间范围选择器**（今日/7 日/自定义）+ **应用/模型筛选**。
- 阈值染色：兜底率、失败率超阈值（默认 5%）标红（前端阈值，可配）。

**② 应用维度（点某应用）**
- 同指标限定该应用 + **分阶段耗时瀑布**（哪个阶段慢一目了然，读 span duration）+ 该应用质量信号明细。

**③ 样本下钻（点任意数字/图上某点/某质量信号）**
- 跳已有 trace 列表，**带该筛选条件**（如「本时段 fallback.used=true 的问答」）→ 点一条 → M9 W2 已做好的 trace 详情页。**这条链路大部分已存在，看板只提供入口。**

**产品动作（让「可优化」闭环）**
- **阈值告警**：兜底率/失败率超阈值 → 首页红标（通知渠道延后，属线 B）。
- **Badcase 出口**：从质量指标一键把坏样本捞成列表，作为将来评测集（M11）入口——「可追踪 → 可优化」的接点。

## Failure modes

- **物化视图执行报错**：CH 默认 MV 失败不回滚源 INSERT；显式保持（不给 MV 加会抛异常的约束/类型转换），保证 Invariant 1——指标坏了，trace 照常落、问答照常成。
- **D-metrics 未落地/根 span 无 token 汇总**：token/cost 偏低但不报错；`codecrush_traces` 保留 JOIN 兜底，看板 token 列在 D-metrics 前标「—」或走 JOIN 慢路径。
- **汇总表数据疑似错乱**：派生可重建——`TRUNCATE codecrush_metrics_1m` 后全量回填，事实源 `otel_traces` 不动。
- **回填与 MV 边界重叠**：按建 MV 时刻切分回填时间范围，避免同桶被双算（见回填注）。

## Alternatives considered

| 决策 | 选择 | 拒绝 | 放弃了什么 |
|---|---|---|---|
| 指标计算 | 从 trace 派生（读侧聚合） | 应用发独立 OTel Metrics 计数器/直方图 | 与 trace 解耦、不受采样偏差——换可下钻到样本 + 无第二套埋点。低 qps 无采样，派生够用 |
| 聚合时机 | 物化视图增量卷积（预聚合） | 每次看板现算原始表 / 定时批处理 | 首波简单——换看板秒回 + 落库时顺手算、无批任务 |
| token 跨 span 汇总 | 写侧 D-metrics 落根 span | MV 全表 GROUP BY TraceId | 零写侧改动——换 MV 干净增量、不每批重扫全表（见关键决策） |
| 属性存储 | Map + 汇总表投影热点 | 原始表直接加物化列/跳数索引 | 改导出器 schema 风险——换派生表隔离，导出器不动。物化列是后续 Revisit 项 |
| 平台健康指标 | 独立线 B（Prometheus） | 塞进 trace 派生 | 统一一处——换正确性：跨请求信号本就不在 trace 里 |

## Rollout & 分波

- **W-a（已交付）**：D-metrics 写侧 delta（根 span 落 token/model 汇总）+ `codecrush_metrics_1m` + MV + 守卫回填 + `GET /metrics/overview|apps`。cost 列恒 0，不建 finalize VIEW。
- **W-b1（已交付）**：前端运行看板、应用筛选、候选 Trace 下钻、阈值染色与单应用六阶段 P50/P95。
- **W-b2**：TTFT/修复率/降级率补属性、精确阶段下钻与 Badcase 出口列表按依赖继续拆波。
- **W-cost**：定价模型、配置 UI、`rag.cost.usd` emit 与历史重算，独立设计实施。
- **W-c（线 B，独立）**：Collector metrics pipeline → Prometheus + 平台健康看板 + 告警通道。

**「在工作」信号**：跑 N 条真实问答（含至少一条兜底、一条失败）→ 看板数字与手动 `SELECT … FROM codecrush_traces` 现算结果一致 → 点兜底率下钻能落到那条兜底 trace 详情。

## Revisit triggers

## W-b2 诊断信号契约（2026-07-14）

W-b2 不包含 W-cost，也不提前创建 M11 评测集或 Badcase 持久化模型。新增信号仍沿用
OTLP → Collector → ClickHouse 事实链路；写侧只做进程内、best-effort 的 observer 汇总，observer
异常必须被吞掉，不得等待外部 I/O。

- `rag.ttft_ms`：调用 provider stream 前的单调时钟至首个非空 delta；超时、首 token 前失败或
  abort 时缺省，不写 0。
- `rag.generation.duration_ms`：reply 流从 provider 调用开始至结束的持续时间。
- `rag.generation.tokens_per_second`：`output_tokens / ((duration_ms - ttft_ms) / 1000)`；分母
  非正或无 output token 时缺省。界面必须标为“生成 token/s（首 token 后）”。
- `rag.repair.attempt_count / eligible_count`：发生修复的结构化节点调用数 / 已执行且可判断的
  结构化节点调用数。
- `rag.degraded.keyword_recall.count / rag.retrieval.execution_count` 与
  `rag.degraded.rerank.count / rag.rerank.requested_count` 分别是两类独立降级的分子分母；属于
  检索执行样本，不等于问答数。子 span 只写无敏感正文的布尔属性。
- `rag.quality.confidence` 是现有检索分数派生的启发式可信度，不是正确率；fallback/无可用值时
  缺省。`rag.citation.count` 与 `rag.citation.coverage=full|partial` 描述引用数量与覆盖，不宣称
  引用正确性。

`GET /metrics/apps/:id` 增加 `signals`：TTFT 与 token/s 的样本数和 P50/P95、repair 与两类
degradation 的分子/分母/nullable rate、可信度固定分桶、引用数固定分桶和覆盖计数。零分母返回
`null`，无样本的分位值返回 `null`。当前应用详情按所选应用/时间/模型在正式 chain span 上聚合；
流量或查询规模触发性能阈值时迁移到独立 `codecrush_metrics_quality_1m`，不得原地修改既有
`codecrush_metrics_1m`。

Trace 查询增加 typed `signal` 与 `model`，所有条件与 stage/application/time/status 组合。Badcase
仅是这些信号对应的只读候选 Trace 集合；`GET /traces/export` 复用同一查询、稳定时间倒序、上限
10,000，CSV 对引号/换行和表格公式前缀转义，只导出 trace 身份、时间、应用、问题、状态、耗时和
质量信号，不导出 span IO、引用正文或秘密。加入评测集、回放、标签和所有权继续属于 M11。

- 单分钟桶维度组合（应用×模型）过多致汇总表膨胀 → 降维或拆姊妹表。
- 时间窗查询仍慢（跨大量 1m 桶）→ 加 1h/1d 多分辨率 rollup（rollup 的 rollup）。
- 需按任意长尾属性切片 → 原始表加物化列 + bloom filter 跳数索引（属性存储从纯 Map 走向 Map+热点列，对齐业内成熟部署）。
- 采样引入（trace 抽样）→ 派生指标失真，改发独立 OTel Metrics 计数器补真值。
- 需实时告警/通知 → 提前线 B。

## References

- `004-trace-observability`：读模型演进路径（step 2 = 本文）、Revisit「VIEW 性能不足 → 物化表」
- `015-m9-trace-read-model`：既有 `codecrush_traces/sessions/trace_spans` VIEW、根 chain span 身份富化、写侧 delta 模式（D1/D2）
- `013-m8-rag-orchestration`：T3 写侧 `gen_ai.usage.*` / `rag.quality.*` / `rag.chunk.scores` 埋点来源
- `002-implementation-roadmap`：M10 运行看板（本文为其读模型地基）、M11 评测集（Badcase 出口去向）
- OpenTelemetry Collector `clickhouseexporter`（`otel_traces` 标准表）；ClickHouse `AggregatingMergeTree` / `Materialized View` / `quantileTDigest`
