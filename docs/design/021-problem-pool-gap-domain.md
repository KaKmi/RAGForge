---
title: "知识缺口 / 问题池域（E-W4 B2a）"
description: "坏样本自动入池、增量 embedding 聚类、根因分诊与缺口状态机；新建 gaps 域作为 eval-runs 之上的新依赖顶点，并把坏样本批量沉淀为 gold 用例。"
category: "design"
number: "021"
status: draft
services: [backend, frontend, infra]
related: ["design/002", "design/003", "design/017", "design/018"]
last_modified: "2026-07-21"
---

# 021 — 知识缺口 / 问题池域（E-W4 B2a）

评测飞轮的离线主干在 E-W2a/W2b/B1 已闭环（gold 题库 → run 引擎 → 记分卡 → 屏3 报告 → 屏4 版本对比 → 单条重放 → 上线门禁 → 在线回流），
但**「问题聚合 → 批量沉淀 gold」这一段仍缺**（`002:54`）。坏样本只能靠人在 Trace 列表里逐条打捞。

原型 §9（`assets/eval-flywheel-product-design.html:354`）一句话点破本页存在的理由：
**「原始 trace 列表给不了『聚类+频次+状态』」**。

产品权威：`docs/design/assets/eval-flywheel-product-design.html` §9（`:353-380`）、§17.5（`:626-637`）、§10、§18.C。

## 0. 波次切分（用户 2026-07-19 拍板）

原型波次表（`:555`）定义 **E-W4 = 屏5 问题池（自动聚类+分诊+补库人审流+回验）+「从坏样本生成」+ 首页质量摘要行**。
调查后确认全量远超一波，切成两波：

| 波 | 范围 | 状态 |
|---|---|---|
| **B2a**（本文） | 首页质量摘要行；屏5 问题池核心（自动收集 / 增量聚类 / 自动分诊 / 表格与筛选 / 拆分合并 / 忽略）；入池入口（Trace 详情、屏3 逐用例表）；「从坏样本生成」三步 Modal；[修检索参数] 跳转 | 本波 |
| **B2b** | [补知识库] 三步人审向导（LLM 草拟 → 人审 → 走 ingestion 入库）；自动回验（入库后重放+评分、`41→89` 改善、7 天内 ≥5 条复发重开）；屏3 逐 case 标记忽略；B2a 三项降级收口（promote 原子事务 / centroid CAS / 入集重复检测补语义近似） | **已交付**（决策 I–N，见 §9b；迁移 0028/0029） |

**切分依据**：① `002:54` 自述 B2 目标即「问题聚合 → 批量沉淀 gold」，正是评测飞轮臂；
② 原型 `:138` 明说这是**两个咬合的飞轮**（知识缺口飞轮补库 / 评测飞轮回归题库），共享同一批坏样本作起点——天然的切分缝；
③ 补库臂要动 KB 入库管线，且带一条产品红线「**无人审不入库**——LLM 编错答案会污染知识库且忠实度还显示满分」（`:367`），是独立的信任面。

⇒ 缺口状态机的 `草拟中 / 待人审 / 已入库 / 已回验` 四态在 B2a **不可达**（见决策 H 的前向兼容要求），**B2b 已全部打通**——七态全集见 §9。

## 1. 决策 A —— `gaps` 是新的依赖顶点（在 `eval-runs` 之上）

**它拥有**：缺口簇、簇内问题、入池阈值判定、增量 embedding 聚类、自动分诊、簇状态机、
以及「从坏样本生成」的 gold 草拟与批量沉淀编排。

**允许的依赖边（穷举，且仅此）**：

```
gaps ──► eval-runs      （[进评测集]：批量创建 draft 用例）
  ├────► evaluations    （阈值设置 / judge 版本 / embeddingModelId）
  ├────► models         （ModelProviderPort：聚类 embedding、LLM 草拟 gold）
  └────► platform/{clickhouse, persistence, queue}
```

**反向一律禁止**：`eval-runs` / `evaluations` / `chat` / `traces` **不得** import `gaps`。

新分层（`003` 的分层图同步更新）：

```
⓪ gaps        问题池 / 知识缺口（B2a 新顶点）
   │
① eval-runs   离线评测 run（原顶点）
   │
② chat / evaluations / traces …
```

### 为什么不放进 `evaluations`（认真评估过的替代方案，记录以防后人重开）

看起来更省：自动聚类的生产者就是 `evaluations` 的后处理 worker（原型 §11.1 的数据流图里聚类确实画在那一步），
且 `evaluations` 已有 `ModelsModule` 能做 embedding。

**否决理由**：[进评测集] 需要**服务端**批量创建 gold 用例（一次 N 条、要做重复检测、要写 `source_trace_id`）。
`evaluations → eval-runs` 是**反向边**，直接违反 `003`「E-W2a eval-runs 域边界」一节的「`evaluations` 与 `chat` 均不反向依赖 `eval-runs`」。
绕开只有两条路，都更差：① 前端逐条 POST（N 个请求、无事务、失败一半没法回滚，且重复检测要在前端跑 embedding，不可行）；
② 让 `eval-runs` 反过来 import gap 表——成环。

⇒ **需要同时驱动「读坏样本聚合」与「写 gold 用例」的编排关切，只能放在两者之上。**
这与 `018` 决策 A 对 `eval-runs` 自身的论证**结构完全同构**，是同一条推理的第二次应用。

### 为什么不加 `gaps → traces` 边

`gaps` 自建 `ClickHouseGapsRepository`，直接注入 `platform/clickhouse` 的 client。
**每个域持有自己的 CH read repository 是本仓既定模式**：`003`「E-W1 evaluations 域边界」一节明写「evaluations 与 traces 不直接 import；
写侧经 OTLP 解耦，读侧**分别查询** ClickHouse VIEW」，`clickhouse-evaluations.repository.ts` 即先例。

