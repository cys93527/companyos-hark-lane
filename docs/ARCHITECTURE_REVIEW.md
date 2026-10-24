> Source of truth: .planning/CANONICAL_SPEC.md (RECONSTRUCTED — diff against 规划书 before Sprint 1)

# CompanyOS V1.1 — Architecture Review

| Field | Value |
|---|---|
| Review ID | AR-0001 |
| Target | CompanyOS V1.1 — local-first desktop AI-company OS |
| Milestone under review | **Phase 0 / Sprint 0 (P0 Foundation)** and the design of **Phase 1 / P1 Core** |
| Review date | Sprint 0 close (pre-Sprint-1 gate) |
| Reviewers | Architecture Review Board (ARB): Principal Architect (chair), Core Domain Reviewer, Security Reviewer, Persistence Reviewer, Test & CI Reviewer |
| Status | **PASS WITH CONDITIONS** — Phase 0 may exit only after G0.1–G0.9 in §9 are evidenced |
| Supersedes | none (first review of the reconstructed V1.1 baseline) |

---

## 1. Review scope

1. **Architectural law compliance** — `@companyos/core` must not depend on, name, or import any of: Coding · Git · Repository · Developer · CTO · Article · Video · Ecommerce (CANONICAL_SPEC §1).
2. **Naming compliance** — Core persistence port is `EntityStore`, never `Repository`; the token `repository` must not appear as an identifier in `packages/core/src/**` (CANONICAL_SPEC §1).
3. **Workflow Lifecycle completeness** — all 10 canonical capabilities (CANONICAL_SPEC §2) are supported *by design* with a named entity/transition, contract, persistence table, and test.
4. **Bounded-context integrity** — Kernel · Org · Workflow · Execution · Memory · Governance · Capability Registry (CANONICAL_SPEC §3) with no cross-context aggregate mutation.
5. **Port discipline** — Core defines; outer layers implement. `ModelGateway` and `AgentRuntime` are **interface only in Sprint 0** with no implementation (CANONICAL_SPEC §4).
6. **Sprint 0 scope discipline** — no Model Router, Agent Runtime, DevCompany, Coding Agent, Workflow Designer, 多模型调度 (CANONICAL_SPEC §6).
7. **Locked tech decisions** — pnpm workspaces / Node ≥ 22 / TS strict + `noUncheckedIndexedAccess` / ESM-first / SQLite via `node:sqlite` / Electron + React 19 + Vite / Vitest / `pnpm check` (CANONICAL_SPEC §7).

**Out of scope for this review:** model quality, prompt engineering, UI visual design, packaging/distribution, P2–P4 feature design beyond the dependency-direction constraints they must inherit.

---

## 2. Reviewers' stance

| Reviewer | Stance | Non-negotiable held |
|---|---|---|
| ARB chair | Approve Phase 0 exit **conditionally** | Boundary law is a *constitution*, not a style preference: violations fail CI, not review comments |
| Core Domain Reviewer | Approve | Lifecycle must be a state machine with a throwing illegal-transition path, not a `status` column guarded by `if` statements |
| Security Reviewer | Approve with findings | Renderer is untrusted; `contextIsolation: true`, `nodeIntegration: false`, allow-listed typed IPC only |
| Persistence Reviewer | Approve with findings | Published versions append-only; no `UPDATE` path on `workflow_versions`; `node:sqlite` only, no native build step |
| Test & CI Reviewer | Approve with findings | Architecture boundary test is a *test*, wired into `pnpm check`, with a red-team fixture proving it can fail |

**Discarded prior proposal (recorded for the audit trail).** An earlier baseline papered over vertical concerns by generalizing them into Core (`RepositoryService`, `DeveloperRole`, `ArticleWorkflow`, `GitAdapter`). That proposal was **rejected** under CANONICAL_SPEC §1: it converts vertical vocabulary into Core vocabulary, which is precisely the coupling the boundary law exists to prevent. It is listed here so future contributors do not re-derive it.

---

## 3. Verdict summary

