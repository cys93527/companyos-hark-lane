# CompanyOS V1.1 — Sprint 0 Task List (Foundation)

> **Scope authority:** `CANONICAL_SPEC.md` §6 (`[DIRECTIVE]` verbatim) + §7 (locked tech decisions).
> **Companion doc:** [`EXECUTION_ROADMAP.md`](./EXECUTION_ROADMAP.md) — Sprint 0 section.
> **Status legend:** `⬜ TODO` · `🟨 WIP` · `🟩 DONE` · `🚫 BLOCKED`
> Sprint 0 delivers **infrastructure only**. Every task below must be provably verifiable by a
> command that exits `0`.

---

## 1. Sprint 0 objective

> Stand up a buildable, lint-clean, type-safe, test-covered pnpm monorepo that launches an
> hardened Electron shell with a React 19 + Vite renderer, opens a SQLite database through a
> checksum-verified migration runner, emits structured JSON-lines logs with redaction and
> correlation ids, and runs all of it behind a single `pnpm check` gate (lint + typecheck +
> architecture boundary + test + build) that also runs in GitHub Actions.

**Priority:** P0 · **Duration:** 1–2 weeks · **Depends on:** nothing · **Tag:** `sprint-0.0.1`

**Deliverable definition:** a fresh clone + `pnpm install --frozen-lockfile` + `pnpm check`
exits `0`, and `pnpm dev` opens an Electron window whose renderer displays the version string
obtained over the typed preload bridge.

---

## 2. Scope

### ✅ ALLOWED (exact list — do nothing outside it)

| # | Allowed | Where |
|---|---|---|
| A1 | Monorepo (**pnpm workspaces**) | `pnpm-workspace.yaml`, root `package.json` |
| A2 | **Electron** main + preload | `apps/desktop` |
| A3 | **React 19 + Vite** renderer | `apps/renderer` |
| A4 | **TypeScript** strict, ESM-first | `tsconfig.base.json` + project references |
| A5 | **SQLite** via `node:sqlite` | `packages/persistence` |
| A6 | **Migration** runner + `0001_init.sql` | `packages/persistence/migrations` |
| A7 | **Logging** (structured JSONL, redaction, correlation ids) | `packages/observability` |
| A8 | **Testing** (Vitest unit + architecture boundary tests) | `packages/*/tests`, `scripts/tests` |
| A9 | **CI** (GitHub Actions, `pnpm check`) | `.github/workflows` |
| A10 | `AGENTS.md` | repo root |
| A11 | `PROJECT_HANDOFF.md` | repo root |
| A12 | Interfaces/ports **only** (`Clock`, `IdFactory`, `Logger`, `EventBus`, `EntityStore<T>`, `MigrationRunner`, `SecretResolver`, `ModelGateway`, `AgentRuntime`) | `packages/core/src/ports` |

### 🚫 FORBIDDEN in Sprint 0 (do not build · do not scaffold · do not stub with logic)

| # | Forbidden | Detection |
|---|---|---|
| F1 | **Model Router** | any provider SDK dependency, any adapter file, `packages/model-router/**` |
| F2 | **Agent Runtime** | any node executor / tool invocation code; `AgentRuntime` may exist **only** as a type |
| F3 | **DevCompany** | any archetype, staffing or RACI implementation |
| F4 | **Coding Agent** | any source-editing / diff-applying capability |
| F5 | **Workflow Designer** | any canvas, DAG editor, node inspector UI |
| F6 | **多模型调度** | any queue, quota, scheduler, rate-limiter for models |
| F7 | Industry nouns in Core — `Coding · Git · Repository · Developer · CTO · Article · Video · Ecommerce` | `scripts/check-boundaries.mjs` + ESLint `no-restricted-imports` |
| F8 | `Repository` as a Core identifier (the port is `EntityStore`) | boundary script AST/text scan |
| F9 | `@companyos/pack-*` imports from `@companyos/core` | boundary script |
| F10 | Live network calls in tests/CI | Vitest network guard |

