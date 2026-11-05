# TEST_SPEED — faster dev-loop tests (Hark lane, 2026-11-05)

Status: Hark lane change, offline. Vitest 3.2.7 → 5.1.0 (the approved bump; no other new
dependency), two Vitest projects, four new scripts and one helper. Not an acceptance conclusion.

## The rule first

**The full suite stays mandatory.** It runs on every push in CI (`hark-ubuntu`, step
"Full vitest (deterministic suite)" followed by "Compare against the triaged baseline") and it
must be green on the exact commit before any tag/release (`lane/h18-release.sh` refuses to tag
otherwise). The fast commands below only shorten the local edit → test loop; a green
`test:changed` or `test:since` never stands in for the full suite.

`tests/hark/test-speed-full-suite.test.ts` pins this: the hark-ubuntu full-vitest command may not
carry `--shard`, `--changed`, `--since-last-run`, `--related`, `--project`, `-t` or a file
filter; `test` and `test:full` stay `vitest run`; `isolate:false` applies only to the
`packages` project and the two projects together select exactly the old include list.

## Commands

| Command | What it runs | When to use it |
|---|---|---|
| `pnpm test` / `pnpm test:full` (`npx vitest run`) | the whole deterministic suite, both projects | before pushing anything risky, and what CI runs; mandatory before any tag/release |
| `pnpm test:since` (`npx vitest run --since-last-run`) | only the test files affected by files modified since the previous local Vitest run | the tight loop: edit one thing, rerun what it touches |
| `pnpm test:changed` (`node scripts/hark/test-changed.mjs`) | `vitest run --changed <merge-base of HEAD and the base branch>`: tests affected by everything on this branch, committed or not | before opening a merge: "did my branch break anything it touches?" |
| `pnpm test:shard` (`npx vitest run --shard=1/4` … `4/4`) | one quarter of the full suite | splitting a full run across terminals/machines; all shards together = the full suite |
| `npx vitest run tests/hark apps/renderer/tests` | the Hark + renderer dev-loop folders | UI / lane-script work |
| `npx vitest run --project packages` | only the pure-Node libraries (`packages/*`) | library work |

`test:changed` base: `$TEST_BASE_REF` when set, otherwise the first of `origin/hark-lane` and
`hark-lane` that resolves. A missing base is a typed error (`TEST_CHANGED_BASE_MISSING`, exit 2),
never a silent full or empty run. Vitest reruns everything when `package.json` or a
`vitest.config.*` changed (its `forceRerunTriggers`), so a branch that touches those gets the full
suite from `test:changed` as well.

Selection is by import graph. A change in a leaf file (a renderer component) selects a handful of
files; a change in a widely imported core file (for example `packages/persistence/src/entity-store.ts`)
selects most of the suite, and then the fast commands save little.

## What changed

- **Vitest 5.1.0.** Vitest ≥ 4 forks its own pool worker (`dist/workers/forks.js`, preloaded
  with `suppress-warnings.cjs`) and no longer exports `vitest/vitest.mjs`.
  `scripts/test-offline-guard.cjs` now resolves the CLI, the fork worker and the preload from the
  installed package root and pins each by identity; the fork's `execArgv` must match the exact
  framework shape (optional `--experimental-import-meta-resolve`, optional `--require <pinned
  preload>`, then `--conditions` pairs) or the guard refuses. `tests/sprint18/t18-08-real-crash`
  accepts Vitest 5's "Worker exited unexpectedly with signal SIGKILL" wording; the `basic`
  reporter (removed in 4) became `default`.
- **Two projects** in `vitest.config.ts`: `packages` (`packages/*/tests/**`, `isolate: false`
  — these suites use no module mocks, stubbed globals/env or fake timers and passed in shuffled
  file order with seeds 7 and 1234) and `isolated` (everything else, per-file isolation kept:
  they compose real stores, spawn guarded children and mutate process state).
- **Scripts** `test:full`, `test:since`, `test:changed`, `test:shard` + `scripts/hark/test-changed.mjs`.

## Timings

Measured in the Hark sandbox (4 workers), evidence `lane/evidence/test-speed/`.

| Loop | Before (Vitest 3.2.7, one project) | After (Vitest 5.1.0, two projects) |
|---|---|---|
| Dev loop `tests/hark` + `apps/renderer/tests` (78–79 files) | 56.7 s | 40.2 s |
| `packages/*` project (71 files, 520 tests) | 47.7 s (isolated) | 22.5 s (`isolate: false`) |
| `test:since` after a one-file change | — (whole folder rerun) | 9.7 s, 15 files |
| `test:since` with nothing changed | — | ~1 s ("No changed files found") |
| `test:changed` vs the branch, one throwaway commit touching `apps/renderer/src/cancel-control.tsx` | — | 7.6–8.7 s Vitest (10.6–11.2 s wall), 14 files / 128 tests |
| `test:changed` with no change vs the base | — | 1.1 s wall |
| `test:changed`, throwaway commit touching `packages/persistence/src/entity-store.ts` | — | > 110 s (most of the suite is downstream) |
| Full suite, CI `hark-ubuntu` "Full vitest" step | 167 s (run 41948918316, v0.1.3) | measured on the first hark-ubuntu run of the merged head; see PROJECT_HANDOFF.md |

The `test:changed` measurement used `TEST_BASE_REF=<the test-speed commit>` so that only the
throwaway commit differed (as on a feature branch cut from hark-lane after this merge); the
throwaway commit was removed with `git reset --hard` afterwards.

## Release gate

`lane/h18-release.sh` (lane tooling, outside the repository) refuses to tag unless a
`hark-ubuntu` run on the exact sha concluded `success` with the steps "Full vitest
(deterministic suite)" and "Compare against the triaged baseline" both `success`.
