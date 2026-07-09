# Story 1 Peer Review — 后端全局配置 + nestjs-zod 迁移 + M1 测试修复

Reviewer: independent peer (lightweight adversarial, trust-boundary story → individual review).
Scope: static review of diff `8b6a435..9762985`.

## Verdict

**PASS_WITH_CONCERNS**

Code works, 33 tests green, lint clean, nestjs-zod API used per README, no security hole, no P1.
Three P2s must be addressed before merge: a functional script that breaks under the new `/api`
prefix, a misleading "double insurance" comment on the trust boundary, and design-doc / README
drift that violates AGENTS.md "先改文档再改代码".

## Findings

### [P2] `verify-observability.mjs` not updated for `/api` prefix — will 404 at runtime

**Evidence**: `apps/backend/scripts/verify-observability.mjs:16,36,45`
```
16:  const res = await fetch(`${baseUrl}/auth/login`, { ... });
36: const hello = await requestJson("/traces/hello", { method: "POST", headers: authHeaders });
45:    detail = await requestJson(`/traces/${hello.traceId}`, { headers: authHeaders });
```
The script is wired to `pnpm --filter @codecrush/backend observability:verify` (`apps/backend/package.json:14`). After `setGlobalPrefix("api", ...)`, all three paths now 404. `getToken()` will throw "login failed" (line 22) because `/auth/login` no longer exists.

**Why it matters**: This is the end-to-end OTLP→Collector→ClickHouse verification tool (the M0.5 acceptance gate). It is not in `jest`'s test suite, so "33 tests green" doesn't catch it. The breakage surface in `spec.md` Risk 2 lists only `auth.e2e.spec.ts` / `traces.controller.spec.ts` / frontend `client.ts` — this script was missed.

**Fix**: `/auth/login` → `/api/auth/login`, `/traces/hello` → `/api/traces/hello`, `/traces/${hello.traceId}` → `/api/traces/${hello.traceId}`.

---

### [P2] `traces.controller.ts` comment claims "double insurance" but the global pipe does NOT validate `@Param("traceId") traceId: string`

**Evidence**: `apps/backend/src/modules/traces/traces.controller.ts:17-23`
```ts
async getTrace(@Param("traceId") traceId: string): Promise<TraceDetailResponse> {
  // M2 已引入全局 ZodValidationPipe，但 param 校验仍在此保留作防御性双保险：
  // HTTP 层 pipe 拦 + controller 内 regex 双校验，且使 traces.controller.spec.ts 直调断言不失效。
  if (!TRACE_ID_RE.test(traceId)) {
    throw new BadRequestException("traceId must be a 32-character hex string");
  }
```
The comment asserts the pipe validates `traceId` ("HTTP 层 pipe 拦") AND the regex validates it ("controller 内 regex 双校验"). This is factually wrong. Per the nestjs-zod README (`createZodValidationPipe` → `strictSchemaDeclaration`): the global `ZodValidationPipe` only validates params typed with a nestjs-zod DTO; a plain `string` param is **silently skipped** (and `strictSchemaDeclaration` was not enabled in `app.module.ts:24`). So the regex is the **sole** validation, not double insurance.

**Why it matters**: This is the validation trust boundary — the reason this story gets an individual review. A future dev reading "double insurance" may conclude the pipe covers `traceId` and remove the "redundant" regex. With the regex gone, `traceId` is completely unvalidated before being passed to `tracesService.getTrace(traceId)` (a ClickHouse read). The defensive behavior is correct today; the comment is the hazard.

**Fix** (either):
- Correct the comment to: "全局 ZodValidationPipe 不校验 plain-string @Param；regex 是唯一校验，保留以使 traces.controller.spec.ts 直调断言不失效。"
- Or actually wire pipe validation: `@Param("traceId", new ZodValidationPipe(TraceIdSchema))` / a `TraceIdDto`, which would make the "double insurance" claim true.

---

### [P2] Design docs + README not updated for `/api` prefix — violates AGENTS.md "先改文档再改代码"

**Evidence**:
- `docs/design/005-user-auth.md:28` `POST /auth/login、GET /users/me、PATCH /users/me/password`
- `docs/design/005-user-auth.md:29` `/health、/auth/login 公开，/traces/* 收保护`
- `docs/design/005-user-auth.md:55,68,100` route table and sequence diagram use `/auth/login`, `/users/me/password`
- `docs/design/006-m2-app-shell-skeleton.md:30,160` `接 M1 /auth/login`
- `README.md:79` `GET /traces/:traceId`
- `README.md:82` `/traces/* 需要登录`

All now disagree with the running server (`/api/auth/login`, `/api/users/me`, `/api/traces/*`).

**Why it matters**: AGENTS.md (always-applied workspace rule) states "改架构/顺序/约定，先改对应文档，再改代码" and "设计文档 `docs/design/` 是权威". Story 0 revised 003/006 but did not touch 005 or the path references in 006/README. The `/api` prefix is a convention change to the API surface; the authoritative docs should have been updated before/with the code. `005` is the M1 auth design doc — its route table is now wrong.

**Fix**: Update 005 (route table + sequence diagram), 006 (M1 path references), and README (verify section) to `/api/*`. `/health` references are correct and should stay.

---

