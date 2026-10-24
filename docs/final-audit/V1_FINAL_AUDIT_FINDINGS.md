# CompanyOS V1 — Final Audit Findings

**Baseline:** 4368d5b

**Discovery phase output per Boss Mid-Audit Control Order §12/§15.**

**Status states used:** PROVEN_P0 / PROVEN_P1 / P2_BACKLOG / P3_BACKLOG / FALSE_POSITIVE / NEEDS_PROOF

---

## Verdict Summary

- **PROVEN P0:** 0
- **PROVEN P1:** 0
- **NEEDS PROOF:** 0
- **P2 BACKLOG:** 0
- **P3 BACKLOG:** 3
- **FALSE POSITIVES CLOSED:** 1

No P0/P1 V1 blocker was found. The frozen system holds under every audited
cross-system concern. Two non-blocking diagnostics weaknesses are recorded as
backlog; one initial suspicion was disproven and closed as a false positive.

---

## FINDING FA-P3-001 — Handoff store error mapping conflates constraint kinds

- **Severity:** P3_BACKLOG
- **Subsystem:** persistence / handoff store (`packages/persistence/src/durable/sqlite-handoff-store.ts`)
- **Exact location:** `create()` catch block (line ~205)
- **Frozen invariant checked:** Handoff version immutability — a duplicate (handoff_id, version) must fail loudly.
- **Actual observed behavior:** The catch matches `/UNIQUE|PRIMARY KEY|constraint/i` and reports EVERY constraint failure as `ALREADY_EXISTS` "already exists; versions are immutable". A CHECK violation (e.g. `status = 'PENDING'` which is outside the frozen enum) or an FK violation is therefore mislabeled as a duplicate-version error.
- **Evidence:** Dynamic — during the audit golden-scenario construction, an invalid `status:'PENDING'` packet produced `Handoff "ho_audit_…" v1 already exists; versions are immutable.` although no such handoff existed.
- **Why it is NOT a violation of correctness:** The transaction rolls back in every case (fail-closed, no partial write); only the error MESSAGE/code is imprecise. No second truth, no data corruption, no false success.
- **Root cause:** Over-broad regex classification in the error mapping.
- **Correct owner/layer:** persistence store error mapping.
- **Corrective scope (backlog only):** Distinguish `UNIQUE constraint failed` (→ ALREADY_EXISTS) from `CHECK constraint failed` (→ VALIDATION_FAILED) and `FOREIGN KEY constraint failed` (→ CONFLICT/PERSISTENCE_FAILED).
- **Regression proof when fixed:** A packet with invalid status asserts VALIDATION_FAILED, not ALREADY_EXISTS.
- **Status:** P3_BACKLOG (do not fix during audit per §38 fix policy).

## FINDING FA-P3-002 — Goal Work Profile carries no validatorIds (validation not exercised on the default path)

- **Severity:** P3_BACKLOG (observation, not a defect)
- **Subsystem:** Product Control Plane goal pipeline (`apps/desktop/src/control-plane.ts` step-2 trusted spec derivation)
- **Frozen invariant checked:** Validation authority = validatorIds + Validation records + Evidence (never role/stage/UI label); zero-validator frozen semantics.
- **Actual observed behavior:** The V1 trusted derivation assigns every plan item the deployment's generic work profile with NO validatorIds, so the default Goal→Outcome path never enters the Validation gate. Validation machinery (ValidationService, EvidenceGuard, D1) is proven by S13/S17/S21/S23 suites but not exercised inside the default control-plane flow.
- **Evidence:** Static — the derivation builds `planItemProfiles[itemId] = { stageKind, taskProfile }` with no `validatorIds` key; dynamic — the audit golden scenario observed `validations` table count 0 for a fully settled run while observation truthfully reported no validation.
- **Why it is NOT a violation:** Zero-validator semantics are FROZEN (a stage with no declared validators completes without a validation requirement; nothing fabricates a PASS). This is an honest product-scope decision recorded in S26 §11, not a fail-open path.
- **Root cause:** Product scope decision (V1 default profile has no validators).
- **Correct owner/layer:** Deployment composition (`goalWorkProfile`) — adding validators later is a Pack/deployment concern.
- **Corrective scope (backlog only):** When a V1.x Pack wants validation on the goal path, declare validatorIds in the work profile; the pipeline already routes them (S21 §92 generic validation orchestration proven).
- **Status:** P3_BACKLOG.

## FINDING FA-FP-001 — `env: process.env` in core-services (FALSE POSITIVE)

- **Severity:** FALSE_POSITIVE (closed)
- **Subsystem:** desktop composition secrets
- **Exact location:** `apps/desktop/src/core-services.ts` — `createEnvSecretVault({ env: process.env, prefix: 'COMPANYOS_', authorize: sessionAuthorize })`
- **Suspicion:** Broad process.env inheritance into a child process (AUD-405).
- **Disposition:** SAFE — this is the SecretVault SOURCE (reads host env to resolve `COMPANYOS_`-prefixed secret pointers, authority-checked, values memory-only). Child processes receive only the allowlist-built environment (`buildFilteredProcessEnvironment`, ADR-0028), proven by `s25-preflight-pipeline` tests 9–13 and the deterministic env-policy test in `s25-real-provider-smoke`.
- **Status:** FALSE_POSITIVE.