约束：**只读现有 VIEW**，复用 `platform/clickhouse` 既有的 `loadSqlStatements` / `otelTracesTableExists`，不新建 SQL 文件。
唯一的 DDL 例外见决策 C。

### Revisit 触发条件

若将来出现第二个消费者需要「坏样本聚合」（自动化 A/B 引流器、周报生成器等），
应把聚合抽成 `gaps` 拥有的**只读端口**由消费方 DI，而不是让第二个模块也 import `gaps` 的具体类。

## 2. 决策 B —— 屏3「加入问题池」走前端组合，不产生反向边

原型 `:322`/`:608` 要求屏3 逐用例表行尾能「加入问题池」。
若做成后端 `eval-runs → gaps` 调用，与决策 A 的 `gaps → eval-runs` **立刻成环**。

⇒ **该动作走前端组合**：`EvalRunDetailPage` 的 Dropdown 直接调 `POST /api/gaps/items`，
body 带 `{question, source:"offline_run", sourceTraceId, ...}`。
先例：`AddToEvalSetModal.tsx:105-113` 就是前端把 `question` 传给后端的既有范式。

前端**不受后端依赖图约束**（`eslint.config.mjs` 只禁前端 import backend），
所以同一个 Modal 组件可同时挂在 `EvalSetsPage` 与 `GapsPage` 上，产品形态 1:1 还原，后端仍无环。

## 3. 决策 C —— 入池信号与唯一的 CH DDL 例外

原型 `:378` 定义入池阈值：「可信度 <60 或 兜底 或 无引用 或 eval 任一分 <70；preview/replay/评测 trace 一律不入池」。

**「信号已存在」只在 span 属性层成立，读侧投影并不齐**（B2a execution drill 发现）：

| 原型信号 | 埋点层 | 读侧 `codecrush_traces` |
|---|---|---|
| 可信度 | `rag.quality.confidence`（`otel-conventions:52`，`orchestration.service.ts:337` 在发） | ❌ **任何 view 都没投影** |
| 兜底 | `rag.fallback.used`（`:55`） | ⚠️ 折进 `status`（`001-trace-views.sql:44` 的 `multiIf`） |
| 无引用 | `rag.quality.no_citations` | ✅ `no_citations`（`:47`） |
| eval 三分 | `rag.eval` span | ✅ 走 `LATEST_EVAL_SQL` |

**处置**：
- 兜底 → 谓词用 `t.status = 'fallback'`，不发明新列。
- 可信度 → **给既有 `codecrush_traces` 追加一个投影列**
  `toFloat64OrNull(root.SpanAttributes['rag.quality.confidence']) AS confidence`。

**这是本波唯一的 CH DDL，且是安全的**：view 由本仓维护、以 `CREATE OR REPLACE VIEW` 重建；追加列是纯附加，
既有具名列调用方全不受影响；两个 MV（`codecrush_metrics_1m_mv` / `codecrush_eval_targets_mv`）都读 `otel_traces` 而非本 view。
**必须用 `toFloat64OrNull` 而非 `OrZero`**——属性缺失时记 0 会让每条没埋点的 trace 都被判成「低可信度」灌进池子。

**preview 排除是硬不变量**（原型 E2 `:458`）：收集器查询**必须显式含 `preview = 0`**，
不依赖「只有在线抽样 trace 才有 `rag.eval` span」这条间接性质（既有 `getLowSamples` 正是这么依赖的，本域不照抄该疏漏）。

## 4. 决策 D —— 自动入池只吃在线流量；离线只手动，且不计入 30 天频次

`gap_items.source` 三值：`online`（worker 自动收集）/ `manual_trace`（人从 Trace 详情手动入池）/ `offline_run`（人从屏3 逐用例表入池）。

**频次两个数**（原型 `:377` 一句话里其实有两个口径）：
- `freq`：**累计计数器，只增不减**——即 mock 里的「×23」。簇内 trace 过 TTL 不减频次（trace 到期只让链接置灰）。
  这也是它必须落 Postgres 而非查 ClickHouse 的原因：`otel_traces` 有 **TTL 30 天**（实测 `TTL toDateTime(Timestamp) + toIntervalDay(30)`），到期真删。
- `freq_30d`：滚动 30 天实时聚合，谓词 `source <> 'offline_run' AND trace_start_time >= now() - interval '30 days'`。

**为什么排除的是 `offline_run` 而不是「只算 `online`」**：`manual_trace` 是人从 Trace 详情挑的**一条真实线上 trace**，
它就是真实用户流量，只是发现方式是人工；而 `offline_run` 是离线重跑的产物，计入会让「×23」被灌水失去意义。

## 5. 决策 E —— 自动分诊不做主动检索探针

原型 `:371` 三条规则：

| 根因 | 原型判据 | B2a 实现 |
|---|---|---|
| `missing` 缺内容 | 检索 top 分极低 + 精确率低 | 可信度低 **且** 精确率低 |
| `retrieval` 检索问题 | 库内存在相似内容（以缺口问题检索能命中高分） | 精确率低但可信度不低；**或**簇 `follow_up_ratio > 0.5`（决策 F） |
| `generation` 生成问题 | 精确率高 + 忠实度低 | 精确率高 且 忠实度低 |

**不做主动探针的理由**：原型的 `retrieval` 判据要求「拿缺口问题去检索看能否命中高分」——
那需要 `gaps → retrieval` **外加** `gaps → applications`（解析用哪个 KB）两条新边、每条候选一次检索，
只为一个**人工可下拉改判**的字段（原型 `:371` 明写可改判）。B2a 用记录信号首判 + 人工改判，成本收益明显更好。
B2b 做 [补知识库] 时探针才真正值钱（它决定要不要往 KB 里塞内容）。

