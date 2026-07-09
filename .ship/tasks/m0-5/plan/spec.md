# Spec — M0.5 可观测最小闭环

- **Task ID**: m0-5
- **Scope mode**: full
- **Branch**: main
- **HEAD SHA**: 03c22eaf040d71c4f8131fc931396bb08da3c4d9
- **承接**: `docs/design/001`、`002`、`003`、`004`

## Problem / Motivation

M0 已把 monorepo、NestJS/Vite 骨架、contracts、Postgres/ClickHouse/Collector 服务定义搭好；README 也明确当前下一步是 **M0.5 可观测最小闭环**，即 OTel SDK -> Collector -> ClickHouse -> traces API [README.md:7](../../../../README.md#L7)-[10](../../../../README.md#L10)。路线图要求 M0.5 第一个验证最高风险链路：NestJS 接 OTel SDK、Collector 配 `clickhouseexporter`、自有读 VIEW、traces 读模块骨架、一条 hello span 端到端 [docs/design/002-implementation-roadmap.md:70](../../../../docs/design/002-implementation-roadmap.md#L70)-[73](../../../../docs/design/002-implementation-roadmap.md#L73)。

设计不变量很硬：应用只吐 OTLP、不直写 ClickHouse；ClickHouse 表由 Collector exporter 拥有；读侧经自有 VIEW 防腐；埋点不能进入未来问答关键路径 [docs/design/001-rag-platform-architecture.md:39](../../../../docs/design/001-rag-platform-architecture.md#L39)-[42](../../../../docs/design/001-rag-platform-architecture.md#L42)。M0.5 的任务就是把这条链路用最小但真实的代码跑通，给 M8/M9 留下可复用的通用观测基础。

## Current State / Investigation Findings

### Existing entrypoints and modules

- Backend bootstrap is currently plain Nest startup. `main.ts` has an explicit M0.5 comment saying tracing should be preloaded via `node -r ./dist/tracing.js dist/main.js` [apps/backend/src/main.ts:1](../../../../apps/backend/src/main.ts#L1)-[14](../../../../apps/backend/src/main.ts#L14). This is important because `003` calls OTel initialization order the first likely failure mode and requires tracing preload before Nest bootstrap [docs/design/003-code-organization.md:146](../../../../docs/design/003-code-organization.md#L146)-[148](../../../../docs/design/003-code-organization.md#L148), [docs/design/003-code-organization.md:196](../../../../docs/design/003-code-organization.md#L196)-[198](../../../../docs/design/003-code-organization.md#L198).
- `AppModule` only imports config, persistence, and health today [apps/backend/src/app.module.ts:1](../../../../apps/backend/src/app.module.ts#L1)-[7](../../../../apps/backend/src/app.module.ts#L7). M0.5 must add a `TracesModule` without coupling it to future `chat`.
- The existing controller pattern is `HealthController`: inject a platform provider, perform a small query, return a typed contracts response [apps/backend/src/modules/health/health.controller.ts:1](../../../../apps/backend/src/modules/health/health.controller.ts#L1)-[20](../../../../apps/backend/src/modules/health/health.controller.ts#L20). The matching unit test uses Nest testing with a mocked provider [apps/backend/test/health.controller.spec.ts:1](../../../../apps/backend/test/health.controller.spec.ts#L1)-[28](../../../../apps/backend/test/health.controller.spec.ts#L28). M0.5 should follow this pattern for traces.

### Config and scripts

- Env validation is global and fail-fast through `ConfigModule.forRoot({ validate: envSchema.parse })` [apps/backend/src/platform/config/config.module.ts:6](../../../../apps/backend/src/platform/config/config.module.ts#L6)-[16](../../../../apps/backend/src/platform/config/config.module.ts#L16).
- M0 already reserved `CLICKHOUSE_URL` and `OTEL_EXPORTER_OTLP_ENDPOINT`, but both are optional and not exposed by `AppConfigService` [apps/backend/src/platform/config/config.schema.ts:3](../../../../apps/backend/src/platform/config/config.schema.ts#L3)-[10](../../../../apps/backend/src/platform/config/config.schema.ts#L10), [apps/backend/src/platform/config/config.service.ts:9](../../../../apps/backend/src/platform/config/config.service.ts#L9)-[17](../../../../apps/backend/src/platform/config/config.service.ts#L17). `.env.example` also has them commented as M0.5 variables [apps/backend/.env.example:1](../../../../apps/backend/.env.example#L1)-[6](../../../../apps/backend/.env.example#L6).
- Backend scripts do not preload tracing yet; `start` is `nest start`, `dev` is `nest start --watch`, and `build` is `nest build` [apps/backend/package.json:5](../../../../apps/backend/package.json#L5)-[12](../../../../apps/backend/package.json#L12). M0.5 needs a deterministic built start path that preloads `dist/tracing.js`.

### Existing infrastructure

- Compose already defines Postgres, ClickHouse, and Collector under `infra`/`full` profiles [infra/docker-compose.yml:1](../../../../infra/docker-compose.yml#L1)-[47](../../../../infra/docker-compose.yml#L47). ClickHouse currently has no healthcheck by design, deferred to M0.5 [infra/docker-compose.yml:21](../../../../infra/docker-compose.yml#L21)-[34](../../../../infra/docker-compose.yml#L34).
- Collector currently receives OTLP gRPC/HTTP but exports only to `debug` [infra/collector/config.yaml:1](../../../../infra/collector/config.yaml#L1)-[18](../../../../infra/collector/config.yaml#L18). M0.5 must replace/add ClickHouse export for traces while keeping a debug exporter useful in dev.
- `infra/clickhouse/init` contains only `.gitkeep` [infra/clickhouse/init/.gitkeep:1](../../../../infra/clickhouse/init/.gitkeep#L1), so no read VIEW exists.
- A direct Docker init SQL file cannot assume `otel_traces` already exists: ClickHouse init scripts run when the ClickHouse container initializes, while `otel_traces` is created later by Collector's exporter after the first trace. To preserve "table owned by exporter" [docs/design/001-rag-platform-architecture.md:91](../../../../docs/design/001-rag-platform-architecture.md#L91)-[91], VIEW creation must be an explicit backend-side init/check step or a lazy `ensureViews()` operation that runs after exporter schema creation, not a fragile startup-only script. Therefore the source-controlled view SQL should live outside the Docker entrypoint init directory.

### Contracts and package boundaries

- `@codecrush/contracts` currently depends only on `zod` [packages/contracts/package.json:17](../../../../packages/contracts/package.json#L17)-[23](../../../../packages/contracts/package.json#L23), but it still exports minimal `GEN_AI`/`RAG` constants through `packages/contracts/src/index.ts` [packages/contracts/src/index.ts:1](../../../../packages/contracts/src/index.ts#L1)-[2](../../../../packages/contracts/src/index.ts#L2) and `packages/contracts/src/otel.ts` [packages/contracts/src/otel.ts:1](../../../../packages/contracts/src/otel.ts#L1)-[16](../../../../packages/contracts/src/otel.ts#L16). The updated code-organization decision says `contracts` does **not** carry OTLP attribute constants and only keeps API DTOs [docs/design/003-code-organization.md:237](../../../../docs/design/003-code-organization.md#L237)-[270](../../../../docs/design/003-code-organization.md#L270), so M0.5 must move those constants fully to `@codecrush/otel-conventions`.
- `003` revised M0.5 to cut out `@codecrush/otel-conventions` and `@codecrush/otel`: conventions are pure/shared, SDK is Node-only [docs/design/003-code-organization.md:237](../../../../docs/design/003-code-organization.md#L237)-[250](../../../../docs/design/003-code-organization.md#L250), and M0.5 should create generic primitives covering `llm/embeddings/tool/agent/retrieval/custom` [docs/design/003-code-organization.md:259](../../../../docs/design/003-code-organization.md#L259)-[270](../../../../docs/design/003-code-organization.md#L270). This is a deliberate M0.5 package-boundary change, not app code churn.
- `AGENTS.md` still says frontend may only import `@codecrush/contracts` and ground packages must stay pure [AGENTS.md:37](../../../../AGENTS.md#L37)-[46](../../../../AGENTS.md#L46). To avoid weakening that rule during M0.5, frontend continues to consume API DTOs through `@codecrush/contracts`; only backend and future Trace UI code should import pure convention constants from `@codecrush/otel-conventions`. `@codecrush/otel` must not import `@codecrush/contracts`, ClickHouse, or Trace API DTOs.

### Frontend and current consumers

- Frontend currently only calls `/health`, parses `HealthResponseSchema`, and displays status [apps/frontend/src/api/client.ts:1](../../../../apps/frontend/src/api/client.ts#L1)-[5](../../../../apps/frontend/src/api/client.ts#L5), [apps/frontend/src/pages/HomePage.tsx:5](../../../../apps/frontend/src/pages/HomePage.tsx#L5)-[18](../../../../apps/frontend/src/pages/HomePage.tsx#L18). M0.5 does not need UI changes; M2/M9 own page skeleton/full trace UI.
- Vite proxy only forwards `/health` today [apps/frontend/vite.config.ts:6](../../../../apps/frontend/vite.config.ts#L6)-[9](../../../../apps/frontend/vite.config.ts#L9). Because M0.5 acceptance can be backend/API-level, proxying `/traces` is optional and not part of done unless a tiny dev demo is added.

### Verified missing files / creation candidates

These files/directories do not exist today and should be created rather than extended: `apps/backend/src/tracing.ts`, `apps/backend/src/modules/traces/`, `apps/backend/src/platform/clickhouse/`, `packages/contracts/src/traces.ts`, `packages/otel-conventions/`, `packages/otel/`, `infra/clickhouse/views/001-trace-views.sql`, `apps/backend/test/traces.controller.spec.ts`, and `apps/backend/test/tracing.spec.ts`. `packages/contracts/src/otel.ts` exists today but should be removed or at least stop being exported, because `contracts` is no longer the OTLP constants package.

## Design Approach

### Shape of the closed loop

1. **Backend OTel preload**: add `apps/backend/src/tracing.ts` that starts a NodeSDK before Nest boot. It reads `OTEL_EXPORTER_OTLP_ENDPOINT` from env, uses an OTLP gRPC trace exporter, batch processing, and HTTP auto-instrumentation. Startup failures are caught/logged and never prevent Nest from starting.
2. **Generic telemetry package**: create `packages/otel` for Node-only tracing helpers and `packages/otel-conventions` for pure operation names, span kind/profile names, and attribute constants. `packages/otel` depends on `@opentelemetry/*` and conventions only; it must not depend on contracts, ClickHouse, backend modules, or Trace API DTOs.
3. **Collector -> ClickHouse**: update `infra/collector/config.yaml` to export traces to ClickHouse via `clickhouseexporter` while keeping debug output in dev. ClickHouse table creation remains exporter-owned.
4. **Read-side VIEW**: keep `infra/clickhouse/views/001-trace-views.sql` as source-controlled SQL outside Docker's entrypoint init directory, and execute equivalent SQL through backend `ensureTraceViews()` after `otel_traces` exists. The SQL projects the exporter table into a stable view such as `codecrush_trace_spans` with snake_case fields (`trace_id`, `span_id`, `parent_span_id`, `name`, `kind`, `start_time`, `duration_ms`, `status_code`, `attributes`).
5. **Traces API skeleton**: add `apps/backend/src/modules/traces` with:
   - `POST /traces/hello`: emits one manual `manual.hello` span using the generic telemetry helper, returns its `traceId` and `spanId`, and may explicitly `forceFlush()` with a short timeout because this endpoint exists only for M0.5 verification.
   - `GET /traces/:traceId`: reads the defensive view and returns a typed trace detail response.
   - Optional `GET /traces`: latest trace list for manual inspection.
6. **ClickHouse client boundary**: add a small `platform/clickhouse` module/provider using `@clickhouse/client`, configured via `CLICKHOUSE_URL` and optional database/user/password fields. Traces depend on this platform provider, not on collector internals.

### Scope choices

- M0.5 **does** implement the generic SDK/conventions package boundary because `003` explicitly says this happens in M0.5 [docs/design/003-code-organization.md:267](../../../../docs/design/003-code-organization.md#L267)-[270](../../../../docs/design/003-code-organization.md#L270). It may expose cheap semantic helper surfaces for `llm/embeddings/tool/agent/retrieval/custom`, but it does **not** implement agent/tool runtime behavior, endpoints, tests, or integrations.
- M0.5 **does not** build M9's full Trace UI, waterfall, session view, cost aggregation, RAG hit panels, replay, or prompt jumps. `004` describes those as the eventual read/UI model [docs/design/004-trace-observability.md:82](../../../../docs/design/004-trace-observability.md#L82)-[105](../../../../docs/design/004-trace-observability.md#L105); this wave only proves the storage/read abstraction.
- M0.5 **does not** add chat/RAG spans. M8 owns real pipeline traces [docs/design/002-implementation-roadmap.md:95](../../../../docs/design/002-implementation-roadmap.md#L95)-[99](../../../../docs/design/002-implementation-roadmap.md#L99).
- M0.5 **does not** introduce trace-normalizer worker, normalizer queue, or independent observations/traces/sessions wide write tables. Design 004 explicitly keeps those out of the first version [docs/design/004-trace-observability.md:30](../../../../docs/design/004-trace-observability.md#L30)-[37](../../../../docs/design/004-trace-observability.md#L37).

## Changes by File / Area

### New packages

- Create `packages/otel-conventions/`:
  - `package.json`, `tsconfig.json`, `src/index.ts`, focused tests.
  - Export `GEN_AI`, `RAG`, `OTEL_OPERATIONS`, and `CODECRUSH_SPAN_KIND`.
  - Dependency limit: `zod` only if schemas live here; otherwise zero runtime dependencies.
- Create `packages/otel/`:
  - `package.json`, `tsconfig.json`, `src/index.ts`, `src/node-sdk.ts`, `src/trace.ts`.
  - Export `startNodeTelemetry()`, `getTracer()`, `withSpan()`, semantic helpers such as `trace.custom()` and `trace.llm()`, `forceFlushTelemetry()`, and `shutdownTelemetry()`.
  - Node-only package; never imported by frontend or contracts.

### Contracts

- Extend `packages/contracts` with trace response schemas:
  - `HelloTraceResponseSchema`: `{ traceId: string; spanId: string; name: string }`
  - `TraceSpanSchema`: stable view projection fields.
  - `TraceDetailResponseSchema`: `{ traceId: string; spans: TraceSpan[] }`
  - Optional `TraceListItemSchema` if `GET /traces` is implemented.
- Remove `contracts/src/otel.ts` from the public `@codecrush/contracts` surface. `packages/contracts/src/index.ts` should export health and trace API DTOs only; OTLP constants move to `@codecrush/otel-conventions`. Current search shows no application code imports `GEN_AI`/`RAG` from contracts, so this does not require a frontend migration.

### Backend

- Add `apps/backend/src/tracing.ts` and update backend package scripts so production-style `start` preloads `dist/tracing.js` after `build`.
- Add OTel/ClickHouse dependencies to `apps/backend/package.json`, while keeping `@codecrush/contracts` as a workspace dependency [apps/backend/package.json:13](../../../../apps/backend/package.json#L13)-[24](../../../../apps/backend/package.json#L24).
- Extend config schema/service for `CLICKHOUSE_URL`, `CLICKHOUSE_DATABASE`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`, and `OTEL_EXPORTER_OTLP_ENDPOINT`. Use working local defaults where safe; never add secrets to `.env.example`.
- Add `apps/backend/src/platform/clickhouse/` with a provider token and service wrapping `@clickhouse/client`.
- Add `apps/backend/src/modules/traces/` with controller/service/repository/module.
- Update `AppModule` imports to include `ClickHouseModule` and `TracesModule`.
- Add backend unit tests for config defaults, traces controller/service behavior, and repository SQL mapping using mocks.

### Infra

- Update `infra/collector/config.yaml` from debug-only to OTLP receiver -> batch -> ClickHouse exporter plus debug exporter.
- Add ClickHouse healthcheck to `infra/docker-compose.yml` and make Collector wait for healthy ClickHouse if the image supports `clickhouse-client`.
- Add `infra/clickhouse/views/001-trace-views.sql` as the source SQL for view creation outside the Docker init directory, because Docker init timing cannot rely on exporter-owned `otel_traces` already existing.
- Pin `clickhouse/clickhouse-server` and `otel/opentelemetry-collector-contrib` image tags instead of `latest`. Current compose uses `latest` [infra/docker-compose.yml:21](../../../../infra/docker-compose.yml#L21)-[23](../../../../infra/docker-compose.yml#L23), [infra/docker-compose.yml:36](../../../../infra/docker-compose.yml#L36)-[38](../../../../infra/docker-compose.yml#L38), while `001` identifies exporter schema drift as a revisit trigger and says to lock the Collector version [docs/design/001-rag-platform-architecture.md:182](../../../../docs/design/001-rag-platform-architecture.md#L182)-[190](../../../../docs/design/001-rag-platform-architecture.md#L190).

### Verification scripts / docs

- Add a backend script such as `observability:verify` or `test:observability` that:
  1. assumes infra is running,
  2. starts or hits the backend,
  3. calls `POST /traces/hello`,
  4. waits/retries until `GET /traces/:traceId` returns the emitted span from the view.
- Update README M0.5 commands after implementation.
- If backend Jest tests import new workspace packages (`@codecrush/otel` or `@codecrush/otel-conventions`) directly, update `apps/backend/jest.config.js` module mapping or structure tests to import built/source-compatible modules. Existing Jest only maps `@codecrush/contracts` [apps/backend/jest.config.js:5](../../../../apps/backend/jest.config.js#L5)-[8](../../../../apps/backend/jest.config.js#L8).

## Acceptance Criteria

1. `pnpm lint`, `pnpm test`, and `pnpm build` pass.
2. `packages/otel-conventions` stays pure: no Node-only or browser-only dependencies; if it depends on anything, it is only `zod`.
3. `packages/otel` is Node-only, is not imported by frontend or contracts, and does not depend on `@codecrush/contracts`.
4. `@codecrush/contracts` exports no OTLP attribute constants; `GEN_AI`, `RAG`, `OTEL_OPERATIONS`, and `CODECRUSH_SPAN_KIND` live only in `@codecrush/otel-conventions`.
5. Backend built start preloads tracing before Nest bootstrap; `apps/backend/src/main.ts` does not import tracing directly.
6. When `OTEL_EXPORTER_OTLP_ENDPOINT` is missing or Collector is unavailable, backend startup and `/health` still work; telemetry failure is logged/degraded, not fatal.
7. With infra running, `POST /traces/hello` returns a concrete `traceId` and `spanId`.
8. Collector exports the hello span to ClickHouse table `otel_traces`, created/owned by `clickhouseexporter`.
9. Read API uses the defensive view/projection, not application direct writes to ClickHouse and not raw exporter columns in controller code.
10. `GET /traces/:traceId` returns the emitted hello span through `@codecrush/contracts` schemas.
11. At least one verification path proves HTTP auto-instrumentation or preloaded tracing order, addressing the `003` red-team warning.
12. Compose image tags for ClickHouse and Collector are pinned to known versions used by the M0.5 view SQL and validated by collector config validation plus the smoke path.

## Test Plan

- **Unit/contract tests**:
  - Validate new trace schemas accept representative hello trace responses and reject malformed IDs/fields.
  - Validate convention constants expose expected key names without pulling Node dependencies.
- **Backend tests**:
  - `TracesController` returns typed hello response from a mocked service.
  - `TracesRepository` maps ClickHouse JSON rows to contract DTOs and uses view names, not raw table names in public-layer code.
  - Config service exposes ClickHouse/OTLP values with local defaults.
- **Integration/manual verification**:
  - `docker compose -f infra/docker-compose.yml --profile infra up -d --wait`
  - `pnpm --filter @codecrush/backend build`
  - `pnpm --filter @codecrush/backend start`
  - `curl -X POST localhost:3000/traces/hello`
  - `curl localhost:3000/traces/<traceId>` returns the `manual.hello` span after retry.
- **Existing checks**:
  - Existing health controller tests remain valid [apps/backend/test/health.controller.spec.ts:13](../../../../apps/backend/test/health.controller.spec.ts#L13)-[28](../../../../apps/backend/test/health.controller.spec.ts#L28).
  - Existing frontend health client remains untouched unless README/demo wiring is extended [apps/frontend/src/api/client.ts:1](../../../../apps/frontend/src/api/client.ts#L1)-[5](../../../../apps/frontend/src/api/client.ts#L5).

## Risks / Unknowns

- **ClickHouse exporter schema drift**: The view is the anti-corruption layer. Keep raw exporter columns isolated to `infra/clickhouse/views/001-trace-views.sql` and one repository/query helper. If exporter column names differ in the installed collector image, adjust the view SQL, not controller DTOs.
- **View initialization timing**: Docker init alone is not reliable because exporter creates `otel_traces` after first trace. The plan must include explicit retry/lazy `ensureTraceViews()` after the exporter table exists.
- **Package-boundary ambiguity**: `003` now separates contracts from telemetry conventions. The implementation must keep all shared packages pure, remove OTLP constants from the contracts public surface, and preserve frontend's existing `@codecrush/contracts` import rule for API DTOs.
- **Flush semantics**: `POST /traces/hello` may force flush for deterministic verification. Future chat/RAG code must not wait synchronously on telemetry; that invariant remains binding.
- **Dev script tracing**: `nest start --watch` preloading TS tracing is less important than deterministic built startup for M0.5. If dev tracing is added, it must not compromise the built preload path.
- **Forbidden shortcut**: the traces API must not satisfy verification from in-memory spans or Postgres rows. It must read ClickHouse through the defensive view for the returned `traceId`.

## Self-Review

- Placeholder scan: no unresolved sections.
- Internal consistency: scope is limited to M0.5 closed loop and explicitly excludes M8/M9 UI/RAG behavior.
- Scope check: one coherent plan spanning packages, backend, infra, and verification because the feature is inherently end-to-end.
- Ambiguity check: view creation timing and package-boundary choices are made explicit.
- Integrity check: acceptance requires real Collector -> ClickHouse -> view -> API flow, so tests cannot pass by stubbing the entire chain.
