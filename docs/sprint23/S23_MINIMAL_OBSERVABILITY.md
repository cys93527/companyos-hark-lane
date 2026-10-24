# S23 — Minimal Observability (FROZEN)

Baseline `afa59be` (Sprint 22 frozen). Mission: the minimum trustworthy
read/inspection layer that answers WHAT is happening, WHY, what canonical
objects prove it, what is blocked/executing, what was corrected, which result
is canonical, and what survives a restart — **without becoming a second source
of truth**. Companion recon: `S23_OBSERVABILITY_RECON.md`.

## Canonical truth boundary (hard)

Observability may READ, PROJECT, AGGREGATE, EXPLAIN, PAGE and STREAM REFRESH
SIGNALS AFTER COMMIT. It may never write Run/Task state, settle attempts,
create or resolve findings, pass validation, create decisions, provision
corrective work, choose tasks/executors or write Handoff. **Zero new durable
observation tables; zero new event stores** (proven by contract tests #17/#18
and the Sprint22 ARCH-006 inventory guard). A failed observation is a typed
error (`PINNED_VERSION_MISSING`, `OBSERVATION_NOT_FOUND`) that mutates nothing.

## DeepSeek Harness reference mapping (SELECTIVE ADAPTATION)

| Reference mechanism | CompanyOS translation | Decision |
|---|---|---|
| durable Session log vs derived projections | CompanyOS durable truth (Goal/Plan/WorkflowVersion/Run/Task/ExecutionAttempt/Decision/Artifact/Evidence/Validation/Finding/Handoff) stays canonical; `RunObservationService` projections only read it | ADAPTED |
| restart reconstruction from persisted facts | close DB → reopen SQLite → identical projection (contract test) | ADAPTED |
| live events distinct from durable state | `RunObservationNotifier` = "state changed; re-read" only; lost signals recovered by refresh | ADAPTED |
| event map | the observability source/event map below | ADAPTED |
| typed projection seam | `RunOverview` / `TaskObservation` / `RunBlocker` / `TimelineEntry` contracts | ADAPTED |
| runtime inspector | read-only service; inspector surfaces query it; never advance/settle/create | ADAPTED |
| capability graph presentation | current execution relationships documented below (Task→registry→implementation) | ADAPTED (documentation only) |
| Cordis as Core / Session as truth / Agent Teams DAG / second queue/scheduler/state machine | **REJECTED** (see REFERENCE_CAPABILITY_MAP) | REJECTED |

## The read model

`packages/engine/src/observability/run-observation-service.ts` —
`createRunObservationService(deps)` with `getRunOverview`, `getTaskObservation`,
`getRunBlockers`, `getRunTimeline`; `createRunObservationNotifier()` for the
non-authoritative signal. Wired read-only into the desktop composition
(`core.runObservation`), reusing ONLY existing canonical seams: runs/tasks/
executionAttempts/templates/validationStore/artifactStore/events, the T18-04
review-findings sink (all pinned tasks are finding anchors, Sprint21 final),
the supervisor decision sink (D1 consumption via the exported
`reviewVerdictConsumedBy`/`supervisorDecisionEvidenceOf`), a read-only SQL view
over `agent_executions` (provenance only — ARCH-013), and the Sprint11 handoff
store.

### RunOverview

runId/companyId/workflowId/**exact versionId**/state/revision/rework counters/
failure/pause reason; pinned WorkflowVersion identity (templateId+versionId+
node/edge counts); goal/plan refs; per-stage projection (task counts,
terminal-successful, canonical subject + output via `stageSubjectTaskOf` +
`Task.outputs['stageOutput']`); task counts by canonical state; currently
executing tasks with their live attempt; attempt census
(active/interrupted/completed/failed); blockers; unresolved actionable
findings; validation summary (required validatorIds from the pinned nodes vs
completed rows vs missing); corrective/reassessment lineage activity; artifact
references (ids/kinds only); handoff count; **discrete progress**
(stages/tasks counters — never an invented percentage).

### TaskObservation

Task lifecycle (state/attempts) DISTINCT from ExecutionAttempt lifecycle
(attemptNumber/state/runtime owner/settlement) DISTINCT from AgentExecution
provenance (modelKey/provider — a separate array, never merged). Corrective
lineage + reassessment marker; stage output envelope; per-task blockers
(EXECUTION_FAILURE, CAUSAL_CORRECTIVE_WAIT); and the honest uncertainty block
(§crash windows).

### RunBlocker (derived, never durable truth)

`{code, scope, subjectId?, sourceType, sourceId?, evidenceRefs[], explanation}`
— codes: RUN_PAUSED, RUN_FAILED, APPROVAL_REQUIRED, UNRESOLVED_FINDING,
VALIDATION_FAILED, VALIDATION_REQUIREMENTS_MISSING, ROUND_LIMIT_EXHAUSTED,
EXECUTION_FAILURE, CAUSAL_CORRECTIVE_WAIT, UNRECONCILED_CARRIER. Every entry
cites its canonical source (run row, report artifact, validation row, task row,
pinned version). The full matrix is proven in
`s23-blocker-projection.test.ts`.

### Timeline

The smallest useful timeline MERGED from existing durable facts: run.history
transitions, task creations, corrective/reassessment creations, attempt
claim/settlement, finding reports, decisions, validations, artifacts, and the
existing `events` feed (with its global position as sequence). Deterministic
order: canonical timestamp (display metadata only) → event sequence → kind →
key; opaque `base64url` cursor carrying the FULL sort tuple plus the run id;
bounded limit (default 50, max 200); duplicate keys made globally unique by
per-source ordinals. **The cursor is RUN-SCOPED**: a cursor produced for another
run is a typed `OBSERVATION_CURSOR_SCOPE_MISMATCH` error, never a silent
cross-run page. **No new event store.**

