# M1 用户 / 认证 Peer Spec

Repo: `/Users/zhaopengcheng/Desktop/rag-service`  
Branch: `main`  
HEAD: `7fc8c11c25cb78809865a79db42e6f1c4f25cb96`  
Role: independent investigator/spec writer. This spec was written from repository investigation only.

## Problem / Motivation

M1 must add the first real identity boundary to the NestJS backend: a durable user table, demo account seed, login issuing JWTs, and a global guard so existing non-public APIs require a Bearer token. The roadmap defines M1 as "登录(JWT)、user 实体、auth guard" with acceptance "demo 账号登录；无 token 接口 401" (`docs/design/002-implementation-roadmap.md:75-80`). RBAC/admin management is intentionally not part of M1; the architecture lists multi-tenant/RBAC as out of scope for the current phase (`docs/design/001-rag-platform-architecture.md:35-37`).

The implementation must preserve the existing M0/M0.5 boundaries:

- DTOs live in `@codecrush/contracts`, which is the frontend/backend contract source (`AGENTS.md:51-55`, `docs/design/003-code-organization.md:140-142`).
- Drizzle owns Postgres control-plane schema, migrations are explicit commands, and app startup must not silently migrate or seed (`AGENTS.md:48-49`, `docs/design/003-code-organization.md:144-150`).
- `contracts` must stay pure Zod-only and frontend-safe (`AGENTS.md:41-44`, `eslint.config.mjs:39-59`).
- Health must remain usable as the public operational probe; current frontend calls `/health` on load (`apps/frontend/src/api/client.ts:3-5`) and Vite only proxies `/health` today (`apps/frontend/vite.config.ts:6-9`).

## Investigation Findings

### Entrypoints and runtime chain

- The backend root module currently imports only config, persistence, ClickHouse, health, and traces (`apps/backend/src/app.module.ts:1-10`). M1 must add user/auth modules here or via an imported module graph.
- Bootstrap has no global pipes or guards today; it creates `AppModule`, enables CORS, reads `AppConfigService.port`, and listens (`apps/backend/src/main.ts:7-13`). A global auth guard therefore needs Nest `APP_GUARD` registration, not a `main.ts` local guard only.
- Config is fail-fast through `ConfigModule.forRoot({ validate: envSchema.parse })` (`apps/backend/src/platform/config/config.module.ts:8-12`). `JWT_SECRET` must be added to `envSchema`, not read ad hoc.
- `AppConfigService` is the typed config facade used by runtime providers (`apps/backend/src/platform/config/config.service.ts:5-32`), and persistence/ClickHouse providers inject it (`apps/backend/src/platform/persistence/persistence.module.ts:15-18`, `apps/backend/src/platform/clickhouse/clickhouse.module.ts:11-18`).
- The `start` script preloads tracing (`apps/backend/package.json:5-13`), while dev uses `nest start --watch` without `-r`; auth must not depend on tracing initialization.

### Persistence and migration chain

- Drizzle runtime provider injects a `Pool` using `config.databaseUrl` and binds `DRIZZLE` globally (`apps/backend/src/platform/persistence/persistence.module.ts:1-24`).
- The current Drizzle schema barrel is `apps/backend/src/db/schema.ts`, currently containing only `app_meta` (`apps/backend/src/db/schema.ts:1-7`). User table exports must be reachable from this file because `drizzle.config.ts` points at it (`apps/backend/drizzle.config.ts:4-8`).
- Migration execution is explicit via `pnpm --filter @codecrush/backend db:migrate`, which runs `tsx src/db/migrate.ts` (`apps/backend/package.json:11-12`, `package.json:14-15`). The migration script reads `DATABASE_URL` and applies `./drizzle` migrations (`apps/backend/src/db/migrate.ts:1-17`).
- Existing migrations are in `apps/backend/drizzle/`; the only current SQL creates `app_meta` (`apps/backend/drizzle/0000_natural_trish_tilby.sql:1-5`). M1 must add a new migration, not modify the existing one.
- Postgres init currently only enables `vector` (`infra/postgres/init.sql:1`), and Docker uses `pgvector/pgvector:pg16` (`infra/docker-compose.yml:3-19`).

