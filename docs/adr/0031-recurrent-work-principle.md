# ADR-0031: Recurrent Work Principle (COMPANYOS_RECURRENT_WORK_PRINCIPLE_V1)

- **Status**: Accepted
- **Date**: LIVE-SMOKE-FIX-07 closeout (post `432fe9e`)
- **Context**: Architecture adoption — mechanism/principle documentation only; zero production code, schema, migration or runtime change

> **This is MECHANISM adoption. This is NOT LoopVL implementation adoption.**
> No LoopVL dependency, no HRM runtime, no model training, no second Agent Runtime /
> Scheduler / Workflow Engine / canonical truth is introduced by this ADR.

## Context / Problem

CompanyOS repeatedly meets the same structural question across its loops: planning
repair (LIVE-SMOKE-FIX-06), routing complexity calibration (LIVE-SMOKE-FIX-05/
FIX-07), retry budgets, corrective cycles, reassessment boundaries, and context
reconstruction. Live smokes 02–06 each exposed one variant of the same failure
family: a loop without the right OWNER, the right BUDGET, the right STOP CONDITION,
or the right FAILURE SEMANTICS — or a structural signal (integration breadth,
criteria count, compute amount) mechanically collapsed into a model-capability
demand.

This ADR freezes the recurring-computation principles that already govern (or must
govern) every CompanyOS runtime loop, so future loop-shaped features are designed
against one canonical contract instead of ad-hoc per feature.

## Source Insight

Architectural reference: **LoopVL — Recurrent Visual Intelligence** (adoption mode:
MECHANISM / PRINCIPLE ONLY). The source-evidence insights adopted are limited to:

1. **Shared recurrent computation** — one set of compute elements (roles, models,
   executors) may participate in many refinement steps, with per-step state kept
   small and attributable.
2. **Evolving state** — a work state is carried across steps and refined, instead of
   rebuilding everything from scratch on every step.
3. **Local / high-level timescales** — low-level refinement iterates quickly while
   higher-level state updates sparsely, at explicit boundaries.
4. **More compute is not automatically better** — recurrence must be bounded and
   evidence-driven, not "more is smarter".

**Source accuracy (frozen):** LoopVL is evidence for recurrent/shared-state
*principles* in a visual-intelligence model family. It is NOT evidence for agentic
orchestration, CompanyOS architecture, adaptive stopping, unlimited test-time
compute, or Browser/Computer control. No such claim may be attributed to it.
Source-derived claims (above) are kept separate from the CompanyOS translation
(below), which stands on CompanyOS's own durable-truth architecture
([ADR-0029](0029-autonomous-supervisor-and-corrective-work.md),
[ADR-0030](0030-durable-session-is-operational-context.md)).

## CompanyOS Translation

| LoopVL-style concept | CompanyOS owner (existing, no new truth) |
| --- | --- |
| Low-level refinement loop | **ExecutionAttempt → Artifact/Evidence → Validation → Finding → Corrective → New Attempt → Revalidation**; bounded task retry/rework inside the existing lifecycles |
| High-level state update | **Reassessment** and the existing Plan/Run decision boundary (WorkflowVersion lineage, corrective rounds, supervisor decisions) |
| Evolving recurrent state | **Derived context projection** from canonical truth: Goal, Plan, WorkflowVersion, Run, Task, RoleInstance, ExecutionAttempt, Artifact, Evidence, Finding, Validation, Corrective, Decision |
| Shared recurrent computation | Reuse of the existing **Role** (RoleInstance), **ModelProfile** (ModelPool/SmartRouter) and **ExecutorProvider** (embedded DSH) contracts across steps |
| Adaptive recurrence | **Future bounded compute policy** (backlog; NOT V1) |

## Canonical Owner Mapping (all existing — no invented owners)

