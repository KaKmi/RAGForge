# Diff Report — M7 Agent 配置与管理

WARNING: No independent peer was available (Codex confirmed unavailable by user). This is a self-review diff, not host-vs-independent-peer. Per `/ship:design` Phase 2 fallback protocol, the host produced `peer-spec.md` as a second-pass self-critique of its own `spec.md`, then merged findings directly rather than keeping two divergent documents to formally diff.

## Divergences

None in the formal sense (no second independent author to diverge from). The self-review pass found two coverage gaps in the first-pass `spec.md`, both resolved by direct edit (disposition: **patched**, self-identified rather than peer-identified):

| # | Gap | Evidence | Disposition |
|---|---|---|---|
| 1 | `packages/contracts/src/m2-schemas.test.ts` (8 assertions against old flat Agent schema, lines 118-263) was missed because the first-pass consumer grep excluded `packages/` | `grep -rln "from \"@codecrush/contracts\"" apps/frontend/src apps/backend/src` scoped out `packages/contracts/src/m2-schemas.test.ts` itself | patched — added to spec.md "Changes by File → 契约层" |
| 2 | `apps/backend/test/skeleton.e2e.spec.ts:879-909` e2e agents block will break (DB-free test, `AgentsModule` currently needs no repository override; real `AgentsRepository` breaks `beforeAll` bootstrap; `validCreateAgent` fixture and hardcoded `"aftersale"` id are incompatible with the new contract and real persistence) | Read `skeleton.e2e.spec.ts:60-93, 355-403, 564-661, 879-909` directly | patched — added to spec.md Investigation Findings + Test Plan, including required `inMemoryAgentsRepo` + fixture-seeding approach |

## Escalated items

None. Both gaps were resolvable by further investigation (reading the actual files), not judgment calls requiring user input.

## Note on process integrity

Because this was self-review rather than genuine independent investigation, there is elevated risk of shared blind spots — a mistake in reasoning the host wouldn't catch even on a second pass, since it's the same reasoning process. The two gaps found above were both mechanical (missed grep scope, missed a specific test file) rather than judgment errors, which is consistent with what self-review can reliably catch (coverage/placeholder/contradiction issues) versus what it can't (a flawed design decision reasoned the same way twice). The four architecture-level decisions (KB rebind scope, Eval gate form, edit scope, v1 exemption) were already validated via genuine user sign-off in the upstream `/ship:arch-design` phase, which mitigates this risk for the highest-stakes calls.