### Existing API surfaces and consumers

- Current public controller: `GET /health`, returning a `HealthResponse` from `@codecrush/contracts` and checking Postgres with `SELECT 1` (`apps/backend/src/modules/health/health.controller.ts:1-20`).
- Current trace controller: `POST /traces/hello` emits a manual span and `GET /traces/:traceId` reads ClickHouse detail (`apps/backend/src/modules/traces/traces.controller.ts:7-24`). Both are currently unauthenticated because no guard exists.
- Trace detail uses ClickHouse VIEW anti-corruption logic in `ClickHouseTracesRepository.findByTraceId` (`apps/backend/src/modules/traces/clickhouse-traces.repository.ts:82-113`).
- `observability:verify` is a command consumer of the trace endpoints: it POSTs `/traces/hello`, then polls `/traces/:traceId` (`apps/backend/scripts/verify-observability.mjs:16-40`). M1b will break this script unless it can obtain/provide a Bearer token.
- Frontend login is explicitly just a placeholder card (`apps/frontend/src/pages/LoginPage.tsx:1-5`), and frontend login wiring is M2/out of scope.

### Existing DTO and test patterns

- Contract files are small Zod modules exported through `packages/contracts/src/index.ts` (`packages/contracts/src/health.ts:1-8`, `packages/contracts/src/traces.ts:1-30`, `packages/contracts/src/index.ts:1-2`).
- Contract tests use Vitest and parse schemas directly (`packages/contracts/src/health.test.ts:1-15`, `packages/contracts/src/traces.test.ts:1-48`). Add auth/user contract tests in this style.
- Backend tests use Jest + `@swc/jest` with decorators enabled and workspace package mappers (`apps/backend/jest.config.js:1-23`). Add backend tests in `apps/backend/test/*.spec.ts`.
- Existing controller tests instantiate controllers directly with mocked providers (`apps/backend/test/health.controller.spec.ts:5-27`, `apps/backend/test/traces.controller.spec.ts:7-55`). Global guard behavior will not be exercised by these direct tests, so M1b needs an app-level HTTP test.
- No current package dependency includes JWT, Passport, argon2, bcrypt, or supertest; `rg` over package and TS files found no `@nestjs/jwt`, `passport`, `jsonwebtoken`, `jose`, `argon2`, `bcrypt`, `APP_GUARD`, `SetMetadata`, or `UseGuards` references.

### File existence checks

These files do not exist and should be created if this spec is implemented:

- `apps/backend/src/modules/auth/auth.module.ts`
- `apps/backend/src/modules/auth/auth.controller.ts`
- `apps/backend/src/modules/auth/auth.service.ts`
- `apps/backend/src/modules/auth/jwt-auth.guard.ts`
- `apps/backend/src/modules/users/users.module.ts`
- `apps/backend/src/modules/users/users.controller.ts`
- `apps/backend/src/modules/users/users.service.ts`
- `apps/backend/src/modules/users/users.repository.ts`
- `apps/backend/src/modules/users/schema.ts`
- `apps/backend/src/db/seed-demo-user.ts`
- `packages/contracts/src/auth.ts`
- `packages/contracts/src/users.ts`

## Design Approach

### Module shape and dependency boundary

Add a `users` leaf module and an `auth` module:

