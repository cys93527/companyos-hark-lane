# Live contract-fill run 11 fixes

Run: hark-live-goal 42564411429 @ bae8ac6 (custom goal: cross-platform contract auto-fill app).
Result: INCOMPLETE `GOAL_BUDGET_EXHAUSTED` after 450 calls — planning plus steps 1–5 of 6 DONE (field
detection, manual/paste entry, responsive UI, Word export, PDF export), step 6 refused admission.
Spend CNY 3.157935 of the CNY 8 per-run cap.

## 1. The call guard was sized by worst-case tokens

`installer/budget/deepseek-flash.contract-fill.approval-template.json` had `maxCalls 450` =
`maxTokens 93 772 800 / 208 384` (one call's worst-case input + output bound). The goal envelope
(`packages/engine/src/runtime/goal-execution-budget.ts`) counts settled calls at their real usage
(~4.5k tokens, ~7 000 micros in run 11), so the product was never a reachable bound and the guard
stopped the run at 39% of its money cap.

Fix: `maxCalls 1000` (the policy ceiling enforced by the engine, persistence and the approval parser),
`maxTokens 100 000 000` (the approval ceiling). Money (`maxCostMicros`, CNY 8) and real tokens bound the
run; the call guard stays the runaway guard. Regression: `tests/hark/live-custom-goal.test.ts`.

## 2. Work that already exists is reused, not rebuilt

- CompanyOS (`apps/desktop/src/executor/workspace-inventory.ts`): each kernel attempt's task text lists
  the files already in its workspace (bounded: 60 files, depth 4, 5 000 entries; dependency stores,
  caches and VCS data skipped) with a directive to inspect, run the existing tests, and reuse / extend /
  fix rather than rewrite. Applies to later steps, retry attempts and continued runs alike. Read-only.
- Workflow `hark-live-goal` custom mode: new input `resume_from_run` — a completed hark-live-goal run of
  this repository (verified via the API) whose evidence `workspace/` seeds the user's project folder
  before the goal starts; recorded in `resume-source.txt`. The goal text is unchanged.

Regression: `tests/hark/live-contract-fill-run11.test.ts`.

## 3. Independent project check under the runner locale (harness)

`npm test` of the generated Python project failed only with `UnicodeEncodeError` (cp1252 console on the
en-US runner; LibreOffice's Python first on PATH). The check now runs with `PYTHONUTF8=1` and
`PYTHONIOENCODING=utf-8` (`scripts/hark/live-goal-gui.mjs`).