**分诊是簇级属性，两列而非一列**：`root_cause_auto`（worker 写）+ `root_cause_manual`（人写），
读取一律 `COALESCE(root_cause_manual, root_cause_auto)`，**worker 永不覆盖人工判定**。
单列方案在人工改判后会丢失 auto 值，「worker 现在会怎么判」不可回答，且「人工改过」与「自动又变了」不可区分。

## 6. 决策 F —— 用**改写后的问题**做聚类键与 gold 问题（缺口 23 的结构性免疫）

`018 §12.x` 缺口 23：多轮指代型追问（「有没有更细致的操作」「那么之前说的…怎么排」）未被改写节点消解
⇒ 检索召回全是无关片段 ⇒ 精确率 0 ⇒ 兜底/拒答。这类样本会**大量**涌进问题池，且形态与「真的缺内容」完全一样。

### 6.1 按原文入池的两处危害

1. **聚类塌陷**：指代型追问去掉上下文后几乎没有主题信息，embedding 被句式（「还有…需要注意什么」）主导
   ⇒ 不同主题的追问全部并进同一个簇，代表问题/频次/分诊全失去意义。
2. **污染 gold 题库（更严重）**：`runForEvaluation` **不传 convId**（`orchestration.service.ts:518-521`）
   ⇒ `loadHistory` 拿到空历史 ⇒ **离线 run 的每条用例都是无上下文独立重放**。
   把指代原文沉淀成 gold 用例，那条用例**永远不可能被答对**——不是模型不行，是题目缺信息。
   它会在此后每次 run 稳定拿 0 分，拖低综合分并让屏4 版本对比失真。
   **评测集是飞轮里唯一要能信的东西，不能被这样污染。**

### 6.2 改写后的问题是拿得到的

rewrite 节点产出 `rewrittenQuery`（`orchestration.service.ts` 的 rewrite 节点调用），
而 `codecrush_trace_spans` 视图**已把每个 span 的完整 `SpanAttributes` 投影为 `attributes` 列**
（`001-trace-views.sql:2-14`）⇒ **不需要新建任何视图**，按 `trace_id` join 取 rewrite 那条 span 即可。

> ⚠️ **实现时订正（B2a，用户 2026-07-19 裁决）**：本节初稿说从
> `attributes['codecrush.io.output']` 解 JSON 取 `rewrittenQuery`——**那条路是死的**。
> `codecrush.io.output` 只打在 chain 根 span 与 `rag.eval` span 上，
> 真库实测 198 条 rewrite span **0 条**带它。照初稿实现的话 `rewrittenQuestion` 恒为 null，
> 决策 G 的三个用途全部失效且有反效果（聚类键退回原文、入集守卫拦下所有多轮问题、
> `follow_up_ratio` 虚高）。
>
> ⇒ 已在 chat 编排的 rewrite 节点补 `spanEnrich`，发一等属性
> **`rag.rewrite.query`**（`RAG.REWRITE_QUERY`），与 intent 节点的既有做法同款；
> 读侧直接取该属性，不解 JSON。`setAttribute` 是内存操作，不增延迟、不会让问答失败，
> 不违反「埋点绝不进入问答关键路径」。
>
> **历史数据**：埋点是 B2a 才加的，此前 trace 无该属性 ⇒ 取空 ⇒ 按「指代未消解」处理。
> 这是安全默认——宁可标记为待人工改写，也不要把答不对的题沉淀进 gold。

### 6.3 `rewrite_resolved`：一个布尔，两处用途

**判定**：`rewrite_resolved = false` 当且仅当 ①该 trace 非首轮（`session_id` 非空且同 session 有更早 trace）
**且** ②`normalize(rewrittenQuery) === normalize(rawQuery)`。
`normalize` = trim + 折叠空白 + 去尾部标点，**精确比较，不用模糊阈值**。

精确比较就够，因为 `orchestration.service.ts:662` 注释写明「rewrite：**降级时契约 fallback 已回填原 query**」——
改写节点降级时 `rewrittenQuery` 字面等于原 query。

**用途一 · 聚类键**：`rewrite_resolved = true` → 用 `rewrittenQuery` 算 embedding 归簇；
`false` → 用原文。后者因句式相似会自然聚成同一个簇，UI 明确标注为「指代未消解」而不是伪装成某个主题——
**这个簇的频次恰好就是缺口 23 的规模度量**，是有用信息。

**用途二 · 入集守卫**：「从坏样本生成」第②步中，`rewrite_resolved = false` 的行标「指代未消解」，
**必须人工把问题改写成可独立检索的形式后才能勾选入集**；未改写的行禁止进入 `promote` 请求。
写进 gold 用例的问题一律是改写后的或人工改写后的，**绝不是指代原文**。

### 6.4 分诊硬规则（结构性免疫）

`follow_up_suspected = (rewrite_resolved === false) && context_precision <= 10`；
簇级 `follow_up_ratio = follow_up_suspected 数 / items 数`（分母只算 `source='online'`）。

**`follow_up_ratio > 0.5` 的簇，`root_cause_auto` 强制为 `retrieval`，永不判 `missing`。**

收益：B2b 的 [补知识库] 以 `root_cause = missing` 为前置守卫，此规则让这批被误诊的样本
**结构上走不到**「让 LLM 往知识库里写内容」那条不可逆路径。
**限定**：强制只作用于 `root_cause_auto`，人工仍可下拉改判（原型 `:371`）——它是默认值不是锁。

### 6.5 顺带解开 018 缺口 23 的一个待查项

`018 §12.x` 缺口 23 记着「待查：改写节点是否拿到了 `{history}`」。
本次调查已答：`executeNode(cfg.nodes.rewrite, "rewrite", { query, history }, ...)`（`orchestration.service.ts:663-666`）
——**history 是传了的**。⇒ 缺口 23 不是「没给上下文」，而是「给了但没改写好」，排查方向应转向 rewrite 的 prompt 与节点契约。
**本波不修它**，只做可见性与守卫。