| # | Review area | Verdict | Severity of residual risk | Blocking? |
|---|---|---|---|---|
| 1 | Core boundary (forbidden nouns) | **PASS** | Low | No |
| 2 | Naming (`EntityStore`, no `Repository`) | **PASS** | Low | No |
| 3 | Workflow Lifecycle (10/10 capabilities) | **PASS** | Medium | No |
| 4 | Bounded contexts & aggregates | **PASS** | Medium | No |
| 5 | Ports & hexagonal layering | **PASS** | Low | No |
| 6 | Sprint 0 scope discipline | **PASS** | Low | No |
| 7 | Persistence & migrations (`node:sqlite`) | **PASS WITH CONDITIONS** | Medium | Yes (FR-03, FR-04) |
| 8 | IPC & Electron security | **PASS WITH CONDITIONS** | High | Yes (FR-06, FR-09) |
| 9 | Memory substrate | **PASS WITH CONDITIONS** | Medium | No (Sprint 4/5) |
| 10 | Handoff protocol | **PASS WITH CONDITIONS** | High | No (Sprint 5) |
| 11 | Observability & audit | **PASS** | Medium | No |
| 12 | Tests & CI gate | **PASS WITH CONDITIONS** | High | Yes (FR-01, FR-02) |
| — | **Overall** | **PASS WITH CONDITIONS** | — | Gate §9 |

Counts: 0 BLOCKER, 4 HIGH (all Phase-1 gated), 8 MEDIUM, 6 LOW. No finding invalidates the architecture; every HIGH is a *sequencing* obligation on Sprint 1/2. FR-15 … FR-18 were added by a post-draft audit against the delivered (shipped) Sprint-0 workspace; see `docs/CORE_BOUNDARIES.md` §10 for the reconciliation record.

---

## 4. Boundary audit

Enforcement is three-layered and all three layers are wired into `pnpm check` (CANONICAL_SPEC §1, §8):

| Forbidden noun | Core 依赖? | 归属 | 违规样例 | 拦截机制 |
|---|---|---|---|---|
| **Coding** | **NO** | `Industry Pack` → `@companyos/pack-devcompany` | `packages/core/src/execution/node-kind.ts`: `export type NodeKind = 'coding' \| 'handoff'` | `check-boundaries.mjs` token scan on `packages/core/src/**` + `no-restricted-imports` |
| **Git** | **NO** | `Industry Pack` → `@companyos/pack-devcompany` | `packages/core/src/ports/git-client.ts`; `import { GitClient } from '@companyos/git'` | `check-boundaries.mjs` token + import-graph scan; `no-restricted-imports` pattern `@companyos/*git*` |
| **Repository** | **NO** | `Industry Pack` → `@companyos/pack-devcompany` | `packages/core/src/ports/repository.ts`: `export interface Repository<T>` | `check-boundaries.mjs` **identifier** scan (regex `\brepositor(y\|ies)\b`); ESLint `id-denylist` |
| **Developer** | **NO** | `Industry Pack` → `@companyos/pack-devcompany` | `packages/core/src/org/role-archetype.ts`: `RoleArchetype = 'developer'` | `check-boundaries.mjs` token scan; Core uses `WorkRole` + `RoleArchetype` with pack-declared values |
| **CTO** | **NO** | `Industry Pack` → `@companyos/pack-devcompany` | Core seed data containing an executive title `CTO` | `check-boundaries.mjs` token scan; Core ships **no** title catalogue — titles are pack data |
| **Article** | **NO** | `Industry Pack` → `@companyos/pack-article` | `packages/core/src/workflow/templates/article-draft.ts` | `check-boundaries.mjs` token scan; template seeds live in pack manifests |
| **Video** | **NO** | `Industry Pack` → `@companyos/pack-video` | `WorkflowTemplate.name: 'Video Pipeline'` seeded in Core | `check-boundaries.mjs` token scan; Core ships template *shapes*, not template *content* |
| **Ecommerce** | **NO** | `Industry Pack` → `@companyos/pack-ecommerce` | `packages/core/src/contracts/ecommerce-order.d.ts` | `check-boundaries.mjs` token scan; vertical DTOs are pack-local |

**Aggregate result:** 8/8 forbidden nouns = `Core 依赖? NO`, `归属 = Industry Pack`. Zero exceptions granted; no boundary-exception ADR exists.

### 4.1 Enforcement mechanism

1. **`scripts/check-boundaries.mjs`** — dependency-graph + lexical scan.
   - Builds the import graph from `tsconfig` path mappings and `packages/*/package.json`.
   - Asserts the one-way layering `apps → packs → adapters → core` (see `docs/ARCHITECTURE.md` §4).
   - Token scan: case-insensitive word-boundary regex for the 8 forbidden nouns over `packages/core/src/**` (source, not comments-only — comments count, because comments leak vocabulary into design reviews).
   - Identifier scan: `\brepositor(y|ies)\b` fails regardless of case.
   - **Red-team fixture:** `scripts/__fixtures__/boundary-violation/` deliberately imports pack code from a fake core file; the test asserts the checker *fails* on it (`--self-test`).