> **Allowed exception:** `ModelGateway` and `AgentRuntime` exist as **empty-handed interfaces**
> in `packages/core/src/ports`. Zero implementation, zero provider names, zero scheduling logic.

---

## 3. Sprint 0 task table

| Task ID | Task | Owner role | Acceptance Criteria | Test / Verification command | Status |
|---|---|---|---|---|---|
| **T0.1** | pnpm workspace init | Platform Engineer | `pnpm-workspace.yaml` globs `apps/*`, `packages/*`; root `package.json` `private:true`, `packageManager` pinned to an exact pnpm version, `engines.node >= 22.5`; `pnpm install` exits 0 | `pnpm install --frozen-lockfile; $LASTEXITCODE` → `0` then `node scripts/check-workspace.mjs` → prints `workspace ok: N packages` | ⬜ TODO |
| **T0.2** | tsconfig project references + strict | Core Architect | `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `module: nodenext`, `target: es2023`; every package has `composite:true` + `references`; no `any` in shipped source | `pnpm typecheck; $LASTEXITCODE` → `0` and `packages/core/tests/tsconfig-strict.test.ts :: strict flags match CANONICAL_SPEC §7` | ⬜ TODO |
| **T0.3** | ESLint 9 flat config + Prettier | Platform Engineer | `eslint.config.js` flat config, TS-aware; `prettier` config committed; `no-restricted-imports` blocks all 8 industry nouns inside `@companyos/core`; lint exits 0 | `pnpm lint; $LASTEXITCODE` → `0` and `packages/core/tests/lint-guard.test.ts :: eslint on packages/core/src reports 0 errors` | ⬜ TODO |
| **T0.4** | Vitest workspace setup | Platform Engineer | `vitest.workspace.ts` covers every package; `pnpm test` exits 0; coverage v8 reporter + thresholds (lines ≥ 70); a real assertion exists per package | `pnpm test -- --run; $LASTEXITCODE` → `0`; `packages/core/tests/smoke.test.ts :: core package loads` | ⬜ TODO |
| **T0.5** | `@companyos/core` skeleton + ports | Core Architect | package builds to ESM `dist`; exports **exactly** the 9 ports of spec §4 as types + minimal factories that throw `NotImplementedError` only where a port is not yet implementable; ports directory contains no I/O; **no industry nouns** | `pnpm --filter @companyos/core build; $LASTEXITCODE` → `0`; `packages/core/tests/ports.test.ts :: all 9 ports exported`; `node scripts/check-boundaries.mjs` → `boundaries ok` | ⬜ TODO |
| **T0.6** | `@companyos/contracts` (zod) | Core Architect | `EventEnvelope`, `CorrelationIds`, `PackManifest` zod schemas; `z.infer` types exported; parse failure throws with a JSON-pointer path; schema version field present | `pnpm --filter @companyos/contracts test -- --run; $LASTEXITCODE` → `0`; `packages/contracts/tests/envelope.test.ts :: rejects envelope without traceId`; `:: accepts a valid envelope` | ⬜ TODO |
| **T0.7** | `@companyos/persistence` + `node:sqlite` + migration runner + `0001_init.sql` | Persistence Engineer | `EntityStore<T>` implemented on `node:sqlite`; numbered migrations `NNNN_name.sql`; `schema_migrations(name, checksum, appliedAt)`; checksum mismatch throws `MigrationChecksumError`; re-apply is a no-op; `0001_init.sql` creates `schema_migrations` + a minimal `kv`/`entity` table with indexes; PRAGMAs `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` | `pnpm --filter @companyos/persistence test -- --run; $LASTEXITCODE` → `0`; `packages/persistence/tests/migration-runner.test.ts :: applies 0001_init.sql once`; `:: checksum mismatch throws MigrationChecksumError`; `packages/persistence/tests/entity-store.test.ts :: round-trips an entity by id` | ⬜ TODO |
| **T0.8** | `@companyos/observability` structured logging | Platform Engineer | JSON-lines `Logger` port impl; fields `{ts, level, msg, traceId, runId?, orgId?, ...}`; redaction allow-list masks any key matching `/token\|secret\|password\|apikey\|authorization/i`; console sink + rotating file sink (size-capped, N retained); child logger inherits correlation ids | `pnpm --filter @companyos/observability test -- --run; $LASTEXITCODE` → `0`; `packages/observability/tests/redaction.test.ts :: apiKey is masked as ***`; `:: correlation ids propagate to child logger`; `packages/observability/tests/rotation.test.ts :: file sink rotates and caps total size` | ⬜ TODO |
| **T0.9** | `@companyos/desktop` Electron main + preload | Desktop Engineer | app boots; `BrowserWindow` with `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, `webSecurity:true`; preload exposes `window.companyos` via `contextBridge.exposeInMainWorld` with a typed channel allow-list; no `ipcRenderer` leak; single-instance lock | `pnpm --filter @companyos/desktop test -- --run; $LASTEXITCODE` → `0`; `apps/desktop/tests/security.test.ts :: BrowserWindow options match hardening baseline`; `:: preload exposes only allow-listed channels` | ⬜ TODO |
| **T0.10** | `@companyos/renderer` React 19 + Vite | Desktop Engineer | Vite builds `apps/renderer/dist`; React 19 mounts a shell page that calls the bridge and renders `appVersion`; no Node built-ins imported; dev HMR works | `pnpm --filter @companyos/renderer build; $LASTEXITCODE` → `0`; `apps/renderer/tests/bridge.test.ts :: bridge version is surfaced`; `apps/renderer/tests/no-node-builtins.test.ts :: bundle graph contains zero node: imports` | ⬜ TODO |
| **T0.11** | `scripts/check-boundaries.mjs` | Core Architect | fails (exit 1) when any file under `packages/core/src/**` contains a forbidden noun (case-insensitive, word-boundary) or imports a `@companyos/pack-*` module; passes on the real tree; self-tests with in-memory fixtures | `node scripts/check-boundaries.mjs; $LASTEXITCODE` → `0`; `node --test scripts/tests/check-boundaries.test.mjs` → `9 fixtures: 8 fail, 1 pass` | ⬜ TODO |
| **T0.12** | `pnpm check` aggregate script | Platform Engineer | `check` runs `lint → typecheck → boundaries → test → build` in that order, fails fast on the first non-zero step, prints a per-step summary | `pnpm check; $LASTEXITCODE` → `0` and summary shows 5× `PASS`; `node scripts/tests/check-gate.test.mjs :: injected lint failure makes check exit non-zero` | ⬜ TODO |
| **T0.13** | GitHub Actions CI workflow | DevOps | `.github/workflows/ci.yml` runs on `push`/`pull_request`; Node 22 and 24 matrix; `pnpm install --frozen-lockfile` then `pnpm check`; concurrency cancels superseded runs; job required for merge | `act -j check` locally **or** one green CI run URL pasted into `PROJECT_HANDOFF.md`; `docs/tests/ci-config.test.ts :: workflow runs pnpm check and pins the node matrix` | ⬜ TODO |
| **T0.14** | `AGENTS.md` | Tech Lead | states: product one-liner, architecture law §1, all 8 forbidden nouns, "port is `EntityStore` not `Repository`", priority ladder P0–P4, sprint DoD, escalation/de-escalation rules, forbidden-scope policy | `docs/tests/agents-md.test.ts :: lists all 8 forbidden nouns`; `:: states EntityStore naming rule` | ⬜ TODO |
| **T0.15** | `PROJECT_HANDOFF.md` | Tech Lead | headings: Current State · Verified Commands · Environment Facts (Node/pnpm OS) · Sprint 0 Deliverables · Next Sprint Entry Point · Open Risks · Known Limitations; every command in it was actually run | `docs/tests/handoff.test.ts :: required headings present`; `:: every fenced command block parses` | ⬜ TODO |
| **T0.16** | Repo hygiene files | Platform Engineer | `.gitignore` covers `node_modules/`, `dist/`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `.env*`, `coverage/`, `*.log`; `.npmrc` sets `strict-peer-dependencies=true` and linker policy; `.editorconfig`, `.nvmrc`, `README.md` present; `git status --porcelain` shows no build artifacts | `git status --porcelain` → only tracked-file changes, no `dist/` or `*.sqlite*`; `node --test scripts/tests/hygiene.test.mjs :: gitignore covers sqlite and dist` | ⬜ TODO |
| **T0.17** | docs skeleton + ADR-0001 | Tech Lead | `docs/INDEX.md`, `docs/ARCHITECTURE.md`, `docs/adr/0001-monorepo-and-sqlite.md` exist, are linked, and record *why* pnpm + `node:sqlite` (no native compilation) | `docs/tests/links.test.ts :: all relative doc links resolve`; `:: adr 0001 exists and is indexed` | ⬜ TODO |
| **T0.18** | First git commit + tag | Release Engineer | `git init -b main`; one conventional-commit message `chore(sprint-0): initial commit and sprint-0.0.1 tag`; annotated tag `sprint-0.0.1` on HEAD; **no fabricated 40-hex commit hash appears in any document** | `git log --oneline` → 1 line; `git tag --points-at HEAD` → `sprint-0.0.1`; `grep -rE "\b[0-9a-f]{40}\b" docs/ *.md` → no match | ⬜ TODO |

