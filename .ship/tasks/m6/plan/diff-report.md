# M6 Diff Report — Host vs Peer Spec

> Host: `spec.md` · Peer: `peer-spec.md`。仅记录分歧 + 裁决（一致项不记）。
> 证据基准：实际读过 `file:line`；架构权威 `001:88`。
> Peer 为同 provider fallback subagent（无 Codex/Claude CLI），独立性弱，已记。

## 裁决汇总

| # | 分歧 | 裁决 |
|---|------|------|
| D1 | 共享纯逻辑文件名 + 函数名 | host stands（cosmetic 偏好，名更清晰无碰撞） |
| D2 | rollback：单 publish 端点 vs publish + rollback 双端点 | conceded（peer 双端点语义更清 + 独立 AC 验收 + 前瞻审计） |
| D3 | currentVersionId nullable | 一致（均 nullable）—— 不记 |
| D4 | diff：无后端端点 vs 后端 /diff 端点 | proven-false（共享纯函数即单一真相，后端端点是冗余 wrapper，YAGNI） |
| D5 | variables：text[] vs jsonb | conceded（对齐 001:88 架构权威；用 `.$type<string[]>()` 保 TS 类型） |
| D6 | author 来源：客户端 optional vs JWT email 服务端填 | conceded（peer 正确，author 须来自 `req.user.email`，存储必填，请求 schema 删 author） |
| D8 | 唯一约束 + 索引 + retry | conceded（peer `unique(promptId,version)` 防并发撞号 + `index(promptId,status)` 查询性能） |
| D9 | seed 4 默认 Prompt | conceded（可选，恢复 demo 体验，低成本） |
| D10 | "绑定 Agent" tab 处理 | 一致（均空态 + M7 占位）—— 不记 |
| D11 | 循环 FK 处理 | 一致（FK 仅 prompt_versions.prompt_id，currentVersionId 无 DB FK）—— 不记 |
| D15 | publish 幂等拒绝（已是 prod → 409） | conceded（peer ConflictException 更清，防 no-op） |
| D16 | Prompt 读 DTO 暴露 `updatedAt/updatedBy` + PromptVersion 暴露 `createdAt` | conceded（前端 PromptsPage:297 显"更新人/时间"、:592"上次更新"——有消费方） |

**裁决计数**：proven-false ×1（D4）· conceded ×7（D2/D5/D6/D8/D9/D15/D16）· host stands ×1（D1）。

---

## D1 — 共享纯逻辑文件名 + 函数名

- **Host**：新文件 `packages/contracts/src/prompt-template.ts`；函数 `extractVars` / `renderTemplate` / `diffPromptBodies`；类型 `DiffLine`。
- **Peer**：`prompts.ts` 追加或新文件 `prompt-logic.ts`；函数 `extractVars` / `renderBody` / `diffBodies`；类型 `LineDiff`。
- **裁决**：`host stands`——两端均同意"contracts 内纯函数"（003 §Isomorphic），属 cosmetic。文件名 `prompt-template.ts` 比 `prompt-logic.ts` 更达意（主题是 prompt 模板的 var 抽取/渲染/diff）。函数名 `renderTemplate`/`diffPromptBodies` 比 `renderBody`/`diffBodies` 更明确（避免与通用"render body"碰撞）。保留 host 命名。

## D2 — rollback：单端点 vs 双端点

- **Host**：单 `POST /:id/versions/:versionId/publish` 端点，UI 文案区分"发布/回滚"（同一 service 方法）。
- **Peer**：双端点 `POST /publish` + `POST /rollback`，委托同一 service `promote()` 方法；理由"匹配前端两按钮 + AC#4/#5 各自独立验收"。
- **代码证据**：
  - `apps/frontend/src/pages/admin/PromptsPage.tsx:217,249`——"发布上线"与"回滚到此版本"两按钮均调 `setProd`（Option A 同机制）。前端确有两按钮。
  - 原型 `CodeCrushBot.dc.html:1027`（peer 引）——"原生产版本将自动归档，可随时回滚"。
  - Option A 语义：回滚 = 旧版本重标 prod，不新建版本（host/peer 一致）。
