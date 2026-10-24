# Sprint 18 / Task-18-08 — Deterministic Crash & Recovery Proof

Status: implemented (Task-18-08). This document records the fault-injection architecture, the
recovery invariant matrix, the real-process crash coverage, the startup recovery ordering and
the remaining limitations. It claims OS-level crash safety ONLY for the windows that are
actually tested; nothing here is inferred.

## 1. Fault-injection architecture

- `packages/core/src/ports/fault-checkpoint.ts` — `FaultCheckpointPort`, the frozen checkpoint
  vocabulary `FAULT_CHECKPOINTS`, and `FaultCrashError`, the crash sentinel. The sentinel is
  deliberately NOT a `DomainError`: no `catch` that maps errors to domain results can convert a
  crash into Task FAILED / Decision FAILED / Validation FAIL. The SQLite UnitOfWork's error
  normalizer re-throws the sentinel untouched (the transaction still rolls back), so a simulated
  crash inside a transaction behaves like a killed process: rollback, then propagation.
- `packages/engine/src/fault-probe.ts` — `createFaultProbe`, the test-harness adapter. It
  records every observed checkpoint (the ordering proof) and throws the sentinel at the armed
  names deterministically (default: first hit). No randomness, no wall clock, no sleeps.
- Production default: the dependency is ABSENT. Every service takes
  `faultCheckpoints?: FaultCheckpointPort` and calls it optionally, so a production composition
  executes exactly the code it always executed — no interface call, no log, no file, no
  env-var gate. Injection is by trusted dependency from the composition (`composeCoreServices`
  option `faultCheckpoints`), reachable by neither user input nor model output, and fault
  injection is not a Tool (no authority, no catalog entry). The main vitest suite excludes the
  real-process child harness (`tests/sprint18/child/**`) entirely; the child runs only under
  its own spawned config with explicit environment.

Injected sites (checkpoint name → seam): lifecycle run creation
(`before_run_goal_commit`, `during_run_goal_creation_transaction`, `after_run_goal_commit`),
supervisor turn (`after_supervisor_execution_created`,
`after_provider_result_before_decision`, `after_decision_commit_before_execution_complete`),
application (`after_decision_action_before_receipt`,
`after_corrective_task_commit_before_receipt`, `after_rework_exhaust_before_return`,
`after_resume_transition_before_next_turn`), agent units
(`after_agent_execution_before_handler_output`, `after_review_sink_before_task_done`,
`after_validation_sink_before_task_done`), evidence applicator
(`after_review_sink_before_lifecycle`, `after_validation_sink_before_lifecycle`), provider
registry (`after_provider_descriptor_before_runtime_bind`), repository handler
(`after_repository_baseline_before_task_execution`).

Checkpoints are diagnostics only: they carry no state, form no state machine, keep no ledger
and add no retry path. Canonical state remains CompanyOS's existing durable state.

## 2. Recovery invariant matrix (the tested windows)