## 7. 决策 G —— gold 要点指引（缺口 26）

`018 §12.x` 缺口 26：gold 要点「该多全」缺指引，用户按「教材说过什么」写了 15 条覆盖整节课，
导致一个质量良好的答案正确率仅 33。

本波正在造 gold 生产线，**不在生产线上贴这条引导等于批量制造缺口 26**。故：
- 「从坏样本生成」第②步顶部常驻 `Alert`：「gold 要点 = 一个好答案**必须**包含什么，不是资料里**说过**什么。建议 3–5 条」。
- LLM 草拟 prompt 硬约束「3–5 条必须包含的要点」。
- 草拟输入**只吃问题文本 + 该 trace 的原答案**，不吃召回片段正文（`gaps` 不依赖 `chunks`）——
  gold 要点是「答案该包含什么」，本就不需要原始片段。将来若要吃 chunk 正文即是 `gaps → chunks` 新边，届时改本文。

## 8. 决策 H —— PG Schema（3 表，迁移 0026）

均归 `gaps` 域，`schema.ts` 纯表定义、零 service 引用；跨域 id 只存 id、不建 FK。

| 表 | 职责 | 关键点 |
|---|---|---|
| `gap_clusters` | 缺口簇 | 代表问题、`centroid vector(1024)` + HNSW cosine 索引、`freq` 累计、`status`、`root_cause_auto`/`root_cause_manual`、`entered_eval_set_at`（叠加标志非状态）、软删 |
| `gap_items` | 簇内真实问题 | `source` 三值、`source_trace_id`（无 FK，跨存储）、原文 `question` + `rewritten_question` + `rewrite_resolved`、`embedding`、分数与信号快照、`follow_up_suspected`；**`source_trace_id` 全局唯一**（见下） |

| `gap_watermarks` | 收集器游标 | 照 `eval_watermarks`（`evaluations/schema.ts:53-73`）形状：双键游标 + 租约 + 健康度 + `last_cursor_move_at` |

**收集器绝不写** `eval_watermarks` / `eval_candidate_ledger`——那是 `evaluations` 域资产（B1 波的手动评分作业就是因这条走了独立表）。

### 幂等键为什么是 `source_trace_id` 单列

而不是 `(cluster_id, source, source_trace_id)`——B2a peer review 抓出的数据完整性洞，实现时已订正：

- 含 `cluster_id` 只能保证**同簇内**幂等。真实的崩溃重跑路径是：worker 插入 item 并 `freq++` 后、
  推进 `gap_watermarks` 游标**之前**崩溃；重跑时该簇 centroid 已被其他 item 的增量平均挪动，
  同一条 trace 的最近簇变成了**另一个簇** ⇒ 唯一索引不冲突 ⇒ 两簇各留一行、各 `freq+1`。
  而 `freq` 按设计「只增不减」，这种重复计数**没有自愈路径**。
- 含 `source` 同理：一条 trace 被 worker 自动收过、人又从 Trace 详情手动加一次，同样双计。
- 全局唯一还**正好实现原型 `:648` 要的行为**：手动入池时命中唯一冲突即返回
  「已在缺口『…』(×N) 中 · 查看」，而不是再插一行。

⇒ 语义确定为「**一条 trace 全局只入池一次**」。`gaps.db.spec.ts` 用跨簇、跨来源两条用例钉死。

> 拆分/合并不受影响：它们改的是 `cluster_id`（UPDATE），不是插新行。

**状态机 CHECK 的前向兼容**：`status` 用 `varchar` + CHECK，本波只放行**可达的三态**
`pending | routed_retrieval | ignored`。按本仓既定约定（`eval-runs/schema.ts:173-175`：「放行一个引擎不遵守的值 = 投机…W2b 实现时 ALTER 此 CHECK」），
**B2b 加四态时 `ALTER` 该 CHECK**。用 `varchar`+CHECK 而非 PG `enum` 正为此：ALTER CHECK 无需改类型、不锁表重写。

## 9. 缺口状态机（B2b 后全量七态，穷举）

```
（worker 建簇）──► pending「待处理」

── 用户触发（有 HTTP 端点）────────────────────────────────────────────
pending          ──[修检索参数]──►  routed_retrieval「已转检索工单」（跳应用配置带 ?fromGap=id）
pending          ──[补知识库]────►  drafting「草拟中」
drafting/reviewing ──[取消补库]──►  pending（**保留**草稿）
pending          ──[继续编辑]────►  reviewing（resumeDraft：拿回保留的草稿，**不调模型**；
                                    守卫 fill_draft_question/answer 均非空，否则 400）
除 ignored 外任意态 ──[忽略]────►  ignored「已忽略」
                                    （from = pending, routed_retrieval, drafting, reviewing, filled, verified）
ignored          ──[恢复]────────►  pending
任意态           ──[进评测集]────►  状态不变 + entered_eval_set_at 置位（叠加标志，非排他状态）

── 系统触发（无端点，由 GapFillService / GapVerificationNotifier / 收集器驱动）──
drafting  ──[LLM 草拟成功]──►  reviewing「待人审」
reviewing ──[人审确认入库]──►  filled「已入库，待回验」（CAS 抢占，**先于**上传）
filled    ──[登记文档 id]───►  filled                       （attachFillDocument：**自环**，
                                 不改状态；存在的唯一理由是继续吃 `WHERE status=expected` 的 CAS，
                                 上传那几秒里簇若被推走，补写应当落空）
filled    ──[回验 ≥80]──────►  verified「已回验✓」          （写 verified_score）
filled    ──[回验 <80]──────►  pending                      （写 verified_score + 置复发标）
filled    ──[文档入库失败]──►  pending                      （verifyIngestFailed：**不**置复发标）
filled    ──[判分未得出]────►  pending                      （verifyInconclusive：**不**置复发标）
ignored/verified ──[7天内新增≥5条相似]──► pending           （worker 复发重开，置复发标）
```

