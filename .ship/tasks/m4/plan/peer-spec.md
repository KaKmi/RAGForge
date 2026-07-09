# M4 Peer Spec — Ingestion Pipeline And Knowledge Base Management

## 1. Problem And Motivation

M4 must replace the current M2 knowledge-base mock surface with real persisted KB, document, chunk, storage, queue, and ingestion behavior. The authoritative design says M4 owns `knowledge_bases` / `documents` / `chunks`, `platform/storage`, `platform/queue`, a four-stage ingestion pipeline, and blue-green chunk versions via `chunks.version` plus `knowledge_bases.active_version/building_version` [docs/design/007-m4-ingestion-pipeline.md:20]. The current implementation is not there yet: `KnowledgeBasesService`, `DocumentsService`, `ChunksService`, and `IngestionService` still use in-memory mock arrays or fixed status responses [apps/backend/src/modules/knowledge-bases/knowledge-bases.service.ts:4] [apps/backend/src/modules/documents/documents.service.ts:4] [apps/backend/src/modules/chunks/chunks.service.ts:4] [apps/backend/src/modules/ingestion/ingestion.service.ts:6].

The task is architectural, not just UI/API cleanup. Done means a PDF/Word/Markdown/TXT upload can persist to blob storage, enqueue ingestion, parse/clean/chunk/embed into pgvector-backed chunks, expose document lifecycle and metadata, support chunk search and batch deletion, and rebuild a KB by writing a new chunk version while reads keep using the old active version until atomic cutover [docs/design/007-m4-ingestion-pipeline.md:53] [docs/design/007-m4-ingestion-pipeline.md:131].

## 2. Design Approach

Implement the M4 stack in four coordinated layers.

First, update `@codecrush/contracts` as the single API DTO source. The current contract still has `Chunk.enabled` and `UpdateChunkEnabledRequestSchema` [packages/contracts/src/chunks.ts:3], document status values `upload/ingest/ready/failed` and `stage` [packages/contracts/src/documents.ts:3], and KB schema without `chunkTemplate` [packages/contracts/src/knowledge-bases.ts:6]. M4 must change those contracts to the 007 REST shape: chunk deletion rather than enable/disable, document statuses `pending/queued/processing/failed/ready`, metadata/lifecycle/content/chunk pagination schemas, KB `chunkTemplate/status/progress`, and multipart upload response types [docs/design/007-m4-ingestion-pipeline.md:115].

Second, add real persistence. Drizzle currently exports only `app_meta`, users, prompts, and model providers from the central schema barrel [apps/backend/src/db/schema.ts:1]. Domain schemas for KBs, documents, and chunks do not exist, and repositories do not exist either, as verified by file checks during investigation. The M4 implementation should add `schema.ts` and repository files for `knowledge-bases`, `documents`, and `chunks`, then export them from `apps/backend/src/db/schema.ts` so drizzle-kit can generate one M4 migration. The schema must follow 007: `knowledge_bases` with unique name, chunk template, embedding model FK, status, active/building versions; `documents` with blob key, parsed text, metadata jsonb, status, chunk version, lifecycle, error; and `chunks` with `version`, `seq`, text, section, token count, `vector(1024)`, and unique `(doc_id, version, seq)` [docs/design/007-m4-ingestion-pipeline.md:73]. `infra/postgres/init.sql` already enables `vector` [infra/postgres/init.sql:1], and compose already uses the pgvector image [infra/docker-compose.yml:3].

Third, add platform infrastructure and ingestion. `platform/storage` and `platform/queue` files are missing, while 007 requires `BlobStore` and pg-boss worker infrastructure [docs/design/007-m4-ingestion-pipeline.md:97]. Backend dependencies currently include Nest, Drizzle, `pg`, and Zod, but not `pg-boss`, `pdf-parse`, `mammoth`, or explicit upload/parser dependencies in the shown dependency block [apps/backend/package.json:16]. Add the needed dependencies; add `LOCAL_BLOB_ROOT` and queue/upload limit config in `envSchema` and `.env.example`, where only DB/ClickHouse/OTel/JWT/model-key variables exist today [apps/backend/src/platform/config/config.schema.ts:3] [apps/backend/.env.example:1]. The storage module should generate blob keys server-side in the exact `kb/{kbId}/{docId}/original.{ext}` shape required by invariant 4 [docs/design/007-m4-ingestion-pipeline.md:41].