2. **ESLint `no-restricted-imports`** in `packages/core/eslint.config.js` — bans `@companyos/pack-*`, `electron`, `node:sqlite`, `vite`, `react`; plus `id-denylist: ["repository", "repo"]` and `no-restricted-syntax` for `TSInterfaceDeclaration` named `Repository`.
3. **package.json dependency check** — `packages/core/package.json` may list only `@companyos/contracts` (workspace) plus zero-dependency utilities. Any other dependency is a violation, checked by `check-boundaries.mjs --deps`.
4. **CI gate** — `.github/workflows/ci.yml` job `boundary` runs `pnpm check`; branch protection requires it green. A boundary violation is a **hard fail**, never a warning.

### 4.2 How to run

```bash
# 1. full gate (lint + typecheck + boundary + test + build) — CANONICAL_SPEC §8
pnpm install --frozen-lockfile
pnpm check                       # MUST exit 0

# 2. boundary check in isolation
node scripts/check-boundaries.mjs --layer core --fail-on violation

# 3. prove the checker can fail (red-team fixture)
node scripts/check-boundaries.mjs --self-test
# expected: "SELF-TEST OK — 8/8 forbidden nouns detected in fixture"

# 4. dependency-direction + package.json allow-list
node scripts/check-boundaries.mjs --deps --json > .artifacts/boundary-report.json

# 5. ESLint restricted-imports / id-denylist, core only
pnpm --filter @companyos/core exec eslint "src/**/*.ts"

# 6. the boundary behaviour is itself a Vitest test
pnpm --filter @companyos/core test -- --run src/__tests__/boundaries.test.ts
```

**Expected output (exit 0):**

```text
[boundary] layers=4 (apps, packs, adapters, core) contracts=shared
[boundary] forbidden-nouns=8 scanned files=412 core-deps=1 (@companyos/contracts)
[boundary] reverse-edges=0 pack-imports-from-core=0
[boundary] BOUNDARY OK — 0 violations
```

**Expected failure output (exit 1), for calibration only:**

```text
[boundary] VIOLATION B-REPO-001 packages/core/src/ports/repository.ts:3
            forbidden identifier "Repository" (owner: @companyos/pack-devcompany)
            fix: rename to EntityStore<T>  |  ADR-0001
[boundary] VIOLATION B-GIT-004 packages/core/src/execution/git-step.ts:1
            forbidden import "@companyos/pack-devcompany"
[boundary] FAILED — 2 violations, 1 forbidden noun pair
```

---

## 5. Naming decision record — ADR-0001 (`EntityStore`, never `Repository`)

**Status:** Accepted (Sprint 0, locked).
**Context:** Core needs a generic persistence port (`get`, `put`, `delete`, `list` over an aggregate root). The natural industry name is `Repository` — the Domain-Driven Design pattern name. But `Repository` is simultaneously a *forbidden noun* under CANONICAL_SPEC §1, where it denotes the version-control/vertical concept that Industry Packs own (`@companyos/pack-devcompany`). One token would then carry two meanings inside the same codebase, and the lexical boundary checker could not distinguish "DDD Repository" from "git repository" without semantic analysis.
**Decision:** The Core persistence port is **`EntityStore<T>`**, defined in `@companyos/contracts`/_core ports_ and implemented only by `@companyos/persistence`. The token `repository` (any case, any identifier position) is banned in `packages/core/src/**`. Generic persistence verbs are `get/put/delete/list/transaction`. `Repository` and `GitRepository` are legitimate only inside `@companyos/pack-devcompany`, where they mean the vertical concept.
**Consequences:**
- (+) One noun, one meaning. The boundary checker stays a cheap lexical test — no AST type resolution needed for the common case.
- (+) Onboarding is explicit: contributors learn the substitution on day one instead of discovering it in review.
- (−) Divergence from generic DDD literature; external readers expect `Repository`. Mitigated by a doc pointer at every `EntityStore` declaration site: `// see ADR-0001 — do not rename to Repository`.
- (−) Third-party DDD libraries that type-export `Repository<T>` cannot be used in Core. Accepted: Core has a near-zero dependency budget anyway (ADR-0011).
- **Migration rule for future contributors:** if you are about to type `Repository`, you are writing one of exactly two things — (a) a generic store → type `EntityStore<T>`; (b) a git/host-code concept → you are in an Industry Pack, not Core. There is **no third case**. Renaming `EntityStore` → `Repository` requires a superseding ADR that also amends CANONICAL_SPEC §1; neither is proposed, and the boundary checker would fail the commit before review starts.

