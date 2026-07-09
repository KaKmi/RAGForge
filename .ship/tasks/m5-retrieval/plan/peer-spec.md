WARNING: Second spec was self-generated, not independent — Codex peer dispatch unavailable (用户确认"codex 没有额度了"),按 `/ship:design` 技能"peer 不可用"分支执行:自查 placeholder/矛盾/覆盖面/歧义,而非真正独立调查。

# 二次复查 — 对 spec.md 的修正与补充

## 修正 1:`apps/frontend/src/api/client.ts` 已经有 `testRetrieval()`,host spec 写错了

Host spec 的 Changes-by-file 表里写"加 `postRetrievalTest()` 或等价请求函数",**这个函数已经存在**:

```ts
// apps/frontend/src/api/client.ts:349-351
export const testRetrieval = (body: RetrievalTestRequest): Promise<RetrievalTestResponse> =>
  postJson("/api/retrieval/test", body, RetrievalTestRequestSchema, RetrievalTestResponseSchema);
```

`RetrievalTestPage.tsx` 只是还没调用它(现在用本地 `computeRtResults` mock)。**`client.ts` 本次不需要改动**,前端重写时直接 `import { testRetrieval } from "../../api/client"` 调用即可。这是一个实打实的错误,不是分歧——host spec 应该改成"无需改动,页面直接调用既有的 `testRetrieval`"。

## 修正 2:`docName` 的 JOIN 应该在 `ChunksRepository.searchByVector`/`searchByKeyword` 内部做,不是另一个独立步骤

Host spec 的 Design approach 里写"JOIN documents 取 docName"是 008 流程图里独立的第 9 步,但没有落到 Changes-by-file 的任何一行具体改动里,没说这个 JOIN 具体在哪个文件、哪个函数里发生——这是一个真实的覆盖面缺口,不只是措辞问题。

核查 `apps/backend/src/modules/chunks/chunks.module.ts:6`:`imports: [DocumentsModule]`——`chunks` 模块本来就依赖 `documents` 模块。`apps/backend/src/modules/chunks/schema.ts:3`:`import { documents } from "../documents/schema"`(chunks 的 FK 定义已经引用了 documents 表对象)。

**结论**:`docName` 的解析应该直接写进 `ChunksRepository.searchByVector`/`searchByKeyword` 的 SQL 查询里(`.leftJoin(documents, eq(chunks.docId, documents.id))`,select 时带上 `documents.name as docName`),而不是在 `PgHybridRetriever` 里对最终 topN 结果再单独查一次 `DocumentsRepository`。理由:
1. `chunks.repository.ts` 本来就能拿到 `documents` 表(FK 关系已经建立,`chunks.module.ts` 已经 import 了 `DocumentsModule`),不需要新增跨模块依赖。
2. 检查过 `apps/backend/src/modules/documents/documents.repository.ts`,**没有现成的"按一批 docId 批量取 name"的方法**(`inArray` 唯一的用法是按 `kbId` 分组,不是按 `id` 查),如果要在 `PgHybridRetriever` 里单独查,还要新增一个 `DocumentsRepository` 方法,并且让 `retrieval` 模块多背一个对 `documents`/`DocumentsModule` 的依赖——008 定的模块边界里没有这条边,不应该无故新增。
3. 直接在 `ChunksRepository` 里 JOIN,`retrieval` 端完全不需要关心 `docName` 从哪来,拿到的候选行天然带着这个字段,更符合"retrieval 只经 `ChunksService` barrel 拿现成数据"的边界意图。

**修正后的 Changes-by-file 行**:
`apps/backend/src/modules/chunks/chunks.repository.ts` 的改动说明应补充:"`searchByVector`/`searchByKeyword` 的返回行直接 `leftJoin documents` 带出 `docName`,不新增 `documents` 相关的新依赖边"。

## 修正 3:`packages/contracts/src/m2-schemas.test.ts` 遗漏在 host spec 的测试改动表里

Host spec 的"测试"改动表只列了 4 个 `apps/backend/test/*.spec.ts` 文件,**遗漏了 `packages/contracts/src/m2-schemas.test.ts`**——这个文件已经有 `RetrievalTestRequestSchema`/`RetrievalTestResponseSchema` 的合法/非法用例(第 37-53、112-117、161-163 行)。加 `rerankThreshold: z.number().min(0).max(1).optional()` 是可选字段,不会让现有 fixture(`valid.retrievalReq` 没有这个字段)校验失败,**现有测试不会破**,但应该补一条新用例,镜像现成的 `threshold out of range` 测试(第 161-163 行)写 `rerankThreshold out of range` 拒绝用例,保持这个契约字段和其它字段一样有边界值测试覆盖。这个文件要加进 plan 的改动清单。

## 复查未发现新问题的部分(确认 host spec 站得住)

- `grep -rn "RetrievalService\b"` 确认目前只有 `retrieval.controller.ts`/`retrieval.module.ts` 两处消费 `RetrievalService`,没有隐藏的第三方调用者需要担心签名变更(`test()` 改 `async`)会波及。
- `models.service.spec.ts` 确实存在(`apps/backend/test/models.service.spec.ts`),host spec 提到 `rerankTexts` 要镜像 `embedTexts` 的模式是对的,plan 阶段应该在这个文件里加 `rerankTexts` 的用例,而不是漏掉(host spec 的测试表没有明确点名这个文件要加 `rerankTexts` 测试,只笼统提了"镜像 embedTexts",这里补一句明确:`apps/backend/test/models.service.spec.ts` 需要新增 `rerankTexts` 用例)。
- Migration 编号、既有测试惯例(模式 A/B/C 三分法)、模块依赖分析(`retrieval` 无环风险,可以直接三个 `imports`)复查后认为 host spec 的结论都有代码依据支撑,没有找到反例。

## 结论

以上 3 项修正(client.ts 已存在不用改、docName JOIN 归属、m2-schemas.test.ts 遗漏)已经反馈,应合并进最终 spec.md。没有发现需要用户裁决的新分歧点——原 host spec 里已经标注的 3 个 Risks(仓储不单测的先例、drizzle-kit 生成列支持情况、rerank 分数越界处理)复查后依然成立,继续保留待 plan 阶段处理。
