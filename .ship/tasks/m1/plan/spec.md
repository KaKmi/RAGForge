# Spec — M1 用户/认证（两波：M1a 用户基础 / M1b 登录+守卫）

- **Task ID**: m1
- **Scope mode**: full
- **Branch**: main
- **HEAD SHA**: 7fc8c11c25cb78809865a79db42e6f1c4f25cb96
- **承接**: docs/design/001（信任边界/单角色）、002（M1 行）、003（模块边界）；用户拍板：管理面=最小（seed + me + 改自己密码），一个 design 任务两波实现
- **Diff 状态**: 与 peer spec 的 14 处分歧已全部裁决（见 diff-report.md），本文为合并后版本

## Problem / Motivation

**定位**：M1 的 user 指**平台/管理台操作者**（后端系统用户：admin、demo），非 C 端最终用户；C 端接入（若有）是未来独立概念，不复用本表（见 005 Assumptions）。

路线图 M1：登录(JWT)、user 实体、auth guard；RBAC 留 M12 [docs/design/002 波次B M1 行]。验收：demo 账号登录；无 token 接口 401。001 信任边界「浏览器↔后端（JWT + admin 接口鉴权）」[001:158]，当前单角色「admin + demo 用户」[001:35]。现状后端零鉴权。

## Investigation Findings（关键结论，file:line 均亲读）

- **模块归属（diff D1 裁决）**：新建 `modules/users` 叶子模块（仅依赖 persistence）持有 users 表/服务；`modules/auth` 持有登录+guard，依赖 users。理由：将来 `conversations.user_id` 外键需 import users 表 schema，若表在 auth 内违反 003:130「别的模块不 import auth」。**先更新 003**（模块树加 users 叶子；依赖边 `auth → users, config`、`users → persistence`）再动代码（CLAUDE.md 文档先行）。
- **波次依赖（diff D3 裁决）**：/users/me、改密需要 JWT 身份 ⇒ M1a 纯数据层（表/迁移/服务/seed/单测），**全部 HTTP 端点落 M1b**（避免改密接口无鉴权裸奔一波）。
- **横切件位置（diff D4 裁决）**：`@Public()` 装饰器与 `AuthenticatedUser` 类型放 `platform/security/`（所有域→platform 合法 [003:132]；health 不 import auth）。
- env fail-fast：`ConfigModule.forRoot({ validate: envSchema.parse })` [config.module.ts:9-13]；现有 envSchema [config.schema.ts:3-12]。
- Drizzle：DRIZZLE Symbol 提供 `NodePgDatabase<typeof schema>` [persistence.module.ts]；barrel `db/schema.ts` 仅 appMeta [db/schema.ts:1-7]；drizzle.config schema 指向 barrel [drizzle.config.ts:5]；迁移显式 `db:migrate`→tsx src/db/migrate.ts；现有迁移 0000_natural_trish_tilby.sql（不可改，新增 0001）。
- **无 seed 基础设施** ⇒ 新建 src/db/seed.ts + `db:seed`（模式照 migrate.ts：dotenv+Pool+显式命令）。
- main.ts 无全局 guard [main.ts:7-14] ⇒ 全局化走 `APP_GUARD` provider。
- 测试：@swc/jest + moduleNameMapper [jest.config.js]；现有 5 spec 全部直连 controller、不经 guard ⇒ 不受影响，但 **401 语义需 supertest 应用级测试**（diff D8）。
- **guard 受影响消费者清单**：`GET /health`（前端 HomePage + vite 代理仅 /health ⇒ @Public 豁免）；`/traces/*` [traces.controller.ts:11-24] 收保护；**`scripts/verify-observability.mjs` 必改**（AUTH_TOKEN env 优先，否则 demo 凭据登录，带 Bearer 调用）；README M0.5 验证段补 seed+登录。
- PG16 内置 `gen_random_uuid()`，drizzle `uuid().defaultRandom()` 无需 pgcrypto（已验证；plan 仍检查生成 SQL）。

## 选型（有依据）

