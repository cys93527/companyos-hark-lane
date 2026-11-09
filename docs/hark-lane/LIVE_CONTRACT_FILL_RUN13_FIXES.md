# Live contract-fill run 13 fixes (hark-live-goal 42624351676)

Run 13 resumed the contract-fill project from run 12. The run-12 fixes held: `evidence.grounding-check`
passed on every software stage. But every `repo.test-check` ended as a bare registry **TIMEOUT** after
exactly 600 000 ms (validation status `error`, no exit code, no output tail), 5 stages failed the same
way, the corrective rework could not learn anything, and the goal ended FAILED. The project's own
`npm test` passed in the harness's independent check (Ran 75 tests in 107 s, OK).

## Root causes
1. **Deadline race.** The tool registry bounds the whole invocation (snapshot copy + `npm test` + settle)
   by `REPO_TEST_CHECK_SPEC.timeoutMs` (600 000 ms), and the test-contract process was given the *same*
   600 000 ms, armed only after the snapshot copy. The registry always won, so the process tree's own
   deadline (tree kill + output tail) never fired and LibreOffice processes started by the tests leaked.
2. **Silent tail.** A Python test contract writing to a pipe is block-buffered, so even a fired deadline
   would have returned no output.
3. **Thin environment.** The validator's child environment dropped non-secret Windows system locations
   (`PROGRAMDATA`, `ALLUSERSPROFILE`, `COMMONPROGRAMFILES`, `PUBLIC`, `COMPUTERNAME`, ...) that native
   programs a test legitimately launches (LibreOffice for the PDF export tests) expect.
4. The workspace grew to ~14 000 files (LibreOffice profiles the tests left under `.tmp`); the snapshot
   copy of them ran inside the same bound.

## Fixes
- `repoTestContractDeadlineMs(spec)` = `spec.timeoutMs − REPO_TEST_CONTRACT_HEADROOM_MS (90 s)`; the port
  measures the snapshot copy and passes the contract only what is left (`runTestContract({ cwd, timeoutMs })`).
  If under `REPO_TEST_CONTRACT_MIN_MS` (30 s) is left, the verdict is a FAIL `[VALIDATOR_SNAPSHOT_SLOW]`
  telling the agent to clean leftover test temp files.
- A deadline verdict is a FAIL with reason and an output tail prefixed `[VALIDATOR_DEADLINE]`.
- Constant `UNBUFFERED_STDIO_ENV` (`PYTHONUNBUFFERED=1`) in the validator child environment.
- Allowlist extended with the non-secret Windows system keys above (secrets still never pass).
- Regression test: `tests/hark/live-contract-fill-run13.test.ts`.

## CI follow-up (hark-ubuntu on 35b0b0f)
The first version measured the snapshot copy with `Date.now()` inside `@companyos/engine`, which breaks
the engine boundary law (`packages/engine/tests/boundary.test.ts`: no system timers in the engine).
Root fix: the elapsed time comes from an optional `monotonicMs` seam in `RepoTestCheckDeps`, supplied by
the composition root (`core-services.ts`: `performance.now()`); without it the copy counts as 0 ms and the
90 s headroom is the margin. Regression tests in `tests/hark/live-contract-fill-run13.test.ts` cover the
seam, the slow-snapshot FAIL and the production wiring. Local gates now include `packages/engine/tests`.
