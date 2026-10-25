# H14 — Ubuntu offline gate (hark-ubuntu CI) and the Linux defects it exposed

Hark lane, self-review only (Hark self-review PASS when CI is green; not an independent review).

## Gate
`.github/workflows/hark-ubuntu.yml` (push to hark-lane): ubuntu-24.04, Node 24.19.0, pnpm 11.25.0,
`pnpm install --frozen-lockfile --ignore-scripts`, `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, no secrets, no
Provider/DSH. Steps: typecheck, full eslint, Hark offline tests, boundaries, architecture, full vitest
(JSON report) → `scripts/hark/compare-vitest-baseline.mjs` against
`scripts/hark/ubuntu-vitest-baseline.json`. Any failure not listed fails the job; a listed entry that
passes is reported (`NOW-PASSING`) so the list only shrinks.

The baseline may hold ENVIRONMENT-BOUND failures only, each with its reason:
- `docs/tests/handoff.test.ts` — needs git tag `sprint-11.0.0`; tags are approval-blocked.
- `tests/production/headless-guard-explicit-extension.test.ts` (2 artifact checks) — read the gitignored
  `.companyos-embedded/dsh-runtime/`, materialized only from an installed DSH runtime (approval-blocked).

## Defects found by triage and fixed at the root (they were the old "baseline")
1. **Path grammar ignored the injected platform** (`packages/engine/src/executor/execution-safety.ts`,
   `repository/path-policy.ts`). Every seam takes `platform`, but `isAbsolute`/`resolve`/`sep` used the
   host's, so a win32 decision on Linux refused `C:\work` as "not absolute" (and a POSIX decision on
   Windows would use Windows grammar). Now `win32`/`posix` is chosen from the injected platform.
   Executor config gains `platform` (DSH paths are Windows paths). Tests in s24/s25 now state the platform
   their paths are for; one s25 case that mixed a POSIX seam with Windows paths was corrected; 3 new
   cross-grammar tests.
2. **Live DSH suite ran inside the deterministic suite** contrary to the S26 taxonomy. It now runs only
   under `vitest.provider-live.config.ts` (`pnpm test:provider:dsh:live`).
3. **Fixtures lost output on Linux**: `process.stdout.write(...)` followed by `process.exit()` truncates
   piped output on POSIX (reproduced: 60416 of 65536 bytes). sprint17 fixtures use `process.exitCode`.
4. **A registry timeout was recorded as CANCELLED**: the runner inferred TIMEOUT from elapsed time, but the
   registry's timer starts before the runner's `startedAt`, so it always fired "early". `ToolPort.cancel`
   now takes the caller's reason; the registry passes `'TIMEOUT'` (elapsed-time inference stays only as a
   fallback for reason-less callers).
5. **POSIX tree stop missed a grandchild that left the process group** (`setsid`/`detached`). On Linux the
   runner now freezes the group and every `/proc` descendant (repeat until no new one), then kills them
   all, then the group (`linuxDescendantPids`, unit-tested on synthetic /proc).
6. A cancel test guessed child start-up time (400 ms); the fixture now publishes a ready marker after its
   output exists.

7. **The Ubuntu job never built `apps/desktop/dist`** (gitignored) although
   `tests/embedded-storage-lifecycle.test.ts` spawns Node against it (first hark-ubuntu run 40221981935,
   ERR_MODULE_NOT_FOUND). The workflow now builds libs + desktop dist from the checkout before vitest.
8. **A wall-clock bound** in `execution-safety-process.test.ts` ("bounds failed cleanup", < 350 ms; 459 ms
   on the runner). Rewritten load-independent: the request deadline fires once the fixture's pid line is
   seen, the test asserts the provider returned (timeout, termination unproven) while the unkillable
   process was still alive, then releases it and checks the late exit does not change the outcome.

## CI
- First run 40221981935 @00ab0b6: 3 UNEXPECTED (items 7, 8) — kept in lane evidence H14-ci.
- GREEN @243eded: hark-ubuntu 40227470496 (offline 132/132, typecheck/eslint/boundaries/architecture 0,
  vitest 3806/3809, 0 UNEXPECTED, 3 baselined env-bound), hark-windows 40227470473, hark-installer
  40227470462, hark-restart 40227910957, hark-upgrade 40227910782.
