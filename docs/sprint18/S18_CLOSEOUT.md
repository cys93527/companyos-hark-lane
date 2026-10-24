# Sprint 18 — Final Closeout & Freeze (T18-09)

Status: CLOSED. This is the authoritative final record: the final gap board, the frozen
architecture audit, the frozen contracts, the post-Sprint18 handoff list, and the freeze
inputs recorded for Session Runtime / Planning / Structured Handoff. Historical sections in
the other Sprint18 documents describe the state AT THEIR TIME and are snapshots — where they
say a gap is OPEN that is now CLOSED, this document supersedes them.

## 1. Task status (all CLOSED)

| Task | Commit(s) | Status |
|---|---|---|
| T18-01 architecture freeze | `bcb8a0e` | CLOSED |
| T18-02 Goal / Snapshot verification / model pinning | `8331c86` | CLOSED |
| T18-03 Decision Sink (+ corrective) | `9d2705a`, `6227e1b` | CLOSED |
| T18-04 Review Findings (+ corrective) | `0789d1c`, `687957b` | CLOSED |
| T18-05 Corrective provisioning / lineage | `1bdb88c` | CLOSED |
| T18-06 Supervisor Decision Runtime (+ corrective) | `18de001`, `ebdc514` | CLOSED |
| T18-07 Autonomous Loop (+ 3 correctives + audits) | `5e4cfca`, `6cfbfcc`, `4e30540`, `8bcb5f3`, `743d24b` | CLOSED |
| T18-08 Crash / Recovery proof | `d59e2e7`, `9083527` | CLOSED |

## 2. Final gap board

CLOSED (autonomous core, all proven by enabled tests):

```
CORRECTIVE_TASK_PERSISTENCE_GAP            REVIEW_FINDING_DURABILITY_GAP
SUPERVISOR_PINNED_MODEL_CONSUMER           GENERIC_AGENT_PINNED_MODEL_CONSUMER
MODEL_BINDING_EXECUTION_CONSUMER_GAP       HANDLER_OUTPUT_CARRIER_GAP
HANDLER_OUTPUT_ATOMICITY_GAP               EVIDENCE_TO_RUN_LIFECYCLE_GAP
PROVIDER_ABORT_CONTRACT_GAP                PROVIDER_RUNTIME_REBIND_GAP
DECISION_APPLICATION_DURABILITY_GAP        PRODUCTION_TURN_TWO_DEFECT
PRODUCTION_VALIDATION_MATERIALIZATION_AUTHORITY_GAP
HUMAN_ESCALATION_STATE_GAP                 REWORK_HUMAN_ESCALATION_STATE_CONTRACT_GAP
ARTIFACT_PROVENANCE_SPOOF_GAP
```

Permitted OPEN (product scope, not autonomous core):

```
HUMAN_GOAL_PRODUCT_INGRESS_GAP   — no production IPC/UI submits a human goal yet
```

Notes on two entries that earlier documents recorded as OPEN/PARTIAL at their time:
`GENERIC_AGENT_PINNED_MODEL_CONSUMER` is CLOSED since T18-07 — the ONLY autonomous
model-execution path is `createPinnedAgentExecution`, whose method surface exposes no model
identity at all (T18-07 §8 ruling); the generic `AgentRuntime.prepare` seam itself is
unchanged by design (non-autonomous callers keep their explicit binding). Consequently
`MODEL_BINDING_EXECUTION_CONSUMER_GAP` is CLOSED for the autonomous chain. The T18-06-era
section 13 list in `S18_AUTONOMOUS_SUPERVISOR_CONTRACT.md` and the T18-04-era notes in
ADR-0029 are historical snapshots to that effect.

## 3. Frozen architecture audit

No second truth was introduced. Canonical authorities remain exactly: WorkflowEngine (run
lifecycle), the Task machine (`applyTaskEvent`), the Decision Sink (T18-03), ReviewFindingsSink
(T18-04), ValidationService, CorrectiveProvisioner (T18-05), ToolRegistry, Authority/Risk,
EvidenceGuard, Repository Runtime. The autonomous orchestrator (`autonomous-supervisor.ts`) is
an applicator over those services — it holds no store of its own beyond application receipts
(artifacts), no scheduler, no retry state machine, no permission system, and no provider
fallback.

## 4. Frozen supervisor boundary

The Supervisor is a generic orchestration runtime, not a role: no `if role === …`, no pack
nouns, no `if packId === …`, no `if stageName === …` in the kernel. The supervisor model
invocation is structurally tool-less (`// No tools, no toolIds`), has no subagent/spawn
capability, cannot bypass ToolRegistry, and a Decision is a record — never direct execution
authority.

## 5. Frozen bounds

