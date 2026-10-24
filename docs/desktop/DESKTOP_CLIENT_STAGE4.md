# DESKTOP CLIENT STAGE 4 — Productization + Canonical Access Policy + Release Candidate

Status: **Implemented; E2E validation-closure blocker identified** (2026-10-05).
Baseline `d9ff985`. Companion: [../product/V1_DESKTOP_SUPPORTED_BOUNDARY.md](../product/V1_DESKTOP_SUPPORTED_BOUNDARY.md).

---

## 1. TL;DR

The Stage-4 productization work is complete: the 访问权限 selector is now REAL (canonically
bound to the Goal, enforced below the renderer by the DSH kernel sandbox), the product
shell/history/empty/error states are finalized, and a REAL release-candidate Goal ran end
to end through the Desktop UI → canonical Goal → Planner → Tasks/Roles → embedded DSH
kernel (real model, real workspace writes) → artifacts — `report.md` was produced in the
workspace with evidence-grounded content and the execution run reached
EXECUTING→REVIEWING→VALIDATING with both work tasks DONE on first attempts.

**The one acceptance criterion that did not complete: the final
VALIDATING→FINALIZING→COMPLETED closure.** The engine (by frozen design, ADR-0020) yields
the VALIDATING transition to the evidence applicator — a bare `VALIDATION.PASS` is refused
by construction — and the desktop dynamic-plan composition does not wire validators for
dynamically planned work, so no validation batch ever exists and the run rests in
`VALIDATING` (Goal `EXECUTING`, typed and visible, never fabricated). This is an OPEN
PRODUCT P1 routed to Boss review; everything else in the stage is green.

---

## 2. Canonical access policy (Section A + PHASE 0 verdicts)

| Question | Verdict |
|---|---|
| AUTHORITY_POLICY_OWNER | **the GOAL itself** — the run-goal artifact's `structured` payload (`RunGoal.structured`, durable CAS artifact) |
| WRITE_SEAM | `goal.create` now validates a closed `accessPolicy` (`ACCESS_POLICIES` = ASK_PERMISSION / READ_ONLY / WORKSPACE_OPERATIONS) and binds it into `goal.structured` (invalid values → `CONTROL_PLANE_ACCESS_POLICY_INVALID`, fail closed) |
| READ_SEAM | `goal.workspace` returns `accessPolicy` (canonical default `ASK_PERMISSION` for pre-Stage-4 goals) |
| ENFORCEMENT | below the renderer: `dshSandboxModeOf` maps `READ_ONLY` → the DSH kernel's own fs-sandbox `read-only` mode (kernel refuses writes; typed `FsError`), rendered into the per-attempt `cordis.patch.yml`; unknown/absent ⇒ `workspace-write`, never broader |
| SCOPE | Goal |

No second authority truth: the policy reuses the existing run-goal artifact + kernel
sandbox + canonical approval boundary. `dshTaskTextOf` also carries the policy as data in
the kernel task text. Changing the selector crosses the typed control-plane command
(`goal.create`) and rehydrates through the canonical read-back — never renderer storage
(no localStorage authority keys; the only client-side store remains the Stage-2
submission-intent outbox).

---

## 3. Productization (Sections B–H, J–N)

* Shell unchanged (frozen Stage-2/3 layout; Settings bottom-left; no Team/Pro/quota).
* History: recent Goals with status + created time; derives only from `home.summary`.
* Empty/error states: no-workspace, no-goals, provider/model/executor unconfigured,
  planning/executing, approval required, failed (canonical reason verbatim — unknown
  causes stay UNKNOWN, no fabricated provider diagnosis), no-artifacts, startup error —
  typed, no `undefined` (S4-14 renders and asserts it).
* Failure UX: FAILED + canonical `failureReason` + failed attempt classification from
  `execution_attempts` (S4-16).