- **argon2（argon2id）而非 bcrypt**：OWASP 首选、memory-hard；bcrypt 72 字节截断。N-API prebuilds 覆盖 darwin-arm64/linux、Node 22/24；CJS 兼容；@swc/jest 不转换原生模块。参数：`memoryCost 65536, timeCost 3, parallelism 1`。安装失败的降级预案：node:crypto scrypt（dev 波按实际定，spec 首选 argon2）。
- **@nestjs/jwt**：项目 CommonJS+node10（jose v5+ ESM-only 会炸 require）；Nest 官方、HS256 够用。
- **不引 passport**：003 定位 auth 为横切全局 guard [003:130]，薄 `CanActivate`+Reflector 即可。
- **登录标识 = email**（diff D2）：demo 账号 `demo@codecrush.local`；写入/查询前 `trim().toLowerCase()` 规范化；M1 不引 citext。

## Design Approach

### M1a — 用户基础（数据层，无 HTTP）

1. **docs/design/003 更新**（先行）：模块树 `modules/` 加 `users`；依赖边补 `users → persistence（叶子）`、`auth → users、config`。
2. `modules/users/schema.ts`（纯表定义）：`users(id uuid pk defaultRandom, email text unique notNull, display_name text notNull, password_hash text notNull, status text notNull default 'active', created_at/updated_at timestamp notNull defaultNow)`。
3. `db/schema.ts` barrel re-export（保留 appMeta）→ `pnpm db:generate` 产出 0001 迁移（验证含 CREATE TABLE users + unique email，不动 0000）。
4. `modules/users/password.ts`：`hashPassword`/`verifyPassword`（argon2id，上述参数）。
5. `modules/users/users.repository.ts`（注入 DRIZZLE）：findById / findByEmail(normalized) / upsertDemoUser / updatePasswordHash。repository 可返回含 hash 的内部行，**controller/service 出口不可**。
6. `modules/users/users.service.ts`：normalizeEmail；`getProfile(userId)`（sanitized，无 password_hash）；`validateCredentials(email, password) → profile|null`（**未知用户也对固定 dummy hash 跑一次 verify，抑制枚举时序**）；`changeOwnPassword(userId, current, new)`（current 错→UnauthorizedException）；`seedDemoUser`。
7. `src/db/seed.ts` + backend/root `db:seed` 脚本：dotenv+Pool+drizzle，argon2 哈希 `DEMO_USER_PASSWORD`（默认 `CodeCrushDemo123!`），按 normalized email upsert `demo@codecrush.local`（display_name "Demo Admin"），幂等；打印 email 不打印 hash。
8. contracts `users.ts`：`UserProfileSchema {id uuid, email email, displayName min1, status, createdAt datetime, updatedAt datetime}`、`ChangeOwnPasswordRequestSchema {currentPassword min1, newPassword min8 max128}`、`ChangeOwnPasswordResponseSchema {status: literal "ok"}` + z.infer；index 导出；vitest。
9. `UsersModule`（providers+exports: UsersService/UsersRepository，此波无 controller）挂 AppModule。

### M1b — 登录 + 守卫（HTTP 面）

