---
title: "离线评测 run 与评测集（E-W2a）"
description: "gold 题库 + 对指定配置版本发起离线 run（真实走编排产出 preview trace）+ 屏3 报告；结果存 Postgres 与在线 rag.eval 读模型物理隔离。"
category: "design"
number: "018"
status: draft
services: [backend, frontend]
related: ["design/002", "design/003", "design/013", "design/017"]
last_modified: "2026-07-16"
---

# 018 — 离线评测 run 与评测集（E-W2a）

E-W1（`017`）交付了**在线**答案质量评测：对真实流量抽样、reference-free 三指标、`rag.eval` span → ClickHouse 读模型 → 屏1 总览。它**测不了对错**（无 gold），也无法在上线前用固定题库回归。

E-W2a 补上离线闭环：**gold 题库（评测集）** + **发起 run（真实走一遍编排）** + **屏3 报告**。这是「改动敢上线」的地基（E-W3 版本对比、E-W4 问题池均依赖它）。

产品权威：`docs/design/assets/eval-flywheel-product-design.html` §5/§6/§7/§15/§18/§19。

## 1. 目标与边界

**IN（W2a）**

- 评测集 CRUD（软删）+ 用例的不可变版本 + CSV 导入。
- run 引擎：发起 / 停止 / 预算熔断 / 全局串行 / 1h 幂等。
- 屏3 报告：4 个指标（Faithfulness / Answer Relevancy / Context Precision 复用 E-W1 + 新增 Correctness）。

**OUT（W2b 及以后）**

- 重放、换版本并排、版本对比屏4（E-W3）、问题池（E-W4）。
- Trace 详情「加入评测集」按钮、「立即评测」端点、评分中/重试态。
- 检索层 gold-docs 指标：Context Recall / NDCG@5 / 命中率@5；生成层 Citation 指标。
- 每题重复 >1（原型 §6 有控件、§14 定义口径为「取均值」，W2a 默认值即 1 —— 见「已知缺口」3）。
- `gold_stale` 检测器（建列不建检测器）。
- 配置版本引用保护（原型 §6「被 run 引用的配置版本不可删」）。

## 2. 决策 A —— `eval-runs` 作为新依赖顶点

run 引擎需要同时驱动 **chat 编排** 与 **evaluations Judge**。三种方案：

| 方案 | 判断 |
|---|---|
| `evaluations` 直接 import `chat` | ❌ 违反 `AGENTS.md` 边界 1「chat 顶点」；把在线评测域与编排耦死 |
| 把 run 引擎塞进 `chat` | ❌ 污染编排内核；评测关切侵入问答模块 |
| **新模块 `eval-runs` 置于 chat 之上** | ✅ 图仍无环；chat / evaluations 互不感知；评测编排关切独立 |

**采纳**：`modules/eval-runs` 拥有 sets / cases / runs / results + run 引擎；依赖 `ChatModule`（编排）、`EvaluationsModule`（Judge）、`ApplicationsModule`（`resolveForTest`）。

依赖图（无环）：

```
eval-runs ──► chat ──► applications / retrieval / node-runtime / conversations / knowledge-bases
    └───────► evaluations ──► conversations / chunks / models
    └───────► applications
```

**唯一允许的新依赖方向**：`eval-runs → {chat, evaluations, applications}`。
**`evaluations` 不反向依赖 `eval-runs`**（保持 017 的域边界不变）；`chat` 不感知 `eval-runs`。

**导出面最小化**：`EvaluationsModule` 只导出 `EvaluationJudgeService` 一个服务，**不导出 4 个 evaluator**——「怎么判分」是 evaluations 的域知识，`eval-runs` 只拥有 run 生命周期。`ChatModule` 只新增导出 `OrchestrationService`。

**副作用（本文档同步修订）**：`AGENTS.md` 边界 1 的「chat(顶点)」表述 → 顶点变为 `eval-runs`，chat 仍是**问答**顶点；`003` 的模块依赖分层图与精确依赖边列表补一条 `eval-runs → chat / evaluations / applications`，并新增「E-W2a eval-runs 域边界」小节。

**Revisit 触发条件**：若将来出现第二个「同时驱动编排与判分」的消费者（如在线 A/B 引流器），应把 `runForEvaluation` 抽为 chat 拥有的端口（interface）由消费方 DI，而非让第二个模块也依赖 `chat` 具体类。

## 3. 决策 B —— run 结果存 Postgres，**绝不发 `rag.eval` span**

**这是本波最重要的隔离约束。**

ClickHouse MV **不按 preview / run 过滤**，只要 `SpanName='rag.eval' AND status='success'` 就进聚合：

- `infra/clickhouse/views/003-eval-views.sql:13-29`（`codecrush_eval_targets_mv`）——过滤条件只有 `SpanName = 'rag.eval'`。
- `clickhouse-evaluations.repository.ts:301-333`（`getOverview`）直读 `codecrush_eval_targets`，**无 preview 过滤**。
- `clickhouse-evaluations.repository.ts:276-299`（`getMinuteAggregates`）同上。
- 仅 `getByAgent`（`:335-351`）因 join `codecrush_traces WHERE preview = 0` 而免疫。

⇒ **若 run 结果发 `rag.eval` span，屏1 的三指标卡与趋势会立刻被离线分数污染。**

对照：候选侧安全——`listCandidates` 过滤 `WHERE t.preview = 0`（`:227`），故 run 产生的 preview trace 永不进在线评测候选集。

**采纳**：run 生命周期（进度/停止/预算）本就是控制面事务 → 结果存 Postgres。

