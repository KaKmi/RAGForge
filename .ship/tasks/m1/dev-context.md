# Dev Context

## Test Command
`pnpm lint && pnpm test && pnpm build`

Runtime acceptance after stories complete:
`docker compose -f infra/docker-compose.yml --profile infra up -d --wait && pnpm db:migrate && pnpm db:seed && pnpm observability:verify`

## Code Conduct
- TypeScript strict, Prettier with semicolons, double quotes, printWidth 100, trailing commas.
- Contracts live in `packages/contracts`, use Zod, and must only depend on `zod`.
- Backend uses NestJS modules/controllers/services with DI providers and domain-local `schema.ts` files kept pure.
- Drizzle/Postgres schema changes go through `apps/backend/src/db/schema.ts` barrel plus generated migrations under `apps/backend/drizzle`.
- ClickHouse stays outside Drizzle; traces write via OTLP and read through VIEW only.
- Frontend must not import backend or Node-only packages.
- Conventional Commits per story; stage only files touched by the story.
- Do not mark `/traces/*` public, do not leak password hashes, do not default or hardcode `JWT_SECRET`, and do not weaken 401 tests.

## Pattern References
### Story 1: 003 文档更新 + contracts 用户 DTO
- Reference: `packages/contracts/src/health.ts`, `packages/contracts/src/traces.ts`
  - Why analogous: existing Zod DTO package shape and exported type aliases.
  - Mirror: schema constants plus `z.infer` type exports; no runtime/platform imports.
  - Deviations: user DTOs add UUID/email/password length constraints per M1 spec.
- Reference: `packages/contracts/src/health.test.ts`, `packages/contracts/src/traces.test.ts`
  - Why analogous: Vitest schema parse tests.
  - Mirror: `safeParse(...).success` assertions and direct schema imports.
  - Deviations: add password and email negative cases.
- Reference: `docs/design/003-code-organization.md`
  - Why analogous: authoritative module tree and dependency edge documentation.
  - Mirror: edit existing module tree and precise dependency edge list.
  - Deviations: add `users` leaf and `auth -> users, config` clarification.

### Story 2: users 数据层 + 迁移 + seed
- Reference: `apps/backend/src/platform/persistence/persistence.module.ts`
  - Why analogous: DB provider token and `DB` type used by repositories.
  - Mirror: inject `DRIZZLE`, use typed Drizzle database, keep platform dependency one-way.
  - Deviations: users repository is domain-specific and exports no adapter.
- Reference: `apps/backend/src/db/migrate.ts`
  - Why analogous: explicit DB command pattern with dotenv, Pool, drizzle, top-level `main`.
  - Mirror: explicit command, no app startup side effects, clean pool shutdown.
  - Deviations: seed inserts demo user and prints only email.
- Reference: `apps/backend/test/health.controller.spec.ts`
  - Why analogous: backend Jest style with mocked providers.
  - Mirror: direct class/module tests, concise fixtures, explicit exception assertions.
  - Deviations: password helper uses real argon2 and longer Jest timeout.

### Story 3: 登录 + 全局 guard + 用户端点
- Reference: `apps/backend/src/modules/traces/traces.controller.ts`
  - Why analogous: controller-level parsing and typed contract responses.
  - Mirror: parse/validate at controller boundary until M2 global Zod pipe exists.
  - Deviations: auth/users controllers parse body DTOs and use guard principal.
- Reference: `apps/backend/src/platform/config/config.schema.ts`, `apps/backend/src/platform/config/config.service.ts`
  - Why analogous: fail-fast env schema and typed getters.
  - Mirror: add env fields to schema and expose through service getters.
  - Deviations: `JWT_SECRET` has no default by design.
- Reference: `apps/backend/test/traces.controller.spec.ts`
  - Why analogous: backend controller and exception tests.
  - Mirror: direct unit tests for service/guard logic.
  - Deviations: global guard behavior needs app-level HTTP coverage in Story 4.

### Story 4: supertest 矩阵 + 消费者适配 + 运行时验收
- Reference: `apps/backend/scripts/verify-observability.mjs`
  - Why analogous: existing M0.5 end-to-end smoke consumer of `/traces/*`.
  - Mirror: small fetch helpers, clear error messages, polling trace detail.
  - Deviations: authenticate first or use `AUTH_TOKEN`, then attach Bearer headers.
- Reference: `apps/backend/src/app.module.ts`
  - Why analogous: app-level module composition that global guard affects.
  - Mirror: assemble real controllers/providers in tests through Nest testing module.
  - Deviations: e2e test mocks domain services and uses supertest.
- Reference: `README.md`
  - Why analogous: operator-facing setup and verification instructions.
  - Mirror: update existing M0.5 verification section and status bullets.
  - Deviations: include `db:seed` and M1 auth note.

## Waves
Sequential only:
- Wave 1: Story 1. Produces contracts and docs required by later stories.
- Wave 2: Story 2. Consumes Story 1 user contract; produces users service/data layer and seed.
- Wave 3: Story 3. Consumes users service and contracts; produces auth endpoints, guard, config.
- Wave 4: Story 4. Consumes full auth behavior; produces e2e evidence, updated smoke script, README.

