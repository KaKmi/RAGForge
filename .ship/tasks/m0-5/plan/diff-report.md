# Diff Report — M0.5 Plan Refresh

## Peer Runtime Note

This refresh used a same-provider peer agent (`019f30a7-e3b7-7b50-b513-a36f362ddcb8`) because no non-host peer runtime was exposed in the current tool set. The peer wrote `.ship/tasks/m0-5/plan/peer-spec.md` independently before seeing the host revisions.

## Prior Resolved Divergences Preserved

### D1 — HEAD SHA

- **Prior host claim**: `spec.md` recorded an older HEAD.
- **Prior peer claim**: current HEAD is `03c22eaf040d71c4f8131fc931396bb08da3c4d9`.
- **Evidence**: `git rev-parse HEAD` returned `03c22eaf040d71c4f8131fc931396bb08da3c4d9`.
- **Disposition**: conceded. `spec.md` already records the current HEAD.

### D2 — Hello Span Name

- **Prior host claim**: diagnostic endpoint should emit `codecrush.hello`.
- **Prior peer claim**: diagnostic endpoint should emit `manual.hello`.
- **Evidence**: Roadmap only requires a manual hello span, while the existing plan and contracts now consistently use `manual.hello`.
- **Disposition**: patched. `spec.md` and `plan.md` standardize on `manual.hello`.

### D3 — Compose Image Pinning

- **Prior host claim**: add ClickHouse healthcheck and Collector ClickHouse exporter.
- **Prior peer claim**: also pin ClickHouse and Collector image tags.
- **Evidence**: `infra/docker-compose.yml` currently uses `latest`; `docs/design/001` identifies exporter schema drift as a revisit trigger and says to lock Collector version.
- **Disposition**: patched. `spec.md` and `plan.md` require pinned versions and validation.

### D4 — Jest Workspace Package Mapping

- **Prior host claim**: add backend unit tests for traces/config/repository.
- **Prior peer claim**: backend Jest mapping must include new workspace packages.
- **Evidence**: `apps/backend/jest.config.js` currently maps only `@codecrush/contracts`.
- **Disposition**: patched. `plan.md` adds mappings for `@codecrush/otel` and `@codecrush/otel-conventions`.

### D5 — Verified Missing Files

- **Prior host claim**: proposed create paths across backend, packages, and infra.
- **Prior peer claim**: explicitly list verified missing files.
- **Evidence**: repository has no `apps/backend/src/tracing.ts`, no `apps/backend/src/modules/traces`, no `apps/backend/src/platform/clickhouse`, no `packages/otel*`, and no `infra/clickhouse/views/001-trace-views.sql`.
- **Disposition**: patched. `spec.md` keeps the verified creation candidates.

### D6 — Forbidden Shortcut: In-Memory / Postgres Trace Reads

- **Prior host claim**: acceptance requires real Collector -> ClickHouse -> view -> API flow.
- **Prior peer claim**: explicitly forbid satisfying the API from in-memory spans or Postgres rows.
- **Evidence**: architecture says applications emit OTLP and do not write ClickHouse directly; roadmap acceptance requires span -> Collector -> ClickHouse -> traces API.
- **Disposition**: patched. `spec.md` and `plan.md` make this explicit.

## Refresh Divergences Resolved

### D7 — Contracts Should Not Keep OTLP Constants

- **Host pre-refresh state**: `spec.md` allowed `contracts/src/otel.ts` as a compatibility facade and `plan.md` modified it.
- **Peer claim**: updated docs require `@codecrush/contracts` to keep API DTOs only; OTLP constants belong in `@codecrush/otel-conventions`.
- **Evidence**: `docs/design/003-code-organization.md` states contracts do not carry OTLP constants and M0/M0.5 create `packages/otel-conventions` / `packages/otel`; current `packages/contracts/src/index.ts` still exports `./otel`.
- **Disposition**: conceded. `spec.md` now requires removing `contracts/src/otel.ts` from the public surface, and `plan.md` deletes `packages/contracts/src/otel.ts` plus verifies no constants remain under contracts.

### D8 — `@codecrush/otel` Must Not Depend On API Contracts

- **Host pre-refresh state**: `@codecrush/otel` returned `HelloTraceResponse` and depended on `@codecrush/contracts`.
- **Peer claim**: SDK should return neutral span identity; API DTO conversion belongs in backend traces module.
- **Evidence**: `docs/design/001` and `003` say `@codecrush/otel*` only handles trace semantics/OTLP emission and must not know Trace API or physical storage.
- **Disposition**: conceded. `plan.md` now defines `SpanIdentity`, removes `@codecrush/contracts` from `packages/otel/package.json`, and adds a boundary check.

### D9 — Commit Steps Conflict With Repo Instructions

- **Host pre-refresh state**: each plan task ended with `git commit`.
- **Peer claim**: commit steps should be removed because repo instructions say commits only when requested.
- **Evidence**: `AGENTS.md` says "提交或推送仅在被要求时进行".
- **Disposition**: conceded. `plan.md` removes all commit steps and adds a global constraint that tasks must not include commits unless the user requests them.

### D10 — Task 5 Should Not Mark Design Docs Complete

- **Host pre-refresh state**: Task 5 modified `docs/design/002`, `003`, and `004` to add M0.5 completion notes.
- **Peer claim**: current design docs already carry the architecture; implementation should not mark them complete until evidence exists, and this plan refresh should focus on plan artifacts.
- **Evidence**: docs are authoritative and already define M0.5 scope; status should be updated only after implementation is verified.
- **Disposition**: conceded. Task 5 now modifies only `README.md`, runs full checks, and runs the real closed-loop smoke path.

### D11 — Collector Config Must Preserve Batch Processor

- **Host pre-refresh state**: proposed Collector config had `processors: []`.
- **Peer claim**: keep `batch`, since current config uses it and architecture calls out Collector batch/retry behavior.
- **Evidence**: `infra/collector/config.yaml` currently declares `batch`, and `docs/design/001` diagram names batch/retry.
- **Disposition**: patched. `plan.md` now declares `processors.batch` and uses `processors: [batch]`.

### D12 — VIEW SQL Should Have One Canonical Source

- **Host pre-refresh state**: plan created `infra/clickhouse/views/001-trace-views.sql` and duplicated SQL in `ClickHouseTracesRepository`.
- **Peer claim**: keep physical SQL in `infra/clickhouse/views` and have backend execute/read that source rather than duplicating it.
- **Evidence**: `docs/design/003` separates physical storage/query from `@codecrush/otel`; `docs/design/004` says physical VIEW belongs to infra/backend traces, not SDK.
- **Disposition**: patched. `plan.md` makes the repository read `infra/clickhouse/views/001-trace-views.sql` before executing the view creation.

### D13 — `infra/clickhouse/init` Path Was Stale

- **Host finding during diff**: updated plan used `infra/clickhouse/views`, but `docs/design/003` still referenced `infra/clickhouse/init` for VIEW SQL.
- **Peer context**: peer also pointed out the physical VIEW owner must be explicit.
- **Evidence**: Docker init timing is unsafe because exporter-owned `otel_traces` may not exist when ClickHouse container init runs.
- **Disposition**: patched. `docs/design/003-code-organization.md` now names `infra/clickhouse/views` and says M0.5 applies the VIEW through explicit/lazy initialization.

## Escalations

None. All divergences were resolved by file-backed evidence without user input.