* Artifact UX: preview (bounded) / open / reveal through the bounded typed channel, with
  typed unsupported-format and missing-artifact fallbacks (Stage-3 surface, unchanged).
* Readiness: `runtime.readiness` drives Settings' 运行与诊断 (provider/model/executor/
  workspace rows + the first canonical external block).
* Autonomy: exactly ONE active driver per Goal; **no replay loop** (the Stage-2 4095-replay
  bug regression test stays green). STAGE 4 addition: a driver generation ending in
  `AUTONOMY_STALLED` while durable truth still shows the Goal non-terminal is resumed by
  the launcher after a 30 s cool-down, at most 3 consecutive resumes — each generation
  re-reads canonical truth; terminal/approval/external-blocked outcomes are never resumed.

---

## 4. REAL END-TO-END (Section I) — measured

Environment: REAL machine model env (values never printed), real embedded DSH kernel
(manifest/closure verified per attempt), fresh external workspace
`companyos-desktop-stage4-e2e\project-files` (`notes.txt` + `data.csv`: 4 sensor rows,
S-103 = DEGRADED, Site ALPHA, Q3 budget 12,000 CNY).

Readiness preconditions (presence only): provider configured ✓ · model selected ✓ ·
executor READY ✓ · workspace READY ✓.

| Metric | Value |
|---|---|
| Release Goal | `run_01M44ANSZBVWDEWKFE2KEA6E8A` (sent once from the REAL UI; accessPolicy = WORKSPACE_OPERATIONS, canonical read-back ✓) |
| Planner | PASS — plan compiled, execution run derived (`run_701203f3a8…`) |
| Tasks | 2 (both work tasks DONE, attempts 1/3 each — zero retries) |
| Roles | deterministic professional seats (`drole_…`) per plan item |
| DSH Executor | PASS — real kernel sessions ran; `executor.dispatch_settled` outcome `succeeded`, real provider session id recorded |
| Artifacts | `report.md` written INTO the workspace (evidence-grounded: byte-exact `data.csv` content, SHA256 method, inventory table, S-103 DEGRADED fact) + canonical run-goal artifact |
| Review | PASS (`run.review_passed`, REVIEWING entered) |
| Validation | **INCOMPLETE** — see the blocker below |
| Outcome | NOT REACHED (Goal rests `EXECUTING`, execution run `VALIDATING` — typed, visible, never fabricated) |
| Oracle | PASS on produced content — report.md correctly states 4 sensor rows, S-103 DEGRADED, 12,000 CNY budget, Site ALPHA; no fabricated claims |
| Manual Continue / Decomposition / Role-pick | NO / NO / NO |

Three earlier goals in the same fresh userData are preserved as durable history: two FAILED
pre-fix (Electron-runtime child + executor-null) and one FAILED first-driver-generation
(non-recoverable execution failure, preserved truth — never edited).

Two genuine defects were caught by the E2E and fixed:
1. The embedded-kernel child ran on the Electron binary → GUI-app exit (Windows status
   0xFFFFFFFF). Fixed: the launcher resolves the platform Node for the embedded child
   (`resolveEmbeddedChildNode`); the kernel's own boot gate then verified the runtime
   (it REJECTS Electron-flavoured fingerprints even under `ELECTRON_RUN_AS_NODE` — its
   typed failure is what surfaced the fix).
2. The autonomy driver stalled (`AUTONOMY_STALLED`) while the execution run was genuinely
   progressing through REVIEWING→VALIDATING (the goal-run fingerprint legitimately stays
   `EXECUTING`). Fixed: bounded stall-resume in the launcher (3 × 30 s, canonical non-
   terminal check before each resume; regression-tested).

---

## 5. THE BLOCKER (open product P1)

