# CompanyOS Architecture Laws (ARCH-001..ARCH-032)

> Status: **FROZEN** — normative, not advisory. Automated laws fail `pnpm check`;
> document-only laws are explicit below with the reason. Baseline: `779491b`
> (Sprint 21 frozen). Source of the recon matrix: `ARCHITECTURE_LAW_MATRIX.md`.

**How to read this file.** Each law names its canonical owner, a forbidden and an
allowed example, the automated guard that enforces it (or the explicit reason it is
document-only), and the Sprint/ADR that froze it. **False-positive control** (§39):
every identifier scan strips comments and string literals, so documentation,
forbidden-field lists and error-message strings never trip a guard; recency is
banned only as *semantic authority* — documented tie-breaks are allowed.

**Amendment process.** A new canonical table, a new exemption, or a new automated
guard requires an ADR amendment to this file. Nothing is grandfathered silently
(Sprint22 §47): the one existing exemption is listed in §Exceptions.

| Guard | Location | Runs |
|---|---|---|
| Boundary guard (ARCH-001/002) | `scripts/check-boundaries.mjs` | `pnpm check` step `boundaries` |
| Architecture guard (ARCH-003..ARCH-039) | `scripts/check-architecture.mjs` | `pnpm check` step `architecture`, fast path `pnpm test:architecture` |
| Architecture law probes (both directions) | `tests/architecture/architecture-laws.test.ts` | `pnpm check` step `test` |

---

## Dependency direction

### ARCH-003 — Dependency direction (source level)
**Statement.** Core ← Contracts ← Engine ← Desktop. Engine and Persistence are
inner-ring implementors: their sources may import Core contracts/ports only —
never apps, Electron or React.
**Canonical owner.** ADR-0005 (engine boundary) + the monorepo manifests.
**Forbidden.** `packages/engine/src/foo.ts` importing `@companyos/desktop`.
**Allowed.** `apps/desktop/src/core-services.ts` importing `@companyos/engine`.
**Automated guard.** `check-architecture.mjs` ARCH-003 (import specifier scan over
`packages/engine/src` + `packages/persistence/src`).
**Source.** ADR-0005; Sprint 22.

## Core neutrality

### ARCH-001 — Core is industry neutral (vocabulary)
**Statement.** Core/Contracts sources must not name Pack concepts (Coding, Git,
Repository, Developer, CTO, Article, Video, Ecommerce) as identifiers.
**Canonical owner.** ADR-0002 / CORE_BOUNDARIES §1.
**Forbidden.** `class Repository {...}` in `packages/core/src/**`.
**Allowed.** `EntityStore`, `WorkRole` — or the concept inside `packs/dev-company`.
**Automated guard.** `check-boundaries.mjs` LAW 1 (comment/string-stripped
identifier scan) + the ESLint `no-restricted-syntax` twin.
**Source.** ADR-0002; Sprint 0 (kept, re-homed).

### ARCH-002 — Core/Contracts imports stay inner-ring
**Statement.** Core and Contracts import only themselves and Node built-ins —
never Packs, apps, UI, Electron or adapters.
**Canonical owner.** ADR-0002/0005 / CORE_BOUNDARIES §1.
**Forbidden.** `packages/core/src/**` importing `@companyos/pack-*` or `electron`.
**Allowed.** Relative Core/Contracts imports and `node:` built-ins.
**Automated guard.** `check-boundaries.mjs` LAW 1b (import specifier scan) + the
ESLint `no-restricted-imports` twin.
**Source.** ADR-0002/0005; Sprint 0 (kept, re-homed).

### ARCH-031 — Software is a Pack (generic paths stay vocabulary-clean)
**Statement.** The GENERIC orchestration sources (engine `supervisor/`,
`projection/`) must not name or import software-pack concepts; the ADR-0028
repository seam and `packs/dev-company` are the allowed homes.
**Canonical owner.** ADR-0002 + ADR-0028.
**Forbidden.** `import ... from '../repository/repository-git.js'` in
`packages/engine/src/supervisor/**`.
**Allowed.** The same code under `packages/engine/src/repository/**` (ADR-0028
seam) or in the pack.
**Automated guard.** `check-architecture.mjs` ARCH-031 (identifier scan + import
specifier scan over the two generic module dirs).
**Source.** ADR-0002/0028; Sprint 22.

## Execution safety (Sprint 25)

