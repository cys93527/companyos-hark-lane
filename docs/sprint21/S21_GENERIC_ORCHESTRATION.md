# S21 — Pack-Driven Generic Orchestration

Baseline `9e5aabf` / tag `sprint-20`. Mission CLOSED: an arbitrary valid Pack-defined
WorkflowVersion with heterogeneous roleId/taskKind/maxAttempts/validatorIds/DAG is
autonomously executable by the generic CompanyOS runtime without changing Core supervisor
source. `work/review/qa` and `Developer/Reviewer/QA` are no longer universal CompanyOS
concepts in the orchestration path.

## Legacy Supervisor audit (what changed, what stayed)

The software semantics lived in three strata: (a) the Core run-state machine's gate
phases (REVIEWING/VALIDATING — UNCHANGED, they are generic quality gates, not roles);
(b) the orchestrator's phase→stage-kind string coupling (`new Set(['review'])`,
`?? 'work'` — REMOVED); (c) the composition's role-classified handler factory and
session registration (GENERALIZED into deployment data). The supervisor turn runtime,
decision sink, evidence applicator mechanics, receipts, recovery, engine per-run FIFO,
pinned executions, workspace lease and startup recovery were already neutral and are
UNCHANGED.

## Core / Pack / Runtime boundary (frozen)

- CORE/ENGINE: the generic orchestration algorithm — DAG readiness, phase advancement,
  gate semantics, lifecycle, recovery, authority enforcement. Zero stage-kind/role-name
  string branches (source-audited).
- PACK: role/task semantics, workflow definitions, task profiles, validator
  declarations — data in the pinned WorkflowVersion.
- RUNTIME/ADAPTER: concrete executor implementations registered as composition data
  (`stageHandlers.executorKinds` etc.); model/tool/provider integration.

## Stage classes and executor resolution

The frozen Sprint21 stage-class seam (`stageClasses` on the supervisor deps) was REMOVED
in the final corrective: finding ANCHORS are every task of the pinned graph (canonical
findings arrive through the frozen findings contract — the envelope kind a trusted
executor emits — never through a stage-kind classification; a task with no findings simply
has no report). The deployment-declared review/qa kinds (`stageHandlers.reviewKinds` /
`qaKinds`) remain EXECUTOR REGISTRATION data, and additionally classify stages ONLY in
the trusted work-subject projection of the bounded agent contexts (a deployment whose
review kind is `task.compliance-inspection` declares it so; the frozen workflow-graph
node-kind vocabulary 'review'/'qa' stays admitted for legacy task-profile-less graphs).
The class key is never a role name. Executor resolution = EXACT taskKind map hit (the
engine handler registry); no fallback, no first-registered-wins, no fuzzy match; missing
kinds fail CLOSED at materialization (`NORMAL_TASK_TASK_KIND_UNAVAILABLE`, zero provider
calls). The GENERIC EXECUTOR handler (`executor.generic:<kind>`) = one pinned model round
whose CONTEXT IS the T20-06 Work Package projection, optionally materializing the durable
artifact the structured output declares (envelope kind = the frozen generic work-output
kind); when the structured output declares `verdict` + `subjectTaskId`, the envelope kind
is the review-findings CANDIDATE and the ONE carrier routes it to the canonical findings
sink (any trusted executor may produce findings — no sink choice by stage class).

## Readiness and DAG advancement

Ready selection derives from the pinned DAG (every direct predecessor stage terminal-
successful, any class — a gate-class predecessor genuinely blocks its business
successor), task state and the run phase; deterministic topological order with node
order tie-break; never createdAt/role/stage-name/registry order. One advance executes the
unit = ALL open tasks of the first ready stage. The engine stays in EXECUTING until the
whole graph's work is terminal-successful (`EXECUTION.COMPLETE`); a cancelled/uniformly
non-DONE stage blocks it (an empty or non-successful stage never passes a gate on stale
evidence). The gate phases (REVIEWING/VALIDATING) select open work with the SAME DAG rule
and run it through the registered agent-unit handler (found by task kind); when NO open
work remains, the evidence applicator's durable findings/validation rows drive the gate
events and the deterministic gate-skip advances an empty gate.

## Gate semantics

