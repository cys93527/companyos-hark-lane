# Hark lane H3 — Windows x64 CI + native Job Object (koffi@3.3.3, CI only)

Status: native lifetime primitives EVIDENCED on GitHub-hosted windows-2022. Independent review is still PENDING. This is not Hark final acceptance.

## Authorization
- 2026-10-24: the user approved adding a push trigger on the hark-lane branch, because workflow_dispatch was never registered (API 404).
- 2026-10-24: the user approved koffi@3.3.3 on CI only. It is installed into RUNNER_TEMP, outside the repo and the lockfile, with `npm --ignore-scripts`. Before install, the tarball integrity of koffi and @koromix/koffi-win32-x64 is checked against the pinned sha512, and the installed package-lock is checked again after.

## Runs (raw evidence under lane/evidence/H3-windows-ci and lane/evidence/H3-native)
| Run | Commit | Result | First failure |
|---|---|---|---|
| 40104986563 | 4a29346 | failure | offline 63/65: test used POSIX '/' as outside path (drive-relative on Windows → path-not-canonical). Product fail-closed correctly; test fixed in f149476 |
| 40105162320 | f149476 | success | install/typecheck/lint/offline 65/65/boundaries/architecture all green |
| 40106283757 | a38b382 | failure | CI script: ConvertFrom-Json rejects package-lock empty root key; koffi integrity had matched; native tests skipped. Fixed 59f0248 (-AsHashTable) |
| 40106440529 | 59f0248 | success | offline 65/65, gates 0, koffi integrity OK, **native 7/7** |

Host: Microsoft Windows NT 10.0.20348.0, AMD64, Node v24.19.0, pnpm 11.25.0.

## Native tests (apps/desktop/tests/hark-native-lifetime/native/job-native.win-test.ts)
1. The Job handle is non-inheritable. KILL_ON_JOB_CLOSE plus ACTIVE_PROCESS are read back (flags 8200, limit 8), and no breakaway flag is set.
2. PROC_THREAD_ATTRIBUTE_JOB_LIST: the child is a Job member while still suspended (members = {1,[pid]}). Resume returns 1. The identity image path matches the pinned copy, and closing the last Job handle kills the child.
3. Legacy create-then-assign: the child is outside the Job, then a member after assign. TerminateJobObject reaps it with the CompanyOS stop code, and the active count drops to 0.
4. Adapter: normal → EXITED (ATOMIC, drained, identity coverage complete, handles closed).
5. Adapter: exit 17 → FAILED with the real code.
6. Adapter: timeout with a grandchild → TIMEOUT. Root and grandchild are both gone, and the descendant is observed.
7. Adapter: cancellation → CANCELLED, drained.

## Findings for review (not hidden)
- conhost.exe is a real Job member of console children (it appears as a DESCENDANT). Coverage accounting includes it.
- In the cancellation run, errors contain `TerminateProcess` nativeCode 5 (ACCESS_DENIED), most likely racing the Job termination of an already-exiting root. The outcome stayed CANCELLED with the Job drained. A reviewer should decide whether this must become STOP_UNPROVEN or be classified as benign once drain is proven.

## Still NOT proven
Independent watchdog process with DuplicateHandle/lease transport on native; handle-pinned launch (TOCTOU between hash pin and CreateProcessW); Supervisor/dispatch wiring; Electron; installer; normal-user install/uninstall; independent review.