> 「除 ignored 外任意态」这个措辞是**刻意**的：`verified` 也在 `ignore` 的 from 集合里，
> 而决策 M 又把 `verified` 算作「已终结」。两者不矛盾——「终结」指的是**复发窗口的锚点**
> （`terminal_at` 从那一刻起算），不是「不能再操作」。已回验的簇当然还能被忽略。
> 本条曾写成「非终态 ──[忽略]──►」，与括号里的 from 集合自相矛盾（复审抓出）。

两条原型未写、B2a 显式补全的迁移，理由同构——**无出口的状态是死态，一次误点即永久占位**：
- `ignored → pending`（恢复）：原型没给「误忽略了怎么办」的回路。
- `routed_retrieval → ignored`：转了检索工单的缺口后来被判定不值得追。

**B2b 把同一条推理用在了 `filled` 上**：回验的**每一个**分支都必须把簇推离 `filled`。该态没有任何用户可触发的出口（只剩「忽略」），若某条分支不写状态，簇就永久停在一个没人会再管的位置，而系统事件（文档终态广播）已经发生过、不会重来。这直接决定了下面两条的存在：

- **`verifyIngestFailed` 与 `verifyFail` 必须分开**（peer review 抓出）：文档自己没解析成 ≠「补库后仍低分」。两者都回 `pending`，但只有后者置复发标，UI 文案也不同（「文档处理失败，可重新提交」vs「补库后仍低分(62)，建议检查检索配置」）。混在一个红点里，运营无法分辨「该换个文档格式重投」还是「该重新查这个缺口」。
- **`verifyInconclusive`（实现期新增，spec 无）**：判官不可用/重放无结果时**没测出分数**，而不是「测出来很低」。绝不能假装通过——「已回验✓」是给人看的信任凭据；但也不能置复发标，否则「判官 API key 过期」这一件事会显示成「这批缺口全都复发了」。spec 原本规定此情形按 `verifyFail` 处理，实现时按同一条「不要把基础设施故障说成业务结论」的推理改掉了，理由与上一条同构。

非法迁移一律 400，`gaps.service.spec.ts` 按行断言（含非法迁移被拒）。`TRANSITIONS` 是**穷举常量表**，新增状态必须同批改 CHECK 约束、契约枚举与该表三处，否则 CHECK 会在运行时把一个类型系统认为合法的迁移打回。

## 9b. B2b 决策 I–N（补知识库向导 / 自动回验 / B2a 降级收口）

### 决策 I —— 新增两条允许依赖边

决策 A 的「允许边穷举」写于 B2a，当时 [补知识库] 明确不在范围内，故没为它留位置。B2b 起穷举表**追加两条出边**：

```
gaps ──► documents        （写：把人审后的 Q&A 合成文档，走现有 upload 管线）
  └────► knowledge-bases  （只读：入库前校验目标 KB status === 'ready'）
```

论证结构与决策 A 论 `gaps → eval-runs` 同构：**批量/受控写入必须在服务端一处完成**，前端没有能力做「校验 KB ready → 拼文档 → 触发管线」这一整套编排。**反向依赖依旧禁止**（Boundary ⑤ 管的是「谁不能 import gaps」，不涉及 gaps 的出边，规则本身无需改）。

回验的完成通知走**平台层**、不算新域边：`gaps → platform/events`（`DocumentChangeNotifier`，与 `eval-runs` 的 `GoldStaleNotifier` 同模式）。

**合成文档格式**：`QaChunker`（`ingestion/adapters/chunkers/qa-chunker.ts`）识别 `问：`/`答：` 配对行逐对切片，未命中时自动退化为 `GeneralChunker`（不报错）。故人审确认的内容拼成 `问：{q}
答：{a}
`，以 `.txt` 走 `documentsService.upload(kbId, [file], { autoParse: true })`。选错 Profile 最坏情况是退化成通用切片，不是失败。

### 决策 J —— 状态机扩到七态

CHECK 追加四值（`drafting/reviewing/filled/verified`），迁移 0028。见 §9 的全量状态机。

**三处必须同批改**：`schema.ts` 的 CHECK、`packages/contracts` 的 `GAP_CLUSTER_STATUSES`、`gaps.service.ts` 的 `TRANSITIONS`。

**草稿保留的出口是 `resumeDraft`（`pending → reviewing`）**。取消补库时 `fill_draft_*` 保留，
下次打开向导第①步的**主按钮**是「继续编辑上次草稿」（走 `POST :id/resume-fill`，不调模型），
「重新草拟」降为次要按钮并在 Tooltip 里说明它会覆盖。

> ⚠️ B2b 初版**只做了保留、没做出口**：草稿确实留在库里，但没有 `pending → reviewing` 迁移，
> 向导步骤由后端状态驱动 ⇒ `pending` 恒等于第①步，唯一按钮是「重新草拟」，
> 点下去发起一次新的 LLM 调用并把保留的那份覆盖掉。**本条承诺的价值一次都没兑现过**，
> 由运行时 QA 抓出「文档承诺 ≠ 实现」。教训：写进设计文档的用户价值，
> 必须有一条端到端可达的路径，「数据存下来了」不等于「用户拿得到」。

### 决策 K —— 新增列与回验口径

`gap_clusters` 新增 9 列（迁移 0028，**全部 nullable、纯附加**）：`fill_draft_question`、`fill_draft_answer`、`fill_target_kb_id`、`fill_target_document_id`、`fill_verify_application_id`、`fill_verify_config_version_id`、`fill_pre_score`、`verified_score`、`recurred_at`。

