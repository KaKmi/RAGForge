# M4 QA — Runtime Report（完整重跑）

> Branch: `feat/m4-ingestion-pipeline` @ `8cba6da`
> Date: 2026-07-09（本轮，忽略此前 02:50 的 QA 记录与 fixtures，全新独立测试）
> Method: infra（postgres+pgvector，已在跑）+ backend/frontend dev server（经 preview 工具）+ 真实 embedding 模型（text-embedding-v4, openai_compat, 阿里云 MaaS）+ curl 全链路 API 测试 + 浏览器交互测试（登录→知识库→文档→切片三页面）。
> 全新构造 4 种格式测试夹具（手写最小合法 PDF / DOCX 二进制，非既往 QA 遗留文件），覆盖 spec AC 1–7。

## Verdict

**PASS WITH FINDINGS（F1/F5/F6 已修复并回归验证）** — 7 条 AC 核心机制全部验证通过。QA 期间发现的 P1 重建死锁（F1）、Embedding 显示 bug（F6）、antd 废弃 API 警告（F5）已在本轮内修复并重新验证（单测 + 真实运行时复现原触发序列确认解决）。剩余 F2/F3/F4/F7 为规格偏离或已知设计取舍，不阻塞。

### 修复后回归结果
- `pnpm --filter backend test`：254/254 通过（含 `kb-rebuild.service.spec.ts` 新增 2 条回归用例）
- `pnpm --filter frontend test`：40/40 通过
- `pnpm lint`：0 违规
- 运行时复现：原 F1 触发序列（重建中上传 autoParse=false 文档）重新执行，KB 在 1 秒内正确切换到 ready（此前会永久卡死），新文档保持 pending 不受影响，两篇既有文档正确产出目标模板切片

## Environment

- infra: postgres(pgvector, healthy) / clickhouse / otel-collector — 已在跑，未新建
- backend: `pnpm --filter backend dev` on :3000（本轮新启动）
- frontend: `pnpm --filter frontend dev` on :5173（经 Claude Preview 工具管理）
- embedding 模型: `80f294d7-...` text-embedding-v4 (openai_compat, enabled)，真实外部调用
- demo 用户: demo@codecrush.local
- QA KB: `QA-FULL-0709` (`1f5e06e0-a01f-455f-b109-6695bb1d95db`)

## Acceptance criteria 结果

### AC1 — KB 创建 + 查重 + 校验 ✅
- 创建成功 201，字段齐全（`docsCount`/`chunksCount` 真实值）
- 重名 → 409；`chunkTemplate` 缺失 → 400（zod 枚举错误信息清晰）；`embeddingModelId` 指向不存在的模型 → 404
- 证据: `api-ac1-kb-create.txt`

### AC2 — autoParse 两态 + 多格式上传 ✅
- 一次性上传 txt/md/**pdf**/**docx** 四种格式，`autoParse=false` 全部停在 `pending`（chunkVersion=null），类型判定正确（type: text/markdown/pdf/word）
- `POST /:id/parse` → 202，四篇全部 `pending → queued → processing → ready`
- 证据: `api-ac2-upload-noautoparse.txt`, `api-ac2-trigger-parse.txt`

### AC3 — 四格式端到端 ✅（本轮新增：真实 PDF/DOCX 覆盖，前次 QA 未测）
- 手写最小合法 PDF（pdf-parse 真实解析）与 DOCX（mammoth 真实解析）均产出正确切片、正确 lifecycle 三阶段闭合
- 切片 `version` 字段与文档 `chunkVersion` 一致
- txt 文档中文标题层级切段正确，tokenCount CJK 感知估算符合预期量级
- 证据: `api-ac3-pdf-chunks-lifecycle.txt`

### AC4 — 全库重建蓝绿 ⚠️ PASS WITH P1 FINDING
- 正常路径（重建期间无新上传）：`building → ready` 原子切换、`activeVersion` 递增、旧版本切片重建期间仍可查（不空窗）、qa 模板对无 Q/A 内容的文档正确回落 general — 全部验证通过，且连续触发 4 次重建全部干净完成
- **F1 [P1] 重建期间上传 autoParse=false 文档 → KB 永久卡在 building**（见下方 Findings，已独立复现）
- **F2 [P2] 前端编辑 KB 弹窗改分块模板无二次确认** — spec 明确要求"触发重建给出确认提示"，实测点击保存直接静默触发重建
- **F3 [P3] 重建中仅 desc 的 PATCH 不受 409 保护** — 只有携带 `chunkTemplate` 的 PATCH 才会 409，纯改 desc 的 PATCH 在 building 期间照常 200 生效
- 证据: `api-ac4-rebuild-trigger.txt`, `api-ac4-concurrent-patch.txt`, `api-edge-pending-during-rebuild.txt`

