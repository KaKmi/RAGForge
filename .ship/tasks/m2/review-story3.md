# Code Review — Story 3（后端 10 个 skeleton 模块）

> 范围：`a811276..HEAD`（commits `0fff948` impl + `2237c74` ledger），仅 Story 3。
> 对抗档：轻量（非安全 story 不做每 story 审，本 review 为 Story 3 单独静态审查；任务收尾仍跑一次全量 review）。
> Spec：`.ship/tasks/m2/plan/spec.md`（AC 1-10；本 story 主要命中 AC 4/9/10）。

## Findings

### P2: `createVersion` 返回的版本号低于现存版本（版本倒退）
- File: `apps/backend/src/modules/prompts/prompts.service.ts:82`
- Trigger: `POST /api/prompts/p1/versions`。`MOCK_VERSIONS` 中 p1 已有 v7（prod，line 19）与 v8（draft，line 29）两条。`existing.length + 1 = 3`，故新建版本 `version: 3`。
- Impact: 版本号倒退（3 < 7 < 8），违反 `PromptVersionSchema.version` 隐含的单调递增不变量与 spec「后端分配 version」的意图。客户端若按「最新 = max version」选版本，会把新建的 v3 当成比 v7/v8 更旧。id `pv-p1-3` 也与既有 `pv1`/`pv1-draft` 命名错位。
- 测试盲点：e2e `skeleton.e2e.spec.ts:267` 仅断言 `typeof res.body.version === "number"`，故测试全绿但行为错误（reward-hack 式通过）。
- Fix: `const nextVersion = existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;` → 9。同步加断言 `expect(res.body.version).toBeGreaterThan(8)`。

### P3: 四个 create 端点在重复调用时返回相同 id（id 不唯一）
- Files:
  - `apps/backend/src/modules/agents/agents.service.ts:58` — `agent-${MOCK_AGENTS.length + 1}` → 恒为 `agent-3`
  - `apps/backend/src/modules/documents/documents.service.ts:45` — `d${MOCK_DOCS.length + 1}` → 恒为 `d3`
  - `apps/backend/src/modules/knowledge-bases/knowledge-bases.service.ts:43` — `kb${MOCK_KBS.length + 1}` → 恒为 `kb3`
  - `apps/backend/src/modules/models/models.service.ts:46` — `m${MOCK_MODELS.length + 1}` → 恒为 `m4`
- Trigger: 同一 create 端点调用两次 → 返回完全相同的 id；且新对象未 push 进 mock 数组，故 `GET /:id` 用返回的 id 查询会 404。
- Impact: id 唯一性是核心不变量；创建出的资源不可回查。M2 stub 影响面窄（无持久化、无后续 GET 断言），但行为不正确。
- Fix: 用单调计数器（模块级 `let seq`）或 `crypto.randomUUID()`；若希望 mock 反映创建结果，push 进数组。

### P3: `CreateKnowledgeBaseRequestSchema` 未 omit `progress`，客户端可覆盖后端分配值
- File: `packages/contracts/src/knowledge-bases.ts:22-28`（omit 集合缺 `progress`）+ `apps/backend/src/modules/knowledge-bases/knowledge-bases.service.ts:42-50`（`...req` 在后，覆盖前面的 `progress: 0`）
- Trigger: `POST /api/knowledge-bases` body 带 `progress: 99` → 响应 `progress: 99`，而非后端设定的 0。
- Impact: `progress` 是构建进度指标，语义上与 `status`/`docsCount`/`chunksCount` 同属后端分配字段，却留在 create 请求里；与既有 omit 集合不一致。
- Fix: `CreateKnowledgeBaseRequestSchema = KnowledgeBaseSchema.omit({ id, docsCount, chunksCount, status, progress, updatedAt })`。

## Diagnosis

四个 create 端点的 id 生成共享同一缺陷模式：`id: \`<prefix>${MOCK_*.length + 1}\`` 既不 push 进数组、也不用计数器，导致 id 既不唯一也不可回查。根因是「stub 用数组长度当序列号」这一快捷写法在没有持久化的前提下不成立。建议统一一个 `nextId(prefix)` 工具或显式 push；M3+ 接真实表后自然消除，但 M2 阶段应至少保证单进程内 id 唯一，避免前端 Story 5/6 联调时踩坑。

## Open Questions / Notes（非正式 finding，供后续 story 参考）

1. **chat SSE 非真流式**：`chat.controller.ts:32-36` 同步 for-loop 写完全部事件后 `res.end()`，无 `await`/flush/100ms 间隔。spec 设计描述（line 107）提到「按 100ms 间隔 flush」，但 AC9 仅要求「事件可被 ChatStreamEventSchema parse」，且 `chat.service.ts:13` 注释已声明这是 M2 刻意简化（M8 改 AsyncGenerator）。**不是 bug**，但 Story 6 写 `api/sse.ts` 时需注意：浏览器端在响应结束前不会收到增量 token（一次性到达），不能用真流式的 UI 渐显断言。

2. **stub 原地变更与「不持久化」注释矛盾**：`agents.service.ts:65`（`Object.assign(agent, req)`）与 `chunks.service.ts:47`（`chunk.enabled = enabled`）直接改写模块级 mock 数组元素，注释却写「不持久化」。实际在进程内是持久的 → 跨测试潜在污染（当前测试顺序下未触发，因无后续断言依赖原值）。建议要么改注释为「进程内持久、重启失效」，要么返回副本 `{ ...agent, ...req }`。

3. **`zod-pipe.e2e.spec.ts` 并行偶发 404**：dev-ledger 已记录，非本 story 引入，CI 复现时按 `--runInBand` 或 beforeAll 路由就绪等待排查。