Fourth, rewrite the frontend KB three-screen area against the new API and current prototype. The current pages still import M2 mock data [apps/frontend/src/pages/admin/KnowledgeBasesPage.tsx:3] [apps/frontend/src/pages/admin/DocumentsPage.tsx:3] [apps/frontend/src/pages/admin/ChunksPage.tsx:3]. The latest prototype shows list cards with only document count/update time and busy blue pulse [RAG知识库问答系统设计/CodeCrushBot.dc.html:636], detail summary with chunk template and embedding plus edit [RAG知识库问答系统设计/CodeCrushBot.dc.html:669], metadata modal [RAG知识库问答系统设计/CodeCrushBot.dc.html:725], chunk split view with batch delete/search/full-brief/infinite scroll [RAG知识库问答系统设计/CodeCrushBot.dc.html:752], upload drawer with single-file/folder and auto-parse switch [RAG知识库问答系统设计/CodeCrushBot.dc.html:812], and create/edit KB modals with embedding locked on edit [RAG知识库问答系统设计/CodeCrushBot.dc.html:907].

## 3. Investigation Findings

Entrypoints and caller chain:

- `AppModule` imports `KnowledgeBasesModule`, `DocumentsModule`, `IngestionModule`, `ChunksModule`, `RetrievalModule`, and `ModelsModule` as M2/M3 domain modules [apps/backend/src/app.module.ts:23]. `main.ts` applies `/api` as the global prefix through `applyGlobalConfig` [apps/backend/src/main.ts:8] [apps/backend/src/app/app-bootstrap.ts:10].
- Existing KB API is `GET/POST /api/knowledge-bases` and `GET /api/knowledge-bases/:id`; there is no PATCH yet [apps/backend/src/modules/knowledge-bases/knowledge-bases.controller.ts:8].
- Existing document API is `GET /api/documents?kbId=...`, `GET /api/documents/:id`, and JSON `POST /api/documents`; M4 must replace upload with `POST /api/knowledge-bases/:id/documents` multipart and add lifecycle/metadata/content/delete endpoints [apps/backend/src/modules/documents/documents.controller.ts:8] [docs/design/007-m4-ingestion-pipeline.md:119].
- Existing ingestion API is old `POST /api/documents/:id/ingest` and `GET /api/documents/:id/ingestion-status`; 007 says the manual/retry endpoint should be `POST /api/documents/:id/parse`, lifecycle should be separate, and status should be persisted on document rows [apps/backend/src/modules/ingestion/ingestion.controller.ts:5] [docs/design/007-m4-ingestion-pipeline.md:121].
- Existing chunk API is `GET /api/chunks/:docId` plus `PATCH /api/chunks/:id` for enabled toggle; M4 must change to `GET /api/documents/:id/chunks?offset&limit&q` and `POST /api/chunks/batch-delete` [apps/backend/src/modules/chunks/chunks.controller.ts:8] [docs/design/007-m4-ingestion-pipeline.md:124].

Analogous M3 feature:

- Models are the best backend precedent. Contracts define enums, request schemas, read schemas, and legal protocol combinations [packages/contracts/src/models.ts:3]. Backend has a domain schema [apps/backend/src/modules/models/schema.ts:7], repository [apps/backend/src/modules/models/models.repository.ts:7], service with validation/encryption/port calls [apps/backend/src/modules/models/models.service.ts:33], controller DTOs via `createZodDto` [apps/backend/src/modules/models/models.controller.ts:13], and module exports for downstream consumers [apps/backend/src/modules/models/models.module.ts:8].
- `ModelsModule` already exports `ModelsService` and `MODEL_PROVIDER_PORT`, with a comment saying M4 ingestion should consume the port rather than adapters [apps/backend/src/modules/models/models.module.ts:15].
- `ModelProviderPort` currently exposes only `testConnection`, and the file explicitly notes M4/M8 should add required methods such as `embed()` [apps/backend/src/modules/models/ports/model-provider.port.ts:3]. Protocol dispatch currently uses a builder table for test probes [apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts:23], and tests assert the table covers all contract protocol combinations [apps/backend/test/protocol-dispatch.adapter.spec.ts:25].
- Embedding test probes exist for supported embedding protocols, but they only test response shape, not real batch embedding calls [apps/backend/src/modules/models/adapters/protocols/openai-compat.ts:26].

Existing infrastructure:

- Postgres and Drizzle are global. `PersistenceModule` creates a `NodePgDatabase<typeof schema>` from `DATABASE_URL` [apps/backend/src/platform/persistence/persistence.module.ts:8].
- Migrations are explicit through `pnpm db:migrate` and `src/db/migrate.ts`, not startup-time migrations [apps/backend/src/db/migrate.ts:6].
- Auth is already global via `APP_GUARD`, so M4 endpoints are JWT-protected by default unless marked public [apps/backend/src/modules/auth/auth.module.ts:21]. The guard requires `Authorization: Bearer ...` and attaches an authenticated user [apps/backend/src/modules/auth/jwt-auth.guard.ts:22].
- `@codecrush/otel` is available to backend and already used in `ModelsService` around model test spans [apps/backend/src/modules/models/models.service.ts:13]. 007 requires ingestion stage spans but says they must stay async and not touch the chat critical path [docs/design/007-m4-ingestion-pipeline.md:158].
- ESLint only enforces package-level boundaries today, not all backend module barrel/adapters rules [eslint.config.mjs:30]. This matters because 003 says direct `adapters/` imports should be forbidden and cross-domain module access should go through services/ports [docs/design/003-code-organization.md:139].

Consumer chain and affected data structures:

- `Chunk.enabled` is consumed by the contract schema and update request [packages/contracts/src/chunks.ts:11], backend mock data and `setEnabled` [apps/backend/src/modules/chunks/chunks.service.ts:43], controller DTO and PATCH route [apps/backend/src/modules/chunks/chunks.controller.ts:1], frontend chunk page toggle state/batch enable/disable controls [apps/frontend/src/pages/admin/ChunksPage.tsx:31], and contract tests [packages/contracts/src/m2-schemas.test.ts:67]. This field and route must be removed, not left as dead compatibility, because 007 explicitly forbids an enabled switch [docs/design/007-m4-ingestion-pipeline.md:36].
- `Document.status`, `stage`, and `blobKey` are in the contract [packages/contracts/src/documents.ts:9], backend mock rows [apps/backend/src/modules/documents/documents.service.ts:4], frontend mock lifecycle helpers [apps/frontend/src/mocks/knowledge-bases.ts:71], and skeleton e2e tests [apps/backend/test/skeleton.e2e.spec.ts:394]. M4 must replace status values and stop accepting client-supplied `blobKey`.
- `KnowledgeBase.docsCount/chunksCount/status/progress` are in the contract [packages/contracts/src/knowledge-bases.ts:6], backend mock rows [apps/backend/src/modules/knowledge-bases/knowledge-bases.service.ts:4], frontend mock list data [apps/frontend/src/mocks/knowledge-bases.ts:16], and skeleton e2e tests [apps/backend/test/skeleton.e2e.spec.ts:380]. M4 must add `chunkTemplate`, active/building version behavior, and progress derived from persisted document state.
- Frontend typed API client currently has only `getKnowledgeBases`, `getDocuments(kbId)`, `getIngestionStatus(docId)`, and `getChunks(docId)` for the KB surface [apps/frontend/src/api/client.ts:163]. M4 needs typed clients for create/update KB, multipart upload, parse/retry, lifecycle, metadata, content, paginated chunks, and batch-delete.

Existing tests expected to break and be rewritten:

- `packages/contracts/src/m2-schemas.test.ts` imports and asserts `UpdateChunkEnabledRequestSchema`, old document statuses, old chunk enabled, old create KB/document shapes, and `IngestionStatusSchema` [packages/contracts/src/m2-schemas.test.ts:1].
- `apps/backend/test/skeleton.e2e.spec.ts` asserts old JSON document upload, old `/ingest` and `/ingestion-status` paths, old chunk `PATCH /api/chunks/:id`, and old OpenAPI paths [apps/backend/test/skeleton.e2e.spec.ts:402] [apps/backend/test/skeleton.e2e.spec.ts:725].
- `apps/frontend/src/app/App.test.tsx` currently verifies real API wiring for models/prompts but not KB pages [apps/frontend/src/app/App.test.tsx:85]. M4 should add equivalent tests proving KB pages call the real API rather than mocks.

Unresolved assumptions from code alone:

- The exact parser packages and request/response shapes for every provider’s real embedding call are not implemented; M3 only has test probes [apps/backend/src/modules/models/adapters/protocol-dispatch.adapter.ts:49]. The spec selects the same builder-table style for embedding, but implementation must validate each builder with unit tests.
- The design requires `multer` memory upload into BlobStore [docs/design/007-m4-ingestion-pipeline.md:65], but direct `multer` and parser dependencies are not in `apps/backend/package.json` today [apps/backend/package.json:16]. Implementation should decide whether Nest’s platform-express transitive multer types are enough or add explicit dependencies/types.
- Product text in `CodeCrushBot.dc.html` still contains an outdated “启用后才能被检索” detail summary line [RAG知识库问答系统设计/CodeCrushBot.dc.html:665], while 007 says that wording is outdated and must not be restored [docs/design/007-m4-ingestion-pipeline.md:143].

## 4. Backend Changes By File

