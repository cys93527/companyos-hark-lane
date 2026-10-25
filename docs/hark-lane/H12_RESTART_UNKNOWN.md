# H12 — Restart consistency, UNKNOWN no-replay, cancel terminal kept (2026-10-25)

Hark self-review PASS for this layer only. Not independent review, not product acceptance.
No real Provider, no network model call, CNY 0. No DSH, no native.job production dispatch, no tag/release.

## What was added (no product code changed)
- `scripts/hark/restart-unknown.mjs` — harness run as THREE separate processes on one dataDir with the
  production composition (`productionCompositionOptions` + operator budget approval via `createDeploymentBudgetProofSource`)
  and an in-process **counting fake** model provider (`h12.counting-fake`; counts every invoke in-process and in a durable
  `provider-calls.log`; never answers).
  - **p1**: create Goal A (budget initialized) and Goal B; cancel B; start A's autonomy driver; the planning turn is admitted
    (reservation RESERVED, bound CNY 0.112 nominal) and the fake never answers; the process exits with `process.exit`
    — no settle, no `db.close()`.
  - **p2**: reopen. Composition recovery turns the reservation UNKNOWN (usage null, bound unchanged); `goal.advance` refused
    `POLICY_DENIED / GOAL_USAGE_UNKNOWN`; autonomy driver ends NON_RECOVERABLE_FAILURE; **0 provider calls**; still 1 reservation;
    `run.budget` unknown = {calls 1, costMicros 112000}, held 0. B's history unchanged. Then A is cancelled.
  - **p3**: reopen. A and B history + cancellation intent byte-identical to p2/p1; advance refused typed `CANCELLED`;
    0 provider calls; UNKNOWN still counted; `run.budget` state CANCELLED.
- `scripts/hark/fixtures/h12-counting-fake.approval-template.json` — operator approval/proof for the fake identity
  (endpoint `http://127.0.0.1:9/h12-no-network`, never contacted). Nominal rates only so the bound is a non-zero number.
- `.github/workflows/hark-restart.yml` — runs after a successful push-triggered `hark-installer` run (workflow_run) or on
  dispatch with `installer_run_id`; installs that installer per-user and runs p1/p2/p3 each as its own
  `CompanyOS.exe` process (`ELECTRON_RUN_AS_NODE=1`, `Start-Process -Wait`); uninstalls; uploads `hark-restart-evidence`.
- `tests/hark/h12-restart-unknown.test.ts` — the same contract in the regular vitest gate (three compositions, one dataDir).

## Semantics found (recorded, not changed)
- Core run-state has no CANCELLED run state: `CANCEL` → `FAILED` with history event `CANCEL` (run-state.ts: "reason=cancelled，不单列状态").
  "Cancelled terminal not overwritten" is therefore proven as: run state + full `history_json` + budget `cancellation` are
  unchanged across recovery and resume.
- Goal A after p2: the resume path settles A's planning task FAILED (typed GOAL_USAGE_UNKNOWN); the later cancel adds
  the durable intent; the cancel check then wins (`available()` checks cancellation first).
- Negative control (local): with `executionSafety.recover()` removed from the built composition, p2 **replayed the paid
  call** (second line in provider-calls.log, phase p2) and blocked in it. The harness catches it; recovery is what prevents it.

## Results (real output in lane/evidence/H12-*)
| run | result |
|---|---|
| local run1 (Linux, built dist, 3 node processes) | p1 PASS, p2 PASS, **p3 FAIL** — first failure kept: my expectation was GOAL_CANCEL_REQUESTED, the control plane refuses a cancelled Goal earlier with typed code `CANCELLED` |
| local run2 (adds Goal B cancelled in p1) | p1/p2/p3 FAIL on Goal B — first failure kept: I expected run state CANCELLED; core maps CANCEL → FAILED (see Semantics) |
| local run3 | p1 6/6, p2 11/11, p3 12/12 PASS |
| negative control (recover() removed from built composition) | p2 replays the call (provider-calls.log line from p2), blocks, killed by timeout 150 |
| vitest tests/hark run1 | 3 fail: the offline guard forbids spawning make-budget-approval.mjs (OFFLINE_TEST_EXECUTION_DENIED) — first failure kept |
| vitest tests/hark run2 / run3 | 7/7 (H11 P1–P4 + H12 R1–R3) |
| eslint run1 / run2 | 1 error (no-explicit-any in the test) / 0 |
| typecheck run1 / run2 | 0 / 0 |
| offline (node scripts/hark/test-hark-offline.mjs) | 132/132 |
| check-boundaries / check-architecture | exit 0 / exit 0 |
| vitest full | 38 failed / 3716 passed of 3754 (H11: 39/3750). Failure set vs H11: +1 `sprint17/repository-process-failure-evidence` "8. cancellation evidence" (in the H2 baseline failure set; passed on isolated rerun, where 1-3/6/7 failed instead = known nondeterministic stream-capture file); −1 `production/pre-dispatch-failure` (the H11 fix); −1 `sprint17/repository-git` 13-14 (baseline flaky). No product code changed in H12. ⇒ baseline-equivalent |
| **CI @c233140** | hark-windows 40198010566 success; hark-installer 40198010569 success; **hark-restart 40198306740 success**: Windows Server 2022 (10.0.20348), installed CompanyOS.exe, Electron 44.5.1 / Node 24.21.0; three processes pid 3596 / 5672 / 5176, exit 0/0/0; p1 6/6, p2 11/11, p3 12/12; provider-calls.log has exactly 1 line (p1); p2 advance `POLICY_DENIED/GOAL_USAGE_UNKNOWN`; run.budget unknown {calls 1, tokens 32000, costMicros 112000}, held 0; p3 state CANCELLED, advance `CANCELLED`, Goal B history unchanged |

## Not done / limits
- The "crash" is `process.exit` mid-call in the same OS process that holds the call; a power loss / torn WAL write is not simulated.
- UNKNOWN stays UNKNOWN forever in product terms: there is no operator reconciliation flow yet (needs a design + approval; not in H12).
- Fake provider only; no real Provider spend was made or needed. No DSH; native.job not production-wired.

## Reproduce
- CI: push to hark-lane (hark-installer then hark-restart via workflow_run), or dispatch hark-restart with `installer_run_id`.
- Local: build (`pnpm run build:libs && pnpm --filter @companyos/desktop build`), make an app-shaped dir with
  `node_modules/@companyos/{core,contracts,engine,persistence,observability}` → packages and `apps` → repo apps,
  `node scripts/hark/make-budget-approval.mjs <budget> scripts/hark/fixtures/h12-counting-fake.approval-template.json`,
  then with `COS_PLAN_PREVIEW_WITHOUT_EXECUTOR=1` run `node scripts/hark/restart-unknown.mjs p1|p2|p3 <app> <ev> <budget> <data>`.

## Review request
Independent reviewer: check that (1) p1 really leaves the reservation admitted and unsettled at exit, (2) no path other
than composition recovery could have produced the UNKNOWN, (3) the negative control is meaningful.
