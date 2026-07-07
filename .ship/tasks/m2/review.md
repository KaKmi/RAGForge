# Code Review — M2 (final diff coverage, 轻量对抗档)

## Scope

- Base: `origin/main`
- HEAD: `1b6c4af` (Story 7 SHA follow-up) + worktree P3 fixes (this commit)
- Scope: full M2 diff (`feat/m2-app-shell` branch) — Stories 0–7
- Spec: `.ship/tasks/m2/plan/spec.md` (10 AC)
- Mode: 轻量对抗档 — host 自查 plan 代替 execution drill（依据 CLAUDE.md 分级：M2 是 CRUD/骨架型）；3 个并行子代理按子系统审查（contracts+backend / frontend / config+Story7），合并为本文。

## Verdict

**DONE** — 0 P1 / 0 P2 / 4 P3（全部已修复）。10 AC 全验证（见 dev-ledger Story 7）。test/lint/build 全绿。

## Findings（全部 P3，已修复）

### P3-1: Prompt 版本号计算可产生倒退/重复
- File: `apps/backend/src/modules/prompts/prompts.service.ts:82`
- Trigger: `createVersion` 用 `existing.length + 1` 算下一版本号。当历史版本被删除或版本号不连续（mock 数据 `p2` 有 v3、`p4` 有 v2，但若未来插入高版本再删除低版本），`length+1` 会小于现存最大 version，导致新版本号倒退；同 prompt 并发创建（M6 持久化后）也会撞号。
- Impact: Prompt 版本号唯一性/单调性破坏，diff 与回滚定位错版本。M2 是 mock 桩不持久化，影响潜伏到 M6。
- Fix: 改为 `existing.reduce((m, v) => Math.max(m, v.version), 0) + 1`——取现存最大 version +1，保证单调且不撞号。
- Status: **fixed**（本提交）

### P3-2: CreateKnowledgeBaseRequest 未 omit `progress`，客户端可覆盖后端构建进度
- File: `packages/contracts/src/knowledge-bases.ts:22`（omit 列表）
- Trigger: `CreateKnowledgeBaseRequestSchema = KnowledgeBaseSchema.omit({id, docsCount, chunksCount, status, updatedAt})`，漏了 `progress`。`progress` 语义是「构建进度百分比」，由后端在 building 态填；客户端 POST 时可塞 `progress: 100` 伪造「已完成」。
- Impact: 信任边界泄漏——客户端能影响后端状态字段。M2 后端是 skeleton 不读该字段，但 M4 入库管线接真后会沿契约形状直接写入。
- Fix: omit 列表加 `progress: true`。Zod 默认 strip 已 omit 的 key，客户端传入也会被丢弃。
- Test: `m2-schemas.test.ts:274` 加强断言——`parse({...rest, progress: 62}).progress === undefined`，锁定「客户端塞 progress 被 strip」。
- Status: **fixed**（本提交）

### P3-3: PagePlaceholder.tsx 死代码
- File: `apps/frontend/src/components/PagePlaceholder.tsx`（整个文件）
- Trigger: grep 全 `apps/frontend/src` 仅命中自身定义（line 3 interface + line 12 function），无任何 import。Story 5 后所有占位页改用 `React.lazy` 真实页面，该通用占位组件被遗弃。
- Impact: 死代码漂移——后续读者误以为还在用，或误改无效果。
- Fix: 删除文件。
- Status: **fixed**（本提交）

### P3-4: 006 设计文档 OpenAPI 路径与实现不一致
- File: `docs/design/006-m2-app-shell-skeleton.md:40` 与 `:301`
- Trigger: line 40 写 `nestjs-zod → /api/openapi.json`，line 301 写 `curl /api/docs 返回 OpenAPI JSON`；但实现（Story 1 `app-bootstrap.ts`）是 Swagger UI 在 `/api/docs`、OpenAPI JSON 在 `/api/docs-json`。line 263 已正确区分两者，line 40/301 漂移。
- Impact: 文档与实现不一致——按文档 curl `/api/docs` 拿到 HTML 而非 JSON；设计权威失真。
- Fix: line 40 `/api/openapi.json` → `/api/docs-json`；line 301 `curl /api/docs` → `curl /api/docs-json`。
- Status: **fixed**（本提交）

## Diagnosis

无单一根因。4 个 P3 分属 4 类：版本号算法（P3-1）、契约 omit 遗漏（P3-2）、重构遗留死代码（P3-3）、文档漂移（P3-4）。均为低影响、易修，M2 skeleton 阶段不暴露真实故障，但 M4/M6 接真后会放大——现修最经济。

## Verification

- `pnpm lint` → 0 boundary 违规，0 error
- `pnpm test` → 8/8 tasks green（backend 60 / frontend 16 / contracts 52，含加强后的 m2-schemas 42）
- `pnpm build` → 5/5 tasks green
- 10 AC 验证见 `dev-ledger.md` Story 7（QA 18/18 + login-check + curl SSE/OpenAPI）

## Open Questions

无。M2 收尾，可交付。