- 屏3 报告读 PG；**ClickHouse 读模型与 017 基线零改动**（无需 DROP/CREATE MV，无历史数据迁移）。
- 每个 case 的 **preview trace 照常进 ClickHouse**（`rag.pipeline`，preview=true），结果行存其 `traceId` 供「trace」链接跳转。
- 守护网：`apps/backend/test/eval-run-isolation.spec.ts` —— 跑完一个离线 run 后断言 `getOverview()` 的 `sampleCount` 不变。

### chain 根 span 上的 `rag.eval.run_id`

原型 §6 明写「trace 标 `rag.preview='true'` + `rag.eval.run_id`」→ `packages/otel-conventions` 的 `RAG` 加 `EVAL_RUN_ID: "rag.eval.run_id"`，由 `runForEvaluation` 写到 `rag.pipeline` 根 span。

**污染安全性已验证**：MV 只消费 `SpanName = 'rag.eval'`（`003-eval-views.sql:25`），该属性写在 `rag.pipeline` span 上 → **不进 MV**。

> **注意区分两件事**：**给编排 trace 打 run 标记**（做，不进 MV）vs **发 `rag.eval` 评测 span**（不做，会进 MV）。

### ⚠️ 本设计**推翻**原型 §15 不变量 E2 的一处事实断言

原型 §15 E2 写：「评测/重放流量不污染线上统计：一律 `rag.preview='true'`，**现有 MV/VIEW 天然排除**」。

**这句话对 eval 读模型不成立。** `codecrush_eval_targets_mv` 的过滤条件里**没有 preview**（`003-eval-views.sql:25` 只有 `WHERE SpanName = 'rag.eval'`），`getOverview`/`getMinuteAggregates` 也不过滤 preview。即：**只标 preview 并不能让离线分数被排除**——标了 preview 的 `rag.eval` span 照样进屏1 聚合。

E2 的**目标**（评测流量不污染线上统计）我们完全采纳并强化；但它假设的**机制**（靠 preview 标记 + 现有 MV 天然排除）是错的。本设计改用**存储物理隔离**达成同一目标：离线分数根本不进 ClickHouse，存 PG。

> 后续会话若直接读原型 §15 E2 而未读本节，会误以为「标了 preview 就安全」，进而放心去发 `rag.eval` span —— **那会立刻污染屏1**。这是本波最危险的误解，故在此显式钉死。

（E2 对 **trace** 侧仍成立：`listCandidates` 确有 `WHERE t.preview = 0`（`:227`），`getByAgent` 经 join 也过滤了 —— 天然排除只在这两处为真。）

## 4. 决策 C —— 编排暴露 eval 专用入口（行为中性重构）

`chat/orchestration.service.ts`：

1. `PrepResult` 增字段 `hits: TaggedHit[]`（内部结构，additive，不进 SSE 契约）。三处返回点全带：reply 分支、检索层 fallback 分支、CHAT 短路分支。
2. 抽出 `private async *runWithConfig(agentId, cfg, query, convId?, userId?, opts?)`——现有 `run()` 自 `startManualSpan` 起的全部逻辑搬入，**零行为变化**。
3. `run(agentId, query, convId?, userId?)` = `resolvePublic(agentId)` → `yield* runWithConfig(agentId, cfg, ...)`（`opts` 省略 → 行为与今日逐字节一致）。`resolvePublic` 必须仍在**生成器体内、首个 `next()` 时触发**——`chat.controller.ts:52-53` 依赖它在写 SSE 头之前抛 404/403。
4. 新增 `runForEvaluation(cfg, query, opts)`：内部 drain `runWithConfig` 的生成器，收集 `{ traceId, replyText, hits, usage, isFallback, timedOut }`。
5. `ChatModule` 导出 `OrchestrationService`。

**`runForEvaluation` 向下传什么 agentId**：传 `cfg.applicationId`。这与下面「绝不可用 `cfg.applicationId` 替换」**不冲突**——那条禁令约束的是 `runWithConfig` 的**形参不得被删除或改由 cfg 推导**（否则线上 `run()` 路径的 IDOR 校验被破坏）；而 `runForEvaluation` 是**新的调用方**，它传什么值是它自己的事。此处安全的原因要写死：离线 run **不传 `convId`** → `resolveConvId` 在 `:563` 的 `if (!convId) return undefined` 处**短路返回**，根本走不到 `:566` 的归属校验；且 `persist` 已被 `opts.persist=false` 跳过，无写入归属。故此处传 `cfg.applicationId` 无害。

**`runWithConfig` 必须保留 `agentId` 首参**：relocated body 在 `prepare(agentId,…)`、`persistCtx`、日志与 `resolveConvId(agentId,…)` 都用它。**绝不可用 `cfg.applicationId` 替换**——`agentId` 可能是 slug，且用于会话归属 IDOR 校验（`conv.agentId !== agentId`）；替换会破坏跨应用会话防护，且既有测试因 fixture 里 `applicationId === agentId` 恰好重合而**抓不到**这个 divergence。

### 「chat 关键路径零改动」的口径（写死，防被当成违规）

指**线上问答行为零变化**——同一份代码路径、同一 SSE 事件序列、无新增同步等待。**不是**「chat 目录一行不能改」。本波是加性重构 + 一个 eval 专用只读入口，`AGENTS.md` 边界 7「埋点绝不进入问答关键路径」仍然满足（评测在独立 worker 进程内、由离线 run 触发）。

守护网：既有 chat/orchestration 测试原样通过。既有测试红 = 重构破坏行为 → 修代码，不改测试。

## 5. 决策 C-2 —— 离线 run 不落会话（`opts.persist = false`）

