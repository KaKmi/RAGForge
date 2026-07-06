# M2 Dev Ledger

Story 0: "修订 003/006 设计文档" — complete
  Commits: 8b6a435
  Files: docs/design/003-code-organization.md, docs/design/006-m2-app-shell-skeleton.md
  Produces: 003 OpenAPI tooling revised; 006 route table 14 routes, 15-screen table fixed
  Concerns: none

Story 1: "后端全局配置 + nestjs-zod 迁移 + M1 测试修复" — complete (pending peer review)
  Commits: <to fill after commit>
  Deps added: nestjs-zod@5.4.0, @nestjs/swagger@11.4.5 (backend)
  Files:
    - apps/backend/src/app/app-bootstrap.ts (NEW: applyGlobalConfig + setupSwagger helpers)
    - apps/backend/src/main.ts (wire prefix + swagger)
    - apps/backend/src/app.module.ts (APP_PIPE ZodValidationPipe + APP_INTERCEPTOR ZodSerializerInterceptor)
    - apps/backend/src/modules/auth/auth.controller.ts (createZodDto, drop manual safeParse)
    - apps/backend/src/modules/users/users.controller.ts (createZodDto, drop manual safeParse)
    - apps/backend/src/modules/traces/traces.controller.ts (keep defensive TRACE_ID_RE as double insurance; comment updated)
    - apps/backend/test/auth.e2e.spec.ts (APP_PIPE + applyGlobalConfig; paths → /api/*)
    - apps/backend/test/openapi.e2e.spec.ts (NEW: GET /api/docs-json paths assertions)
    - apps/backend/test/zod-pipe.e2e.spec.ts (NEW: ZodValidationPipe 400 shape)
  Produces: global /api prefix (health excluded); Swagger UI at /api/docs + JSON at /api/docs-json; ZodValidationPipe global; M1 controllers migrated to createZodDto
  Tests: 12 suites / 33 tests green; lint 0; build ok
  Breaking change: API prefix /auth/login→/api/auth/login, /users/me→/api/users/me, /traces/*→/api/traces/* (/health unchanged)
  Concerns: none
