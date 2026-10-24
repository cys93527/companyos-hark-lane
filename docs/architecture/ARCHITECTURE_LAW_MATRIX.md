# Sprint 22 — Architecture Law Matrix (pre-implementation recon)

Baseline `779491b` (Sprint 21 frozen). Produced BEFORE any guard implementation
(§3). Every row: the law, its canonical source, what is ALREADY enforced, what is
missing, the chosen guard technique (§36 order: existing boundary system →
TS/AST → package dependency rules → focused architecture tests → targeted source
assertions), the false-positive risk, and the test that proves the guard itself
(§38: forbidden fails, legitimate passes).

## Existing enforcement inventory (recon result)

| Mechanism | Covers |
|---|---|
| `scripts/check-boundaries.mjs` (LAW 1/1b/2, comment+string-stripped identifier scan, inner-ring import scan, `package.json` dependency allow-list; `--root` fixture-tree mode) | Core/Contracts vocabulary, Core import direction, package dependency direction |
| ESLint `no-restricted-syntax` (identifier denylist) + `no-restricted-imports` (Core inner-ring) | the identifier twin of LAW 1/1b |
| `scripts/check-workspace.mjs`, `scripts/tests/hygiene.test.mjs`, `docs-consistency.test.mjs`, `check-gate.test.mjs` | workspace manifests, ignore/npmrc hygiene, doc truth, fail-fast gate |
| Feature tests (s21b/s21c/s21d, t20-03 identity, t19 bounded contexts) | per-feature proofs (claim-before-executor, carrier reconciliation, D1 scoping, WorkPackage derivation, ownership FK) |

Everything else in the Sprint22 law list is currently DOCUMENTATION-ONLY or
proved incidentally by feature tests — no mutation-proof guard.

## Law matrix