- `users` owns the `users` Postgres table, `UserService`, user repository, password hashing/verification helper, `GET /users/me`, and `PATCH /users/me/password`.
- `auth` owns `POST /auth/login`, JWT issuance, and the global JWT guard.
- `auth` may depend on `users` through the `UsersModule` export because login must validate user credentials. This is a small architecture clarification: `docs/design/003-code-organization.md` currently lists `auth` as a leaf with only `persistence`/`config` dependencies (`docs/design/003-code-organization.md:114-132`) and does not list a `users` module in the target module tree (`docs/design/003-code-organization.md:74-80`). Update `003-code-organization.md` before code to record `users` as a leaf and `auth -> users, config` as the precise M1 dependency.
- Other modules should not import auth. Cross-cutting route metadata such as `@Public()` and request principal type should live under `apps/backend/src/platform/security/`, so `HealthController` can mark itself public without importing from the auth domain. This preserves the "other modules do not import auth" intent in `docs/design/003-code-organization.md:130-134`.

### Password hashing choice: argon2id

Use `argon2` with `argon2id`.

Justification:

- Argon2id is memory-hard and better aligned with modern password storage than bcrypt. Bcrypt is mature but has GPU-resistance and password-length limitations that are not worth choosing for a greenfield Node 22 service.
- Native module risk is real for both `argon2` and `bcrypt`. This repo already accepts native tooling in dev/test through `@swc/core` and `@swc/jest` (`apps/backend/package.json:30-45`, `apps/backend/jest.config.js:11-21`), and the project targets Node >=22 (`package.json:5-7`, `AGENTS.md:60-64`). Keep password hashing isolated in a small users helper so tests can cover one real hash/verify integration and mock higher-level auth flows where speed matters.
- Do not use `bcryptjs` as an escape hatch: it avoids native installs but weakens the security choice and would not satisfy the argon2-vs-bcrypt decision honestly.

Recommended production parameters for M1: `type: argon2.argon2id`, `memoryCost: 65536`, `timeCost: 3`, `parallelism: 1`. Tests may call the same helper sparingly; do not introduce a separate weak test-only verifier in application code.

### JWT library and guard choice

Use `@nestjs/jwt`, not raw `jsonwebtoken`, `jose`, or Passport.

Justification:

- `@nestjs/jwt` fits Nest 11 DI/module configuration and gives `JwtService.signAsync/verifyAsync` without building a custom token service from lower-level primitives.
- Raw `jsonwebtoken` would add less Nest integration and more manual wiring.
- `jose` is standards-focused and excellent for JWK/remote issuer scenarios, but M1 only needs symmetric HS256 local JWTs from `JWT_SECRET`.
- Avoid Passport for M1. The project currently favors thin explicit providers/controllers, with no Passport infrastructure (`rg` found no passport/JWT guard references), and `@Public()` metadata plus a plain `CanActivate` guard is smaller and easier to test than adding `@nestjs/passport` + `passport-jwt`.

JWT claims:

- `sub`: user id.
- `email`: normalized email.
- Optional `iat`/`exp`: provided by JWT library.

Use a fixed M1 expiry such as 8 hours (`expiresIn: "8h"`) and return `expiresIn: 28800` in the login response. Do not add refresh tokens in M1.

### Public/protected route policy

- `GET /health` is public. It is the operational probe and existing frontend shell depends on it (`apps/frontend/src/api/client.ts:3-5`).
- `POST /auth/login` is public.
- `GET /users/me` and `PATCH /users/me/password` are protected.
- `POST /traces/hello` and `GET /traces/:traceId` are protected. Trace data can expose observability metadata, prompts, future RAG inputs, and debug-only span emission. `POST /traces/hello` is not a health probe; it writes observability data and should require auth after M1. This means `apps/backend/scripts/verify-observability.mjs` must log in first or accept an `AUTH_TOKEN`/`BEARER_TOKEN` env var before calling traces (`apps/backend/scripts/verify-observability.mjs:16-40`).

## Changes by File

### M1a: user foundation

#### Docs

- `docs/design/003-code-organization.md`
  - Add `users` to the backend module tree near `auth`.
  - Clarify dependency edge: `auth -> users + config`, `users -> persistence`, and other modules still do not import `auth`.
  - Keep RBAC/admin-management deferred; do not add roles/permissions here.

#### Contracts

