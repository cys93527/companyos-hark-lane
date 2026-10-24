# H4 — Native lifetime completion: binding failure / owner crash / owner hang (Hark lane)

Date: 2026-10-24 (HKT). Authorisation: koffi@3.3.3 on Windows CI only (user, 2026-10-24); the user
asked Hark to follow the outline and decide stage gates itself (2026-10-24 23:23 HKT).
Independent review is still required by the outline and is NOT self-granted here.

## Changes (commits 4f8ab1b, 9950b33)
| Area | Change |
|---|---|
| job-lifetime.ts | Stop path no longer calls TerminateProcess on a natively verified member root after a successful TerminateJobObject (H3 race, ERROR_ACCESS_DENIED). TerminateProcess ACCESS_DENIED (5) is benign ONLY if the root is then proven exited; otherwise it is reported and the run is STOP_UNPROVEN + quarantine. New `onJobReady(job)` hook runs after Job configure/read-back and BEFORE any process exists; a throw = LAUNCH_FAILED with zero processes. |
| lease-file.ts (new) | Owner->watchdog lease: fixed 64-byte record `HL1 <seq> <released> <sha256-16>`, rewritten in place; tampered/torn records decode to null (fail closed); writer refuses a pre-existing file; strictly increasing sequence. Lives in an owner control dir outside the child workspace. |
| watchdog-process.ts (new) | `armNativeWatchdog`: watchdog created suspended OUTSIDE the Job; DuplicateHandle of the Job (JOB_OBJECT_QUERY|TERMINATE only) and of the owner process (SYNCHRONIZE|QUERY_LIMITED only), never SAME_ACCESS; args file then resume. `runNativeWatchdog`: WatchdogPort over its own handles + pure decision loop. |
| koffi-job-port.ts | `createKoffiHandleTransfer` (GetCurrentProcess, DuplicateHandle) with explicit least access. |
| owner-watchdog.ts | Owner exited + well-formed, non-regressed RELEASED lease => RELEASED (caller still proves drain; RELEASE_NOT_DRAINED terminates). Otherwise owner exit still terminates first. |
| Tests | +8 offline (76 total), +7 native (14 total): binding-native, owner-native (+ fixtures owner/watchdog). |

## Real test results (Windows Server 2022 10.0.20348, AMD64, Node v24.19.0)
| Run | Commit | Offline | Native | Result |
|---|---|---|---|---|
| local sandbox run1 | (uncommitted) | 63/65 FAIL — first fix used the claimed `jobMember` flag; atomicCreateNotMember / assignSilentlyIgnored caught it | NOT RUN | first failure kept |
| local sandbox run2 | (uncommitted) | 72/73 FAIL — lease writer did not refuse beat after close when throttled | NOT RUN | first failure kept |
| CI 40107390262 | 4f8ab1b | 73/73 | **13/14 FAIL** — release case: owner released and exited before watchdog first tick -> OWNER_EXITED instead of RELEASED (safe but wrong classification); also TerminateProcess 5 on exiting root | failure kept |
| CI 40107704862 | 9950b33 | 76/76 | **14/14 PASS** | success, all steps |

Native evidence (run 40107704862):
- Binding failure: AssignProcessToJobObject over active limit -> native 1816 (ERROR_NOT_ENOUGH_QUOTA); victim never ran, exit = stop code. Atomic PROC_THREAD_ATTRIBUTE_JOB_LIST create over limit -> CreateProcessW 1816, no process created, Job members unchanged. Adapter membership read-back failure -> LAUNCH_FAILED, resumed=false, root exit 0xE0003E02, no TerminateProcess error.
- Owner (Supervisor stand-in) hard-killed, no watchdog -> root + grandchild dead (kill-on-last-close).
- Owner hard-killed with watchdog holding a Job handle -> watchdog OWNER_EXITED, TERMINATED_DRAINED, root + grandchild dead, watchdog exited.
- Owner alive but event loop blocked -> watchdog OWNER_UNRESPONSIVE after 1.5 s heartbeat silence, TERMINATED_DRAINED, root + grandchild dead, owner still running (hang was real).
- Normal run with watchdog -> owner EXITED, lease `HL1 n 1`, watchdog RELEASED_DRAINED.
- Cancel -> CANCELLED with errors [] (H3 ACCESS_DENIED finding closed).

## Hark self-review stage gate (NOT independent review)
Outline step 3 lifetime items: suspended create, Job read-back, verified membership before resume, non-inheritable handle,
kill-on-close, no breakaway, cancel / timeout / binding failure / supervisor crash with real root+descendant exit and
Job active-zero, uncertain stop blocks further runs (quarantine). **Hark self-review: H4 scope PASS** on the evidence above.

## Still not proven / out of scope
- Handle-pinned launch (TOCTOU between hash verification and CreateProcessW) — next stage H5.
- Supervisor production wiring (adapter + watchdog not in dispatch); watchdog crash itself (then kill-on-close re-arms only if owner also gone — owner still holds its handle; documented, not tested natively).
- Lease forgery by same-user processes outside the Job (control dir ACL not set — system ACL changes unapproved); hard deadline bounds it.
- Job Object is lifetime containment, NOT isolation (no file/network sandbox).
- Electron, installer, ordinary-user install/uninstall, real Provider/DSH, independent review.

## Reproduce
Push to `hark-lane` (workflow `hark-windows`), or locally on Windows x64: install koffi@3.3.3 per H3 doc, set HARK_KOFFI_DIR, `node scripts/hark/test-hark-native.mjs`.
