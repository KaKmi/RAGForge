---
title: "知识缺口 / 问题池域（E-W4 B2a）"
description: "坏样本自动入池、增量 embedding 聚类、根因分诊与缺口状态机；新建 gaps 域作为 eval-runs 之上的新依赖顶点，并把坏样本批量沉淀为 gold 用例。"
category: "design"
number: "021"
status: draft
services: [backend, frontend, infra]
related: ["design/002", "design/003", "design/017", "design/018"]
last_modified: "2026-07-19"
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
| **B2b** | [补知识库] 三步人审向导（LLM 草拟 → 人审 → 走 ingestion 入库）；自动回验（入库后重放+评分、`41→89` 改善、7 天内 ≥5 条复发重开） | 待做 |

**切分依据**：① `002:54` 自述 B2 目标即「问题聚合 → 批量沉淀 gold」，正是评测飞轮臂；
② 原型 `:138` 明说这是**两个咬合的飞轮**（知识缺口飞轮补库 / 评测飞轮回归题库），共享同一批坏样本作起点——天然的切分缝；
③ 补库臂要动 KB 入库管线，且带一条产品红线「**无人审不入库**——LLM 编错答案会污染知识库且忠实度还显示满分」（`:367`），是独立的信任面。

⇒ 缺口状态机的 `草拟中 / 待人审 / 已入库 / 已回验` 四态**本波不可达**，见决策 H 的前向兼容要求。

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
`evaluations → eval-runs` 是**反向边**，直接违反 `003:335`「`evaluations` 与 `chat` 均不反向依赖 `eval-runs`」。
绕开只有两条路，都更差：① 前端逐条 POST（N 个请求、无事务、失败一半没法回滚，且重复检测要在前端跑 embedding，不可行）；
② 让 `eval-runs` 反过来 import gap 表——成环。

⇒ **需要同时驱动「读坏样本聚合」与「写 gold 用例」的编排关切，只能放在两者之上。**
这与 `018` 决策 A 对 `eval-runs` 自身的论证**结构完全同构**，是同一条推理的第二次应用。

### 为什么不加 `gaps → traces` 边

`gaps` 自建 `ClickHouseGapsRepository`，直接注入 `platform/clickhouse` 的 client。
**每个域持有自己的 CH read repository 是本仓既定模式**：`003:328` 明写「evaluations 与 traces 不直接 import；
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

rewrite 节点产出 `rewrittenQuery`（`orchestration.service.ts:663-670`），落在该节点自己的子 span 上；
而 `codecrush_trace_spans` 视图**已把每个 span 的完整 `SpanAttributes` 投影为 `attributes` 列**
（`001-trace-views.sql:2-14`）⇒ **不需要新建任何视图**，按 `trace_id` join、取 rewrite 节点那条 span 的
`attributes['codecrush.io.output']`（JSON，含 `rewrittenQuery`）即可。

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
| `gap_items` | 簇内真实问题 | `source` 三值、`source_trace_id`（无 FK，跨存储）、原文 `question` + `rewritten_question` + `rewrite_resolved`、`embedding`、分数与信号快照、`follow_up_suspected`；`(cluster_id, source, source_trace_id)` 唯一（worker 重跑幂等） |
| `gap_watermarks` | 收集器游标 | 照 `eval_watermarks`（`evaluations/schema.ts:53-73`）形状：双键游标 + 租约 + 健康度 + `last_cursor_move_at` |

**收集器绝不写** `eval_watermarks` / `eval_candidate_ledger`——那是 `evaluations` 域资产（B1 波的手动评分作业就是因这条走了独立表）。

**状态机 CHECK 的前向兼容**：`status` 用 `varchar` + CHECK，本波只放行**可达的三态**
`pending | routed_retrieval | ignored`。按本仓既定约定（`eval-runs/schema.ts:173-175`：「放行一个引擎不遵守的值 = 投机…W2b 实现时 ALTER 此 CHECK」），
**B2b 加四态时 `ALTER` 该 CHECK**。用 `varchar`+CHECK 而非 PG `enum` 正为此：ALTER CHECK 无需改类型、不锁表重写。

## 9. 缺口状态机（B2a 可达子集，穷举）

