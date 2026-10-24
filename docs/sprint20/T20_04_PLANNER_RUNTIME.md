# T20-04 — Generic Planner Runtime + Durable Plan Artifact

Mission: the FIRST real Goal → Plan runtime — one bounded, industry-neutral planner turn
per authorized planning command, producing a durable, replay-safe `companyos:plan`
artifact. This task deliberately does NOT compile plans into WorkflowVersions, does NOT
create Execution Runs, does NOT implement Structured Handoff or any product Goal ingress.

## Product boundary (frozen)

Planning is a **CompanyOS Core capability**; every industry meaning comes from the
canonical Goal and the trusted workflow configuration. The planner runtime contains no
software-development vocabulary — proven by a procurement goal ("Evaluate three suppliers,
perform financial review, obtain approval…") and a software goal planning through the SAME
runtime with zero code differences. There is no SoftwarePlanner/DevPlanner/CodePlanner.

## Planner role and execution seam

Owner: trusted Engine infrastructure (`engine/src/planning/planner-runtime.ts`), wired
into the production composition as `core.plannerRuntime` — a trusted main-process service
(same exposure convention as the session runtime and the materializer; NOT in the frozen
IPC workflow contract, not a Tool, not MCP, not model-callable).

The Planning Task is always a **legitimate, materialized normal Task**: a generic planning
workflow (one `planning`-kind stage) is published through the REAL lifecycle with a pinned
node-config `taskProfile` (`{roleId: 'rol.planner', taskKind: 'companyos:planning',
maxAttempts}` — the T20-03B pack-driven mechanism; nothing about Planning is special-cased
in the materializer), the planning run is created through the real `createRun` with its
canonical run-goal, and the planner task is materialized through the frozen
`NormalTaskMaterializer`. The runtime refuses any task that is not owned by the run
(`PLANNER_TASK_RUN_MISMATCH`) or not of the pinned planning kind
(`PLANNER_TASK_KIND_MISMATCH`) — BEFORE any provider call.

## Model binding and drift

The planner resolves the run's OWN pinned binding (`bindingKey` trusted configuration,
default `planner`; the value always comes from the run snapshot). A run without that
binding fails closed (`RUN_BINDING_MISSING`); registration order, current defaults and
later composition changes can never select or substitute a model. Restart stability: a
pinned run keeps its binding semantics forever; an unavailable pinned model fails closed.

## Context, budget, prompt

Bounded context from canonical facts only: company/run identities, the canonical same-run
run-goal objective (never caller text), the planning task identity, the plan schema and
`PLAN_LIMITS`, and an explicit instruction that the output is a `PlanningProposal`. NO
Developer/Reviewer/QA transcripts, no other runs, no sessions (V1 planner is bounded,
single-turn, state-reconstructed — a re-plan is a NEW authorized command, never a chat).

Pre-provider token budget reuses the proven T19 stateless kernel
(`decideBoundedContextBudget`) with a trusted model-catalog context window (unknown window
fails closed), a **4 096-token output reservation** (`PLANNER_RESERVED_OUTPUT_TOKENS` —
plans are the payload, so the planner reserves more than the 1 024 the role contexts use;
bounded, provider-neutral, trusted-configuration-derived, never model-chosen) and the
frozen safety margin, accounting the COMPLETE rendered request. Overflow ⇒ rejection with
**zero provider calls**; no silent truncation.

The system contract is generic: objectives, work decomposition, dependencies, acceptance
criteria, verifiable completion — no software wording (validator is the only authority).

## Strict proposal → trusted plan

The model returns only the T20-02 `PlanningProposal` (schema `companyos/plan-proposal/1`;
identity fields like planId/artifactId/companyId/fingerprint/approval/WorkflowVersionIds/
TaskIds/timestamps are trusted-runtime-only and absent from the contract). Parsing is the
frozen `validatePlanningProposal` — prose, unknown fields, cycles, orphan criteria,
duplicate ids, oversize all fail closed (the execution settles FAILED truthfully; **no
repair, no field dropping, no cycle removal**). The trusted runtime then injects
`sourceGoal.goalArtifactId` from the run's own `companyos:run-goal` artifact and writes the
trusted payload (`companyos/plan/1`).