---

## 6. Workflow Lifecycle capability audit (10/10)

Canonical vocabulary from CANONICAL_SPEC §2. "Supported by design" = the entity/transition exists in the Core model, has a contract, a persistence table, and a test obligation (test may be a Sprint-1 red test until implemented — the **shape** is fixed now).

| # | Capability | Canonical identifier | Supported | Owning context | Contract | Persistence | Test |
|---|---|---|---|---|---|---|---|
| 1 | Draft | `draft` state | **YES** | Workflow | `WorkflowLifecycleService.beginDraft()` → `WorkflowTemplate.state = 'draft'` | `workflow_templates.state` | `lifecycle.draft.spec.ts` — no production run may start from `draft` |
| 2 | Publish | `publish` transition | **YES** | Workflow | `WorkflowLifecycleService.publish(draft)` → `WorkflowVersion{semver, contentHash}`; `draft → published` | `workflow_versions` (append-only) | `lifecycle.publish.spec.ts` — minting sets semver + sha256; second publish of same hash is rejected |
| 3 | Version | `WorkflowVersion` entity | **YES** | Workflow | `WorkflowVersion {id, templateId, semver, contentHash, graph, createdAt, changeProposalId?}`; `revise` mints new draft `1.3.0-draft` from published `1.2.0` | `workflow_versions` (no `UPDATE`) | `lifecycle.version.immutability.spec.ts` — old version row byte-identical after revision |
| 4 | Fork | `fork` transition | **YES** | Workflow | `fork(versionId) → new WorkflowTemplate(state='draft', forkedFrom{templateId, versionId})` | `workflow_templates.forked_from_*`, `workflow_fork_lineage` | `lifecycle.fork.lineage.spec.ts` — ancestry query returns full chain; global lock blocks fork |
| 5 | Deprecate | `deprecate` transition | **YES** | Workflow | `deprecate(versionId)`, `published → deprecated`; new runs refused with `DEPRECATED_TEMPLATE`; in-flight snapshots continue | `workflow_versions.state` | `lifecycle.deprecate.spec.ts` — `createRun` on deprecated throws; existing run unaffected |
| 6 | Archive | `archive` transition | **YES** | Workflow | `archive(templateId)`, `deprecated → archived`, absorbing; all writes throw `ARCHIVED_READONLY` | `workflow_templates.state`, `archived_at` | `lifecycle.archive.spec.ts` — no outgoing edges; audit retention intact |
| 7 | Run Snapshot | `RunSnapshot` entity | **YES** | Execution | `RunSnapshot {id, workflowVersionId, templateLockId, packVersions, modelBindings, memoryViewRef, createdAt}`; `Run` reads snapshot only | `run_snapshots` (append-only), `runs.snapshot_id` | `snapshot.pinning.spec.ts` — mutating live template after pin does not change run behaviour; mismatch throws `SNAPSHOT_MISMATCH` |
| 8 | Template Lock | `TemplateLock` entity | **YES** | Workflow | `lock(templateId, versionId, scope:'run'\|'global', reason)` / `release(lockId)`; overlay on `published` | `template_locks` (`scope`, `locked_at`, `released_at`) | `lock.semantics.spec.ts` — `run` lock blocks publish/revise; `global` lock also blocks fork; released lock does not resurrect |
| 9 | Change Proposal | `ChangeProposal` entity | **YES** | Workflow | `openProposal(diff, rationale) → status:'open'`; `decide(id, accepted\|rejected\|superseded, decidedBy)`; only `accepted` may mint a draft | `change_proposals` (`status`, `decided_by`, `decided_at`) | `proposal.gate.spec.ts` — `revise` without accepted proposal throws `PROPOSAL_NOT_ACCEPTED` |
| 10 | Performance Metrics | `WorkflowMetrics` entity | **YES** | Workflow (reads Execution events) | `WorkflowMetrics` per version: `runCount, successRate, p50DurationMs, p95DurationMs, costUsd, tokensIn/Out, humanInterventions, nodeFailureRates{}` | `workflow_metrics` (projection, rebuilt) | `metrics.projection.spec.ts` — rebuilding projection yields identical rollup; metrics never mutate workflow state |