| # | crash window (committed state → crash) | restart expectation | proven by |
|---|---|---|---|
| 1 | run creation tx, before run row commit | NO run, NO goal (both or neither) | `t18-08-fault-recovery` 1a/1b |
| 1c| run + goal committed, caller killed | both exist; ledger replay returns the SAME run | 1c |
| 2/3 | snapshot missing / pinned version tampered | fail closed BEFORE any model execution; nothing repaired | 2/3 |
| 4 | AgentExecution CREATED, no model call yet | no invented Decision; a NEW legal turn only | `t18-08-fault-matrix` 4 |
| 5 | provider result in memory only | no Decision exists; restart reasons afresh | 5 |
| 6 | Decision durable, execution unsettled | same Decision preserved, no duplicate, no provider re-call to rediscover it | 6, 33 |
| 7/8 | CONTINUE decision → action absent / action → receipt absent | the same current Decision applies once; canonical durable action recognized, bookkeeping written, no double application | matrix 7; real-crash A/C |
| 9 | corrective Task commit → receipt absent | SAME T1 identity, parent/root/round; zero duplicates | recovery 9 |
| 10/11 | COMPLETE transition / ESCALATE approval → receipt absent | replay writes bookkeeping once (receipt-replay path; §39 bookkeeping) | matrix 7 + supervisor idempotency suite |
| 12/14 | review/validation sink durable → Task not DONE | same artifact/batch reused, zero rerun, task left PENDING (never a fabricated DONE), lifecycle applies once | matrix 12/14; real-crash B |
| 13/15 | Task DONE → lifecycle event not applied | the legal event applies exactly once; a second application is a no-op | matrix 13/15 |
| 16/17 | corrective rounds across restart | round/root/parent/origin survive; round 4 still rejected | recovery 16/17 |
| 18/19 | CANCELLED AgentExecution | never an automatic retry; the loop stops `cancelled` | recovery 18/19 |
| 20 | repository baseline durable → before execution | capture-or-replay replays the SAME baseline; the lease is released on every terminal path (incl. the crash sentinel) | recovery 20 |
| 21-23 | provider descriptor / adapter bind | descriptor durable, adapter process-local; rebind idempotent on match; incompatible descriptor fail-closed | recovery 21/22/23 |
| 24/25 | REWORK.EXHAUST committed / RUN.RESUME committed | run stays PAUSED across restart with ZERO model calls; exactly one resume continuation | recovery 24/25 |
| 26/27 | old review PASS vs newer CHANGES (and inverse) | the NEWEST canonical verdict decides; an older PASS cannot resurrect | recovery 26/27 |
| 28 | corrupt corrective lineage | fail closed, never repaired | recovery 28 |
| 29-31 | ledger trimmed | decision/validation/review replay via PERMANENT identity, zero duplicates | recovery 29/30/31 |
| 32 | cross-tenant recovery | readers stay company-scoped; a foreign company sees nothing | recovery 32 |
| 33-39 | duplicate prohibitions | no duplicate AgentExecution / ToolInvocation / Approval / corrective Task / Review artifact / Validation batch / Decision | matrix 33; recovery 9/29-31; approval suite |
| 40 | full chain with injected crash | still reaches COMPLETED | chaos §42 |

## 3. Real-process crash coverage

Three windows use a REAL child process that terminates abruptly — `SIGKILL` to itself
(TerminateProcess on Windows; no unwinding, no teardown, no afterEach), with the kill marker
written synchronously to fd 2 beforehand so it cannot be lost in buffered stdout. The parent
then reopens the same durable files in a fresh composition. These are NOT ordinary thrown
exceptions:

- A. Decision durable → action absent (`after_decision_commit_before_execution_complete`)
- B. Review sink durable → Task not DONE (`after_review_sink_before_task_done`)
- C. Action committed → receipt absent (`after_decision_action_before_receipt`)

## 4. Startup recovery ordering

Actual order in the desktop composition: durable database open + migration chains → CAS
reconciliation (detect/report only; a fatal integrity finding fails startup CLOSED) → trusted
configuration load (tool ports, repository kinds) → provider descriptor verification + adapter
bind (idempotent rebind, fail-closed on mismatch) → RunSnapshot verification happens per
execution attempt (not at startup) → no workspace recovery exists in V1 (repository commands
fail closed until a trusted host opens one). Recovery CANNOT execute an agent, invoke a
provider or run a tool before those steps: nothing auto-resumes at startup, and the autonomous
loop only runs when explicitly invoked. Runs in PAUSED or WAITING_APPROVAL remain stopped with
zero model calls (`human_required`, turns = 0).

## 5. Uncertain external side effects

Sprint 14's ruling stands: an external side effect with uncertain completion is never blindly
retried. A CANCELLED AgentExecution is terminal and non-retryable. Repository tool invocations
are classified read-only / idempotent / side-effect at the tool-record level, and the baseline
is capture-or-replay keyed by the durable invocation. A crash between an OS-level side effect
and its durable settlement remains fail-closed: the recovery never re-executes uncertain work
(it replays the durable record or stops).

## 6. Remaining limitations (honest scope)

- OS-level crash safety is claimed ONLY for the windows in the matrix above. Windows not
  covered by a checkpoint are not claimed.
- The crashed review/QA Task is deliberately left PENDING with its canonical artifact durable
  (the safe, non-self-certifying state). A product-level reconciliation that completes such a
  task from durable evidence would be a future task, not silently invented here.
- Repository coverage uses the read-only baseline window; full git side-effect windows under
  V1's no-openWorkspace default fail closed and are not crash-proven beyond that.