- `packages/contracts/src/users.ts`
  - Add `UserProfileSchema`:
    - `id: string().uuid()`
    - `email: string().email()`
    - `displayName: string().min(1)`
    - `createdAt: string().datetime()`
    - `updatedAt: string().datetime()`
  - Add `ChangeOwnPasswordRequestSchema`:
    - `currentPassword: string().min(1)`
    - `newPassword: string().min(12).max(128)`
  - Add `ChangeOwnPasswordResponseSchema`: `{ status: "ok" }`.
  - Export inferred types.
- `packages/contracts/src/index.ts`
  - Export `./users`.
- `packages/contracts/src/users.test.ts`
  - Accept valid profile/change-password payloads.
  - Reject malformed email and too-short new password.

#### Backend schema and migration

- `apps/backend/src/modules/users/schema.ts`
  - Create a pure Drizzle table definition, with no service imports:
    - `users`
    - `id uuid primary key defaultRandom()`
    - `email text not null unique`
    - `display_name text not null`
    - `password_hash text not null`
    - `created_at timestamp not null defaultNow()`
    - `updated_at timestamp not null defaultNow()`
  - The application must normalize email to lowercase before writes/lookups; do not add `citext` in M1.
  - Do not add `role`, `is_admin`, tenant fields, user management flags, or RBAC tables in M1.
- `apps/backend/src/db/schema.ts`
  - Keep `appMeta` (`apps/backend/src/db/schema.ts:1-7`) and export the new users schema so drizzle-kit sees it (`apps/backend/drizzle.config.ts:4-8`).
- `apps/backend/drizzle/0001_*.sql`
  - Generate with `pnpm db:generate` after schema changes.
  - Verify it creates `users` and unique email constraint without modifying `0000_natural_trish_tilby.sql`.

#### Backend user module

- `apps/backend/src/modules/users/password.ts`
  - Export `hashPassword(plain: string)` and `verifyPassword(hash: string, plain: string)` using argon2id.
  - Keep all hashing details out of contracts and frontend.
- `apps/backend/src/modules/users/users.repository.ts`
  - Inject `DRIZZLE` and provide DB access:
    - `findById(id)`
    - `findByEmail(normalizedEmail)`
    - `upsertDemoUser({ email, displayName, passwordHash })`
    - `updatePasswordHash(userId, passwordHash)`
  - Repository can return internal rows including `passwordHash`; controllers must not.
- `apps/backend/src/modules/users/users.service.ts`
  - Normalize email via `trim().toLowerCase()`.
  - Map rows to `UserProfile`.
  - Provide:
    - `getProfile(userId)`
    - `validateCredentials(email, password): Promise<UserProfile | null>`
    - `changeOwnPassword(userId, currentPassword, newPassword)`
    - `seedDemoUser({ email, password, displayName })`
  - Wrong current password should throw `UnauthorizedException` or return a result that the controller maps to 401.
- `apps/backend/src/modules/users/users.controller.ts`
  - `GET /users/me`: protected by the global guard, reads current principal, returns `UserProfile`.
  - `PATCH /users/me/password`: protected, validates body with `ChangeOwnPasswordRequestSchema`, verifies current password, updates hash, returns `{ status: "ok" }`.
- `apps/backend/src/modules/users/users.module.ts`
  - Provide and export `UserService`; register `UsersController`.

#### Demo seed

- `apps/backend/src/db/seed-demo-user.ts`
  - Explicit command only; never imported by `main.ts` or `AppModule`.
  - Read `DATABASE_URL` with `dotenv/config`, create a `Pool`, create a Drizzle client with schema, hash the demo password, upsert by normalized email, close the pool.
  - Defaults:
    - `DEMO_USER_EMAIL=demo@codecrush.local`
    - `DEMO_USER_PASSWORD=CodeCrushDemo123!`
    - `DEMO_USER_DISPLAY_NAME=Demo Admin`
  - Print the seeded email, never print the password hash.
