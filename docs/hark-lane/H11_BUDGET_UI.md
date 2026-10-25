# H11 — Budget / spend / UNKNOWN / previewed-plan view (2026-10-25)

Hark self-review PASS for this layer only. Not independent review, not product acceptance.

## What changed
- `apps/desktop/src/efficiency/goal-budget-projection.ts` — pure projection of the durable `GoalExecutionBudget` (the same facts admission reads):
  KNOWN settled exactly; UNKNOWN counted at its full trusted bound and listed separately (never zero, never replayed);
  RESERVED held at bound; remaining = worst-case allowance, never negative; states NO_BUDGET / ZERO_COST_POLICY / ACTIVE / CANCELLED / EXPIRED.
  Currency only from the deployment's trusted proof source; absent ⇒ raw units, said plainly.
- `control-plane.ts` — new read-only op `run.budget` (company-scoped, owned run) returning `{budget, plan}`; `plan` is the latest `companyos:plan` artifact (items + acceptance criteria). No admission, no dispatch.
- `core-services.ts` — wires `goalBudget` (`database.executionBudget.read`, trusted currency).
- Renderer: `budget.ts` (strict parse ⇒ malformed renders nothing; Chinese rows), runtime panel 运行 tab shows 费用 rows and 计划预览（未执行） while no work task exists; `App.tsx` loads it per open Goal on refresh.

## Tests (real output in lane/evidence/H11-budget-ui/)
| run | result |
|---|---|
| offline-run1 | 131 pass / 1 fail — first failure kept: my B4 expectation was wrong (700000 − 6×112000 = 28000, not 0) |
| offline-run2 | 132/132 |
| vitest-run1 (renderer h11 + stage2/3) | 72/72 |
| vitest-preview-run1 (tests/hark/h11-plan-preview, REAL composition) | 3/3: P1 no opt-in ⇒ blocked before planning, 0 model calls; P2 opt-in ⇒ 1 planning call, 0 work tasks, re-advance typed EXECUTOR_PROVIDER_UNKNOWN planReady, no 2nd call, run.budget returns the 2-item plan; P3 unknown/foreign run refused |
| vitest-run2 | 3 failures in runtime-refresh.test.ts: its harness enumerates read ops and left the new `run.budget` read pending (baseline at HEAD: 20/20) |
| vitest-run3 (after adding run.budget to that harness's read-op list) | 212/212 |
| eslint / typecheck / boundaries / architecture | 0 / 0 / 0 / 0 |

| vitest-full (whole suite, after H11) | 39 failed / 3711 passed of 3750. Versus the H2 baseline failure set: 5 baseline-flaky items did not fail this time; 2 new: `sprint6/boundary` credential scan timed out at 30 s under load (passes alone, 5/5), and **`production/pre-dispatch-failure` "unknown executor provider" — a real H10b regression** (see fix) |
| vitest-run4-after-optin-fix | 62/62 incl. pre-dispatch-failure, boundary, stage3-seams, h11, runtime-refresh |
| vitest-run5-hark | 4/4 (adds P4: preview is opt-in only) |
| offline-run3 | 132/132 |

## H10b regression found and fixed here
H10b turned `planPreviewWithoutExecutor` on for EVERY production composition. That changed a pre-existing contract:
a dispatch to an unknown executor must leave a durable typed FAILED attempt (LIVE-SMOKE-FIX-04). Fix: the preview is now an
explicit operator opt-in, `COS_PLAN_PREVIEW_WITHOUT_EXECUTOR=1` (exactly "1"); `hark-live-goal.yml` sets it. Default production
behaviour is back to pre-H10b (preflight blocks before planning; no model call). H10b live evidence remains valid because that run
is now reproduced by the opt-in. My H10b full-suite sweep was missing; it is now part of every stage.

## Not done / limits
- No boss "approve plan → execute" button: execution needs the DSH runtime / native.job wiring (approval required). The view is read-only.
- Not tried on a real user PC; Windows CI covers typecheck/lint/offline only for this stage.