`packages/engine/src/engine.ts:1557-1573` — with the frozen evidence gate present
(ADR-0020), a bare `VALIDATION.PASS` is refused by construction; the engine yields the
VALIDATING transition to the evidence applicator, which applies **durable validation
batches**. The desktop dynamic-plan composition wires no validators for planned work, so
no batch is ever produced: `validations` for the run are empty and the engine has nothing
to apply. The run rests in `VALIDATING` and the Goal in `EXECUTING` — honestly, and only
resolvable by wiring a real independent validator for dynamic plans (a Stage-4.5/Bug-bash
sized fix: choose/attach validators to work items at compile time and let the sprint-13
validation service produce the batches).

Approval reality (Section J): the E2E workload produced no approval — acceptable per the
task; approval semantics remain covered by the deterministic tests and the Stage-3/4 suites.

---

## 6. Tests

`apps/renderer/tests/stage4-client.test.ts` (23 tests) — S4-01..S4-26: policy crossing
`goal.create` as READ_ONLY, closed vocabulary, kernel-sandbox mapping (READ_ONLY →
`read-only`; unknown ⇒ `workspace-write`), policy-as-data in the kernel task text,
selector rendering with the canonical read-back, no renderer authority persistence,
history from canonical Goals, provider/executor unconfigured states, no `undefined` in the
runtime projection, artifact typed fallbacks, failure UNKNOWN stays UNKNOWN, no manual
Continue (shell source + one-driver guard), restart regression markers, telemetry `--`,
settings without secrets, no renderer DB/FS access, no second Session/Authority truth.

`apps/desktop/tests/desktop-autonomy-runner.test.ts` (7) — unchanged invariants + the
launcher's regression markers; full client sweep: **305 passed / 18 files**.
Final gate: `pnpm check` 6×PASS · `pnpm test:scripts` 23/23 · `git diff --check` clean.

---

## 7. Sections K/L/M

* K (cache/context audit): NOT started — recorded only (§ telemetry above).
* L (restart during work): the release Goal outlived one full app restart mid-flight
  (startup recovery + autonomy resume, no duplicate Goal/Task/settlement); the FINAL
  closure stall is the §5 blocker, preserved truthfully.
* M (visible Windows smoke): this automation host has the proven machine-wide GPU crash;
  NO GPU workaround code was added. **`VISIBLE_NON_HEADLESS_SMOKE = EXTERNAL_PENDING`.**

---

## 13. DYNAMIC_PLAN_VALIDATION_CLOSURE (P1 fix, post-Stage-4)

Root cause of the Stage-4 blocker: the production composition never bound the deployment's
validator set into the compiled work path — (a) no `goalWorkProfile.validatorIds` was
supplied, so compiled nodes carried empty `config.validatorIds` (starving the supervisor's
validationRunner, the evidence applicator and the evidence gate), and (b) no validator TOOL
with `TOOL_CAPABILITY_VALIDATOR` was registered, so even pinned ids would resolve
`VALIDATOR_NOT_FOUND`. The known-good production tests (goal-run-success-terminality)
supply both; the shipped composition supplied neither.

Fix (canonical owner = the engine/application composition, NOT Desktop code):
1. New generic verifier tool `evidence.grounding-check`
   (packages/engine/src/validation/evidence-grounding-tool.ts): deterministic, verifier-only
   — checks the target artifact's machine-checkable factual claims (named workspace paths,
   quoted CSV-shaped data rows, cited digit-bearing identifiers) against the opened
   workspace. Generic for any data/text analysis workload; no report/software hardcoding.
2. Production composition registers the tool (record + port) and binds
   `goalWorkProfile.validatorIds: ['evidence.grounding-check']` — the binding now flows
   into every compiled work node and drives the EXISTING lifecycle: supervisor
   validationRunner → ValidationService (ONE durable batch per creation command) →
   evidence applicator → VALIDATION.PASS/FAIL → terminal (ADR-0020 intact).