**`fill_pre_score` 必须在 `startDraft` 那一刻快照，不能展示时现读 `avgQuality`**：后者是对 `gap_items` 的实时聚合，而向导从点击到回验完成可能跨越数分钟到下一个收集器周期（半小时一轮的 cron）。现读的话，「41→89」的左端会随新坏样本涌入静默漂移，那就不再是用户点按钮时真正看到的数字。

**回验用的应用/配置版本由前端提供**（向导第②步的必选下拉），后端只存两个 id、全程不读应用信息——**因此不新增 `gaps → applications` 边**。

**分数口径** = `LEAST(faithfulness, answerRelevancy, contextPrecision)`，与屏5 `avgQuality` 同源，这样「41→89」两端可比。**不掺 correctness**：补进知识库的是资料，不是 gold 要点，没有可比对的标准答案。实现上必须是「任一为 `null` 则结果为 `null`」，**不能用 `Math.min`**——它把 `null` 当 0，于是「裁判没评出忠实度」会被当成「忠实度 0 分」，一条本可能通过的回验被判成惨败。

**不建独立 `gap_fill_jobs` 表**：当前约束只有「一个簇同时至多一个进行中的补库流程」，加列比加表更符合本文档「不要投机」的既定原则（同决策 H 对 `gap_watermarks` 的取舍）。未来若要支持「同一簇多次补库并保留历史」才值得拆表。

### 决策 L —— `eval_run_results.ignored_at`（屏3 逐 case 标记忽略）

纯附加 nullable 列。叠加标志而非排他状态（同 `entered_eval_set_at` 的既定风格）：忽略的行保留原 `verdict`，只是默认视图排除。**不加 `ignored_by`**——单 admin 系统无需 actor 归属。

### 决策 M —— 「复发」角标

`recurred_at` 非空即在屏5 显示红色「复发」标。**两个来源**：回验没通过（`verifyFail`），或已终结的簇（`ignored`/`verified`）在窗口内又攒够新样本。

**清除时机**（原型未定义，本文档补充）：用户下一次主动推进该簇状态时清空——`startDraft`/`routeRetrieval`/`ignore` 触发，语义是「人已经看到这次复发并采取了行动」。**`reopen` 不清除**：那是独立的手动迁移，与复发判定无关。**不做**「N 天后自动清除」——原型没提，凭空加定时器语义不算实现原型。

> **窗口锚点必须是 `terminal_at`，不是滚动 7 天**（peer review 抓出，迁移 0029 补 `terminal_at` 列）。初版按「过去 7 天内新增 ≥5 条」判定，于是一个刚被忽略的热门簇会**被它自己忽略之前的历史立刻重开**——「忽略」变成一个无效操作，而用户完全不知道为什么。窗口必须从簇**进入终态的那一刻**起算。

### 决策 N —— `promote` 原子事务（B2a 降级收口之一）

B2a 的「进评测集」分两次写（建 case + 标 `entered_eval_set_at`），中间崩溃会留下不一致，当时用 `PartialPromoteError` 把这个状态**报告**给用户。B2b 改为**跨域共享一个数据库事务**——本仓首次出现该模式：`Tx` 类型集中定义在 `platform/persistence/persistence.module.ts`，由调用方开启事务并把 `tx` 透传给两个域的 repository 方法。`PartialPromoteError` 随之移除。

另两项降级同批收口：**簇 centroid 增量平均改 CAS**（`WHERE freq = expectedFreq`，冲突重试一次；原先并发入池会丢更新），**入集重复检测补上 embedding 语义近似**（原先只做精确文本匹配，换个说法的同一个问题会重复进评测集）。

## 10. 增量聚类

原型 `:379`「embedding 余弦 ≥0.85 归簇（常量起步）；聚类只增量不全量重算」。

每条新坏样本 → 取聚类键（决策 F）的 embedding → pgvector 最近邻（`ORDER BY centroid <=> $1 LIMIT 1`）→
`1 - distance >= 0.85` 归入该簇（`freq+1`、centroid 增量平均 `(c*f+v)/(f+1)`、`last_seen_at` 更新），否则建新簇。
阈值落 `gap.constants.ts` 具名常量，不散写字面量。

**已终结簇的重复流入**：B2a 可达状态里只有 `ignored` 属已终结——再收到相似问题**频次 +1 但不重开**。
**B2b 起补上原型 `:376` 的自动重开**：`ignored`/`verified` 两个终态，在**进入终态之后**（锚点 `terminal_at`，见决策 M）的 7 天窗口内新增 ≥5 条相似 item ⇒ 重开为 `pending` 并置复发标。仅 worker 的 `ingest` 路径触发，`GapsService.addItem` 手动入池不触发（原型明写「(worker)」）。

**拆分/合并**：原型 `:366`/`:632` 明确其用途是「**纠正聚类错误**」——产品设计从一开始就假设机器会聚错。
拆分时新簇 centroid **按被选条目向量重新算平均**（不继承旧值）；合并后源簇若清空则**软删**（留痕，因「已进评测集」的关联要保留）。

## 11. 已知取舍 / 缺口

1. **入池阈值与聚类阈值是常量，不是设置表**。原型 `:378` 写「可配」，但 §17.5（`:627-637`）的组件清单里**没有设置抽屉**
   ——加一张只有一行、UI 摸不到的设置表是投机。B2b 若加设置面板再建表。
2. **屏5「平均质量」列原型从未定义**。本文裁定 = 簇内各 item 的 `min(三个非空指标)` 的均值，
   与 `evaluations.service.ts:508-512` 同源。**此值为设计补充，非原型推导**。
3. **手动入池的 item 不参与 `follow_up_ratio` 统计**（分母只算 `source='online'`）：
   手动入池是人主动挑的样本，本就不该参与「这簇是不是指代追问」的自动判定。
