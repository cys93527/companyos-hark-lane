# T20-05 — Deterministic Plan Compiler + Execution-Run Derivation + Task Materialization

Mission: an explicitly selected canonical immutable Plan Artifact plus a trusted immutable
compilation profile become, with ZERO model calls, a published immutable WorkflowVersion →
ONE Execution Run pinned to exactly that version (its own canonical goal) → baseline normal
Tasks through the frozen materializer. No Planner call, no Task execution, no Structured
Handoff, no Plan approval.

## Compiler authority and the pure boundary

Owner: trusted Engine infrastructure (`engine/src/planning/plan-compiler.ts`), wired into the
production composition as `core.planCompiler` (trusted main-process service; not IPC / not a
Tool / not MCP / not model-callable).

Split (Boss §11): `compilePlanGraph` is the PURE transformation (Plan + profile → the
canonical WorkflowVersion graph — zero provider/model calls, zero repair, zero AI
classification, zero current-time semantic decisions, zero random semantic ids; identical
trusted inputs ⇒ identical output). The service shell around it owns durable identity,
publication, run creation and materialization — no runtime side effects in the pure part.

## Compilation profile authority (§7-§10)

T20-02 deliberately lets the Plan choose NO execution semantic. The authority here is the
**trusted immutable compilation profile** — composition/Pack-owned configuration supplied as
an explicit input to each compilation command: `{stageKind, taskProfile:{roleId, taskKind,
maxAttempts}, validatorIds?}`. Software, procurement, legal, finance, content profiles all
work identically — Core contains no industry branch (source-asserted by the test suite).
The profile is NOT a live default and NOT registration-order-derived (T20-03B rulings
carry over). Pre-persistence replay stability (§10): the profile is an immutable input of
the command; a same-command retry with different semantics CONFLICTS
(`COMPILILATION_COMMAND_CONFLICT` via the deterministic template name + graph hash) — a
crash can never silently drift to a newer/Pack default profile.

## Plan selection (§4-§6)

EXACT selection: `{companyId, planningRunId, planArtifactId, compilationCommandId}` — the
caller names the precise artifact id; the compiler performs exactly ONE artifact read and
never scans for newest/latest. Authority validation: artifact exists, owned by the named
planning run (else `PLAN_ARTIFACT_NOT_OWNED`), kind `companyos:plan`, payload is the strict
T20-02 `companyos/plan/1` (revalidated by `validatePlanArtifactPayload`), CAS content hash
re-verified byte-for-byte, plan identity recovered from the artifact's own permanent
creation command (`plan:<planId>` — the planner runtime's row-level anchor). Foreign
company ⇒ NOT_FOUND / no leak. The Plan is compile input and immutable provenance — never
cross-run evidence inside Execution-Run validation semantics.

## Plan item → node compilation (§12-§15)

Deterministic node id `stg_<sha256("companyos/plan-stage/1:"+planId+":"+planItemId)[0:16]>`
(same Plan ⇒ same ids; different Plan identity ⇒ salted apart). Every semantic survives:
`config.planItem = {planItemId, objective, acceptanceCriterionRefs}` (byte-exact objective),
dependencies compile EXACTLY into WorkflowVersion edges (A→B, A→C, (B,C)→D — no
linearization, no hidden reorder; §60 shape proven), and the T20-02 validator already
rejected cycles/self/duplicates at plan time, but the publisher's own graph validation
re-checks everything (defense in depth — nothing invalid can survive to publish).

## Acceptance-criteria freeze (§16-§19)

Criteria are specification truth frozen INTO the immutable version config: each node carries
`config.acceptanceCriteria` = the full definitions (criterionId + requirement, byte-exact
text — never rewritten, summarized, renamed or reinterpreted) of exactly the criteria its
plan item references. Shared criteria (one criterionId, multiple items) keep ONE canonical
id — physically duplicated into each referencing node because the WorkflowVersion schema has
no version-level criterion store (documented shape; §19 satisfied: sharing preserved, ids
canonical). They survive planning-run completion, execution-run creation, restart and Pack
reload with zero mutable Plan lookup. NO criterion status/result rows exist at compile time.

## Validator authority (§20-§22)

`config.validatorIds` comes ONLY from the trusted profile (Pack authority) — the Plan never
chooses validators, the model never chooses validators. Nodes carry the frozen
T20-03B-compatible `config.taskProfile`, so later materialization reads pinned version
truth, not live defaults.

## Publication, content hash, provenance (§26-§30)

The graph goes through the REAL lifecycle (createTemplate → saveDraftGraph → publish —
including graph validation and the content hash over the full graph/config). No raw store
writes. The version content hash covers graph + task profiles + criteria + validator
requirements + compile provenance (all live in node config). `config.compiledFrom =
{planId, planFingerprint, planningRunId}` — immutable provenance answering "which Plan
produced this version" without embedding the whole Plan as a second truth (only
execution-required compiled data + provenance refs).

