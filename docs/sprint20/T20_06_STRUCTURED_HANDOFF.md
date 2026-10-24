# T20-06 — Structured Handoff + Generic Work Package Projection

Baseline `c471b34` (T20-05 FULLY CLOSED / FROZEN). Mission: give every legitimate execution
Task a deterministic, bounded, auditable **Work Package** derived from canonical CompanyOS
truth, while the existing Sprint-11 **HandoffService** remains the ONE owner of durable
human/organizational handoff. No second handoff system, no Supervisor redesign, no Task
execution.

## Work Package vs HandoffPacket (the frozen split)

- **Work Package = derived execution projection** (`WorkPackageProjector`,
  `packages/engine/src/projection/work-package-projector.ts`). It is NOT new truth, NOT a
  table, NOT an Artifact type, NOT a lifecycle, NOT handoff history. Same durable state ⇒
  same semantic package (restart-proven); nothing about it is persisted.
- **HandoffPacket = durable explicit handoff record**, owned by the Sprint-11
  HandoffService (DRAFT→READY→ACCEPTED/REJECTED, versioned supersession, authority
  checks, redacted audit events). The projector only READS accepted packets through a
  new read-only scoped query on the EXISTING store (`listForScope`).

Boundary: autonomous Task-to-Task progression → Work Package projection (ZERO HandoffPacket
rows are created by workflow advance — proven); explicit human/organizational responsibility
transfer → durable HandoffPacket through the existing service.

## Existing HandoffService ownership (source-audited)

`core/domain/handoff.ts` + `engine/handoff/handoff-service.ts` +
`persistence sqlite-handoff-store` (PK `(handoff_id, version)`, append-only versions).
It owns: structured work-transfer packets with bounded summaries plus explicit
artifact/decision/validation/execution REFERENCES (never context copies), authority-checked
lifecycle (`handoff.create|read|accept|reject`), redacted audit events, and the ONE
ACCEPTED-only agent-context projection (`handoffContextViewIfAccepted` /
`previousHandoffTextOf`). T20-06 changes exactly one thing: the store/port gains the
read-only `listForScope({companyId, workflowRunId, taskId})` (latest version per
handoffId, deterministic handoffId ordering — never a timestamp). Identity audit (§61):
the same `(handoffId, version)` creation replay fails `ALREADY_EXISTS` at the PRIMARY KEY
— no duplicate rows, no second identity system needed; handoff ids remain caller-supplied
(the service contract), which is preserved as-is.

## Canonical Work Package sources

`project({companyId, runId, taskId})` — nothing else is caller-suppliable:

- **Goal** — the Execution-Run-owned `companyos:run-goal` (the run-goal service reader).
  The Planning Run's goal/artifacts are NEVER imported (plan source ref is provenance
  only).
- **WorkflowVersion** — Run → RunSnapshot → the EXACT pinned version → the EXACT stage
  node. Never `template.currentVersion`, never a latest version, never a Pack default.
- **Objective** — the compiled PlanItem objective frozen in the pinned node config,
  byte-exact; never summarized, rewritten or model-reinterpreted.
- **Acceptance Criteria** — the frozen node criteria `{criterionId, requirement}` with
  no runtime status (projection never infers PASS/FAIL).
- **Validator refs / task profile** — the pinned `validatorIds` (informational; authority
  stays with the trusted registry/runtime) and the pinned `taskProfile`
  (roleId/taskKind/maxAttempts), which must MATCH the task row or projection fails closed
  (`WORK_PACKAGE_TASK_PROFILE_MISMATCH`).
- **Task inputs** — the canonical immutable `Task.inputs` (corrective lineage included
  as-is; bounded at 16 KiB).

## Dependency authority

Dependencies come ONLY from the pinned WorkflowVersion DAG: the direct predecessors of
the task's stage (`edges.to === stageId`), deterministically ordered, never inferred from
creation time, task ids, timestamps, role order, array order or text similarity.

## Upstream output authority (source-established)

