# Sprint 23 — Observability Recon (no implementation yet)

Baseline `afa59be`. Audited before any production code (Boss §3). Companion
matrix: `S23_MINIMAL_OBSERVABILITY.md` §source-of-truth.

## What exists, per canonical object

| Object | Durable truth | Read APIs available today | Observability gap |
|---|---|---|---|
| Run | `runs` row (17-state machine, `revision`, `reworkCount/maxRework`, `failureReason`, `resumePoint`, `history` JSON = `RunStateChange[] {from,to,event,at}`) | `runs.get` (EntityStore) | no unified overview; `history` is authoritative but unreadable without projection |
| WorkflowVersion (pin) | `workflow_templates` + `workflow_template_versions` (graph nodes/edges, `taskProfile`, `validatorIds`) | `templates.get` → `versions.find(id === run.versionId)` | pinned-read pattern exists (ARCH-004) but no read-model exposes it |
| Task | `tasks` row (state, attempts/maxAttempts, inputs/outputs JSON, run ownership FK since T20-03A) | `tasks.get`, `tasks.listByRun` | counts-by-state / stage projection not exposed anywhere |
| ExecutionAttempt | `execution_attempts` (Sprint21: `exa_` id, state ACTIVE/INTERRUPTED/COMPLETED/FAILED, seed company/run/task/attemptNumber/roleId/taskKind, settled_at) | `listByTask`, `activeOfTask`, `byTaskAndAttempt` | never surfaced; `runtime_instance_id` ownership not readable |
| AgentExecution (model provenance) | `agent_executions` | store `get`/list | must stay SEPARATE from attempt visibility (ARCH-013) |
| Goal | `artifacts` row via `runGoalCommandId(runId)` creation command | `artifactStore.getByCreationCommand` | exists, readable |
| Plan | `companyos:plan` artifact + planner permanent command | artifact reads | exists |
| Decision | `decisions` table (supervisor decision sink: subject_key, version, envelope) | `decisionHistory.listRunDecisionHistory` (engine port; needs actor scoping) | the ONE cross-cutting history reader already in the engine |
| Receipts | `companyos:supervisor-application` artifacts (SUPERVISOR_APPLICATION_KIND) | `artifactStore.listByRun` filter | exists |
| Artifact | `artifacts` + CAS (`contentRef`, taskId, kind) | `listByRun`, `get` | refs only — never copy content (Boss §19) |
| Validation | `validations` rows (validatorId, status, stageId, targetRef) | `validationStore.listByRun` | no required-vs-completed projection |
| Finding/report | `companyos:review-findings` artifacts via the T18-04 sink | `reviewFindingsSink.listReviewHistory` (per review task, actor-scoped), `getLatestReviewReport` | unresolved/consumed projection lives only inside the supervisor turn (D1) — not exposed as a read model |
| Corrective lineage | Task inputs `corrective {round, parentTaskId, rootTaskId, originDecisionId, causeEvidenceRefs}` | task reads | lineage exists; no projection walks it |
| Reassessment lineage | Task inputs `companyos:reassessment {correctiveTaskId, ...}` (deterministic ids) | task reads | same |
| Handoff | `handoffs` (+`handoff_refs`) Sprint11 chain | `handoffs.listForScope` | exists, read-only reuse (ARCH-009) |
| Domain events | `events` table (`type`, `occurred_at`, `aggregate_id/type`, `run_id`, `payload`, global position) — appended by engine (task.state_changed, task.blocked, approval.*) and artifact service | `events.readByRun(runId)`, `readFrom(position, limit)` | a real append-only feed already exists — the timeline can be DERIVED, no new event store (Boss §21) |
| Ledger | `command_ledger` (idempotency; bounded) | store | NOT identity (ARCH-026) — timeline uses events/artifacts, not the ledger |
| Logs | nullLogger/console in composition | — | no runtime log truth; out of scope for the read model |
| Desktop read APIs | IPC `CHANNELS.workflow`, `databaseStatus`, `platformInfo` | `ipcMain.handle` | no run-inspection surface (Boss §32: none to build) |

## Key existing seams the observation service can reuse unchanged

- `pinnedGraphOf(runId)` pattern (templates.get + versions.find by `run.versionId`) — the ARCH-004-legal pin read.
- `stageSubjectTaskOf` (exported from work-package-projector) — the canonical stage result authority.
- `executionAttempts.listByTask/activeOfTask` — attempt visibility.
- `reviewFindingsSink.listReviewHistory` — per-anchor findings; D1 scoping rules live in supervisor-runtime (`anchorSubjectMatched`, `firstUnresolved`).
- `decisionHistory.listRunDecisionHistory` — decisions.
- `events.readByRun` — the timeline backbone with global positions for stable cursors.
- `run.history` (JSON) — canonical run state changes even without events.

## Hard constraints carried into design (Boss §5/§6/§10/§17/§22)

- READ/PROJECT/AGGREGATE/EXPLAIN only; STREAM AFTER COMMIT only.
- Zero new canonical tables; zero disposable cache tables in Sprint23 (prefer none).
- Every existing-Run projection reads `run.versionId`'s pinned version.
- Stage results via `stageSubjectTaskOf` + `Task.outputs['stageOutput']`.
- Unreconstructable history → report the gap, never invent.
- Failure policy: typed error, zero mutation.
- Ownership: company/run scoping on every read; cross-tenant/cross-run NOT_FOUND.
- Timeline: cursor paging (event global position), stable deterministic order.

## Conclusion

Everything needed for a truthful read model is already durable and read-addressable.
The gap is purely a projection layer: an engine-side read-only
`RunObservationService` over the existing stores + events, with the contract,
crash-window, blocker, restart and paging tests the Boss enumerates. No new
persistence, no live-event authority (a process-local "changed" emitter after
commit is optional and non-authoritative).
