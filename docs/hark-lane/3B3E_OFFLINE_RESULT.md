# Hark lane — Phase 3B-3E offline result (H1)

Status: implemented offline in the Hark lane; **independent review pending**. Not wired to production dispatch, IPC, composition root or any Provider/DSH. Not a sandbox.

## Source changes (all new files; no existing file modified except PROJECT_HANDOFF.md and these docs)
| File | Purpose |
|---|---|
| `apps/desktop/src/executor/native-lifetime/job-port.ts` | Win32 Job/process port types + constants; imports no native module |
| `apps/desktop/src/executor/native-lifetime/launch-pins.ts` | `verifyLaunch` → branded immutable `VerifiedLaunch` (WeakSet brand, not Boolean); sha256 pins; alias-free canonical paths; single-link files; cwd containment; closed env allowlist (no NODE_OPTIONS/PATH/proxy/keys); ordinal env sort; CRT-exact argv quoting |
| `apps/desktop/src/executor/native-lifetime/job-lifetime.ts` | Bounded lifetime adapter: configure+read-back before any process; ATOMIC_REQUIRED (JOB_LIST) default, legacy assign opt-in with orphan window reported; membership verified before single Resume (prev count must be 1); drain proof (active 0 + empty list + all handles signalled); EXITED needs full identity coverage + all zero; first stop reason wins; STOP_UNPROVEN + quarantine; PID-reuse aware; lease heartbeat/release |
| `apps/desktop/src/executor/native-lifetime/owner-watchdog.ts` | Independent owner-hang watchdog contract: pure `evaluateWatchdog` (owner exit → hard deadline → lease progress on watchdog's own clock) + `runOwnerWatchdog` with bounded drain proof |
| `apps/desktop/tests/hark-native-lifetime/*` | Deterministic simulated Win32 kernel (16 injectable faults, kill-on-close, active limit, owner crash, watchdog duplicate handle) + 3 node:test suites |
| `scripts/hark/*` | Zero-dependency offline runner: Node type stripping, `.js→.ts` resolver, guard denying net/dns/http(s)/fetch/child_process/dlopen/koffi/.node |

## Real test evidence (this host: Linux aarch64, Node 22.23.3)
Command: `node scripts/hark/test-hark-offline.mjs`
| Run | Result | Cause |
|---|---|---|
| run1 | 29 tests / 28 pass / 1 fail, exit 1 | Test expectation wrong: truncated list followed by consistent post-terminate read-back is legitimately proven drained (FAILED, not STOP_UNPROVEN). Assertion corrected + a persistent-truncation case added. Product code unchanged. |
| run2 | 65 / 64 / 1, exit 1 | Test bug: `path.join` normalised the `..` probe. Fixed by passing raw string. |
| run3 | 65 / 64 / 1, exit 1 | Test isolation bug: hard link raised nlink of shared fixture. Moved to own workspace. |
| **run4 (final)** | **65 tests / 65 pass / 0 fail / 0 skip, exit 0** | — |
| guard-probe | 3 / 3 pass, exit 0 | fetch, child_process.spawn, `require('koffi')` all denied inside tests |
| check-boundaries / check-architecture | exit 0 / exit 0 | After the change |

Counts are per invocation; not added to any other lane's or historical numbers. Raw stdout/stderr/exit files and SHA256 list are in the lane evidence directory (`evidence/H1-3B3E-offline`, `evidence/evidence-sha256.txt`).

## Failure / unknown matrix
| Item | State |
|---|---|
| Adapter state logic & fail-closed under injected faults | PASS (simulated kernel only) |
| Owner-hang watchdog decision + simulated termination | PASS (simulated) |
| Real Win32 Job/CreateProcess/JOB_LIST behaviour | **NOT RUN** (no Windows x64 host; binding not approved) |
| koffi@3.3.3 binding | **BLOCKED** — candidate only; not downloaded/installed |
| Watchdog process spawn, DuplicateHandle, lease transport | **BLOCKED** (needs native binding + Windows) |
| TOCTOU between pin verification and CreateProcess | OPEN (needs handle-pinned launch review) |
| TypeScript typecheck / ESLint / Vitest regression | **NOT RUN** (no dependencies; download not authorized) |
| scripts/tests baseline | 20/31 pass; 11 environment failures preserved |
| Supervisor integration, real DSH/Provider, trusted price/budget, Windows file/network isolation | BLOCKED (unchanged) |

## Reproduce
1. `python verify_package.py` (package) → PASS.
2. In the lane repo: `node scripts/hark/test-hark-offline.mjs` (Node ≥ 22.18; earlier 22.x adds `--experimental-strip-types` automatically).
3. `node scripts/check-boundaries.mjs && node scripts/check-architecture.mjs`.

## Independent review request
Review the four source files against ADR-0034's contract and the TAKEOVER_REPORT findings. Self-review is not independent review; this scope stays open until an independent PASS.
