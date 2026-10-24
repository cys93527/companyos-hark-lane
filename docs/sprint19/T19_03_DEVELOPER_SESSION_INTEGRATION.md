# T19-03 — Developer Session Runtime Integration

Status: implemented (Developer ONLY). Reviewer and QA keep their Sprint-18 isolated bounded
contexts; the Supervisor stays state-reconstructed per turn — no session exists for any of
them and nothing flows from a Developer Session into their inputs. No Planning, no
Structured Handoff. Baseline `1e2fcf9`.

## 1. The chain (exactly the Boss §0 target)

```
Task → trusted Developer role resolution → Developer Session
     → authoritative context projection + bounded Session residue
     → token budget gate → AgentExecution (pinned) → Provider invocation
     → bounded output residue → the EXISTING StageHandlerOutcome / Task output path
```

Recon answers (§2, from source): the Developer role is identified ONLY by the trusted
`stageHandlers.developerKinds` registration in `composeCoreServices` (capability semantics);
`roleId`/`agentId`/`bindingKey` come from the SAME registration object; `taskId` from the
engine's stage execution context; `runId`/`companyId` re-read from the durable run row; the
developer prompt is the `AgentContext` seats (objective + memoryView + artifactRefs) rendered
by `buildAgentContext`/`assemblePrompt`/`toMessages` into exactly two messages (system+user)
on `InvocationRequest`; the AgentExecution row is created by `pinnedAgentExecution`'s
`prepare`, settled by its `completeExecution`; `StageHandlerOutcome`/`Task.outputs`/`DONE`
remain the ENGINE's own writes. Repository baseline is available via the repository runtime
(anchor identity only, when a workspace is open); corrective lineage from `Task.inputs`; the
latest review from the T18-04 reader. Developer invocations carry NO tools (structurally).
Each AgentExecution performs exactly ONE provider invocation.

## 2. Role binding (DEVELOPER_SESSION_ROLE_BINDING_GAP = CLOSED)

No global mapping table exists or was invented. The trusted registration
(`{kinds, roleKey: 'rol.developer', agentId, bindingKey}`) is the ONE source: the Session's
`roleKey` and the AgentExecution's `roleId` are both taken from that same object at
composition time, so `Session.roleKey === AgentExecution.roleId` holds by construction. The
model cannot select it (no tool, no parameter); the caller cannot substitute it (the runtime
surface exposes no role parameter at all — asserted by test §46-4).

## 3. Session creation & identity

`sessionIdOf(companyId, runId, taskId, roleKey)` — deterministic, idempotent (T19-02 kernel).
Original task T0: `parentSessionId = null`. Corrective task T1 (proven by
`Task.inputs.corrective`): a NEW session whose `parentSessionId` is the T0 Developer
session, derived from the lineage's `parentTaskId` — and only if that T0 session actually
exists (null otherwise; no manufactured Supervisor parent, §6). T1 NEVER reuses T0's session
and inherits ZERO context automatically (§7/§8).

## 4. Context projection (authoritative vs residue — kept distinguishable)

Every authorized turn re-reads fresh (§12) and renders one `companyos/developer-context/1`
object containing: the Run Goal (canonical artifact reader), the current Task
identity/kind/state, the corrective lineage (parent/round) when present, the pinned binding
identity, the repository anchor identity (workspace id, only when a workspace is open —
reference only), and the latest canonical review verdict (run-wide newest, the same rule the
evidence applicator uses). Acceptance criteria are NOT canonically available in the current
WorkflowVersion/Task contracts — reported absent (`"correctiveLineage":null` /
`"latestReviewVerdict":null` style explicit nulls), never invented. Canonical refs ride the
entry refs (goal/task/parent-task/repository-anchor). The ACTIVE session residue rides the
bounded memory-view seat under an explicit `# Session residue` heading — the two categories
are distinguishable in the rendered input and in storage. Nothing copies whole business
records into the session (§12): the projection is rebuilt per turn and never stored; only
the bounded `model_output_residue` entries are stored.

## 5. Seed / residue / ordering (RESIDUE FIRST — closeout Shape B)

On first creation exactly one idempotent `context_seed` entry (command id `seed`,
deterministic; replay never duplicates). After each successful provider round a bounded
(`≤8192` chars) `model_output_residue` entry with command id `turn:<executionId>` is appended
— permanent, replay-safe. Ordering (closeout-audited, frozen):

provider result (execution still RUNNING — `runWithOutput` defers settlement) → **session
output residue durable** → AgentExecution terminal settlement (COMPLETED) →
StageHandlerOutcome returned → the engine's own Task.outputs/DONE writes.

The residue is durable BEFORE the execution may be marked COMPLETED (the closeout
`DEVELOPER_SESSION_EXECUTION_RESIDUE_DURABILITY` fix): a durably terminal-successful
execution can therefore never lack its durable residue — the forbidden state
(COMPLETED + residue missing + no other durable copy) is impossible by construction. If the
residue append fails, the wrapper CANCELS the execution (no fabricated success). The pinned
round surface is `runRoundResidueFirst(round, persistResidue)`; the legacy `runRound`
(settle-then-return) remains for the non-session paths.

