# Dev Context — M6 Prompt 管理

## Test Command

- 全量：`pnpm test`（turbo run test）
- 单包：`pnpm --filter @codecrush/contracts test`（vitest）/ `pnpm --filter @codecrush/backend test`（jest, @swc/jest）/ `pnpm --filter @codecrush/frontend test`（vitest）
- Lint：`pnpm lint`（ESLint + 依赖边界，必须 0）
- Build：`pnpm build`（turbo 全量）
- DB：`pnpm db:generate` / `pnpm db:migrate` / `pnpm db:seed`（均 filter @codecrush/backend）
- 依赖服务：`docker compose -f infra/docker-compose.yml --profile infra up -d --wait`

> Backend jest `moduleNameMapper` 把 `@codecrush/contracts` 映射到源码 `src/index.ts`——后端测试无需先 build contracts。前端/契约 vitest 同理直接跑源码。

## Code Conduct

- TS strict；Prettier（`semi: true`, 双引号, printWidth 100, trailingComma all）。
- 依赖边界（ESLint 强制）：依赖方向朝下、无环；前端只 import `@codecrush/contracts` + `@codecrush/otel-conventions`；contracts 只依赖 `zod`；`@codecrush/otel` 仅后端。
- 契约单一来源：前后端 DTO 走 `packages/contracts` 的 Zod schema。
- 端口/适配器：域模块拥有 port（interface），适配器经 NestJS DI token 注入。
- 域内 `schema.ts` 零 service 引用（防循环 import）。
- 迁移显式命令，不在应用启动时静默执行。
- Conventional Commits，按 story 提交；提交/推送仅在被要求时进行。
- 不得软化测试断言——改代码/改测试体（契约演进的合法更新）。

## 对抗强度

**轻量对抗**（CLAUDE.md：M6 = Prompt 管理，CRUD/配置型）。dev = host 直接实现每 story（单 story 顺序波），**不做每 story peer review**；收尾跑一次 `/ship:review` 覆盖全量 diff。理由：design 阶段已 peer 独立调查 + diff（diff-report.md D1–D16 已裁决），host 自查 plan（plan.md 末尾自查表）代替 execution drill。

## Pattern References

### Story 1 — 契约 + 共享纯逻辑
- Reference: `packages/contracts/src/prompts.ts`（现状，要改）+ `packages/contracts/src/index.ts`（barrel，追加 export）+ `packages/contracts/src/m2-schemas.test.ts`（测试 fixture 范式）。
- Mirror: zod `z.object`/`z.enum` schema 形状；`export type X = z.infer<typeof XSchema>`；测试用 `valid` fixture 对象 + `expect(() => Schema.parse(bad)).toThrow()`。
- Deviations: prompt-template.ts 是纯函数零 zod 依赖（contracts 内允许，不引新依赖）；diffPromptBodies 迁自 `apps/frontend/src/mocks/prompts.ts:180-210` lineDiff 逐字照搬。

### Story 2 — DB schema
- Reference: `apps/backend/src/modules/users/schema.ts`（pgTable 范式：uuid primaryKey defaultRandom、text notNull unique、timestamp notNull defaultNow、`export type XRow = typeof x.$inferSelect`）+ `apps/backend/src/db/schema.ts`（barrel，追加 `export * from "../modules/prompts/schema";`）+ `apps/backend/drizzle.config.ts`（schema: `./src/db/schema.ts`，out: `./drizzle`）。
- Mirror: 表定义零 service 引用；`.$inferSelect`/`.$inferInsert` 类型导出。
- Deviations: 用 `jsonb().$type<string[]>()`（D5 对齐 001:88）+ `uniqueIndex(promptId, version)` + `index(promptId, status)`（D8）+ `updatedBy` 列（D16）。

