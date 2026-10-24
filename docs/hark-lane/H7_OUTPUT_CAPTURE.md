# H7 — stdout/stderr capture — Hark lane

Status: **Hark self-review PASS (H7 scope)**. Not production-wired. Independent Review: **NOT GRANTED**.

## Changes
- `job-port.ts`: optional `createOutputPipe` / `pipeAvailable` / `readPipe`. `createSuspendedInJob(..., stdio?)`.
- `koffi-job-port.ts`: `CreatePipe` (64 KiB). The read end has INHERIT cleared. `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` makes the child inherit EXACTLY the two write ends (the Job handle and everything else stay private). `STARTF_USESTDHANDLES` with stdin NULL. Non-blocking pump via `PeekNamedPipe`, then `ReadFile`. `ERROR_BROKEN_PIPE` = EOF.
- `job-lifetime.ts`: `captureOutput: { maxBytes }`. Capture is refused unless the launch is atomic and the port has pipes (`output-capture-unavailable`, zero native calls). The owner checks that the read ends are not inheritable. The owner closes its write ends right after create. The pump runs every poll. A final drain after the Job is drained waits until EOF. Bytes over the cap are counted, not kept. Result: `output { stdout, stderr, droppedBytes, complete }`.
- `job-executor-contract.ts` (C11): `structured-output` is advertised only when the adapter captures output. A structured result requires complete, untruncated stdout that parses to a JSON object (`NATIVE_OUTPUT_INCOMPLETE` / `NATIVE_STRUCTURED_OUTPUT_MALFORMED`). Truncated plain text carries a marker. Failure/timeout outcomes carry bounded diagnostics.

## Results
| Run | Offline | Native |
|---|---|---|
| local-1/2 (typecheck, lint, gates exit 0) | 117/117 | NOT RUN |
| CI 40110944441 @1a7219b (Win Server 2022, Node 24.19.0) | 117/117 | **25/25** |

Native evidence:
- stdout `{"ok":true,...}` and stderr `diag-line` captured separately; complete.
- 3 MiB flood with a 64 KiB cap: EXITED, 65536 kept + 3080192 dropped = 3145728 (the child never deadlocked).
- A descendant that inherits stdio: `root-out;leaf-out;`, and EOF waited for the leaf (conhost is listed as a descendant).
- Contract structured-output: `succeeded` with `structured.value.ok === true`.

## Not covered
- Inheritance of the Job handle into the child is constrained by HANDLE_LIST + a non-inheritable read-back, but no in-child handle enumeration was done.
- stdin is NULL (no interactive input). Non-UTF-8 output is decoded leniently.
- Production wiring / independent review: separate approval.