- `apps/backend/package.json`
  - Add `"db:seed:demo": "tsx src/db/seed-demo-user.ts"`.
- `package.json`
  - Add root `"db:seed:demo": "pnpm --filter @codecrush/backend db:seed:demo"` beside the existing root db scripts (`package.json:14-16`).
- `apps/backend/.env.example`
  - Add demo seed variables as optional documentation and later `JWT_SECRET` in M1b.

### M1b: login + global guard

#### Contracts

- `packages/contracts/src/auth.ts`
  - Add `LoginRequestSchema`:
    - `email: string().email()`
    - `password: string().min(1)`
  - Add `LoginResponseSchema`:
    - `accessToken: string().min(1)`
    - `tokenType: literal("Bearer")`
    - `expiresIn: number().int().positive()`
    - `user: UserProfileSchema`
  - Export inferred types.
- `packages/contracts/src/index.ts`
  - Export `./auth`.
- `packages/contracts/src/auth.test.ts`
  - Accept a valid login response and reject missing/invalid token fields.

#### Config and env

- `apps/backend/src/platform/config/config.schema.ts`
  - Add `JWT_SECRET: z.string().min(32)` with no default. Missing/short secret must fail app startup via existing `envSchema.parse` (`apps/backend/src/platform/config/config.module.ts:8-12`).
- `apps/backend/src/platform/config/config.service.ts`
  - Add `jwtSecret` getter.
- `apps/backend/.env.example`
  - Add `JWT_SECRET=dev-only-change-me-at-least-32-chars`.
  - Keep this a dev example only; do not default it in `envSchema`.

#### Platform security helpers

- `apps/backend/src/platform/security/public.decorator.ts`
  - Export `PUBLIC_ROUTE_KEY` and `Public()` using Nest `SetMetadata`.
- `apps/backend/src/platform/security/authenticated-user.ts`
  - Export an internal `AuthenticatedUser` principal type: `{ id: string; email: string }`.
- Optional: `apps/backend/src/platform/security/current-user.decorator.ts`
  - Export `CurrentUser()` to read `request.user`. If this adds awkward typing, controllers may use `@Req()` and cast to `AuthenticatedUser`; keep auth-domain imports out of users/health controllers.

#### Auth module

- `apps/backend/src/modules/auth/auth.module.ts`
  - Import `JwtModule.registerAsync` or register `JwtService` with `secret: config.jwtSecret`, `signOptions: { expiresIn: "8h" }`.
  - Import `UsersModule`.
  - Register `{ provide: APP_GUARD, useClass: JwtAuthGuard }`.
  - Provide `AuthService`, `JwtAuthGuard`; register `AuthController`.
- `apps/backend/src/modules/auth/auth.service.ts`
  - `login(email, password)`:
    - validate credentials through `UserService.validateCredentials`.
    - throw `UnauthorizedException` with a generic message on failure.
    - sign `{ sub: user.id, email: user.email }`.
    - return `LoginResponse`.
- `apps/backend/src/modules/auth/auth.controller.ts`
  - `@Public() @Post("login")`.
  - Validate body with `LoginRequestSchema` and return `LoginResponse`.
- `apps/backend/src/modules/auth/jwt-auth.guard.ts`
  - Implements `CanActivate`.
  - Uses `Reflector.getAllAndOverride(PUBLIC_ROUTE_KEY, [handler, class])`.
  - Accepts only `Authorization: Bearer <token>`.
  - Missing header, non-Bearer header, malformed token, expired token, or bad signature -> `UnauthorizedException` (HTTP 401).
  - On success, set `request.user = { id: payload.sub, email: payload.email }`.
  - Do not query ClickHouse or observability code in the guard.

#### Existing modules affected by guard

- `apps/backend/src/modules/health/health.controller.ts`
  - Add `@Public()` at class or method level. This is required so `/health` continues to return the contract response (`apps/backend/src/modules/health/health.controller.ts:11-20`) and frontend health polling keeps working (`apps/frontend/src/pages/HomePage.tsx:5-18`).
