# Live contract-fill run 17 fixes

Run: hark-live-goal 42730130436 (2026-11-10, resume of 42711818830). Result INCOMPLETE:
`DRIVER_AUTONOMY_BUDGET_EXHAUSTED` after 3 corrective rounds. The generated contract-fill app
passed its own suite (78/78), but every `repo.test-check` ended `timedOut` after 510 s and
`evidence.grounding-check` failed on the step-5 answer.

## Root causes

1. **Validator output capture kept the head, not the tail.** `runRepoTestContract` stored the
   first 16 KiB of stdout (then stderr) and dropped everything after 32 KiB. A test contract
   stopped by its deadline therefore reported its early, passing tests as "last output" — never
   the test that was still running (here: LibreOffice probes/conversions, `soffice.exe → ETIMEDOUT`).
2. **Corrective tasks did not say why they were redone.** A `VALIDATION_FAILED` corrective task
   reached the coding kernel with only `causeEvidenceRefs: ["val_…", "art_…"]`. The kernel
   searched the workspace for the validation id, reworked unrelated UI text, and never learned
   that the test command overran the validator deadline or which grounding claims were unsupported.

## Fixes

- `apps/desktop/src/repo-test-process.ts`: a rolling window (`keepRecentOutput`) of the most recent
  32 KiB of stdout+stderr in arrival order, decoded as UTF-8 per stream.
- `apps/desktop/src/executor/corrective-cause-detail.ts` (new): resolves the cited failing
  validations → their validator report artifact → CAS bytes, and renders a bounded plain block
  (command, timeout/exit code, reasons, unsupported claims, last output). Context only; verdicts,
  causes, lineage and authority are unchanged.
- `core-services.ts` `workContextOf` attaches the block as `correctiveCauses` on the work envelope;
  `provider-dispatch.ts` carries it; `dshTaskTextOf` renders it after the plan context.

## Regression

`tests/hark/live-contract-fill-run17.test.ts` (rolling tail under a deadline; cause resolution and
rendering incl. unreadable-store degrade; task-text placement; composition/dispatch wiring).
