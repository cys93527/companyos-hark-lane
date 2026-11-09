# Live contract-fill run 12 fixes

Run: hark-live-goal 42577881852 (resumed from 42564411429), CNY 4.989861 settled, 674 calls all KNOWN.
Result INCOMPLETE: `DRIVER_AUTONOMY_BUDGET_EXHAUSTED` (corrective cycles 3 reached the goal-level cap).
All 7 planned stages ran; the generated project's own `npm test` exited 0 in the independent harness check.

## Root causes and fixes

1. **`repo.test-check` stdio encoding** (`apps/desktop/src/repo-test-process.ts`). The validator runs the
   workspace test contract with an allowlisted environment and decodes the captured output as UTF-8, but a
   Python test runner writing to a pipe uses the ANSI code page (cp1252 on the en-US runner). The generated
   tests print Chinese, so every software stage failed with `UnicodeEncodeError` (exit 1) and corrective
   rework could never fix it. Fix: constant `UTF8_STDIO_ENV` (`PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`) is
   set on the child — constants, never copied from the parent environment (ADR-0028 D12 unchanged).
2. **`evidence.grounding-check` false positives** (`packages/engine/src/validation/evidence-grounding-tool.ts`).
   Reports about the .docx exporter named archive members (`word/document.xml`, `_rels/.rels`,
   `[Content_Types].xml`) and were failed as "named path not found in workspace". Fix: a token that is not
   under an existing workspace directory and that the workspace text names verbatim is a grounded reference;
   a missing file under an existing workspace directory remains a strict, unsupported path claim.
3. **Harness hang** (`.github/workflows/hark-live-goal.yml`). `Start-Process -Wait` also waits for every
   descendant; a process left running after the driver finished kept the step waiting ~3 h until the step
   timeout. The step now waits for the driver process only, writes `leftover-processes.txt` to the evidence
   and ends what was left.

Regression tests: `tests/hark/live-contract-fill-run12.test.ts`.