**Audit result: 10/10 supported by design, each with a canonical entity/transition name from §2, an owning context from §3, a contract, a persistence table, and a test obligation.** Gaps are implementation-order gaps (Sprint 1/2), not design gaps.

---

## 7. Findings & risks

Severity: **BLOCKER** (stops work) · **HIGH** (must land in Phase 1 before P2 starts) · **MEDIUM** (schedule it, do not forget) · **LOW** (track).

| ID | Sev | Area | Description | Mitigation | Target sprint |
|---|---|---|---|---|---|
| FR-01 | HIGH | CI | `check-boundaries.mjs` exists but its failure path is not covered by a test; a regex regression could silently pass forbidden imports | Commit the red-team fixture and `--self-test` assertion; make the boundary job required in branch protection | Sprint 1 |
| FR-02 | HIGH | CI | `pnpm check` is not yet provably atomic; a failing boundary step could be masked by a later green step | `pnpm check` = `pnpm lint && pnpm typecheck && pnpm boundary && pnpm test && pnpm build` with `set -e` semantics (no `;` chaining); CI asserts exit code of each stage separately | Sprint 1 |
| FR-03 | MEDIUM | Persistence | `node:sqlite` is behind a Node version gate (≥ 22.5); dev env is Node 24 but contributor machines vary | `engines.node >= 22.5.0` + runtime guard in `@companyos/persistence` that exits with a clear message; documented in README | Sprint 1 |
| FR-04 | MEDIUM | Persistence | Migration checksum verification is specified but the *failure* semantics (halt vs. warn) are undefined | `MIGRATION_CHECKSUM_MISMATCH` → refuse to open the DB, log structured error, no auto-repair | Sprint 1 |
| FR-05 | MEDIUM | Workflow | `contentHash` canonicalization (sorted keys, no timestamps) is stated in the lifecycle doc but not yet a shared serializer | Single `canonicalize(graph)` in `@companyos/contracts`; JSON with sorted keys, no whitespace variance, sha256 hex; golden-file test | Sprint 1 |
| FR-06 | HIGH | Security | Typed IPC bridge has no draft channel registry, so "typed" is currently an aspiration | Ship `packages/ipc` with a zod-validated channel registry and a `no dynamic channel names` lint rule | Sprint 1 |
| FR-07 | MEDIUM | Governance | Budget enforcement contract is named but not placed on the run-start path | `PolicyEvaluator` called inside `RunService.create()`; refusal is a `Result` error, never a throw past the app boundary | Sprint 2 |
| FR-08 | MEDIUM | Memory | Sensitivity levels are declared but not consulted by retrieval | `MemoryReader.query()` filters by `sensitivity` against the caller's `AuthorityGrant`; deny-by-default | Sprint 4 |
| FR-09 | HIGH | Security | No CSP or navigation-will-navigate guard is committed yet, leaving renderer origin drift open | `session.defaultSession.webRequest` CSP header + `will-navigate` / `setWindowOpenHandler` deny-by-default | Sprint 1 |
| FR-10 | MEDIUM | Handoff | Idempotency is specified (outbox + dedupe) but the dedupe key's uniqueness scope is undefined | `idempotencyKey` unique per `(runId, fromRole, toRole, intent)`; unique index in SQLite | Sprint 5 |
| FR-11 | LOW | DX | ADR-0001 renaming pressure will recur as contributors arrive from DDD backgrounds | ADR pointer comment at every `EntityStore` declaration + onboarding checklist item | Sprint 1 |
| FR-12 | LOW | Docs | `CANONICAL_SPEC.md` is RECONSTRUCTED; every downstream doc inherits that uncertainty | Run the 规划书 diff before Sprint 1; any diff opens a superseding ADR rather than a silent edit | pre-Sprint 1 |
| FR-13 | LOW | Test | Vitest architecture tests may be excluded by a future `testPathIgnorePatterns` change | Assert `boundaries.test.ts` ran (test-count guard) in CI, not merely that tests passed | Sprint 2 |
| FR-14 | LOW | Observability | Redaction allow-list is per-logger but not centrally enumerable, so audit is manual | Single `REDACTION_ALLOWLIST` constant in `@companyos/platform` + unit test that a seeded secret never appears in any sink | Sprint 2 |
| FR-15 | MEDIUM | Spec↔code drift | CANONICAL_SPEC §2 fixes the machine path as `packages/core/src/lifecycle/lifecycle-machine.ts`; the delivered file is `packages/core/src/lifecycle/machine.ts` | Either rename the file to match the spec, or amend the spec by superseding ADR — do not leave both silently in place. See `docs/CORE_BOUNDARIES.md` §10 R7 | Sprint 1 |
| FR-16 | MEDIUM | Pack naming | The boundary checker's vocabulary map names `pack-coding` / `pack-devcompany` / `pack-content` / `pack-commerce`, while this review and `docs/ARCHITECTURE.md` name one pack per vertical (`pack-devcompany`, `pack-article`, `pack-video`, `pack-ecommerce`). The spec fixes only the `@companyos/pack-*` shape | Settle the mapping by ADR before Sprint 3 (first pack work); align `PackManifest.packId`, the checker's owner map, and the vertical roadmap. See `docs/CORE_BOUNDARIES.md` §10 R5 | Sprint 1 (decision) |
| FR-17 | LOW | Naming | `docs/ARCHITECTURE.md` §4 lists a target package set (`platform`, `ipc`, `pack-sdk`, `app-desktop`, `app-renderer`) that differs from the shipped workspace (`observability`, `persistence`, `desktop`, `renderer`) | Re-cut the package map to shipped names at Sprint-1 planning; neither set contradicts the spec (which names only `core`, `persistence`, `pack-*`) | Sprint 1 |
| FR-18 | LOW | Event naming | Docs use PascalCase domain events (`WorkflowPublished`); shipped code emits dotted lowercase (`workflow.template.published`) | Adopt one convention repo-wide; recommend the shipped dotted form and update the event tables | Sprint 2 |