`MAX_SUPERVISOR_TURNS = 20`, `MAX_CORRECTIVE_ROUNDS = 3`. The corrective cap is enforced at
the provisioner boundary (`round > maxRounds`, derived from durable lineage, checked before
any Task row is created), so a DIRECT provisioner call cannot bypass it either.

## 6. Frozen cancellation / recovery semantics

`FAILED + error_kind=CANCELLED + error_code=CANCELLED` is terminal and non-retryable; the
autonomous loop stops `cancelled` with zero further turns. Cancellation propagates to the real
provider adapter contract (`InvocationRequest.signal`; a cancelled invocation returns
`err(DomainError('CANCELLED', …, { kind: 'CANCELLED' }))` and the registry never re-classifies
it). Uncertain external side effects are never blindly retried (Sprint 14 ruling); the
repository baseline is capture-or-replay over the durable invocation.

## 7. Frozen human stop semantics

`WAITING_APPROVAL` = the approval-based human gate (`APPROVAL_REQUIRED`, resumed by the
trusted `resumeEscalatedRun` under separation of duties). `PAUSED` = the durable
human-required / manual-resume stop, including corrective exhaustion (`REWORK.EXHAUST`).
Startup never auto-resumes: nothing at startup drives runs at all, and the autonomous loop
stops on PAUSED at turn 0 with ZERO model calls (`human_required`); `RESUME` is by explicit
trusted command only, exactly once.

## 8. Frozen validation authority / provenance

Authorization principal ≠ provenance producer. The validator report's provenance is
`validator:<id>@<version>` and never becomes session authority; there is no `validator:*`
global authorization, no kind-specific bypass in generic ArtifactService, and the spoof audit
proved a caller-supplied validator `producedBy` creates an artifact but never canonical
validation evidence.

## 9. Frozen provider restart contract

Descriptor = durable configuration identity; adapter = process-local executable capability.
Restart may verify an existing descriptor and re-bind a MATCHING adapter (idempotent,
`enabled` preserved); an incompatible descriptor (kind / displayName / catalogue) fails closed
with the mismatch named — never silently replaced, no fallback.

## 10. Crash / fault proof (T18-08 evidence)

Three real abrupt process-crash tests (child SIGKILLs itself; marker on fd 2), the full chaos
path (a crash at every phase still reaches COMPLETED), the corrective chaos path (T1 lineage
unchanged), and the human-stop chaos path (PAUSED survives restart, zero model calls, exactly
one resume). Repeated fault suite: 10/10 consecutive passes, zero flake. Fault injection is
not a Tool, not user/model reachable, and absent by default in production.

## 11. Post-Sprint18 handoff (recorded, NOT implemented)

Next-phase candidates, in dependency order:

1. Session / Context Isolation — constraints in §12 below.
2. Planning / Task Decomposition — constraints in §13 below.
3. Structured Handoff / Work Package — constraints in §14 below.
4. Architecture Guard (automated boundary-law enforcement beyond the current lint gate).
5. Minimal Observability (structured, bounded; no platform).
6. Real Production Provider / Executor integration — REQUIRED BEFORE any user-facing
   operation: the current product composition ships only fake/mock providers; no real
   third-party adapter exists yet.
7. Human Goal / Product Control Plane (closes `HUMAN_GOAL_PRODUCT_INGRESS_GAP`).
8. V1 Final Gap Audit.

Classified POST-V1 unless a later audit proves V1 blocker: Long-term Memory; Parallel Agents;
Remote Agents; Cloud Runtime; OS-level Sandbox expansion; dynamic model fallback/routing;
plugin ecosystem; FDE commercial features.

## 12. Session Runtime freeze input

Session is a context container, NOT truth. Run / Task / Decision / Artifact / Review /
Validation remain authoritative. Supervisor / Developer / Reviewer / QA must support isolated
contexts. Session may support: resume, token budget, context handoff, bounded compaction.

## 13. Planning freeze input

The user supplies Goal / constraints. Planning generates plan, tasks, dependencies and
acceptance criteria — but Planning does NOT become a second Workflow Engine: materialized work
must enter the existing Run / Task / Decision / Engine surfaces.

## 14. Structured Handoff freeze input

Handoff / Work Package = a projection of authoritative state, never a second source of truth.
It must eventually contain bounded: goal, task, scope, constraints, dependencies, decisions,
artifacts, acceptance criteria, required evidence.

## 15. Evidence-bounded claims

Proven: the T18-08 matrix windows (docs/sprint18/crash-recovery-proof.md §2) and the three
real-process windows. NOT claimed: universal OS-crash safety; universal exactly-once external
side effects; OS sandbox isolation; network isolation; a complete production UI; complete
human product ingress. Production model operation today is mock/fake-provider only (handoff
item 6).