- `apps/backend/package.json`: add `pg-boss`, `pdf-parse`, `mammoth`, and any required upload/parser type packages. Keep `@codecrush/contracts`, `@codecrush/otel`, Drizzle, and `pg` as existing runtime dependencies [apps/backend/package.json:16].
- `apps/backend/src/platform/config/config.schema.ts`, `config.service.ts`, `.env.example`: add blob root, upload limits, worker concurrency, queue retry/batch defaults, and expose getters. Existing env validation is centralized in `envSchema` and `AppConfigService` [apps/backend/src/platform/config/config.schema.ts:3] [apps/backend/src/platform/config/config.service.ts:5].
- `infra/docker-compose.yml`: add a named blob volume for the `full` backend service when/if backend is containerized, or document host path for local dev; current compose has only `pgdata` and `chdata` volumes [infra/docker-compose.yml:56].
- New `apps/backend/src/platform/storage/*`: create `BlobStore` token/port with `put/get/delete`, `StorageModule`, and `LocalFsBlobStore`. It must normalize by construction: business code passes generated blob keys, the adapter joins under configured root and rejects traversal before touching filesystem. 007 requires local volume storage and server-generated blob keys [docs/design/007-m4-ingestion-pipeline.md:99] [docs/design/007-m4-ingestion-pipeline.md:168].
- New `apps/backend/src/platform/queue/*`: create pg-boss wrapper, queue constants, enqueue API, and lifecycle-managed worker registration. It must use `singletonKey=documentId` and `retryLimit=1` for document ingestion jobs [docs/design/007-m4-ingestion-pipeline.md:100]. The queue layer should not know ingestion internals beyond job name/payload.
- New `apps/backend/src/modules/knowledge-bases/schema.ts` and `knowledge-bases.repository.ts`: table, insert/list/get/update helpers, name uniqueness, counts/progress queries, `markBuilding`, atomic cutover, old-version cleanup selection. No service imports in schema because 003 requires pure co-located schemas [docs/design/003-code-organization.md:147].
- `apps/backend/src/modules/knowledge-bases/knowledge-bases.service.ts`: replace mocks with repository-backed CRUD. Create validates name uniqueness, embedding model exists/enabled/type `embedding`, and a 1024-dimension probe; edit locks embedding model and triggers rebuild on `chunkTemplate` change. A second template change while `building_version` exists returns 409 per design assumption [docs/design/007-m4-ingestion-pipeline.md:185].
- `apps/backend/src/modules/knowledge-bases/knowledge-bases.controller.ts`: add PATCH `/:id`, use Zod DTOs for create/update, and return M4 response DTOs.
- New `apps/backend/src/modules/documents/schema.ts` and `documents.repository.ts`: document table with `kb_id`, server blob key, parsed text, metadata jsonb, status, chunk version, lifecycle jsonb, error, timestamps, and count helpers [docs/design/007-m4-ingestion-pipeline.md:79].
- `apps/backend/src/modules/documents/documents.controller.ts`: replace JSON upload with `POST /knowledge-bases/:id/documents` multipart files plus `autoParse` and `relativePath[]`; add `POST /documents/:id/parse`, `GET /documents/:id/lifecycle`, `PATCH /documents/:id/metadata`, `DELETE /documents/:id`, and `GET /documents/:id/content`. Existing controller only has list/get/JSON POST [apps/backend/src/modules/documents/documents.controller.ts:8].
- `apps/backend/src/modules/documents/documents.service.ts`: create document rows, infer/validate file type, generate blob key, call BlobStore, enqueue parse when `autoParse=true`, mark pending otherwise, and delete rows/blob/chunks. It must ignore client-supplied paths and not accept `blobKey` from requests [docs/design/007-m4-ingestion-pipeline.md:45].
- New `apps/backend/src/modules/chunks/schema.ts` and `chunks.repository.ts`: chunks table with vector(1024), `unique(doc_id, version, seq)`, HNSW index, query by doc/version with `offset/limit/q`, batch delete, and transactional replace for document/version. 007 specifies no M4 FTS column yet [docs/design/007-m4-ingestion-pipeline.md:38].
- `apps/backend/src/modules/chunks/chunks.controller.ts` and `chunks.service.ts`: remove PATCH enabled flow, expose `GET /documents/:id/chunks?offset&limit&q` and `POST /chunks/batch-delete`. Batch-delete must hard-delete selected chunk ids and return a count or accepted ids; no soft `enabled` compatibility [docs/design/007-m4-ingestion-pipeline.md:125].
- `apps/backend/src/modules/ingestion/*`: add `ports/` for `IngestionPipelinePort`, `DocumentParserPort`, `TextCleanerPort`, and `ChunkerPort`; add default adapters/registries for PDF/Word/Markdown/TXT parsers and general/QA chunkers. The current ingestion service only returns fixed statuses [apps/backend/src/modules/ingestion/ingestion.service.ts:5].
- `apps/backend/src/modules/ingestion/ingestion.service.ts`: become job orchestration, not status DTO mock. It should enqueue manual/retry jobs, process worker jobs, update lifecycle stages, handle deleted documents idempotently, and call the pipeline with target version `building_version ?? active_version` [docs/design/007-m4-ingestion-pipeline.md:131].
- `apps/backend/src/modules/models/ports/model-provider.port.ts`, `protocol-dispatch.adapter.ts`, and `protocols/*`: add `embed(config, texts, options)` returning `number[][]`, implement `(embedding, protocol)` builders, merge `dimensions: "1024"` and `batch_size`, validate all vectors are length 1024, redact secrets, and expose `ModelsService.embedTexts(modelId, texts)`. Current port only has `testConnection` [apps/backend/src/modules/models/ports/model-provider.port.ts:23].
- `apps/backend/src/modules/*/*.module.ts`: update module imports/exports so `ingestion` can depend on documents/chunks/models/storage/queue and documents can depend on KB/storage/queue without circular imports, consistent with 003 dependency edges [docs/design/003-code-organization.md:123].
- `apps/backend/src/db/schema.ts` and `apps/backend/drizzle/*`: export the new schemas and generate one M4 migration. Existing migration style is plain generated SQL in `apps/backend/drizzle` [apps/backend/drizzle/0003_reflective_matthew_murdock.sql:1].