### AC5 — batch-delete ✅
- 物理删除确认（DB 计数验证）、空数组 400、不存在 id → `deletedCount:0`（不报错）、契约 grep 确认无 `enabled` 残留
- 前端切片页勾选+删除走 antd `Popconfirm`（非 `window.confirm`），交互与后端接线正确
- 证据: `api-ac5-batch-delete.txt`

### AC6 — 前端真实 API ✅
- `mocks/knowledge-bases.ts` 已删除，grep 唯一命中是注释
- 浏览器网络面板实测三页面（知识库/文档/切片）全部走真实 `/api/knowledge-bases`、`/api/documents`、`/api/documents/:id/chunks` 请求，非本地 mock

### AC7 — test / lint
- 本轮独立重跑 `pnpm lint` → 0 边界违规、0 error
- `pnpm test` 未在本轮重跑（dev 阶段与 review 均已验证全绿，属高成本低信息增量，QA 聚焦运行时）

## Findings

### F1 [P1][已修复] 重建期间上传 autoParse=false 文档 → KB 永久卡死在 building

**独立复现，非代码推断**：
```
PATCH /api/knowledge-bases/:id {chunkTemplate:"qa"} → 200 building (activeVersion=5, buildingVersion=6)
立即 POST /:kbId/documents (autoParse=false) → 201, 新文档 status=pending
```
连续轮询 45 秒，KB `status` 与 `updatedAt` 纹丝不动，始终 `building`（同等规模的重建正常仅需 1-2 秒）。**验证是永久卡死而非慢**：手动 `POST /api/documents/:id/parse` 该 pending 文档后，KB 立即在 1 秒内完成切换到 ready。

**根因**（对照 `kb-rebuild.service.ts` 的 `onDocumentTerminal`/`allTerminal` 逻辑）：重建完成判定检查 KB 下**当前全部**文档是否都到终态（ready/failed），但新上传的 `pending` 文档不入队、永远不会自行到达终态，导致 `allTerminal` 永远为 false。

**触发路径是正常 UI 操作**：用户在上传抽屉关闭"上传后立即解析"开关、KB 恰好在重建中——没有任何异常操作或极端时序，是完全可达的真实场景。前端此时会显示"重建中"徽标且永不消失，无错误提示、无恢复指引，用户不知道发生了什么或如何解决。

**建议**：`allTerminal` 检查应基于 `startRebuild` 发起时刻的文档快照集合，或重建期间上传的 pending 文档不计入终态判定门槛；同时前端"重建中"态如果超过合理阈值应给出诊断提示。

**修复**：`kb-rebuild.service.ts` 新增 `rebuildDocIds: Map<kbId, Set<docId>>`，`startRebuild` 入队前落快照，`onDocumentTerminal` 只对快照集合里的文档判定终态（快照缺失时回退旧行为兜底；快照里的文档若中途被删除也不阻塞）。新增 2 条回归单测（`kb-rebuild.service.spec.ts`）覆盖"重建期间新上传 pending 文档不阻塞切换"与"快照文档中途被删不阻塞切换"。**已用原始触发序列重新在真实运行时复现验证**：同样的"触发重建 + 立即上传 autoParse=false 文档"操作，KB 在 1 秒内正确切换到 ready（此前永久卡死），新文档保持 pending 不受影响。

### F2 [P2] 编辑知识库弹窗改分块模板无确认提示，偏离 spec

Spec `Changes by file` 明确写"编辑 KB Modal（chunkTemplate 可改，**触发重建给出确认提示**）"。浏览器实测：编辑弹窗选择新分块模板 → 点击"保存" → 立即静默触发全库重建（无任何"确定要重建吗"的二次确认），与规格文字不符。全库重建是有实际成本的操作（重新调用 embedding API、短暂旧版本共存），跳过确认对用户不友好。

### F3 [P3] 重建期间仅 PATCH desc 不受 409 保护

AC4 原文"重建中再次 PATCH 同库 → 409"未限定字段。实测：`building` 状态下 `PATCH {desc:"..."}` 正常 200 生效，只有 body 含 `chunkTemplate` 时才 409。可能是有意为之（desc 修改与分块逻辑无冲突），但与 AC4 字面表述有出入，建议在设计文档中明确该例外并同步更新 AC 措辞。

### F4 [P3] 无 magic bytes 校验（已通过运行时验证，非仅代码审查推断）