```
（worker 建簇）──► pending「待处理」
pending          ──[忽略]──►        ignored「已忽略」
pending          ──[修检索参数]──►  routed_retrieval「已转检索工单」（跳应用配置带 ?fromGap=id）
routed_retrieval ──[忽略]──►        ignored
ignored          ──[恢复]──►        pending
任意态           ──[进评测集]──►    状态不变 + entered_eval_set_at 置位（叠加标志，非排他状态）
```

两条原型未写、本文显式补全的迁移，理由同构——**无出口的状态是死态，一次误点即永久占位**：
- `ignored → pending`（恢复）：原型没给「误忽略了怎么办」的回路。
- `routed_retrieval → ignored`：转了检索工单的缺口后来被判定不值得追。

非法迁移一律 400，`gaps.service.spec.ts` 按行断言（含非法迁移被拒）。

## 10. 增量聚类

原型 `:379`「embedding 余弦 ≥0.85 归簇（常量起步）；聚类只增量不全量重算」。

每条新坏样本 → 取聚类键（决策 F）的 embedding → pgvector 最近邻（`ORDER BY centroid <=> $1 LIMIT 1`）→
`1 - distance >= 0.85` 归入该簇（`freq+1`、centroid 增量平均 `(c*f+v)/(f+1)`、`last_seen_at` 更新），否则建新簇。
阈值落 `gap.constants.ts` 具名常量，不散写字面量。

**已终结簇的重复流入**：本波可达状态里只有 `ignored` 属已终结——再收到相似问题**频次 +1 但不重开**。
（原型 `:376` 的「已回验后 7 天内 ≥5 条自动重开」依赖回验态，属 B2b。）

**拆分/合并**：原型 `:366`/`:632` 明确其用途是「**纠正聚类错误**」——产品设计从一开始就假设机器会聚错。
拆分时新簇 centroid **按被选条目向量重新算平均**（不继承旧值）；合并后源簇若清空则**软删**（留痕，因「已进评测集」的关联要保留）。

## 11. 已知取舍 / 缺口

1. **入池阈值与聚类阈值是常量，不是设置表**。原型 `:378` 写「可配」，但 §17.5（`:627-637`）的组件清单里**没有设置抽屉**
   ——加一张只有一行、UI 摸不到的设置表是投机。B2b 若加设置面板再建表。
2. **屏5「平均质量」列原型从未定义**。本文裁定 = 簇内各 item 的 `min(三个非空指标)` 的均值，
   与 `evaluations.service.ts:508-512` 同源。**此值为设计补充，非原型推导**。
3. **手动入池的 item 不参与 `follow_up_ratio` 统计**（分母只算 `source='online'`）：
   手动入池是人主动挑的样本，本就不该参与「这簇是不是指代追问」的自动判定。
4. **依赖方向的强制力有限，且文档此前失实**。`AGENTS.md:39` 与 `003:182/:240` 曾称模块边界由 ESLint 强制——
   **实测 `eslint-plugin-boundaries` / `eslint-plugin-import` 根本没安装**（`package.json`），
   `eslint.config.mjs` 只有 4 个包级 `no-restricted-imports` 块（前端 / contracts / otel-conventions / otel），
   且**全是黑名单**——只列了几个禁止项，**不等于**对应的不变量。
   本波新增 **Boundary ⑤**（ESLint 核心规则、零新依赖）机械强制**「无人 import `gaps`」这一条**，
   并订正上述失实表述。**它不是通用模块 DAG 强制器**（那需要 `eslint-plugin-boundaries`）；
   尤其注意「跨域只走 barrel、禁止直接 import `adapters/`」**完全没有** lint 兜底，
   而「共享包只依赖 zod」也只是部分兜底（`packages/contracts` 里 `import "pg"` 当前是绿的）。
   逐条强制力对照表见 `003`「依赖规则的真实强制力」与 `AGENTS.md`「依赖边界」。

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

## References

- 路线图与波次进度：`002-implementation-roadmap`
- 代码组织与依赖边界：`003-code-organization`
- 在线答案质量（E-W1）：`017-online-answer-quality`
- 离线评测 run 与评测集（E-W2a，含 §12.x 缺口 23–26）：`018-offline-eval-runs`
- 产品权威：`docs/design/assets/eval-flywheel-product-design.html` §9 / §10 / §17.5 / §18.C
