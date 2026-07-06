# M1 用户/认证 Implementation Plan

> **For agentic workers:** Use `/ship:dev` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** M1a（Task 1-2）：users 叶子模块数据层 + demo seed；M1b（Task 3-4）：JWT 登录 + 全局 guard + 最小用户端点 + 消费者适配。

**Architecture:** `modules/users` 叶子（仅依赖 persistence）持有 users 表与服务；`modules/auth` 持登录/guard、依赖 users；`@Public()`/`AuthenticatedUser` 放 `platform/security`（health 不 import auth）；DTO 在 `@codecrush/contracts`。文档先行：003 先补 users 模块与依赖边。

**Tech Stack:** NestJS 11、Drizzle 0.45、argon2（argon2id）、@nestjs/jwt（HS256）、Zod 4、@swc/jest + supertest、vitest（contracts）。

## Global Constraints

- 环境：Node >= 22、pnpm 9、Docker（含 compose）；TS strict；Prettier semi/双引号/printWidth 100/trailingComma all。
- 版本：NestJS ^11、Zod ^4.4.3、drizzle-orm ^0.45、@nestjs/jwt ^11.0.2、argon2 ^0.44.0、supertest ^7.1.0。
- 「提交或推送仅在被要求时进行」（AGENTS.md 原文）；本次 dev 流程用户已授权按 story 小步 Conventional Commits。
- `pnpm lint` 必须 0；contracts 仅依赖 zod；不得引 passport/jose/bcrypt。
- **禁止**：/traces/* 标 @Public；响应含 password_hash；JWT_SECRET 默认值/硬编码；seed 挂启动路径；软化 401 断言。
- 401 统一语义：凭据错/用户不存在/无 token/坏 token 均 401；畸形 body 400。
- argon2 参数固定：`{type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1}`。
- email 全链路 normalize：`trim().toLowerCase()`。
- 既有 5 个 backend spec 与 M0.5 行为不得回归；`pnpm observability:verify` 最终必须全绿。

---

### Task 1: 003 文档更新 + contracts 用户 DTO（M1a）

**Files:**
- Modify: `docs/design/003-code-organization.md`
- Create: `packages/contracts/src/users.ts`
- Create: `packages/contracts/src/users.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: 无（本任务是 M1 的起点；仅依赖 zod 与现有 contracts 结构）。
- Produces:
  - `UserProfileSchema: ZodObject`；`type UserProfile = { id: string; email: string; displayName: string; status: string; createdAt: string; updatedAt: string }`
  - `ChangeOwnPasswordRequestSchema`；`type ChangeOwnPasswordRequest = { currentPassword: string; newPassword: string }`（newPassword 8-128）
  - `ChangeOwnPasswordResponseSchema`；`type ChangeOwnPasswordResponse = { status: "ok" }`
- Consumed by: Task 2 `toProfile()` 返回 UserProfile、Task 3 controllers、Task 4 supertest。

**Tier:** standard

> 注：Step 1 是文档改动（CLAUDE.md「改架构先改文档」），先于失败测试属有意为之，不适用 TDD 序。

- [ ] **Step 1: 更新 003（文档先行）**

在 `docs/design/003-code-organization.md` 模块树（`├─ auth/ models/ knowledge-bases/ documents/` 一行）将 `auth/` 后追加 `users/`：

```
│  │  │     ├─ auth/ users/ models/ knowledge-bases/ documents/
```

在「精确依赖边」区（`- auth → persistence、config(横切:全局 guard,别的模块不 import 它)` 一行）改为并追加：

```
- `auth` → `users`、`config`(横切:全局 guard,别的模块不 import 它;@Public()/principal 类型在 platform/security)
- `users` → `persistence`(叶子;user 实体归属地,供 auth 校验凭据、未来 conversations.user_id 外键引用)
```

Run: `rg -n "users" docs/design/003-code-organization.md | head -5`
Expected: 模块树与依赖边均含 users。

- [ ] **Step 2: 失败测试**

Create `packages/contracts/src/users.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ChangeOwnPasswordRequestSchema,
  ChangeOwnPasswordResponseSchema,
  UserProfileSchema,
} from "./users";

describe("user contracts", () => {
  it("accepts a valid user profile", () => {
    expect(
      UserProfileSchema.safeParse({
        id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
        email: "demo@codecrush.local",
        displayName: "Demo Admin",
        status: "active",
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed email and short new password", () => {
    expect(
      UserProfileSchema.safeParse({
        id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
        email: "not-an-email",
        displayName: "x",
        status: "active",
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      ChangeOwnPasswordRequestSchema.safeParse({ currentPassword: "a", newPassword: "short" })
        .success,
    ).toBe(false);
  });

  it("accepts change password roundtrip shapes", () => {
    expect(
      ChangeOwnPasswordRequestSchema.safeParse({
        currentPassword: "CodeCrushDemo123!",
        newPassword: "NewPassword456!",
      }).success,
    ).toBe(true);
    expect(ChangeOwnPasswordResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
  });
});
```

Run: `pnpm --filter @codecrush/contracts test` — Expected: FAIL（./users 不存在）。

- [ ] **Step 3: 实现 contracts/users.ts 并导出**

Create `packages/contracts/src/users.ts`:

```ts
import { z } from "zod";

export const UserProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const ChangeOwnPasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});
export type ChangeOwnPasswordRequest = z.infer<typeof ChangeOwnPasswordRequestSchema>;

export const ChangeOwnPasswordResponseSchema = z.object({ status: z.literal("ok") });
export type ChangeOwnPasswordResponse = z.infer<typeof ChangeOwnPasswordResponseSchema>;
```

Modify `packages/contracts/src/index.ts`:

```ts
export * from "./health";
export * from "./traces";
export * from "./users";
```

Run: `pnpm --filter @codecrush/contracts test && pnpm --filter @codecrush/contracts build` — Expected: PASS。


### Task 2: users 数据层 + 迁移 + seed（M1a）

**Files:**
- Create: `apps/backend/src/modules/users/schema.ts`
- Create: `apps/backend/src/modules/users/password.ts`
- Create: `apps/backend/src/modules/users/users.repository.ts`
- Create: `apps/backend/src/modules/users/users.service.ts`
- Create: `apps/backend/src/modules/users/users.module.ts`
- Create: `apps/backend/src/db/seed.ts`
- Create: `apps/backend/test/users.service.spec.ts`
- Modify: `apps/backend/src/db/schema.ts`
- Modify: `apps/backend/src/app.module.ts`
- Modify: `apps/backend/package.json`（dep argon2 + script db:seed）
- Modify: `package.json`（root db:seed）
- Modify: `apps/backend/.env.example`（DEMO_USER_PASSWORD）
- Generate: `apps/backend/drizzle/0001_*.sql`（drizzle-kit）

**Interfaces:**
- Consumes: Task 1 的 `UserProfile`；platform 的 `DRIZZLE` token 与 `DB` 类型。
- Produces:
  - `users` 表 + `type UserRow = typeof users.$inferSelect`
  - `hashPassword(plain: string): Promise<string>`、`verifyPassword(hash: string, plain: string): Promise<boolean>`
  - `normalizeEmail(raw: string): string`
  - `UsersService.getProfile(userId: string): Promise<UserProfile>`
  - `UsersService.validateCredentials(email: string, password: string): Promise<UserProfile | null>`
  - `UsersService.changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<void>`
  - `UsersModule`（exports: UsersService）、命令 `pnpm db:seed`
- Consumed by: Task 3 auth.service / users.controller。

**Seed 冲突语义（定死，勿猜）**：`onConflictDoNothing({target: users.email})` —— demo 用户已存在时**不覆盖任何字段（包括密码）**；幂等 = 二跑零变更零报错。重置 demo 密码的途径是 PATCH /users/me/password 或手动删行重 seed，seed 本身永不改已有行。

**Tier:** standard

- [ ] **Step 1: 依赖与失败测试**

`apps/backend/package.json` dependencies 增加 `"argon2": "^0.44.0"`；scripts 增加 `"db:seed": "tsx src/db/seed.ts"`。root `package.json` scripts 增加 `"db:seed": "pnpm --filter @codecrush/backend db:seed"`。`apps/backend/.env.example` 追加 `DEMO_USER_PASSWORD=CodeCrushDemo123!`。跑 `pnpm install`。

Create `apps/backend/test/users.service.spec.ts`:

```ts
import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { hashPassword, verifyPassword } from "../src/modules/users/password";
import { UsersService, normalizeEmail } from "../src/modules/users/users.service";
import type { UsersRepository } from "../src/modules/users/users.repository";
import type { UserRow } from "../src/modules/users/schema";

jest.setTimeout(30000); // argon2 真实哈希

const now = new Date("2026-07-05T00:00:00.000Z");
function makeRow(passwordHash: string): UserRow {
  return {
    id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
    email: "demo@codecrush.local",
    displayName: "Demo Admin",
    passwordHash,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

describe("password helper", () => {
  it("hash/verify roundtrip; wrong password false", async () => {
    const hash = await hashPassword("CodeCrushDemo123!");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "CodeCrushDemo123!")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });
});

describe("UsersService", () => {
  it("normalizes email", () => {
    expect(normalizeEmail("  Demo@CodeCrush.LOCAL ")).toBe("demo@codecrush.local");
  });

  it("validateCredentials: 成功返回 sanitized profile（无 passwordHash）", async () => {
    const hash = await hashPassword("CodeCrushDemo123!");
    const repo = {
      findByEmail: jest.fn(async () => makeRow(hash)),
    } as unknown as UsersRepository;
    const service = new UsersService(repo);
    const profile = await service.validateCredentials("Demo@CodeCrush.local", "CodeCrushDemo123!");
    expect(profile).toMatchObject({ email: "demo@codecrush.local", displayName: "Demo Admin" });
    expect(profile && ("passwordHash" in profile || "password_hash" in profile)).toBe(false);
    expect((repo.findByEmail as jest.Mock).mock.calls[0][0]).toBe("demo@codecrush.local");
  });

  it("validateCredentials: 未知用户也执行一次 dummy verify（抑制枚举时序）", async () => {
    const repo = { findByEmail: jest.fn(async () => undefined) } as unknown as UsersRepository;
    const service = new UsersService(repo);
    const spy = jest.spyOn(service as never, "getDummyHash" as never);
    expect(await service.validateCredentials("nobody@x.local", "whatever")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("changeOwnPassword: current 错 → Unauthorized；未知 user → NotFound", async () => {
    const hash = await hashPassword("CodeCrushDemo123!");
    const update = jest.fn(async () => undefined);
    const repo = {
      findById: jest.fn(async () => makeRow(hash)),
      updatePasswordHash: update,
    } as unknown as UsersRepository;
    const service = new UsersService(repo);
    await expect(
      service.changeOwnPassword("8f14e45f-ceea-467f-a8d5-91be1a2f3b6d", "wrong", "NewPassword456!"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await service.changeOwnPassword(
      "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
      "CodeCrushDemo123!",
      "NewPassword456!",
    );
    expect(update).toHaveBeenCalled();

    const emptyRepo = { findById: jest.fn(async () => undefined) } as unknown as UsersRepository;
    await expect(
      new UsersService(emptyRepo).changeOwnPassword("no-such", "a", "NewPassword456!"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

Run: `pnpm --filter @codecrush/backend test -- users.service.spec.ts` — Expected: FAIL（模块不存在）。

- [ ] **Step 2: schema + barrel + 迁移**

Create `apps/backend/src/modules/users/schema.ts`:

```ts
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type UserRow = typeof users.$inferSelect;
```

Modify `apps/backend/src/db/schema.ts`（保留 appMeta，追加）:

```ts
export * from "../modules/users/schema";
```

Run: `pnpm --filter @codecrush/backend db:generate`，然后 `rg -l "CREATE TABLE" apps/backend/drizzle | xargs grep -l users`。
Expected: 新增 `drizzle/0001_*.sql` 含 `CREATE TABLE "users"` 与 email unique；`0000_*.sql` 未被修改（`git diff --stat apps/backend/drizzle/0000*` 为空）。检查生成 SQL 使用 `gen_random_uuid()`（PG16 内置，无需扩展）。

- [ ] **Step 3: password/repository/service/module 实现**

Create `apps/backend/src/modules/users/password.ts`:

```ts
import * as argon2 from "argon2";

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
```

Create `apps/backend/src/modules/users/users.repository.ts`:

```ts
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../platform/persistence/drizzle.constants";
import type { DB } from "../../platform/persistence/persistence.module";
import { users, type UserRow } from "./schema";

@Injectable()
export class UsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DB) {}

  async findById(id: string): Promise<UserRow | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0];
  }

  async findByEmail(normalizedEmail: string): Promise<UserRow | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    return rows[0];
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, id));
  }
}
```

Create `apps/backend/src/modules/users/users.service.ts`:

```ts
import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { UserProfile } from "@codecrush/contracts";
import { hashPassword, verifyPassword } from "./password";
import { UsersRepository } from "./users.repository";
import type { UserRow } from "./schema";

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function toProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  private dummyHash: string | undefined;

  constructor(private readonly usersRepository: UsersRepository) {}

  async getProfile(userId: string): Promise<UserProfile> {
    const row = await this.usersRepository.findById(userId);
    if (!row) throw new NotFoundException("user not found");
    return toProfile(row);
  }

  async validateCredentials(email: string, password: string): Promise<UserProfile | null> {
    const row = await this.usersRepository.findByEmail(normalizeEmail(email));
    if (!row) {
      // 未知用户也跑一次 verify，抑制用户枚举的时序差
      await verifyPassword(await this.getDummyHash(), password);
      return null;
    }
    return (await verifyPassword(row.passwordHash, password)) ? toProfile(row) : null;
  }

  async changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const row = await this.usersRepository.findById(userId);
    if (!row) throw new NotFoundException("user not found");
    if (!(await verifyPassword(row.passwordHash, currentPassword))) {
      throw new UnauthorizedException("current password is incorrect");
    }
    await this.usersRepository.updatePasswordHash(userId, await hashPassword(newPassword));
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHash) this.dummyHash = await hashPassword("dummy-password-for-timing");
    return this.dummyHash;
  }
}
```

Create `apps/backend/src/modules/users/users.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { UsersRepository } from "./users.repository";
import { UsersService } from "./users.service";

@Module({ providers: [UsersRepository, UsersService], exports: [UsersService] })
export class UsersModule {}
```

Modify `apps/backend/src/app.module.ts`（完整替换）:

```ts
import { Module } from "@nestjs/common";
import { AppConfigModule } from "./platform/config/config.module";
import { PersistenceModule } from "./platform/persistence/persistence.module";
import { ClickHouseModule } from "./platform/clickhouse/clickhouse.module";
import { HealthModule } from "./modules/health/health.module";
import { TracesModule } from "./modules/traces/traces.module";
import { UsersModule } from "./modules/users/users.module";

@Module({
  imports: [
    AppConfigModule,
    PersistenceModule,
    ClickHouseModule,
    HealthModule,
    TracesModule,
    UsersModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 4: seed 脚本**

Create `apps/backend/src/db/seed.ts`:

```ts
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashPassword } from "../modules/users/password";
import { normalizeEmail } from "../modules/users/users.service";
import { users } from "../modules/users/schema";

const DEMO_EMAIL = normalizeEmail(process.env.DEMO_USER_EMAIL ?? "demo@codecrush.local");
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? "CodeCrushDemo123!";
const DEMO_DISPLAY_NAME = process.env.DEMO_USER_DISPLAY_NAME ?? "Demo Admin";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await db
    .insert(users)
    .values({ email: DEMO_EMAIL, displayName: DEMO_DISPLAY_NAME, passwordHash })
    .onConflictDoNothing({ target: users.email });
  await pool.end();
  console.log(`demo user ensured: ${DEMO_EMAIL}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: 验证**

Run: `pnpm --filter @codecrush/backend test && pnpm --filter @codecrush/backend build && pnpm lint`
Expected: jest 6 个 suite 全过（新增 users.service.spec 5 用例）；nest build 与 eslint 退出码 0、无输出。
Run（需 infra）: `pnpm db:migrate && pnpm db:seed && pnpm db:seed`
Expected: `migrations applied`；两次 seed 均打印 `demo user ensured: demo@codecrush.local`，第二次不报唯一键冲突（幂等）。


### Task 3: 登录 + 全局 guard + 用户端点（M1b）

**Files:**
- Create: `packages/contracts/src/auth.ts`、`packages/contracts/src/auth.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/backend/src/platform/config/config.schema.ts`
- Modify: `apps/backend/src/platform/config/config.service.ts`
- Modify: `apps/backend/.env.example`
- Create: `apps/backend/src/platform/security/public.decorator.ts`
- Create: `apps/backend/src/platform/security/authenticated-user.ts`
- Create: `apps/backend/src/modules/auth/auth.module.ts`
- Create: `apps/backend/src/modules/auth/auth.service.ts`
- Create: `apps/backend/src/modules/auth/auth.controller.ts`
- Create: `apps/backend/src/modules/auth/jwt-auth.guard.ts`
- Create: `apps/backend/src/modules/users/users.controller.ts`
- Create: `apps/backend/test/auth.service.spec.ts`
- Create: `apps/backend/test/jwt-auth.guard.spec.ts`
- Create: `apps/backend/test/config.schema.spec.ts`
- Modify: `apps/backend/src/modules/users/users.module.ts`（挂 controller）
- Modify: `apps/backend/src/modules/health/health.controller.ts`（@Public）
- Modify: `apps/backend/src/app.module.ts`（AuthModule）
- Modify: `apps/backend/package.json`（@nestjs/jwt）

**Interfaces:**
- Consumes: Task 1/2 全部。
- Produces: `POST /auth/login`、`GET /users/me`、`PATCH /users/me/password`、全局 JwtAuthGuard、`@Public()`、`AuthenticatedUser`、env `JWT_SECRET/JWT_EXPIRES_IN`、`expiresInSeconds()`。

**Tier:** standard

- [ ] **Step 1: contracts auth（先失败测试，后实现）**

先创建下方 `packages/contracts/src/auth.test.ts`，运行 `pnpm --filter @codecrush/contracts test`，Expected: **FAIL**（Cannot find module './auth'）。然后创建 `auth.ts` 并更新 index，再运行同命令，Expected: PASS。

Create `packages/contracts/src/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LoginRequestSchema, LoginResponseSchema } from "./auth";

const user = {
  id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
  email: "demo@codecrush.local",
  displayName: "Demo Admin",
  status: "active",
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z",
};

describe("auth contracts", () => {
  it("accepts valid login roundtrip", () => {
    expect(
      LoginRequestSchema.safeParse({ email: "demo@codecrush.local", password: "x" }).success,
    ).toBe(true);
    expect(
      LoginResponseSchema.safeParse({
        accessToken: "header.payload.sig",
        tokenType: "Bearer",
        expiresIn: 43200,
        user,
      }).success,
    ).toBe(true);
  });

  it("rejects bad shapes", () => {
    expect(LoginRequestSchema.safeParse({ email: "nope", password: "x" }).success).toBe(false);
    expect(
      LoginResponseSchema.safeParse({ accessToken: "t", tokenType: "bearer", expiresIn: 1, user })
        .success,
    ).toBe(false);
    expect(
      LoginResponseSchema.safeParse({ accessToken: "t", tokenType: "Bearer", expiresIn: 0, user })
        .success,
    ).toBe(false);
  });
});
```

Create `packages/contracts/src/auth.ts`:

```ts
import { z } from "zod";
import { UserProfileSchema } from "./users";

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
  user: UserProfileSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
```

Modify `packages/contracts/src/index.ts`（完整替换）:

```ts
export * from "./health";
export * from "./traces";
export * from "./users";
export * from "./auth";
```

Run: `pnpm --filter @codecrush/contracts test && pnpm --filter @codecrush/contracts build` — Expected: test 全绿（含 auth.test.ts 2 用例）、build 无输出退出 0。

- [ ] **Step 2: env + config（先失败测试，后改 schema）**

**先**创建下方 `apps/backend/test/config.schema.spec.ts` 并运行 `pnpm --filter @codecrush/backend test -- config.schema.spec.ts`，Expected: **FAIL**（envSchema 尚无 JWT_SECRET 字段，「缺失→失败」用例不成立）。**然后**按下文修改 schema/service/.env.example，再运行同命令，Expected: PASS（3 用例）。

`config.schema.ts` envSchema 追加：

```ts
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("12h"),
```

`config.service.ts` 追加 getters：

```ts
  get jwtSecret(): string {
    return this.config.get("JWT_SECRET", { infer: true });
  }
  get jwtExpiresIn(): string {
    return this.config.get("JWT_EXPIRES_IN", { infer: true });
  }
```

`.env.example` 追加：

```dotenv
JWT_SECRET=dev-only-change-me-please-32-chars-min!!
JWT_EXPIRES_IN=12h
```

同时给本机 `apps/backend/.env` 追加同样两行（运行时验收需要；.env 不入库）。
`apps/backend/package.json` dependencies 追加 `"@nestjs/jwt": "^11.0.2"`；跑 `pnpm install`。

Create `apps/backend/test/config.schema.spec.ts`（验收 6 的具体测试）:

```ts
import { envSchema } from "../src/platform/config/config.schema";

const base = {
  DATABASE_URL: "postgres://codecrush:codecrush@localhost:5432/codecrush",
};

describe("envSchema JWT fail-fast", () => {
  it("JWT_SECRET 缺失 → 校验失败", () => {
    expect(envSchema.safeParse(base).success).toBe(false);
  });

  it("JWT_SECRET 过短（<32）→ 校验失败", () => {
    expect(envSchema.safeParse({ ...base, JWT_SECRET: "short" }).success).toBe(false);
  });

  it("合法 JWT_SECRET → 通过且 JWT_EXPIRES_IN 默认 12h", () => {
    const r = envSchema.safeParse({
      ...base,
      JWT_SECRET: "dev-only-change-me-please-32-chars-min!!",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.JWT_EXPIRES_IN).toBe("12h");
  });
});
```

Run: `pnpm --filter @codecrush/backend test -- config.schema.spec.ts` — Expected: 第一次 FAIL（envSchema 尚无 JWT_SECRET 字段，"缺失→失败"用例不成立）；完成本 Step 的 schema 修改后 PASS（3 用例）。

- [ ] **Step 3: platform/security + guard + auth 模块（附失败测试先行）**

Create `apps/backend/test/jwt-auth.guard.spec.ts`:

```ts
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";

const SECRET = "test-secret-at-least-32-characters-long!!";

function makeContext(authorization?: string, isPublic = false) {
  const request: Record<string, unknown> = { headers: { authorization } };
  const context = {
    getHandler: () => (isPublic ? "publicHandler" : "handler"),
    getClass: () => "TestClass",
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function makeGuard(isPublic = false) {
  const reflector = {
    getAllAndOverride: jest.fn(() => isPublic),
  } as unknown as Reflector;
  const jwtService = new JwtService({ secret: SECRET });
  return { guard: new JwtAuthGuard(reflector, jwtService), jwtService };
}

describe("JwtAuthGuard", () => {
  it("@Public 放行且不解析 token", async () => {
    const { guard } = makeGuard(true);
    const { context } = makeContext(undefined, true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("无 header / 非 Bearer / 坏 token → 401", async () => {
    const { guard } = makeGuard();
    await expect(guard.canActivate(makeContext(undefined).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(makeContext("Basic abc").context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      guard.canActivate(makeContext("Bearer not-a-jwt").context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("合法 token 放行并挂 request.user", async () => {
    const { guard, jwtService } = makeGuard();
    const token = await jwtService.signAsync({
      sub: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
      email: "demo@codecrush.local",
    });
    const { context, request } = makeContext(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
      email: "demo@codecrush.local",
    });
  });
});
```

Create `apps/backend/test/auth.service.spec.ts`:

```ts
import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthService, expiresInSeconds } from "../src/modules/auth/auth.service";
import type { UsersService } from "../src/modules/users/users.service";
import type { AppConfigService } from "../src/platform/config/config.service";

const SECRET = "test-secret-at-least-32-characters-long!!";
const profile = {
  id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
  email: "demo@codecrush.local",
  displayName: "Demo Admin",
  status: "active",
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z",
};

function makeService(valid: boolean) {
  const usersService = {
    validateCredentials: jest.fn(async () => (valid ? profile : null)),
  } as unknown as UsersService;
  const jwtService = new JwtService({ secret: SECRET });
  const config = { jwtExpiresIn: "12h" } as AppConfigService;
  return { service: new AuthService(usersService, jwtService, config), jwtService };
}

describe("expiresInSeconds", () => {
  it("解析 s/m/h/d，拒绝垃圾", () => {
    expect(expiresInSeconds("12h")).toBe(43200);
    expect(expiresInSeconds("30m")).toBe(1800);
    expect(() => expiresInSeconds("whenever")).toThrow();
  });
});

describe("AuthService.login", () => {
  it("成功：返回可验签 token + 秒数 + sanitized user", async () => {
    const { service, jwtService } = makeService(true);
    const res = await service.login("demo@codecrush.local", "CodeCrushDemo123!");
    expect(res.tokenType).toBe("Bearer");
    expect(res.expiresIn).toBe(43200);
    expect(res.user).toEqual(profile);
    const payload = await jwtService.verifyAsync<{ sub: string; email: string }>(res.accessToken);
    expect(payload.sub).toBe(profile.id);
    expect(payload.email).toBe(profile.email);
  });

  it("失败：统一 401", async () => {
    const { service } = makeService(false);
    await expect(service.login("demo@codecrush.local", "wrong")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
```

Run: `pnpm --filter @codecrush/backend test -- jwt-auth.guard.spec.ts` — Expected: FAIL（文件不存在）。

Create `apps/backend/src/platform/security/public.decorator.ts`:

```ts
import { SetMetadata } from "@nestjs/common";

export const PUBLIC_ROUTE_KEY = "codecrush:public_route";
export const Public = () => SetMetadata(PUBLIC_ROUTE_KEY, true);
```

Create `apps/backend/src/platform/security/authenticated-user.ts`:

```ts
/** JWT 验证通过后挂在 request.user 上的最小主体 */
export type AuthenticatedUser = { id: string; email: string };
```

Create `apps/backend/src/modules/auth/jwt-auth.guard.ts`:

```ts
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { PUBLIC_ROUTE_KEY } from "../../platform/security/public.decorator";

