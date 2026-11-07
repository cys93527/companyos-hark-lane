# Live contract-fill run 6 — root fixes (Hark lane, offline candidate, not an acceptance verdict)

Run 6 = `hark-live-goal` 42385697784 on c7b2a4c: INCOMPLETE / TERMINAL_FAILED, CNY 6.502398
(171 calls, all KNOWN). Step 1 failed after three kernel attempts, each ending with kernel
`turn_end` reason `error` (~55 model calls each).

## Root cause (derived from run evidence + the pinned kernel source)

The contract-fill route ran with a 96 000-byte admission input bound, so the kernel working
window was 96 000 / 4 = 24 000 tokens, while the route `max_tokens` had been raised to 16 384
after run 5. The profile rendered compaction-basic `headroomTokens` and summary `maxTokens` as
the route `max_tokens`. compaction-basic's automatic threshold is
`min(window × 0.8, window − reservedCompletion − headroom)` = `min(19 200, 24 000 − 16 384 − 16 384)`
< 0, which it treats as a configuration error: it warns once and **never compacts on pressure**.
The only remaining reduction was the broker's `context_length_exceeded` answer at the byte
bound, which compaction-basic retries **once** per request (`maxOverflowRetries` default 1).
The ledger shows every attempt growing to ~28k tokens per call, dropping to ~8k after an
overflow compaction, and ending at ~28k; each attempt also had exactly one exchange without
usage (174 exchanges vs 171 settled calls), consistent with a final refused overflow. The
kernel then ended the turn with an `LlmError` → `turn_end {kind:"error"}`. The exact message was
not captured by run 6 (fix 1 now captures it), so this is the strongest evidence-based cause,
to be confirmed by run 7's captured kernel error.

Fix: compaction headroom and summary `max_tokens` are capped at 4096 (independent of the route
ceiling), `compactionRetries: 2`, `maxOverflowRetries: 3`; the contract-fill input bound is
192 000 bytes (48 000-token window → threshold 27 520 tokens; per-call bound CNY 0.515; maxCalls
450 as the runaway guard, maxTokens 93 772 800 within the 100M approval limit); and the provider
refuses to spawn when the sizing leaves a threshold under 12 000 tokens
(`EXECUTOR_KERNEL_CONTEXT_WINDOW_TOO_SMALL`) instead of silently disabling compaction.
Regression: `tests/hark/h15d-context-window.test.ts`.

## Other fixes

1. **Kernel error capture** — `executor.dispatch_settled` now carries `kernelError {kind, code,
   message}`, `kernelEventsTail` and `stderrTail`; goal.workspace exposes `detailMessage`; the UI
   reason reads `智能体内核异常结束（error）：CODE: message`; the live harness records
   `attemptFailures` and `live-summary.mjs` prints them into the job log.
2. **Retry cost** — a retry starts a fresh, small kernel context (never a session replay) with a
   project-only inventory (caches/dependency stores excluded — run 6's `.npm-cache` filled the
   60-entry inventory) and the previous attempt's compact notes (last actions, last note, end
   reason) kept in `.companyos/attempt-notes/<task>.json`. **Per-step spend cap**: one step may
   spend at most 35 % of the goal money cap (`COS_STEP_SPEND_CAP_RATIO`, (0, 1]); admission
   refuses the next call past it and the driver stops with the standing block
   `GOAL_STEP_SPEND_CAP_REACHED` (UI: 已阻塞 · 单个步骤的花费已达上限…).
3. **Usage coverage** — the usage panel reads the settled budget ledger: with every ledger call
   KNOWN there is no unknown dispatch (coverage 100 %); a body refused before any upstream HTTP
   is a proven zero, not an unknown exchange.
4. **Evidence size** — the evidence workspace copy and file list skip `node_modules`, npm/pnpm/yarn
   caches, `.git`, venvs; copy bounded at 2 MB per file and 40 MB total
   (`scripts/hark/evidence-filter.mjs`).

Tests: `tests/hark/live-contract-fill-run6.test.ts`, `tests/hark/h15d-context-window.test.ts`.
