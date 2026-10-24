# ADR-0032 — Goal execution admission, cancellation and verified file delivery

- Status: Boss design decisions ADR-A / ADR-B / ADR-C approved; F candidate implementation awaiting independent review.
- Date: 2026-10-11.
- Scope: bounded Execution Safety Closure Sprint 2, based on `45b68682e67ce07724d33eefffdd2d8e304ded7f`.
- Planning references: PRODUCT_PLAN.md §三十 (Decision), §五十六 (SQLite / migrations), §五十九 (execution and acceptance).

## rationale

The existing invalid-proposal/role/attempt limits do not constitute a persistent
Goal-wide financial admission envelope. Cancellation previously waited behind
the executing Run queue. An exit-zero final message is not proof of an actual
business file. Boss approved extending the existing authorities, without another
database, scheduler, terminal state machine, or Artifact/Handoff authority.

## ADR-A — subordinate facts on the canonical Run

Migration `engine/0008_goal_execution_budget.sql` adds two nullable columns to
`runs`: `execution_goal_run_id` and `execution_budget_json`. The human Goal's
planning Run owns the immutable policy; its compiled execution Runs bind to the
same root. Each physical model call has a Run/owner/call identity. Policy identity,
maxCalls, maxTokens, maxCostMicros and deadlineMs persist before dispatch.

Reserve/read/update/settle use the existing connection fence and SQLite
transaction. Concurrent connections can receive BUSY and must refuse dispatch;
retrying after contention still checks the committed quota. A duplicate call ID
is never permission to resend. Known settlement can release unused token/cost
reservation, but never refunds call count. Missing, invalid, conflicting or
over-bound usage is UNKNOWN; UNKNOWN forbids further risky calls. Startup maps
unsettled reservations to UNKNOWN, without resetting policy, deadline or quota.
Corrupt persisted JSON/shape/accounting fails closed and cannot be reinitialized.
Known late-response settlement retains the actual accounting before checking
cancellation/deadline again; it cannot grant permission to publish success. Unknown
accounting preserves the original typed provider failure, while blocking the next
admission. A failed billing reconciliation also persists UNKNOWN.

The production composition enables this gate for Planner/Supervisor Agent calls
and per-request embedded model Broker calls. Executors without the per-call
admission contract are refused. Trusted deployment token/price bounds must exist
before an external call is permitted. No real price or upstream-enforced token
bound has been established in this sprint: production defaults have no proof
callback and refuse external calls. `maxCostMicros=0` is NOT evidence of zero
external billing. Offline fixtures explicitly attest deterministic local outputs;
their zero-price proof must never be reused for a real endpoint.

The original logical retry/proposal/role limits remain in force. A HTTP 500 with
missing usage now blocks a subsequent physical call under Goal admission. The
legacy retry unit remains separately tested with its original assertions, and a
paired production test proves the new UNKNOWN restriction.

## ADR-B — durable intent, unchanged terminal authority

Cancel intent commits first in the same Goal envelope, then local transport
controllers are signalled. The response distinguishes accepted intent from
actual stopping: `accepted=true`, `stopped=false`, `NOT_CONFIRMED`. No local timeout
or abort proves remote cancellation or grants a refund. Legacy NULL-budget Runs
can receive a zero-allowance `LEGACY_CANCEL_ONLY` envelope; cancellation never
grants execution permission.

Admissions recheck after reservation/controller enrollment. New claims, Run
transitions, compiler/advance entry and restart recovery consult durable intent.
Uncommitted late Agent outcomes become CANCELLED via the existing terminal CAS
and its audit transaction. Existing already-committed outcome arbitration remains
authoritative. Late executor success/throw/malformed results settle Task CANCELLED
and ExecutionAttempt INTERRUPTED; Run remains FAILED with `cancelled`, using the
existing state machine. Controllers and deadline timers are transport resources,
not a second persistent scheduler or state authority.

Existing local process-tree stop evidence still requires observed tree stop AND
root exit; failed cleanup/residual processes remain UNKNOWN. Real DSH process-tree
behavior and remote-side stopping remain NOT VERIFIED.

## ADR-C — human-owned file contract through existing services

Immutable Goal `structured.fileDeliveries` declares 1–8 entries:
`criterionId`, relativePath, maxBytes (1–16 MiB), optional expectedSha256 and
expectedSizeBytes. The Planner must preserve and assign each criterion. Tasks
consume only requirements associated with their pinned acceptance criteria.

