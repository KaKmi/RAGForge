Story 1: "003 文档更新 + contracts 用户 DTO（M1a）" — complete
  Commits: 0222eadc8164ce38b4b9daec34fef7cca29e6fef
  Files:
    .ship/tasks/m1/dev-context.md
    docs/design/003-code-organization.md
    packages/contracts/src/index.ts
    packages/contracts/src/users.test.ts
    packages/contracts/src/users.ts
  Produces:
    UserProfileSchema: ZodObject; type UserProfile = { id: string; email: string; displayName: string; status: string; createdAt: string; updatedAt: string }
    ChangeOwnPasswordRequestSchema; type ChangeOwnPasswordRequest = { currentPassword: string; newPassword: string } with newPassword 8-128
    ChangeOwnPasswordResponseSchema; type ChangeOwnPasswordResponse = { status: "ok" }
  Concerns: none

Story 2: "users 数据层 + 迁移 + seed（M1a）" — complete
  Commits: 5f6c792fb48e1634b1e4f79378cc71f8306dbd3b
  Files:
    apps/backend/.env.example
    apps/backend/drizzle/0001_spooky_ultimatum.sql
    apps/backend/drizzle/meta/0001_snapshot.json
    apps/backend/drizzle/meta/_journal.json
    apps/backend/package.json
    apps/backend/src/app.module.ts
    apps/backend/src/db/schema.ts
    apps/backend/src/db/seed.ts
    apps/backend/src/modules/users/password.ts
    apps/backend/src/modules/users/schema.ts
    apps/backend/src/modules/users/users.module.ts
    apps/backend/src/modules/users/users.repository.ts
    apps/backend/src/modules/users/users.service.ts
    apps/backend/test/users.service.spec.ts
    package.json
    pnpm-lock.yaml
  Produces:
    users table + type UserRow = typeof users.$inferSelect
    hashPassword(plain: string): Promise<string>; verifyPassword(hash: string, plain: string): Promise<boolean>
    normalizeEmail(raw: string): string
    UsersService.getProfile(userId: string): Promise<UserProfile>
    UsersService.validateCredentials(email: string, password: string): Promise<UserProfile | null>
    UsersService.changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<void>
    UsersModule exports UsersService; command pnpm db:seed
  Concerns: pnpm v11 returned ERR_PNPM_IGNORED_BUILDS after installing native/dev tool packages, but backend can require argon2 and backend Jest/build/ESLint passed.

Story 3: "登录 + 全局 guard + 用户端点（M1b）" — complete
  Commits: 824b908, 91735fa
  Files:
    apps/backend/.env.example
    apps/backend/package.json
    apps/backend/src/app.module.ts
    apps/backend/src/modules/auth/auth.controller.ts
    apps/backend/src/modules/auth/auth.module.ts
    apps/backend/src/modules/auth/auth.service.ts
    apps/backend/src/modules/auth/jwt-auth.guard.ts
    apps/backend/src/modules/health/health.controller.ts
    apps/backend/src/modules/users/users.controller.ts
    apps/backend/src/modules/users/users.module.ts
    apps/backend/src/platform/config/config.schema.ts
    apps/backend/src/platform/config/config.service.ts
    apps/backend/src/platform/security/authenticated-user.ts
    apps/backend/src/platform/security/public.decorator.ts
    apps/backend/test/auth.service.spec.ts
    apps/backend/test/config.schema.spec.ts
    apps/backend/test/jwt-auth.guard.spec.ts
    packages/contracts/src/auth.test.ts
    packages/contracts/src/auth.ts
    packages/contracts/src/index.ts
    pnpm-lock.yaml
  Produces:
    POST /auth/login
    GET /users/me
    PATCH /users/me/password
    global JwtAuthGuard
    Public() decorator and AuthenticatedUser type
    env JWT_SECRET/JWT_EXPIRES_IN
    expiresInSeconds(expr: string): number
  Concerns: none

Story 4: "supertest 矩阵 + 消费者适配 + 运行时验收（M1b 收尾）" — complete
  Commits: ba53da7
  Files:
    README.md
    apps/backend/package.json
    apps/backend/scripts/verify-observability.mjs
    apps/backend/test/auth.e2e.spec.ts
    pnpm-lock.yaml
  Produces:
    global guard HTTP matrix via supertest
    observability verify script authenticates with AUTH_TOKEN or demo login
    README documents db:seed and M1 trace auth behavior
  Concerns: none