- **裁决**：`conceded`——双端点更优：① OpenAPI 自文档"发布"与"回滚"为两种 intent（即便机制同）；② AC#4（发布 draft→prod）与 AC#5（回滚 archived→prod）独立路由验收更清；③ 前瞻审计（M11 audit 表可按端点区分 publish/rollback 事件）。成本仅两个薄 route handler 委托同一 `promote()`。controller 加 `POST /:id/versions/:versionId/rollback`。

## D4 — diff 后端端点

- **Host**：无后端 `/diff` 端点。前端用共享 `diffPromptBodies(a,b)` 本地算。YAGNI。
- **Peer**（Risk 4）：建议后端 `/diff` 端点作"单一真相"，承认"可辩论"。前端也可本地算。
- **代码证据**：
  - `diffPromptBodies` 是 contracts 内共享纯函数（host §2 / peer §1 一致）——前端 import 它算的结果 == 后端 import 它算的结果。"单一真相"已由共享纯函数保证（一份实现，双端 import）。
  - 后端 `/diff` 端点只是对该纯函数的薄 wrapper（读两 version body → 调 `diffBodies` → 返回）——无新逻辑，仅多一次网络往返。
  - peer 引"M9 跳 Prompt 版本可复用"——M9 从 trace 跳 Prompt 版本只需 READ 版本 body（已有 `GET /:id/versions/:versionId`），不需 diff。
- **裁决**：`proven-false`——peer 的"单一真相"已由 contracts 共享纯函数达成（一份实现双端用）。后端端点是冗余 wrapper（route + handler + 测试，零新逻辑）。M6 YAGNI；M9+ 若有程序化消费方（非 UI）再加 `GET /diff?from=&to=`。

## D5 — variables：text[] vs jsonb

- **Host**：`text("variables").array().notNull().default([])`（Drizzle 原生 array，TS 推 `string[]`）。
- **Peer**：`variables jsonb notNull default '[]'::jsonb`（对齐 `001:88`）。
- **代码证据**：`docs/design/001-rag-platform-architecture.md:88`——`prompt_versions(...variables jsonb...)`。架构权威用 jsonb。
- **裁决**：`conceded`——对齐架构权威 001:88，用 jsonb。用 Drizzle 的 `.$type<string[]>()` 在 TS 层 cast 为 `string[]`（无运行时 parse 开销，仅类型断言；对我们的 own-write 安全）：`jsonb("variables").notNull().default([]).$type<string[]>()`。既对齐架构又保 DX。若架构升 `current` 时判定 text[] 更优，先改 001:88 再改列。

## D6 — author 来源

- **Host**：`CreatePromptRequestSchema`/`CreatePromptVersionRequestSchema` 含 `author: z.string().optional()`（客户端可传）。service 用 `req.author`（请求体）。
- **Peer**：`PromptVersionSchema.author` 必填（存储恒非空）；请求 schema 不含 author；后端恒从 `req.user.email`（JWT）填充。
- **代码证据**：
  - `apps/backend/src/modules/auth/jwt-auth.guard.ts:41`——验证后挂 `request.user = { id, email }`（peer §A 引）。
  - `apps/backend/src/platform/security/authenticated-user.ts:1`——`AuthenticatedUser = { id; email }`（无 displayName）。
  - `apps/backend/src/modules/users/users.controller.ts:20`——`@Req() req: AuthedRequest` 取 `req.user.id` 的范式（principal 来自 JWT，不信任 client 传入的身份字段）。
  - author 是审计字段（"谁创建此版本"），若由 client 传入可被伪造，审计失效。
- **裁决**：`conceded`——peer 正确。`author` 须来自 `req.user.email`（JWT），不可由 client 传入。`PromptVersionSchema.author` 改必填（`z.string().min(1)`）；`CreatePromptRequestSchema`/`CreatePromptVersionRequestSchema` 删 `author` 字段；service 用 `req.user.email` 填。controller 加 `@Req() req: AuthedRequest` 取 principal。这是审计正确性的关键修复。