type JwtPayload = { sub: string; email: string };
type RequestWithUser = { headers: { authorization?: string }; user?: AuthenticatedUser };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer token");
    }
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        header.slice("Bearer ".length).trim(),
      );
      request.user = { id: payload.sub, email: payload.email };
      return true;
    } catch {
      throw new UnauthorizedException("invalid or expired token");
    }
  }
}
```

Create `apps/backend/src/modules/auth/auth.service.ts`:

```ts
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { LoginResponse } from "@codecrush/contracts";
import { AppConfigService } from "../../platform/config/config.service";
import { UsersService } from "../users/users.service";

const EXPIRES_RE = /^(\d+)([smhd])$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function expiresInSeconds(expr: string): number {
  const m = EXPIRES_RE.exec(expr.trim());
  if (!m) throw new Error(`invalid JWT_EXPIRES_IN: ${expr}`);
  return Number(m[1]) * UNIT_SECONDS[m[2]];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.usersService.validateCredentials(email, password);
    if (!user) throw new UnauthorizedException("invalid credentials");
    const accessToken = await this.jwtService.signAsync({ sub: user.id, email: user.email });
    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: expiresInSeconds(this.config.jwtExpiresIn),
      user,
    };
  }
}
```

Create `apps/backend/src/modules/auth/auth.controller.ts`:

```ts
import { BadRequestException, Body, Controller, HttpCode, Post } from "@nestjs/common";
import { LoginRequestSchema, type LoginResponse } from "@codecrush/contracts";
import { Public } from "../../platform/security/public.decorator";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @HttpCode(200)
  @Post("login")
  async login(@Body() body: unknown): Promise<LoginResponse> {
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return await this.authService.login(parsed.data.email, parsed.data.password);
  }
}
```

Create `apps/backend/src/modules/auth/auth.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { AppConfigService } from "../../platform/config/config.service";
import { UsersModule } from "../users/users.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.jwtExpiresIn },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthModule {}
```

- [ ] **Step 4: users controller + health @Public + 接线**

Create `apps/backend/src/modules/users/users.controller.ts`:

```ts
import { BadRequestException, Body, Controller, Get, Patch, Req } from "@nestjs/common";
import {
  ChangeOwnPasswordRequestSchema,
  type ChangeOwnPasswordResponse,
  type UserProfile,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { UsersService } from "./users.service";

type AuthedRequest = { user: AuthenticatedUser };

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("me")
  async me(@Req() req: AuthedRequest): Promise<UserProfile> {
    return await this.usersService.getProfile(req.user.id);
  }

  @Patch("me/password")
  async changePassword(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ChangeOwnPasswordResponse> {
    const parsed = ChangeOwnPasswordRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    await this.usersService.changeOwnPassword(
      req.user.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    return { status: "ok" };
  }
}
```

`users.module.ts` 增加 `controllers: [UsersController]`（import 该文件）。
`health.controller.ts`：`@Controller("health")` 上方加 `@Public()`（`import { Public } from "../../platform/security/public.decorator";`）。
`app.module.ts` imports 追加 `AuthModule`。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @codecrush/backend test && pnpm --filter @codecrush/backend build && pnpm --filter @codecrush/contracts test && pnpm lint`
Expected: backend jest 9 个 suite 全过（原 5 + users.service + config.schema + jwt-auth.guard + auth.service）；contracts vitest 4 文件全过；build/lint 退出 0。


### Task 4: supertest 矩阵 + 消费者适配 + 运行时验收（M1b 收尾）

**Files:**
- Create: `apps/backend/test/auth.e2e.spec.ts`
- Modify: `apps/backend/package.json`（devDeps supertest/@types/supertest）
- Modify: `apps/backend/scripts/verify-observability.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1-3 全部。
- Produces: 应用级 401 矩阵证据、带鉴权的 observability:verify、README 更新。

**Tier:** standard

- [ ] **Step 1: supertest 依赖 + 应用级矩阵测试**

`apps/backend/package.json` devDependencies 追加 `"supertest": "^7.1.0"`、`"@types/supertest": "^6.0.2"`；`pnpm install`。

Create `apps/backend/test/auth.e2e.spec.ts`:

```ts
import { type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AuthController } from "../src/modules/auth/auth.controller";
import { AuthService } from "../src/modules/auth/auth.service";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { HealthController } from "../src/modules/health/health.controller";
import { TracesController } from "../src/modules/traces/traces.controller";
import { TracesService } from "../src/modules/traces/traces.service";
import { UsersController } from "../src/modules/users/users.controller";
import { UsersService } from "../src/modules/users/users.service";
import { AppConfigService } from "../src/platform/config/config.service";
import { DRIZZLE } from "../src/platform/persistence/drizzle.constants";

const SECRET = "test-secret-at-least-32-characters-long!!";
const profile = {
  id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
  email: "demo@codecrush.local",
  displayName: "Demo Admin",
  status: "active",
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z",
};

describe("global guard HTTP matrix", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET, signOptions: { expiresIn: "1h" } })],
      controllers: [HealthController, AuthController, UsersController, TracesController],
      providers: [
        AuthService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        {
          provide: UsersService,
          useValue: {
            validateCredentials: async (email: string, password: string) =>
              email === "demo@codecrush.local" && password === "CodeCrushDemo123!" ? profile : null,
            getProfile: async () => profile,
          },
        },
        { provide: TracesService, useValue: { emitHello: async () => ({}), getTrace: async () => ({}) } },
        { provide: DRIZZLE, useValue: { execute: async () => [{}] } },
        { provide: AppConfigService, useValue: { jwtExpiresIn: "1h", jwtSecret: SECRET } },
      ],
    }).compile();
    app = ref.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health 无 token → 200（@Public）", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
  });

  it("无 token：/users/me、/traces/hello、/traces/:id → 401", async () => {
    await request(app.getHttpServer()).get("/users/me").expect(401);
    await request(app.getHttpServer()).post("/traces/hello").expect(401);
    await request(app.getHttpServer())
      .get("/traces/391dae938234560b16bb63f51501cb6f")
      .expect(401);
  });

  it("坏 token → 401", async () => {
    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", "Bearer garbage")
      .expect(401);
  });

  it("登录矩阵：畸形 400 / 错凭据 401 / 正确 200", async () => {
    await request(app.getHttpServer()).post("/auth/login").send({ email: "nope" }).expect(400);
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "demo@codecrush.local", password: "wrong" })
      .expect(401);
    const res = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "demo@codecrush.local", password: "CodeCrushDemo123!" })
      .expect(200);
    expect(res.body.tokenType).toBe("Bearer");
    expect(res.body.user.email).toBe(profile.email);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");

    await request(app.getHttpServer())
      .get("/users/me")
      .set("Authorization", `Bearer ${res.body.accessToken}`)
      .expect(200);
  });
});
```

Run: `pnpm --filter @codecrush/backend test -- auth.e2e.spec.ts` — Expected: PASS（4 用例）。
> 注：本测试验证 Task 3 已实现的行为（集成检查点），非新单元的 fail-first；若任何 401/400 断言失败即 Task 3 有缺陷，回 Task 3 修。

- [ ] **Step 2: verify 脚本带鉴权**

Modify `apps/backend/scripts/verify-observability.mjs`——在 `requestJson` 定义后追加登录逻辑，并给两处 traces 调用加 Authorization 头：

```js
async function getToken() {
  if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN;
  const email = process.env.DEMO_USER_EMAIL ?? "demo@codecrush.local";
  const password = process.env.DEMO_USER_PASSWORD ?? "CodeCrushDemo123!";
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(
      `login failed (${res.status}): 请先运行 pnpm db:migrate && pnpm db:seed 创建 demo 账号`,
    );
  }
  return (await res.json()).accessToken;
}

