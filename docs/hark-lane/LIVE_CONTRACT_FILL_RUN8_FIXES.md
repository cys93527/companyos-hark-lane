# Live contract-fill run 8 fixes

Run: hark-live-goal 42419993676 (2026-11-08 06:34–06:57 CST), INCOMPLETE —
`GOAL_STEP_SPEND_CAP_REACHED`. 192 model calls, all KNOWN, CNY 2.317 (the run-7 cache-hit
pricing fix held: 192 calls cost what 57 cost in run 7).

## What happened

Planning produced 5 software-work steps + 1 work step. Step 1 was "基于成熟的 Word 文档解析库实现
跨平台合同模板解析与可填充字段自动识别". The kernel worked on it for 21 minutes and wrote the
**whole** application — `server.js`, `public/{index.html,app.js,styles.css}`, `src/paste.js`,
`src/preview.js`, `src/pdf.js`, `src/docx/{parse,detect,fill}.js` — i.e. the work of steps 2–5,
then kept probing field detection until the step's 35 % spend share ran out.

## Root cause

The kernel task text carried the step objective plus `Goal: <whole goal>` but nothing told the
kernel that the goal is split into steps that run separately. A capable agent seeing the full
goal builds the full goal inside step 1; a step's spend share (a correct guard) then stops it
mid-work and the goal blocks with no step finished.

## Fix

- `WorkPackage.plan` (engine projector): the pinned version's compiled plan-item objectives in
  plan order (≤ 24 steps, ≤ 400 chars each), this task's step marked. Context only.
- `ExecutorWorkInput.planContext` carried from the work envelope (core-services →
  provider-dispatch → executor).
- `dshTaskTextOf` renders `Plan position: this task is step k of N`, lists every step with
  `(THIS task)` / `(another task — not yours)`, and `STEP_SCOPE_DIRECTIVE`: do only this step,
  do not implement the other steps, work economically, answer as soon as this step's criteria
  are met. Single-step goals get no plan lines.

Regression: `tests/hark/live-contract-fill-run8.test.ts`, plan assertions in
`tests/sprint20/t20-06-work-package.test.ts`.
