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

## H10b — plan-only preview mode (2026-10-25, user approved option B)

Changes (no new state machine):
- `control-plane.ts`: optional `executionAvailable()` dep. After a successful planning turn, if no executor is available, `goal.advance` returns typed `EXECUTOR_PROVIDER_UNKNOWN` (`planReady:true`) and never compiles or dispatches. Planning replays are idempotent.
- `core-services.ts`: `planPreviewWithoutExecutor` option; when set, the `executor-provider` doctor check stays `fail` but is no longer `requiredForGoal` (gate moved to dispatch time). Only `production-composition.ts` opts in.
- `openai-compatible-provider.ts`: explicit `COS_MODEL_STRUCTURED_OUTPUT=json_schema|json_object`. DeepSeek accepts only `json_object` (official JSON Output guide); in that mode the schema is sent as a system instruction and output is still parsed and validated by the caller.
- Harness/workflow: wait for the GUI-subsystem `CompanyOS.exe` with `Start-Process -Wait`; robust evidence finish.

Runs (all kept):
| run | result | note |
|---|---|---|
| 40162107073 | NON_RECOVERABLE_FAILURE, HTTP 400 invalid_request | preview gate worked; adapter sent `json_schema`, DeepSeek rejected. Reservation left `UNKNOWN` (conservative; bound ¥0.112). |
| 40162636756 | no evidence (harness bug) | pwsh `&` did not wait for the GUI exe; uninstall/upload ran mid-goal. Spend unknown, bound ¥0.112. |
| 40162770951 | **PLAN_READY_EXECUTION_BLOCKED** | 1 DeepSeek call, 1402 in / 367 out tokens, settled KNOWN 5,740 micro-CNY (¥0.00574), planning task DONE, `run.plan_ready`, plan artifact 1 item / 2 acceptance criteria, driver `EXTERNAL_PRECONDITION_BLOCKED: EXECUTOR_PROVIDER_UNKNOWN`, 0 compile/dispatch, no key in evidence. |

Not proven: execution, validation, delivery, DSH runtime, `native.job` production wiring. Goal run is left `EXECUTING` at the plan gate (the boss-approval UI for previewed plans is H11 work). Hark self-review PASS for the preview layer only; not independent review.
