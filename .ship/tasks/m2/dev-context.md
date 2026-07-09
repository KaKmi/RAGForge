# Dev Context — M2

## Test Command
- `pnpm test`（turbo run test，全量）
- `pnpm lint`（eslint，边界规则必须 0）
- 单包：`pnpm --filter @codecrush/{backend|frontend|contracts} test`

## Code Conduct
- TypeScript strict；Prettier（semi, 双引号, printWidth 100, trailingComma all）
- 后端：NestJS 11 模块化，端口/适配器 DI，域内 schema.ts 纯表定义
- 前端：React 19 + antd 6 + react-router-dom v7，ConfigProvider zhCN + theme token
- 契约：`packages/contracts` 只依赖 zod，`export const XSchema = z.object({...}); export type X = z.infer<typeof XSchema>;`
- 跨域只走 barrel exports，不直接 import adapters/
- Conventional Commits，按 story 提交
- 不软化测试断言——修代码不修测试（除非测试模式本身需迁移）

## Pattern References

### Story 1 (backend global config + migration)
- Reference: `apps/backend/src/modules/users/users.controller.ts`
  - Why analogous: M1 手写 safeParse 模式，Story 1 迁移到 ZodValidationPipe
  - Mirror: @Controller + @Get/@Patch + @Body + service 注入
  - Deviations: safeParse → createZodDto / pipe
- Reference: `apps/backend/test/auth.e2e.spec.ts`
  - Why analogous: e2e 测试模式（supertest + Test.createTestingModule）
  - Mirror: 全局 guard 注册、mock service、路径断言
  - Deviations: 路径加 /api 前缀、加 setGlobalPrefix + useGlobalPipes 到 test setup
- Reference: `apps/backend/src/main.ts`
  - Why analogous: bootstrap，Story 1 扩展加 setGlobalPrefix + Swagger

### Story 2 (contracts)
- Reference: `packages/contracts/src/users.ts`
  - Why analogous: 标准 schema 写法
  - Mirror: `export const XSchema = z.object({...}); export type X = z.infer<typeof XSchema>;`
- Reference: `packages/contracts/src/index.ts`
  - Why analogous: barrel re-export

### Story 3 (backend skeleton)
- Reference: `apps/backend/src/modules/users/users.module.ts`
  - Why analogous: 标准三件套模块
  - Mirror: @Module({controllers, providers, exports?})
- Reference: `apps/backend/src/modules/traces/traces.controller.ts`
  - Why analogous: controller + 防御性校验
  - Deviations: skeleton 返回 mock/空态，无 repository

### Story 4 (frontend shell)
- Reference: `apps/frontend/src/app/App.tsx`
  - Why analogous: 现有路由 + Layout，Story 4 扩展为嵌套路由
  - Mirror: Layout + Sider + Menu + Routes/Route
  - Deviations: Sider dark 主题、嵌套 Outlet、14 路由
- Reference: `apps/frontend/src/main.tsx`
  - Why analogous: ConfigProvider + BrowserRouter 已配

### Story 5 (pages)
- Reference: `apps/frontend/src/pages/LoginPage.tsx` / `HomePage.tsx`
  - Why analogous: 现有占位页，Story 5 重写/扩展
  - Mirror: 函数组件 + antd 组件

## Waves
- Wave 1: [Story 0] — docs revision（前置，无代码依赖）
- Wave 2: [Story 1] — backend global config + migration（安全相关，单独审）
- Wave 3: [Story 2] — contracts（基座，无依赖）
- Wave 4: [Story 3] — backend skeleton modules（依赖 1+2）
- Wave 5: [Story 4] — frontend app shell（无后端依赖）
- Wave 6: [Story 5] — frontend pages（依赖 4）
- Wave 7: [Story 6] — API client + SSE（依赖 2+3）
- Wave 8: [Story 7] — integration verification（依赖全部）

轻量对抗档：Story 1（auth 安全）单独 peer 审；其余收尾一次 review 覆盖全量 diff。