**Task count:** `T0.1 … T0.18` (N = 18).

---

## 4. Step 8 — exact verification protocol (copy-pasteable)

Run from the repo root (`E:\DeepSeek.gzq\companyos`). Paste the whole block; every step must
produce the expected result. **The macro gate is step 8.1: `pnpm check` must exit `0`.**

```powershell
# ── Step 8.1 — THE GATE: everything (lint + typecheck + boundaries + test + build) ──
pnpm check                    ; if ($LASTEXITCODE -ne 0) { throw "GATE FAILED: pnpm check exit $LASTEXITCODE" }

# ── Step 8.2 — working tree must be clean of unintended change ──
git status                    # expect: "nothing to commit, working tree clean"
git status --porcelain        # expect: NO output (empty)

# ── Step 8.3 — no unstaged drift vs the Sprint 0 commit ──
git diff                      # expect: NO output
git diff --stat HEAD          # expect: NO output
git diff --cached             # expect: NO output

# ── Step 8.4 — tests ──
pnpm test                     # expect: all suites pass, 0 failed
pnpm -r test -- --run         # expect: same, per-package summary, exit 0

# ── Step 8.5 — build ──
pnpm -r build                 # expect: exit 0; dist/ emitted for every package
Test-Path apps\renderer\dist\index.html   # expect: True

# ── Step 8.6 — typecheck ──
pnpm -r typecheck             # expect: tsc -b exit 0, "0 errors"

# ── Step 8.7 — lint ──
pnpm lint                     # expect: exit 0, 0 errors, 0 warnings

# ── Step 8.8 — architecture boundary (the non-negotiable law) ──
node scripts/check-boundaries.mjs   # expect: "boundaries ok" and exit 0

# ── Step 8.9 — forbidden-scope proof (must print nothing) ──
Get-ChildItem packages\core\src -Recurse -File |
  Select-String -Pattern 'Coding|Git|Repository|Developer|CTO|Article|Video|Ecommerce' -CaseSensitive:$false
Get-ChildItem -Recurse -File -Include *.ts | Where-Object { $_.FullName -notmatch 'node_modules' } |
  Select-String -Pattern 'model-router|agent-runtime|devcompany|designer'
# expect: NO matches for either command

# ── Step 8.10 — tag is on HEAD ──
git tag --points-at HEAD      # expect: sprint-0.0.1
git log --oneline             # expect: exactly 1 line
```