Live proof (real Desktop → Core → DSH run, fresh workspace):
EXECUTION.COMPLETE → REVIEW.PASS → VALIDATING → validationRunner executed
`evidence.grounding-check` → canonical validation rows recorded (status: fail — the
validator detected genuinely unsupported claims in the model's report) → VALIDATION.FAIL →
REWORK → REWORK.READY → EXECUTING (corrective round began). The FAIL path is the
independent validator doing its real job against an imperfect model report.

Remaining (honestly): the corrective round's re-dispatch pacing — after REWORK.READY the
bounded stall budget (3 resumes) was consumed before the corrective work re-dispatched, and
a later app restart re-resumed it (bounded, no busy loop). The deterministic PASS path is
fully covered by tests/production/goal-run-success-terminality.test.ts with the exact
binding the production composition now carries.

## 14. CORRECTIVE_AUTONOMY_REDRIVE_EXHAUSTION closure (P1 fix, post-P1)

Boss adjudication on the section-13 live proof: DYNAMIC_VALIDATION_INFRASTRUCTURE = PASS,
STAGE_4_PRODUCT_ACCEPTANCE = BLOCKED on `CORRECTIVE_AUTONOMY_REDRIVE_EXHAUSTION` — the
corrective round provisioned nothing, so the run stalled in REWORK/EXECUTING until the
bounded re-drive budget (3 resumes) was exhausted. Budget was the symptom; the cause was
below.

### 14.1 Validator selection architecture (PART A audit)

- **Selected owner**: `productionCompositionOptions().goalWorkProfile.validatorIds`
  (apps/desktop/src/production-composition.ts) → plan-compiler copies the profile into each
  compiled work node's `config.validatorIds` (packages/engine/src/planning/plan-compiler.ts)
  → supervisor validationRunner resolves the ids against the Tool Registry
  (`TOOL_CAPABILITY_VALIDATOR`) → ValidationService batches → evidence applicator →
  ADR-0020 evidence gate. One owner, no second selection path.
- **Classification**: `evidence.grounding-check` is the deployment's GENERIC BASELINE — the
  validation capability every dynamically planned work item requires regardless of workload
  (evidence grounding against the opened workspace). It is a component of the larger
  capability-based strategy, not a temporary hack: the composition declares a CAPABILITY,
  the registry resolves it to whichever registered validator tool carries it, and specialized
  validators (software QA via `repo.validation-evidence`, pack validators, future
  workload-specific tools) remain fully selectable by declaring different validator ids per
  profile/stage — nothing was replaced. Deterministic, no LLM routing.
- **Guard rails kept**: the legacy repo-QA corrective cause path
  (`resolveQaEvidenceCause`, `companyos/repository-qa-evidence`) is intact; the review-cause
  path (`resolveReviewCause`, `companyos:review-findings`) is untouched; the grounding
  validator remains an ADDITIONAL baseline that can never substitute a specialized validator
  because selection is per-profile and additive, and ADR-0020 still demands every required
  validator's blocking pass row.

### 14.2 Corrective autonomy root cause (PART B forensic)

Live stuck state (s9 run `run_01M45TK2A8Z18YBTDJFGKSA2Q7` / execution
`run_5fd70c3d2b1e82101de8147e94`): validation batch FAIL (`evidence.grounding-check`), an
ACTIVE REQUEST_CORRECTIVE Decision, zero corrective Task, driver fingerprint frozen.

- **CORRECTIVE_STATE**: Decision recorded (durable, ACTIVE), provision never succeeded.
- **MISSING_PRODUCER**: two defects, both on the provision path:
  1. `supervisor-runtime.ts` recorded the Decision with the model's cited evidence only —
     the proposal legally cited one of the validation's evidence ARTIFACTS (an
     executor-output artifact), so the Decision envelope carried NO validation-kind ref.
  2. `corrective-provisioner.resolveValidationCause` accepted only the legacy QA-evidence
     report kind (`companyos/repository-qa-evidence`), refused the generic grounding report
     (`CORRECTIVE_CAUSE_EVIDENCE_KIND_MISMATCH`), and had no path that resolves a cause from
     the canonical Validation ROW itself.