## Execution run + goal (§31-§39)

ONE Execution Run per compilation command via the EXISTING run-creation command ledger
(`commandId = compilationCommandId` — same command replays the same run and goal; different
content ⇒ CONFLICT). It pins EXACTLY the compiled version (never currentVersion after
creation, never repinned). Its goal is its OWN `companyos:run-goal` artifact created in its
own transaction with the SAME canonical semantics as the planning goal (byte-same objective
read from the planning run's canonical goal; no trim/rewrite/summary) and immutable
provenance `source: {type:'application', ref:'plan:<planId>'}` — provenance only, and the
Execution Run's own goal is its canonical goal (cross-run artifacts are never execution
evidence). Deterministic template discoverability: the compiled template name is
`plan-compile:<planId>:<compilationCommandId>` — the replay anchor that guarantees version
and run idempotency.

## Task materialization (§40-§44)

Every materializable compiled node (complete pinned taskProfile) gets ONE baseline normal
Task through the frozen generic `NormalTaskMaterializer` (deterministic
`tsk_<sha256(company:run:stage)>` identity — no localKey, no UNIQUE(run_id,stage_id)).
Task inputs stay EMPTY at compile time: the pinned WorkflowVersion is the execution
configuration authority and carries the criteria/plan-item config — no WorkflowVersion
duplicate, and no foreign Planning-Run plan artifact enters Task inputs as evidence
(`taskProfile`/`planItem`/`acceptanceCriteria`/`compiledFrom` all live in the pinned
version). Compilation stops after materialization: no provider invocation, no task start,
no Developer AgentExecution, no Reviewer, no QA, no Validation writes, no corrective loop.

## Idempotency and crash/restart convergence (§48-§55)