1. env：`JWT_SECRET z.string().min(32)` 必填无默认（fail-fast）；`JWT_EXPIRES_IN z.string().default("12h")`；AppConfigService getters；.env.example 补 JWT_SECRET(dev 值)/JWT_EXPIRES_IN/DEMO_USER_PASSWORD。
2. contracts `auth.ts`：`LoginRequestSchema {email email, password min1}`、`LoginResponseSchema {accessToken min1, tokenType literal "Bearer", expiresIn int positive(秒), user: UserProfileSchema}`；vitest。
3. `platform/security/public.decorator.ts`（`PUBLIC_ROUTE_KEY` + `Public()`=SetMetadata）、`platform/security/authenticated-user.ts`（`AuthenticatedUser {id, email}`）。
4. `modules/auth/auth.service.ts`：调 UsersService.validateCredentials；失败统一 UnauthorizedException("invalid credentials")；成功 `JwtService.signAsync({sub, email})`；返回 LoginResponse（expiresIn 由配置换算秒）。
5. `modules/auth/auth.controller.ts`：`@Public() POST /auth/login`，body 用 LoginRequestSchema.parse（M2 才上 ZodValidationPipe，本波 controller 内 parse，parse 失败 → 400）。
6. `modules/auth/jwt-auth.guard.ts`：Reflector.getAllAndOverride(PUBLIC_ROUTE_KEY,[handler,class])；仅认 `Authorization: Bearer <t>`；缺失/格式错/verify 失败 → UnauthorizedException；成功挂 `request.user: AuthenticatedUser`。AuthModule 注册 `{provide: APP_GUARD, useClass: JwtAuthGuard}`。
7. `modules/users/users.controller.ts`（M1b 才建）：`GET /users/me`（request.user.id→getProfile）、`PATCH /users/me/password`（ChangeOwnPasswordRequestSchema.parse；返回 {status:"ok"}）。
8. HealthController 加 @Public()（import 自 platform/security）；traces 不加。
9. AuthModule：JwtModule.registerAsync（secret/expiresIn 来自 AppConfigService）+ import UsersModule；AppModule 挂 AuthModule。
10. `verify-observability.mjs`：`AUTH_TOKEN` env 优先；否则 `POST /auth/login`（`DEMO_USER_EMAIL`/`DEMO_USER_PASSWORD` 默认=seed 默认）；/traces/* 带 Bearer；401 时报错提示「先 pnpm db:seed」。README M0.5 段补 seed+登录步骤。
11. supertest 应用级测试：小型 Test module（health/auth/users/traces controllers + APP_GUARD + mock DRIZZLE/CLICKHOUSE/UsersService providers + 测试用 JwtModule secret）跑矩阵：/health 无 token 200；/users/me、/traces/hello 无 token 401；坏 token 401；登录→带 token /users/me 200。

## Non-goals / Forbidden Shortcuts

- 不做：RBAC/角色语义、注册、管理他人端点、refresh token、登出/黑名单、前端登录页（M2）、rate limiting、citext、密码重置流。
- **禁止**：/traces/* 标 @Public 保脚本绿；任何响应含 password_hash；JWT_SECRET 代码写死或 schema 默认值；seed 挂启动路径；软化 401 断言；测试只断言"token 形状的字符串"而不过真 guard。

## Acceptance Criteria

1. `pnpm lint`(0) / `pnpm test` / `pnpm build` 全过。
2. `pnpm db:migrate` 建 users 表；`pnpm db:seed` 幂等（二跑无错无重复）。
3. `POST /auth/login` demo 凭据 → 200 `{accessToken, tokenType:"Bearer", expiresIn(秒), user}`；错密码/不存在 email → 统一 401；畸形 body → 400。
4. 无 token：/users/me、POST /traces/hello、GET /traces/:id → 401；GET /health → 200；坏/过期 token → 401。
5. 带 token：/users/me → sanitized profile；PATCH /users/me/password（current 对）→ {status:"ok"}，旧密码登录 401、新密码 200；current 错 → 401。
6. JWT_SECRET 缺失或 <32 → 启动 fail-fast。
7. contracts 仅依赖 zod；边界 lint 0。
8. guard 上线后 `pnpm observability:verify` 全绿（脚本内登录）。
9. 任何 API 响应无 password_hash。
10. docs/design/003 已含 users 模块与新依赖边（M1a 第一步完成）。

## Test Plan

- contracts（vitest）：三组 schema 正反例（含 email 格式、newPassword<8、tokenType≠Bearer、expiresIn 非正整数）。
- backend 单测（jest）：password 真实 hash/verify 往返 + 错密码 false；users.service（validateCredentials 未知用户走 dummy verify——以 mock 计数断言、changeOwnPassword current 错→Unauthorized、profile 无 hash）；auth.service（成功签 token/失败 401）；jwt-auth.guard（@Public 放行、无 header/非 Bearer/坏 token 401、合法挂 request.user）；controllers mock service。
- **supertest 应用级**：401/公开/带 token 矩阵（见 Design 11）。
- 既有 5 spec 不动仍绿。
- 运行时（M1b 收尾）：migrate+seed → 启动 → curl 矩阵（验收 3/4/5/6）→ observability:verify。

## Risks / Unknowns

- argon2 prebuild 安装失败（无网/罕见平台）→ 降级 node:crypto scrypt，dev 波定夺。
- JWT_SECRET 必填导致旧 .env 启动失败——有意 fail-fast，README 显式提示。
- 本地未 seed 时 verify 脚本 401——脚本错误信息指引 `pnpm db:seed`。
- drizzle-kit 迁移文件名随机——plan 以内容（CREATE TABLE users）验证，不硬编码文件名。

## Self-Review

- 无占位符；D1-D14 裁决已全部反映；波次划分依赖单向（M1a 数据层→M1b HTTP）；
- 歧义点定死：email 标识、users 叶子模块、端点全在 M1b、401 统一语义、seed 幂等、expiresIn 秒；
- 反作弊：验收 8 强制真实登录链路；supertest 保证 401 经真 guard 验证。