## 6. Token budget (wired — before the provider)

The T19-02 gate runs on the COMPLETE rendered request (authoritative projection + eligible
residue + structured keys) with the context window resolved from the durable model catalog
via the run's pinned binding (trusted configuration only; a missing window fails closed with
`SESSION_TOKEN_WINDOW_UNKNOWN`; a catalog/binding refusal is equally fail-closed BEFORE any
provider call), reserved output 1 024 (the configuration actually sent), and the fixed 256
safety margin. Per-byte conservative estimate (corrective A). Over budget ⇒
`SESSION_TOKEN_BUDGET_EXCEEDED`, provider call count 0, no truncation, no auto-compaction.

## 7. Multi-turn & restart

"Multi-turn" = multiple separately authorized developer turns on the same Task/role
reconstruct and reuse the bounded durable residue (§23 — no inner loop, no scheduler). Turn
2 receives turn 1's eligible residue through the checkpoint-aware active projection. A fresh
composition over the same files restores the same session, the same refs, the residue — and
re-reads the canonical facts, so changed Task/Review truth WINS over old residue (§56).
Restart never invokes a provider to recreate durable output, and never duplicates the seed,
a residue entry, or an AgentExecution.

## 8. Crash ordering (deterministic fault seam, T18-08 infrastructure reused)

Three frozen checkpoint names in the existing vocabulary, covering every window of the
residue-first sequence:

- `after_session_before_provider` — crash after session creation, before the provider: no
  execution, no residue; restart appends no duplicate seed.
- `after_provider_result_before_session_residue` — crash after the provider result, before
  the residue append: the execution stays RUNNING (settlement is deferred until AFTER the
  residue), NO durable residue exists, and nothing is claimed or reconstructed. A restart
  runs a NEW authorized turn with a NEW execution if the caller decides to.
- `after_session_residue_before_execution_settlement` — crash in the Shape-B window: the
  residue IS durable and the execution is NOT terminal (RUNNING). The residue stays as
  history but is NEVER trusted as a completed turn (the §9-eligibility gate below excludes
  it); the task is not fabricated DONE; the next authorized turn proceeds without it.

The forbidden state (execution COMPLETED while its session residue is missing with no other
durable copy — no deterministic reconstruction without another provider call) is UNREACHABLE
at every checkpoint: settlement happens strictly after the residue is durable. Proven by the
closeout test file `tests/sprint19/t19-03b-durability.test.ts` (14 tests: ordering, both
exact boundaries, restart durability, idempotent permanent commands, no duplicates, no
fabricated DONE, eligibility incl. FAILED/CANCELLED/INTERRUPTED/foreign, T0→T1 lineage).

## 9. Security boundaries & residue eligibility (closeout §9)

**Eligibility:** a session entry that records an execution (`executionId ≠ null`) enters the
active context ONLY when that execution is durably COMPLETED, read fresh from the durable
row through the existing execution states (no second state machine). RUNNING / FAILED /
CANCELLED / INTERRUPTED / missing / unreadable ⇒ excluded — the entry stays durable as
history, but is never loaded as prior-turn context, and never treated as business success.
The storage layer additionally CHECK-constrains execution statuses to the known whitelist.

Entries are inert rows (no grant/register/complete/dispatch surface exists); foreign tenants
get NOT_FOUND; scope tampering fails closed (`SESSION_SCOPE_CONFLICT`) and the task is NOT
marked DONE by any session failure (§42/§46-50). Reviewer/QA/Supervisor receive no Developer
transcript — structurally: their paths never read session entries (no API exists for them;
the runtime is wired only into the developer handler registration). Secret redaction rides
the T19-02 append seam. Session content grants no tool/lease/repository authority (§34).

## 10. Closeout audit verdict (DEVELOPER_SESSION_EXECUTION_RESIDUE_DURABILITY)

Recon of the as-first-committed order found: `runRound` settled the execution internally
(COMPLETED — persisting only usage/latency/resultRef, NOT the output text) BEFORE the
session residue append ran, so at `after_provider_result_before_session_residue` the state
was exactly COMPLETED + residue missing + no other durable copy of the output → the
forbidden state was REACHABLE (Shape C unusable: no durable carrier precedes settlement).
Fix adopted: **Shape B (residue first)** — §5 ordering, §8 windows, §9 eligibility, plus the
`runRoundResidueFirst` pinned-round surface. No schema change, no new table, no migration.

## 11. Remaining gaps (deliberately open)

Reviewer/QA session integration (none — isolated bounded contexts); Structured Handoff /
Work Package (the context-seed seam exists; no handoff projection producer); Planning; the
AgentRuntime-wide budget gate beyond the Developer path (this integration gates its own
invocations only); real production provider integration (still mock/fake only — Sprint-18
closeout handoff item 6).