4. **依赖方向的强制力有限，且文档此前失实**。`AGENTS.md`「依赖边界」与 `003` 旧的「依赖规则 = lint 规则」一节曾称模块边界由 ESLint 强制——
   **实测 `eslint-plugin-boundaries` / `eslint-plugin-import` 根本没安装**（`package.json`），
   `eslint.config.mjs` 只有 4 个包级 `no-restricted-imports` 块（前端 / contracts / otel-conventions / otel），
   且**全是黑名单**——只列了几个禁止项，**不等于**对应的不变量。
   本波新增 **Boundary ⑤**（ESLint 核心规则、零新依赖）机械强制**「`apps/backend/src` 下除三个聚合根（gaps 域自身、`app.module.ts`、`db/schema.ts`）外，无人 import `gaps`」**，
   并订正上述失实表述。**它不是通用模块 DAG 强制器**（那需要 `eslint-plugin-boundaries`）；
   尤其注意「跨域只走 barrel、禁止直接 import `adapters/`」**完全没有** lint 兜底，
   而「共享包只依赖 zod」也只是部分兜底（`packages/contracts` 里 `import "pg"` 当前是绿的）。
   规则字面禁掉了什么，见 `003`「依赖规则的真实强制力」与 `AGENTS.md`「依赖边界」的规则表
   （那两处只陈述事实，**不做**逐条覆盖度判定）。

   > **Boundary ⑤ 的匹配写法有坑**（第一版踩过，peer review 抓出）：`no-restricted-imports` 的 `group`
   > 走 gitignore 式匹配，`"../gaps/*"` **只匹配深度恰为 1 的相对路径**（`../../gaps/x` 会漏），
   > 而 `"**/modules/gaps/*"` 对相对 import **根本不匹配**（import 字符串里没有 `modules/` 段）。
   > 必须写成 `["**/gaps", "**/gaps/**"]`。验证反向规则时**务必覆盖多个目录深度**——
   > 第一版的验证只植入了深度 1 的反例，恰好落在唯一能拦住的形态上，因此误判通过。
5. **rewrite 结果目前靠解 JSON 取**。更干净的做法是让 chat 把 `rewrittenQuery` 提升为一等 span 属性
   （零延迟、不违反「埋点绝不进关键路径」），但那要动 `chat` 与 `otel-conventions`，超出 B2a。
   **Revisit 触发条件**：若 JSON 解析在真实数据上被证明脆弱（rewrite 节点 output 结构变更），即提升为一等属性。
6. **热门问题聚类可复用本域的聚类纯函数**。`002:165`/`006:103` 早就规划了看板「热门问题」，
   `016:44`/`016:230` 因「需聚类」延后——本波正是那个能力。
   **给 M10 的提示**：不要再造第二套聚类器；且若上全量聚类，正确形状多半是
   **全量问题簇做底座、问题池是「其中含坏样本的簇」的视图**，并顺带获得「失败率 = 坏样本数 / 总提问数」的分母
   （当前设计只有分子，无法区分「23/25 系统性坏掉」与「23/2000 长尾噪声」）。届时 `gap_clusters` 是被吸收还是并存需一次决策。

7. ⛔ **回验的结论可能与可观测事实相反，且低分时无法归因**（B2b 上线后**真环境实测**发现，2026-07-21）。

   **实测经过**：用户在自己的知识库上走完整条臂一（草拟→人审→入库→文档 ready→自动回验），
   簇被判 **62 分**（<80）⇒ 退回 `pending` + 打红色「复发」标。
   **但用户随后重新提问，检索命中了新补的内容、回答是对的**（主观判断，未走判官）。
   ⇒ 系统告诉运营「这个缺口又回来了」，而实际上这次补库是**成功的**。

   ### ⚠️ 根因订正（同日晚，已修复并实测闭环）

   **本条最初把根因写成「`ctxprec` 恒 0（缺口 23）+ 三取最小」——那个判断是错的**，
   订正如下。之所以完整保留错误结论与推翻它的过程，是因为「诊断连错两次」本身
   比结论更值得下一波读到。

   **真正的根因**：手动入池时**把 rewrite 的结果扔了**。
   `GapsService.addItem` 硬编码 `rewrittenQuestion: null` / `rewriteResolved: false`，
   注释写「手动入池不经 rewrite 节点」——那句是错的：`manual_trace` 是人从 Trace 详情挑的
   **一条真实线上 trace**，它当然走过 rewrite 节点，结果就在 span 属性 `rag.rewrite.query` 里
   躺着（真库实测：那条「下属来要求涨薪」的改写结果是
   「如何回应下属的加薪请求？结合薪酬管理、公平理论、期望理论…」，完全可独立检索）。

   丢掉它引发四件事连锁：① 样本被误标「指代未消解」；② 评测臂强制人再改写一遍；
   ③ 决策 F 的聚类键退回原文；④ **回验拿那句带指代的原话去重放** ⇒ 检索本就召不回
   ⇒ `ctxprec` 为 0 ⇒ 三取最小把分数拖死 ⇒ 假的「复发」标。

   ⇒ 所谓「`ctxprec` 恒 0」**是这个 bug 的症状，不是原因**。缺口 23（rewrite 真的失败）
   确实存在，但**不是**卡住 B2b 闭环的那个东西。

   **修复后同日实测闭环**（首次）：同样的流程，补库 → 自动回验判 **88 分** ⇒ `verified`、
   不打复发标、`terminal_at` 正确落库；该缺口沉淀成 gold 用例后跑离线评测，
   **Context Precision / Recall / 命中率@5 全部 100**，判定通过。
   两套独立口径（回验的三取最小、离线评测的分层指标）得出同一结论。

   > 因此**「三取最小」这个口径本身没有被证伪**：它在输入正确时工作良好。
   > 但下面 ①② 两条修法依然成立——它们防的是「分数不可信时不要给业务结论」，
   > 与根因是什么无关。

   **仍然建议做**：① `gap_clusters` 加三列存回验明细，低分时让人看得见是哪一项拖的
   （本次能查清全靠直接翻 ClickHouse，运营没有这个能力）；
   ② 任一指标为 0/未评时走 `verifyInconclusive` 而非 `verifyFail`（**不打复发标**）——
   与本波「基础设施故障不该说成业务结论」的推理同构。缺口 23 真的发生时，这条是唯一的防线。

   > **~~③ 缺口 23 应当提级~~**：**撤回**。提级的理由是「它卡死了 B2b 闭环」，
   > 而实测证明卡住闭环的是上面那个数据流 bug，不是它。缺口 23 仍是真实缺陷，
   > 但维持 `018` 原有的「慢慢修」定级。

   > **为什么没被任何测试或复审抓到**：单测与 db 测试都喂**构造的分数**（89 / 62），
   > 验的是「分数≥80 走哪条分支」——这层逻辑是对的。**没有任何一层去问「这个分数本身可不可信」**。
   > QA 跑到了真实的 72 分，却把它当作「补的内容不够好」接受了。
   > 端到端测试验了「管道通不通」，没验「流过去的东西对不对」。
   >
   > 同理，`gaps.e2e.spec.ts` 的 embedding 桩**对所有文本返回同一个向量**，
   > 于是「聚类键用了哪段文本」这件事在测试里根本区分不出来、断言恒真——
   > 那正是聚类键漂移（收集器用改写后、手动入池用原话）能长期潜伏的原因。
   > 修复时一并改造了桩（`embedByText` 让两条原话正交）。
   > **教训：桩把输入抹平到分不出对错时，它守的就只是「没抛异常」。**

   > **诊断连错两次的复盘**（比结论更值得记）：
   > 第一次说「补的内容不够好」——被用户实测推翻（检索命中、回答正确）；
   > 第二次说「根因是缺口 23 导致 ctxprec 恒 0」——被自己的进一步查证推翻
   > （改写其实成功了，是入池时扔的）。
   > 两次都**从观测到的现象直接跳到了最近的已知缺陷**，而没有先问
   > 「这个现象的上游是什么、那一段的数据长什么样」。
   > 真正解决问题的一步，是用户贴出「进评测集」弹窗里那句
   > 「离线评测无对话上下文，指代原文永远答不对」——
   > 那说明**系统自己早就知道这类问题不能直接用**，而另一条臂却在拿它算分。
   > 两条臂对同一个信号的处置自相矛盾，才是该顺着查下去的线头。

