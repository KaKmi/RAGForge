# Concerns — M4 dev

- T4 (PASS_WITH_CONCERNS, Codex): 依赖版本 brief 未钉死，实际解析 pdf-parse ^2.4.5（major v2）而 @types/pdf-parse 仅有 ^1.1.5 —— T13 解析器实现时必须实测 v2 的 import/API 形态（CJS/ESM、默认导出）。
- T12 reviewer 独立性说明: Codex 用量限额（当日）导致 T12 复审改用同 provider（Claude opus）fresh session —— 独立性弱于跨模型评审，已按 skill 规定记录。
- T12 [UNVERIFIABLE]（host 裁定）: embedTexts 不在 models 域内校验「模型是 embedding 类型且 enabled」——由消费方 T15（读 kb 配置）与 T18（建库校验 type=embedding && enabled）负责把关；T18 评审时须确认该校验存在。
- T13 (PASS_WITH_CONCERNS): PDF 真实 happy-path（含文字的合法 PDF → 非空 text）无法在当前 Jest 配置下经真实库验证（pdfjs-dist 需 NODE_OPTIONS=--experimental-vm-modules），只有错误路径经真实库覆盖 —— T15 或 QA 阶段需用真实 PDF 手动/e2e 验证一次完整链路（spec 验收标准本就要求 curl 全链路验证）。
- Wave 2 期间已知计划内破坏: 契约删除使 documents.controller.ts / chunks.controller.ts / 前端 client.ts / skeleton.e2e.spec.ts 暂不编译（skeleton e2e 红）——由 T19/T20/T22/T23 重写解决，最终回归必须全绿。
- Wave 2 起 reviewer 独立性: Codex 当日限额，T2/T5/T6/T13 及 T12-fix 复审均为同 provider（Claude opus）fresh session。
- T9 (PASS_WITH_CONCERNS, plan-mandated): appendLifecycleStage 是读-改-写非原子追加（brief 样例如此）——并发写同一文档时可能丢 lifecycle 项；预期调用面（每文档单 worker, singletonKey=documentId）下风险低。设计负责人后续可改 SQL 原子追加。
- T10 (plan-mandated): findPage 的 q ILIKE 未转义 %/_ 通配符——搜索字面 "50%" 会变通配匹配。drizzle 参数绑定无注入风险，纯行为怪癖，M5 检索/搜索 UX 负责人裁量。
- T14 host 裁定（plan-mandated 样例代码缺陷，已修）: F1 首标题前正文被丢弃（数据丢失，不可接受）→ 以 section="" 补发；F2 跳级标题产生空路径段 "a >  > c" → join 时过滤空段。plan 文本未主张这两个行为，属样例代码疏漏，不算偏离设计。
- T15 (PASS_WITH_CONCERNS，host 裁定): (a) chunkCount=0 时管线静默成功且 replaceVersion 清空该版本——T16 处置为失败态（可读错误），因「ready 但 0 切片」对用户是误导；(b) embedBatchSize≤0 会死循环，但 T4 config schema 已拒绝非正数，接线用 config 即安全；(c) 测试未断言跨批向量与 chunk 的一一对应（实现正确，覆盖弱），记录不阻塞。
- ~~T16 (plan-mandated): ingest/running 项永不闭合~~ ✅ 已修（b157ed6，用户 QA 坐实后 completeLifecycleStage 闭合终态）。
- T24: 新建按钮双击竞态可能双 POST（第二次 409 无可见影响，低危不修）；Modal 打开前同步等待 getModels（brief 如此）。
- T22: batch-delete e2e 断言 201（landed T20 controller 无 @HttpCode，Nest POST 默认 201；brief 样例写 200 系笔误，无 spec AC 约束）。
- 【QA 待办】spec 验收标准 3（真实 PDF 上传→ready→查切片全链路 curl 验证）与标准 4 的真实重建链路未在 dev 阶段运行时验证——单测/e2e 均为假仓储/假队列。需 /ship:qa 起 infra + 真实 embedding 模型跑一遍（T13 的 PDF happy-path Jest 限制也在此一并覆盖）。
- 【用户 QA 三修，b157ed6】①中文文件名 busboy latin1 误解码 → decodeOriginalName 还原；②lifecycle ingest 阶段闭合（上一条）；③docsCount/chunksCount 占位 0 → 分组计数真实填充（T18/T19 的「留待补齐」已补齐）。后端需重启生效；已入库的旧文档名/未闭合的旧 lifecycle 项不回溯修复。