## FINDING FA-P3-003 — Sprint26 closeout committed an un-indexed document (docs governance gap)

- **Severity:** P3_BACKLOG (process/diagnostics; fixed as documentation-only during this audit)
- **Subsystem:** docs governance / Sprint26 closeout process
- **Exact location:** `docs/S26_TEST_TAXONOMY.md` (created in commit 4368d5b) vs `docs/INDEX.md`
- **Frozen invariant checked:** `docs/tests/docs-links.test.ts` — every document under docs/ must be reachable from INDEX.md (T11-02 discovery discipline).
- **Actual observed behavior:** At baseline 4368d5b the committed tree's `pnpm check` step `test` FAILS: `S26_TEST_TAXONOMY.md` was added after the Sprint26 5× consecutive check streak had already been recorded and was committed without re-running the gate.
- **Evidence:** Dynamic — `pnpm check` at baseline fails at step test with `expected [ 'S26_TEST_TAXONOMY.md' ] to deeply equal []`.
- **Why it is NOT P0/P1:** Documentation-index reachability only; zero product/safety/recovery impact; no canonical truth affected. It does show a closeout-process weakness (gate not re-run after the last file addition) — recorded honestly.
- **Root cause:** Sprint26 closeout ordering: doc created → commit, without a final gate pass on the exact committed tree.
- **Correct owner/layer:** docs INDEX + closeout discipline.
- **Corrective scope:** Documentation-only: the INDEX row for `S26_TEST_TAXONOMY.md` was added by this audit (no production change), and the full 5× gate now runs against the final audit-committed tree.
- **Regression proof:** `pnpm check` 5× consecutive PASS on the audit's final tree (this report's gate evidence).
- **Status:** P3_BACKLOG — documentation correction applied during the audit (docs-only, permitted); the process lesson (re-run the gate after ANY last addition before commit) is recorded for future closeouts.

---

## Evidence Index (per audit matrix section)

| Matrix Section | Result | Key dynamic evidence |
|---|---|---|
| 1 Canonical authority (AUD-001..021) | PASS | schema audit (execution_attempts UNIQUE(task,attempt), provider_dispatches subordinate + UNIQUE(dispatch_key), tasks.run_id FK NOT NULL); `t20-03a` ownership tests; `s21b` attempts tests 1–13; `s26` E2E |
| 2 Second truth (AUD-100..110) | PASS | full CREATE TABLE inventory (33 tables, zero dashboard/ui/shadow/second-queue tables); renderer holds only view state; preload frozen 5-channel surface; `s26-decisions-restart` test 27/28/29 |
| 3 Pipeline (AUD-200..213) | PASS | `t20-05` test 16 (V2 current cannot hijack pinned V1); `t20-07` non-software E2E; audit golden scenario |
| 4 Crash/uncertainty (AUD-300..306) | PASS | `s24-crash-recovery` windows A/B/C1/D; `s25-claim-ordering` 1–8; `s21b` test 12/13 (same-attempt reacquire, attempts not incremented); `s26-decisions-restart` 9/13 (decision restart) |
| 5 Security/safety (AUD-400..421) | PASS | `s25-secret-boundary` (12); `s25-workspace-safety` (13 adversarial paths incl. sibling/case/mixed-sep/drive/UNC-equivalent/symlink/junction/reparse/missing/file); `s25-preflight-pipeline` (env allowlist, drift fail-closed); zero `shell:true`; zero secret_value columns; FA-FP-001 dispositioned |
| 6 Session/validation/corrective (AUD-500..506) | PASS | `s19` boundary suites; `s21d` F (newer clean cannot mask older unresolved); `s23` CASE 9; ARCH guard recency-not-authority |
| 7 Artifact/handoff/observation (AUD-600..609) | PASS | `s13` artifact suites; `t20-06` work package; audit golden scenario (handoff create + projection unaffected); `s23` contracts + cursor scope CASE 4 |
| 8 Control plane/IPC (AUD-700..710) | PASS | preload allow-list audit; ARCH-035/036 both directions; `s26-renderer-boundary` (5); `s26-control-plane-flow` test 35 (malformed fail-closed) |
| 9 Stale/duplicate/cross-scope (AUD-800..814) | PASS | `s26-decisions-restart` 20/21 (stale conflict + duplicate idempotent); `s26-control-plane-flow` 17–19 + 21; `s23` CASE 4/5; audit cross-scope sweep (cursor scope, cross-run no-bleed, foreign company refused, dispatch re-bind refused by UNIQUE) |
| 10 Database/restart (AUD-900..917) | PASS | migration checksum/rollback/ordering tests; `t20-03a` legacy-abort trigger; every suite re-opens fresh DBs; audit mid-flow restart (zero duplicate runs/tasks, goal replay idempotent) |
| 11 Generic/truthfulness (AUD-1000..1008) | PASS | check-boundaries Core vocabulary guard (developer/git/repository/QA banned, enforced both directions); `t20-03b` procurement/finance non-software flows; audit golden scenario (non-software objective); renderer audit: no fake progress/cost/budget/sandbox/percentage strings |
| Golden scenario | PASS | `tests/final-audit/v1-golden-scenario.test.ts` 3/3 (goal→…→handoff→observation→readback; mid-flow restart; cross-scope sweep) |