### Story 3 — Repository + Service
- Reference: `apps/backend/src/modules/users/users.repository.ts`（`@Injectable()` + `@Inject(DRIZZLE) db: DB` + drizzle query 范式 `db.select().from(x).where(eq(x.id, id)).limit(1)`）+ `apps/backend/src/modules/users/users.service.ts`（service 注入 repo + `toProfile(row)` 映射 + `NotFoundException` + `toISOString()` 序列化）+ `apps/backend/test/users.service.spec.ts`（mock repo `jest.fn()` per method + `new Service(repo)` 构造 + 行为断言）。
- Mirror: repo 方法返 `Promise<...Row | undefined>`；service `toX(row)` 把 Date → ISO string；service spec 用 `as unknown as Repo` 构造 mock repo。
- Deviations: `publishVersion` 用 `this.db.transaction` 单事务（archive 旧 prod + set 新 prod + 更新 currentVersionId + updatedBy + updatedAt）；`createVersion` retry 一次 unique 冲突（D8，`isUniqueViolation(e)` 判 `code==="23505"`）；`promote` 先查 status 已 prod → `ConflictException`（D15）。
- **决策（createPrompt 事务）**：plan 末尾 note 推荐 service 内 `this.db.transaction` 直调 drizzle 绕 repo，但 Story 3 service spec 断言 `repo.insertPrompt` + `repo.insertVersion` 被 createPrompt 调用（测试是 AC，权威）。采纳**测试支配**路径：createPrompt 调 `repo.insertPrompt` + `repo.insertVersion` 两步（无 tx），对齐 users.service 无事务范式。原子性风险（v1 draft 失败留孤儿 prompt）plan 已判"可接受 greenfield + 单用户"，记入 concerns。若后续需原子再给 repo 加 tx 参数。

### Story 4 — Controller + e2e
- Reference: `apps/backend/src/modules/users/users.controller.ts`（`@Controller` + `createZodDto` + `@Req() req: AuthedRequest` 取 `req.user.id`/`req.user.email` + `type AuthedRequest = { user: AuthenticatedUser }`）+ `apps/backend/test/skeleton.e2e.spec.ts`（Test.createTestingModule + APP_GUARD JwtAuthGuard + APP_PIPE ZodValidationPipe + `overrideProvider(...).useValue(inMemoryRepo)` + supertest + `token = jwt.sign(PRINCIPAL)`，PRINCIPAL = `{ sub, email }`）。
- Mirror: controller 用 `@HttpCode(201/200)` + `@Param`；e2e 用 `inMemoryRepo`（DB-free）+ `auth()` helper。
- Deviations: prompts e2e 块改测试顺序为「先 POST 建 prompt → 再测 GET versions / POST versions / publish / rollback」（inMemoryRepo 起空，不再依赖 mock p1）；createVersion 测试体改 `{body}`（删 variables/author，D6/D5）+ 断言 `res.body.variables` 非空 + `author === PRINCIPAL.email`。

### Story 5 — 前端
- Reference: `apps/frontend/src/api/client.ts`（`getJson`/`postJson`/`apiFetch` 范式 + typed client + ZodSchema<T> 最小接口避免前端 import zod）+ `apps/frontend/src/pages/admin/PromptsPage.tsx`（现状本地态，要改）+ `apps/frontend/src/mocks/prompts.ts`（mock 数据 + 纯函数，要清理）。
- Mirror: client 用 `getJson(path, schema)` / `postJson(path, body, reqSchema, resSchema)`；publish/rollback 无 body 用 `apiFetch` + `resSchema.parse`。
- Deviations: PromptsPage `useEffect` 挂载调 `getPrompts()`；node/status 经 `NODE_LABEL`/`STATUS_LABEL` 映射中文；diff/extract/render 用共享 `@codecrush/contracts` 纯函数（删本地副本）；"绑定 Agent" tab 空态（M7）。

## Waves

6 story 严格顺序（每 story 单独一波，依赖链：1 契约 → 2 DB → 3 repo+service → 4 controller+e2e → 5 前端 → 6 收尾）。无并行（每 story 依赖前 story 产物 + 共享文件）。

## Pre-flight 决策

1. **createPrompt 事务**（见 Story 3 deviations）：测试支配，无 tx，两步 repo 调用。记 concerns。
2. **findProdVersion 保留**：未用但作为 repo 查询 API 保留（unused class method 不触发 ESLint；M7/M8 列版本可能用）。
3. **seed v1 状态**（Story 6）：选 `status:"prod"` + `currentVersionId` 保 demo 连续性（M2 mock 有 4 个 prod 版本），对齐 plan 标注的"后者"。
4. **前端 currentVersionId 显版本号**（Story 5）：GET versions 后本地 build `id→version` map 映射，不改契约。
