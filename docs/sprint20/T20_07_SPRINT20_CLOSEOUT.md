# T20-07 — Sprint20 Final Closeout

Baseline `b783c30` (T20-06 FULLY CLOSED / FROZEN). T20-07 adds NO product functionality:
verification + integration proof + gap classification + documentation + Sprint20 freeze.
Closeout evidence: `tests/sprint20/t20-07-sprint20-closeout.test.ts` (18 tests) plus the
frozen T20-02…T20-06 suites it references.

## Sprint20 mission (final statement)

Give CompanyOS a complete, deterministic, industry-neutral
**Goal → Plan → Workflow → Run → Task → Work Package** pipeline on canonical durable
truth, with permanent identities, exact pinned semantics, fail-closed dependency
readiness, and the ONE Sprint-11 HandoffService retained as the durable handoff owner.

## Product architecture statement (§7, frozen)

**CompanyOS Core = industry-agnostic goal-to-outcome work execution system. Software
development = ONE Industry/Business Pack.** The Sprint20 Core abstractions — Goal, Plan,
WorkflowVersion, Run, Task, Artifact, Decision, Validation, Handoff, Work Package —
remain industry-neutral (source-audited; the closeout suite asserts no business-domain
branching in plan.ts / plan-compiler.ts / work-package-projector.ts /
normal-task-materializer.ts / planner-runtime.ts).

## Final architecture: Goal → Outcome pipeline

Canonical Goal → Planning WorkflowVersion → Planning Run (run-owned goal) → Planner Task
(NormalTaskMaterializer) → Planner Runtime (proposal → T20-02 validation → immutable Plan
Artifact `companyos:plan`, content = fingerprint) → explicit selection + trusted
per-PlanItem spec → deterministic compiler → **permanent compilation anchor**
(`companyos:plan-compilation`) → deterministic WorkflowTemplate lineage → published
WorkflowVersion (criteria/profile frozen byte-exact) → Execution Run (deterministic Run.id
PK-arbitrated; own `companyos:run-goal`; plan ref = provenance only) → baseline Normal
Tasks (deterministic `tsk_` ids) → WorkPackageProjector → deterministic Work Package.
**Stop there: business Tasks are never executed by Sprint20.**

## Core vs Pack boundary

Core/Engine own MECHANISM (planning turns, compilation, materialization, projection,
recovery, identities). Packs own MEANING: roles, task kinds, validator sets, attempt
policies, stage kinds — all of it travels in trusted composition config and is frozen
into WorkflowVersion node config. A software workflow and a procurement workflow and a
novel logistics Pack compile and project through the exact same code.

## Authority matrix (§45)

| Truth | Canonical owner | Durable? | Replay identity | Writer | Reader/projector |
|---|---|---|---|---|---|
| Goal (per run) | `companyos:run-goal` artifact via RunGoalService (inside run tx) | yes | command `run-goal:<runId>` (Option-B unique) | run creation only | planner, projector (run-owned only) |
| Plan | `companyos:plan` artifact (T20-02 contract) | yes | permanent command `plan:<planId>`; planId `pla_sha256(company:run:command)`; fingerprint = contentHash | planner runtime only | compiler (explicit selection), audit |
| Workflow lineage | WorkflowTemplate row + versions | yes | deterministic `tpl_sha256(company:plan:command)[0:26]`, PK + guarded insert | compiler via real lifecycle | snapshot verifier, projector |
| Compiled version | WorkflowVersion row | yes (immutable once released) | content hash match inside the lineage (never currentVersion) | lifecycle publish only | run pin, projector |
| Execution Run | runs row | yes | deterministic `run_sha256(company:planningRun:plan:command)[0:26]`, PK + guarded insert | compiler via createRun | projector, supervisor |
| Task | tasks row (run-owned) | yes | creation seed run/stage/role/kind/maxAttempts/canonical inputs via putGuarded | materializer + corrective provisioner only | projector, supervisor, engine |
| Execution provenance | AgentExecution rows | yes | execution identity (T18) | agent runtime only | audit/recovery |
| Acceptance Criterion spec | frozen node config in WorkflowVersion | yes (immutable) | criterionId + byte-exact requirement | compiler only | projector, validation |
| Validation truth | validation rows (ADR-0020 evidence gate) | yes | permanent batch command identities | ValidationService only | evidence guard, supervisor |
| Handoff | Sprint-11 HandoffPacket (`handoffs`, PK (handoffId,version)) | yes | caller-supplied handoffId + version PK (replay → ALREADY_EXISTS, no dup) | HandoffService only | ACCEPTED-only projection via listForScope |
| Work Package | WorkPackageProjector | NO (derived) | Task identity + canonical truth (deterministic function) | nobody | any trusted consumer |
| Stage output carrier | `Task.outputs['stageOutput']` envelope + canonical sinks | yes | permanent sink command ids; per-task envelope written atomically with DONE | engine/stage carrier | projector (predecessor results) |
| Compilation input identity | `companyos:plan-compilation` anchor artifact | yes | command `plan-compile:<company>:<command>`; contentHash = compile-input fingerprint | compiler only | compiler replay/conflict |

