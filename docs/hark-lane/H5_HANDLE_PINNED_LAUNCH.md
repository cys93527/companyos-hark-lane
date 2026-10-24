# H5 — Handle-pinned launch (TOCTOU) — Hark lane

Status: **Hark self-review PASS (H5 scope)**. Independent Review: **NOT GRANTED** (cannot self-grant). Not production-wired into Supervisor.

## Problem
`verifyLaunch()` (H1) hashes the executable and inputs by path. Between that hash and `CreateProcessW` (and, for inputs, until the child reads them), the path could be redirected or the bytes swapped.

## Changes
- `src/executor/native-lifetime/file-pins.ts` (new): `pinLaunch(launch, FilePinPort)`
  1. Every ancestor directory (drive root → parent) is opened `FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|SYNCHRONIZE`, share `READ|WRITE` (deny DELETE ⇒ no rename/move), `FILE_FLAG_OPEN_REPARSE_POINT|BACKUP_SEMANTICS`. These are pinned before any file is opened.
  2. The executable and its inputs are opened `GENERIC_READ`, share `READ` only (deny write/delete ⇒ no rewrite, unlink, rename, or rename-over), `OPEN_REPARSE_POINT`.
  3. It refuses: a reparse point anywhere; a final path (`GetFinalPathNameByHandleW`) that differs from the requested path; a UNC path; links ≠ 1; a size change; anything too large.
  4. The SHA-256 is recomputed **through the pinned handle** and must equal the verified pin.
  5. Partial pins are released on any refusal.
- `job-lifetime.ts`: `launchPinning: 'REQUIRED'` is the **default**. With no `pinPort` it refuses `launch-pinning-unavailable` before any native call. Pinning happens before `createJob`. After the membership read-back, the root's `QueryFullProcessImageNameW` path must equal the pinned executable's final path before resume, else `image-path-mismatch` (never resumed). Pins are released only after all handles are closed. The result has `launchPinned`.
- `koffi-job-port.ts`: `createKoffiFilePinPort` (CreateFileW / GetFileInformationByHandle / GetFinalPathNameByHandleW / ReadFile / CloseHandle).
- Tests: `file-pins.node-test.ts` (offline, simulated pin port over Node fs), `node-fs-pin-port.ts`, `native/pins-native.win-test.ts`. Every native adapter test (H3/H4 too) now runs pinned.

## Results (real)
| Run | Where | Offline | Native | Notes |
|---|---|---|---|---|
| local-1 | Linux sandbox | 86/86 | NOT RUN | |
| local-3 | Linux sandbox | 87/87 | NOT RUN | typecheck/lint/gates exit 0 |
| CI 40109275557 @88080fb | Win Server 2022 | 86/86 | **16/18 FAIL** | test bug: the hard link and junction were created BEFORE verifyLaunch, which already refused them (`path-not-single-link-file`, `path-alias`), so the pin layer was never reached |
| CI 40109482553 @7a87828 | Win Server 2022 10.0.20348.0, AMD64, Node v24.19.0 | 87/87 | **19/19 PASS** | all steps green |

Native evidence (40109482553):
- While pinned: exe write/delete/rename → `EBUSY`. Script write → `EBUSY`. Rename-over the script → `EPERM`. A hard link created while pinned: creation is allowed, writing through it → `EBUSY` (sharing is per file object). Parent dir and workspace rename → `EBUSY`. Reads → allowed. After release, renames are allowed again.
- A dir swapped for a junction after verify → `reparse-point:…\bin`. A hard link added after verify → `multi-link`. Content swapped after verify → `hash-mismatch`.
- Adapter run: event order `launch-pinned → job-created → … → membership-verified → image-path-verified → resumed → … → handles-close-attempted → pins-released`. Writing the script mid-run → `EBUSY`. Errors `[]`.

## Failure / unknown matrix
| Item | Status |
|---|---|
| Rewrite/rename/delete of exe/input during the run | PROVEN denied (native) |
| Directory chain rename | PROVEN denied (native) |
| Junction / reparse redirection after verify | PROVEN refused (native) |
| Hard-link alias | PROVEN: refused at pin time, and writes through a new link denied |
| Image path ≠ pinned exe | refused before resume (offline simulated; native happy path verified) |
| Admin / kernel / backup-privilege actor bypassing share modes | NOT COVERED (out of threat model) |
| DLLs loaded by the exe (search order) | NOT COVERED |
| Same-user read access to inputs | NOT COVERED (no ACL change; requires approval) |
| Supervisor production wiring | NOT DONE |
| Independent review | NOT GRANTED |

## Reproduce
`node scripts/hark/test-hark-offline.mjs`; native: push to `hark-lane` (workflow `hark-windows.yml`), evidence in `lane/evidence/H5-pinned-launch/`.

## Review request
Check: whether the share modes are complete (does `FILE_SHARE_READ` alone block every write path, including memory-mapped writes?); whether directory pins need `FILE_LIST_DIRECTORY` to be enforced; whether the image-path compare is sufficient versus a file-ID compare; and the DLL-planting gap.
