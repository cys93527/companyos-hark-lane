# Live contract-fill run 10 fixes

Run: hark-live-goal 42441418492 (2026-11-08 11:23–11:55 CST), INCOMPLETE — `IDLE_NO_PROGRESS`.
126 model calls, all KNOWN, CNY 1.056. The run-9 fixes held for step 1: it finished (core
library — docx field extraction incl. split runs, tables, header/footer, content controls; manual
JSON / pasted-text entry; fuzzy matching; fill — 13 sample templates, tests).

## What happened

Step 2 (data entry + auto-match) started at ~11:34, made its calls until ~11:40 and then went
completely silent: no model call, no kernel output, no event for 15 minutes. The UI kept showing
"执行中 · 尝试 1". The attempt would only have ended at its 30-minute deadline; the live harness
stopped first (15-minute idle limit). The evidence artifact was again refused (storage quota), so
the job log is the only record — and it held no trace of what the kernel was doing.

## Root causes

1. **An attempt that can no longer progress waited for its deadline.** Two paths lead there:
   the run-9 wrap-up drain stopped admitting model calls but left the kernel process running
   (every further request refused → it can only wait until the deadline), and a kernel stuck
   past its own tool timeouts (persistent shell: 300 s) emits nothing at all.
2. **The harness idle limit (15 min) was shorter than the kernel attempt deadline (30 min).**
3. **No diagnostics survive a refused artifact**: the job-log summary had event counts only.

## Fixes

1. `apps/desktop/src/executor/attempt-early-stop.ts` — per-attempt early stop. Kernel stdout
   lines and model-broker requests/exchanges are activity; silence longer than
   `COS_KERNEL_SILENCE_MS` (default 600 000 ms; bounds 120 000..3 600 000; longer than the shell
   tool timeout + a model call) fires `KERNEL_SILENT`; an exhausted wrap-up fires
   `WRAP_UP_DRAINED`. Either ends the attempt exactly like its deadline: broker drain, bounded wait
   for the in-flight call, proven stop, outcome `timeout` (resumable; verified work credited).
2. `packages/engine/src/executor/process-executor-provider.ts` — new composition seam
   `earlyTimeout(fire)`; firing runs the same deadline path once (`beforeTimeoutStop`, then stop).
3. The retry's attempt notes carry the reason and a hint (`KERNEL_SILENT`: never leave a server,
   GUI, watcher or interactive prompt in the foreground; bound every command).
4. Harness: `LIVE_IDLE_STOP_MS` 900 000 → 1 200 000 (> silence + drain grace); `live-goal.json`
   carries `recentEvents` (last 30: type, time, payload head) and the job-log summary prints the
   last 15.

Regression: `tests/hark/live-contract-fill-run10.test.ts`.