## 5. Contracts Changes By File

- `packages/contracts/src/knowledge-bases.ts`: add `ChunkTemplateSchema = z.enum(["general","qa"])`; add `chunkTemplate`, optional `embeddingModelName`, `activeVersion`, `buildingVersion`, derived `docsCount`, optional `chunksCount` if needed by detail but list UI should not require it; add create/update schemas. Create requires `name`, optional `desc`, `chunkTemplate`, `embeddingModelId`; update allows `name`, `desc`, `chunkTemplate` but not embedding model [docs/design/007-m4-ingestion-pipeline.md:26].
- `packages/contracts/src/documents.ts`: replace status enum with `pending/queued/processing/failed/ready`; add `metadata`, `lifecycle`, `chunkVersion`, `uploadedAt`, `updatedAt`, `error`; add lifecycle stage schemas, metadata patch schema, content response schema, parse response schema, and upload response schema. 007’s table maps these statuses directly [docs/design/007-m4-ingestion-pipeline.md:95].
- `packages/contracts/src/chunks.ts`: remove `enabled` and `UpdateChunkEnabledRequestSchema`; add chunk `version`, paginated/list response with `items/total/offset/limit/hasMore`, query schema, and batch-delete request/response. 007 says chunk list is infinite scroll 20/page and batch delete [docs/design/007-m4-ingestion-pipeline.md:30].
- `packages/contracts/src/index.ts`: continue exporting the three revised modules [packages/contracts/src/index.ts:6].
- `packages/contracts/src/m2-schemas.test.ts`: either split M4 tests out or rewrite affected M2 assertions. Do not keep old tests by loosening schemas to accept both old and new shapes; 007 calls the contract revision intentionally breaking [docs/design/007-m4-ingestion-pipeline.md:127].

## 6. Frontend Changes By File

- `apps/frontend/src/api/client.ts`: add typed API functions for KB create/update/get/list; `uploadDocuments(kbId, FormData)` without JSON `Content-Type`; `parseDocument`; `getDocumentLifecycle`; `patchDocumentMetadata`; `deleteDocument`; `getDocumentContent`; `getDocumentChunks({docId, offset, limit, q})`; and `batchDeleteChunks`. Current client only exposes read-only mock-era KB/document/chunk calls [apps/frontend/src/api/client.ts:163].
- `apps/frontend/src/pages/admin/KnowledgeBasesPage.tsx`: replace `KB_ROWS` mock with `getKnowledgeBases()`, loading/error/empty states, 3s polling for building KBs, create modal using enabled embedding models from `/api/models`, name duplicate error surfacing, and route by KB id rather than KB name. Current page navigates with encoded name [apps/frontend/src/pages/admin/KnowledgeBasesPage.tsx:38].
- `apps/frontend/src/pages/admin/DocumentsPage.tsx`: replace `KB_DOCS` mock with real KB detail/documents. Show config summary row and edit modal; include document metadata modal; upload drawer must use real `<input type=file multiple>` and folder mode with `webkitdirectory` where supported; auto-parse off creates pending rows with a start parse action; lifecycle drawer uses backend lifecycle. Current upload drawer is a local picked boolean and chunk strategy selector [apps/frontend/src/pages/admin/DocumentsPage.tsx:48].
- `apps/frontend/src/pages/admin/ChunksPage.tsx`: replace local `chunkOff/chunkDel` state with backend content/chunk APIs, remove enable/disable buttons and switches, implement infinite scroll loading 20 at a time, keyword query, full/brief display, selection, and batch delete with API refresh. Current page still renders enable/disable buttons and switch controls [apps/frontend/src/pages/admin/ChunksPage.tsx:203].
- `apps/frontend/src/mocks/knowledge-bases.ts`: either delete unused KB mocks after migration or keep only test fixtures that are not imported by production pages. Production KB pages must stop importing it [apps/frontend/src/pages/admin/KnowledgeBasesPage.tsx:3].
- `apps/frontend/src/app/App.test.tsx`: add tests analogous to the Models/Prompts API wiring tests that assert KB/list/detail/chunks pages call `/api/knowledge-bases`, `/api/knowledge-bases/:id/documents`, `/api/documents/:id/content`, and `/api/documents/:id/chunks` [apps/frontend/src/app/App.test.tsx:111].

