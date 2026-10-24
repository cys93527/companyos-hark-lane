# CompanyOS V1.1 — Canonical Spec (single source of truth for all docs & code)

> STATUS: **RECONSTRUCTED**. The user-supplied planning file `最终1.1.txt` arrived at the
> harness as **0 bytes / empty** (sha256 `e3b0c442...` of the empty string). No project
> planning text was recoverable from it, and no `CompanyOS` planning document exists anywhere
> in the workspace. This spec is therefore derived **only** from the explicit 11-step execution
> directive the user issued, plus the non-negotiable constraints stated in that directive.
> Everything marked `[DERIVED]` must be diffed against the real 规划书 by the user before
> Sprint 1 is allowed to start.

## 0. Product in one paragraph

CompanyOS is a **local-first, desktop AI-company operating system**. A user staffs a virtual
company with role archetypes (executives, PM, architect, engineer, reviewer, QA, marketer),
binds them to **versioned, forkable workflows** (SOPs / DAG templates), and executes runs
against a **memory/knowledge substrate**. Runs are reproducible (immutable run snapshots),
auditable (event log), and portable across verticals (Industry Packs).

## 1. Architectural law (from the user directive — non-negotiable)

**`@companyos/core` MUST NOT depend on, name, or import any of:**

Coding · Git · Repository · Developer · CTO · Article · Video · Ecommerce

These nouns belong to **Industry Packs** (`@companyos/pack-*`), which depend on Core — never the reverse.
Consequence for naming: the persistence port in Core is `EntityStore`, **not** `Repository`.
The word `repository` must not appear as an identifier in `packages/core/src/**`.
Dependency direction is enforced by an automated boundary test (`scripts/check-boundaries.mjs`)
wired into `pnpm check`, and by ESLint `no-restricted-imports` in the core package.

## 2. Workflow Lifecycle — canonical vocabulary (10 capabilities)

| Capability | Canonical identifier | Meaning |
|---|---|---|
| Draft | `draft` state | Mutable authoring state. No production runs may be started. |
| Publish | `publish` transition | `draft → published`. Assigns immutable semver + `contentHash` (sha256 of canonical graph JSON). Published versions are append-only. |
| Version | `WorkflowVersion` entity | Immutable record `{id, templateId, semver, contentHash, graph, createdAt, changeProposalId?}`. Revision of a published template opens a **new** draft version; the old version is never mutated (e.g. `1.2.0` → draft `1.3.0-draft`). |
| Fork | `fork` transition | Clones a `published`/`deprecated` version into a **new** template in `draft`, recording `forkedFrom {templateId, versionId}`. Fork lineage is a first-class graph. |
| Deprecate | `deprecate` transition | `published → deprecated`. New runs are refused; already-issued run snapshots keep running on their pinned version. |
| Archive | `archive` transition | `deprecated → archived`. Terminal. Read-only forever; retained for audit. |
| Run Snapshot | `RunSnapshot` entity | Immutable pin of everything a run needs: `{id, workflowVersionId, templateLockId, packVersions, modelBindings, memoryViewRef, createdAt}`. A run reads its snapshot, never live template state. |
| Template Lock | `TemplateLock` entity | `{id, templateId, versionId, scope: 'run'|'global', reason, lockedBy, lockedAt, releasedAt?}`. Blocks mutation/publish racing against in-flight runs; `global` locks also block forking. |
| Change Proposal | `ChangeProposal` entity | `{id, targetTemplateId, baseVersionId, diff, rationale, author, status: open\|accepted\|rejected\|superseded, decidedBy?, decidedAt?}`. Only an `accepted` proposal can mint a new draft version. |
| Performance Metrics | `WorkflowMetrics` entity | Per-version rollups: `runCount, successRate, p50DurationMs, p95DurationMs, costUsd, tokensIn/Out, humanInterventions, nodeFailureRates{}`. Read-only projections; never mutate workflow state. |

State machine (single source of truth — must match `packages/core/src/lifecycle/lifecycle-machine.ts`):

```
draft --publish--> published --deprecate--> deprecated --archive--> archived
  ^                    |  |
  |                    |  +--lock(scope=run|global)--> (locked overlay)
  |                    +--fork--> NEW template(draft)
  |                    +--revise (via accepted ChangeProposal) --> NEW draft version
  +--------------------+
```
Illegal transitions must throw `LifecycleError` with code `ILLEGAL_TRANSITION`.
`archived` is absorbing (no outgoing edges).

## 3. Core bounded contexts (Sprint 1+, contracts only fixed in Sprint 0)

1. **Kernel** — ids (`ulid`), clock (injectable), `Result`, errors, event envelope.
2. **Org** — org units, role archetypes, staffing, authority/RACI. *(no industry nouns)*
3. **Workflow** — template, version, lifecycle, lock, fork, change proposal, metrics.
4. **Execution** — run, run snapshot, node execution, handoff, checkpoint/resume.
5. **Memory** — memory scopes (working / episodic / semantic / artifact), retrieval ports.
6. **Governance** — policy evaluation, budget, approvals, audit.
7. **Capability Registry** — packs register capabilities; Core resolves by contract only.

## 4. Ports (Core defines, outer layers implement)

`Clock`, `IdFactory`, `Logger`, `EventBus`, `EntityStore<T>`, `MigrationRunner`,
`SecretResolver`, `ModelGateway` (interface only — **no implementation in Sprint 0**),
`AgentRuntime` (interface only — **no implementation in Sprint 0**).

## 5. Priorities

- **P0** — Foundation: monorepo, Electron, React, TypeScript, SQLite, migrations, logging, tests, CI, governance docs. *(= Sprint 0, delivered)*
- **P1** — Core kernel + workflow lifecycle/versioning + memory + handoff + governance. Local-first, single user.
- **P2** — Model Router + Agent Runtime + multi-model scheduling + run engine.
- **P3** — Industry Packs: DevCompany, Coding/Git, Article, Video, Ecommerce; Workflow Designer UI.
- **P4** — Ecosystem: plugin SDK, pack marketplace, team/cloud sync, enterprise SSO, billing.

## 6. Sprint 0 scope (allowed) vs. prohibitions

ALLOWED: Monorepo · Electron · React · TypeScript · SQLite · Migration · Logging · Testing · CI ·
`AGENTS.md` · `PROJECT_HANDOFF.md`.

FORBIDDEN in Sprint 0 (do not build, do not scaffold, do not stub with logic):
Model Router · Agent Runtime · DevCompany · Coding Agent · Workflow Designer · 多模型调度.

## 7. Tech decisions (locked)

- Package manager: **pnpm workspaces**, Node ≥ 22 (dev env: Node 24).
- Language: **TypeScript strict** + `noUncheckedIndexedAccess`, ESM-first.
- Persistence: **SQLite via `node:sqlite`** (built into Node ≥ 22.5) behind
  `@companyos/persistence`; no native compilation step. Migrations are numbered
  `NNNN_name.sql` applied by a `schema_migrations` table with checksum verification.
- Logging: **structured JSON lines**, one `Logger` port, redaction allow-list, correlation ids
  (`traceId`, `runId`, `orgId`), console sink + rotating file sink.
- Desktop: **Electron** main/preload + **React 19 + Vite** renderer, contextIsolation on,
  no `nodeIntegration`, IPC through a typed preload bridge.
- Tests: **Vitest** (unit + architecture boundary tests). CI: GitHub Actions, `pnpm check`.

## 8. Definition of Done for any Sprint

`pnpm check` exits 0 (lint + typecheck + boundary + test + build), docs updated,
`PROJECT_HANDOFF.md` updated, one git commit with the sprint tag, no forbidden-scope code.
