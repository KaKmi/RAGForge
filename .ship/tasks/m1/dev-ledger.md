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
  Commits: faf1892921600e8fecb66b941cb214948ea26175
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