Same compilation command ⇒ same template (deterministic name) ⇒ same version ⇒ same run
(command ledger) ⇒ same tasks (deterministic identities): replay is total convergence with
zero duplicate versions/runs/goals/tasks. Frozen checkpoints (the full §49-§53 matrix):
`after_compiled_graph_before_workflow_publish` (A), `after_workflow_published_before_execution_run`
(B), `after_execution_run_durable_before_tasks` (C), `after_task_materialization_progress`
(D — the halfway point), `after_compilation_complete_before_return` (E). A: nothing durable
— retry recompiles identical semantics (profile drift CONFLICTS, never drifts). B: replay
reuses the canonical version (graph-hash matched against the same command's template) and
creates the one run. C: replay returns the same run+goal and materializes the tasks. D:
existing tasks REPLAY, missing tasks are created (T1 replay / T2-T4 create proven). E: zero
new durable objects; the canonical result returns. No global transaction — small durable
truths + idempotent replay, the CompanyOS recovery philosophy; at every checkpoint the
canonical/missing/safe-to-replay questions have deterministic answers (no
scan-newest-and-guess).

## Version duplication / plan / profile identity (§56-§58)

Same command replay never publishes a competing version (deterministic template name +
graph-hash match). Different plans salt different node ids AND different template names.
Same plan + different profile ⇒ different graph ⇒ `COMPILATION_COMMAND_CONFLICT` on the
same command (or a distinct template under a distinct command) — never silent reuse of
wrong execution semantics.

## Industry boundary and debt (§2/§24/§25/§67)

The compiler Core has no software vocabulary (source-asserted). The synthetic procurement
chain (supplier analysis → financial review → approval → recommendation) and a software
plan both compile end-to-end through the SAME compiler — proven against the real
composition with each profile's own roles/kinds/validators and zero Core modification.
`GENERIC_ROLE_ORCHESTRATION = OPEN` (documented, not hidden): the current legacy
work/review/qa Supervisor does not thereby gain arbitrary-Pack orchestration; T20-05 does
not claim it.

## Non-responsibilities (frozen)

No Task execution; no HandoffPacket/handoff version/acceptance/supersession (T20-06); no
Plan approval system (no Plan.status/approved flag/approval table/currentPlan/selectedPlan
pointer — the compiler receives an explicit trusted Plan reference; product-level
selection/approval authority remains separate); no latest-workflow authority (the run pins
exactly the compiled version); no second Workflow truth; no Task DAG; no new table; no
migration.


---

# Hardening addendum — heterogeneous per-item profiles + permanent identity

The two remaining architecture questions from the final T20-05 review are closed:
(A) heterogeneous plan-item execution profiles, (B) permanent Execution Run /
compilation identity. Everything below is implemented and proven by the §39 24-point
matrix in `tests/sprint20/t20-05-plan-compiler.test.ts`.

## Heterogeneous plan-item execution profiles

A single uniform `PlanCompilationProfile` is REPLACED by a trusted per-item
`PlanCompilationSpec { planItemProfiles: { [planItemId]: { stageKind, taskProfile,
validatorIds } } }`. Different plan items in ONE plan may carry different stage kinds,
roles, task kinds, attempt bounds and validator sets — e.g. the procurement chain
compiles supplier-analysis (analyst/2 attempts/1 validator), financial-review
(reviewer/4 attempts/2 validators), approval (approver/1 attempt/no validators) and
recommendation (analyst/3 attempts) into one WorkflowVersion with four nodes and four
tasks. No stage-type enumeration exists in Core; `taskKindAvailable` remains a probe,
never a selector.

## Trusted per-item compilation authority

Every profile field (stage kind, role, task kind, maxAttempts, validatorIds) is TRUSTED
configuration supplied per compilation command by the composition (Pack/workflow
concern). The Plan never carries or influences any of them; Core never interprets any of
them; no model call decides any of them.

## Exact plan-item / profile coverage

The join key is the exact canonical `planItemId` — never objective text, classification,
ordering or timestamps. Coverage is EXACT: a missing assignment
(`COMPILATION_PROFILE_MISSING`), an assignment to an unknown item
(`COMPILATION_PROFILE_UNKNOWN_ITEM`) and a malformed assignment (empty stage
kind/role/task kind; maxAttempts non-integer or outside 1..100 —
`COMPILATION_PROFILE_MALFORMED`) all FAIL CLOSED before anything durable exists. There
is NO implicit default, NO fallback profile, NO "the rest use X" in Core.

## Permanent compilation identity

Each compilation command is anchored BEFORE the WorkflowVersion exists by an immutable
planning-run-owned artifact (`kind = companyos:plan-compilation`, permanent command
`plan-compile:<companyId>:<compilationCommandId>`) whose content is the canonical
compilation input — schema `companyos/plan-compilation-input/1`, the compiler contract
`companyos/plan-compiler/1`, companyId, planningRunId, planId, planFingerprint and the
full per-item profile assignment — so its contentHash IS the compilation-input
fingerprint. Re-using the command with a different Plan or a different per-item spec
replays the anchor and CONFLICTS (`COMPILATION_COMMAND_CONFLICT`); re-using it with the
same inputs replays. The anchor is created through the same frozen ArtifactService
primitive (Option-B permanent idempotency) — no new table, no new store.

## Bounded command ledger ≠ permanent identity

The T18-02 command ledger is a SHORT-WINDOW duplicate guard with a `trim(limit)`
eviction; it is never identity. Permanent identity lives in durable rows: the
compilation anchor (above) for compilation inputs, and the run row itself for execution
runs. Full ledger loss is proven harmless: with the ledger emptied the same command
replays to the same version/run/tasks (`M12`), and after a real restart it returns the
SAME Execution Run R (`M13`) — including the crash-C-then-ledger-loss combination
(`M20`).

## Permanent Execution Run identity

Execution Run identity is derived from immutable semantic inputs —
`workflowId = wf_exec_<sha256("companyos/execution-run/1:" + companyId + ":" +
planningRunId + ":" + planId + ":" + compilationCommandId)[0:26]>` — and stored as the
run row's own durable `workflow_id` (a free TEXT column that IS an immutable creation
semantic of the row). A minimal run-specific guarded creation seam (`runs
.findByWorkflowId`) looks the permanent identity up BEFORE `createRun`: found + same
pinned version + same goal semantics ⇒ replay (skip creation, converge tasks); found +
different version ⇒ `EXECUTION_RUN_VERSION_CONFLICT`; found + different goal ⇒
`EXECUTION_RUN_GOAL_CONFLICT`; not found ⇒ `createRun` with the permanent workflowId
(the DB PK arbitrates true concurrency; the ledger row remains only as a short-window
duplicate guard). Mutable run lifecycle state never participates in the identity
comparison.

## WorkflowVersion as the permanent compilation anchor

The published WorkflowVersion stays the anchor of WHAT runs: deterministic template
name `plan-compile:<planId>:<compilationCommandId>`, deterministic node ids
`stg_<sha256("companyos/plan-stage/1:" + planId + ":" + planItemId)[0:16]>`, exact DAG
preservation, and the version replay conflict (graph-hash mismatch ⇒
`COMPILATION_COMMAND_CONFLICT`) remain. Template names carry no unique DB constraint;
uniqueness is enforced by discovery + hash comparison, and the same command can never
publish a competing version — including after crash A with different compilation inputs
(the durable anchor fails that case first). Unrelated later versions of other templates
are irrelevant to identity.

