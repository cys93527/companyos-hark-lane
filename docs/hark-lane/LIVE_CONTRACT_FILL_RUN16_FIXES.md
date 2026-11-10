# Live contract-fill run 16 fixes (hark-live-goal 42711818830)

Run 16 resumed the contract-fill project from run 15 with the run-15 supervisor-window fix. All six
work tasks reached DONE between 06:40 and 07:00 CST (261 model calls, CNY 1.744, no UNKNOWN usage), the
execution run reached EXECUTION.COMPLETE and REVIEW.PASS, and then nothing happened for 20 minutes:
the driver ended three generations `AUTONOMY_STALLED` ("canonical state fingerprint unchanged for 3
consecutive steps") and the harness stopped on `IDLE_NO_PROGRESS` with the UI still showing 执行中.
No validator ever ran (0 rows in `validations`).

## Root cause
One autonomous supervision call (`createAutonomousSupervisorRuntime().run`) carries ONE whole-run
deadline (default 120 s) over every turn AND the stage work its CONTINUE decisions apply. Turn 5
(06:58) applied the last stage (about 2 minutes of DSH work), so turn 6 began at 07:00 with only
seconds of the deadline left. Our own timer aborted it during the provider catalogue preflight, the
execution settled as a durable `CANCELLED` row, and the frozen §28 rule (a CANCELLED execution is never
re-entered automatically) made every later call stop with `cancelled` before any turn. The run sat in
VALIDATING with no model turn to reach the validation gate, and the user was shown no decision.

## Fix
`packages/engine/src/supervisor/autonomous-supervisor.ts`: a new model turn starts only while the turn
window is open. The window closes `minTurnWindowMs` (default `min(60 s, half the deadline)`) before the
deadline, on the same shell timer seam as the deadline itself. Once it has closed, the call yields
`timeout` with no execution and no Decision, and the next `goal.advance` takes the turn under a fresh
deadline. A provider that hangs through a whole window still settles CANCELLED and parks the run as
before (tests/production/corrective-software-validation.test.ts F1+F2 unchanged).

Regression: `tests/sprint18/autonomous-supervisor.test.ts` "live run 16" (fails before the fix with
stopReason `error` after a second turn ran inside the closing window; passes after).
