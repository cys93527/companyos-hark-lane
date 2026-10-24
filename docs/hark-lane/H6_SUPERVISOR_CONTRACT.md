# H6 — Supervisor integration contract — Hark lane

Status: **Hark self-review PASS (H6 scope: contract + offline/native contract tests)**. **NOT production-wired** (architecture guard). Independent Review: **NOT GRANTED**.

## Changes
- `src/executor/native-lifetime/job-executor-contract.ts`: `createNativeJobExecutorProvider` is an `ExecutorProvider` (`native.job`) over `JobLifetimeAdapter`. Clauses C1–C10 are in the file header:
  - unknown kind, capability, or workspace problems are refused with zero native calls
  - argv = literal args + typed string inputs; task text never enters argv
  - timeout = min(request, operation)
  - the adapter must have `launchPinning: 'REQUIRED'`
  - outcome mapping EXITED/FAILED/TIMEOUT/CANCELLED/LAUNCH_FAILED/STOP_UNPROVEN → succeeded/provider-failed/timeout/cancelled/provider-failed/uncertain
  - never `succeeded` without drained + proven + full identity coverage
  - the provider has its OWN blocking latch: an unproven stop, a throw, or a launch failure after resume blocks every later start (`NATIVE_EXECUTION_BLOCKED`, zero native calls); it never self-clears
- `job-lifetime.ts`: the adapter exposes `launchPinning`.
- Honest gap: **no stdout/stderr capture**. Capabilities exclude `structured-output`, and a structured request is refused.

## Results
| Run | Offline | Native | Notes |
|---|---|---|---|
| local-1 | 105/105 | NOT RUN | |
| mutation: provider latch removed | **survived** (0 failures) | — | masked by adapter quarantine → added own-latch tests |
| mutation (after fix) | killed | — | |
| mutation: success without proof | killed (6 ✖) | — | |
| mutation: contract imported from src/readiness.ts | killed by guard | — | |
| local-2 | 107/107; typecheck/lint/gates 0 | NOT RUN | |
| CI 40110364994 @bc81549 (Win Server 2022, Node 24.19.0) | 107/107 | **21/21** | all steps green |

Native evidence: normal → `succeeded`; exit 17 → `provider-failed NATIVE_JOB_FAILED exitCode 17`; tree cancel → `cancelled terminationProven:true`, root + leaf dead; 1.5 s timeout → `timeout terminationProven:true`; provider not blocked.

## Not covered / next
- Registering it in production composition / Supervisor: needs approval + independent review.
- stdout/stderr capture (H7 candidate, CI-only, no new deps).
- DSH / Provider / isolation / installer: need separate approval.
