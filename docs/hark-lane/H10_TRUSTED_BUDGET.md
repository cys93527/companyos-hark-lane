# H10 — Operator-attested trusted budget + live planning Goal attempt (2026-10-25)

User approval (chat 2026-10-25): planning-only tiny Goal, cost cap CNY 1.

## Changes (c142ed2, fix 2nd commit)
- `apps/desktop/src/deployment-budget-proof.ts`: PRODUCTION_VERIFIED TrustedBudgetProofSource whose trust root is the
  operator file `<userData>/budget/approvals.json` + sha256-addressed proofs. Env is never consulted; approval re-read on every
  call (revocation immediate); identity only on exact provider/model/endpoint/credential match; expired proofs not selected.
- `production-composition.ts`: optional `budgetCap` only together with a PRODUCTION_VERIFIED source; otherwise fail-closed
  default (maxCostMicros 0) unchanged. `main.ts` loads userData/budget at both composition sites.
- `scripts/hark/make-budget-approval.mjs` + `installer/budget/deepseek-flash.approval-template.json`: DeepSeek `deepseek-flash`
  proof at worst-case peak cache-miss rates from https://api-docs.deepseek.com/zh-cn/quick_start/pricing (input CNY 2/M, output
  CNY 8/M), bound 24k in + 8k out per call = CNY 0.112; cap 6 calls / 200k tokens / CNY 1.00 / 10 min.
- `.github/workflows/hark-live-goal.yml` (dispatch only, id 395634173) + `scripts/hark/live-goal-planning.mjs`.
- Note: `deepseek-chat` (used by H9) is no longer listed on the pricing page; H10 uses `deepseek-flash`.

## Real results
| Check | Result |
|---|---|
| offline node:test (incl. 9 new budget tests) | 126/126 local |
| first CI hark-windows 40161095494 @c142ed2 | FAIL (typecheck TS5097 `.ts` import in new test) — kept |
| hark-installer 40161095500 @c142ed2 | success |
| live goal 40161398936 (installed app, Node 24.21.0 / Electron 44.5.1) | Goal created; budget policy initialized from attested proof (6 calls / 200k / 1,000,000 micro-CNY); driver stopped at preflight `EXTERNAL_PRECONDITION_BLOCKED / EXECUTOR_PROVIDER_UNKNOWN` |
| model calls / spend | 0 / CNY 0 |

## Matrix
- Trusted budget proof + cap reach production composition: PASS (Hark self-review).
- Planning turn with real model: NOT RUN — canonical preflight requires the work-kind executor (dsh-headless) to be registered;
  DSH runtime is not packaged/approved, so the Goal fails closed before planning. Correct per strategy ("any missing precondition => no dispatch").
- Settlement of a real reservation under the proof: NOT RUN.
- Independent review: not granted.