## Identity matrix (summary)

planId `pla_…`; normal task `tsk_…(company:run:stage)`; compiled node `stg_…(plan:item)`;
compiled lineage `tpl_…(company:plan:command)`; execution run `run_…(company:planningRun:
plan:command)`; compilation anchor `plan-compile:<company>:<command>`; run goal
`run-goal:<runId>`; plan artifact `plan:<planId>`. Ledger retention is NEVER required for
correctness (re-proven at closeout §20).

## Recovery matrix (§46)

| Crash point | Canonical truth already durable | Missing state | Replay behavior | Provider re-invocation |
|---|---|---|---|---|
| Planner before Plan (A/B) | task PENDING, goal | no plan | authorized retry runs a new turn | YES (allowed — no truth yet) |
| Planner after Plan, before execution settlement (C) | plan artifact | execution settlement | replay same command → zero calls, same plan; recoverInterrupted converges the execution truthfully | NO |
| Planner after execution, before task settlement (D) | plan + execution | task DONE | same-command replay converges task via artifact.taskId anchor | NO |
| Compiler A (anchor durable, before template) | anchor | template/version | replay → same deterministic lineage + version | never (compiler has no provider) |
| Compiler B (version published, before run) | anchor + version | run | replay → exact content-matched version + deterministic Run.id | never |
| Compiler C (run + goal, before tasks) | … + run + goal | tasks | replay → same run id (PK), tasks materialize | never |
| Compiler D (partial tasks) | some tasks | rest | replay → putGuarded replays/creates the rest | never |
| Compiler E (all durable, before return) | everything | nothing | replay → identical result | never |
| Task materialization replay | tasks rows | — | deterministic ids + creation seed → REPLAY/conflict, lifecycle never reset | never |
| Work Package restart | all truth | — | same semantic package (pure projection) | never |
| Handoff restart | packets | — | same ACCEPTED-only projection | never |

## Replan semantics (frozen)

One Planning Run = one planning result; re-plan = a NEW Planning Run. A settled planner
task refuses a second planning command (`PLANNER_TASK_ALREADY_SETTLED`); same-command
replay returns the same artifact with ZERO provider calls; there is NO latestPlan /
currentPlan authority anywhere (source-audited).

## Work Package / Handoff distinction (frozen)

Work Package = derived execution projection (no table, no artifact, no state machine, no
handoff truth). HandoffPacket = the ONE durable explicit handoff record (Sprint-11).
Autonomous DAG edges create zero HandoffPackets; accepted packets project into the Work
Package through the domain's own ACCEPTED-only view.

## Upstream output authority (§26/§27, closeout audit)