已核实：`persist()` 在**每条**完成路径都会调用（`orchestration.service.ts:283,306,314,338`），而 `conversations` 表**没有 preview/source 列**（`modules/conversations/schema.ts:17-24`）。若不抑制，一个 50 题的 run 会往会话表灌 50 行，与真实用户会话**不可区分**——污染会话列表与后续按会话口径的统计。

⇒ `runWithConfig` 增 `opts.persist?: boolean`（默认 `true`）；`runForEvaluation` 传 `false`。

- **不违反**「与线上完全同路径」（原型 §6）——该约束指**检索/生成**同路径；落库是持久化关切，不影响任何检索或生成行为。
- Judge 输入在进程内直接从 `runForEvaluation` 的返回值构造，**不依赖** `conversations.findEvaluationTurnByTraceId`，故跳过落库不影响判分。
- 「trace」链接仍可用：Trace 详情读 ClickHouse，问答原文在 span 的 `codecrush.io.input/output` 上（`:177,202`），与会话表无关。
- **代价**：eval trace 上没有 `session.id`（该属性来自 persist 返回的 convId——`:184`）。可接受：离线 run 本就不是用户会话。

## 6. 决策 D —— Correctness + `scoreOffline` 单指标隔离

### `scoreOffline` 绝不复用 `score()`

`EvaluationJudgeService.score()` 是**整体失败**语义——三个 `await` 顺序执行、无 try/catch，任一 evaluator 抛错整体 reject（`evaluation-judge.service.ts:15-29`）。且这是 `017:39` 明文规定的**在线不变式**（「任一 metric 仍失败则整条 evaluation 失败，不聚合部分分数」）——**是有意设计，不是 bug**。

离线要求相反（原型 §6：单指标失败重试 1 次，仍失败该指标记「未评」、**不记 0 分**、不拖累其余）。

⇒ `scoreOffline` **必须**对 4 个 evaluator 各自 `Promise.allSettled` + 独立处理；**`score()` 一行不动** → E-W1 在线不变式完整保留。

### CorrectnessEvaluator

- 位置：`evaluations/correctness.evaluator.ts`，复用 `evaluation-judge.utils`。
- 输入 `{question, answer, goldPoints[]}` → 逐要点判定 `hit | missing | contradicted` → `score = hits / points × 100`，evidence 为逐要点理由（对齐原型 §7「正确率显示 gold 要点比对(一致/缺失/矛盾)」）。
- `withJudgeRetry` 的 `metric` 形参**加性扩宽**为含 `"correctness"`。`MAX_ATTEMPTS = 2`（首次 + 重试一次）已满足原型 §6。
- `goldPoints` 为空则**不调**模型（`correctness: null`）——**这是防御性分支，正常 API 路径不可达**：`reviewed` 要求 gold 要点 ≥1（原型 §18.B 守卫），且只有 `reviewed` 用例进 run，故进入 run 的用例恒有 gold。保留该分支是为了让 `scoreOffline` 对任意输入都不崩，不是为了支撑某条产品路径。
  > 实际能产出 `correctness: null` 的**可达**路径只有一条：correctness 裁判调用失败（重试后仍败）→ 记 NULL 不记 0。E2E 已按可达路径覆盖（`eval-runs.e2e.spec.ts`），空 gold 分支由单测 `evaluation-judge-offline.spec.ts:55` 覆盖。

### 构造函数第 4 参必须 `@Optional()`

两个 E-W1 测试**正位**构造该 service 且只传 3 参（`evaluation-judge.spec.ts:30`、`evaluations.e2e.spec.ts:270-274`）。若第 4 参必需，这两个测试编译失败，直接违反「E-W1 测试原样通过」。⇒ `@Optional() private correctness?: CorrectnessEvaluator`，运行时 DI 正常注入。

### judgeVersion

**在线 `judgeVersion` 不变**（仍 `online-v1`）——017 §Judge 规定算法/prompt/模型/解析契约变化才升版本，这里在线算法一行没动。离线用独立 `offlineJudgeVersion`（默认 `offline-v1`）记在 run 行上。

## 7. 决策 E —— W2a 指标范围 4/8

原型 §7 屏3 展示 8 个指标：检索层 `Context Precision / Context Recall / NDCG@5 / 命中率@5`，生成层 `Faithfulness / Relevancy / Correctness / Citation`。

W2a 实现 **Faithfulness / Answer Relevancy / Context Precision（复用 E-W1）+ Correctness（gold 要点）**。

延到 W2b：`Context Recall / NDCG@5 / 命中率@5`（均需 **gold docs** 标注 + 排序真值）、`Citation`（需引用正确性判定）。

**理由**：① 任务书 IN 只写「三指标 + gold 对照指标」；② 这四个需要 gold docs 通路（检索选择器 UI + doc→chunk 映射）与新判分算法，量级等同再开一波；③ **原型自带缺 gold docs 的空态规则**——「检索层指标显示『—』并注『未标 gold docs』；记分卡该项旁标覆盖率」，W2a 直接落这个空态即为**原型合规**，不是欠账。

**关键**：`eval_case_versions.gold_doc_ids` 字段 W2a 就建好（可空），W2b 加指标时**无需迁移**。

## 8. 决策 F —— 路由改用产品文档路径

采纳原型 §5/§7 的路径：`/admin/eval/sets`、`/admin/eval/runs`、`/admin/eval/runs/:runId`。

**与 M2 骨架的路由变更**：仓库原有 `/admin/evalsets`、`/admin/evaluations`、`/admin/evaluations/:reportId`（M2 mock 占位页）→ 本波替换，**不保留重定向**（占位页无真实用户依赖）。