## D1 representation

Subject-scoped proposal/cause projection and ALL-UNRESOLVED-ANCHORS global
blocking stay visible: per-anchor findings (resolved/unresolved individually),
an unresolved anchor blocks regardless of a newer clean anchor, and resolution
is decided ONLY by decision-history consumption — never recency.

## Crash-window representation (at-least-once honesty)

- **A** claim durable / executor not called → Task RUNNING, attempt ACTIVE,
  `uncertainty.externalInvocationProven = false`, replay possible.
- **B** executor returned / settlement absent → Task not DONE, attempt not
  COMPLETED, `canonicalSettlementAbsent = true`, provenance visible but never
  claiming settlement; the note says "NOT exactly-once".
- **C** settled / carrier unreconciled → settlement visible + an
  UNRECONCILED_CARRIER blocker (a review-findings candidate whose canonical
  report is not yet durable); ordinary work outputs are never flagged (their
  carrier is skipped by design). The blocker clears exactly when the carrier
  reconciles.

## Restart reconstruction (FROZEN DEFINITION)

**Restart Reconstruction = deterministic reconstruction from durable canonical
facts under frozen recovery semantics.** It does NOT require an invalid/dead
runtime's ACTIVE state to remain ACTIVE after restart: where canonical
recovery requires ACTIVE(dead runtime) → INTERRUPTED, the post-restart
observation MUST expose INTERRUPTED while preserving the SAME durable attempt
identity, the SAME attempt number and the SAME Task.attempts count. The
pre-restart observation of a LIVE process and the post-restart observation of
a recovered process are equal **modulo exactly the frozen recovery
transitions** — nothing else may differ. In practice: closing the database and
reopening the same SQLite files rebuilds the identical projection except that
one canonical transition (the Sprint21 startup orphan conversion
`interruptActiveOfRuntime`) moves the dead runtime's ACTIVE attempt to
INTERRUPTED, without allocating a new attempt, without a new Task START, and
without incrementing Task.attempts. No renderer memory, no live-event memory,
no process-local cache (proven by rebuilding through a second service instance
and by the restart suite).

## Live notification semantics

`RunObservationNotifier.subscribe(runId, listener)` / `notify(runId)` —
process-local, fired only AFTER canonical commit, carrying no truth. A lost
notification is recovered by re-reading the projection (contract test #15).
Nothing in the workflow may depend on a subscriber receiving it.

## Source/event map (per observable transition)

| Transition | Canonical owner | Producer | Persistence | Observation projection | Live consumer (optional) |
|---|---|---|---|---|---|
| Run state change | WorkflowRun (frozen machine) | engine dispatch | `runs.history_json` + `events`(subset) | timeline `run.transition` | notifier |
| Task created | Task | materializer/provisioner | `tasks` | timeline `task.created` | notifier |
| Task lifecycle step | Task | engine claim path | `tasks` + `events`(task.state_changed) | TaskObservation + timeline | notifier |
| Attempt claim/settle | ExecutionAttempt | engine claim/settle tx | `execution_attempts` | TaskObservation + timeline | notifier |
| Finding reported | review-findings sink | T18-04 sink | `artifacts` (companyos:review-findings) | FindingObservation + timeline | notifier |
| Decision recorded | decision sink | T18-06 sink | `decisions` | timeline `decision.recorded` | notifier |
| Validation recorded | ValidationService | T17 service | `validations` | validation summary + timeline | notifier |
| Corrective/reassessment provisioned | provisioner | T18-05/S21 provisioner | `tasks` (lineage inputs) | correctiveActivity + timeline | notifier |
| Artifact created | ArtifactService | artifact service | `artifacts` + CAS | artifact refs + timeline | notifier |
| Handoff | HandoffService (Sprint11) | handoff service | `handoffs` | handoffCount | notifier |
| Agent round | AgentExecution | executors | `agent_executions` | provenance array | — |

## Capability graph (current execution relationships, documentation only)

Task → pinned taskKind/role requirement (`WorkflowVersion` node
`taskProfile`) → executor registry (deployment `stageHandlers.*Kinds`) →
implementation handler. ValidatorId → pinned node `validatorIds` → trusted
validator registry → implementation. Both are DATA relationships; no runtime
redesign happened in Sprint23.

## Known limitations (history gap rule)

- Run transitions before the `events` feed existed are projected from
  `run.history` only; when the feed is empty but history exists, the timeline
  reports `HISTORY_NOT_RECONSTRUCTABLE` as its limitation instead of inventing
  events.
- Agent-provenance rows carry no executor-implementation reference beyond the
  model binding; implementation identity is registry data, not run data.
- The overview is not yet indexed for very large runs (bounded by task/artifact
  counts; timings recorded in the restart suite).

## Future Product Control Plane boundary

This sprint deliberately builds NO UI, no dashboard, no control plane. The
observation service is the read foundation those layers consume later
(Paperclip-informed presentation concepts stay DEFER — see
`docs/references/REFERENCE_CAPABILITY_MAP.md`).

## Tests

`tests/sprint23/s23-observation-contract.test.ts` (15 — Boss §46 contract
points 1-18), `s23-crash-window-observation.test.ts` (3 — windows A/B/C),
`s23-blocker-projection.test.ts` (8 — blocker matrix + D1),
`s23-restart-reconstruction.test.ts` (3 — restart, live-loss recovery,
performance timings). 29 tests total; all read through the production
composition over canonical SQLite.
