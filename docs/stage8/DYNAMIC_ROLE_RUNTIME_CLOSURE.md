# STAGE 8C — AUTONOMY PRECONDITION CLOSURE

Status: IMPLEMENTED (Stage 8C)
Date: 2026-10-02

Two blockers closed: (A) the normal Goal pipeline now resolves DYNAMIC
PROFESSIONAL ROLES; (B) the security 31→24 question is settled with git-backed
mechanical evidence — the baseline was never lost, the earlier "24" was an
undercount. Handoff autonomy is proven: READY suffices for internal consumer
progress; ACCEPTED is an explicit human acknowledgement that nothing waits on.

## A. Dynamic professional roles in the normal Goal pipeline

The chain (all through the REAL application path — goal.create → goal.advance
→ plan → compile → materialize → dispatch → settle):

```
User Goal → Plan → PlanItem
  → ProfessionalResponsibilityRequirement (declared by the plan when present —
    an optional model REQUEST validated by the canonical plan contract — else
    derived deterministically from the item's own semantics: the objective IS
    the intent; a deployment operation kind ≠ the work kind IS independent
    evaluator work)
  → RoleResolver (Stage 7: catalog match on declared capabilities → the
    canonical seat key; else DETERMINISTIC_DYNAMIC_ROLE_SPEC → drole_<hash16>)
  → the resolved seat pinned into the task profile (durable with the
    WorkflowVersion — the single task truth; restart/idempotent by construction)
  → Task → Smart Router (per attempt) → ExecutionAttempt → SelectedModelSnapshot
```

What changed (all additive):

| Layer | Change |
|---|---|
| Core plan contract | `PlanningProposalItem.professionalResponsibility?` (intent + capabilities + independence + risk); validator + payload keys extended; planner JSON schema mirrors it |
| Plan compiler | `PlanItemCompilationProfile.professionalResponsibility?` pinned into the compiled node config beside the task profile |
| Work Package projector | `WorkPackage.execution.professionalResponsibility` (null for pre-8C versions — never guessed) |
| Control plane | the per-item derivation resolves the seat via the injected `professionalSeatOf` seam; `'rol.worker'` is GONE from the normal path (ARCH-044 mechanically forbids it) |
| Runtime bridge | `professionalResponsibilityOfPlanItem` + `resolveProfessionalSeat` + `dynamicProfessionalSeatIdOf`; the dispatch-time role resolution consumes the PINNED requirement (durable truth) |

Properties (mechanically proven in `tests/stage8c`):

- **User never chooses roles** — the plan's responsibilities + the resolver do.
- **No fixed team template** — seat count/type follow the plan; identical
  responsibilities share ONE seat (minimal sufficient team HARD GATE).
- **Catalog seats come from the canonical roles table** (registered through the
  real authorization path; capabilities parsed from rows) — Pack-extensible.
- **Dynamic seats are deterministic** (`drole_<sha256-16 of the canonical
  requirement>`): identical responsibility ⇒ identical seat ⇒ idempotent
  compilation, restart-safe reconstruction.
- **Late specialist**: a NEW professional responsibility resolves to a NEW
  seat — never a fallback generic seat.
- **Role ≠ Model** (Stage 7B): the seat contributes requirements/hints; the
  per-attempt RoutingDecision owns the selection.

## B. Security 31 baseline reconciliation (git-backed)

Historical frozen baseline (Stage 5E): claims 7 + broker 7 + attack 17 = 31.
Current main gate (`pnpm check`) — all three suites run, none excluded:

| Suite | Evidence |
|---|---|
| claims 7 | `tests/security/v1-claims.test.ts` — created at Stage 5E commit `0e54faf`; 7 static `it(`; runs under `tests/**/*.test.ts`; NOT in `vitest.hardened-research.config.ts` |
| broker 7 | `tests/security-broker-security.test.ts` — unchanged |
| attack 17 | `tests/security-agent-attack.test.ts` — 9 static + 8 TAMPER_CASES |

The Stage 8/8B reports' "24" **undercounted** the claims suite (it quoted only
two of the three files). No test moved, no coverage lost, no gate weakened; the
process-boundary suite (23 cases) sits in the separate hardened-research gate
(Stage 5E-B, per Boss §28) and is part of NEITHER count. Corrected
mechanically in `tests/stage8c` (§12-§15) and the Stage 8B §27 test; the Stage
8B report's mapping section is corrected in `docs/stage8/RUNTIME_INTEGRATION_CLOSURE.md`.

## C. Handoff autonomy semantics (§16-§20)

Verified semantics — **no code change was needed**:

- `READY` is the handoff's durable, evidence-complete delivery state; the
  consumer runtime reconstructs its context from the durable packet (the
  Stage 8B `roleContextOf` reads the task-scope packets regardless of
  ACCEPTED), and the engine gates consumer tasks on the DAG, never on
  acceptance.
- `ACCEPTED` is an explicit human/IPC acknowledgement — a record of receipt,
  not a gate.
- Mechanical proof (`tests/stage8c` §16-§20): a two-task internal chain
  completes with the handoff in `READY`, the consumer task DONE, and NO
  `handoff.accepted` event — `ORDINARY_INTERNAL_HANDOFF_REQUIRES_USER = NO`.
- The runtime never fakes a human actor: the handoff events carry only the
  composition's system session actor (audit visible).
- High-risk decisions (payment/publishing/destructive/escalation/legal) keep
  the existing Authority/Approval path — untouched.

## D. Architecture guard

**ARCH-044** (both-direction probes): the control plane must not pin
`'rol.worker'` (any single generic seat) for the normal path; role resolution
goes through the professional-seat resolver. LLM role synthesis and fixed
team templates remain forbidden (Stage 7/8 laws).

## Honest boundaries

- The DECLARED responsibility is an optional model REQUEST validated by the
  canonical plan contract — same authority class as `taskKind`; the trusted
  control-plane derivation resolves it deterministically (a request is never
  authority, never a role pin, never a user choice).
- The plan-proposal schema change is additive-optional; plans without
  declarations derive seats deterministically from item semantics.
- LIVE evidence EXTERNAL_BLOCKED (no live credential); all proofs are
  deterministic in-process runs of the REAL composition.
