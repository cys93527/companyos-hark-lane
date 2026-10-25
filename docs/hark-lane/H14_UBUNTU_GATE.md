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

## CI
Run ids and results: PROJECT_HANDOFF.md (H14 section).