### Expected-results table

| Step | Command | Expected stdout / exit | If it fails |
|---|---|---|---|
| 8.1 | `pnpm check` | exit **0**, 5× `PASS` summary | **BLOCKER** — fix before anything else; do not tag |
| 8.2 | `git status`, `git status --porcelain` | `working tree clean`, empty | commit or revert; no untracked `dist/`, `*.sqlite*` |
| 8.3 | `git diff`, `git diff --stat HEAD`, `git diff --cached` | empty, empty, empty | unstaged drift → `T0.18` invalid |
| 8.4 | `pnpm test` | 0 failed, all suites green | a failing test is a Sprint 0 failure |
| 8.5 | `pnpm -r build` + `Test-Path apps\renderer\dist\index.html` | exit 0, `True` | renderer build broken → `T0.10` |
| 8.6 | `pnpm -r typecheck` | exit 0, 0 errors | strict flags violated → `T0.2` |
| 8.7 | `pnpm lint` | exit 0, 0 errors | rule violation → `T0.3` |
| 8.8 | `node scripts/check-boundaries.mjs` | `boundaries ok`, exit 0 | forbidden noun in Core → `T0.11` |
| 8.9 | forbidden-scope grep | **no output** | forbidden scope present → delete it, `F1`–`F8` violated |
| 8.10 | `git tag --points-at HEAD`, `git log --oneline` | `sprint-0.0.1`, 1 line | amend before tag is pushed |

