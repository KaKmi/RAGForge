# M4 Diff Report — host spec.md vs peer-spec.md

Peer runtime: Codex (`mcp__plugin_ship_codex__codex`, threadId `019f404f-2e19-7882-8ce9-7b8665a61f3c`). No debate rounds needed — both divergences below were resolved directly by reading the disk (peer was correct both times, host claim was wrong or incomplete).

## D1: pgvector extension — already enabled at container init, or must be added by migration?

- **Host spec claimed** (Risks/unknowns): "pgvector HNSW 索引在 drizzle-kit generate 流程下是否能被追踪... 假设手写 raw SQL migration...加 `CREATE EXTENSION IF NOT EXISTS vector;`" — implying the extension itself still needs to be created by the M4 migration.
- **Peer spec claimed**: "`infra/postgres/init.sql` already enables `vector`" [peer-spec.md:15, citing infra/postgres/init.sql:1].
- **Evidence**: `cat infra/postgres/init.sql` → `CREATE EXTENSION IF NOT EXISTS vector;`; `infra/docker-compose.yml:13` mounts it at `/docker-entrypoint-initdb.d/init.sql:ro` — runs once at first container init on the Postgres image.
- **Disposition**: **proven-false** (host). The extension is already enabled by infra, not by application migration. The M4 migration only needs to declare `vector(1024)` columns + HNSW index — no `CREATE EXTENSION` statement needed in the drizzle-generated SQL (though harmless if repeated via `IF NOT EXISTS`, it's not the mechanism 007 relies on).
- **Spec update**: spec.md Risks/unknowns section corrected; migration guidance in Changes-by-file no longer treats extension creation as an open risk.

## D2: frontend test precedent — is `api/sse.test.ts` the only existing frontend test file?

- **Host spec claimed** (Test plan): "现有 `api/sse.test.ts` 是本仓库前端测试的唯一先例，M4 前端测试深度对齐该先例的量级即可。"
- **Peer spec claimed**: `apps/frontend/src/app/App.test.tsx` exists and already tests real-API-wiring for ModelsPage/PromptsPage (`it("loads ModelsPage from real /api/models on /admin/models (M3)"...)`), citing lines 85/111.
- **Evidence**: `find apps/frontend/src -iname "*.test.*"` → 4 files: `api/sse.test.ts`, `app/App.test.tsx`, `mocks/models.test.ts`, `pages/chat/ChatPage.test.tsx`. Reading `App.test.tsx:111-133` confirms the exact pattern: mock `global.fetch`, mount page via route, assert the fetched URL list contains `/api/models` — proving the page calls the real API instead of local mock.
- **Disposition**: **proven-false** (host), and materially important — this is the exact test pattern M4 should replicate for KB/documents/chunks pages replacing their mocks, not something to under-scope.
- **Spec update**: Test plan → frontend section rewritten to point at `App.test.tsx`'s established pattern (mock fetch, assert real API URL called) as the concrete template for the three KB page rewrites, replacing the vague "align with sse.test.ts's scale" guidance.

## Agreement (no divergence, nothing to record beyond noting convergence)

Both specs independently arrived at the same conclusions on every other major point: M3 models module as the pattern to replicate (repo/service/port/registry); the four M2 mock services/controllers to replace; the exact set of contract fields to remove (`Chunk.enabled`, `UpdateChunkEnabledRequestSchema`) and add (`chunkTemplate`, document 5-value status, `metadata`/`lifecycle`, chunk `version`, batch-delete); the route migration from query-param/PATCH-toggle style to nested-resource/POST-batch-delete style; `ModelProviderPort.embed()` as a new required method; `platform/storage`/`platform/queue` as new platform modules; async-only rebuild via pg-boss with atomic version cutover; and the exact non-goals list (no KB delete, no per-file template override, no OCR, no FTS consumption, no post-create embedding model change).

## Post-diff spec.md updates applied

1. Risks/unknowns: removed the pgvector-extension-creation uncertainty; replaced with a note that `infra/postgres/init.sql` already handles it, migration only adds column/index DDL.
2. Test plan (frontend): replaced "sse.test.ts is the only precedent" with the `App.test.tsx` real-API-wiring pattern as the concrete template, per peer evidence.
3. Added docker-compose note (peer caught this, host missed it): if the backend is ever containerized, a blob volume will be needed alongside `pgdata`/`chdata` — noted as a plan follow-up, not urgent for local dev where `LocalFsBlobStore` just writes to a host-mounted path.

No escalated items — both divergences resolved by direct filesystem evidence, no debate round needed.