## Identity, fingerprint, artifact, replay

- `planId = planIdOf({companyId, planningRunId, planningCommandId})` — the frozen T20-02
  primitive; deterministic from the trusted scope alone (no model content, no clock, no
  provider identity).
- `planFingerprint = planFingerprintOf(payload)` — and the artifact content bytes are the
  payload's **canonical JSON**, so `sha256(content)` IS the plan fingerprint: the durable
  artifact alone can always re-derive it.
- Persistence uses the existing ArtifactService (kind `companyos:plan`; owned by the
  planning run; **no Plan table, no migration, no second store**). Idempotency is the
  artifact service's permanent command identity (`plan:<planId>` — the exact mechanism
  `companyos:run-goal` uses): one logical planId can never mint competing artifacts across
  retry/restart/duplicate/crash; same planId + different bytes ⇒
  `ARTIFACT_COMMAND_FINGERPRINT_MISMATCH` (fail closed, original unchanged).
- **Replay FIRST**: before any work, the runtime looks the plan up by its permanent
  command — an existing durable plan replays with ZERO provider calls (never re-asks the
  model to reconstruct durable truth).

## Durability shape and crash semantics

**SHAPE B (artifact-first)** — chosen deliberately (Shape A's single atomic UoW across the
artifact service and the execution settlement would cross two trusted services; Shape C is
rejected outright): provider result → validate → durable plan artifact → THEN execution
settlement. The frozen checkpoint `after_plan_artifact_before_execution_settlement` sits in
that window:

- Crash there ⇒ the plan IS durable; the execution row truthfully stays RUNNING
  (interrupted recovery semantics own it — never a faked COMPLETED). Restart + same
  command ⇒ single canonical plan replayed, zero provider calls, no alternate accepted.
- Crash BEFORE the artifact ⇒ no canonical plan truth exists; a later authorized retry may
  invoke the provider again under existing execution semantics; the lost model output was
  never business truth.
- The plan artifact is business/planning truth; the AgentExecution is provenance — one
  COMPLETED planner execution per fresh planning command (validated usage persisted), and
  an invalid proposal settles the execution FAILED with NO artifact.

## Re-plan and the absence of "latest plan"

A re-plan is a NEW `planningCommandId` ⇒ a NEW planId ⇒ a NEW immutable artifact. The old
plan is never mutated; both stay auditable. There is NO `currentPlanId`, no
latest-plan-wins, no active-plan pointer — which plan is approved/selected for execution
is future authority (T20-05 compiler receives an explicit selected plan reference), and
T20-04 adds no approval system (Plan approval remains CONDITIONAL per the T20-01 ruling).

## Non-responsibilities (frozen)

No Planner Session / transcript / conversation / thread; no workflow compilation
(createTemplate/saveDraftGraph/publish for execution workflows are untouched); no
Execution Run; no execution Tasks; no Review/Validation/Handoff/Decision writes; no Tool
or Validator authority; no Run repin; no secret material in prompts (the canonical goal +
bounded contract are the only content); provider-neutral (no provider/conversation ids).
Planning alone writes exactly one thing: the plan artifact (plus its one truthful
AgentExecution provenance row).

## Recorded, not solved (§68)

`GENERIC_ROLE_ORCHESTRATION`: the current autonomous supervisor still uses the
work/review/qa workflow vocabulary for ITS orchestration phases. That is legacy software
workflow configuration, not a planner concern — the planner needed none of it (its task
materializes through the generic mechanism and its turn runs directly through the trusted
runtime), so this is recorded as architecture debt, NOT a T20-04 blocker.

---

## Final durability corrective — Planner Task lifecycle & execution recovery

### AgentExecution recovery ownership

