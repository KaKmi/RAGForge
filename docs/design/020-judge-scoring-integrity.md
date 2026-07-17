---
title: "Judge scoring integrity v2"
description: "让 faithfulness 未评分在在线/离线、OTLP、ClickHouse、API 与 UI 全链路保持为 null，并以 v2 解析契约修复长答案确定性拒绝。"
category: "design"
number: "020"
status: current
services: [backend, frontend, infra]
related: ["design/002", "design/017", "design/018"]
last_modified: "2026-07-17"
---

# 020 — Judge scoring integrity v2

## Status

current——v2 evaluator、OTLP/ClickHouse null 语义、API/UI 与 PostgreSQL 迁移均已实现并验证。对应迁移为 `0021_judge_scoring_v2`。

## Summary

现有 faithfulness 把空 claims 记 100，同时用 20 条 claims / 300 字 generated field 的结构化
输出上限确定性拒绝长答案。实测结果是空/兜底短答拿满分，真实长答案无分，质量指标方向反转。
本设计把“没有可信分数”定义为**未评**，在领域/API 使用 `null`，在不可空的 ClickHouse
Float64 聚合状态内使用保留哨兵 `-1`，并在所有读模型第一层立即还原为 NULL。解析契约升为
`online-v2` / `offline-v2`，历史 v1 不重写。

## Goals / Non-goals

**Goals**：空 claims 不进均分；长答案在有界 v2 schema 内可解析；在线高风险候选仍完整评测
answer relevancy/context precision；所有读模型、筛选、排序、minimum 与 UI 忠实表达未评；版本迁移
不让运行中的 v1 离线 run 被 v2 evaluator 续跑。

**Non-goals**：不改变抽样风险分类、游标推进、租约、账本、离线 C-3 空答案守卫、离线 timeout、
`scoreOffline` 的 allSettled 隔离、离线 verdict；不自动回补历史在线流量；不重建 ClickHouse
物理聚合表。

## Design

### D1 intentional null 是成功结果，不是裁判失败

- `FaithfulnessEvaluator.score()` 返回 `MetricResult | null`；claims 为空返回 null，不 throw。
- 在线 `EvaluationJudgeService.score(..., { skipFaithfulness })` 只可跳过 faithfulness；另外两项
  仍按现有顺序执行。真正被调用的 evaluator 抛错仍使整条在线 evaluation 失败。
- 在线 fallback、failed、`noCitations=true` 跳过 faithfulness；低置信度 success 不跳过。
  eligibility 判据固定为 `status === "success" && !noCitations`，不从 contexts/confidence 推断，
  也不修改 `classifyRisk`。
- `EvaluationScores.faithfulness` 与公开评分结果为 `number | null`；未评时 evidence 不含
  faithfulness 键，不伪造“No evidence”。离线自然继承 fulfilled-null 分支，其余指标继续落分。

### D2 v2 structured output 边界

- claims 最多 100；prompt 要求合并细碎主张。
- generated string 上限统一为 500：faithfulness claim/reason、answer relevancy question、
  context precision reason、correctness reason；context precision 的 chunkId 边界不变。
- 四个 structured-output name 升为 `evaluation_*_v2`。
- evidence 仍最多 3 条、每条最多 300 字；解析放宽不扩大持久化/展示面。

### D3 Float64 兼容哨兵

- `@codecrush/otel-conventions` 定义 `EVALUATION_UNSCORED_SCORE = -1`；合法 API 分数域仍为
  `[0,100]`。
- 成功 span 对 null faithfulness 显式写 `rag.eval.faithfulness=-1`，不得省略属性。失败 span
  仍不写任何分数。
- `codecrush_eval_targets.faithfulness_state` 保持 `AggregateFunction(argMax, Float64, ...)`；
  不 DROP/ALTER/重建。
- `codecrush_eval_1m`、evaluations latest、traces latest 与 overview 内联 state 读取均在
  `argMaxMerge` 后第一层执行 `nullIf(value, -1)`；repository mapper 再把负值/非有限值归一为
  null。`-1` 不得越过 repository 边界。

选择哨兵而非 Nullable state 是部署兼容决策：当前 ClickHouse DDL 只有 `IF NOT EXISTS`，没有
schema migration runner；直接改聚合 state 类型不会演进存量表，破坏性重建又没有必要。

### D4 聚合、筛选与 minimum

- `sampleCount=count()` 继续表示成功 evaluation trace 总数；另增
  `faithfulnessSampleCount=count(faithfulness)`。
- faithfulness 的 avg、previous delta、样本不足与卡片 n 使用自己的 count；另外两项继续使用
  success 总数。空 faithfulness 集合显式返回 SQL NULL，禁止 NaN。
- trend 同时返回 `faithfulnessSampleCount` 与 `sampleCount`，tooltip 明示两种 n。byAgent
  faithfulness 可 null，总 n 仍是成功 trace 数。