### ARCH-033 — No wholesale parent-environment inheritance
**Statement.** No child process this system creates receives the parent
environment as-is. Exactly ONE environment law applies to every process
(repository tools and provider executions alike): an allowlist of host variable
names plus the trusted composition's declared additions, filtered through
`buildExecutorEnvironment`. `{ ...process.env }` and `env: process.env` are both
forbidden spellings of the same leak — they hand an external provider every
credential the operator's shell happened to carry.
**Canonical owner.** ADR-0028 D12/D18/D19 (repository process runner), extended
to the Sprint 25 executor seam by `execution-safety.ts`.
**Forbidden.** `env: { ...process.env, ...additions }` in a provider/adapter
spawn; passing `process.env` as a child environment.
**Allowed.** A reference to `process.env` as the FILTER SOURCE
(`hostEnv: process.env`) that the allowlist then narrows — the parent environment
is read, never forwarded.
**Automated guard.** `check-architecture.mjs` ARCH-033 (spread + `env:` scan over
`packages/engine/src/executor` and `apps/desktop/src/executor`).
**Source.** Sprint 25 (SECRETS/CONFIG/WORKSPACE SAFETY contract §16).

### ARCH-034 — Path containment is a component boundary, never a prefix
**Statement.** A path is inside the trusted workspace root only when it equals the
root or begins with the SEPARATOR-TERMINATED root (or when the shared containment
helper says so). A bare `candidate.startsWith(root)` is forbidden: it accepts
`C:\work\foobar` for the root `C:\work\foo` — a sibling directory that is not the
workspace.
**Canonical owner.** ADR-0028 D11–D13 (`path-policy.ts`), whose exported
`assertPathWithinCanonicalRoot` is the single boundary test for repository tools
and the executor cwd alike.
**Forbidden.** `absolute.startsWith(root)` in a containment decision.
**Allowed.** `absolute.startsWith(root + sep)`, the shared helper, and
content/string checks (git porcelain kinds, NDJSON tokens) that are not path
containment.
**Automated guard.** `check-architecture.mjs` ARCH-034 (raw-prefix scan over
`packages/engine/src/repository` and `packages/engine/src/executor`).
**Source.** Sprint 25 (contract §24-§25).

### ARCH-035 — The renderer is untrusted (no domain/durable imports)
**Statement.** Renderer sources may reach the preload bridge only. Importing
persistence, SQLite, engine domain services, or a provider adapter from
`apps/renderer/src` hands an untrusted process authority the trust boundary reserves
to the main process.
**Canonical owner.** Sprint 26 (renderer trust boundary; channels.ts allowlist).
**Forbidden.** `apps/renderer/src/**` importing `@companyos/persistence`,
`better-sqlite3`, `@companyos/engine`, a provider adapter, or `child_process`.
**Allowed.** Bridge calls through `window.companyos` (`workflowRequest`,
`controlPlaneRequest`, read-only shell queries).
**Automated guard.** `check-architecture.mjs` ARCH-035 (comment/string-stripped
import scan over `apps/renderer/src`).
**Source.** Sprint 26 (Product Control Plane contract §9/§34).

### ARCH-036 — The Control Plane projection is read-only
**Statement.** `control-plane.ts` is the Goal runtime's typed surface: it forwards
commands to canonical services and projects their truth. It owns no truth, so its
own module performs no direct durable writes — a dashboard that writes becomes a
second truth owner.
**Canonical owner.** Sprint 26 (contract §32/§33); the canonical services remain the
sole writers.
**Forbidden.** A direct `INSERT/UPDATE/DELETE/CREATE/DROP` (or `exec`) against the
database inside `apps/desktop/src/control-plane.ts`.
**Allowed.** Forwarding to lifecycle/engine/supervisor/handoff/decision services,
and READ-ONLY SQL through the injected read seams.
**Automated guard.** `check-architecture.mjs` ARCH-036 (SQL-write scan over the
control-plane module).
**Source.** Sprint 26 (contract §32/§33/§60).