## 7. Intent, Non-Goals, And Forbidden Shortcuts

Satisfying M4 means implementing persisted behavior, not making the old skeleton tests pass with larger mocks. Forbidden shortcuts:

- Do not keep `Chunk.enabled`, enable/disable PATCH routes, frontend switches, or “启用后才能被检索” copy. The design says chunk management is deletion-only and that old wording is not to be restored [docs/design/007-m4-ingestion-pipeline.md:36] [docs/design/007-m4-ingestion-pipeline.md:143].
- Do not accept client blob keys, relative paths as storage paths, or static file serving. Blob key generation is server-side and content is served only through authenticated API [docs/design/007-m4-ingestion-pipeline.md:45] [docs/design/007-m4-ingestion-pipeline.md:170].
- Do not perform ingestion synchronously in the upload request. 007 requires pg-boss async worker behavior and queue persistence [docs/design/007-m4-ingestion-pipeline.md:100].
- Do not update chunks in-place during KB rebuild. Rebuild must use a new version and atomic active-version switch [docs/design/007-m4-ingestion-pipeline.md:132].
- Do not put metadata filtering, FTS `tsv`, OCR, per-file chunk templates, KB delete API, or embedding-model changes after KB creation into M4 [docs/design/007-m4-ingestion-pipeline.md:33].
- Do not import backend adapters directly from ingestion. The established boundary is port/service exports, and 003 explicitly calls out “拿端口,不拿适配器” [docs/design/003-code-organization.md:99].

## 8. Acceptance Criteria

- Creating a KB with duplicate name returns a validation/conflict error; creating with a disabled or non-embedding model is rejected; creating with an embedding model that cannot produce 1024 dimensions is rejected with a clear message [docs/design/007-m4-ingestion-pipeline.md:41].
- KB edit can change name/description/template, cannot change embedding model, and returns 409 when another rebuild is already in progress [docs/design/007-m4-ingestion-pipeline.md:185].
- Upload accepts PDF, Word, Markdown, and TXT; rejects unsupported type, oversized file, and path traversal; folder upload preserves safe relative display name only; `autoParse=false` creates pending documents without enqueuing ingestion [docs/design/007-m4-ingestion-pipeline.md:28].
- Manual parse/retry enqueues at most one active job per document id. Retrying an already queued/processing document is idempotent and does not create duplicate chunks [docs/design/007-m4-ingestion-pipeline.md:44].
- A successful document ingestion stores parsed text, lifecycle timings, document metadata, and chunks with embeddings length 1024; chunk replacement happens in one transaction so consumers never see zero chunks due to a mid-reparse delete [docs/design/007-m4-ingestion-pipeline.md:131].
- Changing a KB chunk template sets `building_version = active_version + 1`, enqueues all documents, shows percent progress, keeps old active chunks available until cutover, switches atomically when terminal documents complete, and later deletes old-version chunks in batches [docs/design/007-m4-ingestion-pipeline.md:132].
- Failed documents in a rebuild do not block final active-version switch; those documents are temporarily absent from the new version until retry succeeds [docs/design/007-m4-ingestion-pipeline.md:133].
- `GET /api/documents/:id/content` returns parsed text only for authenticated users; `GET /api/documents/:id/chunks?offset&limit&q` returns 20/page by default and filters by ILIKE keyword for M4 [docs/design/007-m4-ingestion-pipeline.md:124].
- Batch chunk delete physically removes selected chunk rows and the frontend reflects removal without exposing enable/disable state [docs/design/007-m4-ingestion-pipeline.md:125].
- OpenAPI JSON contains the new M4 paths and no longer advertises old `/api/documents/{id}/ingest`, `/api/documents/{id}/ingestion-status`, or `PATCH /api/chunks/{id}` behavior [apps/backend/test/skeleton.e2e.spec.ts:725].