| ID | Law | Canonical source | Current enforcement | Missing | Chosen guard | FP risk | Self-test |
|---|---|---|---|---|---|---|---|
| ARCH-001 | Core is industry neutral (no Pack role/task branching as identifiers) | ADR-0002, CORE_BOUNDARIES §1 | check-boundaries LAW 1 + ESLint twin | none (kept, re-homed) | existing boundary system (unchanged) | comments/strings — already stripped | scripts/tests/check-boundaries.test.mjs |
| ARCH-002 | Core/Contracts imports stay inner-ring | ADR-0002/0005 | check-boundaries LAW 1b + ESLint | none | existing | none | check-boundaries.test.mjs |
| ARCH-003 | Dependency direction Core←Engine←Desktop | ADR-0005 | check-boundaries LAW 2 (manifests) | source-level engine→desktop imports inside packages | AST import scan (engine/persistence must not import apps) | none (absolute paths only) | probes in tests/architecture |
| ARCH-004 | Existing Run semantics come from the PINNED WorkflowVersion (`versions.find(id === run.versionId)`), never currentVersion/latest | ADR-0027, T20-05 | none at guard level | all | TS/AST: `currentVersion` / `currentVersionId` / `latestVersion` references in run-execution modules are violations (lifecycle authoring modules exempt by explicit path list) | authoring paths use currentVersion legitimately — exemption list is explicit and tested | forbidden+allowed probes |
| ARCH-005 | No second dependency graph (TaskEdge/RuntimeDependency/CorrectionGraph/ReassessmentGraph/ExecutionGraph tables or code-level edge stores) | T20-06, ADR-0029 | none | all | persistence migration scan (table names) + AST (type/interface names) | docs/strings — scan identifiers only, comments stripped | probes |
| ARCH-006 | No second scheduler truth (Scheduler/Queue/RuntimeTaskState/AgentQueue tables or canonical queue stores) | ADR-0029 | none | all | migration scan + AST | operational helpers allowed if non-canonical — exemption by name list with reason | probes |
| ARCH-007 | No latest-object authority (created_at DESC / most-recent as SEMANTIC authority where frozen identity exists) | T20-06 §subject, Sprint21 D1 | none | all | TS/AST pattern scan limited to supervisor/provisioner/projection modules; ORDER BY created_at DESC flagged unless inside a documented tie-break function | documented tie-breaks (byDeterministicRecency, earliest-(createdAt,id)) — allow-list by function name + comment marker | probes (both directions) |
| ARCH-008 | WorkPackage is derived-only (no WorkPackage table/lifecycle/status/ownership) | T20-06 | none at guard level (feature tests prove derivation) | persistence + lifecycle | migration scan (work_package*) + AST (no exported mutators on the projector) | the projection's own type name is fine — ban only persistence/lifecycle | probes |
| ARCH-009 | Sprint11 HandoffService is the only durable Handoff owner (no new handoff table/lifecycle; WorkPackage ≠ HandoffPacket) | ADR (Sprint 11), T20-06 | feature tests (zero handoffs in autonomous paths) | persistence guard | migration scan (handoff*) + AST (exported create/store of handoff outside the Sprint11 service path) | autonomous edges legitimately create ZERO packets — guard only second-owner declarations | probes |
| ARCH-010 | Task canonical ownership = Task.runId → Run → Company (no Task.companyId, no heuristic inference) | T20-03A | DB FK + migration trigger + feature tests | guard for new ownership columns/heuristics | migration scan (company_id on tasks) + AST (task.companyId property reads/writes outside tests) | none | probes |
| ARCH-011 | Normal Task identity is deterministic immutable-seed (no timestamp identity, no registry order in seed) | T20-03A/B | feature tests (seed REPLAY/CONFLICT) | AST guard for creation-seed composition | TS/AST: `createTask` call sites must pass deterministic ids; identify seed builders by function name | ids factory injection is the allowed pattern — probes pin it | probes |
| ARCH-012 | ExecutionAttempt ≠ Task (attempt owns runtime identity; no workflow/validation/finding/business truth on it) | Sprint21 final | schema + feature tests | AST guard for business fields on the attempt entity | TS/AST: execution-attempt domain module may not import/validate findings, validations, DAG, run-state semantics | the attempt does carry roleId/taskKind (pinned profile) — allowed by field allow-list | probes |
| ARCH-013 | AgentExecution ≠ ExecutionAttempt (model provenance only; never the generic claim truth) | Sprint21 final, ADR-0030 | feature tests (zero model fields on attempts) | guard for model fields leaking into the attempt seed/domain | TS/AST: the attempt domain must not reference model/provider fields | none | probes |
| ARCH-014 | Executor registry answers implementation only (never stage order/validator/business meaning) | Sprint21 | source-audit tests exist | none needed beyond C/ARCH-012 (registry data only) | AST: registry consumers may not compute stage order — covered by ARCH-004/005 probes | — | probes |
| ARCH-015 | Validation authority = pinned node validatorIds + trusted validator registry (no QA role/stage class/name heuristics) | ADR-0020, Sprint21 | feature tests | AST guard for validation-authority computation | TS/AST scan of validation-service/projector modules for role-name branching | none | probes |
| ARCH-016 | Findings drive correction (no review role/class/literal taskKind as corrective eligibility authority) | ADR-0029, Sprint21 D1 | D1 scoping feature tests | AST guard for eligibility branching | TS/AST: provisioner may not branch on role/taskKind strings | error message strings exempt | probes |
| ARCH-017 | D1 scope: proposal/cause projection SUBJECT-SCOPED; run blocking ALL_UNRESOLVED_ANCHORS | Sprint21 final (Boss 终令) | feature tests (s21-generic-corrective) | mutation-proof guard | TS/AST: the context builder must gate projection population on subject match, and the blocking scan must not gate on the anchor | the anchor report itself must populate when subject-matched — allowed-example probe | probes |
| ARCH-018 | Stage output authority = existing stage-subject authority + Task.outputs['stageOutput'] (no latest-task/array-last/registry-order wins) | T20-06, Sprint21 | feature tests | covered by ARCH-007 pattern scan + stage-subject function allow-list | TS/AST pattern scan | tie-breaks allowed (documented) | probes |
| ARCH-019 | Corrective/reassessment lineage continues through canonical lineage (no manual review2 seeding, no ad-hoc reassessment queue) | Sprint21 final | feature tests (manual seeding migrated away) | guard against reintroduced seeding in fixtures of production | AST: production modules must not create tasks with `companyos:reassessment` inputs outside the provisioner | the provisioner owns it — path allow-list | probes |
| ARCH-020 | Descendant invalidation derives from the run-pinned DAG only | Sprint21 final (B1) | feature tests | AST: provisioner must read the pinned graph for descendants | TS/AST scan for live template/pack graph reads in the invalidation path | none | probes |
| ARCH-021 | Claim before executor (no durable attempt → no external executor invocation) | Sprint21 final | feature tests (s21b) | guard for executor invocation without a preceding claim | TS/AST: in the engine claim path, handler invocation must follow the claim transaction (statement-order check on the claim/handler call pairs) | only the engine module is scanned | probes |
| ARCH-022 | No SQLite write transaction spans an executor/provider invocation | ADR-0006, Sprint21 | engine structure (settlement is a separate transaction) | guard for regression | TS/AST: inside `inTransaction` callbacks in engine/src, no call to the handler/executor/provider invocation functions | the callback body is scanned; nested helpers flagged by name | probes |
| ARCH-023 | Same-attempt recovery never increments Task.attempts | Sprint21 final | feature tests (s21b) | none beyond claim-path statement check | covered by ARCH-021 probe + feature tests | — | probes |
| ARCH-024 | Carrier before readiness and before terminal completion | Sprint21 final | feature tests (s21d A1/A2) | none (regression proven by s21d) | keep as architecture test (not a source guard) | — | s21d |
| ARCH-025 | External exactly-once is NOT claimed (documentation guard) | Boss §26 | doc wording | doc-level check | docs-consistency-style assertion in the architecture suite | none | probe |
| ARCH-026 | Ledger is not permanent business identity (identity paths must not fall back to bounded ledger lookup) | T20-05 final | feature tests | source assertion | TS/AST: identity derivation functions must not read the command ledger | ledger reads for IDEMPOTENCY are allowed — allow-list by function | probes |
| ARCH-027 | UI is not truth (renderer must not own Run/Task/Validation/finding state; renderer→service boundary) | ADR-0008 | ADR + IPC contract | automated guard | TS/AST: renderer sources must not import persistence/engine stores or call lifecycle mutators directly; desktop main/renderer boundary by import scan | the renderer importing contracts is allowed (existing) | probes |
| ARCH-028 | Session is context, not workflow truth (no Task DONE/Run state/validation decisions from session modules) | ADR-0030 | feature tests | source assertion | TS/AST: session/work-session modules must not dispatch run events or write tasks | none | probes |
| ARCH-029 | Artifact/Evidence/Validation ownership preserved (not collapsed into Task outputs or prompt text) | Sprint13/17/19 | sinks own their writers | source assertion | TS/AST: the canonical sinks' writers are unique (one writer per kind) — scan for artifact kinds' creation sites | the executor materializing work outputs is the allowed second path (generic work kind) | probes |
| ARCH-030 | Memory is not authority (future memory must not mutate Goal/Plan/WorkflowVersion/Run/Task/Decision/Artifact/Evidence/Validation/Handoff without canonical commands) | Boss §34/§51 | none (no memory integration) | documentation boundary + import guard | docs + AST: no module may import a memory store into the command paths (vacuously true today; guarded by import scan) | none | probes |
| ARCH-031 | Software is a Pack (Git/repo/developer/code semantics stay outside Core authority) | ADR-0002, T17 | pack boundaries + dev-company pack location check | location assertion | path assertion: git/repository vocabulary must not appear in Core/Engine sources (only in packs/dev-company + tests/docs) | the boundary script already scans Core; ENGINE is the new scan target with a narrower vocabulary | probes |
| ARCH-032 | Executor registry is implementation authority only (registry order has no semantic authority) | Sprint21 | feature tests (registration-order invariance) | none | covered by ARCH-004/005/014 | — | probes |
| ARCH-033 | No wholesale parent-environment inheritance (one environment law: allowlist + trusted additions) | ADR-0028 D12 + Sprint25 §16 | feature tests (env policy unit + REAL filtered child env) | none | TS/AST: `...process.env` spread or `env: process.env` in `packages/engine/src/executor` + `apps/desktop/src/executor` fails; `process.env` as the allowlist's FILTER SOURCE is allowed | none | probes |
| ARCH-034 | Path containment is a component boundary, never a raw prefix (`C:\work\foo` must not accept `C:\work\foobar`) | ADR-0028 D11–D13 + Sprint25 §24–25 | feature tests (13 workspace cases) | shared helper `assertPathWithinCanonicalRoot` | TS/AST: `.startsWith(root|canonicalRoot|workspaceRoot|baseDir|base)` in `packages/engine/src/repository` + `packages/engine/src/executor` fails; `root + sep` and content checks pass | none | probes |

## False-positive control (§39)

- All identifier scans strip comments AND string literals (reusing the proven
  `stripCommentsAndStrings` from check-boundaries.mjs), so documentation,
  forbidden-field lists and error-message strings cannot trip a guard.
- Authoring paths that legitimately use `currentVersion` (lifecycle-service
  publish/draft/fork) are exempt by an explicit, documented path list — the
  guard fails any NEW exemption silently added to that list only through a
  failing probe in the architecture suite.
- Documented tie-breaks (`byDeterministicRecency`, earliest-(createdAt,id)) are
  allow-listed BY FUNCTION NAME with a required doc marker comment.

## Guard entrypoint (§41/§42)

`pnpm test:architecture` → `node scripts/check-architecture.mjs` (fast, real
scan). `pnpm check` gains the `architecture` step (after `boundaries`). The
mutation probes live in `tests/architecture/` (vitest), so `pnpm test:scripts`
stays 23/23.