REVIEWING with no actionable finding left = deterministic gate-skip (idempotent
`REVIEW.PASS`; the applicator ran at the loop head, so any durable
CHANGES_REQUESTED/PASS report has already fired its event — never best-effort).
VALIDATING with no validation-class stage: the orchestrator runs the pinned business
validatorIds through the ONE ValidationService (`generic-validation:<run>:<stage>:<artifact>`
permanent command), then the evidence applicator derives PASS/FAIL. A graph with ZERO
validator requirements CANNOT legally pass the frozen ADR-0020 gate — the loop stops
`validation_requirements_missing` (a safe human stop; never a faked PASS). **Known V1
constraint:** a gate-class stage cannot be a DAG predecessor of a business stage (the
phase pipeline runs gates after the business domain).

## Corrective loop (generic, immediate)

Findings come from any trusted executor through the unchanged T18 sinks/evidence
applicator; a REQUEST_CORRECTIVE application PROVISIONS **AND EXECUTES** the corrective
inside the same apply (immediate corrective): the corrective task is created on the
TARGET stage with the TARGET stage's pinned profile, lineage/round/cap intact, and runs
through the same engine claim path. The loop then keeps driving — no S18-style stop
between rounds. In the SAME provisioning unit the provisioner mints the deterministic
post-corrective REASSESSMENT tasks:

- the PRODUCER-stage reassessment of the finding's own producer
  (`tsk_sha256("companyos/reassessment-task/1:company:run:correctiveTaskId)[0:26]`, keyed
  by `inputs['companyos:reassessment'].correctiveTaskId`);