> **No commit hashes are recorded in this document by design.** Capture the hash at verification
> time from `git rev-parse HEAD` into `PROJECT_HANDOFF.md` if and only if the user asks for it.

---

## 5. Out of scope / deferred

### 5.1 Deferred to Sprint 1 (P0, contracts & kernel)

| Deferred | Why | Lands in |
|---|---|---|
| `IdFactory` ULID implementation + branded id types | port exists in S0, behavior is Sprint 1 | T1.1 |
| Injectable `Clock` (`SystemClock`, `FakeClock`) | port exists in S0 | T1.2 |
| `Result<T,E>` + full error taxonomy / code registry | only `NotImplementedError` placeholder in S0 | T1.3–T1.4 |
| Frozen event envelope semantics (validation at the bus edge) | schema exists, enforcement does not | T1.5 |
| Final port signature freeze + ADR-0002 | S0 ships provisional signatures | T1.6, T1.9 |
| Harden boundary test to 8 negative + 1 positive fixtures | S0 ships the working script only | T1.8 |
| MCP/tool contracts, capability registry resolution | needs frozen contracts first | Sprint 5/8 |

### 5.2 Deferred to later phases (explicitly forbidden now)

| Deferred | Phase / Sprint |
|---|---|
| Model Router, provider adapters, cost ledger, redaction of prompts | **P2 / Sprint 7** |
| 多模型调度 (multi-model scheduler, quotas, priority queues) | **P2 / Sprint 7** |
| Agent Runtime, node executor, tool invocation, checkpoint/resume, cancellation | **P2 / Sprint 8** |
| DevCompany archetypes (CTO / Developer / Reviewer / QA), coding & Git & repository capabilities | **P3 / Sprint 9** |
| Workflow Designer UI (canvas, inspector, publish/fork UI) | **P3 / Sprint 10** |
| Article / Video / Ecommerce content packs | **P3 / Sprint 10** |
| Workflow lifecycle & versioning (10 capabilities), `contentHash`, forks, locks, change proposals, metrics | **P1 / Sprint 3** |
| Memory scopes, retrieval port, embedding cache | **P1 / Sprint 4** |
| Handoff protocol, event bus implementation, DLQ, replay | **P1 / Sprint 5** |
| Governance, policy engine, approvals, budgets, audit chain | **P1 / Sprint 6** |
| Code signing, auto-update, encryption at rest, telemetry, plugin SDK, marketplace | **P4 / Sprint 11** |
| Cloud/team sync, SSO, billing | **P4+ / post-1.1** |

### 5.3 Explicit non-goals for Sprint 0

- No real workflow execution, no model calls, no network calls at all.
- No UI beyond a shell page proving the preload bridge works.
- No product features, only infrastructure + interfaces.

---

## 6. Traceability — task → acceptance criteria → verification

