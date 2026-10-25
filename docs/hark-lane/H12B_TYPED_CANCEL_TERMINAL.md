# H12b — Typed cancellation terminal, cancel convergence after restart, fenced boss reads (2026-10-25)

Hark self-review PASS for this layer only. Not independent review, not product acceptance.
No real Provider, no network model call, CNY 0. No DSH, no native.job production dispatch, no tag/release.

## Decision: is "cancel → FAILED" a product defect?
- `PRODUCT_TARGET.md` asks for trusted Goal/Plan/Run/Task/Attempt state and "取消终态不被迟到成功覆盖";
  `COMPARISON_ACCEPTANCE.md` asks for cancel terminals kept across restart.
- The L1 run machine is **frozen at 17 states** (规划书 §三十三, ADR-0003; `run-state.test.ts` "declares exactly the 17
  frozen states"), and ADR-0032 / STATE_MACHINE.md SM-L1-07 decide explicitly: cancel and timeout land on `FAILED`
  **with a typed `failureReason`** (`cancelled` / `timed_out`). The domain already did this (`WorkflowRun.failureReason`,
  persisted in `runs.failure_reason`). Adding a 18th `CANCELLED` run state would break the frozen planning contract.
- The **real defects** were around it, and they are fixed at the root here:
  1. No boss-facing projection carried the type: the goal list / workspace badge showed `FAILED`, the chat said
     "目标失败 · cancelled", the runtime phase was `failed`, the blocker was `RUN_FAILED`. The renderer compared run state
     with `'CANCELLED'` in four places — a state that cannot exist (dead code that hid the gap).
  2. `failure_reason` had no storage constraint and was cast through on read (any string became a "reason").
  3. `goal.cancel` commits the durable intent, then settles the owned runs fire-and-forget. A process exit between the two,
     or a failed settlement, left the Goal **non-terminal forever** (refused for work, but shown as e.g. PLANNING).
  4. Found while fixing 3: unfenced raw reads (autonomy `loadGoalState` COUNT queries) were refused
     `CROSS_CONTEXT_TRANSACTION_READ_REFUSED` whenever another async context held a transaction — e.g. cancelling Goal B
     while Goal A ran killed A's autonomy driver with PERSISTENCE_FAILED (the H12 vitest went red on exactly this race once
     the settlement timing moved). Boss read operations had the same exposure.
  5. Found in the sweep: `home.summary` read ONE page of 100 runs (execution runs included), so older Goals silently
     disappeared from the home list.

## Changes
- core `workflow-run.ts`: `runTerminalOutcome(run)` → `COMPLETED | CANCELLED | TIMED_OUT | FAILED | null`,
  `RUN_TERMINAL_OUTCOMES`, `isRunFailureReason`. The 17-state machine is unchanged.
- persistence: migration `engine/0009_run_failure_reason_typed.sql` (additive: two BEFORE INSERT/UPDATE triggers,
  `RAISE(ABORT,'RUN_FAILURE_REASON_INVALID')`; `state` already had a CHECK). `sqlite-run-store` decodes `state`,
  `resume_point`, `failure_reason` typed and fails closed (`PERSISTENCE_FAILED`) on a corrupt legacy row.
- engine observation: `RunOverview.terminalOutcome`; blocker code `RUN_CANCELLED` / `RUN_TIMED_OUT` / `RUN_FAILED` by outcome.
- control plane: `terminalOutcomeOfRun` used for every terminal check (dead `'CANCELLED'` compares removed);
  `home.summary` goals and `goal.workspace` planning/execution runs carry `terminalOutcome`; `goal.workspace`
  carries `cancellationRequested` (durable intent, visible before settlement); `home.summary` pages through all runs;
  read-only operations run in the connection read fence (`readFence` = `writeFence.immediate`).
- composition (`core-services.ts`): `settleGoalCancellation(goalRunId)` shared by `goal.cancel` and a **startup
  convergence** pass — every Goal with a durable cancellation intent gets each owned non-terminal run cancelled through
  the engine's own `RUN.CANCEL` (idempotent; terminal runs are never rewritten). Autonomy `loadGoalState` runs in the
  read fence.
- renderer: `run-outcome.ts` (`terminalOutcomeOf`, labels 已完成/已取消/已超时/失败); phases `cancelled` / `timed-out`;
  chat entry "目标已取消"; goal list / sidebar / workspace badges show the outcome label (canonical state kept as title);
  "已请求取消…正在收尾" while the intent is durable but runs are not settled; no failure banner for a cancelled Goal.
- harness `scripts/hark/restart-unknown.mjs`: P1/P2/P3 also check `failure_reason = cancelled` and
  `terminalOutcome = CANCELLED` for Goal B across the process restarts.
- docs: STATE_MACHINE.md SM-L1-07 note; S23 blocker code list.

## Tests added
- `packages/core/tests/domain/run-terminal-outcome.test.ts` (outcome mapping; machine still 17 states, CANCEL → FAILED).
- `tests/hark/h12b-cancel-terminal.test.ts` C1–C7 (production composition, offline): typed CANCELLED in workspace /
  overview / blockers / home; live Goal not ended; **intent committed, settlement never ran → next composition converges**,
  third composition byte-identical; a run FAILED before the cancel is not rewritten; storage refuses an untyped reason and a
  `CANCELLED` state, corrupt legacy row fails closed; home lists Goals past 100 runs; a boss read during a foreign open
  transaction waits and succeeds (negative control: the unfenced raw read is refused).
- `apps/renderer/tests/h12b-run-outcome.test.ts` (labels, phases, list/workspace render, pending cancel, source scan).
- `tests/hark/h12-restart-unknown.test.ts` R1/R3 now assert the typed outcome.
- `tests/sprint3/migration.test.ts`, `tests/sprint4/boundary.test.ts`: chain lists include 0009.

## Results (real output in lane/evidence/H12b-*)
| run | result |
|---|---|
| vitest targeted run1 | 4 fail — first failure kept: goal-client CLIENT-05 expected raw `FAILED` badge text (fixed: canonical state kept as badge title); H12 R1–R3 failed: autonomy driver refused `CROSS_CONTEXT_TRANSACTION_READ_REFUSED` (unfenced COUNT reads in loadGoalState while Goal B's cancel settled) — root-fixed with the read fence |
| h12b C5 first version | CHECK constraint on `state` fired first (kept); test split into storage refusal + legacy decode |
| h12b C7 first version | hung: store reads are already fenced, the negative control used one — replaced with the raw unfenced read that actually races |
| vitest targeted run2 / run3 | 225/225; then 147/148 (C7 hang above) → 7/7 C1–C7 |
| offline (test-hark-offline.mjs) | 132/132 |
| check-boundaries / check-architecture / typecheck / eslint (full) | exit 0 / 0 / 0 / 0 |
| vitest full | 37 failed / 3733 passed of 3770 (H12: 38/3716 of 3754). New vs H12: sprint17 repository-git 13-14 and repository-process-tools "long stderr" — both pass on isolated rerun (vitest-rerun-sprint17.txt; same flaky process-capture family as the baseline); gone: supervisor-ownership B1-01, process-failure-evidence 1-3, sprint6 secrets scan. ⇒ baseline-equivalent, no new failure |
| CI @26ce6be | hark-windows 40206148040, hark-installer 40206148063, then hark-restart (workflow_run) — results recorded in PROJECT_HANDOFF when complete |

## Not done / limits
- `docs/tests/handoff.test.ts` needs git tag `sprint-11.0.0`, absent in the Hark repo; creating tags needs approval.
- UNKNOWN reconciliation, hard-kill harness, migration chain hygiene: queued as H12c.
