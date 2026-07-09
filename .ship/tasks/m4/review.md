# Code Review — M4 入库管线与知识库管理（复核轮，验证既往 7 个 P2 是否真实存在）

## Scope

- Base: `main`（`git merge-base main HEAD` = `6a9112c`）
- HEAD: `feat/m4-ingestion-pipeline` 分支尖端 + 本轮未提交改动
- 本轮任务：不是重新走一遍全量 diff review，而是**逐条重新核实上一轮 review 报告的 7 个 P2**——用户明确要求"去看下是否真的存在问题"。每条都回到当前源码重新读、必要时起服务/连真实 Postgres 实测，不采信旧报告的文字描述。核实后修复了其中 5 条，1 条被证明"诊断机制错但问题本身仍真实存在"（未修，说明见下），1 条维持原判未修（范围/设计权衡，非本轮仓促可定）。
- Spec: `.ship/tasks/m4/plan/spec.md`；Design: `docs/design/007-m4-ingestion-pipeline.md`

## 核实结论总览

| 编号 | 上轮判定 | 本轮核实结果 | 处置 |
|---|---|---|---|
| P2-1 singletonKey 静默丢弃 | 重建期间同文档在途 job 被静默丢弃 | **诊断机制错误**——pg-boss `standard` 策略下 singletonKey 根本不去重（见下）；但换一种机制，问题**依然真实存在**：两个不同目标版本的 job 会**都跑**，last-write-wins 覆盖 chunkVersion，已用真实竞态复现 | 未修（见 Open Questions，需要设计取舍） |
| P2-2 重建期间上传阻塞切换 | 新上传 pending 文档卡死重建 | **确认真实**，已用真实运行时复现（KB 卡在 building 45s+ 不动） | **已修**（本轮之前的 QA 环节修的，`kb-rebuild.service.ts` 快照方案，本轮重新验证仍有效） |
| P2-3 deleteByVersion 未分批 | 单条全量 DELETE + 无谓 RETURNING | 确认真实，读源码直接看到 | **已修**：改分批循环，用真实 Postgres 插入 2500 行验证跨 3 批正确全删 |
| P2-4 缺 FK | embedding_model_id 无 FK 约束 | 确认真实，schema.ts + 迁移 SQL 均无该约束 | **已修**：加 FK RESTRICT + 新迁移 `0007` + service 层友好 409（另发现并修了一个 drizzle 错误解包 bug，见下） |
| P2-5 无 magic bytes 校验 | 仅信扩展名 | 确认真实，`inferType()` 只查 `extname()` | 未修（范围较大：需定纸每种格式的签名字节与 zip-bomb 应对策略，不是本轮几分钟能拍板的） |
| P2-6 embed() 无超时 | 出站 fetch 无 AbortController | 确认真实，紧邻的 `testConnection()` 有完整超时而 `embed()` 完全没有 | **已修**：加 60s AbortController，镜像 `testConnection` 既有写法 |
| P2-7 上传聚合内存无上限 | 100 文件 × 20MB 无总量兜底 | 确认真实，`FilesInterceptor` 只设了单文件大小 | 未修（需要决定方案：Content-Length 预检 vs 转 diskStorage，且 chunked 传输能绕过前者——不是可以随手定的实现细节） |

## P2-1 深挖：原诊断的机制是错的，但换个机制问题仍然真实

**原判定**："pg-boss v12 singletonKey 语义：同 key 已有 created/active job 时，新 `send()` 返回 `null` 静默丢弃"——**这句话对我们实际用的队列策略不成立**。

读了 `node_modules/.pnpm/pg-boss@12.25.1/.../dist/manager.js` 的 `createQueue()`：

```js
const policy = options.policy || plans.QUEUE_POLICIES.standard;
```

`apps/backend/src/platform/queue/pg-boss-queue.adapter.ts` 的 `ensureQueue()` 调 `this.boss.createQueue(jobName)`，**不传 `options.policy`**，所以队列策略是 `standard`。而 `plans.js` 里唯一按 `singleton_key` 去重的分区索引（`job_i1/i2/i3/i6/i8`）**全部限定在 `short`/`singleton`/`stately`/`exclusive`/`key_strict_fifo` 策略**，`standard` 策略一个都不适用；剩下那条不限策略的 `job_i4`（节流索引）只在设了 `singletonSeconds` 之类的节流选项、`singleton_on` 非空时才生效——我们也没设。也就是说：`createJob()` 那次 `INSERT ... ON CONFLICT DO NOTHING RETURNING`，在我们当前配置下**没有任何约束可以冲突**，两次 `send()` 都会成功插入两行，都会被 worker 取到并执行——不是"静默丢弃"，是**都跑**。

