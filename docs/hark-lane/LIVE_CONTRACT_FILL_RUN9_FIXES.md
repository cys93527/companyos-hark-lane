# Live contract-fill run 9 fixes

Run: hark-live-goal 42429421366 (2026-11-08 08:36–09:19 CST), INCOMPLETE —
`GOAL_STEP_SPEND_CAP_REACHED`. 282 model calls, all KNOWN, CNY 2.317. The run-8 scope fix held
(step 1 built only the core library), but step 1 still did not converge.

## What happened

Step 1 (core library: docx fields, matcher, fill, **and PDF export**) ran its whole 30-minute
attempt (178 calls, CNY 1.572) and timed out without a final answer, although its tests passed
(5 pass, 1 skipped). The skipped test was PDF export: the engineering directive recommends
LibreOffice (`soffice`), which the Windows live runner does not have, and the kernel spent the
attempt chasing it. The retry (attempt 2) re-read the project and was refused at the step's spend
share (35 % of CNY 8) → standing block.

## Root causes

1. The test environment lacked a tool the plan depended on, and nothing told the kernel so.
2. "Answer as soon as the criteria are met" was prompt-only; the kernel never knew how much time
   or money its attempt had left.
3. A timed-out attempt's verified work was thrown away: the step was retried from scratch.
4. The planner mixed an environment-dependent capability (PDF conversion) into the core step.

## Fixes

1. **Test environment** — `hark-live-goal.yml` (custom job) installs LibreOffice first
   (`choco install libreoffice-fresh`, 30-min step timeout, 3 attempts), puts
   `C:\Program Files\LibreOffice\program` on `GITHUB_PATH`, verifies `soffice --version`
   (bounded) and stops the job before any build or model spend if it fails. This is a tool for the
   user's generated project, not a CompanyOS dependency. The kernel task text now carries an
   `Environment (detected by CompanyOS on this machine): …` line (`attempt-wrap-up.ts`:
   `detectExternalTools` on PATH + well-known dirs) that says whether `soffice` exists; when it is
   missing the kernel is told not to search for or install it and to degrade with a clear message.
2. **Wrap-up mechanism** — the loopback broker gained `rewriteRequest`, applied to every model
   request before admission (so admission meters the body actually sent). The embedded provider
   appends a `[CompanyOS status]` note to the LAST message (prefix cache and role order intact):
   time left in the attempt and spend left in the step (`modelCallBudgetStatus`, read from the
   durable ledger by the execution-safety coordinator's `stepBudget`). Below a threshold the note
   becomes `[CompanyOS WRAP-UP — mandatory]` (stop new work, run the tests, final answer with what
   is done and what remains); after a bounded number of wrap-up turns the broker stops admitting
   and the attempt drains as a resumable timeout. Env: `COS_WRAPUP_STEP_SPEND_LEFT_RATIO`
   (default 0.2), `COS_WRAPUP_ATTEMPT_MS_LEFT` (default 300000), `COS_WRAPUP_MAX_TURNS`
   (default 12).
3. **Credit verified work** — `verified-work-credit.ts`. A live tap reads every `tool_call` /
   `tool_result` of the attempt (CompanyOS never runs kernel-written code itself). An attempt that
   ended by time or the spend cap is credited as done (files kept, `executor.verified_work_credited`
   evidence event, synthesized final text naming the test run and criteria) only when its last
   test run passed (recognised node:test / vitest / jest / mocha / pytest summary, ≥ 1 pass,
   0 fail), nothing that can change the workspace ran after it, every criterion is proven by a
   passing test named `[criterion-id] …` and by no failing or skipped one, and the step needs no
   declared file delivery. Otherwise it stays a resumable timeout and the retry continues from the
   attempt notes. The task text asks for criterion-named tests (`VERIFICATION_DIRECTIVE`). Run 9
   as it happened would NOT be credited (the PDF criterion was only skipped) — correct.
4. **Planner** — the planner contract now keeps environment-dependent capabilities (office-suite
   PDF conversion, printing, OCR, OS services/integration) in their own work item with their own
   criterion, never mixed into the core library item.

Regression: `tests/hark/live-contract-fill-run9.test.ts` (thresholds, notes, injection, broker
rewrite/drain, tool detection, task text, workflow step, summaries, criterion mapping, credit
decision, planner contract), `tests/production/e2-minimum-sufficient-planning.test.ts` (composed
planner prompt), `tests/kernel/run9-verified-work-credit.test.ts` (end to end through the embedded
provider with a fixture kernel; kernel gate).
