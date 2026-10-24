# STAGE 8B — RUNTIME INTEGRATION CLOSURE

Status: IMPLEMENTED (Stage 8B)
Date: 2026-10-02

The Stage 8 mechanisms (Professional Handoff Contract, Smart Model Router V1)
are wired into the REAL CompanyOS canonical runtime. Nothing below is a
unit-only proof: every claim is driven through the application path
(`control-plane → engine claim → StageHandler → provider dispatch → provider →
settlement`) by `tests/stage8b/stage8b-runtime-integration.test.ts` and by the
embedded-kernel E2E gate (`pnpm test:kernel`).

## 1. Where each mechanism landed (no new truth)

| Stage 8 mechanism | Runtime seat | Existing owner reused |
|---|---|---|
| Smart Router V1 | the dispatch ROUTING PHASE in `provider-dispatch.ts` (after the safety preflight, before the durable dispatch claim and before any provider side effect) | Stage 6 `ModelPool`; Stage 7B attempt ownership |
| RoutingDecision evidence | `provider_dispatches.routing_decision_json` (new additive column, migration `engine/0006`) — the SAME per-attempt durable owner that already carries the provider binding | Sprint 24 `provider_dispatches` |
| SelectedModelRoute | `ExecutorExecutionRequest.selectedModelRoute` (additive optional) — attached to the attempt before invocation | `ExecutorExecutionRequest` contract |
| Provider role context | `ExecutorWorkInput.roleContext` (additive optional) + the kernel render in `dshTaskTextOf` | the Work Envelope contract |
| Professional Handoff write | the dispatch success path → `HandoffService.createDraft → ready` through the EXISTING Sprint-11 service | `handoffs` / `handoff_refs` tables |
| Consumer role context | `roleContextOf` seam: Work Package projection + durable handoff packets for the consumer task scope | the Work Package projector's handoff projection |
| Role catalog | seeded from the canonical `roles` table at composition; unknown seats fall back to Stage 7 dynamic synthesis | the `roles` table |
| Role execution budget | time budget → the kernel request timeout; turn/tool/token budgets enforced against outcome usage with a structured `ROLE_EXECUTION_BUDGET_EXHAUSTED` end | `ExecutionBudget` (Stage 7) |

**New tables added: ZERO.** The only schema change is one additive nullable
column on the existing per-attempt dispatch owner.

## 2. The runtime chain (mechanically proven)

```
Goal/Plan → Task → RoleInstance (canonical seat) → RoutingRequirements
  → Smart Router V1 → RoutingDecision → dispatch row (durable evidence)
  → ExecutionAttempt (engine claim) → request{selectedModelRoute, roleContext}
  → provider (consumes the route; never re-selects) → outcome
  → canonical Artifact + READY Handoff (Sprint-11 owner) → engine settlement
```

Proven by the runtime suite: every attempt receives the CompanyOS-selected
route; the dispatch row carries policyVersion/eligible/rejected/scoreBreakdown/
selectedProfileId/decisionPolicy; the provider-consumed profile equals the
decision's selection; a handoff packet references the durable artifact the same
attempt produced; a restart rebuilds the consumer context from durable truth.

## 3. Routing mode (§9)

`ComposeCoreServicesOptions.modelRouting.mode`:

- `DETERMINISTIC_V1` (default) — the Stage 6 deterministic selector stays the
  attempt's single selection authority; no route is attached, no routing
  evidence is recorded. Zero behavior change for existing compositions.
- `SMART_ROUTER_V1` — every provider-backed attempt is routed before the kernel
  is invoked; the provider then consumes the route verbatim.

One attempt, one selection authority: a SMART_ROUTER_V1 composition records a
decision for every dispatch it runs, and a legacy composition records none
(proven mechanically in both modes).

## 4. Kernel never routes (§10)

The embedded provider consumes `request.selectedModelRoute` verbatim, and in
SMART_ROUTER_V1 compositions it is configured `requireRequestedModel` — a
request without the CompanyOS selection fails loud
(`COMPANYOS_SELECTED_MODEL_REQUIRED`) instead of choosing its own model.
ARCH-043 mechanically forbids the kernel/provider from importing the Smart
Router and forbids task-state mutators in the collaboration bridge.