### [P3] `ZodSerializerInterceptor` registered but inert — no handler uses `@ZodSerializerDto` / `@ZodResponse`

**Evidence**: `apps/backend/src/app.module.ts:25-27` registers `APP_INTERCEPTOR ZodSerializerInterceptor`. Neither `auth.controller.ts` nor `users.controller.ts` uses `@ZodSerializerDto` / `@ZodResponse` / `@ApiOkResponse({ type })`. Per README, the interceptor only activates when such a decorator is present; otherwise it passes through.

**Why it matters**: The interceptor is currently dead weight. Response-shape enforcement (e.g., stripping extra fields) is provided by the service layer's `toProfile` mapping (`users.service.ts:11-20`), not by zod serialization. `auth.e2e.spec.ts:98`'s `not.toContain("passwordHash")` passes because `toProfile` omits `passwordHash`, not because of the interceptor. Within Story 1 scope (spec only asked to register), but flag for future stories: adopt `@ZodResponse` to get declarative response contracts + OpenAPI response schemas.

---

### [P3] OpenAPI: bearer security scheme defined but not applied per-operation; response schemas undocumented

**Evidence**: `apps/backend/src/app/app/app-bootstrap.ts:26` `.addBearerAuth()`. No controller uses `@ApiBearerAuth()`, so the scheme is declared but no operation is marked as requiring it. No handler uses `@ApiOkResponse({ type: X.Output })` or `@ZodResponse`, so response bodies are absent from the generated doc (only request bodies via `@Body() body: ZodDto` are documented).

**Why it matters**: The OpenAPI doc is structurally valid (paths present, `openapi.e2e.spec.ts` asserts them) but incomplete — a consumer can't tell which endpoints need auth or what they return. Acceptable for Story 1 (acceptance criteria 4 only requires paths), but worth a follow-up.

---

### [P3] 400 error shape inconsistency between pipe-validated routes and traces manual check

**Evidence**: `ZodValidationException` (README) produces `{ statusCode:400, message:"Validation failed", errors:[...] }`. `traces.controller.ts:22` throws `BadRequestException("traceId must be a 32-character hex string")` → `{ statusCode:400, message:"traceId must be...", error:"Bad Request" }`.

**Why it matters**: Clients see two different 400 shapes. This is a direct consequence of the deliberate "keep defensive regex" decision (diff-report #7) and is acceptable for Story 1. Flag for awareness when the traces route is eventually migrated to a `TraceIdDto` (would unify the shape).

---

### [P3] `openapi.e2e.spec.ts` does not register `APP_PIPE`; none of the new e2e specs register `APP_INTERCEPTOR`

**Evidence**: `apps/backend/test/openapi.e2e.spec.ts:27-43` (no `APP_PIPE`); `zod-pipe.e2e.spec.ts:23-29` and `auth.e2e.spec.ts:36-56` register `APP_PIPE` but not `APP_INTERCEPTOR`.

**Why it matters**: Not a full production replica, but inconsequential today — OpenAPI metadata exploration doesn't need the pipe, and the interceptor is inert without `@ZodSerializerDto`. `auth.e2e.spec.ts` correctly replicates `applyGlobalConfig` + `APP_PIPE` + `APP_GUARD`, which is what matters for its assertions. No test passes for the wrong reason. Mention only for test-fidelity awareness.

## Notes

- **nestjs-zod API usage**: `createZodDto`, `ZodValidationPipe`, `ZodSerializerInterceptor`, `cleanupOpenApiDoc` all used per README. No deprecated APIs (`zodV3ToOpenAPI`, `@nest-zod/z`, `validate`, `ZodGuard`). ✓
- **Security/trust boundary**: `@Public()` only on `health` + `login`; `JwtAuthGuard` still registered via `APP_GUARD` in `auth.module.ts:22`; global prefix `exclude: ["health"]` doesn't expose any protected route; `/api/docs` + `/api/docs-json` sit outside the Nest router (swagger registers at Express adapter level) so the guard doesn't block them — `openapi.e2e.spec.ts` confirms 200 with guard active. No `passwordHash` in any request-body schema or `UserProfile`. No leak. ✓
- **`auth.e2e.spec.ts:98` `not.toContain("passwordHash")`**: pre-existing assertion (diff only changed paths, not this line). Passes because `UsersService.validateCredentials` → `toProfile` strips `passwordHash` at the service layer — correct behavior, not a false pass.
- **CLAUDE.md change** (adversarial-strength grading, diff lines 99-108): process doc, not code; not in Story 1 brief. Harmless but technically out-of-scope for this story's commit.
- **`setupSwagger` comment** ("UI 路由不在 Nest 路由表内，全局 JwtAuthGuard 不会拦截"): accurate — swagger routes bypass the Nest router.
- **Conventions**: dependency direction OK (backend-only imports in `app-bootstrap.ts`/`app.module.ts`); contracts still only depend on `zod`; barrel imports from `@codecrush/contracts` everywhere; Conventional Commit message well-formed.
- **Test quality**: `zod-pipe.e2e.spec.ts` asserts the exact `ZodValidationException` shape (`message:"Validation failed"` + non-empty `errors` array) — strong. `openapi.e2e.spec.ts` asserts specific paths including the `/health` exclude — strong. No softened assertions found.