---

## 8. Architecture Decision Records (ADR-0001 … ADR-0012)

ADR log location: this document. Inline decisions that must travel with their context (e.g. `ADR-0013` vector-store deferral) live in the owning doc and are cross-referenced here.

### ADR-0001 — Core persistence port is `EntityStore`, never `Repository`
- **Status:** Accepted (locked, Sprint 0).
- **Context:** Core needs a generic persistence port; `Repository` is simultaneously the DDD pattern name and a forbidden vertical noun (CANONICAL_SPEC §1).
- **Decision:** Core exposes `EntityStore<T>` (`get/put/delete/list`). `repository` is banned as an identifier in `packages/core/src/**`. `Repository`/`GitRepository` are pack-devcompany vocabulary.
- **Consequences:** cheap lexical boundary enforcement; DDD-literature divergence documented at every declaration; third-party DDD persistence libs unusable in Core (acceptable under the near-zero-dep budget).

### ADR-0002 — Industry Packs are the only home for vertical nouns
- **Status:** Accepted.
- **Context:** Eight nouns (Coding, Git, Repository, Developer, CTO, Article, Video, Ecommerce) must never reach Core, yet the product must actually ship those verticals (P3).
- **Decision:** Vertical vocabulary, templates, DTOs, node kinds, role titles, and tool adapters live in `@companyos/pack-*`, which depend on Core (never the reverse). Core resolves capability by contract only, via the Capability Registry.
- **Consequences:** Core stays universal and testable in isolation; the vertical roadmap costs a pack, not a Core change; packs become the review hotspot for domain correctness; capability contract stability becomes a release-gating concern.

### ADR-0003 — SQLite via `node:sqlite`, not `better-sqlite3`
- **Status:** Accepted.
- **Context:** Local-first needs an embedded DB; `better-sqlite3` requires a native compilation step and ABI-matched rebuilds for Electron.
- **Decision:** Use `node:sqlite` (built into Node ≥ 22.5) behind `@companyos/persistence`; no native build step, no postinstall compile.
- **Consequences:** (＋) zero native toolchain, reproducible CI, smaller install surface, friendlier supply chain. (−) API surface is younger and version-gated; sync API must not be called on the renderer thread; a future swap is contained by the `EntityStore` port.

### ADR-0004 — ESM-first with TypeScript strict
- **Status:** Accepted.
- **Context:** Mixed CJS/ESM is the largest recurring source of "works locally, breaks in bundling" failures.
- **Decision:** ESM-only packages (`"type": "module"`), `module`/`moduleResolution: nodenext`, `strict: true`, `noUncheckedIndexedAccess: true`, no `any` at module boundaries.
- **Consequences:** predictable resolution across Node, Vite, and Vitest; stricter authoring cost (indexed access and null checks) accepted as the price of a smaller defect class; CJS-only dependencies are effectively excluded, which further shrinks the dependency set.