理由：① 飞轮设计文档是本功能的产品权威，且分波结构（E-W1/W2/W3/W4）本身就出自它；② **E-W1 先例**：屏1 落在 `/admin/quality`，与该文档 §4 逐字一致；③ 两页骨架本就整体重写，改路由边际成本≈0。

## 9. 决策 G —— token 计量是尽力而为

通路缺口（已核实）：

- `ChatResult.usage?` 是**可选**字段（`models/ports/model-provider.port.ts:47-50`）——provider 可能不回传。
- 原 evaluator **丢弃 usage**，只取 `response.content`（`faithfulness.evaluator.ts:36-53`）→ 本波补透传。
- 编排的 token 累计在 `ChainMetricsAccumulator` 内，只写进 span 属性（`orchestration.service.ts:113-118`）→ 本波经 `onUsage` 回调出进程。

**口径**：`tokens_used` = Σ(编排 usage + 各裁判 usage) 中**能拿到的部分**；provider 不回传时该项计 0。预算熔断按已知用量判定——即 usage 缺失时熔断会**偏松**，**绝不因此假装精确**。报告页 tooltip 需写明「token 用量为已知上报之和，部分 provider 不回传」。这是诚实的降级，不是缺陷。

## 10. PG Schema（5 表，全部归 `eval-runs` 域）

字段级约束全部取自原型 §19.1（表单校验）。

| 表 | 职责 | 关键点 |
|---|---|---|
| `eval_sets` | 评测集 | `name` 1-50 字；`lower(name)` 上的**部分**唯一索引（`WHERE deleted_at IS NULL`）→ 软删后名字可复用 |
| `eval_cases` | 用例**身份**（稳定 id） | `status`(draft/reviewed) 与 `deleted_at` 是**逻辑用例**属性，跨版本延续 |
| `eval_case_versions` | 用例内容的**不可变版本** | 保存即新版本，旧版本冻结供历史 run 引用；`(case_id, version)` 唯一 |
| `eval_runs` | run | `case_version_snapshot` jsonb 发起时快照；租约列；`application_id`/`config_version_id` **无 FK**（跨域只存 id） |
| `eval_run_results` | 逐用例结果 | 分数列**可空**；未跑到的用例**不写行** |

**两表（身份 + 版本）而非单表**的依据：原型 §18.B「`reviewed` --编辑保存--> `reviewed`(新版本 v+1)」——编辑已审用例后新版本**仍是 reviewed**（不回退 draft）。即 `status` 是逻辑用例的属性。单表方案需在每次生成新版本时**复制** status/deleted_at 到新行，产生跨行同步义务（漏复制 = 编辑后用例悄悄退出 run 候选集，是隐蔽 bug）。

**不变量**：

- 分数列可空且**只在真评出来时写**；裁判失败 / 超时 / 无 gold → NULL + `verdict` 标记，**绝不落 0**（防拉低均值——原型 §6 明文）。
- 聚合（记分卡）按**非空**样本算 avg，并回传各指标 `scoredCount/total` 覆盖率。
- 未跑到的用例**不写结果行**——报告按 `snapshot − 结果行` 推导 skipped（原型 §18.A「未跑用例标 skipped」），避免垃圾行与重跑清理。

## 11. run 状态机（原型 §18.A 逐字对齐）

`queued | running | done | partial | budget_stop | failed`

| 迁移 | 触发 |
|---|---|
| `queued → running` | worker 抢到租约**且在 `markRunning` 时仍持有它**（条件更新，见下）；全局同时最多 1 个 running |
| `running → done` | snapshot 全部处理完 |
| `running → partial` | `stop_requested_at` 被置 |
| `running → budget_stop` | `tokens_used >= token_budget` |
| `queued/running → failed` | 配置版本不可用；job 异常**重试 3 次**仍败；或**被回收器判定为僵尸/孤儿**（见缺口 11） |

- **租约是状态推进的唯一凭据（两条不变式，缺口 11 详述、真库钉死）**：
  **① 持有活租约的 run 永不被回收**（两条回收臂都以租约为免疫证据）；
  **② 失去租约的 worker 永不能把 run 写回 `running`**（`markRunning` 与 `renewLease` 同为条件更新
  `WHERE lease_owner = owner`，返回 false 即让位）。
  故 `queued → running` **不是**无条件迁移：`tryAcquireLease` 与 `markRunning` 之间隔着两次 DB
  往返，这个窗口里回收器可能已把该 run 判死并清空租约；无条件写会把 `failed` 复活成
  `running` + NULL 租约 —— 一个**两条回收臂都够不着**的终局（`NULL < ts` 求值为 NULL 而非 TRUE）
  → `findActiveRun` 恒返回它 → `POST /eval/runs` 恒 409。
- `queue.publish` 用 `retryLimit: 3`（原型 §18.A「重试 3 次」）——**不可照抄 E-W1 的 `retryLimit: 1`**。
- **停止守卫「≥1 用例完成」**：原型未定义 0 条完成时点停止的次态 → 本设计显式补全为 `partial` + `done_cases = 0` + 横幅「手动停止，已完成 0/N」（不新造状态）。

**用例判定**（原型 §7「用例判定 = 各指标最低档」）：在**非 NULL** 指标里取最低值 → `<60` = low、`60–79` = weak、`≥80` = pass。`correctness` 为 NULL（裁判失败；空 gold 分支不可达，见上）时不参与判定。**三个基础指标全为 NULL**（裁判全挂）→ `verdict = unscored`，不进 pass/weak/low 分母——此分支原型未写全，本设计显式补全。

## 12. 已知取舍 / 缺口