## 5. Restart recovery (§4/§23)

The consumer context is rebuilt from durable state: the Work Package projection
plus the durable handoff packets of the consumer task scope. The runtime suite
closes the first composition (process boundary), opens a fresh one over the same
data directory, drives the remaining work, and asserts zero duplicated
Tasks/Artifacts/Handoffs/dispatches plus a rebuilt context that references the
durable producer artifact. Raw producer transcripts are never an input — they
do not exist in the durable state.

## 6. Corrective / reroute (§15/§16)

A reroute is a NEW canonical attempt with its own RoutingDecision; the previous
attempt's recorded decision is frozen. A replayed dispatch (same attempt +
provider) whose recomputed decision disagrees with the durable evidence is
refused with `ATTEMPT_ROUTE_CONFLICT` — an attempt-internal model switch is
structurally impossible. In-attempt switching never occurs because the model
route is fixed on the request the provider runs under.

## 7. Stage 5 security count mapping (§27) — CORRECTED BY STAGE 8C

The Stage 8/8B reports stated the Standard gate count as 24. **That was an
undercount**: the third Standard suite, `tests/security/v1-claims.test.ts`
(the Stage 5E negative-claims suite, 7 tests), also runs in the main gate and
was omitted from the count. The corrected, mechanically verified mapping:

| Suite | Static `it(` | Parameterized | Total | Gate |
|---|---|---|---|---|
| `tests/security/v1-claims.test.ts` (claims) | 7 | — | 7 | Standard V1 (`pnpm check`) |
| `tests/security-broker-security.test.ts` (broker) | 7 | — | 7 | Standard V1 (`pnpm check`) |
| `tests/security-agent-attack.test.ts` (attack) | 9 | 8 (TAMPER_CASES) | 17 | Standard V1 (`pnpm check`) |
| **Standard V1 total** | | | **31** | = the Stage 5E frozen baseline, INTACT |
| `tests/security-process-boundary.test.ts` | 21 static | — | 23 cases | hardened-research gate only (Stage 5E-B) |

**No Standard V1 coverage was lost, moved, or deleted** — the earlier 24 was a
reporting undercount, not a coverage change. The mapping is asserted
mechanically in `tests/stage8c/stage8c-dynamic-role-runtime.test.ts` (§12-§15)
and in the Stage 8B suite's corrected §27 test.

## 8. Latency (§32)

Measured in-process (the §32 test logs it): a full two-task production-path run
— two canonical attempts, two routing decisions, one durable handoff — completes
in well under a second on the test host (recorded in the CI log). The Stage 8B
integration adds no heavyweight per-role runtime: the routing phase is a pure
in-process decision function and the handoff write is one indexed read plus one
insert.

## 9. Honest boundaries

- **One work seat in V1**: the goal pipeline assigns every plan item the
  deployment's generic work seat (`rol.worker`), so the multi-STAGE chain is
  proven across canonical TASKS (each with its own RoleInstance, attempt,
  RoutingDecision and context) and across durable handoffs. A deployment that
  pins different seats per stage routes per seat through the same seams — the
  role catalog is seeded from the canonical roles table (proven by the fixture,
  which defines the seat through the real authorization path before composition).
- **The deterministic ExecutorProvider is a CONTROLLED FIXTURE** (Boss §26); the
  real-kernel path is proven separately by `pnpm test:kernel`, which runs the
  full embedded-runtime E2E including the Stage 8B collaboration/handoff write.
- **LIVE_RUNTIME_EVIDENCE = EXTERNAL_BLOCKED** — no live model credential exists
  in this environment; all runtime evidence is deterministic.
- Consumer ACCEPTANCE of a handoff stays a real actor operation (the existing IPC
  path); the runtime records DRAFT → READY and never fabricates acceptance.

## 10. Backlog (explicitly NOT started)

Adaptive Historical Router · Cost Governor · Peer Chat · Free-form Multi-Agent
Team · Browser · Memory Governor · Hardened Sandbox · Real Project Bug Bash ·
V1 Freeze.