### ARCH-037 — An external provider is never CompanyOS authority
**Statement.** `ModelProviderPort` (reasoning) and `ExecutorProvider` (external
execution) are subordinate capability adapters. CompanyOS owns Goal, Plan,
WorkflowVersion, Run, Task, ExecutionAttempt, Decision, Artifact, Evidence,
Validation, Recovery, Handoff and Outcome. Two mechanical facets: (a) PRODUCTION
sources never resolve the test mock provider — a mock in the shipped composition
would fabricate reasoning/execution silently; (b) Core and Engine stay
vendor-neutral — no external provider brand appears as an identifier in the
frozen inner rings (adapters live in the composition/adapter layer; routing
targets are deployment data). An individual provider being unavailable (e.g. the
optional dsh adapter's current auth state) is never an architecture blocker: the
ports, the routing seam and every canonical owner stand independently.
**Canonical owner.** V1 Product Reachability closeout (Boss contract §0/§22);
the provider ports (`packages/core/src/ports/model-provider.ts`,
`packages/engine/src/executor/executor-provider.ts`) remain the only inner-ring
provider contracts.
**Forbidden.** `apps/desktop/src/**` importing `mock-provider`; a `dsh`/`deepseek`/
`openai`/`codex`/`zcode` identifier in `packages/core/src` or
`packages/engine/src` sources.
**Allowed.** Adapter implementations in the desktop layer
(`apps/desktop/src/executor/dsh-executor-provider.ts`,
`apps/desktop/src/models/openai-compatible-provider.ts`), and deployment routing
data (`COMPANYOS_EXECUTOR_PROVIDER`, `providerRoutes` composition values).
**Automated guard.** `check-architecture.mjs` ARCH-037 (mock-import scan over
production sources + vendor-identifier scan over the stripped inner rings).
**Source.** V1 Product Reachability closeout (BUG-BB-001/BUG-BB-002).

### ARCH-038 — Reasoning and execution are distinct capability classes
**Statement.** `ModelProviderPort` is the reasoning/generation capability;
`ExecutorProvider` is the external-execution capability. Neither implements,
imports or grows into the other: the planner/supervisor reasoning runtimes stay on
the model seam, and the executor dispatch stays on the provider seam. Provider
success is never canonical Task settlement (enforced by the frozen S24/S26 suites);
an external provider session is never CompanyOS Session truth (ADR-0030); a routing
decision is never business truth; adding a provider never adds a parallel
Workflow/Task/authority (§21 anti-bloat; enforced structurally — adapters live in
the outer ring only).
**Canonical owner.** V1 Execution Architecture Freeze (§26); the two ports
(`packages/core/src/ports/model-provider.ts`,
`packages/engine/src/executor/executor-provider.ts`).
**Forbidden.** supervisor/planner runtimes importing executor-provider machinery;
the executor-dispatch path importing model-registry machinery.
**Allowed.** The composition root registering adapters of both classes; reasoning
routines validating their own structured contracts (BB-WATCH-001 single-source
schemas).
**Automated guard.** `check-architecture.mjs` ARCH-038 (bidirectional import scan:
reasoning→executor machinery and dispatch→model-registry).
**Source.** V1 Execution Architecture Freeze (BB-WATCH-001 closeout).

### ARCH-039 — Natural-language task content is never an executable
**Statement.** Executable/argv authority belongs to TRUSTED DEPLOYMENT DATA (the
native operation profile at the composition boundary — the same authority class as
the dsh adapter's typed configuration). Free-form Task prose must never be
interpolated into argv, a path, a script, SQL or an HTTP request; typed
`Task.inputs` values are DATA arguments (one argv element each, never re-parsed).
Model output never becomes execution authority; provider execution result is never
canonical completion (the engine settles, as ever).
**Canonical owner.** V1 Native Execution Foundation (§4/§20); the native provider
(`apps/desktop/src/executor/native-process-provider.ts`) and the Sprint25
preflight/settlement pipeline.
**Forbidden.** `request.taskText`/`work.objective` used in executable code; a
shell-string execution path; renderer/model/provider invention of executables.
**Allowed.** Profile literal argv + declared typed input values; the composition
boundary registering operations.
**Automated guard.** `check-architecture.mjs` ARCH-039 (prose-use scan over the
native provider's stripped code; both-direction probes).
**Source.** V1 Native Execution Foundation (classification B closeout).

## Pinning

### ARCH-004 — WorkflowVersion is execution semantic authority
**Statement.** An existing Run's execution semantics come from the exact PINNED
version (`versions.find((entry) => entry.id === run.versionId)`), never from
`currentVersion` / `latestVersion` / the template's current pointer.
**Canonical owner.** ADR-0027 (pack provenance and run pinning).
**Forbidden.** Resolving a run's stages through `template.currentVersionId`.
**Allowed.** `currentVersion` in lifecycle AUTHORING paths (publish/draft/fork),
which are deliberately outside the scanned module set.
**Automated guard.** `check-architecture.mjs` ARCH-004 (identifier scan over
`engine/src/engine.ts`, `engine/src/supervisor/**`, `engine/src/projection/**`,
`apps/desktop/src/core-services.ts`).
**Source.** ADR-0027; T20-05; Sprint 22.

### ARCH-020 — Descendant invalidation uses the pinned DAG
**Statement.** Completed stale descendants derive from the RUN-PINNED
WorkflowVersion DAG — never the current template/pack graph, task creation order
or timestamps.
**Canonical owner.** Sprint21 final corrective (B1 stale-descendant ruling).
**Forbidden.** Scanning the live template's graph for descendants.
**Allowed.** Reading `run.versionId`'s pinned version inside the provisioner.
**Automated guard.** `check-architecture.mjs` ARCH-020 (the provisioner must read
a pinned version when it performs a descendant scan).
**Source.** Sprint 21 final; Sprint 22.

## No second truth

### ARCH-005 — No second dependency graph
**Statement.** The WorkflowVersion DAG is the only dependency authority. No
TaskEdge / RuntimeDependency / CorrectionGraph / ReassessmentGraph /
ExecutionGraph tables.
**Canonical owner.** T20-06 + ADR-0029.
**Forbidden.** `CREATE TABLE task_edges (...)`.
**Allowed.** The pinned version's `nodes`/`edges` (lifecycle migration).
**Automated guard.** `check-architecture.mjs` ARCH-005 (migration table-name
categories).
**Source.** ADR-0029; T20-06; Sprint 22.

### ARCH-006 — No second scheduler / no unlisted storage
**Statement.** There is no Scheduler/Queue/RuntimeTaskState/AgentQueue truth, and
every canonical table belongs to the frozen inventory (§Table inventory) — a new
table is an explicit amendment, not a silent second truth.
**Canonical owner.** ADR-0029 + this document.
**Forbidden.** `CREATE TABLE scheduler (...)` or any unlisted table.
**Allowed.** An amendment recorded in §Table inventory with its owning law.
**Automated guard.** `check-architecture.mjs` ARCH-006 (migration scan against
the frozen inventory + forbidden categories).
**Source.** Sprint 22.

### ARCH-008 — WorkPackage is derived-only
**Statement.** The Work Package is a read-only derived projection: no table, no
lifecycle, no status, no ownership, no persisted second Task truth.
**Canonical owner.** T20-06.
**Forbidden.** `CREATE TABLE work_packages`; `export function saveWorkPackage`.
**Allowed.** `createWorkPackageProjector` (the factory of the pure projection) and
its `project()` read.
**Automated guard.** `check-architecture.mjs` ARCH-008 (projector export scan +
table scan).
**Source.** T20-06; Sprint 22.

### ARCH-009 — Handoff single owner
**Statement.** The Sprint11 HandoffService chain is the only durable Handoff
owner; autonomous progression creates zero packets; WorkPackage ≠ HandoffPacket.
**Canonical owner.** Sprint 11 + T20-06.
**Forbidden.** A `handoff_*` table outside `migrations/handoff/`.
**Allowed.** The existing `handoffs` chain (Sprint 11).
**Automated guard.** `check-architecture.mjs` ARCH-009 (migration chain scan);
feature proof: autonomous E2Es record zero handoffs.
**Source.** Sprint 11/20/21; Sprint 22.

### ARCH-010 — Task belongs to Run
**Statement.** Task canonical ownership is `Task.runId → Run → Company`. No
`Task.companyId`, no standalone company inference, no heuristic ownership.
**Canonical owner.** T20-03A.
**Forbidden.** A `company_id` column on `tasks`; `task.companyId` on the domain
type.
**Allowed.** `database.tasks.listByRun(runId)` ownership reads.
**Automated guard.** `check-architecture.mjs` ARCH-010 (migration column scan +
domain type scan) over the T20-03A FK + migration trigger.
**Source.** T20-03A; Sprint 22.

### ARCH-026 — Ledger is not permanent business identity
**Statement.** The command ledger supports idempotency; it must not replace
permanent semantic identity. Identity paths must not fall back to a bounded
ledger lookup.
**Canonical owner.** T20-05 (final permanent identity corrective).
**Forbidden.** Deriving a Run's identity from the latest ledger row.
**Allowed.** Ledger reads for idempotency windows and receipt arbitration.
**Automated guard.** Feature proofs (T20-05 §36 identity matrix; ledger-trim
recovery in T18-08 fault recovery) — documented as feature-enforced.
**Source.** T20-05; T18-08; Sprint 22.

## Execution ownership

### ARCH-012 — ExecutionAttempt ≠ Task
**Statement.** ExecutionAttempt owns runtime attempt identity, active ownership,
interruption/recovery and settlement provenance. Task owns the work lifecycle.
The attempt must not become workflow state, DAG state, validation truth, finding
truth or business status.
**Canonical owner.** Sprint 21 final.
**Forbidden.** The attempt domain importing findings/validation/run-state
modules.
**Allowed.** The immutable seed (company/run/task/attemptNumber/roleId/taskKind)
and the frozen state machine.
**Automated guard.** `check-architecture.mjs` ARCH-012 (import scan over
`packages/core/src/lifecycle/execution-attempt.ts`).
**Source.** Sprint 21 final; Sprint 22.

### ARCH-013 — AgentExecution ≠ ExecutionAttempt
**Statement.** AgentExecution remains model/LLM provenance only. Generic executor
attempts must not require fake model fields, and the attempt must never be
replaced by AgentExecution.
**Canonical owner.** ADR-0030 + Sprint 21 final.
**Forbidden.** `modelKey` / `providerId` / `agentId` on the attempt seed.
**Allowed.** Agent rows carrying provider/model provenance for model rounds.
**Automated guard.** `check-architecture.mjs` ARCH-013 (model-field scan over the
attempt domain).
**Source.** Sprint 21 final; Sprint 22.

### ARCH-021 — Claim before executor
**Statement.** Generic execution maintains a durable ExecutionAttempt claim
BEFORE any external executor invocation; no executor call may happen while no
durable attempt owner exists.
**Canonical owner.** Sprint 21 final.
**Forbidden.** Invoking the handler before the claim transaction commits.
**Allowed.** claim → executor → settlement ordering.
**Automated guard.** `check-architecture.mjs` ARCH-021 (statement-order check in
`engine.ts`).
**Source.** Sprint 21 final; Sprint 22.

### ARCH-022 — No long SQLite write TX across executor
**Statement.** Executor/provider/CLI/HTTP/model invocation must never happen
inside a SQLite write transaction.
**Canonical owner.** ADR-0006.
**Forbidden.** `await handler.execute(...)` inside an `inTransaction` callback.
**Allowed.** The claim and settlement transactions with no external calls.
**Automated guard.** `check-architecture.mjs` ARCH-022 (transaction-callback
body scan).
**Source.** ADR-0006; Sprint 22.

### ARCH-023 — Same-attempt recovery is not a retry
**Statement.** Interrupted same-attempt recovery must not increment
`Task.attempts` again: crash recovery ≠ new retry.
**Canonical owner.** Sprint 21 final.
**Automated guard.** feature proof (`tests/sprint21/s21b-execution-attempts.test.ts`:
startup orphan conversion + same-attempt re-acquisition keeps attempts = 1) plus
the ARCH-021/022 ordering guards.
**Source.** Sprint 21 final.

### ARCH-024 — External exactly-once is not claimed
**Statement.** External side-effect exactly-once is NOT guaranteed and must not
be encoded or documented as such. Classification: NOT GUARANTEED —
a `REAL_PRODUCTION_PROVIDER_EXECUTOR` concern.
**Canonical owner.** Boss §26; T17 boundary docs.
**Automated guard.** documentation assertion in `tests/architecture/`
(the wording "exactly-once" may only appear with the NOT GUARANTEED
classification).
**Source.** Sprint 22.

### ARCH-025 — Carrier before readiness and before terminal completion
**Statement.** Durable carrier/finding/evidence reconciliation happens BEFORE
selecting next work, and a Run cannot become COMPLETED while applicable durable
carriers/findings remain unreconciled.
**Canonical owner.** Sprint 21 final.
**Automated guard.** feature proof (`tests/sprint21/s21d-final-invariants.test.ts`
A1/A2: a settled unit with an unrouted carrier never reports COMPLETED; the
restart reconciles exactly once).
**Source.** Sprint 21 final.

## Authority separation

### ARCH-007 — No latest-object authority
**Statement.** `latest` / `most recent` / `ORDER BY created_at DESC` may not act
as SEMANTIC authority where frozen identities or pinning exist.
**Canonical owner.** T20-06 subject authority + Sprint 21 D1.
**Forbidden.** `ORDER BY created_at DESC` picking the run's data.
**Allowed.** Documented tie-breaks: `byDeterministicRecency`,
earliest-(createdAt,id) in canonical-subject selection.
**Automated guard.** `check-architecture.mjs` ARCH-007 (SQL DESC + comparator
scan with a tie-break allow-list).
**Source.** T20-06; Sprint 22.

### ARCH-011 — Task identity is deterministic immutable-seed
**Statement.** Normal Task identity is deterministic and immutable-seed based:
no timestamp identity, no createdAt identity, no mutable lifecycle fields in the
creation seed, no registry order in identity.
**Canonical owner.** T20-03A/B.
**Forbidden.** Seeding a task id from `Date.now()`.
**Allowed.** The deterministic seed + `putGuarded` REPLAY/CONFLICT arbitration.
**Automated guard.** feature proof (T20-03A §15-§22 identity matrix) — documented
as feature-enforced.
**Source.** T20-03A/B; Sprint 22.

### ARCH-014 — Executor registry is implementation authority only
**Statement.** The registry answers WHICH trusted implementation executes a
pinned taskKind — never what the Task means, which stage comes next, which
validator is required or which business outcome is correct.
**Canonical owner.** Sprint 21.
**Forbidden.** Deriving readiness from registration order.
**Allowed.** `stageHandlers.executorKinds` registration data.
**Automated guard.** feature proof (registration-order invariance in
`s21-generic-orchestration`) + ARCH-004/005/006 guards.
**Source.** Sprint 21; Sprint 22.

### ARCH-015 — ValidatorIds drive system validation
**Statement.** Validation authority = pinned node `validatorIds` + the trusted
validator registry — never a QA role, validation stage class, task name or
string heuristic.
**Canonical owner.** ADR-0020 + Sprint 21 gate semantics.
**Automated guard.** feature proof (validatorIds-driven gate orchestration with
no QA role in `s21-generic-orchestration`).
**Source.** ADR-0020; Sprint 21.

### ARCH-016 — Findings drive correction
**Statement.** Generic correction is based on canonical findings / decisions /
evidence — never on a review role, review class, QA class or literal taskKind
string as corrective eligibility authority.
**Canonical owner.** ADR-0029 + Sprint 21 D1.
**Automated guard.** feature proof (generic corrective E2E with zero role
vocabulary) + ARCH-017 scoping guard.
**Source.** ADR-0029; Sprint 21.

### ARCH-017 — D1 scope separation
**Statement.** Proposal/cause validation projection = SUBJECT-SCOPED
(an anchor report populates only when its subject matches the turn's subject).
Run-level blocking = ALL_UNRESOLVED_ANCHORS (any unresolved finding blocks; a
newer clean report cannot mask an older unresolved one). A foreign-subject
report must never populate the subject-local projection.
**Canonical owner.** Sprint 21 final (D1 终裁).
**Forbidden.** Populating the review projection before the subject-match gate.
**Allowed.** The anchor report inside the subject-matched branch; the
all-anchors blocking scan.
**Automated guard.** `check-architecture.mjs` ARCH-017 (gate/order check in
`supervisor-runtime.ts`) + feature proofs.
**Source.** Sprint 21 final; Sprint 22.

### ARCH-018 — Stage output authority
**Statement.** The canonical stage result is owned by the existing stage-subject
authority and `Task.outputs['stageOutput']` — never latest-timestamp-wins,
latest-Task-wins, array-last-wins or registry-order-wins.
**Canonical owner.** T20-06 + Sprint 21.
**Automated guard.** `check-architecture.mjs` ARCH-007 pattern scan (the
recency-authority ban) + feature proofs (same-round earliest-(createdAt,id)
tie-break, corrective child wins).
**Source.** T20-06; Sprint 21.

### ARCH-019 — Corrective/reassessment authority
**Statement.** Corrective/reassessment lineage continues through the canonical
provisioner. No manual review2 seeding, no parallel winner hierarchy, no ad-hoc
reassessment queue, no timestamp reassessment authority.
**Canonical owner.** Sprint 21 final.
**Forbidden.** A second production writer of the reassessment marker.
**Allowed.** The provisioner (producer-stage + pinned-DAG strict descendants).
**Automated guard.** `check-architecture.mjs` ARCH-019 (marker-writer scan over
production sources).
**Source.** Sprint 21 final; Sprint 22.

## Context / ownership boundaries

### ARCH-027 — UI is not truth
**Statement.** Renderer/Desktop UI must not own Run state, Task state, Validation
state, finding state or workflow progression; the renderer → application/service
boundary is preserved.
**Canonical owner.** ADR-0008.
**Forbidden.** `apps/renderer/src/**` importing `@companyos/persistence` /
`@companyos/engine` / Electron / `node:fs`.
**Allowed.** `@companyos/contracts` + the preload/IPC contract.
**Automated guard.** `check-architecture.mjs` ARCH-027 (renderer import scan).
**Source.** ADR-0008; Sprint 22.

### ARCH-028 — Session is context, not workflow truth
**Statement.** Sessions hold bounded execution context. They must not decide
Task DONE, Run state, workflow progression, validation or finding resolution.
**Canonical owner.** ADR-0030.
**Forbidden.** `dispatchInternal` / `applyTaskEvent` inside the session runtime.
**Allowed.** Returning the round outcome for the trusted applicator.
**Automated guard.** `check-architecture.mjs` ARCH-028 (lifecycle-call scan over
`packages/engine/src/session/**`).
**Source.** ADR-0030; Sprint 22.

### ARCH-029 — Artifact / Evidence / Validation ownership
**Statement.** Artifact = durable artifact truth, Evidence = evidence truth,
Validation = validation truth. They are not collapsed into Task outputs or
prompt text.
**Canonical owner.** ADR-0015/0017/0020 + T18-04 sinks.
**Automated guard.** feature proofs (one canonical writer per sink; T19-04
isolation) — documented as feature-enforced.
**Source.** Sprint 13/17/19; Sprint 22.

### ARCH-030 — Memory is not authority
**Statement.** No learned/long-term memory integration yet. Future memory must
not mutate Goal, Plan, WorkflowVersion, Run, Task, Decision, Artifact, Evidence,
Validation or Handoff without canonical command paths.
**Canonical owner.** Boss §34/§51.
**Automated guard.** the ARCH-003 import scan covers the direction (a memory
store reaching the command paths fails); the semantic boundary is documented
here until a memory integration exists.
**Source.** Sprint 22.

### ARCH-032 — Registry order has no semantic authority
**Statement.** Executor registration order never answers readiness, stage order,
validator requirements or business outcome.
**Canonical owner.** Sprint 21.
**Automated guard.** feature proof (registration-order invariance) —
documented as feature-enforced.
**Source.** Sprint 21.

---

## Table inventory (ARCH-006)

Frozen at `779491b` (the guard fails any table outside this list):

Sprint24 amendment: `provider_dispatches` (the durable provider dispatch binding — SUBORDINATE to ExecutionAttempt; records providerKey/dispatchKey/externalRunId/state; never decides attempt numbers, Task success, retry counts or lifecycle). Frozen at the Sprint24 baseline.
`schema_migrations, entities, settings, events, handoff_refs,
workflow_template_versions, workflow_template_locks, workflow_templates,
workflow_change_requests, benchmark_results, agent_executions,
agent_execution_artifacts, runs, tasks, tasks_t2003a, tool_invocations_rebuilt,
approvals, command_ledger, decisions, artifacts, validations, model_records,
logical_aliases, execution_attempts, roles, role_assignments, providers,
provider_models, secret_refs, pack_versions, pack_installations,
pack_content_refs, handoffs, memories, router_decisions,
model_selection_policies, sessions, session_entries, tool_records,
tool_invocations, tool_invocation_artifacts, run_snapshots`.

## Exceptions (§47 — no silent grandfathering)

| Where | What | Reason |
|---|---|---|
| `packages/engine/src/supervisor/bounded-agent-context.ts` | imports `REQUIRED_QA_EVIDENCE_SLOTS` from the ADR-0028 repository seam | The evidence SLOT vocabulary (tests/lint/typecheck/build/gitStatus/gitDiff) is execution-shape data projected into the bounded context; the owning module stays in the Sprint-17 seam. Removing the edge would move the projection into the software pack — a semantic change outside Sprint 22's non-production mandate (§40). Recorded here and reported by the guard's exemption note on every run. |

## Enforcement summary

| Class | Laws |
|---|---|
| Automated by `check-boundaries.mjs` | ARCH-001, ARCH-002 (imports inner-ring) |
| Automated by `check-architecture.mjs` | ARCH-003, 004, 005, 006, 007, 008, 009, 010, 012, 013, 017, 019, 020, 021, 022, 027, 028, 031 |
| Feature-enforced (architectural tests prove the invariant) | ARCH-011, 014, 015, 016, 018, 023, 025, 029, 032 |
| Documentation boundary (no integration exists yet) | ARCH-024 (wording guard in the architecture suite), 026 (identity matrix), 030 (import direction) |

### ARCH-040 — The Smart Router is a pure deterministic decision function
**Statement.** Model routing (Stage 8 §B) is deterministic, explainable and
non-adaptive: hard filter first, then integer weighted scoring over ORDINAL
static traits, then a declared tie-breaker. Router Uses LLM = NO (no
model-calls-model, no network call, no provider/executor import); Model
Tournament = NO (no voting, no fan-out, exactly one profile per attempt);
Adaptive Learning = NO (OBSERVE YES / LEARN NO / ADAPT NO — no historical
success rate, usage telemetry or outcome feedback is read); Hidden Fallback =
NO (an empty eligible set fails loud, never "any enabled profile").
**Canonical owner.** Stage 8 Smart Model Routing V1
(`apps/desktop/src/executor/smart-model-router.ts`) over the Stage 6 ModelPool
contract; model lock ownership is ARCH-042.
**Forbidden.** Provider/executor/registry imports or `fetch()` in the router;
`tournament` / `vote` / `fallback` / `adaptive` identifiers; adaptive or
historical inputs; silent fallback selection.
**Allowed.** ModelPool-contract-only imports, ordinal ladders
(`QUALITY_LADDER`/`COST_LADDER`/`LATENCY_LADDER`/`RELIABILITY_LADDER`),
`ModelRoutingPolicyV1` static weights, `ROUTING_POLICIES` fixtures, the
operator/task-level pin (audit-visible, fail-closed).
**Automated guard.** `check-architecture.mjs` ARCH-040 (import-specifier scan +
stripped-source identifier scan; both-direction probes).
**Source.** Stage 8 task §B (AUTHORIZED).

### ARCH-041 — Role collaboration has no second truth and no peer chat
**Statement.** Roles collaborate through DURABLE OBJECTS (Task, Artifact,
Evidence, Decision, ExecutionAttempt) via the Professional Handoff Contract —
never peer chat. There is no `role_messages` / `agent_chat_truth` /
`team_task_store` / `agent_team_scheduler` / `peer_workflow_state` as a table
or as an identifier; every collaboration view is DERIVED (the projection owns
no state); the PM coordinates handoffs but is NOT a scheduler and owns no
scheduling truth; a handoff carries refs and professional summaries — never
raw chain-of-thought, a full private transcript, or hidden reasoning.
**Canonical owner.** Stage 8 Role Collaboration V1
(`apps/desktop/src/executor/role-collaboration.ts`); durable persistence stays
in the frozen `handoffs` / `handoff_refs` tables (no new table).
**Forbidden.** Any second-truth table (ARCH-005/006 extension) or identifier;
`scheduler`/`agent_queue`-class tables; scheduling/assignment mutators in the
collaboration module; raw-context fields on a handoff or a reviewer envelope.
**Allowed.** `buildProfessionalHandoff` / `acceptHandoff` /
`assertReviewerIndependence` / `projectRoleCollaboration`; the closed failure
set HANDOFF_INPUT_MISSING, HANDOFF_ARTIFACT_INVALID,
HANDOFF_AUTHORITY_MISMATCH, HANDOFF_CONTEXT_BUILD_FAILED,
REVIEW_INDEPENDENCE_VIOLATION, COLLABORATION_DEPENDENCY_BLOCKED.
**Automated guard.** `check-architecture.mjs` ARCH-041 (identifier scan over
the collaboration module + forbidden-table categories; both-direction probes).
**Source.** Stage 8 task §A (AUTHORIZED).

### ARCH-042 — The RoleInstance never owns a selected model
**Statement.** The ExecutionAttempt is the sole owner of the
`SelectedModelSnapshot` (per-attempt model lock). A `RoleInstance` may carry
`modelSelectionRequirements` (and a pack routing hint) — never `modelLock`,
`selectedModel` or `modelProfileId`. Routing (Stage 6 selection, Stage 8 smart
routing) RETURNS a decision + snapshot for one attempt; it never writes model
truth onto the role object. The same RoleInstance may therefore route to Model
A for attempt 1 and Model B for attempt 2.
**Canonical owner.** Stage 7B correction + Stage 8 §B
(`selectModelForAttempt` / `routeModelForAttempt`; `RoleInstance` in
`apps/desktop/src/executor/role-orchestration.ts`).
**Forbidden.** `modelLock`/`selectedModel`/`modelProfileId` fields on the
RoleInstance interface; any assignment of model truth onto a role object.
**Allowed.** `RoleInstance.modelSelectionRequirements`;
`RoleDefinition.routingPreference` (hint-only: policy fixture + minimum
tiers — never a pin, never authority).
**Automated guard.** `check-architecture.mjs` ARCH-042 (RoleInstance
interface-body scan + write-back scan; both-direction probes).
**Source.** Stage 7B correction, re-asserted by Stage 8 task §B.

### ARCH-043 — The kernel never routes; collaboration never mutates tasks
**Statement.** The embedded kernel/provider CONSUMES the CompanyOS-selected model
route carried on the executor request and never re-scores, re-fallbacks or
re-routes: selection authority lives at the application seam (the Stage 8B
dispatch routing phase), and the provider is configured fail-closed
(`requireRequestedModel` ⇒ COMPANYOS_SELECTED_MODEL_REQUIRED) when the
deployment runs SMART_ROUTER_V1. Symmetrically, the role-collaboration runtime
bridge only builds durable handoffs and derived views: it holds no task-state
mutator — Task readiness, claiming and settlement stay with the CompanyOS engine
(the PM coordinates; it does not schedule).
**Canonical owner.** Stage 8B runtime integration:
`apps/desktop/src/executor/provider-dispatch.ts` (routing phase), the embedded
provider (`apps/desktop/src/executor/dsh-executor-provider.ts`), and the
collaboration bridge (`runtime-collaboration.ts` / `runtime-routing.ts`).
**Forbidden.** The kernel/provider importing the Smart Router; a task-state
mutator (`settleTask`/`claimTask`/`transitionTask`/…) in the collaboration or
runtime bridge; a provider choosing its own model in SMART_ROUTER_V1 mode.
**Allowed.** `request.selectedModelRoute` consumed verbatim; the routing phase
attaching the decision before the kernel is invoked; handoffs recorded through
the existing Sprint-11 HandoffService (createDraft → ready).
**Automated guard.** `check-architecture.mjs` ARCH-043 (import-specifier scan over
the kernel adapter + identifier scan over the bridge modules; both-direction
probes).
**Source.** Stage 8B task §10/§18 (AUTHORIZED).

### ARCH-044 — The normal goal pipeline never flattens work onto a generic seat
**Statement.** Every plan item's professional responsibility — declared by the
plan when present (an optional model REQUEST), else derived deterministically
from the item's own semantics — resolves through the Stage 7 RoleResolver
(catalog match on declared capabilities, else DETERMINISTIC_DYNAMIC_ROLE_SPEC)
into the seat pinned into its task profile. The user never chooses roles; there
is no unconditional generic worker seat; the team is exactly as large as the
plan's responsibilities (minimal sufficient team).
**Canonical owner.** Stage 8C: `apps/desktop/src/control-plane.ts` (the trusted
per-item derivation), `runtime-routing.ts` (`resolveProfessionalSeat`), the
pinned `taskProfile.roleId` (durable with the WorkflowVersion).
**Forbidden.** The control plane pinning `'rol.worker'` (or any single generic
seat) for the normal path; LLM role synthesis; fixed role-team templates.
**Allowed.** Catalog seats from the canonical roles table / Packs; deterministic
dynamic seats (`drole_<hash16>`); explicitly pinned legacy/diagnostic seats
outside the control plane.
**Automated guard.** `check-architecture.mjs` ARCH-044 (stripped-source literal
scan over the control plane; both-direction probes).
**Source.** Stage 8C task §1-§6/§24 (AUTHORIZED).