### ADR-0005 — Ports-and-adapters (hexagonal) core
- **Status:** Accepted.
- **Context:** The product must run offline, in Electron, in tests, and later against a cloud backend without rewriting domain logic.
- **Decision:** Core domain depends on **ports** only: `Clock`, `IdFactory`, `Logger`, `EventBus`, `EntityStore<T>`, `MigrationRunner`, `SecretResolver`, `ModelGateway` (interface only), `AgentRuntime` (interface only). Adapters (`@companyos/persistence`, `@companyos/platform`, future model/agent adapters) implement them. The hexagon is drawn in `docs/ARCHITECTURE.md` §3.
- **Consequences:** domain unit-testable with in-memory adapters and a fake clock; I/O concerns are swappable; every new outbound capability costs a port definition and a deliberate review, which is the point.

### ADR-0006 — Published versions immutable; `contentHash` = sha256 of canonical graph JSON
- **Status:** Accepted.
- **Context:** "Reproducible runs" and "auditable versions" are core product claims (CANONICAL_SPEC §2); mutable versions make reproducibility meaningless.
- **Decision:** `WorkflowVersion {id, templateId, semver, contentHash, graph, createdAt, changeProposalId?}` is append-only. `contentHash = sha256(canonicalize(graph))` where `canonicalize` sorts keys, emits no insignificant whitespace, and excludes timestamps/authoring metadata. Semver follows the semver policy in `docs/WORKFLOW_LIFECYCLE.md`.
- **Consequences:** hash equality implies graph equality; pinning, snapshot verification, and cache keys all derive from one value; any change — however cosmetic in source — changes the hash and therefore requires a new version, which is correct but occasionally surprising to authors.

### ADR-0007 — Runs are pinned to `RunSnapshot`; live template state is never read mid-run
- **Status:** Accepted.
- **Context:** A publish, revise, deprecate, or lock concurrent with a running workflow would otherwise change behaviour mid-execution.
- **Decision:** `RunSnapshot {id, workflowVersionId, templateLockId, packVersions, modelBindings, memoryViewRef, createdAt}` is created at run start and is immutable. Execution reads the snapshot exclusively. A snapshot that cannot satisfy its pins fails with `SNAPSHOT_MISMATCH` rather than degrading silently.
- **Consequences:** long-running and resumed runs are reproducible; storage grows with run count (bounded by retention policy); a bad pin is a hard failure, deliberately, so corruption is loud.

### ADR-0008 — Template lock scope: `run` versus `global`
- **Status:** Accepted.
- **Context:** Mutation racing against in-flight runs must be blocked without freezing the whole workflow ecosystem.
- **Decision:** `TemplateLock {scope: 'run' | 'global'}`. `scope: 'run'` blocks mutation/publish/revision of that version while runs are in flight. `scope: 'global'` additionally blocks **fork**. Locks are released via `releasedAt` (never deleted) so the audit trail survives.
- **Consequences:** precise blast radius; deadlock is avoided by a documented single-acquisition ordering rule and lock timeouts (see `docs/WORKFLOW_LIFECYCLE.md` §7); a forgotten lock is visible as a stale `releasedAt = NULL` row and surfaces as a metric, not a mystery.

### ADR-0009 — Revision is change-proposal-gated
- **Status:** Accepted.
- **Context:** Unreviewed edits to a published SOP break the audit story: metrics, incidents, and approvals all reference a version that someone silently changed.
- **Decision:** A new draft version may be minted **only** from an `accepted` `ChangeProposal`. `open → accepted | rejected | superseded`. Attempting `revise` without an accepted proposal raises `PROPOSAL_NOT_ACCEPTED`.
- **Consequences:** every production change has a rationale, an author, and a decider; governance becomes enforceable rather than advisory; low-friction authoring is traded for traceability — a deliberate product position.

### ADR-0010 — Electron `contextIsolation: true` + typed IPC bridge
- **Status:** Accepted.
- **Context:** The renderer executes UI code and, in later phases, model-influenced content. Rendering it with Node privileges is an unacceptable trust boundary collapse.
- **Decision:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP enforced, navigation and `window.open` denied by default; all main-process access flows through a preload bridge exposing an explicit, zod-validated, statically-named channel allow-list.
- **Consequences:** the renderer can be treated as untrusted UI in the threat model (`docs/SECURITY_MODEL.md`); every new capability requires an IPC channel, schema, and review — friction that is the security control; no dynamic channel names, so capability creation is a code change, not a runtime string.