## 9. Test Plan

Contracts:

- Rewrite schema tests for KB create/update, document lifecycle/status/metadata/content, chunk paginated list, and batch delete. Explicitly assert unknown `enabled` is stripped or rejected according to chosen Zod object strictness, and `UpdateChunkEnabledRequestSchema` is no longer exported [packages/contracts/src/m2-schemas.test.ts:356].

Backend unit tests:

- `KnowledgeBasesService`: name duplicate, embedding model type/enabled validation, 1024 probe failure, template-change rebuild start, 409 while building, atomic cutover trigger.
- `DocumentsService`: server-generated blob key, extension/magic-byte validation, autoParse true/false enqueue behavior, metadata patch, delete while job pending.
- `ChunksService`: paginated keyword query, batch delete, no enabled update.
- `IngestionService` and pipeline adapters: parser registry dispatch for four file types, empty/scanned PDF failure, cleaner behavior, general/QA chunker behavior, transactional replace, lifecycle updates, idempotent rerun.
- `ProtocolDispatchAdapter`: builder table coverage for real embedding calls and vector length validation, extending existing probe coverage tests [apps/backend/test/protocol-dispatch.adapter.spec.ts:25].
- `QueueModule` and `StorageModule`: lifecycle/close behavior, singleton enqueue payload, local path traversal defense.

Backend e2e:

- Replace skeleton KB/document/chunk tests with multipart upload flow, pending manual parse, ready status, content/chunks retrieval, metadata patch, batch delete, and OpenAPI path assertions. Existing tests are old-surface assertions and must be rewritten, not loosened [apps/backend/test/skeleton.e2e.spec.ts:402].

Frontend:

- Add API-client tests for FormData upload not setting JSON content type.
- Add page tests proving KB pages call real APIs and render empty/loading/error states, following the established M3 ModelsPage test pattern [apps/frontend/src/app/App.test.tsx:111].
- Add chunk page tests for search, infinite load trigger, full/brief toggle, select all, batch delete call, and absence of enable/disable controls.

Verification commands:

- `pnpm --filter @codecrush/contracts test`
- `pnpm --filter @codecrush/backend test`
- `pnpm --filter @codecrush/frontend test`
- `pnpm build`
- `pnpm lint`

## 10. Risks And Unknowns

- Real embedding builder compatibility is the highest integration risk because M3 only implemented lightweight probes and has no real `embed()` contract yet [apps/backend/src/modules/models/ports/model-provider.port.ts:23].
- pg-boss shares Postgres with app control data. This is accepted for M4 scale, but 007 already says >100 doc/min should trigger reconsideration toward BullMQ/Kafka [docs/design/007-m4-ingestion-pipeline.md:67].
- Upload folder mode support differs by browser. The frontend can use `webkitdirectory` for Chromium-family support but must still support multi-file upload; backend must treat relative path as display metadata, never as filesystem path [docs/design/007-m4-ingestion-pipeline.md:45].
- Blue-green progress based on terminal document counts needs a clear definition for documents uploaded during rebuild. 007 chooses “new uploads enter building version and become searchable only after cutover” [docs/design/007-m4-ingestion-pipeline.md:134].
- Large deletes and HNSW index build can be slow. 007 explicitly keeps old-version cleanup out of the switch transaction [docs/design/007-m4-ingestion-pipeline.md:132].

## 11. Self-Review Notes

- Placeholder scan: no placeholder requirements remain.
- Internal consistency: endpoint names use the 007 table, not the old M2 skeleton paths.
- Scope check: this spec covers M4 only; retrieval filtering consumption is noted for M5 but the M4 schema must store versions.
- Ambiguity check: chunk management is hard-delete only; embedding model is immutable after KB creation; rebuild conflict policy is 409 rather than queueing another rebuild.
- Integrity check: the spec forbids mock persistence, old compatibility routes, client blob keys, in-place rebuilds, and test loosening.