| Concern | Owner |
| --- | --- |
| Goal truth | Run-goal artifact (`companyos:run-goal`, run-owned, immutable) + goal pipeline |
| Plan truth | Plan artifact (`companyos:plan`, immutable; re-plan = NEW planning run/command — no latest-plan truth) |
| Workflow graph truth | WorkflowVersion + RunSnapshot (run-pinned, immutable) |
| Run lifecycle | L1 run state machine + engine command router (`EXECUTION.FAIL`, `EXECUTION.COMPLETE`, …) |
| Task lifecycle | Task L3 state machine; claim-before-execute |
| Role | RoleCatalog resolution / dynamic professional seats (Stage 7/8C); per-attempt model selection (Stage 7B) |
| Attempt truth | ExecutionAttempt rows — independently durable, auditable, settled, evidence-producing (failure truth on the row itself, migration 0007) |
| Artifact / Evidence | Artifact CAS + validation/evidence domain (resolve-all-before-write) |
| Validation | ValidationService + evidence gate (ADR-0020) + deterministic validators |
| Finding / Corrective | Review-findings sink + corrective provisioner (ADR-0029); reassessment causal model (Sprint 21) |
| Reassessment | Deterministic reassessment (causal reference to corrective result; Sprint 21) |
| Handoff / Outcome | HandoffService (Sprint 11) + Goal-Outcome autonomy driver projection |
| Routing | ModelPool + SmartRouter (SMART_ROUTER_V1; DETERMINISTIC_V1 default) |
| Executor | ExecutorProvider contract; embedded DSH headless (brokered, secret-isolated) |
| Session / context | Operational context only (ADR-0030); supervisor/reviewer/QA state-reconstructed per turn |

## Local vs Global Recurrence (intended shape)

```
Goal / Plan  (relatively stable)
        │
        ▼
Task-local work loop:
  ExecutionAttempt → Artifact/Evidence → Validation
        → (Finding → Corrective → New Attempt → Revalidation)*   [bounded]
        │
        ▼  explicit reassessment boundary
Reassessment  (deterministic, evidence-triggered)
        │
        ▼  only if canonical evidence requires it
higher-level Plan / workflow decision changes
```

Avoided anti-pattern: **every local failure rebuilds the entire Plan.** Local
refinement and high-level reassessment operate at different timescales; higher-level
Goal/Plan changes happen ONLY at explicit reassessment boundaries.

## Invariants (COMPANYOS_RECURRENT_WORK_PRINCIPLE_V1 — frozen)

1. Canonical durable truth remains authoritative.
2. Local execution may repeatedly refine work over an evolving work state without
   rebuilding the entire global Plan.
3. Local refinement and high-level reassessment operate at different timescales.
4. High-level Goal/Plan changes occur only at explicit reassessment boundaries.
5. These concepts are SEPARATE and must not be mechanically collapsed into one
   scalar: Structural Task Complexity · Model Capability Requirement · Required
   Tools · Context Requirement · Risk/Reliability Requirement · Execution Compute
   Depth · Retry Budget · Corrective Budget · Review Depth · Reassessment Depth.
6. More loops / retries / agents / tokens / model calls / dependencies do NOT
   automatically imply higher quality or a need for a stronger model.
7. Every recurrent runtime loop must have: **evidence · budget · stop condition ·
   failure semantics.**
8. Recurrent Work State is **derived / projected state** from existing canonical
   truth — it is NOT a new durable truth owner.
9. The same RoleInstance / ModelProfile / ExecutorProvider may participate in
   multiple refinement steps, but each real ExecutionAttempt remains independently
   durable, auditable, settled, evidence-producing.
10. Adaptive compute depth is a future policy concern — NOT a V1 requirement unless
    a proven P0/P1 product blocker requires it.

## FIX-07 Relationship (one concrete implementation of this principle)

**Structural Complexity ≠ Model Capability Requirement** — implemented in
`minimumQualityByComplexity` calibration (LIVE-SMOKE-FIX-07):

| Complexity | BALANCED policy floor | QUALITY_FIRST floor | COST_AWARE floor |
| --- | --- | --- | --- |
| LOW | ECONOMY | ECONOMY | ECONOMY |
| MEDIUM | BALANCED | BALANCED | ECONOMY |
| HIGH | **BALANCED** | **BALANCED** | BALANCED |
| VERY_HIGH | **STRONG** | **STRONG** | **BALANCED** |

**Quality floor is POLICY-owned.** The architecture principle is: structural
complexity may INFLUENCE a policy's minimum quality requirement, but structural
complexity is NOT itself the model-intelligence truth. It is therefore WRONG to
document "VERY_HIGH always requires STRONG under every policy" — the current
policy reality above is policy-specific by design (COST_AWARE legitimately floors
VERY_HIGH at BALANCED). Likewise automatic stronger-model escalation solely from
DAG breadth is REJECTED.

## Failure / Stop Semantics (MORE COMPUTE ≠ AUTOMATICALLY BETTER — frozen)

Every loop is bounded; no open-ended "keep trying until successful" behavior may
exist:

