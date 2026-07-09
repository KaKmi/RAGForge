WARNING: Second spec was self-generated, not independent. Codex peer runtime was confirmed unavailable by the user before this phase started; per `/ship:design` Phase 2 fallback, the host self-produced this second pass instead of dispatching an independent peer agent. Treat the findings below as a self-critique pass, not a genuinely independent second opinion.

# Self-Review Pass — M7 Agent 配置与管理

Method: placeholder scan + contradiction scan + coverage scan + ambiguity scan on the host's own `spec.md`, plus a deliberate second sweep for consumers/tests the first investigation pass missed.

## Placeholder scan

No TBD/TODO/incomplete sections found in `spec.md`. Clean.

## Contradiction scan

No internal contradictions found between sections (Design Approach / Changes by File / Acceptance Criteria / Test Plan are consistent with each other and with `docs/design/008-m7-agent-management.md`).

## Coverage scan — this is where the first pass had real gaps

The first-pass investigation grepped for Agent-contract consumers with:

```
grep -rln "from \"@codecrush/contracts\"" apps/frontend/src apps/backend/src | xargs grep -l "Agent"
```

This scope excluded `packages/` itself. Re-running without that restriction surfaced two consumers the first pass missed entirely:

1. **`packages/contracts/src/m2-schemas.test.ts`** — 8 assertions (lines 118-119, 164-165, 221-238, 255-263) directly parse/assert the OLD flat `AgentSchema`/`CreateAgentRequestSchema`/`UpdateAgentRequestSchema` shape via a `valid.agent` fixture (line 54). These break the moment `agents.ts` contracts are rewritten. **This is now folded into spec.md's "Changes by File → 契约层" section.**
2. **`apps/backend/test/skeleton.e2e.spec.ts:879-909`** — a full e2e `describe("agents", ...)` block that exercises the current mock-backed HTTP endpoints, including a hardcoded `PATCH /api/agents/aftersale` that only works because `MOCK_AGENTS` has that literal id. This was the more consequential miss — the first pass's Test Plan section originally said "确认无测试直接断言旧 mock 数据" without actually running the check against this specific file. A targeted grep (`grep -n "agent" apps/backend/test/skeleton.e2e.spec.ts`) found it immediately. **This is now folded into spec.md's Investigation Findings and Test Plan sections, including the fact that this test file is fully DB-free (all repositories overridden with in-memory fakes) and that `AgentsModule` currently needs no such override — which is exactly why nobody noticed this coupling before.**

Lesson applied: the "cross-reference all consumers" step in the investigation methodology needs to search the whole repo, not just the two app directories that seemed obviously relevant. Contract test files living next to the schema definitions are an easy blind spot.

## Ambiguity scan

One point worth flagging as a judgment call rather than a hard blocker: the rewritten `skeleton.e2e.spec.ts` agents block cannot reuse the `modelId`/`kbId` variables created inside the "models"/"knowledge-bases" `describe` blocks (they're block-scoped, not shared), and the "prompts" `describe` block runs *after* "agents" in file order, so its fixtures aren't available either. The spec resolves this by requiring the agents block to build its own self-contained fixtures via real HTTP calls (mirroring the existing `ensureEmbeddingModel` pattern), and to move the block's fixture-dependent tests below "prompts" only if convenient — reordering top-level `describe` blocks is not required, self-contained `beforeAll` fixture creation is sufficient and lower-risk. This is now explicit in spec.md's Test Plan section; flagging it here so the plan-writing phase doesn't silently pick a different, incompatible approach (e.g. trying to read `inMemoryPrompts` internals directly, which would break test isolation from the established HTTP-driven fixture style in this file).

## Conclusion

No disposition needed against a second independent spec (none exists). All findings from this self-review pass have already been merged into `spec.md` directly — there is nothing left in this document that spec.md doesn't already reflect. This file exists to satisfy the artifact contract and to make the self-review process auditable.
