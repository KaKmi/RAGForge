# Concerns — m5-retrieval

## Story 3 (PASS_WITH_CONCERNS → 已当场修复)

- **双降级 span 属性覆盖**:`pg-hybrid-retriever.adapter.ts` 的关键词降级与 rerank 降级都写 `rag.degraded` 同一 key,同请求双降级时后者覆盖前者(仅丢观测数据,不影响检索结果)。
  → 已修复于 `180e37e`(改用 `rag.degraded.keyword_recall` / `rag.degraded.rerank` 独立 key),不留残余。

## Story 1 review 顺带记录的两个计划内取舍(非缺陷,不需处理)

- `ProtocolDispatchAdapter.rerank()` 无 post-parse 形状守卫:200 + 意外响应体 → 静默 `{results: []}`(与 embed() 的数量校验不同)——plan 有意为之,rerank 端结果为空时检索自然降级为保留融合分。
- `RERANK_BUILDERS` 的 `Number(r.relevance_score ?? r.score)` 对两 key 均缺失的畸形上游产生 NaN——与 plan 文本一致的畸形上游容忍度。

## Story 4 (PASS_WITH_CONCERNS → 已当场修复)

- **结果头部阈值标签漂移**:`RetrievalTestPage.tsx` 头部「阈值 X 以上」插值的是滑杆实时 state,跑完后拖滑杆会让标签与已展示结果不符(纯展示问题,不影响请求正确性)。
  → 已修复于 `73ced4c`(运行时快照 `ranThreshold`),不留残余。

## 与本任务无关的既有问题(已顺手修复)

- `apps/frontend/src/app/App.test.tsx` 的 "loads DocumentsPage from real /api/documents" 用例环境敏感:全量套件并发跑时 vitest 现场转换最重的懒加载 chunk 超出 findByText 默认 1s 超时(单跑轻载能过)。非 M5 引入(reviewer revert 验证),根因查明后修复于 `d000f2e`(放宽该断言等待窗口,语义不变),全量 `--force` 回归通过。

## 全局备注

- Peer review 全部由同 provider 的全新 Agent 会话执行(Codex 无额度,2026-07-09 用户确认)——独立性弱于跨模型评审。