| Loop | Budget / bound | Stop condition | Failure semantics |
| --- | --- | --- | --- |
| Planner proposal repair (PLAN_PROPOSAL_REPAIR_V1) | 3 total proposals (1 + 2 repairs), one logical planning operation | valid proposal OR exhaustion | typed `PLANNER_INVALID_OUTPUT` + per-attempt codes; planning task FAILED; Goal Run settled FAILED |
| Control-plane network retry | 4 total network attempts, 2s/5s/15s backoff, bounded Retry-After; per logical invocation | response or exhaustion | typed provider class; never consumes an outer work ExecutionAttempt |
| Work attempt retry | task `maxAttempts`; deterministic (retryable=false) fails fast | DONE / FAILED | attempt-row failure truth; pre-dispatch failures make 0 fake dispatches/decisions |
| Corrective | existing corrective lifecycle + cycle budgets (ADR-0029) | re-validation PASS or budget exhausted | typed bounded terminal (never infinite rework) |
| Reassessment | explicit boundary; deterministic causal reference (Sprint 21) | reassessment settles or defers | reassessment truth durable |
| Autonomy driver | bounded steps/attempt/corrective/stall budgets | typed terminal state | `NON_RECOVERABLE_FAILURE` / `AUTONOMY_BUDGET_EXHAUSTED` / … with durable run terminality (FIX-06/FIX-07) |

## Gap Classification

**ALREADY_HAVE** — durable ExecutionAttempt (incl. row-scoped failure truth);
bounded network retry; bounded planner proposal repair; Validation/Corrective/
Reassessment lifecycles; ModelPool/SmartRouter routing with per-attempt model
selection; fail-closed execution truth; planning- and execution-failure Goal-Run
terminality; complexity/quality policy separation (FIX-07); plan-shape-invariant
structural complexity (FIX-05).

**PARTIALLY_HAVE** — local-refinement vs global-reassessment separation (exists via
ADR-0029/Sprint-21 semantics; not yet phrased as one recurrent-work contract — this
ADR); derived evolving work-state context (WorkPackage projection + state-
reconstructed supervisor/reviewer/QA contexts exist; a unified "current work state
projection" seam does not); long-running state reconstruction across restarts
(durable replays exist; long-horizon recurrence policies do not);
validation-driven compute stopping (validators gate stage outcomes; they do not yet
drive compute-depth policy).

**BACKLOG** — SESSION_CONTEXT_EVOLVING_WORK_STATE · ADAPTIVE_COMPUTE_DEPTH_POLICY ·
VALIDATION_DRIVEN_STOPPING_POLICY · RECURRENT_CONTEXT_COMPACTION ·
BROWSER_COMPUTER_OBSERVATION_STATE · LONG_RUNNING_REASSESSMENT_POLICY.

**REJECT** — unbounded retry; loop-until-green; a second Agent Runtime
(AgentRuntimeV2); a second workflow truth / second DAG; a second Goal/Task/Role/
Authority truth; a WorkStateTruth / LoopState / RecurrentTask / RecurrentRun table;
PlannerV2 / SchedulerV2; automatic stronger-model escalation solely from DAG
breadth.

## Backlog detail (future direction ONLY — no V1 scope expansion)

- **Session / context direction:** Canonical Truth → Context Builder → Current Work
  State Projection → Model/Executor → Artifact/Evidence → Canonical Truth. The
  projection may be ephemeral, compacted, role-specific — but must NEVER become an
  authority competing with canonical truth (extends ADR-0030).
- **Browser / computer direction:** observation loop concept (Observation → Action →
  New Observation → State Update → Next Action) with state attributable to real
  actions, real observations, canonical evidence. NOT implemented here.
- **Adaptive compute direction:** a future bounded policy may vary model-call depth,
  corrective depth, review depth, reassessment depth based on canonical evidence,
  validation results, risk, capability requirements and budget. NOT implemented now;
  not a V1 requirement absent a proven P0/P1 product blocker.

## Non-Goals

- No LoopVL/HRM dependency, vendoring, porting or training.
- No replacement of the CompanyOS model stack.
- No new runtime service, schema, migration, table or canonical entity.
- No second Agent Runtime, Scheduler, Workflow Engine or truth owner.
- No adaptive-compute, session-context-runtime or browser/computer implementation.
- No claim that LoopVL proves anything CompanyOS-specific (see Source Accuracy).

## Consequences

1. Every future loop-shaped feature MUST be designed against invariant 7 (evidence,
   budget, stop condition, failure semantics) and reviewed against invariant 5
   (no scalar collapse of the ten separated concerns).
2. The FIX-05 structural complexity derivation and the FIX-07 policy calibration are
   the canonical reference implementation of invariant 6 for routing.
3. Backlog items are recorded, NOT scheduled; realizing any of them requires a new
   Boss-approved task and must reuse the canonical owners above.
4. Architecture-law style guards may cite this ADR when rejecting second-truth or
   unbounded-loop proposals.