上传一个内容为纯文本、扩展名伪装为 `.pdf` 的文件，autoParse 后被正常接受排队，最终在解析阶段以 `[PARSE_FAILED] 文档解析失败：Invalid PDF structure.` 优雅失败（`status=failed`，错误信息清晰，未导致进程崩溃或 worker 阻塞）。确认：类型校验仅看扩展名，不校验文件头；但至少此类"内容与扩展名不符"的场景失败降级是干净的，不构成本轮观测到的可用性问题。构造恶意负载（zip 炸弹/超大 PDF）导致的资源耗尽风险未在本轮验证范围内。

### F5 [P3][已修复] 前端 antd 组件废弃 API 警告（控制台噪音）

浏览器控制台反复出现：
```
Warning: [antd: Modal] `maskClosable` is deprecated. Please use `mask.closable` instead.
Warning: [antd: Drawer] `width` is deprecated. Please use `size` instead.
```
不影响功能，但与 CLAUDE.md "前端组件优先用 antd 且需正确用法" 的要求有出入，建议顺手清理这两处 prop 用法。

**修复**：`DocumentsPage.tsx`/`KnowledgeBasesPage.tsx` 共 5 处 `maskClosable={x}` 改 `mask={{closable: x}}`，2 处 `Drawer width={n}` 改 `size={n}`（antd v6 Drawer 的 `size` 直接接受数字，语义等价，非仅预设档位）。`tsc --noEmit` 通过，`pnpm lint` 0 违规。

### F6 [P3][已修复] 编辑知识库弹窗 Embedding 字段显示原始 UUID 而非模型名

`DocumentsPage.tsx` 的 KB 摘要行（原 525 行）与编辑弹窗的禁用 Select（原 774-778 行）均直接渲染 `kb.embeddingModelId`（UUID），未做任何名称查找——该文件从未 `import getModels`，也没有模型列表可供查表，与 `KnowledgeBasesPage.tsx` 创建表单里正确的 `embeddingModels.map(m => ({label: m.name, value: m.id}))` 模式不一致。截图证据即为本轮 AC4 测试中拍到的编辑弹窗画面。

**已在本轮修复**：`DocumentsPage.tsx` 新增独立 `getModels()` 拉取（`useEffect`，仅拉一次，不随文档轮询重复请求）+ `embeddingModelName` 查找（`models.find(m => m.id === kb.embeddingModelId)?.name ?? kb.embeddingModelId`，查不到时兜底回退显示 id），摘要行与编辑弹窗 Select 的 `label` 均改用查找结果。`tsc --noEmit` 通过，浏览器实测摘要行与编辑弹窗均正确显示 `text-embedding-v4`。

### F7 [P4/未复现] singletonKey 跨版本竞态（review 已记录，本轮尝试复现未命中）

针对 review 记录的"手动触发解析 + 立即触发全库重建"竞态（`singletonKey=documentId` 不含版本号，pg-boss 理论上会静默丢弃后到的同 key job），本轮用并发 curl 尝试复现 2 次（含一次用多切片文档拉长窗口），两次均正确收敛到目标版本、无切片丢失。黑盒时序竞得太紧，未能在本轮独立复现为可观测的运行时故障；不代表该风险不存在，只是本轮未能实测证实，仍建议按 review 建议补针对性单测（构造锁步的 fake queue）而非依赖运行时随机命中。

### 其余轻量观测（不单独定级）

- 批量删除切片传 300 个不存在的 id → 优雅返回 `deletedCount:0`，无超时/报错，未见明显性能问题（规模仍小）
- 切片搜索 `q=%`（SQL LIKE 通配符）未转义，返回全部匹配——已知既有 concern（dev-ledger T10），非本轮新发现
- 创建 KB 时塞入额外字段（`id`/`status`/`activeVersion`）被服务端正确忽略，无越权写入
- 名称含 `<script>` 标签的 KB 创建成功、原样入库——API 层不做转义符合预期（渲染时转义是前端职责，未在本轮验证前端渲染点，风险较低）
- 上传请求不带 `files` 字段 → 优雅返回 `201 []`（非此前 review 描述的 500 崩溃），该特定回归担忧本轮验证未复现

## 遗留测试数据

- `QA-FULL-0709` (`1f5e06e0-...`)：5 篇文档、多轮重建（activeVersion 已推进到 8）+ 1 篇 magic-bytes 失败样本，可作为回归基线保留或手动清理
- `QA-INJECT-TEST`、`<script>alert(1)</script>`（KB 名称，注入测试用）：建议清理，避免污染知识库列表
- fixtures 位于 `.ship/tasks/m4/qa/fixtures/`（全新生成：手写 PDF/DOCX + txt/md，与既往 QA 记录无关）