供后续会话查证，**不要当成"忘了做"**：

1. **preview trace 的质量面板显示 `unscored`** —— 分数在 PG 不在 CH，判分依据在屏3 抽屉看。原型 §7 说「trace」打开 preview trace 详情「完整链路+质量面板」：链路完整可看，判分依据走屏3。W2b 处理面板联动。
2. **超时口径偏离原型 §6**（本波唯一一处主动偏离产品权威，须知悉）—— 原型「成本熔断」行说编排超时「记 0 分并标『超时』」，「裁判失败」行说单指标裁判失败「记『未评』(不记 0 分，不拉低均值)」。本设计**两者统一记 NULL + `verdict` 标记**。

   诚实说明：这两条规则**并非自相矛盾**——它们针对不同失败模式，各自有道理：
   - 编排超时 = **系统没答出来**，是被测配置的真实缺陷 → 计 0 分让它拉低均值是"该罚"；
   - 裁判失败 = **量具坏了**，与被测配置无关 → 计 0 分是冤枉。

   仍统一为 NULL 的理由：`eval_run_results` 的分数列是**单一口径**的，同一列里混「0 = 真的很差」与「NULL = 没测出来」会让记分卡的 avg **不可解释**（看到 avg=45 无法判断是配置差还是裁判挂了一半）。取「没评出来就不进 avg」后，超时信息**不丢失**——`verdict=timeout` 列显性表达，覆盖率 `scoredCount/total` 显性表达占比。

   **已知代价**（W2b 需正视）：一个**每条都超时**的配置，会得到一个全 `unscored` 的 run，而不是一个"分数很低"的 run——记分卡上表现为覆盖率 0% 而非低分。屏3 必须让 `verdict=timeout` 的数量足够显眼，否则用户可能误读为"没测"而非"全崩"。若 W2b 认为超时该计入配置质量，正确做法是**加一个独立的「超时率」指标**（不污染现有分数列的口径），而不是回头往分数列写 0。
3. **每题重复 `repeat_count` 未做** —— 原型 §6 有「每题重复 1-5」控件。**聚合口径原型已定义**：§14「裁判稳定性」行明写「评测 run 可选『每题重复 N 次取均值』(默认 1，重要对比建议 3)」⇒ **取均值**，默认 1。W2a 不实现的理由**不是**「口径不明」，而是：① 原型默认值就是 1，不实现 = 默认行为，无信息损失；② 它与「范围（仅上次低分/按标签）」同属发起参数族，一并做才划算；③ 逐用例表是一行一用例（§7），加 repeat 维度要动 `eval_run_results` 的唯一索引（`(run_id, case_version_id)` → 需加 `repeat_index`），属 schema 变更。W2b 做时按 §14 的**取均值**口径加列，不要重新发明。
   > 修订记录（peer review，2026-07-16）：本条原写「多次重复如何聚合到一行原型未定义」——**该表述是错的**，§14 已定义。错误源自 spec.md:263 只查了 §5/§6/§7 未查 §14。已按原型订正。
4. **`gold_stale` 建列不建检测器** —— 该列恒 `false`，UI 不显示橙 tag。不做半个功能。
5. **配置版本引用保护未做**（原型 §6「被 run 引用的配置版本不可删」）—— 实现它需要 `applications` 反查 `eval_runs` = **反向依赖成环**。留 W2b 用注册式引用检查器（applications 暴露 `ReferenceChecker` 端口，eval-runs 注册）解决。
6. **`ApplicationsService.tryVersionChat()` 仍是桩**（`applications.service.ts:576-580` 返回 `pending_orchestration`）—— W2a 不修（eval-runs 直接注入 `OrchestrationService`，不经该 HTTP 端点）。它是 W2b 重放/对话测试的天然接入点。
7. **`MetricChart` 未用于屏3** —— 屏3 无趋势图，记分卡用 antd `Progress`/`Statistic`。不为凑「用了 echarts」而强塞图表。
8. **进度反馈用轮询而非 SSE** —— `GET /eval/runs/:id`，前端 3s、仅 `queued/running` 时轮询。W2a 无逐 token 流，轮询足够且零新基建。

