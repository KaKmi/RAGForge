# Dev Context

## Test Command
`pnpm test`（turbo：contracts vitest + backend jest + frontend vitest）

## Code Conduct
- 约定源：docs/design/003（monorepo 布局、依赖边界、端口/适配器）、001/002。
- TS strict；Prettier（semi, double-quote, printWidth 100, trailingComma all）；ESLint 9 flat + typescript-eslint + no-restricted-imports 边界。
- 依赖边界（不变量，lint 强制）：apps/frontend 只能 import @codecrush/contracts；contracts 不得依赖 apps；共享包只依赖 zod。
- Conventional Commits，按 Story 提交。

## Pattern References
### 全部 Story
- Reference: 无（greenfield，仓库仅有 docs + 原型 HTML）。已搜 apps/ packages/ → none found。
- 权威依据 = plan.md（每步含完整代码）+ docs/design/003。

## Waves
Story 0→6 严格顺序（每 Story 依赖前者）：单 Story 顺序波次，无并行。
- 0 根 → 1 tooling → 2 contracts → 3 infra → 4 backend(依赖2,3) → 5 frontend(依赖2,4) → 6 验收。

## 环境
Node v24.18.0（≥22 OK）、pnpm 9.13.2、Docker 29.6.1 + compose 5.3.0。

## 审查方式
harness 规则限制未 spawn 子代理；per-story 采用 fallback 自审（冷读 diff + 验收对照），报告如实标注。