- `apps/backend/src/modules/traces/traces.controller.ts`
  - Do not add `@Public()`. Both trace endpoints should become protected (`apps/backend/src/modules/traces/traces.controller.ts:11-24`).
- `apps/backend/src/app.module.ts`
  - Import `UsersModule` and `AuthModule` into the root module graph beside existing modules (`apps/backend/src/app.module.ts:8-10`).

#### Observability verification script

- `apps/backend/scripts/verify-observability.mjs`
  - Before calling traces, obtain a token:
    - Use `AUTH_TOKEN`/`BEARER_TOKEN` if present, or
    - POST `/auth/login` with `DEMO_USER_EMAIL`/`DEMO_USER_PASSWORD` defaults matching the seed.
  - Send `Authorization: Bearer <token>` on `/traces/hello` and `/traces/:traceId`.
  - Keep `/health` out of this flow; health remains public.

#### Dependencies

- `apps/backend/package.json`
  - Add runtime deps:
    - `@nestjs/jwt`
    - `argon2`
  - Add test deps:
    - `supertest`
    - `@types/supertest`
  - Do not add `@nestjs/passport`, `passport`, or `passport-jwt` for M1.

## Intent / Non-goals / Forbidden Shortcuts

Intent:

- Establish a single demo/admin identity path sufficient for M2+ protected backend APIs.
- Make authorization default-deny through a global guard, with explicit `@Public()` exceptions.
- Keep identity contracts in `@codecrush/contracts`, DB schema in Drizzle, and runtime secrets in fail-fast config.

Non-goals:

- No frontend login page implementation beyond existing placeholder (`apps/frontend/src/pages/LoginPage.tsx:1-5`).
- No admin user CRUD, manage-other-users endpoints, delete/deactivate users, invite flows, roles, permissions, or tenants.
- No refresh tokens, sessions, cookies, OAuth/OIDC, password reset emails, or CSRF work.
- No changes to trace storage architecture or observability data path.

Forbidden shortcuts:

- Do not seed from `main.ts`, `AppModule`, or a module constructor.
- Do not store plaintext passwords or compare plaintext.
- Do not return `password_hash` from any controller or contract.
- Do not put `JWT_SECRET` default in `envSchema`.
- Do not mark `traces` public just to keep existing tests/scripts green; update the script/tests to authenticate.
- Do not weaken contract/backend tests to assert only "some token-shaped string"; verify missing/bad token gives 401 through the real global guard.

## Acceptance Criteria

M1a:

- `pnpm db:generate` creates a users migration and `pnpm db:migrate` applies it.
- `pnpm db:seed:demo` inserts or updates `demo@codecrush.local` with an argon2id password hash and does not run during app startup.
- `GET /users/me` and `PATCH /users/me/password` exist, but require auth once M1b is active.
- Contracts export user DTOs and pass contract tests.

M1b:

- Starting backend without `JWT_SECRET` or with a short secret fails during config validation.
- After running migrate + demo seed, `POST /auth/login` with demo credentials returns `{ accessToken, tokenType: "Bearer", expiresIn, user }`.
- `GET /health` without token returns 200 and the existing `HealthResponse`.
- `GET /users/me` without token returns 401.
- `GET /users/me` with `Authorization: Bearer <demo token>` returns the demo user's profile.
- `PATCH /users/me/password` rejects wrong current password and allows changing the current user's own password.
- `POST /traces/hello` and `GET /traces/:traceId` without token return 401; with a valid token they retain existing behavior.
- `pnpm lint` is 0, especially for contracts purity and frontend/backend import boundaries.

## Test Plan

Contracts:

- `pnpm --filter @codecrush/contracts test`
- Add Vitest coverage for `UserProfileSchema`, `ChangeOwnPasswordRequestSchema`, `LoginRequestSchema`, and `LoginResponseSchema`.

Backend unit tests:

