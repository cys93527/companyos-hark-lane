# Live contract-fill run 15 fixes (hark-live-goal 42690434549)

Run 15 resumed the contract-fill project from run 14 with the run-14 validator fix. All six plan
steps and all eight tasks reached DONE (263 model calls, CNY 1.928, no UNKNOWN usage); `repo.test-check`
passed on every stage, and `evidence.grounding-check` failed on three stages, so the run went
VALIDATING → REWORK and a corrective round ran (REWORK.READY → EXECUTION.COMPLETE → REVIEW.PASS).

The very next supervisor turn — the one that precedes the re-validation of the corrected work — then
produced three consecutive illegal proposals, each refused with

```
The run has no actionable failing validation; no VALIDATION_FAILED cause exists.
```

and the driver ended the goal `SUPERVISOR_INVALID_ACTIONS_EXHAUSTED`, still EXECUTING.

## Root cause
`buildContext` (`packages/engine/src/supervisor/supervisor-runtime.ts`) correctly treats a failing
validation that a corrective child already cites as CONSUMED (no blocking condition, not a corrective
cause). But it still

1. projected that consumed FAIL row as the context's latest `validation` with no marker, and
2. offered the "ordinary" action window `CONTINUE, REQUEST_CORRECTIVE, ESCALATE`.

With no blocking condition neither extra action can ever be legal: `REQUEST_CORRECTIVE` needs an
unconsumed CHANGES_REQUESTED review or an actionable failing validation (both are blocking conditions),
and `ESCALATE` is refused without a blocking condition. The model was invited to re-cite the consumed
failure and the application rejected it every time.

## Fix
- The window without blocking conditions (and without completion provenance) is now exactly
  `CONTINUE`, which is what `validateProposal` accepts; the provider schema enum and the system prompt
  follow it.
- A consumed failing row in the projection carries `consumedByCorrective: true` and the note
  "already corrected; re-validation pending".
- Legality (`validateProposal`) is unchanged.

Regression: `tests/sprint18/supervisor-decision-runtime.test.ts` — "live contract-fill run 15 — consumed
failure before re-validation" (window = CONTINUE + marker; provider request carries the narrowed
window and CONTINUE is recorded; an unconsumed failure still opens REQUEST_CORRECTIVE/ESCALATE).