There is NO (run, stage)-addressed output carrier in the architecture. The canonical
per-task carrier is the `companyos/stage-output/1` envelope under
`Task.outputs['stageOutput']`, written atomically with the task's DONE transition; the
canonical SUBJECT of a stage is selected by the repository's deterministic rule — a
corrective child (lineage parent inside the stage's task set) always wins over its
ancestor, ties broken by corrective round, then recency, then id (the same tie-breaks the
T19-04 work-subject selection and the evidence layer use), scoped to one stage and
kind-neutral. No timestamp winner exists anywhere in the projection: round beats
recency, and recency itself is only a deterministic tie-break of durable state.

## Corrective output selection

A corrective T1/T2 on the same stage becomes the canonical subject once DONE; downstream
packages then reference T1's envelope refs, never blindly T0. A "corrective" row whose
parentTaskId points outside the stage set is not a child and never wins. Validation
gates the RUN (ADR-0020 evidence gate, VALIDATING→FINALIZING), not the DAG edge — the
repository rule, respected and documented rather than re-invented.

## Dependency readiness (fail closed)

For each direct predecessor stage: the stage must have tasks, ALL of them terminal, and
at least one DONE; the canonical subject must resolve. Any miss ⇒
`WORK_PACKAGE_DEPENDENCY_NOT_READY` (projection never advances/starts anything).

## Accepted Handoff projection

`listForScope(company+run+task)` latest-version packets → the domain's OWN
`handoffContextViewIfAccepted` filter. Pending/Rejected never become context; a
superseded version stops being active the moment its successor version exists (latest
version per handoffId); the accepted successor projects. Scope is exact — packets of
other tasks/runs/companies never leak. No "latest handoff by timestamp" anywhere.

## Boundedness and the secret boundary

Bounds: direct predecessors ≤ 16, result refs ≤ 16 per predecessor, accepted handoffs
≤ 4, task inputs ≤ 16 KiB; criteria/objective already carry T20-02 bounds. No database
dump. Projection performs NO truncation of semantic truth to fit a model — the canonical
bounded package is the output; any later context-budget policy is the renderer's concern,
and a package that cannot be fully consumed is a pre-provider failure, never silent
deletion. Secrets: the projection copies only canonical structured references and
already-safety-checked handoff views; it introduces no secret surface of its own.

## Restart determinism and industry neutrality

Same durable state ⇒ same semantic package (real restart proven, including accepted
handoff context and corrected predecessor selection; `observational.taskState` is the
only non-semantic field and is durable truth, clearly labeled). The projector contains
zero industry vocabulary — it projects whatever the pinned WorkflowVersion says; the
heterogeneous procurement chain, a uniform software workflow and a brand-new logistics
Pack role all project through the SAME code with zero projector changes (proven).
Role-specific category filtering, when it arrives, must be generic configuration-driven
behavior, never a Core branch.

## Explicit non-responsibilities

No Task execution (no start/attempts/state change, no provider call, no AgentExecution,
no workspace claim); no Decision/Review/Validation/Session writes; no HandoffPacket
writes (autonomous edges create zero); no Work-Package status machine (PENDING/ACCEPTED/
DONE/SUPERSEDED/FAILED belong to Task/HandoffPacket/Validation/Run); no durable
WorkPackage row or id (it is a projection of Task identity + canonical truth); no IPC/UI
exposure in T20-06 (no `workPackage.*` channel added; the Product Control Plane comes
later); no approval invention (handoff acceptance is never Plan/Task/Validation
approval); no GENERIC_ROLE_ORCHESTRATION change (remains OPEN; the current legacy
Supervisor loop is untouched, and the projector is suitable for a future generic
orchestrator); no Planner/T20-02 contract change.

## Architecture statement (§71)

**CompanyOS does not pass work between agents by copying conversation transcripts.**
Work moves through canonical durable business state — Runs, Tasks, pinned
WorkflowVersions, stage-output carriers, review/validation evidence, accepted
HandoffPackets — plus a deterministic Work Package projection. Conversation/session
context is not the workflow truth.

## Gate board

STRUCTURED_WORK_PACKAGE = CLOSED · WORK_PACKAGE_CANONICAL_PROJECTION = CLOSED ·
WORK_PACKAGE_DEPENDENCY_AUTHORITY = CLOSED · WORK_PACKAGE_OUTPUT_AUTHORITY = CLOSED ·
WORK_PACKAGE_RESTART_DETERMINISM = CLOSED · HANDOFF_EXISTING_OWNER_REUSED = CLOSED ·
HANDOFF_DUPLICATE_SYSTEM = ABSENT · HANDOFF_PROJECTION = CLOSED ·
CROSS_RUN_CONTEXT_ISOLATION = CLOSED · GENERIC_ROLE_ORCHESTRATION = OPEN ·
PRODUCT_CONTROL_PLANE = OPEN