## D8 — 唯一约束 + 索引 + retry

- **Host**：`prompts.name.unique()`；`prompt_versions` 无唯一/索引。createVersion 用 `reduce max+1`，无 retry。
- **Peer**：`unique(promptId, version)`（防撞号）+ `index(promptId, status)`（查 prod 性能）；createVersion 并发撞 unique 时 retry 一次。
- **代码证据**：
  - `prompts.service.ts:82`（M2 review P3-1）——`reduce max+1`。并发场景：两请求同时读到 max=3，均 insert version=4 → 撞号（无 unique 约束则两条 v4，数据损坏）。
  - `prompt_versions` 列版本/prod 查询高频（"列某 prompt 的 prod 版本"用于 chat 编排），`index(promptId, status)` 加速。
- **裁决**：`conceded`——采纳 peer：① `unique(promptId, version)` 防并发撞号（数据完整性）；② `index(promptId, status)` 提速列版本/prod 查询；③ createVersion 捕获 unique 冲突 → retry 一次（仍冲突则 `ConflictException` 409）。schema 加两约束，service 加 retry。

## D9 — seed 4 默认 Prompt

- **Host**：未提 seed。
- **Peer**（Risk 5）：可选——扩展 `seed.ts` seed 4 个默认 Prompt（rewrite/intent/reply/fallback 各 v1 prod），恢复 mock 演示数据。
- **代码证据**：`apps/backend/src/db/seed.ts:4,16-19`——现仅 seed demo user（`db.insert(users).values(...).onConflictDoNothing`）。已有 seed pattern，扩展成本低（~30 行）。
- **裁决**：`conceded`（可选/nice-to-have）——M2 mock 有 4 个默认 Prompt 演示；M6 真实 DB 起空，demo 体验断裂。扩展 seed 恢复 4 个默认 Prompt（v1 prod）保 demo 连续性。非 AC，标 optional。

## D15 — publish 幂等拒绝

- **Host**：未提。publish 同一 prod 版本会 no-op（重新 set status=prod）。
- **Peer**：目标版本已是 prod → `ConflictException`（409，幂等拒绝）。
- **裁决**：`conceded`——peer 更清。已是 prod 再 publish 是 no-op，应返 409 明确告知 client"该版本已是生产"，而非静默成功。service `promote()` 先查目标版本 status，若已 prod 抛 `ConflictException`。

---

## 应用到 spec.md 的变更（patched/conceded）

已同步更新 `spec.md`：

1. **D2**：controller 加 `POST /:id/versions/:versionId/rollback`（委托同一 `promote()`）；AC#5 改走 rollback 端点。
2. **D5**：`prompt_versions.variables` 改 `jsonb("variables").notNull().default([]).$type<string[]>()`（对齐 001:88）。
3. **D6**：`CreatePromptRequestSchema`/`CreatePromptVersionRequestSchema` 删 `author`；`PromptVersionSchema.author` 改必填；service 用 `req.user.email` 填；controller 加 `@Req() req: AuthedRequest`。
4. **D8**：schema 加 `unique(promptId, version)` + `index(promptId, status)`；service createVersion 捕获 unique 冲突 retry 一次。
5. **D9**：seed.ts 扩展（optional）seed 4 默认 Prompt。
6. **D15**：`promote()` 先查 status，已 prod → `ConflictException`。
7. **D16**：`PromptSchema` 加 `updatedAt`/`updatedBy`；`PromptVersionSchema` 加 `createdAt`；`prompts` 表加 `updated_by` 列；`repo.publishVersion(promptId, versionId, actorEmail)`；`service.promote(promptId, versionId, actorEmail)` + `createPrompt` 设 `updatedBy`；controller publish/rollback 传 `req.user.email`；`toPrompt`/`toVersion` 映射新字段；AC#12 + test plan 覆盖。

保留不变：D1（文件名/函数名 host 命名）、D4（无后端 /diff 端点）。