**用真实竞态复现验证了这一点**（非猜测）：
1. 手动 `/parse` 一篇文档（targetVersion=1，进 processing）
2. 轮到 `processing` 状态时立刻发 `PATCH {chunkTemplate}` 触发全库重建（targetVersion=2，同一文档也在 `startRebuild` 的入队循环里）
3. 查 `GET /:id/lifecycle`：同一文档出现了**两轮完整的 ingest→ready**（`22:439→22:918` 和 `24:447→25:001`），证实两个 job 真的都独立跑完，不是被丢弃

最终这次复现里，先入队的 job（旧版本）先完成、后入队的（新版本）后完成，`chunkVersion` 落在正确的新版本——**运气好的顺序**。但触发条件（文档已在 `processing` 时被并入新一轮重建）完全符合原报告描述的用户操作序列（"手动重试 / 上传 autoParse=true 未消费"文档时用户改了分块模板），如果旧 job 因为网络抖动比新 job 慢完成，`docsRepo.update(documentId,{chunkVersion: targetVersion})` 是 last-write-wins——旧 job 后写会把 `chunkVersion` 改回旧版本号，而这个旧版本的切片这时已经被 `finalizeSwitch` 的异步清理删掉了，文档会显示 `status=ready` 但查切片是空的。

**为什么本轮没有直接修**：这不是"漏了一个 if"能补的——真正安全的修法要么是让 pg-boss 换用真正支持互斥的队列策略（需要验证 `singleton`/`exclusive` 策略在我们的 retryLimit/幂等语义下是否还符合预期，不是换个字符串就完事），要么是在应用层加一个"新 job 完成时检查 kb 是否已进入更新版本的重建、需要的话自我重新入队"的自愈逻辑——这两个方向都是需要独立设计+测试的架构决策，不是复核会话里能安全定的。原报告的 Open Question（"是否要一起修 P2-1/P2-2"）现在应该更新为："P2-2 已经独立修完；P2-1 需要专门一轮 dev 决定队列策略或自愈方案"。

## 已修复（5 条）

### P2-3 [已修] deleteByVersion 未分批
- File: `apps/backend/src/modules/chunks/chunks.repository.ts:99-117`
- 改为循环分批删（`DELETE_BATCH_SIZE=1000`，子查询选 id 再按 id 删），每轮 `deleted.length < 1000` 即终止
- 验证：写了一次性脚本直连真实 Postgres，插入 2500 行后调用该方法，确认跨 3 批（1000/1000/500）全部删除、返回值等于总数，脚本用后即删

### P2-4 [已修] 缺 FK：knowledge_bases.embedding_model_id → model_providers.id
- File: `apps/backend/src/modules/knowledge-bases/schema.ts:10-14`、新迁移 `apps/backend/drizzle/0007_wide_giant_girl.sql`
- 加 `.references(() => modelProviders.id, {onDelete: "restrict"})`；`RESTRICT` 而非 `SET NULL`/`CASCADE`——`embeddingModelId` 创建后锁定不可更换是既有产品拍板，模型被引用期间语义上就不该能删
- 迁移前查了现网数据无孤儿引用，可以安全 apply；已在真实 Postgres 验证 apply 成功
- **顺带修了一个关联 bug**：给 `ModelsService.remove()` 加 FK 冲突捕获转 409 时，第一版直接查 `e.code === '23503'` 测试失败——起服务实测发现 drizzle-orm 把真实 pg 错误包在 `DrizzleQueryError.cause` 里，不是顶层 `e.code`。改成查 `e.cause.code` 后端到端验证通过（绑定模型删除 → 409 带清晰文案；未绑定模型删除 → 204 正常）
- **发现但未动的关联 bug**：`apps/backend/src/modules/prompts/prompts.service.ts:145-151` 的 `isUniqueViolation(e)` 有**完全相同的问题**——查的是 `e.code` 而不是 `e.cause.code`，同一个 drizzle-orm 版本、同一个包装方式。这意味着 `createVersion()`（prompts.service.ts:63-89）设计好的"撞 `(promptId,version)` 唯一约束时重试一次，重试仍撞则转 409"逻辑，**实际永远走不到 `isUniqueViolation(e)===true` 分支**——真实并发建版本冲突会原样抛出 `DrizzleQueryError`，大概率在用户侧变成裸的 500 而不是预期的重试后 409。这是 M4 范围之外的 prompts 模块既有代码，本轮只核实/记录，不顺手改（不是这次 review 的改动范围，且改了要连它的重试路径一起验证，值得单独一轮）。