---

# Final permanent-identity corrective — Run identity vs Workflow identity

The final review closed the last two identity questions. Everything below is proven by
the §36 matrix (25 points) in `tests/sprint20/t20-05-plan-compiler.test.ts`.

## Run Identity vs Workflow Identity

Source-established canonical semantics: `Run.id` = run identity; `Run.workflowId` =
the identity of the Workflow lineage whose version the Run executes (typed
`WorkflowId`, projected to agents as `workflow: { id: run.workflowId }` by the T19-04
bounded contexts); `Run.versionId` = the pinned WorkflowVersion; `RunSnapshot` carries
templateId + workflowVersionId and is verified by the ONE `RunSnapshotVerifier`.
The previous revision derived an execution idempotency key into `workflow_id` — a
semantic field overload and a real architecture defect. It is REMOVED: compiled runs
now carry `workflowId = <compiled template id>` (the actual lineage identity).

## Permanent Execution Run Identity

`Run.id = run_<sha256("companyos/execution-run/1:" + companyId + ":" + planningRunId +
":" + planId + ":" + compilationCommandId)[0:26]>` — a deterministic identity from
immutable semantic inputs, using the repo-native `run_` prefix/hash convention. The
trusted `createRun` API accepts an optional `runId`; the durable run store gains a
guarded creation seam (`putGuarded`) whose PLAIN insert is arbitrated by the row
PRIMARY KEY. Same id + same immutable creation seed (companyId/workflowId/templateId/
versionId) → REPLAY of the canonical row (mutable lifecycle state — state/revision/
rework/history — is never reset); same id + drifted seed → `RUN_IDENTITY_SEED_CONFLICT`
fail closed.

## Database Arbitration

The final safety is NEVER find-then-create: the guarded insert itself is a plain
`INSERT` whose same-id conflict is decided by the runs PRIMARY KEY, with a re-read
deciding replay vs conflict (the tasks `putGuarded` pattern). Concurrent duplicate
inserts at the store seam converge to one canonical row plus one replay; the
unit-of-work serializes transactions FIFO on the single connection, and the
in-transaction deterministic-id replay check makes every between-transaction
interleaving converge. Two processes against one WAL file are arbitrated by the same
PRIMARY KEY.

## Workflow Compilation Permanent Identity

The compiled Workflow LINEAGE has a deterministic `WorkflowTemplate.id`:
`tpl_<sha256("companyos/compiled-workflow/1:" + companyId + ":" + planId + ":" +
compilationCommandId)[0:26]>`, created through the trusted `createTemplate` API
(optional `templateId`) and the template store's guarded plain insert (seed =
orgId/name). The permanent `companyos:plan-compilation` anchor artifact remains the
semantic compilation identity (its contentHash binds plan + per-item spec), and the
lineage id is derived from the same semantic inputs — no mutable pointer in either
direction, no second workflow system, no schema change.

## Template Name Is Not Authority

`workflow_templates.name` has no UNIQUE constraint and is display-only. The compiler
resolves the lineage BY DETERMINISTIC ID (`templates.get`), never by a name scan; a
decoy template row with the same display name cannot affect replay (proven
adversarially). The deterministic template name remains the human-facing label.

## Concurrent Compilation Semantics

Two same-command compilations (Promise.all against the serialized unit-of-work)
produce exactly: 1 anchor (UNIQUE(creation_command_id) recovers the loser), 1
canonical template lineage (guarded PK insert), 1 released WorkflowVersion (the
shared draft row is updated in place by `saveDraftGraph`; the loser of
`publish` re-resolves by content and replays), 1 execution run (guarded run PK), 1
run-owned goal, N tasks. Never two lineages, never two equivalent published versions.

## Exact Version Replay

The compiled version is resolved by IMMUTABLE CONTENT match inside the lineage (a
released version whose canonical graph equals the compiled graph) — never by
`template.currentVersionId`. A later unrelated V2 on the same lineage cannot hijack a
replay: the command still returns the version bound to its own compilation inputs,
and the run pin never moves. Crash-A replay reuses the anchor inputs; crash-B replay
resolves the exact previously published version; crashes C-E converge to the same
Run.id with correct workflowId/versionId/goal/tasks.

## Bounded Ledger vs Durable Identity

The T18-02 command ledger remains a short-window duplicate guard only. Permanent
identity lives in durable rows: the anchor artifact (compilation inputs), the
deterministic template id (lineage), the deterministic Run.id (execution run).
Ledger-loss and ledger-loss-plus-restart replays return the same Run row, goal and
tasks.