| Task ID | Acceptance Criteria (short form) | Verification artifact / command | Priority |
|---|---|---|---|
| T0.1 | workspace resolvable; install frozen-lockfile exits 0 | `node scripts/check-workspace.mjs` → `workspace ok` | P0 |
| T0.2 | strict + `noUncheckedIndexedAccess` + refs compile | `packages/core/tests/tsconfig-strict.test.ts :: strict flags match CANONICAL_SPEC §7` | P0 |
| T0.3 | lint 0 errors; 8 nouns banned in core | `packages/core/tests/lint-guard.test.ts :: eslint on packages/core/src reports 0 errors` | P0 |
| T0.4 | every package has a project + ≥1 real test | `vitest.workspace.ts` + `packages/core/tests/smoke.test.ts :: core package loads` | P0 |
| T0.5 | 9 ports exported; core pure | `packages/core/tests/ports.test.ts :: all 9 ports exported` + boundary script | P0 |
| T0.6 | zod schemas parse/reject correctly | `packages/contracts/tests/envelope.test.ts :: rejects envelope without traceId` | P0 |
| T0.7 | migration applies once; checksum verified; entity round-trip | `packages/persistence/tests/migration-runner.test.ts :: checksum mismatch throws MigrationChecksumError` | P0 |
| T0.8 | secrets masked; correlation ids propagate; rotation caps size | `packages/observability/tests/redaction.test.ts :: apiKey is masked as ***` | P0 |
| T0.9 | Electron hardening flags + allow-listed bridge | `apps/desktop/tests/security.test.ts :: BrowserWindow options match hardening baseline` | P0 |
| T0.10 | renderer builds; shows bridge version; no node builtins | `apps/renderer/tests/bridge.test.ts :: bridge version is surfaced` | P0 |
| T0.11 | 8 fixtures fail, 1 passes; real tree passes | `node --test scripts/tests/check-boundaries.test.mjs` | P0 |
| T0.12 | aggregate gate fails fast with per-step summary | `pnpm check` → exit 0 + 5× `PASS` | P0 |
| T0.13 | CI runs `pnpm check` on Node 22/24 | `docs/tests/ci-config.test.ts :: workflow runs pnpm check and pins the node matrix` | P0 |
| T0.14 | AGENTS.md states law + 8 nouns + EntityStore rule | `docs/tests/agents-md.test.ts :: lists all 8 forbidden nouns` | P0 |
| T0.15 | handoff doc complete and commands real | `docs/tests/handoff.test.ts :: required headings present` | P0 |
| T0.16 | hygiene files complete; no artifacts tracked | `node --test scripts/tests/hygiene.test.mjs :: gitignore covers sqlite and dist` | P0 |
| T0.17 | docs index + ADR-0001 linked and resolvable | `docs/tests/links.test.ts :: all relative doc links resolve` | P0 |
| T0.18 | 1 commit, tag `sprint-0.0.1`, no fabricated hashes | `git tag --points-at HEAD` → `sprint-0.0.1` | P0 |

**Coverage of the directive's 11-step gate:** every Sprint 0 deliverable named in the directive
(A1–A12) maps to at least one task row above; the verification block in §4 covers each of the
seven checks the directive's step 8 requires (check · status · diff · tests · build · typecheck ·
lint) plus boundary, forbidden-scope and tag proofs.

---

## 7. Sprint 0 Definition of Done (checklist)

- [ ] `T0.1`–`T0.18` all `🟩 DONE`.
- [ ] §4 verification block executed end-to-end with every step matching the expected-results table.
- [ ] `pnpm check` exits **0**.
- [ ] `git status` clean · `git diff` empty · exactly 1 commit · tag `sprint-0.0.1`.
- [ ] Zero forbidden-scope artifacts (`F1`–`F10` all clean).
- [ ] `AGENTS.md` and `PROJECT_HANDOFF.md` committed and accurate.
- [ ] `EXECUTION_ROADMAP.md` has been **diffed by the user** — Sprint 1 must not start otherwise.

**Risks:** Electron/`node:sqlite` version skew on Node 22.5 vs 24 → pin `engines`, document.
ESM↔CJS interop in the Electron main process → settle before `T0.10`.
Scope creep toward P2 features → the boundary script and forbidden-scope grep are hard failures, not warnings.
