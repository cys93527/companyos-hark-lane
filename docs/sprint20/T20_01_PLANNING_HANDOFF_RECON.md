# T20-01 — Planning / Task Decomposition + Structured Handoff Hard Recon

READ / TRACE / ANALYZE / DOCUMENT ONLY. No production implementation, no schema change, no
planner, no Work Package implementation. Every claim below is source-traced at the frozen
Sprint-19 baseline (`4825ad0`, tag `sprint-19`).

## 1. Does planning already exist? (§3)

**NO.** A full-vocabulary scan (`plan|planner|decompos|specification|execution plan|goal
compiler|task graph|workflow compiler|workflow builder|task materializ`) over
core/engine/persistence/desktop production source yields only naming coincidences:

| Candidate | File | What it actually is | Verdict |
| --- | --- | --- | --- |
| `PLAN.COMPLETE` command, `PLAN` task/stage event | `core/domain/commands.ts`, `task.ts`, `stage.ts`, `engine/command-router.ts` | L3 task / L2 stage lifecycle transition PENDING→READY (execution naming) | not planning |
| `PromptPlan` / `toMessages(plan)` | `core/domain/prompt-assembly.ts` | the prompt RENDERING plan (system/user/structuredKeys → messages); process-local | not planning |
| `'planner:S18'` | `core/domain/event.ts:207-209` | the default audit-actor LABEL on `stage.created`/`task.created`/`task.state_changed` events (historical Sprint-18 naming for the engine's event stream) | not a component |
| `options.plan` / `readBranch(command)` | `engine/engine.ts:164,600` | BranchSet/context plumbing for engine drive | not planning |
| `ports/tool.ts:59` | explicit comment: the tool registry has "no `plan(...)` — that is what keeps this a registry instead of a planner" | by-design absence |
| `workflows.ts`, `pack-service.ts`, `validation-service.ts` | zero planning hits ("validation plan" = the validators array; workflows.ts = the IPC API) | not planning |

**Existing Planning: NO.** Nothing decomposes a Goal, generates task graphs, or derives
dependencies anywhere in production source.

## 2. Goal authority (§4)

- **Created + persisted:** at Run creation, same transaction — run-owned immutable Artifact
  kind `companyos:run-goal`, schema `companyos/run-goal/1`, permanent creation command
  `runGoalCommandId(runId)` (`core/lifecycle/run-goal.ts`, engine `goal/run-goal-service.ts`).
- **Identity:** the artifact id; the RUN is its scope (no separate goal store).
- **Run → Goal:** `run.goal` is the artifact row itself (created with the run; missing goal ⇒
  run creation rolls back — T18-02).
- **Readers:** Supervisor turn (`runGoal.get`, RUN_GOAL_MISSING fail-closed), Developer
  runtime and the T19-04 bounded projectors (same reader seam), review-findings sink
  (validation), every role projection states `goal.objective` fresh per invocation.
- **Can Goal change?** No mutation path exists: artifacts are immutable, the command id is
  fixed per run, and write failure rolls back the whole run. A changed goal = a NEW RUN.
  New-artifact/new-version/mutation: none apply within a run.

Planning must consume this canonical reader. **No second Goal store.**

## 3. WorkflowVersion — is it already a Plan? (§5)

`core/lifecycle/version.ts`: immutable, content-addressed version records — `contentHash =
sha256({templateId, semver, graph})`, `immutable: true` (ADR-0006), persisted on every
RunSnapshot (historical runs reproducible). Graph = `nodes {id, kind, title, config (OPAQUE —
Core never interprets)}` + `edges {from, to, condition?}`.

| Question | Answer |
| --- | --- |
| Already effectively a Plan? | It is a **static, human/pack-authored STAGE-LEVEL execution graph** — the skeleton a plan compiles TO, not a plan produced from a goal. |
| Static template parts | all of it: nodes, edges, kinds, config. |
| Run-specific parts | none in the version; run-specificity enters via the Run pinning + corrective Tasks added at runtime (T18-05). |
| Can a future planner safely produce one? | YES — through the EXISTING lifecycle (`createTemplate`/`saveDraftGraph`/`publish` with graph validation + authority); publishing mints a new immutable version. No new workflow truth needed. |
| Dependencies | YES — stage-level DAG via edges; engine `stageOrder` traversal is the executor. |
| Acceptance criteria | NO canonical expression (config is opaque; `validatorIdsOf` is the only interpreted convention). |
| Role assignment | PARTIAL — node `kind` (work/review/qa) maps to role runtimes via trusted composition registration; no per-node role identity. |
| Required validation | YES by convention — `config.validatorIds` (the Sprint-13 evidence gate's authority, `validatorIdsOf`). |

## 4. Task authority (§6)

- `createTask` (`core/domain/task.ts`) is a pure domain factory; **production callers: the
  corrective provisioner ONLY** (`supervisor/corrective-provisioner.ts:736`, deterministic
  `tsk_<sha256>` identity from the ACTIVE REQUEST_CORRECTIVE Decision).
- **The engine NEVER creates Task rows.** `executeStageInternal` executes the `taskIds` a
  stage command names and normalizes existing rows (PLAN/RETRY/UNBLOCK); it materializes
  nothing.
- **Normal (non-corrective) Tasks enter a Run only from outside the engine** — today:
  tests/fixtures and the desktop seeding path. There is NO production normal-task minting
  seam (this is the long-standing `HUMAN_GOAL_PRODUCT_INGRESS_GAP` family: the product layer
  must provide tasks).
- Supervisor creates normal Tasks: NO. Corrective only: YES (via the provisioner).
- Task↔Run binding: Task rows carry NO runId; membership is PROVEN by
  `stageId ∈ run's pinned version graph` (the decision-sink rule). Task↔Version: via the
  run's `templateId`/`versionId` + the same graph membership.

**Consequence:** a future Planner must mint normal Tasks through a NEW trusted materializer
seam shaped exactly like the corrective provisioner (deterministic identity, provenance,
idempotency) — it cannot and must not bypass the graph-membership invariant.

## 5. Dependency model (§7)

| Level | Status | Evidence |
| --- | --- | --- |
| Stage-level ordering | **CANONICAL EXISTING** | `WorkflowEdge {from,to,condition?}` + engine `stageOrder`; publish-time graph validation (DAG, entry/terminal). |
| Task-level dependencies | **MISSING** | no `dependsOn`/prerequisite field anywhere on Task; no task graph table. |
| Corrective lineage | **CANONICAL EXISTING** | `Task.inputs.corrective {parentTaskId, rootTaskId, round, originDecisionId, causeEvidenceRefs}` (T18-05). |

Cross-stage task dependency is DERIVABLE from stage ordering (all tasks of stage A precede
stage B when an edge exists). Verdict: do NOT invent a second dependency graph — a Plan
expresses dependencies as VERSION EDGES (stage-level) + task minting ORDER within a stage
plus, if finer grain is ever needed, a bounded `dependsOn` list INSIDE `Task.inputs`
(derivable, not a new table).

## 6. Acceptance criteria (§8)

Reconfirmed from source: **no canonical SOURCE exists today.** What exists are SEATS:

- `AgentContext.acceptanceCriteria` (`core/domain/agent-context.ts:49,81` — Sprint-8 context
  seat, bounded count) — production callers pass `[]` (supervisor-runtime:1412) or project
  `null` (T19-04 bounded context, labeled NON_AUTHORITY_PRESENTATION).
- **`HandoffPacket.acceptanceCriteria`** (`core/domain/handoff.ts` — Sprint-11 durable
  handoff packet, see §9 below) — a durable FIELD with no autonomous producer.

Natural home analysis: a WorkflowVersion node definition is template-reusable across goals
(wrong level for goal-specific criteria); an Artifact is durable but not execution-wired;
**`Task.inputs` is the natural execution-visible canonical seat** (bounded strings, consumed
fresh by the role projections — inputs already carry the corrective lineage precedent).
Recommendation: Plan carries the criteria (plan artifact, below); the trusted materializer
projects them into `Task.inputs.acceptance` (bounded); Reviewer/QA/Developer projections
surface them. No new entity, no truth duplication.

## 7. Current task materialization (§9)

```text
WorkflowVersion (published, immutable)
  → Run creation PINS it (templateId+versionId+snapshotId; goal artifact same transaction)
  → Task rows: NOT materialized automatically — externally provided per stage
  → engine drive/advance executes the named taskIds of each stage in stageOrder
```

Materialized at run creation: NO. Lazy: NO. Template-derived: the GRAPH is; the task rows
are externally minted (template-shaped in practice — one task per stage node as fixtures
do). Pack: packs contribute templates/versions (T15), not runtime task rows.
**This empty seam — "mint the pinned graph's normal tasks for this run" — is exactly where
future Planning integrates.**

## 8. The Sprint-11 Handoff system already exists (§15 discovery)

A complete structured-handoff subsystem predates Sprint 19 and remains durable and wired:

- **Domain:** `HandoffPacket` (`core/domain/handoff.ts`) — `handoffId`+`handoffVersion`,
  from/to roles+agents, `objective`, `summary`, `completedWork`/`remainingWork`/
  `constraints`/`acceptanceCriteria`/`knownRisks`/`openQuestions`/`recommendedNextAction`,
  `artifactRefs`/`decisionRefs`/`validationRefs`, `modelBinding`, `executionRef`,
  `supersedes` chain, accept/reject with REASONS, DRAFT→READY→ACCEPTED/REJECTED/SUPERSEDED/
  CANCELLED state machine.
- **Service:** engine `handoff/handoff-service.ts` — orchestration only: applies the Core
  state machine, persists versions, checks `handoff.create/read/accept/reject` authorities,
  emits REDACTED audit events (ids+counts only); never mutates the workflow, never accepts
  on behalf, never LLM-summarizes.
- **Persistence:** `handoff/0001_handoffs.sql` migration chain + `sqlite-handoff-store`
  (opt-in chain; enabled in the desktop app `main.ts` chains list, wired with
  `createHandoffService` + durableReferenceResolver).
- **IPC:** `handoff.create/ready/accept/reject/cancel/get` (Sprint-11 frozen contract,
  server-derived roles, client role claims forbidden).
- **Consumption seam:** `AgentRuntime` accepts `previousHandoff` (SERVER-DERIVED,
  ACCEPTED-packets-only projection; client-supplied values rejected) into the agent context
  (`agent-runtime.ts:135-139,675`).
- **Autonomous loop: does NOT consume it.** No supervisor/developer/reviewer/qa runtime
  reads packets; the T19-04 bounded projectors provide role-start context without it.

This is the decisive §15–§22 fact: the CompanyOS-native Work-Package-shaped entity ALREADY
EXISTS as an accepted, audited, versioned, authority-checked artifact — but as a
human/IPC-facing transfer channel, not as the autonomous roles' context source.

## 9. What each role receives today (§15)

| Role | Authoritative sources (fresh per invocation) | Canonical refs | Session residue | Missing facts | Duplicated fields | Presentation-only |
| --- | --- | --- | --- | --- | --- | --- |
| Developer | Goal objective; Task id/kind/state/lineage; run identities (id/companyId/workflowId/templateId/versionId); binding key; latest review verdict; workspace anchor | goal/task/parent-task/workspace-anchor refs; goal artifact ref | YES (eligibility-gated, bounded, `# Session residue` seat) | acceptance criteria (null-labeled); change-set summary; dependency list | none (authoritative vs residue stay distinguishable) | objective fallback string; classification map |
| Reviewer | Goal; subject Task (kind/state/inputs/lineage/delivered envelope); prior finding; run identities; anchor | delivered refs; goal artifact; prior-finding artifact; anchor | NO (structurally unreachable) | acceptance criteria (null-labeled) | none | classification map; bounded summaries |
| QA | Goal; target Task; latest review verdict; validator ids; six evidence slots; latest batch metadata; run identities; anchor | delivered refs; goal artifact; review artifact; anchor | NO | acceptance criteria; explicit slot→validator expectations (slots are frozen global, not per-goal) | none | classification map |
| Supervisor | Goal; run/pinned version; subject task; lineage; latest review (with findings); latest validation; bounded decision history; blocking conditions | goal/snapshot/binding/task/review/validation/decision refs | NO | acceptance criteria | none | bounded summaries/truncation flags |

Duplicated fields across roles: essentially none — each projection re-reads the same
canonical sources rather than copying another role's output.

## 10. The handoff problem, defined (§16)

Structured Handoff ≠ transcript copy. The eight questions and their canonical status today:

| Question | Canonical today? |
| --- | --- |
| What is the next role asked to do? | YES — the Task (kind/state) + run phase; plan-time objective once planning exists |
| Why? | PARTIAL — Goal objective + corrective lineage + prior finding; no per-task rationale |
| What canonical facts does it need? | YES — the T19-04 bounded projections ARE this |
| What evidence exists? | YES — delivered envelope, review/validation artifacts, refs |
| What constraints apply? | PARTIAL — task inputs/lineage; no explicit constraint list (HandoffPacket has the FIELD) |
| What acceptance criteria apply? | NO (§6) — the gap planning closes |
| What is unresolved? | NO — openQuestions exist only as a HandoffPacket field, unproduced |
| What refs allow deeper inspection? | YES — canonical refs everywhere |

## 11. Work Package truth question (§17) + identity (§18)

**Work Package is a PROJECTION, not truth.** Source compatibility confirms the Boss
preference: a role-start package is fully reconstructible from Goal + Task (+inputs) +
Decision + Artifacts + Review + Validation + repository anchor + (future) planning metadata
— exactly the inputs the T19-04 projectors already read. Two CompanyOS-native realizations,
NOT competing truths:

1. **Autonomous path (primary): the bounded role projections ARE the Work Package** —
   deterministic, stateless, fresh, already role-isolated and budget-gated. Extending them
   with the missing facts (criteria/constraints/rationale via Task.inputs + plan refs)
   completes structured handoff with ZERO new stores.
2. **Human/IPC path (existing): the Sprint-11 HandoffPacket** remains the durable,
   acceptable/rejectable transfer channel when a HUMAN or another process must take/accept
   a package. It is already versioned, authority-checked and audited.

**Work Package durable identity (§18):** for the projection path — a DETERMINISTIC
PROJECTION KEY (task + role + run revision) is the minimum; no durable row is needed
(restart = reproject; nothing to recover). For the human path — the existing
`handoffId`+`handoffVersion` (durable, supersede-chained). Recommendation: adopt exactly
these two; mint no third identity.

## 12. Role-specific handoff packages (§19)

All packages = the role's existing bounded projection + the planning-era additions. Raw
transcripts FORBIDDEN in every package (already structurally true).

| Handoff | Required authoritative facts | Canonical refs | Optional presentation | Forbidden data |
| --- | --- | --- | --- | --- |
| Planner → Developer | Goal; Task(kind/state); acceptance criteria (from plan→inputs); dependencies (stage edges); workspace anchor | plan artifact; goal; task; anchor | rationale summary from plan | plan model's raw reasoning; other roles' transcripts; repository contents |
| Developer → Reviewer | Goal; subject Task + delivered envelope; criteria; lineage | delivered refs; goal artifact; execution id | work summary payload | Developer session residue; hidden reasoning; repo contents |
| Reviewer → Corrective Developer | + prior blocking finding (canonical report) | prior-finding artifact; decision ref | bounded finding summaries | reviewer transcript; full finding history (latest blocking only) |
| Reviewer → QA | Goal; target; latest verdict; validator ids; slots | review artifact; delivered refs; goal artifact | — | findings text (verdict+ref only); transcripts |
| QA → Supervisor | latest batch metadata; verdicts; target state | validation ids; review artifact | — | transcripts; raw tool output (evidence refs only) |

## 13. Corrective / Session / Repository compatibility (§20–§23)

- **Corrective:** `Task.inputs.corrective` + Review findings + Decision refs + parent/root/
  round remain THE lineage; the corrective handoff package reads them (T19-04 already
  projects lineage + prior finding). No second rework lineage.
- **Session:** Work Package = role-START projection; Developer Session = bounded
  CONVERSATIONAL continuity. Integration seam (exact): the Developer runtime's
  `authoritative` projection — the package's facts ride the same fresh-per-turn seat;
  session residue stays the separate, eligibility-gated seat. NO session schema change.
- **Reviewer/QA:** stay stateless/bounded; packages are per-invocation projections; no
  durable Reviewer/QA sessions (§22 satisfied by design).
- **Repository:** packages reference the workspace anchor id (+ baseline/revision anchor
  refs when present), never contents — Sprint-17 authority (path policy, read-only git,
  anchoring) unchanged.

## 14. Planning authority + output truth + shape + idempotency + approval (§10–§14)

- **Authority seam (§10):** the smallest legitimate seam is
  `Goal → Planning result (durable artifact) → TRUSTED validation/compilation → EXISTING
  WorkflowVersion publish + a normal-Task materializer (corrective-provisioner-shaped)`.
  The planner gains NO new authority over tools/validators/lifecycle; it goes THROUGH the
  existing publish authority and a single new trusted minting seam.
- **Plan truth (§11) — recommendation: B.** The Plan is a DURABLE ARTIFACT (run-scoped or
  template-scoped, versioned like every artifact); WorkflowVersion + Task remain the ONLY
  execution truth. Rejection of A: a canonical Plan would become a second workflow truth
  racing the pinned version (exactly what Sprint 19 froze out). Rejection of C: an
  ephemeral plan loses auditability, restart safety, replay and human review. B scores:
  no duplicate truth (version/tasks stay execution truth), restart safe (artifact +
  deterministic replay), auditable (artifact + audit events), versionable (artifact
  versions / content hash), replay safe (§13 idempotency below), human-reviewable (the
  artifact IS the review surface), compatible with WorkflowVersion (compile target), Task
  (materializer), Supervisor (reads canonical state only), corrective Tasks (provisioner
  unchanged).
- **Planner shape (§12): HYBRID.** Model PROPOSES (one pinned round, structured-only, no
  tools — the T18-06 supervisor-proposal pattern); a DETERMINISTIC validator/compiler
  materializes (schema-strict decode → graph validation → authority checks → publish +
  mint). Model output NEVER writes Task/version rows directly; any invalid proposal fails
  closed with zero side effects.
- **Idempotency (§13):** permanent identity everywhere, never the bounded command ledger:
  `planId = pla_<sha256(company:run:planningCommand)>` (the corrective-provisioner
  principle); the plan artifact carries a content fingerprint; same command + same plan ⇒
  replay; same command + DIFFERENT model plan ⇒ CONFLICT (fail closed — a drifting model
  cannot silently replace a plan); crash between artifact and materialization ⇒ recovery
  replays the materialization (task ids deterministically derived from the plan
  fingerprint, so minting is idempotent); same goal twice ⇒ same command identity ⇒ same
  plan replay.
- **Approval (§14): CONDITIONAL, reusing existing authority only.** The Decision system +
  run `PAUSED`/`WAITING_APPROVAL` semantics + human escalation (RUN.RESUME never auto)
  already represent "a human must decide"; the Sprint-11 packet accept/reject is the
  package-level human channel. Recommendation: V1 compilation (deterministic validator
  passed) may run WITHOUT a separate approval when the deployment's trusted configuration
  says so; where a human must approve the plan, represent it as an existing Decision-style
  gate (or packet acceptance) — NO second approval system.

## 15. Validation / tool authority (§24–§25)

The planner may PROPOSE validator ids and desired capabilities INSIDE the plan artifact;
the deterministic compiler only accepts validators that the produced version's node config
declares and the registry knows (publish-time UNKNOWN_VALIDATOR check); ToolRegistry, risk,
approval and workspace-lease authorities are untouched. Model output can never mint
validator or tool authority. (This is the R1-B authority the Sprint-13 gate already uses.)

## 16. External mechanism research (§26, READ-ONLY)

### GitHub Spec Kit (spec-driven development)

| Mechanism | Problem it solves | Why designed that way | Useful principle | CompanyOS equivalent | CompanyOS real gap | Adopt? |
| --- | --- | --- | --- | --- | --- | --- |
| Constitution before spec | project guardrails bind every later artifact | later stages cannot renegotiate foundations | machine-checkable guardrails precede generation | frozen architecture + ADRs + eslint boundary rules | no plan-time machine-checkable rule set | LATER (plan validator can encode a rule set) |
| ordered spec → plan → tasks artifact chain with gate commands | each phase's output is the next's verified input | prevents planning before specification ambiguity is resolved | ordered, gated artifact chain | Goal artifact → (missing) plan artifact → version+tasks | the middle links | **YES** (as artifact chain + validator gates, not markdown files) |
| requirements traceability (/analyze cross-check) | drift between spec/plan/tasks | every task must trace to a requirement | bidirectional trace ids in every artifact | artifact refs/decision refs everywhere; no plan-level trace ids | plan→criterion→task trace field | **YES** (plan schema carries criterion ids; compiler checks coverage) |
| tasks checklist execution with completion marks | incremental, resumable execution | small reviewable units | task-level progress is durable | Task lifecycle + Supervisor loop | none | NO (already native) |

### micronwave/orca (Go orchestration runtime for coding agents)

| Mechanism | Problem it solves | Why designed that way | Useful principle | CompanyOS equivalent | CompanyOS real gap | Adopt? |
| --- | --- | --- | --- | --- | --- | --- |
| Obligations (goal → checkable done-conditions) | open-ended prompts let agents claim success | "done" must be checkable before an agent runs | compile the goal into bounded checkable criteria | acceptance criteria SEAT exists; no canonical source/compilation | goal → criteria compilation | **YES** (criteria as bounded Task.inputs strings + refs; verification stays Review/QA/Validation) |
| Execution Capsule (files+token budget+gates per run) | unbounded scope and cost | every run is bounded and inspectable | package = obligations + scope + refs | T19 bounded context + token budget + Sprint-17 path policy/workspace | criteria/scope in ONE package shape | **YES** (as the role-start projection composition — already half-native) |
| Evidence requirements + Reconciler (claims unverified until evidence) | agent assertions ≠ outcomes | merge only on verifiable evidence | typed evidence matched against obligations | Validation batches + EvidenceGuard + anti-cherry-pick + canonical sinks | none | NO (already CompanyOS's core) |
| Context projections instead of transcript replay | transcripts don't transfer | context is projected, not replayed | fresh bounded projections per role | T19-04 bounded projectors + eligibility-gated session residue | none | NO (already native) |
| Durable event log + resume | crash mid-orchestration | recovery without redo | durable events + idempotent resume | durable commands/ledger/artifacts + crash proofs (T18-08) | none | NO (already native) |

**Anti-stitching (§27/§28):** no external code copied, no dependencies added, no domain
model imported. Spec Kit contributes the ordered-artifact + traceability PRINCIPLE; Orca
contributes the obligations PRINCIPLE (and mostly CONFIRMS the native design — its
evidence/reconciler/context-projection mechanisms already exist here as Validation/
EvidenceGuard/bounded projectors). The final architecture below is CompanyOS-native.

## 17. Architecture cleanliness (§29)

One new component family is proposed (the Planner seam); the checklist:

| Question | Planner (propose+compile seam) | Normal-task materializer |
| --- | --- | --- |
| Owner | engine `planning/` (domain-neutral) | engine `planning/` (corrective-provisioner sibling) |
| Extends | the T18-06 pinned-turn + proposal-contract pattern | the T18-05 provisioner pattern |
| Why the current owner can't | nothing today turns a Goal into a version+tasks | the engine deliberately never mints tasks |
| Authoritative data | the Plan ARTIFACT (versioned, content-hashed) | Task rows (existing store) + version publish (existing lifecycle) |
| Writers | the deterministic compiler ONLY (model output is an untrusted proposal) | the materializer ONLY |
| Readers | humans (review), compiler, role projections (via Task.inputs refs) | existing runtime |
| Lifecycle | artifact-immutable; new plan = new version (supersede chain) | existing Task lifecycle |
| Recovery | artifact + deterministic replay of compile+mint (§14) | same |
| Versioning | artifact versions + content hash | version publish (ADR-0006) |
| Replay | same command+same plan ⇒ replay; different plan ⇒ CONFLICT | deterministic task ids ⇒ idempotent mint |
| Becomes redundant | nothing | nothing (the fixture-only task seeding becomes production) |

The Work Package needs NO new component (projection + existing packet). HandoffPacket
gains an autonomous-path PRODUCER OPTION later, not a new store. All rows answerable ⇒ PASS.

## 18. Minimal target architecture (§30)

```text
Human Goal (human goal/product control plane — allowed-open V1 item)
  ↓ (existing run creation: Goal artifact + pinned WorkflowVersion, same transaction)
Run ── Goal artifact (immutable, run-owned)
  ↓
[PLANNING SEAM — the ONE new trusted component]
  Planner turn (pinned model, structured-only, no tools)  ──propose──▶  Plan PROPOSAL
  ↓ deterministic Plan Validator/Compiler (schema-strict, graph-validating, authority-checking)
  Plan ARTIFACT (durable, versioned, content-hashed; criterion ids; validator/evidence
  expectations as PROPOSALS only)          ←── human review/approval (existing Decision /
  ↓                                            packet-accept channel; conditional)
  EXISTING lifecycle: publish WorkflowVersion (immutable, content-addressed)
  ↓
  EXISTING Run pins the version (or the plan targets the already-pinned template version)
  ↓
  Normal-Task Materializer (trusted, corrective-provisioner-shaped, deterministic ids)
      → Task rows (stageId ∈ pinned graph; Task.inputs: bounded acceptance criteria,
        constraints, refs — THE planning projection into execution truth)
  ↓
  EXISTING frozen runtime, unchanged:
    Supervisor (state-reconstructed) → Developer (durable session) →
    Reviewer / QA (bounded state-reconstructed) → Validation/EvidenceGuard →
    corrective provisioner → delivery
  ↓
  STRUCTURED HANDOFF (no new store):
    role-START packages = the T19-04 bounded projections + Task.inputs criteria/refs
      (autonomous path; deterministic projection key, no durable row)
    HandoffPacket (Sprint-11, existing) = the human/IPC accept-reject channel
    Developer Session = unchanged bounded conversational continuity
    Repository = anchor/baseline REFS only (Sprint-17 authority intact)
```

Where each piece fits: Planning = the seam after Goal, before version publish/task mint.
Acceptance criteria = plan artifact → Task.inputs (bounded) → role projections.
Dependencies = version edges (stage DAG) + mint order (+ optional bounded Task.inputs
dependsOn). Structured handoff = projection path + existing packet channel.

## 19. Proposed task breakdown (§31 — recommend only, do NOT execute)

- **T20-02** — Plan artifact contract + deterministic plan validator (Core contract: plan
  schema, criterion ids, fingerprint; engine validator with strict decode + graph/authority
  checks + CONFLICT-on-drift idempotency). Tests-only + engine module; no runtime wiring.
- **T20-03** — Planner turn runtime (pinned model round, structured-only proposal, zero
  tools, fail-closed decode; crash/replay proofs; optional approval gate via existing
  Decision semantics — configuration-decided).
- **T20-04** — WorkflowVersion compilation + normal-Task materializer (publish through the
  existing lifecycle; deterministic task ids; Task.inputs criteria/constraints/refs
  projection; recovery replay; the graph-membership invariant unchanged).
- **T20-05** — Structured handoff completion (role-start packages: extend the T19-04
  projectors with Task.inputs criteria/refs + plan refs; per-role package tests incl.
  corrective; optional HandoffPacket producer for the human channel).
- **T20-06** — Sprint-20 closeout (E2E Goal→Plan→Version→Tasks→Develop→Review→QA→
  corrective; gap board; freeze).

## 20. Gap board (§32)

| Gap | Status | Evidence |
| --- | --- | --- |
| PLANNING_RUNTIME | OPEN | §3: no planner exists |
| GOAL_TO_PLAN | OPEN | §4: goal is consumed by roles, never compiled |
| PLAN_DURABILITY | OPEN (design ready §14: artifact, option B) | no plan artifact today |
| PLAN_VERSIONING | OPEN (design: artifact versions + content hash) | — |
| PLAN_IDEMPOTENCY | OPEN (design: planId hash + fingerprint CONFLICT) | — |
| PLAN_TO_WORKFLOW | PARTIAL | version publish lifecycle EXISTS (§5); no compiler |
| PLAN_TO_TASK | PARTIAL | corrective minting EXISTS (§6); normal-task materializer missing |
| TASK_DEPENDENCIES | PARTIAL | stage DAG canonical (§7); task-level derivable/missing by design |
| ACCEPTANCE_CRITERIA | PARTIAL | seats exist (AgentContext, HandoffPacket, §8); no canonical source/compilation |
| PLAN_APPROVAL | PARTIAL | Decision/PAUSED/WAITING_APPROVAL + packet accept exist (§14); no plan gate wired |
| WORK_PACKAGE_PROJECTION | PARTIAL | T19-04 bounded projectors ARE role-start packages (§11); criteria/rationale missing |
| WORK_PACKAGE_ROLE_ISOLATION | CLOSED | T19-04 §44 (structural + message-capture proofs) |
| WORK_PACKAGE_RESTART | CLOSED | stateless reprojection (T19 closeout §7) |
| WORK_PACKAGE_TRUTH_SEPARATION | CLOSED | projections read canonical truth only (ADR-0030) |
| PLANNING_TOOL_AUTHORITY | CLOSED (by design) | §15: registry/risk/approval/lease untouched; proposals only |
| PLANNING_VALIDATOR_AUTHORITY | CLOSED (by design) | §15: pinned node config + registry authorizes; UNKNOWN_VALIDATOR at publish |

## 21. Architecture Corrective: Planning Lifecycle Sequencing (Boss review of T20-01)

*(Added by the required architecture corrective at baseline `445bd66` — READ/TRACE/ANALYZE/
DOCUMENT only. This section SUPERSEDES the naive ordering implied by §18 where they differ;
§1–§20 findings stand as traced.)*

### 21.1 The cycle is REAL (corrective §1)

Source-proven chain:

1. `createRun` REQUIRES a published template's CURRENT version — the caller cannot even
   supply a version id (`lifecycle-service.ts:892-1070`: template must be `published` +
   `isRunnable` + `currentVersion`; the run pins it inside the transaction; the RunSnapshot
   is created there).
2. The canonical Goal (`companyos:run-goal`) is created INSIDE that same transaction
   (`lifecycle-service.ts:1027-1049`, `runGoal.attach`, identity `run-goal:<runId>`).
3. Artifacts are RUN-OWNED by schema (`artifacts.run_id TEXT NOT NULL`,
   `artifact/0001_artifact_validation.sql:23`).
4. T20-01's recommended lifecycle had the Planner consume the canonical Goal and compile
   the WorkflowVersion the Run then pins.

Therefore `Run ← Version ← Plan ← Goal(run-goal) ← Run` — **CONFIRMED REAL CYCLE**. The
§18 diagram was wrong to draw Goal → Plan → Version → Run creation without any owner for
the pre-run Goal.

### 21.2 Run creation — exact contract (corrective §2)

| Question | Answer | Source |
| --- | --- | --- |
| function/file | `createWorkflowLifecycle().createRun`, `engine/src/lifecycle-service.ts:892` | — |
| required arguments | `templateId`, `workflowId`, `companyId` (+ actor); `versionId` is NOT caller-supplied | `CreateRunInput:236-258` |
| goal input | optional `goal {objective, source}`; when present REQUIRES the runGoal writer (fail closed) | `:1032-1037` |
| goalArtifact creation point | inside the run-creation transaction (`runGoal.attach`) | `:1038-1049` |
| RunSnapshot creation point | same transaction (`createRunSnapshot`; run bound to snapshotId) | `:1005-1025` |
| transaction boundary | one UoW transaction: template pin-lock → run → snapshot → goal → ledger → lock release | `:947-1070` |
| Run without WorkflowVersion | **NO** | published + currentVersion required `:954-977` |
| Run with an unpublished version | **NO** | template state must be `published` `:954-965` |
| Pin changed after creation | **NO** | no API writes `versionId`; `createWorkflowRun` sets it once `:993-1002` |
| RunSnapshot repinned | **NO** | snapshot immutable; `verifyRunSnapshot` fails closed on mismatch (T18-02) |
| Run adopts a newer version later | **NO** | would require repin — no transition exists; recovery replays the SAME pin |

### 21.3 Goal pre-run existence (§3) and Artifact ownership (§4)

- `companyos:run-goal` without Run: **NO** (run-owned kind; identity derived from runId).
- Generic Artifact without run ownership: **NO** (`run_id NOT NULL`).
- Artifact company-owned but not run-owned: **NO**.
- HandoffPacket carrying pre-run Goal truth: **NO** — `workflowRunId` is a REQUIRED string
  (`core/domain/handoff.ts:111`); packets are run-scoped.
- Another existing canonical object representing a pre-run Goal: **NO**. Closest pre-run
  canonical entities: `ChangeProposal` (template governance — rationale + graph ops,
  company/template-scoped, decision → publish provenance via
  `WorkflowVersion.changeProposalId`) and the WorkflowTemplate itself; neither is a Goal
  authority (a ChangeProposal can carry VERSION provenance, not a goal).
- Cross-run artifacts: rows are mechanically readable, but **evidence semantics reject
  cross-run** (`validation-service.ts:198` (`v.runId !== command.runId`), `:282`
  (`artifact.runId !== command.runId`); T17-06 "cross-run and cross-task evidence fails").
  A cross-run artifact citation can be PROVENANCE, never canonical evidence.
- Immutable shared source artifacts: no shared-source ownership semantic exists.

### 21.4 WorkflowVersion timing (§5) and Task materialization timing (§6)

- WorkflowVersion requires a Run: **NO**. `createTemplate`/`saveDraftGraph`/`publish` are
  template-level lifecycle operations entirely outside any Run; versions exist before any
  Run; publish happens outside Run. Provenance to a Goal/Plan ARTIFACT: **NOT CURRENTLY**
  (the only provenance seat is `changeProposalId` → ChangeProposal).
- Normal-Task materialization legality: **C only** — after Run creation, for nodes already
  in the pinned graph (the graph-membership invariant). (A) before Run creation is
  technically writable but semantically ambiguous — task rows carry no runId, so a
  pre-created task binds to EVERY run pinning that version (the two-run ambiguity is
  exactly the T19-04 lesson); (B) during Run creation has no trusted hook today. A future
  materializer is provisioner-shaped and runs at C.

### 21.5 Lifecycle shape evaluation (corrective §7–§11)

- **Shape A (pre-run planning): REJECT for V1.** No existing canonical owner can hold the
  Goal before a Run (§21.3); it requires a brand-new pre-run Goal authority — i.e. it IS
  Shape E with everything that entails.
- **Shape B (planning Run → execution Run): ACCEPT — recommended.** See §21.6.
- **Shape C (same-run dynamic repin): REJECT explicitly.** RunSnapshot and the pinned
  version are immutable; `verifyRunSnapshot` fails closed on mismatch; recovery/replay
  (T18-08) and every Sprint-18/19 invariant assume one immutable pin per run. Weakening
  them to make planning easier is forbidden by the firewall.
- **Shape D (generic execution graph with dynamic tasks): REJECT.** The version degenerates
  into a fixed shell that says nothing about the actual work; the plan's real structure
  would live in minting order or `Task.inputs`-smuggled edges — a parallel task-DAG truth
  outside WorkflowVersion, and effectively a second scheduler.
- **Shape E (minimal pre-run Goal ingress): DEFER (not required for V1).** It would NOT be
  a second Goal truth if `companyos:run-goal` became the deterministic, cited
  materialization of a canonical Goal Request — but it needs a new entity/authority
  (artifacts cannot host it: run-owned by schema; the Boss firewall forbids casually
  adding a Goal table). Zero-schema-change planning exists via Shape B, so the ingress is
  not a prerequisite. Revisit only if planning-run overhead proves material.

### 21.6 Recommended lifecycle (corrective §19) — Shape B, zero new entities

```text
Human intent
  ↓ (existing createRun, unchanged)
PLANNING RUN — pins a published PLANNING WorkflowVersion (a fixed, human-authored
  template whose graph IS the planning workflow; that version exists entirely outside
  runs, §21.4)
  ├─ canonical run-goal artifact (THE goal, created in-transaction — the cycle's exit)
  ├─ Planner turn (T20-03: supervisor-style pinned model round, structured-only,
  │  zero tools, fail-closed) → PLAN ARTIFACT (run-owned, durable, versioned,
  │  content-fingerprinted — Model B unchanged, now with a legal owner)
  ├─ deterministic Plan Validator/Compiler (T20-02 contract): strict decode, graph
  │  validation, authority checks, criterion coverage
  └─ human review/approval where configured (existing Decision / packet-accept
     channels only)
  ↓ compiled through the EXISTING template lifecycle (publish; provenance = the
     planning template's own version/change-proposal lineage)
EXECUTION WORKFLOWVERSION (immutable, content-addressed, published pre-run — legal, §21.4)
  ↓ (existing createRun, unchanged)
EXECUTION RUN — pins it; its run-goal artifact is the DETERMINISTIC DERIVATION of the
  plan (cites planning runId + plan artifact id in its source; not an independent truth)
  ↓
Normal-Task materializer (T20-04, provisioner-shaped, deterministic ids, timing C:
  after run creation, stage ∈ pinned graph; Task.inputs carries bounded criterion REFS)
  ↓
Supervisor → Developer → Reviewer → QA → Validation/EvidenceGuard → corrective → Delivery
  (all frozen Sprint-18/19 runtime, unchanged)
```

No circular dependency (the planning run's goal is created WITH the planning run — the
planner consumes it after that run exists). No repin. No second workflow (the execution
version goes through the existing publish authority). No second task system
(provisioner-shaped minting into the existing store; graph-membership invariant intact).
No second goal truth (the execution run's goal is a cited, deterministic derivation; the
planning run's goal is the canonical input). No second handoff persistence (Sprint-11
HandoffService is the durable human/IPC owner — CONFIRMED: packets + versioning +
accept/reject/supersede + audit + IPC + ACCEPTED-only previousHandoff projection all
exist and are wired; future Structured Handoff EXTENDS it).

**Autonomous Work Package identity (corrective §18):** deterministic projection identity
(`task + role + run revision`) — no durable row, no table; reprojection on restart.

### 21.7 Plan truth / identity refined (corrective §13/§14)

- Plan Artifact owner: the PLANNING RUN (artifacts are run-owned — the only zero-schema
  durable owner; the execution run reads it as a provenance citation, never evidence,
  §21.3).
- Logical identity: `planId` = deterministic from the canonical planning scope
  (company + planning run + permanent planning command) — the decision-sink /
  corrective-provisioner identity pattern, NOT a bare content hash.
- `planFingerprint = hash(canonical plan content)`; the plan carries an integer version.
- Replay/conflict: same permanent command + same fingerprint ⇒ replay; same command +
  different fingerprint ⇒ **CONFLICT (fail closed)** — a drifting model can never silently
  replace a plan. Fits the existing permanent-identity patterns exactly.
- Can the model produce a different plan for the same permanent command? It can TRY; the
  fingerprint CONFLICT detects it, and the model NEVER writes the artifact — only the
  deterministic compiler does.

### 21.8 Acceptance criteria ownership (corrective §15) — D (hybrid), frozen at publish

**Plan defines → WorkflowVersion freezes → Task references.**

- The Plan artifact defines the criteria (stable criterion ids + plan→criterion→task
  traceability).
- The compiler freezes them into the published version's NODE CONFIG (the `validatorIds`
  convention precedent — opaque to Core, interpreted by trusted edge readers); version
  immutability + content hash answer the hard constraint: a later plan version can NEVER
  silently change criteria for an already-pinned execution run.
- Task.inputs carries bounded criterion REFS (ids), NOT full copies — no N-copy drift.
- Reviewer/QA consume criteria from the PINNED VERSION's node config (authoritative for
  that run) via their existing fresh projections; corrective Tasks inherit through the
  same pinned config + parent task refs. Truth duplication: none (plan = provenance;
  version = frozen execution truth; task = refs). Freshness: immutable by design once
  pinned. Restart: version-pinned. Auditability: content hash + plan artifact.

### 21.9 Dependencies ruling (corrective §16)

`TASK_DEPENDENCY_MODEL_REQUIRED = NO` for V1. The planner compiles dependencies into the
WorkflowVersion stage DAG (one node per dependency group; edges = ordering); tasks within
a stage execute in the frozen bounded SERIAL order (the T18 "ONE agent task per Decision"
rule), so intra-stage ordering is guaranteed without any task-level edge store. No
concrete required V1 scenario exists that the stage DAG cannot express — "B depends on A
inside one stage" compiles to two nodes with an edge. Task-level dependency storage stays
absent by design.

### 21.10 Roadmap impact (corrective §21)

Planning CAN be implemented correctly without pre-run Goal ingress (via Shape B), so the
Product Control Plane roadmap does NOT move (**NO** — not even MINIMAL_INGRESS_ONLY for
V1; Shape E stays a documented future refinement). Corrected task order (content adjusted,
sequence intact):

- **T20-02** — Plan contract + deterministic validator (plan schema, criterion ids,
  fingerprint/CONFLICT idempotency, planning-run ownership, compiled node-config criteria
  convention).
- **T20-03** — Planner turn runtime INSIDE a planning run (pinned model round,
  structured-only, zero tools; the planning WorkflowVersion template; approval via
  existing channels where configured).
- **T20-04** — WorkflowVersion compilation + execution-Run derivation + normal-Task
  materializer (publish through the existing lifecycle; the execution run's goal is a
  deterministic cited derivation; provisioner-shaped minting at timing C).
- **T20-05** — Structured handoff completion (role-start packages = the T19-04 projections
  + pinned-version criteria refs; extend/reuse HandoffService for the human channel).