- **WHY THREE REDRIVES FAILED**: with provision refusing, the engine sat in
  REWORK/EXECUTING with no runnable work unit (DONE tasks are never re-opened and no
  corrective Task existed); the driver fingerprint never changed; the bounded budget
  (3 resumes) expired. Budget increase would not have executed anything — the fix makes the
  canonically runnable corrective work EXIST.

### 14.3 Fix (both ends of one seam)

1. **Runtime citation (supervisor-runtime.ts)**: a VALIDATION_FAILED proposal now always
   carries the failing validation LINE's branded id (`val_<ulid>`, Task-13-09 grammar) —
   appended to the recorded evidenceRefs when the model cited only evidence artifacts,
   deduped when already cited, untouched for non-validation causes (REVIEW_FINDING).
2. **Provisioner dual path (corrective-provisioner.ts)**: `resolveValidationCause` now
   resolves the cause from the cited Validation ROW itself
   (`resolveValidationRowCause`: status fail/error, same run, pinned stage, parent = the
   stage task whose durable outputs produced the gated target artifact; unambiguous single
   terminal stage task as fallback; typed refusals otherwise). When the decision cites no
   validation row, the frozen legacy QA-evidence path runs unchanged.
3. Round cap, lineage derivation, idempotent putGuarded/unitOfWork: unchanged (Task-18-07
   trusted boundary intact).

### 14.4 Deterministic corrective fixture (REQUIRED — delivered)

`apps/renderer/tests/stage4p1-corrective-fixture.test.ts` over REAL durable stores
(SQLite runs/tasks/artifacts/validations + template version graphs + decision versions):
1. planted ungrounded claim → grounding FAIL row is the initial validation; corrected
   artifact re-validated independently to PASS;
2. corrective cause resolution from the validation ROW via the recorded decision envelope
   (validation-kind ref → row → target artifact → parent task);
3. corrective round limit enforced at the provisioning boundary (derived round > cap →
   `CORRECTIVE_ROUND_LIMIT_EXCEEDED`, zero rows written).
Plus 3 new supervisor-runtime tests (tests/sprint18/supervisor-decision-runtime.test.ts):
artifact-only citation still records the ValidationId; explicit ValidationId citation is
recorded exactly once; REVIEW_FINDING decisions are untouched by the augmentation.

### 14.5 Real Desktop release-candidate E2E (fresh userData + fresh workspace, real model)

Two real goals submitted through the REAL composer (real model selection
`deepseek-v4.1-flash`, real 工作区操作 authority, real send), REAL planner, REAL embedded-DSH
executor, REAL ValidationService batches, REAL handoffs:

- Goal `run_01M45ZMWBVVDEWRJNNN9JDX4AJ`: plan → 2 work tasks (1 attempt each, report.md
  delivered to the workspace) → REVIEW → 2 blocking `evidence.grounding-check` validations
  **PASS** → `run.delivered` → **Goal COMPLETED**, execution run `run_52d72a37…` COMPLETED,
  Handoff rows durable.
- Goal `run_01M46062JAM0Y9A0YXDJQPQ3AS`: plan → 3 work tasks → 3 blocking validations
  **PASS** → delivered → **Goal COMPLETED** (execution run `run_2e50f608…` COMPLETED); the
  run absorbed one PROVIDER_UNAVAILABLE and one INVALID_OUTPUT through the bounded retry
  envelope without any manual action.

Honest scope note: in both goals the model produced fully grounded work on the first try, so
no LIVE corrective round triggered. The corrective loop (FAIL → cause from validation row →
corrective Task → execution → independent re-validation → PASS → terminal) is proven by the
deterministic fixture of 14.4 and the existing T18-07 corrective-loop suites (rounds 1–3,
execute-once, idempotent reapply, stale-apply rejection, crash-window replay).