For those Tasks, final JSON schema `companyos/business-files/1` must identify the
actual Goal root, execution Run, Task and exact declared file list with size/hash.
It is a declaration, not evidence. A bounded read checks real file existence,
regular/nonempty size, Workspace containment, component aliases, hardlink count,
file identity and before/after changes. Path traversal, device names, alternate
streams, junctions/symlinks and duplicate aliases are refused.

Actual bytes enter the existing Artifact service and CAS under a stable attempt /
path command identity. `file.delivery-check` independently validates canonical
ownership/content. All existing pinned Task Validators are ADDITIVE and blocking;
all must PASS. Handoff uses only those business Artifact and PASS Validation refs,
not stdout/diagnostic summaries. READY's final admission check and Handoff write
share the existing SQLite transaction. Handoff remains DRAFT → READY; no automatic
ACCEPTED or new workflow progression is added. Terminal Tasks with no successor
retain the existing no-transfer behavior. Partial CAS/artifact/validation rows may
remain after failure/crash, but cannot alone form a successful delivery.

This snapshot reader is not an OS sandbox: Windows final-handle path enforcement
and hostile concurrent reparse ABA races have not been proved. No ACL change or
real DSH Kernel is authorized. Live writable-file execution remains blocked until
the separate host/filesystem isolation boundary is approved and verified.

## Migration compatibility and rollback

Old Run columns, IDs and lifecycle states are unchanged. Old rows have NULLs and
are denied external dispatch, not silently assigned unlimited budgets. Normal Run
updates retain the new columns. The existing migration ledger protects checksum
and replay. No historical migration is edited.

Before a real rollout: stop ALL owners, preserve a consistent SQLite backup with
WAL checkpoint/sidecars as appropriate, CAS and matching build/config identity;
hash and restore-test that backup in a separate directory. No live upgrade occurs
here. The offline regression upgrades a real 0001–0007 fixture, checks old rows,
NULL behavior, checksum refusal and idempotence, and restores a stopped DELETE-mode
backup byte-for-byte with `quick_check=ok`.

Rollback before any external execution may restore the tested pre-migration
backup and prior build after stopping all owners. After possible remote calls,
do NOT erase reservations/cancellation facts or restore quota from an older
backup: retain the migrated data and disable dispatch pending reconciliation.
No destructive down migration, column drop, schema replacement or automatic
rollback is supplied. A WAL/live-production restoration is NOT VERIFIED.

## alternatives

- Memory-only counters/timers: rejected because restart loses quota and intent.
- Separate budget database/scheduler: rejected because it creates a second authority.
- Implicit zero usage/price or retrying uncertain calls: rejected because billed
  side effects may already have occurred.
- Treat final stdout or exit zero as delivery: rejected because no actual file,
  ownership or Validator evidence is established.
- Bypass Sandbox or modify Workspace ACLs now: rejected because not authorized.

## frozenAreas

Core canonical Goal/Run/Task/Attempt identity and terminal states; existing
Router selection semantics; Artifact/CAS/Validation/Handoff authorities;
the original E workspace and historical diagnostics; Electron/GPU/Sandbox and
Windows security policies. No new Runtime or Session/Context authority.

## revisitWhen

Independent review finds an admission or terminal race; a verified deployment
token/tariff contract is available; live DSH and one-shot filesystem isolation
are separately authorized; packaged read-only resources / writable storage are
tested. Such evidence is required before seeking a bounded live Goal approval.

## Candidate validation limitation — 2026-10-11

The raw aggregate's default `security-agent-attack` suite actually started the
embedded DSH Kernel, contrary to this sprint's offline-only authorization. The
preflight incorrectly treated a diagnostic environment variable as a replacement
mechanism; no such mechanism exists in that test. The aggregate stopped with six
failures; the real-kernel CROSS-TASK exit-code failure remains unexplained. It is
not an authorized live acceptance result. No further kernel/default suite run is
performed. Explicit offline regressions, static checks and build pass, but the
full quality gate remains BLOCKED. Native child network/ACL effects were not
completely monitored; no absence-of-side-effects claim follows from the local
JavaScript tripwire. Boss must decide the kernel-dependent gate's authorization
before another aggregate is attempted.
