# Live contract-fill run 14 fixes (hark-live-goal 42668857942)

Run 14 resumed the contract-fill project from run 13 with the run-13 validator fixes. Planning and the
software stages executed again (748 model calls, CNY 5.387, no UNKNOWN usage) and
`evidence.grounding-check` passed on every stage. But all 6 `repo.test-check` calls ended within seconds
as tool errors:

```
EPERM, Permission denied: \\?\C:\Users\RUNNER~1\AppData\Local\Temp\companyos-validator-home-XXXX
```

The validator could not produce a verdict, three corrective cycles all hit the same error, and the
driver ended the goal at the goal-level corrective cap (`AUTONOMY_BUDGET_EXHAUSTED`).

## Root cause
The unconfigured-isolation branch of the validator runner (`apps/desktop/src/repo-test-process.ts`)
removes the per-run scratch profile (HOME/USERPROFILE/APPDATA/TEMP redirect) in a `finally`. The
generated project's tests start LibreOffice; on Windows the orphaned `soffice.bin` processes outlive
`npm test` and keep files of the scratch profile open, so `rmSync` threw `EPERM`. Because the throw came
from the `finally`, it **replaced the contract's verdict**: the test run itself had finished, but the
validation was recorded as a tool error. The isolated branch had the same shape for its workspace copy.

## Fix
- Removal of the scratch profile / isolated copy is housekeeping: `removeBestEffort` retries (Windows
  lock retries, `maxRetries` 5) and never throws. The contract's exit code, timeout flag and output are
  kept; a failed removal only appends `[VALIDATOR_SCRATCH_CLEANUP]` with the leftover path to the tail.
- A run whose process port itself throws still propagates that error (cleanup is still attempted).
- `sweepStaleScratch` removes `companyos-validator-home-*` directories older than an hour left by an
  earlier locked run (best-effort, before each unisolated run).
- Security intent of AUDIT-D1 is unchanged (labelled 未隔离, trusted-state guard).

Regression: `tests/hark/live-contract-fill-run14.test.ts`.