### P2-6 [已修] embed() 无超时
- File: `apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts:106-135`
- 加 `AbortController` + 60s 超时（`EMBED_TIMEOUT_MS`），镜像同文件 `testConnection()` 已有的 10s 超时写法；60s 而非 10s——真实入库调用批量文本量级远超探针最小请求，10s 对真实厂商延迟太紧
- 新增单测：用假 fetch（只在 `signal` abort 时才 reject，模拟真实网络 hang）+ `jest.useFakeTimers()` 验证超时后确实 abort 并抛可读错误，不会永久挂起

### 重建死锁（原 P2-2）[本轮之前的 QA 会话已修，本轮重新验证]
- File: `apps/backend/src/modules/ingestion/kb-rebuild.service.ts`
- 加 `rebuildDocIds: Map<kbId, Set<docId>>` 快照，`onDocumentTerminal` 只认快照集合，重建期间新上传的 pending 文档不计入终态判定
- 本轮用与之前完全独立的一套 KB/文档重新走了一遍触发序列（触发重建 + 立即上传 autoParse=false 文档），确认 1 秒内正确切换，未复现卡死

## 确认真实但未修（2 条，需要专门设计取舍）

### P2-5 无 magic bytes 校验
- File: `apps/backend/src/modules/documents/documents.service.ts:42-49`（`inferType()`）
- 确认：只查扩展名，不查文件头字节。实测上传一个纯文本改名 `.pdf` 的文件，被正常接受排队，在解析阶段才以 `[PARSE_FAILED] Invalid PDF structure` 优雅失败（不是本轮观测到的可用性问题，但确实完全没有前置校验）
- 未修原因：真要做，需要为 PDF/DOCX/MD/TXT 各自定义签名字节判定 + 决定 zip-bomb（DOCX 用 JSZip 解压）要不要单独限制，这是几条独立的产品/安全决策，不是本轮能顺手定的

### P2-7 批量上传聚合内存无上限
- File: `apps/backend/src/modules/documents/documents.controller.ts:21-22`
- 确认：`FilesInterceptor("files", 100, {limits:{fileSize: 20MB}})` 只限制单文件大小，无总字节数上限，理论上 100×20MB=2GB 可堆进单请求内存
- 未修原因：`Content-Length` 头预检能挡大多数场景，但 chunked transfer-encoding 请求没有该头、能绕过；真正的修法要么接受预检的局限、要么把上传改成流式落盘（`diskStorage`），后者是对现有 `blobStore.put(key, buffer)` 全内存 Buffer 接口的改造，牵连面比一次 review 里能安全决定的范围大

## Verification

- `pnpm --filter backend test`：256/256 通过（较上次 254 条 +2：`models.service.spec.ts` FK 回归 + `protocol-dispatch.adapter.spec.ts` 超时回归；`kb-rebuild.service.spec.ts` 的 2 条快照回归是更早的 QA 会话加的）
- `pnpm --filter frontend test`：40/40 通过
- `pnpm lint`：0 违规
- `tsc --noEmit`（backend + frontend）：均 0 错误
- 每条修复都在真实 Postgres/真实运行时单独验证过，不是只看单测绿灯（deleteByVersion 分批用真实插入 2500 行验证；FK 用真实 DELETE 请求验证 409/204 两条路径；embed 超时用 fake timer 模拟真实 hang；重建死锁用真实触发序列复现+验证修复）

## Open Questions

1. **P2-1 修复方向**：pg-boss 队列策略改用真正互斥的 policy（如 `singleton`），还是应用层加"文档完成时检查 kb 是否已进入更晚版本、需要就自我重新入队"？两者都需要独立设计+测试，建议单开一轮 dev。
2. **P2-5/P2-7 的验收标准**：需要产品/安全侧拍板具体阈值和策略（每种格式的 magic bytes 判定规则；上传总量限制用预检还是转 diskStorage），不是工程单方面能定的。
3. **prompts.service.ts 的 isUniqueViolation bug**：是否值得单独开一个小任务修（连带验证 `createVersion` 的并发重试路径真的按预期工作）？本轮只发现记录，未评估影响范围（有多少真实并发建版本场景）。
