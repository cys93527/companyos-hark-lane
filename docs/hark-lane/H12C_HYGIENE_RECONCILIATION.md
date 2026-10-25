# H12c — migration hygiene + downgrade refusal, operator UNKNOWN reconciliation, hard-kill restart, Chinese installer, docs reachability

Hark lane, self-review only (label: Hark self-review PASS when gates and CI are green). Not an independent review.

## (a) Migration chain hygiene + downgrade detection
- Problem: `schema_migrations` is one table shared by all 14 chains, but each chain's runner only knew its own files, so every boot logged "applied migration file is no longer present" for every sibling-chain row, and a database written by a NEWER CompanyOS (unknown migration rows) was silently opened by an older build.
- Fix: `shippedMigrationNames()` (persistence) = every migration name across all chains (asserted globally unique). `openDurableDatabase` / `openCompanyDatabase` pass it as `knownNames`. Sibling rows are silent; a row no shipped chain knows → `MigrationFromNewerVersionError` (frozen code `CONFLICT`, `details.kind = SCHEMA_FROM_NEWER_VERSION`, `unknownMigrations`) thrown BEFORE any migration is applied (data untouched).
- Desktop: bootstrap failure is typed into `databaseStatus().failure` (`SCHEMA_FROM_NEWER_VERSION` | `OPEN_FAILED`); the renderer shows 「数据来自更新版本的 CompanyOS … 请重新安装更新版本」 (`database-failure.tsx`). This is the refusal H13's downgrade CI test exercises.
- Tests: `packages/persistence/tests/h12c-migration-downgrade.test.ts`, `apps/renderer/tests/h12c-database-failure.test.ts`.

## (b) Installer Simplified Chinese wizard
- `installer/companyos.iss`: `[Languages]` is always `chs`. It uses the runner's `ChineseSimplified.isl` when Inno ships it (workflow passes `/DZhCnMessages`); otherwise the in-repo `installer/ChineseSimplified.isl` (authored here, UTF-8 BOM, `LanguageID=$0804`) layered over `compiler:Default.isl`, so any untranslated message falls back to English instead of breaking the build. `LanguageDetectionMethod=none`, no language dialog. Nothing is downloaded.
- First CI (hark-installer 40211843808 @4a9ba6a): the windows runner's Inno Setup 6.7.1 ships 29 languages and **no** ChineseSimplified.isl, so the wizard fell back to English (`iscc.json.wizardLanguage`). Fixed at the root with the in-repo file (H13b commit). Proof: smoke check `wizard-language-zh-cn` reads the uninstall key's `Inno Setup: Language` = `chs`; the workflow fails on any ISCC language/message warning.

## (c) Restart proof: real hard kill
- p1 no longer exits cooperatively (`process.exit`). It records its checks, writes `p1-ready.json`, and blocks with the provider call in flight; the workflow terminates it with `Stop-Process -Force` (TerminateProcess: no exit handlers, no `db.close()`, no WAL checkpoint). `p1-kill.json` records pid, method, exit, still-running check.

## (d) UNKNOWN operator reconciliation (main process only)
- Trust root = the H10 operator directory `<userData>/budget` (no IPC exposes it; env not consulted):
  `reconciliations.json` (`companyos:usage-reconciliation:1`, entries `{reconciliationId, goalRunId, callId, tokens, costMicros, attestedBy, attestedAt, evidence: sha256:<hex>}`) + `evidence/<hex>` bytes (e.g. the provider invoice/usage export line).
- Operator tool: `node scripts/hark/make-usage-reconciliation.mjs <budgetDir> <goalRunId> <callId> <tokens> <costMicros> <attestedBy> <evidenceFile> [id]`.
- Applied once per composition start, after crash recovery, via the canonical budget transaction `reconcile()` (engine): only an UNKNOWN reservation; attested usage must fit the call's trusted admission bound; identical re-apply = no-op; anything else = typed refusal (`GOAL_RECONCILIATION_NOT_UNKNOWN | _EXCEEDS_BOUND | _CONFLICT | _INVALID`, `RECONCILIATION_EVIDENCE_MISSING_OR_MISMATCHED`, `RECONCILIATION_ENTRY_INVALID`, `RECONCILIATION_ID_DUPLICATE`), logged, never thrown (shell still opens). Never admits, retries or replays a call; a cancelled Goal stays cancelled.
- Storage invariant: a `reconciliation` record may only sit on a KNOWN reservation (else `GOAL_BUDGET_STATE_INVALID`).
- Boss view: `run.budget.reconciled` (subset of settled) → 「其中运营者凭证对账 · N 次 · ¥…」.
- Proof: in-process `tests/hark/h12-restart-unknown.test.ts` R4; unit `tests/hark/h12c-usage-reconciliation.test.ts`; installed-app CI `hark-restart` phase p4 (operator tool between p3 and p4).

## (e) docs reachability gate
- `docs/tests/docs-links.test.ts` stripped paths with a Windows-only `\\`, so on Linux every doc looked unreachable (189) and the one real gap was hidden. Now platform-independent; the real gap (ADR-0033 not linked from INDEX) is fixed.

## Gates / CI
CI GREEN @4f31563: hark-windows 40217749251, hark-installer 40217749262 (wizard zh-CN via in-repo isl, `Inno Setup: Language=chs`), hark-restart 40218221060 (4 phases, p1 = Stop-Process -Force, p4 operator reconciliation), hark-upgrade 40218221052. Gate numbers: PROJECT_HANDOFF.md (H12c+H13 section). Hark self-review PASS (not independent review).