- faithfulness 单项筛选要求非 NULL；排序 NULLS LAST；low/minimum 使用非 NULL 指标，SQL 可用
  `least(ifNull(faithfulness, 101), ...)`。另两项低分时，faithfulness 未评的样本仍可命中 low。
- repository 把 sentinel/负数变 null；service 若仍收到域外负数，视为不变量破坏并抛错，禁止
  clamp 成 0。

### D5 contracts 与 UI

- `QualityScores` 只允许 faithfulness nullable；`QualityThresholds` 是独立的三项非空 0–100
  object，不能再别名到 scores。
- scored Trace detail/summary 与 byAgent 接受 nullable faithfulness；minMetric/minScore 仍必填，
  因另外两项在线成功时必有分。
- Trace 详情用中性灰态“未评”，不参与红/绿阈值判断；Trace 列表继续显示后端从真实数字中算出的
  minimum，不把未评当低质量。

### D6 version 与迁移

- online settings 默认与当前 `online-v1` 行升级为 `online-v2`；仅更新值恰为 online-v1 的行，
  自定义/未来版本不覆盖。
- 新离线 run 默认 `offline-v2`；历史终态 run 保留原 offline-v1。
- PostgreSQL 0021 migration 第一条语句检查 queued/running eval run；存在则 fail fast：
  `judge scoring v2 migration blocked: queued or running eval_runs exist`。部署必须先停 worker 并
  等待或终结活跃 run，不能让同一 run 混用 v1/v2 evaluator。
- migration 不删除/回拨在线 watermark。v2 默认只评新流量；历史回补是单独的预算/运维决策。

## Failure modes

| 场景                     | 行为                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| empty claims             | faithfulness=null；在线仍 success，另外两项保留；离线该指标不进均分 |
| 在线不 eligible          | 完全不调用 faithfulness；不增加 judge failure circuit               |
| 实际 evaluator 失败      | 在线整体 failed；离线仅该指标 null，保持既有差异                    |
| span 丢失/Collector 故障 | 不影响 chat；账本与 `scoresNotPersisted` 继续提供差集证据           |
| sentinel 泄漏到 service  | 抛 RangeError，禁止把 -1 展示或钳成 0                               |
| 迁移时有活跃离线 run     | migration 失败且不改变版本默认/设置                                 |
| v2 当前版本暂时无样本    | UI 显示空态/真实 n=0；不自动重跑历史                                |

## Rollout / rollback

Rollout：先发布权威文档；实现并验证 v2；**停止 worker → 确认无 queued/running run → 执行
`0021_judge_scoring_v2` → 部署 v2 API/worker**；观察 evaluation success/failure、faithfulness
coverage 与 sentinel 泄漏断言。若要
历史回补，单独批准预算后删除指定 watermark，并显式设置
`ONLINE_EVAL_BACKFILL_WINDOW_HOURS=-1`。

Rollback：先禁用在线评测并停止 worker。数据库迁移保持前向兼容，不把默认/历史数据倒回 v1，
也不删除 v2 span；修复后应使用新 judgeVersion，而不是把不同解析契约重新标成 v1。

## Security / privacy

没有新信任边界。Judge 原文仍只在 worker 进程内使用；evidence 继续通过受 redactor 保护的
`codecrush.io.output`，每条最多 300 字；不得新增未保护 evidence 属性或持久化完整 chunk 正文。

## Verification

2026-07-17 实际验证：`pnpm test` 的 8 个 Turbo task 全绿；`pnpm lint` 0 错误；`pnpm build` 的
5 个包全绿；专用 PostgreSQL `test:db` 7 suites / 54 tests 全绿；ClickHouse-gated evaluation/
trace quality suites 全绿。迁移测试先证明 active run 会阻断且不改设置，再终结 run 后验证
online-v1→online-v2、自定义版本不覆盖、两个 v2 默认值及历史 offline-v1 保留。

- evaluator 边界：empty/100/101 claims，500/501 generated strings，evidence 3×300。
- 在线 eligibility、failure circuit、cursor/lease/ledger 回归；离线 fallback/C-3/allSettled 回归。
- contracts/service/frontend 的 nullable 与独立 count；threshold null 必须拒绝。
- ClickHouse 混合 v1 完整分数与 v2 sentinel，覆盖 overview/trend/byAgent/latest/low/filter/sort/
  backfill。
- migration 真库验证 active-run guard、默认值、自定义 online version 与历史 offline-v1。
- 全仓 `pnpm test`、`pnpm lint`、`pnpm build`。

## References

- 017 在线答案质量评测
- 018 离线评测 run 与评测集，尤其 §12 缺口 10/22
- AGENTS.md 依赖边界与“设计文档权威”约定