Repository authority (pre-existing): the per-task `companyos/stage-output/1` envelope
written atomically with DONE; the corrective-child-wins subject rule with
round → recency → id tie-breaks (T19-04 work-subject selection, evidence layer);
corrective identity per decision (`tsk_sha256(company:run:decision:version)`), round =
parent lineage + 1, cap 3. T20-06 ADDED only the stage-scoped, kind-neutral packaging of
the SAME rule in `stageSubjectTaskOf` — no new output-selection authority. Same-round
double corrective: **possible** (two distinct decisions may parent the same stage at the
same derived round; no one-per-(stage,round) invariant exists) — the existing
earliest-(createdAt,id) tie-break is canonical, deterministic, restart-stable
(closeout-proven) and concurrency-safe (distinct deterministic ids; PK arbitrates
duplicates). Handoff identity responsibility (§29): handoffId is caller-supplied
(the frozen Sprint-11 contract), must be stable across retry to replay; the
(handoffId, version) PK arbitrates concurrency; creating a genuinely new handoff under a
new id is intentionally a distinct business action. No replay gap found; no new identity
system invented.

## Gap classification (§37/§38/§40)

- **GENERIC_ROLE_ORCHESTRATION = OPEN — V1 BLOCKER.** Answer to §37: **NO** — an
  arbitrary heterogeneous Pack created by T20-05 cannot yet be autonomously executed
  end-to-end without changing Supervisor Core: the legacy autonomous Supervisor still
  classifies stages with software semantics (`work`/`review`/`qa`, Developer/Reviewer/QA
  role orchestration). Core is industry-neutral in planning, compilation, tasks and
  context projection; execution orchestration is the remaining legacy surface.
- **PLAN_APPROVAL = OPEN — V1 LATER** (deliberately absent: explicit selection is the
  frozen authority; an approval layer is a product decision, not a pipeline gap).
- **PRODUCT_CONTROL_PLANE = OPEN — V1 LATER** (no UI/IPC for Work Package in T20-06 by
  ruling; §60 preserved).
- **REAL_PRODUCTION_PROVIDER_EXECUTOR = OPEN — V1 BLOCKER** (provider registry exists;
  real production provider/executor integration pending).
- **ARCHITECTURE_GUARD = OPEN — V1 LATER** (boundaries law covers layering/vocabulary; a
  dedicated architecture-decision guard is future hardening).
- **OBSERVABILITY = OPEN — V1 LATER** (structured logs exist; full trace/metric
  observability pending).
- **SECRETS/CONFIG/WORKSPACE SAFETY = OPEN — V1 BLOCKER** (vault exists; comprehensive
  secret/workspace safety audit pending before V1).
- **FINAL SYSTEM AUDIT = OPEN — V1 BLOCKER** (pre-freeze whole-system audit).
- **REAL PROJECT BUG BASH = OPEN — V1 LATER**.
- **POST-V1 LONG-TERM MEMORY = OPEN — POST-V1**.

## Recommended next sprint (§39)

**Sprint21 — PACK-DRIVEN GENERIC ORCHESTRATION** (close GENERIC_ROLE_ORCHESTRATION so
any Pack executes autonomously). Before: Architecture Guard, Minimal Observability, Real
Production Provider/Executor, Product Control Plane, V1 Final Audit. Not started
(HARD STOP).

## External references register (§41 — references only, NOT dependencies)

- **Paperclip** → control plane, executor adapters, governance, budgets, runtime
  visualization, parallel-agent locks.
- **Hindsight** → learned long-term memory (retain/recall/reflect, observations, mental
  models).
- **StateComp** → context compression timing.
- **PaMER** → short/long-term memory + recall.
- **DRSR** → safe context deletion / pruning.

None is integrated; none is canonical truth.

## Sprint20 is NOT CompanyOS V1 (§49)

Sprint20 closes the Goal → Plan → Workflow → Run → Task → Work Package
planning/execution-DEFINITION pipeline. It does NOT close runtime/product requirements
(see gap classification). **CompanyOS V1 is not finished.**

## Test and gate results (§50)

Closeout suite 18/18 (full-chain E2E, heterogeneous non-software scenario, criteria
freeze, plan contract, replan, pinned semantics, side effects, restart E2E with accepted
handoff, ledger loss, cross-run/tenant isolation, same-round corrective tie-break,
source/schema audits incl. §37 classification). Gates: `pnpm check` 5 consecutive PASS;
`pnpm test:scripts` 23/23; `git diff --check` clean; floor 186 files / 2365+ passing /
0 skips; closeout/non-software/restart/isolation suites 5/5 each; T20-03…T20-06 +
Sprint18 + Sprint19 regressions PASS.