9. **`EVAL_RUN_CASE_TIMEOUT_MS` 是判定阈值，不是墙钟上限**（peer review 实测发现，勿误信）——
   JS 规范规定对**执行中**的异步生成器调用 `return()` 会**排队**到当前 `next()` 完成后，
   无法抢占；而 `prepare()`（rewrite + intent + 检索）整段在**第一个 `next()` 内且无 yield`），
   恰是最典型的超时场景。实测：`timeoutMs=300ms` 时消费循环 300ms 即 break、`timedOut=true`
   正确，但 `runForEvaluation` 直到在途 `next()` 自行结束（3005ms）才返回。

   ⇒ `verdict=timeout` 的**判定是准的**，但单条用例的实际墙钟由**底层 provider 的 HTTP 超时**兜底，
   不由本常量决定。串行 run 下，一条卡死的用例会把队列拖过其预算窗口。

   选择 `await gen.return()` 而非 fire-and-forget 是权衡后的：换来准确 usage（token 是真花了的，
   不 await 就少算预算）、确定性 span 收尾与上游取消、以及避免下一条用例与在途请求重叠加压。

   **W2b 的正确解法**：把 `AbortSignal` 一路 plumb 进 `ModelProviderPort` 的 chat/embed 调用，
   才能真正硬中断。不要试图靠 `Promise.race` + 不 await 来"修"它——那只是把问题从"返回慢"
   换成"统计不准 + 后台请求堆积"。

11. **僵尸/孤儿 run 回收器的残余窗口**（peer review 实测，W2b 收口）——
    回收器覆盖**两态**，且**两条臂都必须以租约为免疫证据**（否则见下方修订记录 2 的死锁）：
    - `running` **僵尸**：判据「租约过期超过 `EVAL_RUN_REAP_GRACE_MS`(15min)」。租约由 worker
      逐条续租 → 过期严格等价于「worker 没了」。
    - `queued` **孤儿**：判据「`created_at` 早于 `now - GRACE` **且无活租约**
      （`lease_until IS NULL OR lease_until < now`）」。两个条件缺一不可：
      · **为什么需要 `created_at`**：queued 期间租约可能压根不存在（`tryAcquireLease` 在
        `markRunning` 之前），其存活证据是「pg-boss 队列里有个 job」——PG 看不见的外部状态。
        两条可达路径会留下**再也不会有 job 来跑**的孤儿：① `insertRun` 成功、`publish` 前
        进程被杀（service 的 try/catch 只兜住 publish **抛出**，兜不住进程**消失**）；
        ② `markRunning` 前瞬时 DB 错误且重试耗尽。健康 queued 只存在数秒。
      · **为什么 `created_at` 一个条件不够**：它**判不出**「job 还在排队」与「job 没了」的
        区别。backend 宕机/部署 > GRACE 时，job 持久化在 PG 里，进程回来后照常被取走——
        这条 run 的 `created_at` 早得很，但它完全健康。只看时间就会把**活 worker 正持有**的
        run 判死。故必须叠加租约活性，恢复 `running` 臂本就有的那层保护：**持租即免疫回收**。
      · **配套不变式**：`markRunning` 是**条件更新**（`lease_owner = owner` 且租约未过期），
        与 `renewLease` 同形。worker 的每一次状态推进都必须先证明自己仍持有租约。
    - **两条不变式**（`eval-runs.lease.db.spec.ts` 钉死，真库）：
      **① 持有活租约的 run 永不被回收；② 失去租约的 worker 永不能把 run 写回 `running`。**

      > 修订记录 1（review 第 1 轮，2026-07-16）：本条原只覆盖 `running`。因 `findActiveRun` 的
      > `ACTIVE_STATUSES` 把 `queued` 也当活跃，回收器的覆盖面**窄于**发起守卫，
      > 这个差集会让一条 queued 孤儿**永久锁死整个离线评测功能**（此后每次 `POST /eval/runs`
      > 恒 409，`stop()` 只置信号不改状态 → 无逃生口）。已补齐 `queued` 臂。
      >
      > 修订记录 2（review 第 2 轮，2026-07-16）：修订 1 的 `queued` 臂**只看 `created_at`、
      > 无视租约证据**，把死锁**原样重生且更不可达**。真库实测的链条：worker `tryAcquireLease`
      > 把租约推到未来 → 并发 `POST /eval/runs` 触发回收器（跑在 `findActiveRun` 守卫**之前**，
      > 连注定 409 的请求也触发）→ queued 臂只匹配 `created_at`，持租免疫不了 → 收成 `failed`
      > + `lease_until=NULL` → worker 的**无条件** `markRunning` 把它写回 `running`。终态
      > `running` + NULL 租约：running 臂要 `lease_until < deadline`（`NULL < ts` 求值为 NULL
      > 而非 TRUE）、queued 臂要 `status='queued'`——**两条臂都够不着** → 永久 409，只能人工改库。
      > 根因：`running` 用租约（worker 可刷新 → 持租即原子免疫）、`queued` 用 `created_at`
      > （worker **无法刷新** → 免疫消失），两态判据不同源，`tryAcquireLease` 不再是「我已接管」
      > 的排他证据。已按上方「两条臂都以租约为免疫证据 + `markRunning` 认租约」修复。

    已知残余窗口：
    - **`queued` 孤儿在无人持租时仍按时间判**：若 job 在队列里干等超过一个 GRACE **且无 worker
      接管**（worker 在 `tryAcquireLease` 前挂起、或 job 迟迟未被取走），回收会先于最后一次
      重试 → 该 run 判 `failed` 而非续跑。代价是「已经卡了 15 分钟的 run 诚实地失败」，换来
      死锁**必然自愈**；重试上来只会看到 `already_finished` 而空转，不产生错误结果。
      **横幅文案据此只陈述观察得到的事实**（「超过宽限期仍无 worker 接管，可重新发起」），
      **不说「任务已丢失」**——回收器判不出 job 是丢了还是还在排队，后者在宕机重启后真实可达。
      W2b 若要消灭它，正解是把「活跃槽位」建模成**有明确所有者与过期证据的资源**（见缺口 13），
      而不是继续调大宽限期。
    - **续租只发生在用例之间**，不在用例执行**期间**。故租约实际断言的是「没有单条用例超过
      5 分钟」而非「worker 活着」。若某条用例卡住超过 5min+15min 宽限，回收器会把一条
      **健康** run 判死，而该 worker 仍会把当前用例的结果写进一条已 `failed` 的 run
      （下一轮迭代的续租检查才会让它让位），且此时 `create` 已放行第二个 run →
      短暂违反「全局同时最多 1 个 run」。实践中不可达（provider 的 HTTP 超时是 60s，
      见 `protocol-dispatch.adapter.ts`），但它依赖的正是 018 缺口 9 说不存在的墙钟上限。
      W2b 正解：用例**执行期间**也发心跳（或把 TTL 抬到高于最坏 provider 超时）。
    - **抢不到租约时的重新入队没有延迟**：`Queue` 端口（`queue.port.ts`）只有
      `singletonKey`/`retryLimit`，**没有 `startAfter`**，故 spec 说的「重新 publish 延后」
      当前无法实现。若 run 时长超过 pg-boss 的 job 过期时间（v12 默认 15min），
      job 会被判过期→重投→撞 `lease_busy`→再 publish→约 2s 后再来，形成自持的
      job churn 直到 run 结束（不产生错误结果，但无界建 job）。W2b 需给 `Queue` 端口加延迟投递。

12. **`failed` run 在屏3 有综合分、在屏2 没有**（peer review 发现，**需产品裁决**）——
    屏2「上次得分」只取 `done|partial|budget_stop`（`failed` 没答出结果，不是「分很低」），
    而屏3 对任何 run 都算 `overallScore`。于是一条跑了一半才 failed 的 run，报告页显示分数、
    列表页显示「未运行」。**不变量 4（屏2==屏3）不受影响**（二者永不指同一个 run），
    但回收器让「failed 且有部分结果」成为常态，这个不一致值得显式裁决而不是当意外。

10. **`FaithfulnessEvaluator` 的空 claims → 100 分，被离线路径继承**（peer review 发现，**需 W2b 决策**）——
    `faithfulness.evaluator.ts:22` 的 schema 是 `.max(20)` 无下限，模型回 `{"claims": []}` 属**合法**响应 →
    `:57` 直接 `return { score: 100 }`。

    **W2a 不动它**：这是 E-W1 基线代码，Global Constraints 明令「`score()` 签名与行为不改」；
    且它有**正当解读**——「答案没有任何事实断言 ⇒ 空洞地忠实」确实说得通（与 correctness 那个
    `{points: []}` 不同：后者在 prompt 明确要求逐条对应时回空，是明白无误的裁判失败）。

    **但必须记下来**：`scoreOffline` 让这条路径开始影响**离线记分卡**——一个模型若对空/无信息
    答案回空 claims，忠实度会拿满分。这与「未评不进 avg」的口径存在张力（100 是真实分数，
    不是未评）。W2b 应显式裁决：是保留「空断言=满分」的语义，还是把它降为「无可判定 → 未评」。
    改这条**必然动 E-W1 在线分数口径**，故不能顺手改，要单独决策。

13. **「全局同时最多 1 个 run」依赖单实例部署前提，非原子守卫**（review 发现，**W2b 收口**）——
    原型 §6 要求「全局同时最多 1 个 run(串行队列)」。当前实现是 `create()` 里
    `findActiveRun()` → `insertRun()` 的 **check-then-insert**：两者之间无事务、无唯一索引，
    故两个管理员同时点「发起评测」（或一次双击）会双双读到「无活跃 run」→ 插出两条 `queued`。

    `tryAcquireLease` **救不了这个**：它的键是 `eval_runs.id`（**per-run**），只防同一条 run
    被两个 worker 重复执行，对**两条不同 runId** 提供零保护。spec §5 原本写的是一把
    `offline-run-worker` 全局单例键租约，实现时退化成了 per-run。

    ⇒ 「全局最多 1 个 running」当前的**唯一实际依赖**是 pg-boss 在**单进程内**串行 await
    handler（`pg-boss-queue.adapter.ts:38-45`，未设批大小/并发）。**本项目按单实例部署**
    （`infra/docker-compose.yml` 单个 backend 容器）。**多实例部署下两条 run 会真并发**——
    同时对被测配置加压、token 预算各算各的。

    > 修订记录（review 第 2 轮，2026-07-16）：本条原写「故后果良性：两条 run 顺序跑完，
    > 与原型『串行队列』的观感一致」。**该结论已被回收器证伪**：run B 排在长 run A 之后干等，
    > 一旦等满一个 GRACE（15min；原型 §6 自估 3~6min，但 50 题 × 30s 超时可远超）且**无人持租**，
    > 回收器就会把 B 判 `failed` 而非让它顺序跑完。B 的 job 随后被取走 → `findRunById` 读到
    > `failed` → `already_finished` 空转。**数据无损、重发即可**（故仍是 P3 量级），但
    > 「顺序跑完」不再成立：TOCTOU 双开的第二条 run **可能无声失败**。这也是缺口 11 那个
    > 残余窗口在单实例下**最常见的触发路径**。W2b 把活跃槽位建模成有所有者的资源后，
    > 两条一起消失（双开根本不会发生，也就没有干等的 B）。

    **本波不修的理由**：干净的修法（`(queued|running)` 上建**部分唯一索引**，或按 spec §5
    补全局键租约）都要动 schema/迁移并改 `create()` 的错误路径（23505 → 409），属架构级
    决策而非 review 修复的范围；半修（比如加个事务但不加约束）只会造成「已加固」的错觉。
    W2b 做「范围/每题重复」时一并把**活跃槽位建模成有所有者与过期证据的资源**（同缺口 11 的
    收口方向），两条一起消失。**在此之前，多实例部署是不被支持的**——这条前提写在这里，
    不要留在代码里当默契。

14. **真库门控测试的执行覆盖面**（review 第 2 轮发现，部分修复，**余下 W2b 收口**）——
    缺口 11 的两条不变式只有**真库**测得到（活在 SQL 三值逻辑上，fake 复刻不出来：
    `1bb8b13` 引入的复活死锁，当时 12 条真库用例 + 875 条单测**全绿**）。而这些用例受
    `RUN_DB_TESTS` 门控：`pnpm test` 下 `describe.skip` **静默跳过**，若不挂进脚本就
    **从不执行**——「钉子」自己不落地。

    **已修**：`apps/backend` 的 `test:db` 从只点名 `prompts.migration.spec.ts` 扩到全部 **5 个
    DB-only spec**（+ `applications.migration`、`conversations.evaluation-turn`、
    `evaluations.repository`、`eval-runs.lease.db`）。
    ⚠️ **必须 `--runInBand`**：这些 spec 都对**同一个** `MIGRATION_TEST_DATABASE_URL` 执行
    `DROP SCHEMA public CASCADE`，并行跑会互相拆台（实测：并行时 5 个 suite 全部死于
    `schema "public" does not exist`，且竞态会让 `vector` 扩展记录与实际对象脱节，
    污染到下一次运行）。改这条脚本时不要顺手删掉 `--runInBand`。

15. **租约守卫「三缺一」与回收宽限锚点**（review 第 3 轮 P3，**W2b 收口**）——
    第 3 轮 review 以状态空间穷举证明回收器谓词已**无死锁**（`running` + `lease_until IS NULL`
    可证不可达 → running 臂的 NULL-盲 `lt` 安全），0 P1 / 0 P2。以下三条是该轮留下的 P3，
    按 Ship「P3 = advisory」未在本波修，但**结论必须留档**，否则后人会重蹈覆辙：

    **(a) `finishRun` 未做租约条件化**（`eval-runs.repository.ts:368-373` ← `eval-run-worker.processor.ts:208`）。
    `renewLease` 只守在每轮迭代**开头**（`:181`），最后一条 case 跑完后直奔 `finishRun`，中间**无租约复检**。
    若最后一条 case 卡住 > 20min（缺口 9：30s 那个常量是**判定阈值**，不是 wall-clock 上界），
    回收器会先把 run 判 `failed` 并释放全局槽位，随后过期 worker 用 `done` 覆盖它，
    并经 `findRecentDoneRun` 成为权威的 1h 幂等结果。非死锁（终态）故为 P3。
    本波代码自述的不变式「每次状态推进都须证明租约所有权」（`:354-355`）目前是 **2/3**。

    **(b) `recordResult` 同理可漏一行**：回收若落在 `runCase` **执行中**，该 case 的
    `recordResult`（`:380`，无条件 INSERT）会写进一条已 `failed` 的 run 并推进 `done_cases`，
    下一轮 `renewLease` 才让位。**每次回收最多漏一行**，run 仍报 `failed`。
    未修的理由：它不是同款一行守卫——INSERT 在事务内，要守就得重排事务（先跑租约守卫
    UPDATE、0 行则跳过 INSERT）+ 改签名 + 改调用方，还会扰动 `listRecordedCaseVersionIds`
    的续跑路径。在「同一处已回归两次」的历史下，这属于 W2b 架构级收口，不做 drive-by。

    **(c) queued 臂的宽限锚点用 `now` 而非 `deadline`**（`:316` vs running 臂 `:311`）。
    对 `created_at` 很旧的 queued run，被 SIGKILL 的 worker 其租约在 acquire+5min 即过期
    → 回收器立刻可回收；而 pg-boss 要到 acquire+15min 才重投（实测 `pg-boss@12.25.1`：
    `expire_seconds: FIFTEEN_MINUTES`、`retry_delay: 0`）→ **回收器早赢 10 分钟，架空了
    `retryLimit: 3`**（原型 §18.A「job 异常重试 3 次仍败 → failed」）。一词之改：
    `lt(leaseUntil, deadline)`。⚠️ `:254-257` 的注释断言该余量成立——**它对 running 臂成立、
    对 queued 臂不成立**，改代码时连注释一起修。

    **(d) 结论：`markRunning` 的 `gt(leaseUntil, now)` 合取项应当被删掉，而不是"做实"。**
    它在唯一调用点是**空转**的（`processRun` 传的 `now` 正是 `tryAcquireLease` 用来算
    `lease_until = now+5min` 的那个 `now`，故 `lease_until > now` 恒真），真正的守卫是
    `eq(leaseOwner, owner)`。**但把它做实（传新鲜时间戳）会打破第 3 轮 review 的无死锁证明**：
    该证明依赖「`markRunning=false` ⟺ `lease_owner ≠ owner`」，这正是 `:154-157`「不重新入队」
    的正当性来源。真过期检查会让 worker **在仍持租时**收到 false（如 `resolveForTest` 慢过 5min）
    → 不重投 → A 正常返回 → pg-boss 视作完成不再重试 → run 卡在 `queued` 直到 15min 后被回收判 failed。
    **那是往非保守方向新增的失败模式。** 故：删空转合取项 + 注明「所有权即守卫」，勿"加固"。

    **未修（W2b）**：① 3 个 **infra 门控** spec（`eval-runs.e2e`、`eval-run-isolation`、
    `evaluations.e2e`）还需 `RUN_CLICKHOUSE_TESTS` + `CLICKHOUSE_URL`，挂进 `test:db` 会让该
    脚本硬依赖 ClickHouse，应另起一个带 infra 的 job；② 仓库**无 CI**（无 `.github/workflows`），
    故以上一切仍靠人工执行——**这是当前最大的守护缺口**，W2b 应建 CI 并把两层门控各挂一个 job；
    ③ 新增 db spec 仍需**手工**加进脚本（文件命名不成体系，无法用一条干净的 pattern 收全）。

## References

- 在线答案质量（E-W1 基线，不改）：`017-online-answer-quality`
- 代码组织与依赖边界：`003-code-organization`
- RAG 编排内核：`013-m8-rag-orchestration`
- 路线图：`002-implementation-roadmap`
- 产品权威：`docs/design/assets/eval-flywheel-product-design.html` §5/§6/§7/§15/§18/§19