- `Password hashing`: one test hashes and verifies with real argon2id; verify wrong password is false.
- `UserService`: validates credentials, normalizes email, maps profile without `passwordHash`, rejects wrong current password, updates own password.
- `AuthService`: returns login response with token for valid credentials and throws `UnauthorizedException` for invalid credentials.
- `JwtAuthGuard`: public metadata bypass, missing auth header 401, malformed header 401, bad token 401, valid token sets request user.
- `Config schema`: `JWT_SECRET` missing/short fails, valid secret passes.

Backend app-level HTTP tests:

- Add a Nest app test using `supertest` because direct controller tests do not exercise global guards (`apps/backend/test/traces.controller.spec.ts:7-55`).
- Test:
  - `GET /health` is 200 without token.
  - `GET /users/me` is 401 without token.
  - `POST /traces/hello` is 401 without token.
  - `POST /auth/login` with mocked/stubbed user service returns a token, or use a test module with in-memory/mocked repository.
  - `GET /users/me` with a signed token reaches the controller.

Existing tests to update or keep stable:

- `apps/backend/test/health.controller.spec.ts` should still pass because `@Public()` metadata does not change `check()` behavior (`apps/backend/test/health.controller.spec.ts:13-27`).
- `apps/backend/test/traces.controller.spec.ts` direct controller behavior should still pass, but add guard-level/app-level tests for 401 (`apps/backend/test/traces.controller.spec.ts:16-55`).
- `apps/backend/test/traces.service.spec.ts` and `apps/backend/test/traces.repository.spec.ts` should remain behaviorally unchanged because auth is above service/repository layers (`apps/backend/test/traces.service.spec.ts:12-35`, `apps/backend/test/traces.repository.spec.ts:24-69`).

Full verification:

- `pnpm build`
- `pnpm test`
- `pnpm lint`
- With infra running:
  - `cp apps/backend/.env.example apps/backend/.env`
  - Set a real `JWT_SECRET`
  - `pnpm db:migrate`
  - `pnpm db:seed:demo`
  - Start backend
  - Login as demo, call protected endpoints with/without Bearer token.
  - Run `pnpm observability:verify` after updating the script to authenticate.

## Risks / Unknowns

- Native `argon2` install can fail on unusual platforms without prebuilds/build tools. This is an accepted M1 trade-off for stronger hashing; keep usage isolated and document Node 22 requirement already present in the repo (`package.json:5-7`).
- `uuid().defaultRandom()` migration output should be verified against the local PG16 image. If generated SQL depends on an extension not present in `pgvector/pgvector:pg16`, add an explicit migration-safe `CREATE EXTENSION IF NOT EXISTS pgcrypto;` or switch to app-generated UUIDs before merging.
- Guard e2e tests require `supertest`, which is not currently in dev dependencies. Add it explicitly instead of relying only on direct controller tests.
- `observability:verify` will require a seeded user or provided token after M1b. CI/dev docs should mention the new order: migrate -> seed demo -> verify protected traces.
- Updating `docs/design/003-code-organization.md` for `users` is a spec requirement because the current doc names `auth` but not `users` in the module tree (`docs/design/003-code-organization.md:74-80`) and currently defines auth as depending only on persistence/config (`docs/design/003-code-organization.md:130-132`).

## Spec Self-review

- Placeholder scan: no `TODO`, `TBD`, or placeholder file names are required for implementation except generated Drizzle migration suffix `0001_*`, which is intentionally tool-generated.
- Internal consistency: M1a creates users and seed; M1b adds login/JWT/global guard. `GET /health` and `POST /auth/login` are public; users/traces are protected.
- Scope check: no frontend login implementation, RBAC, admin user management, refresh tokens, or unrelated observability refactor.
- Ambiguity check: endpoint paths, DTO names, password library, JWT library, guard behavior, seed command, and trace protection policy are explicit.
- Integrity check: tests must exercise real 401 behavior through the global guard and must not mark traces public or weaken password/token assertions to pass.
