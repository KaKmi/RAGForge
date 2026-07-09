# M2 Handoff — Story 7（Vite proxy + 集成验证）

> 在新窗口的第一条消息里粘贴：
> `继续 M2 Story 7。读 .ship/tasks/m2/handoff-story7.md 开始。轻量对抗档（CLAUDE.md），收尾跑一次 /ship:review 覆盖全量 diff。`

## 当前状态

- **分支**：`feat/m2-app-shell`（基于 `main`，未推送）
- **完成**：Story 0–6（8 个 story 中 7 个完成）
- **剩余**：仅 Story 7（收尾），完成后跑 `/ship:review` 全量 diff 审

## Story 0–6 提交链（最新→最旧）

| SHA | Story | 说明 |
|---|---|---|
| 4cc823c | 5 QA | track Story 5 QA artifacts（playwright + qa-script）+ Story 6 SHA |
| 69bc1c7 | 6 | feat(frontend): typed api client + sse skeleton consuming mock stream |
| f9a99ad | 5 review | record Story 5 review follow-up (P3-1 + P3-2 fixed) |
| 349a2b4 | 5 fix | dedupe StartPage link keys (review follow-up) |
| f15e895 | 5 test | assert login navigates to /admin (review P3-1) |
| 91c2e7c | 5 | record Story 5 commit SHA in dev-ledger |
| ee761e1 | 5 | feat(frontend): implement 15 pages with mock data from prototype |
| 46fffa4 | 4 | feat(frontend): add app shell with 14 routes, admin/chat layout, auth guard |
| 2237c74 | 3 | record Story 3 completion in dev-ledger |
| 0fff948 | 3 | feat(backend): add 10 domain skeleton modules with mock endpoints |
| a811276 | 2 | feat(contracts): add M2 domain schemas |
| 9762985 | 1 | feat(backend): add nestjs-zod global pipe + openapi + migrate M1 controllers |
| 8b6a435 | 0 | docs(design): revise 003/006 for M2 |

## Story 6 关键产出（Story 7 集成验证要用）

- **`apps/frontend/src/api/sse.ts`** — `openChatStream(req, signal?)`：fetch POST `/api/chat` + ReadableStream async generator。按 `\n\n` 切帧，仅解析 `data:` 行。**ChatPage 发消息走它消费后端 mock SSE 流**。
- **`apps/frontend/src/api/client.ts`** — `apiFetch(path, opts)`（Bearer token + 401 跳 `/login`）+ 9 域 typed client。M2 页面仍用 mock 不调用，M3+ 接真后端。
- **`apps/frontend/src/pages/chat/ChatPage.tsx`** — 已接 `openChatStream`：发送 → token 累积 + citation 流式入右栏 + done 写 traceId/confidence。Enter 发送 / Shift+Enter 换行。卸载 abort。
- 后端 mock SSE 流：`apps/backend/src/modules/chat/chat.service.ts` 的 `streamChat()` — token×N → citation → done，格式 `data: ${JSON}\n\n`，Content-Type `text/event-stream`。

## Story 7 步骤（来自 plan.md L237-255）

### 1. Vite proxy 扩展

改 [vite.config.ts](file:///Users/zhaopengcheng/Desktop/rag-service/apps/frontend/vite.config.ts)：

```ts
server: {
  port: 5173,
  proxy: {
    "/health": "http://localhost:3000",
    "/api": "http://localhost:3000",   // ← 新增；SSE 经 /api/chat 走同一 proxy
  },
},
```

> Vite proxy 默认不缓冲流式响应，SSE 可直通。保留 `/health`。

### 2. 全量门禁

```bash
pnpm test      # 前端 16 + 后端 60 + 契约 52，全绿
pnpm lint      # 0 boundary 违规
pnpm build     # turbo 全量构建成功
```

### 3. 手动验收（记录到 dev-ledger）

```bash
# 终端 1：依赖服务
docker compose -f infra/docker-compose.yml --profile infra up -d --wait

# 终端 2：后端
pnpm --filter @codecrush/backend dev   # :3000

# 终端 3：前端
pnpm --filter @codecrush/frontend dev  # :5173
```

逐项验收（对齐 spec.md 的 10 条 Acceptance Criteria）：
- [ ] 浏览器逐屏点开 15 屏，路由跳转通（路由表见 `docs/design/006-m2-app-shell-skeleton.md`）
- [ ] 登录（任意用户名/密码，M1 mock）→ token 存 localStorage → 重定向 `/admin`
- [ ] `curl http://localhost:3000/api/docs-json | jq '.paths | keys'` 含全部新域端点（agents/models/knowledge-bases/documents/chunks/retrieval/prompts/chat/conversations）
- [ ] ChatPage 发消息 → 消费后端 mock SSE 流（token 流式渲染 + citation 入右栏 + done 显示置信度）

### 4. 提交

```
chore(m2): vite proxy + integration verification
```

Conventional Commits + 结尾 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

### 5. 收尾

Story 7 完成后跑 `/ship:review` 覆盖 `feat/m2-app-shell` 全量 diff（轻量对抗档：整个任务收尾一次审，不做每 story peer review）。

## 关键上下文 / 约束

- **轻量对抗档**（CLAUDE.md）：M2 是 CRUD/骨架型，跳过 per-story peer review + execution drill；Story 7 收尾跑一次 `/ship:review` 全量 diff。
- **设计权威**：`docs/design/006-m2-app-shell-skeleton.md`（路由表 14 条、15 屏表、后端模块表）；改架构先改文档。
- **dev-ledger**：`.ship/tasks/m2/dev-ledger.md` 记录每 story 完成情况 + commit SHA，优先信它 + `git log`，勿重复实现。
- **plan.md**：`.ship/tasks/m2/plan/plan.md` L237-255 是 Story 7 权威步骤。
- **spec.md**：`.ship/tasks/m2/spec/spec.md` 含 10 条 Acceptance Criteria（Story 7 验证满足）。
- **Story 5 QA 工件**：`.ship/tasks/m2/qa/qa-script.mjs`（Playwright 驱动 frontend dev server，验 AC 1/3/7/8）；运行时产物（screenshots/videos/pids/logs）不入库。
- **未提交残留**：working tree 可能剩 `pids.txt`（QA 运行时产物，不入库）。

## 已知坑

- antd 6 Button 给中文加字间距（"发 送"）；测试断言用 `/发\s*送/` regex 兼容。
- 后端 SSE 流 `done` 事件的 `traceId` 是无 `0x` 前缀的 hex（如 `391dae938234560b16bb63f51501cb6f`），契约 `ChatStreamEventSchema` 的 `done.traceId` 是 `z.string().min(1)`，OK。
- 前端**不直接 import zod**（AGENTS.md 边界）；`api/client.ts` 用本地 `ZodSchema<T>` 结构接口。contracts 已补 `DocumentListResponseSchema`/`ChunkListResponseSchema`/`MessageListResponseSchema`。
- typed client（getAgents 等）M2 未被页面调用，仅 sse 被 ChatPage 调用；M3+ 接真实后端时首次验证路径。
