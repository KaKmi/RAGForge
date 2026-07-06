# M2 Story 5 Review — 前端 13 页 + mock 数据

> 独立静态审查。范围 `git diff 46fffa4..HEAD`（Story 5 impl `ee761e1` + docs SHA）。
> worktree 干净（仅未跟踪 `review-story3.md` / `scratch/`，不在 diff 内）。
> 审查契约：只报 spec/AC 违反、运行时错误/行为破坏、数据不一致、安全/信任边界、接口破坏、
> 「测试通过但真实行为错误」类发现。不报风格/命名/未来推测/重构建议/antd 弃用警告。

## 审查覆盖

- 全量读取 diff 内全部 30 个文件（9 mock + StatusTag + 15 页 + App/ChatLayout/App.test + 删除旧 LoginPage）。
- 对照 `packages/contracts/src/` 全部相关 schema 校验 mock 形状与字段使用。
- 路由表对照 `spec.md` / `006` 路由表。
- 依赖边界：`grep @codecrush/otel apps/frontend/src` 与 `grep apps/backend apps/frontend/src` 均无命中；无残留 `pages/LoginPage` 引用。

## Findings

### P3-1 · 登录测试名声称校验「navigates to /admin」但未断言导航

- **文件**：`apps/frontend/src/app/App.test.tsx:88-119`
- **观察**：测试名 `stores token and navigates to /admin on successful login`，但测试体唯一断言是
  `await waitFor(() => expect(localStorage.getItem("token")).toBe("tok-123"))`（App.test.tsx:118）。
  全程未对导航结果做任何 DOM/location 断言（既未断言 AdminLayout 的 `CodeCrushBot` 品牌，也未断言 StartPage 内容或路由位置）。
- **触发**：`fireEvent.submit(form)` → `onFinish` → `fetch` mock → `localStorage.setItem` → `nav("/admin", { replace: true })`。
  即便 `nav("/admin")` 被删掉、写错目标、或被注释，`localStorage.getItem("token")` 仍为 `"tok-123"`，测试依旧通过。
- **影响**：导航回归不被捕获。AC 2「登录成功 → 重定向 `/admin`」的「重定向」部分无测试覆盖；
  `LoginPage.tsx:34` 的 `nav("/admin", { replace: true })` 行为事实上正确，但无测试约束。
- **修复方向**：在 token 断言后补一条导航落点断言，例如
  `await screen.findByText("CodeCrushBot")`（AdminLayout 品牌，登录后必渲染），
  或用 `MemoryRouter` + test route 检查 location.pathname === "/admin"。

## Open Questions（非 finding，M9 注意）

1. **TraceDetailPage 瀑布图分母**（`apps/frontend/src/pages/admin/TraceDetailPage.tsx:33,57-59`）：
   `total = Math.max(...spans.map(s => s.durationMs), 1)`，用「最大单 span 时长」当时间轴分母，
   而非 `max(startTime+durationMs) - rootStart`。对当前 mock 恰好正确（root span `rag.orchestrate`
   时长 1240ms 最大且起点=rootStart，故 `maxEnd-rootStart === max(durationMs)`，所有 bar 落在 0–100%）。
   但 M9 接真实读模型后，若 root 不是最长 span、或某子 span 终点超过 root 终点，会出现 `leftPct+widthPct>100%`
   甚至 `leftPct>100%`（bar 溢出/错位）。M2 不构成 bug，M9 落地前修。
2. **`buildDepth` 无环保护**（`TraceDetailPage.tsx:8-23`）：按 `parentSpanId` 回溯，若存在环会无限循环挂页。
   mock 无环，M2 安全；M9 真实 span 需加 visited 集合或深度上限。
3. **`spans[0]` 假定为根/最早**（`TraceDetailPage.tsx:32`）：`rootStart = new Date(spans[0].startTime)`。
   mock 中 spans[0] 确为最早，M2 正确；M9 若 spans 未按 startTime 排序，`rootStart` 偏晚会导致 `leftPct` 为负。
   （page 注释已声明「M9 接真实读模型」，上述三点属同一 M9 收口项。）

## 结论

Story 5 实现质量高：路由表与 spec/006 完全对齐；mock 与 contracts 经 tsc 校验形状一致（含 `ModelProvider.role`、
`RetrievalHit.docName` 等 spec 未列但契约已含的字段）；依赖边界零违规；React.lazy + Suspense 接线正确
（15 页均默认导出）；AuthGuard 覆盖 /admin 与 /chat；LoginPage 走 `/api/auth/login` + `LoginResponseSchema.parse` + token 存储 + 跳转，行为正确。

唯一发现为 P3 测试缺口（登录导航未断言）。无 P1/P2。建议修复 P3-1 后进入 `/ship:qa`。

## Follow-up（review 修复运行时暴露的额外问题）

修复 P3-1 后跑测试，登录导航测试日志中出现 React 重复 key 警告：
`Encountered two children with the same key, /admin/knowledge-bases`。

### P3-2 · StartPage 快速开始链接列表重复 key

- **文件**：`apps/frontend/src/pages/admin/StartPage.tsx:24`
- **观察**：`STEPS.map((s) => <Link key={s.to} .../>)`，但步骤 2「创建知识库」与步骤 3「上传文档」
  的 `to` 均为 `/admin/knowledge-bases`，导致两个 `<Link>` 同 key。
- **触发**：登录成功 → `nav("/admin")` → AdminLayout 渲染 → StartPage 挂载 → 链接列表 map。
- **影响**：React 重复 key 警告；理论上可能导致子节点被复用/忽略。当前 mock 下视觉无异常，
  但属真实缺陷。
- **来源**：Story 4（app shell）遗留，非 Story 5 diff 内。轻量对抗档 Story 4 未做每 story 审，
  此处由 Story 5 review 的测试运行间接暴露。
- **修复**：`key={s.title}`（title 在 STEPS 内唯一）。已提交 `349a2b4`。

### 修复状态

- P3-1（登录导航断言）：已修复，commit `f15e895`。测试 7/7 绿。
- P3-2（StartPage 重复 key）：已修复，commit `349a2b4`。测试 7/7 绿，重复 key 警告消失。
- 剩余 stderr 均为 antd 6 弃用警告（`List` / `Steps.direction` / `Steps.items.description` / `Drawer.width`），
  非本任务范围（contracts/antd 升级收口），不计入 finding。