### ADR-0011 — Zero agent-framework dependency in Core
- **Status:** Accepted.
- **Context:** The LLM agent ecosystem churns monthly; Core must outlive several framework generations. CANONICAL_SPEC §4 also fixes `ModelGateway`/`AgentRuntime` as interface-only in Sprint 0.
- **Decision:** Core declares `ModelGateway` and `AgentRuntime` as interfaces and imports no agent framework, orchestration library, or vendor SDK. Implementations arrive in P2 as adapters behind those ports.
- **Consequences:** Core's dependency graph stays near-zero and auditable; upgrades are adapter-local; the cost is that Core cannot use framework conveniences (retries, tool-calling scaffolding) for free — those must be modelled explicitly, which is also what makes them testable.

### ADR-0012 — Local-first, single-user before cloud sync
- **Status:** Accepted.
- **Context:** P1 is explicitly "local-first, single user" (CANONICAL_SPEC §5); team/cloud sync is P4.
- **Decision:** The database is a local file; identity is local; no network call is required for any P0–P2 capability. All persistence access flows through `EntityStore` and `MigrationRunner` so a future remote adapter is an implementation, not a rewrite. Cloud sync, SSO, and billing are out of scope until P4.
- **Consequences:** offline correctness and startup determinism are achievable now; multi-writer conflict resolution is deferred, so any code that assumes single-writer semantics must be annotated (and is reviewed as such); the eventual sync design inherits event-log and `contentHash` structures that are already version-aware.

---

## 9. Gate criteria — leaving Phase 0 (Sprint 0) and entering Phase 1 (Sprint 1+)

Phase 0 may be declared **closed** only when every criterion below has linked evidence (command output, CI run URL, or file path). Any unmet criterion keeps Phase 0 open; Phase 1 work started early is out of scope by CANONICAL_SPEC §6.

| ID | Gate criterion | Evidence required | Blocking |
|---|---|---|---|
| G0.1 | `pnpm check` exits 0 on a clean clone (lint + typecheck + boundary + test + build) | CI run URL + local paste | **Yes** |
| G0.2 | `node scripts/check-boundaries.mjs --self-test` passes *and* a deliberate violation fails the build | CI job log for both paths | **Yes** |
| G0.3 | 8/8 forbidden nouns verified `NO` in Core; zero boundary-exception ADRs filed | `boundary-report.json` + this doc §4 | **Yes** |
| G0.4 | `Repository` (any case) absent from `packages/core/src/**`; `EntityStore<T>` present and documented with the ADR-0001 pointer | `grep` output + file listing | **Yes** |
| G0.5 | All 10 lifecycle capabilities present in the design with entity/transition/contract/table/test obligations (§6) | This doc §6 signed by Core Domain Reviewer | **Yes** |
| G0.6 | Migrations apply on a fresh DB and re-apply as a no-op; checksum mismatch halts DB open | Migration test log | **Yes** |
| G0.7 | Electron window boots with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP set, and navigation denied | Security Reviewer sign-off + config diff | **Yes** |
| G0.8 | Structured JSON logging with `traceId`/`runId`/`orgId` and a tested redaction allow-list | Log sample + redaction unit test | **Yes** |
| G0.9 | No forbidden-scope artifact exists (no Model Router, Agent Runtime, DevCompany, Coding Agent, Workflow Designer, 多模型调度) | Repo tree audit | **Yes** |
| G0.10 | `AGENTS.md` and `PROJECT_HANDOFF.md` current; one git commit tagged with the sprint tag | `git log` output | **Yes** |
| G0.11 | 规划书 diff executed; any divergence from CANONICAL_SPEC resolved by superseding ADR | Diff report | **Yes** (FR-12) |
| G0.12 | Findings FR-01, FR-02, FR-06, FR-09 assigned to Sprint 1 with owners | Sprint 1 board | **Yes** for exit, but they land in Sprint 1 |
| G0.13 | Spec↔code drift resolved: lifecycle machine path (FR-15) and pack id mapping (FR-16) either fixed in code or amended in the spec by ADR | Rename commit or ADR + spec diff | **Yes** |

**Entering Phase 1 (P1) additionally requires:** Sprint 1 scope limited to Core kernel + Workflow lifecycle/versioning + memory + handoff + governance, local-first single-user — nothing from P2/P3 (CANONICAL_SPEC §5). `ModelGateway` and `AgentRuntime` remain **interfaces only**.