8. **回验没有「只重跑、不重新入库」的路径**（B2b 新增）。`DocumentChangeNotifier` 的终态事件只广播一次；若那一次判分因判官服务瞬时故障没得出分数，簇走 `verifyInconclusive` 回 `pending`（不打复发标），用户要重新走一遍向导——**新文档、新入库**——才能再触发一次真实回验。
   **为什么本波不加「重试回验」按钮**：原型没有这个交互，且它会与 `verifyIngestFailed` 的「可重新提交」路径形成两套相似但不同的重试入口，增加认知负担。
   **Revisit 触发条件**：若判官瞬时故障在真实运行中被证明常见（观察 `GapVerificationService` 的 `回验未能得出分数` 日志频次），即加一个只重放不入库的端点——数据上是齐的（`fill_target_document_id`/`fill_verify_*` 都还在），只差一个入口。

9. **补库向导曾因 state 跨簇存活而可把「簇 A 的问答提交进簇 B」**（B2b 第三轮 peer review 抓出，已修）。
   已实测复现过两条路径：① 打开时不清内容 + 新簇草稿拉取失败 ⇒ 屏上仍是 A 的内容且可提交；② 慢的 A 响应在切到 B 之后落地 ⇒ 覆盖 B。

   **结构性修法在 `GapsPage`**：`<GapFillWizard key={fillClusterId} …/>`。key 变化即卸载重建，
   跨簇 state 存活在物理上不可能。组件内另有三道手写防线（打开时清空 / `load` 丢弃陈旧响应 /
   渲染前校验 `draft.clusterId === clusterId`），**保留作纵深防御**——成本近乎为零，
   且能挡住未来有人误删这个 key。

   > ⚠️ **本条曾写成「三道防线互为冗余，任意一道单独存在都够用」——那是错的**，
   > 独立复审用实测证伪：只留第二道（陈旧响应守卫）时，「换簇后 load 失败」立即变红，
   > 簇 A 的问答连同可点的「确认入库」一起出现在簇 B 上。
   > 准确的说法是：**只有第三道（`draftFresh`）单独充分**；第一道只覆盖「打开时残留」，
   > 第二道只覆盖「陈旧响应」，各自都有对方才能挡的那条路径。
   > 删任何一道之前先想清楚它覆盖的是哪条路径，别依据「反正冗余」。

   > 陈旧响应守卫**必须比 ref 里的当前簇，不能比闭包捕获的 `clusterId`**——后者在自己的闭包里恒等于响应的 `clusterId`，守卫永远成立、等于没写。第一版就是这么错的，还被一条同样有缺陷的测试「验证」通过。

   > 加了 key 之后，三道防线在**单个组件实例内**其实都不可达（实例内 `clusterId` 恒定），
   > 即当前是「死代码」。这是刻意的：它们是 key 被误删时的保险。
   > 但也因此**没有测试能单独钉住 `draftFresh`**（改成 `draft !== null` 时 18 条全绿）——
   > 复审已记录，属已知的覆盖缺口。

## References

- 路线图与波次进度：`002-implementation-roadmap`
- 代码组织与依赖边界：`003-code-organization`
- 在线答案质量（E-W1）：`017-online-answer-quality`
- 离线评测 run 与评测集（E-W2a，含 §12.x 缺口 23–26）：`018-offline-eval-runs`
- 产品权威：`docs/design/assets/eval-flywheel-product-design.html` §9 / §10 / §17.5 / §18.C
