# M3 Dev Context

## Test Command

- Per-story targeted: `pnpm --filter @codecrush/{contracts|backend|frontend} test`
- Full regression: `pnpm test` (turbo) + `pnpm lint` + `pnpm build`
- DB migration: `pnpm db:generate` then `pnpm db:migrate` (needs `docker compose -f infra/docker-compose.yml --profile infra up -d --wait`)

## Code Conduct

- TS strict; Prettier `semi: true`, double quotes, printWidth 100, trailingComma all.
- Conventional Commits; co-author trailer per CLAUDE.md.
- Dependency boundary (AGENTS.md): contracts/otel-conventions depend only on zod/zero-dep; backend imports down; frontend imports only contracts + otel-conventions (never backend/otel).
- Port/adapter: domain owns port (interface), adapter via NestJS DI token; never import `adapters/` directly.
- Domain `schema.ts` is pure table def, zero service refs.
- Observability never on critical path; best-effort spans.
- Never soften test assertions to pass — fix code (契约演进更新测试体是合法的，非软化).

## Pattern References

### Story 1 (contracts) — `packages/contracts/src/models.ts`
- Reference: existing `packages/contracts/src/models.ts` (M2 skeleton), `m2-schemas.test.ts` valid.model block.
- Mirror: `z.enum` lowercase types; `ModelProviderSchema.omit({id,...}).extend({...})` for write DTOs; list response = `z.array`.
- Deviations: baseUrl optional→required; add `deploymentId`; split write(`apiKey`)/read(`apiKeyMasked`); add `UpdateModelRequestSchema` (.partial) + `TestModelResponseSchema`.

### Story 2 (encryption) — `apps/backend/src/platform/security/`
- Reference: `apps/backend/src/platform/persistence/persistence.module.ts` (@Global module + DRIZZLE token + useFactory(AppConfigService)); `drizzle.constants.ts` (Symbol token); `config.schema.ts`/`config.service.ts` (env getter); `config.schema.spec.ts` (envSchema fail-fast test pattern); `config.module.ts` (AppConfigModule.forRoot validate).
- Mirror: @Global module + Symbol token + useFactory(AppConfigService) + fail-fast envSchema `z.string().min(44)`.
- Deviations: AES-256-GCM via Node `crypto` (backend-only); maskApiKey co-located on service. Existing `security/` has only `authenticated-user.ts` + `public.decorator.ts` — add `encryption.ts`, `security.constants.ts`, `security.module.ts`.
- NOTE: `envSchema` only directly tested in `test/config.schema.spec.ts`; must update its `base` to include `MODEL_API_KEY_ENCRYPTION_KEY` (44-char base64) so "合法 JWT_SECRET → 通过" stays green. AppConfigModule only imported by app.module.ts (no test triggers env validation at runtime).

### Story 3 (DB schema) — `apps/backend/src/modules/models/schema.ts`
- Reference: `apps/backend/src/modules/users/schema.ts` (pgTable + $inferSelect); `db/schema.ts` barrel (`export * from "../modules/users/schema"`); `drizzle/0001_*.sql` (existing migrations).
- Mirror: uuid PK defaultRandom, text/boolean/timestamp columns, snake_case column names, `$inferSelect`/`$inferInsert` exports.
- Deviations: column `api_key_enc`/`base_url`/`deployment_id` per 001:81; no `unique` on email.

### Story 4 (port + adapter) — `apps/backend/src/modules/models/ports/` + `adapters/`
- Reference: AGENTS.md §端口/适配器; Node 22 global `fetch`.
- Mirror: `interface ModelProviderPort` in ports/; Symbol DI token `MODEL_PROVIDER_PORT`; adapter `@Injectable() implements ModelProviderPort`.
- Deviations: only `testConnection` exposed (chat/embed/rerank leave M4/M8); real-path POST per type (chat/completions max_tokens:1, embeddings input:"ping", rerank query+documents+top_n); AbortController 10s timeout; failures → `{ok:false}` never throw.

### Story 5 (service + controller + e2e) — `apps/backend/src/modules/models/`
- Reference: `users.repository.ts` (@Inject(DRIZZLE) + eq + select/insert/update/delete); `users.service.ts` (@Injectable + toProfile row→DTO mapping + NotFoundException); `users.controller.ts` (createZodDto + @Req AuthedRequest); `users.module.ts` (providers + exports); `skeleton.e2e.spec.ts` (TestingModule + JwtModule + APP_GUARD/APP_PIPE + overrideProvider).
- Mirror: repo find/findById/insert/update/delete; service row→DTO with enc.encrypt/decrypt/maskApiKey; controller GET/GET:id/POST/PATCH:id/DELETE:test; module providers [repo, service, {provide: MODEL_PROVIDER_PORT, useClass: OpenAiCompatAdapter}] + exports [service, port].
- Deviations: withSpan best-effort in test(); e2e uses inMemoryRepo + mock port + fixed-key EncryptionService (NOT SecurityModule — skeleton.e2e doesn't import AppConfigModule).
- CRITICAL test-coupling: Story 1 makes `baseUrl` required + `apiKey` required-write → `skeleton.e2e.spec.ts` models block breaks (m3 has no baseUrl; POST sends no apiKey). Stays red until Story 5 fixes it (non-softening: update test body + assertions). So `pnpm --filter @codecrush/backend test` is NOT green for Stories 1–4; run targeted new spec per story, full backend suite green at Story 5+.

### Story 6 (frontend) — `apps/frontend/src/pages/admin/ModelsPage.tsx`
- Reference: existing `ModelsPage.tsx` (tab+grid+drawer local state); `mocks/models.ts` (LLM_ROWS/MODEL_TYPES/ModelType uppercase); `api/client.ts` (apiFetch/getJson/postJson + ZodSchema<T> interface); M2 dev-ledger Story 6 conventions (frontend never imports zod directly).
- Mirror: typed client via contracts ZodSchema<T>; `useEffect` getModels on mount; enum mapping TYPE_LABEL lower→upper.
- Deviations: drop `LLM_ROWS` (mock data); keep `MODEL_TYPES` (UI constants); `ModelType` = `z.infer<ModelTypeSchema>` (lowercase) + `TYPE_LABEL` map; apiKey not refilled on edit.

## Waves

All sequential single-story waves (strict dependency chain):
1 → 2 → 3 → 4 → 5 → 6 → 7

Lightweight对抗 (CLAUDE.md): peer review only for security/data-integrity stories (Story 2 encryption, Story 5 service+apikey); final review at Story 7 covers all diff. Others host self-checked.
