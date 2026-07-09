# Diff Report — spec.md vs peer-spec.md

WARNING: peer-spec.md 是自我二次复查产出,不是真正独立的 Codex 调查(Codex 额度耗尽,用户确认后按技能"peer 不可用"分支执行)。以下不是"两个独立视角的分歧辩论",是"自查发现的具体错误/缺口",全部按代码证据核实后直接采纳,disposition 统一记 `patched`。

## 1. `apps/frontend/src/api/client.ts` 的 `testRetrieval()` 已存在

- **host spec 原话**:"加 `postRetrievalTest()` 或等价请求函数"
- **代码证据**:`apps/frontend/src/api/client.ts:349-351` 已有 `export const testRetrieval = (body) => postJson("/api/retrieval/test", body, RetrievalTestRequestSchema, RetrievalTestResponseSchema)`
- **disposition**: `patched` — spec.md 对应行改为"无需改动,直接调用既有函数"

## 2. `docName` 的 JOIN 归属未落实到具体文件

- **host spec 原话**:只在 Design approach 提了一句"JOIN documents 取 docName"(继承自 008 流程图第 9 步),Changes-by-file 没有任何一行说明这个 JOIN 具体写在哪
- **代码证据**:`apps/backend/src/modules/chunks/chunks.module.ts:6` 已 `imports: [DocumentsModule]`;`chunks/schema.ts:3` 已 `import { documents } from "../documents/schema"`;`documents.repository.ts` 没有按 id 批量取 name 的方法
- **裁决**:JOIN 应该写在 `ChunksRepository.searchByVector`/`searchByKeyword` 内部(`leftJoin documents`),不新增 `retrieval → documents` 的依赖边,也不需要新建 `DocumentsRepository` 方法
- **disposition**: `patched` — spec.md 的 `chunks.repository.ts` 改动行已补充说明

## 3. `packages/contracts/src/m2-schemas.test.ts` 遗漏在测试改动清单

- **host spec 原话**:测试表只列了 4 个 `apps/backend/test/*.spec.ts`,没提这个契约包自带的 schema 测试文件
- **代码证据**:`packages/contracts/src/m2-schemas.test.ts:37-53,112-117,161-163` 已有 `RetrievalTestRequestSchema`/`RetrievalTestResponseSchema` 的合法/边界值用例,新增 `rerankThreshold` 字段虽不破坏现有 fixture(optional),但应比照现有 `threshold out of range` 用例补一条对称测试
- **disposition**: `patched` — spec.md 测试表已加入这一行,并补充 `models.service.spec.ts` 需要 `rerankTexts` 用例这一同类遗漏

## 未发现分歧的部分

- `RetrievalService` 消费方范围(只有 controller/module 两处)、`models.service.spec.ts` 存在性、migration 编号、三类既有测试模式(A 纯函数/B service-mock-repo/C e2e-repo-fake)、模块依赖无环判断——二次复查未发现反例,host spec 结论保留。

## 汇总

3 项修正,disposition 均为 `patched`,已直接体现在最终 `spec.md` 里。0 项 `escalated`,不需要用户裁决新的分歧。3 项既有 Risks(仓储不单测先例、drizzle-kit 生成列支持情况、rerank 分数越界处理)复查后依然是待 plan 阶段处理的开放项,不是分歧,是本来就需要在写 plan 时拍板的实现细节。