The GENERIC owner already exists: `agentRuntime.recoverInterrupted(actorId)` — the
Sprint-14 startup recovery orchestrator's seam (`main.ts` runs it quiescently after CAS
integrity, before any IPC exposure). A crash-left RUNNING execution converges to
**INTERRUPTED** (paged scan; never COMPLETED, never re-invoked). Proven with a REAL
restart: crash at `after_plan_artifact_before_execution_settlement` → reopen →
`recoverInterrupted` → INTERRUPTED (never RUNNING forever), plan single and canonical,
provider calls stay 1, replay returns the plan with zero calls and the recovered row stays
stable. No planner-specific recovery system was added (no table, no ledger, no flags).

### Planner Task lifecycle (the canonical machine, not a second one)

The planner task is a REAL canonical Task; its transitions go through the EXISTING
`applyTaskEvent` machine: budget-gated preflight → `PLAN` → `START` (attempts +1) →
provider turn → on success `COMPLETE` with the plan-output provenance; on invalid
proposal / provider failure → `FAIL` (never DONE). Pre-flight rejections (wrong run /
wrong kind / foreign company / missing binding / token overflow) happen BEFORE any task
mutation — the task stays PENDING with attempts 0. The planner runtime settles the task
itself because it IS this task's trusted executor (invoked directly by trusted services,
not routed through the software-role supervisor loop — recorded as
GENERIC_ROLE_ORCHESTRATION debt, not a blocker).

### Plan / Task / AgentExecution truth separation

Plan Artifact = business/planning truth. Task = work-lifecycle truth (PENDING→RUNNING→DONE,
attempts, outputs). AgentExecution = individual model-execution provenance (one COMPLETED
row per fresh planning command; crash-left rows converge INTERRUPTED). Related by durable
anchors (the artifact's taskId), none replaces the other. `Task.outputs` carries a
DETERMINISTIC REFERENCE (`plan: {planId, artifactId, fingerprint}`) — provenance only,
never plan authority, never a second plan store, never a latest-plan lookup.

### Artifact-first crash recovery (checkpoint matrix A–E)

Frozen checkpoints: `after_plan_context_before_plan_provider` (A),
`after_plan_proposal_validated_before_plan_artifact` (B),
`after_plan_artifact_before_execution_settlement` (C),
`after_plan_execution_settled_before_task_settlement` (D),
`after_planner_task_settled_before_return` (E). For each: A/B leave NO canonical plan — a
later authorized retry may call the provider again (the lost output was never truth); C/D/E
leave the plan durable — replay NEVER calls the provider, converges the task to DONE via
the durable causal link (the artifact's OWN taskId anchor + the same permanent command),
and the execution row converges INTERRUPTED through the generic recovery owner. In every
state: no duplicate plan, no DONE task without its plan, no COMPLETED execution without
its plan, nothing left RUNNING forever after restart + recovery.

### Task recovery ownership

Same owner as the execution provenance: the planner runtime converges its OWN task on the
next same-command invocation (deterministic causal reconciliation: same planning command +
the plan artifact anchored to THIS exact task ⇒ the task's business output is durable ⇒
canonical DONE), and pre-existing interruptions are handled by the generic
`recoverInterrupted`. No reconciliation table, no scan-newest-artifact, no timestamp
correlation — the causal link is the artifact's durable taskId anchor plus the permanent
command identity.

### Re-plan task semantics (the §29-§34 ruling)

T20-01's frozen lifecycle is `Planning Run → Plan → compiler → Execution Run` and nowhere
REQUIRES multiple plans per planning run; T20-03 freezes ONE baseline task per run/stage;
and one DONE task cannot truthfully carry two independent planning results without a
latest-plan ambiguity. The derived boundary: **one Planning Run authorizes one planning
result — a re-plan is a NEW Planning Run.** A second command against a settled planning
task fails closed (`PLANNER_TASK_ALREADY_SETTLED`, reporting the anchored plan); the
settled task's outputs are never overwritten; the plan is never mutated. The T20-02
planId formula is UNCHANGED (planningCommandId remains the replay identity input — it is
what makes same-command replay deterministic; under this boundary each run simply uses one
command). No `PLANNER_REPLAN_TASK_MODEL_GAP` remains: the model above represents replans
truthfully (each planning run's task settles with exactly its own plan).