- a DESCENDANT reassessment for every strict descendant stage of the subject stage
  (derived from the EXACT run-pinned WorkflowVersion DAG — never timestamps, never the
  current template) that ALREADY owns a canonical successful result
  (`tsk_sha256("companyos/descendant-reassessment/1:company:run:correctiveTaskId:descendantStageId)[0:26]`),
  carrying the EXISTING corrective lineage (parent = that stage's current subject), so the
  frozen stage-subject authority ("a child always wins over its ancestor") makes it the
  stage's canonical subject once settled — the stale result is superseded, never
  rewritten.

Both are causally ineligible until the corrective is DONE (the immediate model executes
it first); their Work Package projects the causal dossier of THAT corrective
(`causal {correctiveTaskId, resultKind, artifactRefs, validationRefs}`; a foreign or
not-DONE reference fails CLOSED with
`WORK_PACKAGE_CAUSAL_REFERENCE_INVALID`/`_NOT_DONE`). Round cap = 3
(`maxCorrectiveRounds`); a fourth is refused at the provisioning boundary
(`CORRECTIVE_ROUND_LIMIT_EXCEEDED`) and the durable human stop is committed BEFORE the
orchestrator returns: `REWORK.EXHAUST` from REWORK (the frozen gate flow) or `RUN.PAUSE`
from EXECUTING (the S21 immediate flow, whose corrective cycle runs inside the DAG with
legal units still ahead) — either way the run reaches the SAME durable PAUSED, a later
invocation makes ZERO model turns, and the trusted `RUN.RESUME` is the only way on.
Reassessment rounds are causally justified tasks; downstream Work Packages consume the
repository-authoritative corrected subject (Sprint20 rule unchanged; same-round
earliest-(createdAt,id) tie-break preserved).

## Session policy

The session seam is the existing generic registration (`kinds + roleKey + agentId +
bindingKey`); the durable task-scoped session remains a Pack/deployment choice
(legacy Developer registration unchanged as a compatibility executor). Generic
executors are state-reconstructed single-turn with the Work Package as context — no
transcript inheritance (T19 isolation preserved).

## Evidence scoping (D1, frozen)

Proposal/cause validation is SUBJECT-SCOPED: the context projects a review reference ONLY
for the report whose subject matches the turn's subject (the anchor report included); a
foreign/unconsumed unresolved finding never supplies a corrective cause
(`SUPERVISOR_PROPOSAL_CAUSE_NOT_ACTIONABLE`, no projection hijack). Run-level BLOCKING is
ALL_UNRESOLVED_ANCHORS: any unresolved finding blocks CONTINUE/COMPLETE
(`SUPERVISOR_PROPOSAL_CONTINUE_BLOCKED`, a newest PASS cannot mask an older unresolved
one) — foreign findings block, but only subject-scoped, durable, actionable evidence
carries a decision. No timestamp ever grants evidence authority; decision-history
consumption (`reviewVerdictConsumedBy`) decides actionability.

## Execution attempts (first-class entity)

Each unit execution is owned by a durable ExecutionAttempt
(`exa_sha256("companyos/execution-attempt/1:company:run:task:attempt)[0:26]`,
states ACTIVE/INTERRUPTED/COMPLETED/FAILED via the frozen domain machine, immutable seed
company/run/task/attemptNumber/roleId/taskKind — no model fields). The engine's
three-transaction timeline: transaction A (normalize + START exactly once — attempts += 1
— guarded claim INSERT; another owner's ACTIVE attempt loses with
`EXECUTION_ATTEMPT_CLAIM_ACTIVE` and performs ZERO executor calls) → executor runs
outside any transaction → transaction B (stageOutput + Task settlement + attempt
settlement, atomic). A legacy single-transaction composition shape is unchanged. Legacy
RUNNING rows with NO attempt row are reconstructed through the guarded path: INTERRUPTED
reconstruction, then the SAME attempt (number preserved, START never applied twice, no
fabricated source); a crashed attempt is re-acquired as the same attempt on restart, and
`maxAttempts = 1` semantics hold for the generic claim path.

## Runtime ownership boundary (desktop)

The OS-level single-instance lock lives in the desktop ENTRY
(`app.requestSingleInstanceLock()` + the `second-instance` handler in `main.ts`); the
composition itself NEVER enforces it (source-audited) — it only CARRIES the runtime
ownership token (`runtimeInstanceId`, generated per composition) used for startup
orphan conversion (`interruptActiveOfRuntime`). V1 boundary documented: one runtime
process per OS user data dir.

## Authority matrix (Sprint21)

| Concern | Owner |
|---|---|
| Workflow semantics | pinned WorkflowVersion (nodes/edges/taskProfile/validatorIds) |
| Task execution requirement | pinned taskProfile (roleId/taskKind/maxAttempts) — the reassessment row is only a carrier |
| Runtime executor implementation | composition registration (executorKinds/reviewKinds/qaKinds/developerKinds/repository) — implementation authority ONLY |
| Task readiness | orchestrator DAG+state algorithm |
| Execution claim | the ExecutionAttempt entity (engine claim transaction, PK + UNIQUE(task_id,attempt_number), guarded INSERT) + run revision + permanent receipts |
| Task lifecycle / stage output / findings / validation / corrective / run terminal | the unchanged Sprint-18/19 owners |
| Session policy | executor registration data |
| Cancellation | the unchanged AbortSignal paths (now forwarded into agent units too) |
| Reassessment identity | derived ids (producer/descendant), one row per (corrective, stage) forever — replay-safe |
| Single-runtime ownership | the desktop entry's OS lock; composition data only (`runtimeInstanceId`) |

## Recovery matrix (crash windows A–G)

Fault checkpoints (non-durable, test/diagnostic hooks that can never alter Task/Attempt
semantics): A `executionClaimBeforeExecutor` (claim committed, executor not invoked),
B `executorResultBeforeSettlement` (executor returned, no canonical settlement — the
honest at-least-once external window), C `taskSettledBeforeCarrier` (Task + attempt
settled, carrier NOT routed), plus `correctiveTaskCommitBeforeReceipt`,
`reviewSinkBeforeLifecycle`, `validationSinkBeforeLifecycle`,
`reworkExhaustBeforeReturn`, `resumeTransitionBeforeNextTurn`. Recovery answers:
before execution → re-derive the ready unit; claim committed/executor not invoked → the
same attempt is re-acquired (never a new number); executor returned/settlement missing →
the durable Task state is the authority (`unitAlreadySatisfied`; a completed task is NEVER
re-executed — proven: a full second autonomous pass performs zero new executor
invocations); Task settled/carrier not routed → the loop-head carrier reconciliation
routes it FIRST, exactly once (durable unreconciled carriers never let a run report
COMPLETED); validation unsettled → the evidence applicator re-applies from durable
batches; finding durable/corrective missing → decision replay by permanent id + receipt;
corrective durable → putGuarded replay; run terminal unsettled → finalize bookkeeping
replays. A FaultCrashError is a CRASH, never a domain error: it escapes every catch,
including the corrective/rework paths. A unit whose attempts are EXHAUSTED stops the loop
on `non_retryable_failure` (the engine's own EXECUTION.FAIL landed the run FAILED) —
never fabricated progress.

## Paperclip reference

REFERENCE_NOT_FETCHED (no external access in this environment). Recorded for the future
Architecture Guard phase: control-plane/executor-adapter separation, atomic task
checkout, goal-aware execution, runtime adapter model, heartbeat/wakeup, recovery —
reference only; the AI-employee product model, CEO/CTO hierarchy and org-chart-as-
workflow are explicitly rejected.

## Gap board

CLOSED: GENERIC_ROLE_ORCHESTRATION, PACK_DRIVEN_EXECUTION, GENERIC_DAG_ADVANCEMENT,
GENERIC_EXECUTOR_RESOLUTION, GENERIC_CORRECTIVE_LOOP,
GENERIC_VALIDATION_ORCHESTRATION, GENERIC_RESTART_RECOVERY,
EXECUTION_ATTEMPT_ENTITY, IMMEDIATE_CORRECTIVE_REASSESSMENT, STALE_DESCENDANT_
INVALIDATION, D1_EVIDENCE_SCOPING, LEGACY_RUNNING_UPGRADE, DESKTOP_RUNTIME_
OWNERSHIP. OPEN: REAL_PRODUCTION_PROVIDER_EXECUTOR (Sprint21 used deterministic fake
executors through the real seams), ARCHITECTURE_GUARD, OBSERVABILITY,
PRODUCT_CONTROL_PLANE, PLAN_APPROVAL, SECRETS/CONFIG/WORKSPACE_SAFETY,
FINAL_SYSTEM_AUDIT, REAL_PROJECT_BUG_BASH.

## Tests

`tests/sprint21/s21-generic-orchestration.test.ts` (19) + `s21-generic-corrective.test.ts`
(17): procurement 4-stage autonomous E2E to COMPLETED, brand-new logistics pack, branch
DAG join, registry-order invariance, pinned-V1-after-V2, missing-executor fail-closed,
zero stage/role-name switches, WorkPackage-as-context, validatorIds-driven validation
with no QA role, zero-requirements safe stop, failing-validator REWORK, generic finding →
corrective (target profile/lineage/downstream authority), rework exhaustion, idempotent
re-entry, cross-run/tenant isolation, cancellation, §95 side-effect ownership.
`s21b-execution-attempts.test.ts` (6): deterministic attempt identity, PK arbitration
(replay/CONFLICT), concurrent double-claim (1 claim / 1 COMPLETED / attempts = 1),
ACTIVE-claim blocks the loser with ZERO executor calls, startup orphan conversion +
same-attempt re-acquisition, DONE never re-executes.
`s21c-reassessment-causal.test.ts` (5): finding → corrective + IMMEDIATE deterministic
reassessment, causal blocking until the corrective is DONE, stale-downstream blocking,
causal Work Package, foreign corrective reference fails closed.
`s21d-final-invariants.test.ts` (11): terminal carrier reconciliation (a durable
unreconciled carrier never lets a run report COMPLETED; the restart routes it exactly
once), legacy RUNNING upgrade (same attempt, START applied once, frozen transition
machine), desktop runtime ownership (the OS lock lives in the entry, never in the
composition), descendant pinned-profile equality (the reassessment row IS the pinned
taskProfile), foreign blocking without projection hijack, newer-clean cannot mask an
older unresolved finding, post-completion descendant canonical replacement, causal
Work Package projection (own dossier; foreign fails CLOSED).
The Sprint-18/19/20 suites were migrated in full to the S21 semantics: T18-08 chaos §44
(rounds 1–3 citing each subject's own corpus evidence, round 4 refused at the cap,
durable PAUSED, crash escape at `reworkExhaustBeforeReturn`, zero-turn restart, exactly
one RESUME), the fault-matrix sink/lifecycle windows (12/13-23/14/15-25 → the frozen
A/B/C windows), fault recovery (29/30/31 ledger-trim replay), real-process crash B (the
review-carrier window), the T18-07 production paths (52/42, 52/43–45, 19–21, 24, A2/A4,
C1/C5, 76, 81), and T19-04's bounded-context family (11 tests incl. the corrective
acceptance and the over-budget fail-closed stops). Suite floor: 191 files / 2433 passing
tests, zero skips.