const token = await getToken();
const authHeaders = { Authorization: `Bearer ${token}` };
```

将 `requestJson("/traces/hello", { method: "POST" })` 改为 `requestJson("/traces/hello", { method: "POST", headers: authHeaders })`；轮询处 `requestJson(\`/traces/${hello.traceId}\`)` 改为 `requestJson(\`/traces/${hello.traceId}\`, { headers: authHeaders })`。

- [ ] **Step 3: README（精确文本）**

Modify `README.md`：

(a) 「M0.5 可观测验证」代码块内，`cp apps/backend/.env.example apps/backend/.env` 一行之后插入一行：

```
pnpm db:migrate && pnpm db:seed
```

(b) 同节末尾（"Collector/ClickHouse 不可用时…" 段之后）追加一段：

```
> M1 起 `/traces/*` 需要登录：verify 脚本会自动用 demo 账号（`demo@codecrush.local` / `DEMO_USER_PASSWORD`，默认 `CodeCrushDemo123!`）换取 token；`GET /health` 保持公开。
```

(c) 「状态」区，将

```
- ⏭ 下一步 **M1 用户与鉴权**（见路线图波次 B）。
```

替换为：

```
- ✅ **M1 用户/认证**已完成（users 实体 + demo seed + JWT 登录 + 全局 guard，`/traces/*` 收保护）。
- ⏭ 下一步 **M2 前后端页面骨架**（见路线图波次 B）。
```

Run: `rg -n "db:seed|M1 用户/认证|M2 前后端页面骨架" README.md` — Expected: 三处均命中。

- [ ] **Step 4: 全量回归 + 运行时验收**

```bash
pnpm lint && pnpm test && pnpm build
docker compose -f infra/docker-compose.yml --profile infra up -d --wait
pnpm db:migrate && pnpm db:seed
pnpm --filter @codecrush/backend start &   # 已含 JWT_SECRET 的 .env
# 验收矩阵：
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health                    # 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/users/me                  # 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/traces/hello      # 401
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@codecrush.local","password":"CodeCrushDemo123!"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
curl -s http://localhost:3000/users/me -H "Authorization: Bearer $TOKEN"                  # 200 profile
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"demo@codecrush.local","password":"wrong"}'  # 401
pnpm observability:verify                                                                 # ok
```

改密往返（验收 5，精确命令；`$TOKEN` 来自上方登录）：

```bash
curl -s -X PATCH http://localhost:3000/users/me/password -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"currentPassword":"CodeCrushDemo123!","newPassword":"TempPassword456!"}'
# Expected: {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"demo@codecrush.local","password":"CodeCrushDemo123!"}'
# Expected: 401（旧密码失效）
TOKEN2=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@codecrush.local","password":"TempPassword456!"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
# Expected: TOKEN2 非空（新密码 200）
curl -s -X PATCH http://localhost:3000/users/me/password -H "Authorization: Bearer $TOKEN2" \
  -H 'Content-Type: application/json' \
  -d '{"currentPassword":"TempPassword456!","newPassword":"CodeCrushDemo123!"}'
# Expected: {"status":"ok"}（改回原密码，保持环境可重复验收）
```

JWT_SECRET fail-fast（验收 6，运行时侧证；单测已在 Task 3 config.schema.spec 覆盖）：

```bash
cd apps/backend && JWT_SECRET=short node -r ./dist/tracing.js dist/main.js
# Expected: 进程启动即抛 ZodError（JWT_SECRET too_small）非零退出，不监听端口。
# 注意 dotenv 不覆盖已存在的环境变量，因此 JWT_SECRET=short 生效（覆盖 .env 值）。
```

## Self-Review

- 覆盖 spec 验收 1-10；Task 依赖单向（1→2→3→4）；
- 无占位符；所有代码块可直接落盘；迁移文件名不硬编码；
- 反作弊：supertest 矩阵走真 guard；verify 脚本真登录；禁止项在 Global Constraints。
