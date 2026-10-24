> Source of truth: .planning/CANONICAL_SPEC.md (RECONSTRUCTED — diff against 规划书 before Sprint 1)

# CompanyOS V1.1 — System Architecture

| Field | Value |
|---|---|
| Document | ARCHITECTURE.md — full system architecture |
| Baseline | CompanyOS V1.1 (Phase 0 / Sprint 0 delivered; Phase 1 = P1 Core) |
| Companions | `docs/ARCHITECTURE_REVIEW.md` (gate), `docs/CORE_BOUNDARIES.md` (constitution), `docs/WORKFLOW_LIFECYCLE.md`, `docs/STATE_MACHINE.md`, `docs/HANDOFF_PROTOCOL.md`, `docs/MEMORY_ARCHITECTURE.md`, `docs/SECURITY_MODEL.md` |
| Architectural style | Hexagonal (ports & adapters) + modular monolith bounded contexts + Industry-Pack extension model |

---

## 1. Architectural principles

| # | Principle | Enforcement |
|---|---|---|
| P1 | **Core is universal.** `@companyos/core` never names or imports Coding · Git · Repository · Developer · CTO · Article · Video · Ecommerce (CANONICAL_SPEC §1) | `scripts/check-boundaries.mjs` + ESLint `no-restricted-imports` + package.json dep check, all inside `pnpm check` |
| P2 | **Vertical knowledge is plug-in, not built-in.** Industry Packs own vertical nouns and depend on Core, never the reverse | ADR-0002; `packs/*` may import core/contracts; core may import neither |
| P3 | **Ports are defined inward, implemented outward.** `Clock`, `IdFactory`, `Logger`, `EventBus`, `EntityStore<T>`, `MigrationRunner`, `SecretResolver`, `ModelGateway` (interface only), `AgentRuntime` (interface only) | ADR-0005; lint rule bans `node:*`, `electron`, `node:sqlite` inside core |
| P4 | **Published is immutable.** Versions and run snapshots are append-only; runs read snapshots, never live template state | ADR-0006, ADR-0007; `WorkflowVersionState` oracle in `docs/STATE_MACHINE.md` |
| P5 | **Local-first by construction.** Every P0–P2 capability performs zero network calls; the DB is a local file | ADR-0012; no network dependency in `pnpm check` |
| P6 | **Untrusted renderer.** Electron renderer holds no disk, no `node:`, no dynamic IPC | ADR-0010; `docs/SECURITY_MODEL.md` |
| P7 | **Explicit failure.** Illegal transitions, stale locks, and mismatched hashes throw typed errors with stable codes; no silent degradation | Error code registry in `docs/STATE_MACHINE.md` §9 |
| P8 | **Versioned everything.** Workflows, packs, envelope contracts, migrations, and events all carry versions or hashes | `contentHash`, `PackManifest.packVersion`, `contractVersion`, `NNNN_name.sql` |
| P9 | **Auditable by default.** Every state change emits a domain event persisted to an append-only log | `EventBus` + `events` table + tamper-evident audit chain |
| P10 | **Boring technology.** `node:sqlite`, ESM, strict TS, Vitest. No native build step, no agent framework in Core | ADR-0003, ADR-0011 |

---

## 2. The hexagon

```text
                                  ┌──────────────────────────────────────────┐
                                  │             ADAPTERS / APPS              │
   ┌──────────────────────────────┴───────────────────────────────────────┐  │
   │                        INDUSTRY PACKS (vertical)                     │  │
   │   pack-devcompany  pack-article  pack-video  pack-ecommerce          │  │
   │   (Coding · Git · Repository · Developer · CTO · Article · Video ·   │  │
   │    Ecommerce vocabulary lives ONLY here — ADR-0002)                  │  │
   └──────────────────────────────┬───────────────────────────────────────┘  │
                                  │                                          │
   ┌──────────────────────────────▼───────────────────────────────────────┐  │
   │                              PORTS (ring)                            │  │
   │  Clock · IdFactory · Logger · EventBus · EntityStore<T> ·            │  │
   │  MigrationRunner · SecretResolver · ModelGateway* · AgentRuntime*    │  │
   │  MemoryReader · MemoryWriter · EmbeddingProvider                     │  │
   │            (* interface only in Sprint 0 — CANONICAL_SPEC §4)        │  │
   └──────────────────────────────┬───────────────────────────────────────┘  │
                                  │  ▲                                       │
                    calls out ────┘  └──── implemented by outer layers        │
                                  │                                          │
   ┌──────────────────────────────▼───────────────────────────────────────┐  │
   │                          CORE DOMAIN (middle)                        │  │
   │   Kernel ─ Org ─ Workflow ─ Execution ─ Memory ─ Governance ─        │  │
   │   Capability Registry                                                │  │
   │   pure TypeScript · no node:* · no electron · no pack imports        │  │
   └──────────────────────────────────────────────────────────────────────┘  │
                                                                             │
   ┌─────────────────────────────────────────────────────────────────────┐   │
   │  APPS: apps/desktop (Electron main + preload) · apps/renderer (React)│◄──┘
   └─────────────────────────────────────────────────────────────────────┘
```

Reading rule: **dependency arrows point inward only.** The hexagon's middle never learns the name of anything outside it.

---

## 3. Layered dependency rule

```text
LAYER ORDER (imports allowed only left-to-right; contracts is shared by all)

  apps ──────────► packs ──────────► adapters ──────────► core
    │                 │                   │                 │
    │                 │                   │                 │
    └─────────────────┴───────────────────┴─────────────────┘
                              ▲
                              │
                        contracts  (shared, depends on nothing internal)

HARD RULES
  R1  core        MUST NOT import apps | packs | adapters | electron | node:sqlite | react | vite
  R2  adapters    MUST NOT import apps | packs
  R3  packs       MUST NOT import apps | core internals (deep paths); ports via contracts only
  R4  apps        MAY import everything below (composition root)
  R5  contracts   MUST NOT import anything internal; only zod + pure types
  R6  no cycles, ever. check-boundaries.mjs fails the build on any reverse edge.
  R7  core's only workspace dependency is @companyos/contracts (ADR-0001/ADR-0011).

FORBIDDEN NOUNS (CANONICAL_SPEC §1) — checked lexically across packages/core/src/**:
  Coding · Git · Repository · Developer · CTO · Article · Video · Ecommerce
```

### 3.1 Import-edge matrix (rows may import columns)

| ↓ imports → | contracts | core | adapters | packs | apps |
|---|---|---|---|---|---|
| **contracts** | — | ✗ | ✗ | ✗ | ✗ |
| **core** | ✓ | — | ✗ | ✗ | ✗ |
| **adapters** | ✓ | ✓ (ports only) | ✗ (no adapter→adapter) | ✗ | ✗ |
| **packs** | ✓ | ✓ (ports via contracts) | ✓ | ✗ (no pack→pack) | ✗ |
| **apps** | ✓ | ✓ | ✓ | ✓ | ✗ |

`packs` legitimately sits between `apps` and `adapters` in the requested layering (`apps → packs → adapters → core`). In practice a pack is a **contract consumer**: it registers capabilities and templates through `pack-sdk` and never reaches into Core internals — it uses port *types*, not port implementations. Pack→pack imports are banned to keep the P3 verticals independently loadable.

---

## 4. Workspace package map

Repo root: `E:\DeepSeek.gzq\companyos`. Workspace manager: **pnpm workspaces** (CANONICAL_SPEC §7).

> **Status note.** This is the **target** package map. The delivered Sprint-0 workspace currently ships `@companyos/core`, `@companyos/contracts`, `@companyos/observability`, `@companyos/persistence`, `@companyos/desktop`, `@companyos/renderer` — i.e. `platform` is spelled `observability`, and the composition root / UI split is `desktop` / `renderer`. The IPC registry and pack SDK are not yet separate packages. Reconciliation actions are tracked as FR-17 in `docs/ARCHITECTURE_REVIEW.md` §7 and `docs/CORE_BOUNDARIES.md` §10 R6; the layer rule (§3) and the dependency matrix (§3.1) hold for either naming.

| Package | Path | Layer | Responsibility | May depend on |
|---|---|---|---|---|
| `@companyos/contracts` | `packages/contracts` | shared | Pure types + zod schemas: port interfaces, event envelope, DTOs, `canonicalize()` hashing helper, error code enum | zod only |
| `@companyos/core` | `packages/core` | core | Seven bounded contexts (Kernel, Org, Workflow, Execution, Memory, Governance, Capability Registry), lifecycle machine, ports declared | `@companyos/contracts` **only** |
| `@companyos/persistence` | `packages/adapters/persistence` | adapter | `EntityStore<T>` implementation over `node:sqlite`, `MigrationRunner`, `NNNN_name.sql` migrations + checksum verification, projections | contacts, core (ports) |
| `@companyos/platform` | `packages/adapters/platform` | adapter | Host services: `Clock`, `IdFactory` (ulid), `Logger` sinks (console + rotating file), `SecretResolver` (OS keychain / Electron `safeStorage`), fs paths, redaction allow-list | contracts, core (ports) |
| `@companyos/ipc` | `packages/ipc` | shared | Typed IPC channel registry, zod request/response schemas, error envelope mapping; imported by main, preload, and renderer | contracts |
| `@companyos/pack-sdk` | `packages/pack-sdk` | shared | `PackManifest` schema, capability descriptor helpers, pack load/validate, capability declaration surface | contracts |
| `@companyos/pack-devcompany` | `packs/devcompany` | pack | **The only home of** Coding · Git · Repository · Developer · CTO vocabulary; software-company role titles, node kinds, tool adapters (P3) | contracts, core, pack-sdk |
| `@companyos/pack-article` | `packs/article` | pack | Article vertical: editorial templates, Article vocabulary (P3) | contracts, core, pack-sdk |
| `@companyos/pack-video` | `packs/video` | pack | Video vertical: production templates, Video vocabulary (P3) | contracts, core, pack-sdk |
| `@companyos/pack-ecommerce` | `packs/ecommerce` | pack | Ecommerce vertical: catalog/order templates, Ecommerce vocabulary (P3) | contracts, core, pack-sdk |
| `@companyos/app-desktop` | `apps/desktop` | app | Electron main process + preload bridge; **composition root**; owns window creation, CSP, IPC handlers, DB file location, worker pool | everything below |
| `@companyos/app-renderer` | `apps/renderer` | app | React 19 + Vite UI; talks to main through `window.companyos` bridge only; holds no disk access | `@companyos/ipc`, `@companyos/contracts` |
| *(Sprint 0 forbidden)* `@companyos/model-gateway` | `packages/adapters/model-gateway` | adapter | **P2 only.** Implements `ModelGateway`. Must not exist in Sprint 0 (CANONICAL_SPEC §6) | — |
| *(Sprint 0 forbidden)* `@companyos/agent-runtime` | `packages/adapters/agent-runtime` | adapter | **P2 only.** Implements `AgentRuntime`. Must not exist in Sprint 0 | — |

---

## 5. Bounded contexts

All seven contexts live inside `@companyos/core`. Contexts communicate by **domain events** and by exchanging *ids*, never by mutating another context's aggregates (see §5.8).

### 5.1 Kernel

| Aspect | Detail |
|---|---|
| Responsibility | Identity, time, results, errors, event envelope. The only context every other context may import freely. |
| Aggregates | none (value-only) |
| Key types | `Id<T>` branded ulid, `Clock`, `Result<T, E>`, `DomainError`, `ErrorCode`, `EventEnvelope {eventId, type, occurredAt, traceId, runId?, orgId, payload, version}` |
| Ports declared | `Clock`, `IdFactory`, `Logger`, `EventBus` |
| Invariants | id monotonicity within a table; `Clock` is injected, never `Date.now()` in domain code; every error carries a stable `ErrorCode` |

### 5.2 Org

| Aspect | Detail |
|---|---|
| Responsibility | Org units, role archetypes, staffing, authority/RACI. **Contains no industry nouns.** |
| Aggregates | `OrgUnit`, `WorkRole` (a `RoleArchetype` binding), `StaffingAssignment`, `AuthorityGrant` |
| Key types | `RoleArchetype` (pack-declared string), `WorkRole {id, orgId, archetype, name, authority}` |
| Ports declared | `EntityStore<OrgUnit>` etc. (generic persistence port, ADR-0001) |
| Invariants | a `WorkRole` name is org-local data, never a Core constant; authority is additive and evaluated deny-by-default; deleting an org unit with live assignments is refused |

### 5.3 Workflow

| Aspect | Detail |
|---|---|
| Responsibility | Template, versioning, lifecycle, locks, forks, change proposals, metrics. Owns the lifecycle machine. |
| Aggregates | `WorkflowTemplate`, `WorkflowVersion`, `TemplateLock`, `ChangeProposal`, `WorkflowMetrics`, `ForkLineage` |
| Key types | see `docs/WORKFLOW_LIFECYCLE.md` §2 for the entity glossary |
| Ports declared | `EntityStore<WorkflowTemplate>`, `EntityStore<WorkflowVersion>`, `EventBus`, `Clock`, `IdFactory`, `MemoryReader` (for template hydration) |
| Invariants | published versions append-only (ADR-0006); `draft` cannot start production runs; `archived` is absorbing; only `accepted` proposals mint drafts (ADR-0009); metrics are read-only projections |
| Machine | `WorkflowTemplateLifecycle`, `WorkflowVersionState`, `ChangeProposalState`, `TemplateLockState` (`packages/core/src/lifecycle/lifecycle-machine.ts`) |

### 5.4 Execution

| Aspect | Detail |
|---|---|
| Responsibility | Run, run snapshot, node execution, handoff, checkpoint/resume. |
| Aggregates | `Run`, `RunSnapshot`, `NodeExecution`, `Handoff`, `Checkpoint` |
| Key types | `RunSnapshot {id, workflowVersionId, templateLockId, packVersions, modelBindings, memoryViewRef, createdAt}` |
| Ports declared | `EntityStore<Run>`, `EventBus`, `Clock`, `AgentRuntime` (interface only in Sprint 0), `ModelGateway` (interface only in Sprint 0) |
| Invariants | a run reads its snapshot and nothing else (ADR-0007); run states are `queued/running/paused/waiting_handoff/succeeded/failed/cancelled/timed_out`; terminal states are absorbing; resume is idempotent from the last checkpoint |
| Machine | `RunState`, `NodeExecutionState`, `HandoffState` |

### 5.5 Memory

| Aspect | Detail |
|---|---|
| Responsibility | Memory scopes (working / episodic / semantic / artifact), retrieval ports, provenance, sensitivity. |
| Aggregates | `MemoryRecord`, `MemoryPromotion` |
| Key types | `MemoryRecord {id, scope, orgId, runId?, contentRef, summary, embeddingRef?, provenance[], confidence, sensitivity, createdAt, ttl?}` |
| Ports declared | `MemoryReader`, `MemoryWriter`, `EmbeddingProvider` (interface only — **no model calls in Phase 0/1**) |
| Invariants | every semantic record carries ≥ 1 provenance entry; sensitivity is deny-by-default at retrieval; working memory is TTL-bound and never the sole source of a semantic claim |
| Detail | `docs/MEMORY_ARCHITECTURE.md` |

### 5.6 Governance

| Aspect | Detail |
|---|---|
| Responsibility | Policy evaluation, budget, approvals (human-in-the-loop gates), audit. |
| Aggregates | `Policy`, `Budget`, `Approval`, `AuditEntry` |
| Key types | `PolicyDecision {allowed, reasons[], policyIds[]}` |
| Ports declared | `EntityStore<Policy>`, `EventBus`, `Clock`, `SecretResolver` (indirectly, via adapters) |
| Invariants | audit log is append-only and hash-chained (tamper-evident); policy evaluation is deny-by-default; budget refusal is a `Result` error, never an exception past the app boundary; approvals are single-use per envelope idempotency key |
| Machine | `ChangeProposalState`'s decider authority is resolved here; approval gate state lives with `HandoffState` |

### 5.7 Capability Registry

| Aspect | Detail |
|---|---|
| Responsibility | Packs register capabilities; **Core resolves by contract only**. |
| Aggregates | `CapabilityDescriptor`, `CapabilityBinding`, `PackManifest` (validated by `pack-sdk`) |
| Key types | `CapabilityDescriptor {id, contractId, version, inputSchema, outputSchema, sensitivity, requiredCapabilities[]}` |
| Ports declared | `EntityStore<CapabilityDescriptor>`, `EventBus` |
| Invariants | Core never branches on a capability *name* from a specific pack; resolution is by `contractId` + semver range; an unregistered capability is unavailable, not approximated; pack capability declarations are least-privilege and review-gated |

### 5.8 Cross-context rules

1. **No shared tables across contexts** (§8 gives table ownership). Cross-context reads go through a port or a projection.
2. **Commands stay inside the owning context.** Anyone may *ask*; only the owner transitions.
3. **Events are the coupling.** `WorkflowPublished`, `RunStarted`, `NodeFailed`, `HandoffAcked`, `ProposalAccepted`, `LockReleased`, `MetricsRolledUp`.
4. **Ids cross boundaries, aggregates do not.** A context may hold another context's id and hydrate it through a reader port.
5. **Projections may be rebuilt.** `WorkflowMetrics` and any read model is derivable from the event log; rebuild must be idempotent.

---

## 6. Runtime topology

```text
┌───────────────────────────── Electron application ──────────────────────────────┐
│                                                                                 │
│  ┌───────────────────────┐        ┌──────────────────────────────────────────┐  │
│  │  RENDERER (untrusted) │        │  PRELOAD (bridge, contextIsolated)       │  │
│  │  React 19 + Vite      │◄──────►│  window.companyos = { invoke(channel,..)}│  │
│  │  sandbox: true        │  IPC   │  statically named channels only          │  │
│  │  nodeIntegration:false│        │  zod schema validation on both sides     │  │
│  │  NO fs, NO node:,     │        └────────────────┬─────────────────────────┘  │
│  │  NO SQLite handle     │                         │                          │
│  └───────────────────────┘                         │ typed IPC (allow-list)   │
│                                                     ▼                          │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │  MAIN PROCESS (composition root, trusted)                                │  │
│  │  · window lifecycle, CSP, will-navigate / setWindowOpenHandler guards    │  │
│  │  · constructs adapters: persistence(node:sqlite) · platform · secret     │  │
│  │  · owns the DB file path  →  %APPDATA%\CompanyOS\companyos.db            │  │
│  │  · IPC handlers: validate → dispatch to Core commands → map Result/Error │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐  │  │
│  │  │  WORKER (node:worker_threads pool, P2)                             │  │  │
│  │  │  · step execution, model calls, long CPU work                      │  │  │
│  │  │  · NO own DB handle: requests writes through a port to main        │  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   ▼
                    ┌──────────────────────────────────┐
                    │  SQLite file: companyos.db       │
                    │  accessed ONLY from main process │
                    │  (workers and renderer never)    │
                    └──────────────────────────────────┘
```

| Concern | Decision | Rationale |
|---|---|---|
| Where SQLite lives | Main process only, behind `@companyos/persistence` | Single writer, no lock contention, no ABI/native issues (ADR-0003), one place to encrypt later |
| Why renderer never touches disk | Renderer is the untrusted UI in the threat model; `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` | Model-influenced content and future plugin UI run here; a disk handle in the renderer collapses the boundary (ADR-0010) |
| IPC boundary | Preload exposes `invoke(channel, payload)` over a **static** registry; zod validates request and response | No dynamic channel names ⇒ capability creation is a code change, reviewable in diff; schemas prevent prototype-pollution and type confusion |
| Worker role | Executes steps; holds no DB handle | Keeps the UI thread responsive while preserving single-writer DB access |
| Clock/Id/Secrets | Injected from `@companyos/platform` at composition root | Deterministic tests (fake clock), single secret source (`SecretResolver` → OS keychain / `safeStorage`) |
| Shutdown | Flush event log + migrate-check on start; WAL checkpoint on quit | Crash recovery invariants in §9 |

---

## 7. Data flow — a single run (numbered sequence)

Reference actors: `R` = renderer, `M` = Electron main, `C` = Core (in-process), `P` = `@companyos/persistence`, `G` = Governance, `W` = worker pool, `Mem` = Memory.

1. **Intent.** `R` sends `run.create {templateId, versionId?, inputs, budget?}` through the preload bridge; the zod schema validates it; an unknown field or wrong type is rejected at the boundary before any Core code runs.
2. **IPC dispatch.** `M` maps channel → Core command handler; `orgId` and `traceId` are attached from local identity; a `traceId` is generated if absent.
3. **Policy gate.** `C` calls `G.PolicyEvaluator.evaluate({orgId, intent})`. Deny-by-default; a refusal returns `Result.err(POLICY_DENIED)` and writes an `AuditEntry`.
4. **Resolve the version.** `C` loads the target `WorkflowTemplate` and picks either the explicitly requested `WorkflowVersion` or the current `published` one. `draft` is refused; `deprecated` is refused with `DEPRECATED_TEMPLATE`; `archived` is refused with `ARCHIVED_READONLY`.
5. **Lock acquisition.** `C` attempts `TemplateLock{scope:'run'}` for that `versionId` (idempotent if the same run already holds it). Contention yields `LOCKED_TEMPLATE` unless a compatible lock exists for the same run.
6. **Snapshot pinning.** `C` creates `RunSnapshot {workflowVersionId, templateLockId, packVersions, modelBindings, memoryViewRef, createdAt}` with `packVersions` = currently loaded pack versions, `modelBindings` = resolved bindings (empty in Phase 0/1), `memoryViewRef` = a read-consistent memory view handle.
7. **Run row.** `C` persists `Run {state:'queued', snapshotId}` and emits `RunQueued`. Metrics counters for `runCount` increment as a projection (not as workflow mutation).
8. **Scheduling.** `M`'s run engine takes the queued run, computes the DAG from **the snapshot's graph** (never `workflow_versions.graph` live), and marks nodes `ready`. `RunState: queued → running`.
9. **Step execution.** For each ready `NodeExecution`: `M` dispatches to `W`. The worker performs the step (in P0/P1: deterministic/local work; model calls arrive with P2 adapters), and reports back through the port boundary rather than writing to the DB itself.
10. **Handoff (if the node is inter-role).** The node emits a `HandoffEnvelope` (`docs/HANDOFF_PROTOCOL.md`): it is written to the **outbox** in the same transaction as the node's state change, then dispatched. The receiver `ack`s or `nack`s; dedupe is by `idempotencyKey`. `RunState: running → waiting_handoff` while a handoff is outstanding and the run has no other runnable node.
11. **Artifacts & memory.** Large payloads go to the artifact store (`contentRef`), small ones inline. Memory writes are scoped: `working` during the run; promotion to `episodic` on checkpoint; `semantic` consolidation only through an explicit promotion rule (`docs/MEMORY_ARCHITECTURE.md`).
12. **Checkpoint.** On each node completion the engine writes a `Checkpoint` (last completed node, node outputs refs, memory view cursor) inside one `EntityStore.transaction`.
13. **Human gate (if the node requires approval).** `G` opens an `Approval`; the run waits in `waiting_handoff` with `intent: 'approval'`. Approval consumes the envelope's `idempotencyKey` once; a second attempt is a no-op.
14. **Completion.** Terminal node(s) succeed → `RunState: succeeded`; `EventBus` emits `RunSucceeded`. Any node exhaustion → `failed`; timeout → `timed_out`; user stop → `cancelled` (children cancelled first, then the run).
15. **Snapshot release.** `releasedAt` is stamped on the run-scope `TemplateLock` **only if** no other in-flight run holds that version. Emits `TemplateLockReleased`.
16. **Metrics rollup.** `WorkflowMetrics` projection recomputes `runCount, successRate, p50DurationMs, p95DurationMs, costUsd, tokensIn/Out, humanInterventions, nodeFailureRates{}` for the pinned version. Read-only; never touches workflow state.
17. **Response.** `M` maps the last `Result` to the IPC response envelope; the renderer receives a typed result or a typed error code — never a stack trace and never a raw SQL error string.

---

## 8. Technology stack (locked — CANONICAL_SPEC §7)

| Layer | Technology | Version / constraint | Notes |
|---|---|---|---|
| Runtime | Node.js | `>= 22.5.0` required (dev env: **Node 24**) | `>= 22.5` gates `node:sqlite` (ADR-0003) |
| Package manager | **pnpm workspaces** | pnpm 9.x (lockfile committed) | `pnpm install --frozen-lockfile` in CI |
| Language | **TypeScript** | 5.x, `strict: true`, `noUncheckedIndexedAccess: true`, `module: nodenext` | ESM-first (ADR-0004) |
| Module system | ESM | `"type": "module"` in every package | no CJS interop shims |
| Persistence | **SQLite via `node:sqlite`** | built into Node ≥ 22.5, sync API | no native compilation step; WAL mode |
| Migrations | numbered SQL + checksum | `NNNN_name.sql` applied by a `schema_migrations` table | checksum mismatch ⇒ refuse to open DB |
| Domain hashing | sha256 over canonical JSON | `node:crypto` | `contentHash` (ADR-0006) |
| Logging | structured JSON lines | one `Logger` port; console sink + rotating file sink | correlation ids `traceId`/`runId`/`orgId`; redaction allow-list |
| Desktop shell | **Electron** | Electron 3x/LTS pinned | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP, navigation guards (ADR-0010) |
| UI | **React 19** | React 19.x | function components + hooks only |
| UI build | **Vite** | 6.x (renderer dev server + prod bundle) | shell bootstrapped only by `dsh`-style host injection in dev |
| Validation | zod | 3.x | IPC request/response + `PackManifest` + `MemoryRecord` |
| IDs | ulid | via `IdFactory` port | sortable, monotonic within a millisecond |
| Tests | **Vitest** | 3.x — unit + architecture boundary tests | `boundaries.test.ts` asserts 0 violations |
| CI | **GitHub Actions** | job `check` → `pnpm check` | lint + typecheck + boundary + test + build |
| Agent/model runtime | **none in Core** | `ModelGateway` / `AgentRuntime` interfaces only | ADR-0011; implementations are P2 adapters |

**Version pinning policy:** exact versions in `package.json` workspace deps; lockfile authoritative; `pnpm audit` in CI; new runtime dependencies in Core require an ADR (ADR-0011 budget).

---

## 9. Non-functional requirements

### 9.1 Performance budgets

| Path | Budget | Measurement |
|---|---|---|
| Cold start → interactive window | **≤ 2.0 s** p95 (dev machine, local DB ≤ 200 MB) | instrumented main-process timeline; `app.whenReady` → first paint |
| Warm start → interactive window | **≤ 800 ms** p95 | same |
| IPC round trip (renderer → main → Core → renderer, no I/O) | **≤ 15 ms** p95 | counter in main |
| Single-row `EntityStore.get` on indexed key | **≤ 3 ms** p95 | Vitest bench over 100k rows |
| List query with index, 1k rows | **≤ 25 ms** p95 | bench |
| Lifecycle transition (publish/fork/deprecate) incl. hash + write | **≤ 60 ms** p95 for graphs ≤ 200 nodes | bench |
| Run-start → first node dispatched | **≤ 150 ms** p95 | run trace |
| Migration apply on fresh DB | **≤ 1.5 s** for the Sprint-1 schema set | CI timing assertion |
| UI: workflow list of 5k templates | **≤ 100 ms** to first paint, virtualized | renderer perf test |

### 9.2 Offline-first

- No P0–P2 capability performs a network request; there is no "loading from cloud" state.
- All model access is behind `ModelGateway` and is absent from Phase 1, so Phase 1 is fully deterministic and offline.
- Any future networked adapter must degrade to a typed `Result` error, never block a run indefinitely (deadline enforcement belongs to `ModelGateway`, not Core).

### 9.3 Startup time

Budget as §9.1. Startup ordering: single-instance lock → open DB → verify migration checksums → apply pending migrations → load pack manifests (validate) → construct adapters → register IPC handlers → create window → first paint. Failure at any step produces a diagnosable error screen with the failing step name; no silent fallback to an empty DB.

### 9.4 DB size

| Bound | Value |
|---|---|
| Expected steady state (single user, 1 year, no artifacts) | ≤ 500 MB |
| Hard warning threshold | 2 GB → UI advisory + compaction suggestion |
| Artifact blobs | never in the DB; stored under `%APPDATA%\CompanyOS\artifacts/` and referenced by `contentRef` |
| Event log | append-only; retention per `docs/MEMORY_ARCHITECTURE.md` capacity policy |
| Growth control | VACUUM on explicit maintenance; WAL checkpoint on quit; projection rebuild is O(events) |

### 9.5 Crash recovery

| Failure | Required behaviour |
|---|---|
| Process killed mid-run | On next start the run is `running`/`waiting_handoff` but has no live worker ⇒ mark `paused`, expose "resume" using the last `Checkpoint` |
| Crash between state write and event append | Both are in **one transaction** (outbox pattern): either both land or neither does |
| Crash during migration | `schema_migrations` is written in the same transaction as the DDL; a partially applied migration is never recorded |
| Corrupted snapshot pin | Run fails loudly with `SNAPSHOT_MISMATCH`; run is `failed`, not silently re-pinned to live state |
| DB lock contention | Only main process writes; contention indicates a bug and is surfaced as a typed error |
| Stale `TemplateLock` (holder gone) | Lock has `lockedAt`; an expiry/liveness sweep releases locks whose owning run is terminal, and emits `TemplateLockReleased` with `reason: 'sweep'` |

### 9.6 Other NFRs

| NFR | Target |
|---|---|
| Test coverage (Core) | ≥ 80% line coverage on `packages/core/src`; 100% of lifecycle transitions have an explicit test |
| Determinism | every domain test runs with a fake `Clock` and a seeded `IdFactory`; no wall-clock reads in domain code |
| Accessibility | renderer targets WCAG 2.1 AA for core flows |
| Observability | every command logs one structured line with `traceId`, `orgId`, `durationMs`, `outcome` |
| Recoverability | a full backup = copy `companyos.db` + `artifacts/`; restore is a file copy while the app is closed |
| Reproducibility | pinning a `RunSnapshot` + the same pack versions must yield the same node order and the same `contentHash` |

---

## 10. C4-ish context and container view

```text
C4 L1 — CONTEXT
                     ┌──────────────────────────────────────────────┐
   [Operator / User] │           CompanyOS (local desktop)          │
        ────────────►│  staffs a virtual company, authors SOPs,      │
                     │  executes runs, inspects memory & audit       │
                     └───────┬───────────────────────────┬──────────┘
                             │                           │
                 reads/writes│ local files               │ (P2+ optional,
                             ▼                           ▼  OFF by default)
                  %APPDATA%\CompanyOS\{db, artifacts}  [Model provider — external]

   C4 L2 — CONTAINERS (inside CompanyOS)
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  apps/renderer (React 19)  ──typed IPC──►  apps/desktop (Electron main)  │
   │                                               │                          │
   │                                               ├─► @companyos/core        │
   │                                               ├─► @companyos/persistence │
   │                                               └─► @companyos/platform    │
   │  packs/* (registered at startup, contract-only)                           │
   │  SQLite file (main process access only)                                   │
   └──────────────────────────────────────────────────────────────────────────┘

   C4 L3 — COMPONENTS inside @companyos/core
   Kernel ─ Org ─ Workflow ─ Execution ─ Memory ─ Governance ─ CapabilityRegistry
      │       │        │           │         │          │              │
      └───────┴────────┴── EventBus (in-process) ───────┴──────────────┘
                    ports: Clock · IdFactory · Logger · EntityStore<T> ·
                           MigrationRunner · SecretResolver · ModelGateway* ·
                           AgentRuntime* · MemoryReader · MemoryWriter ·
                           EmbeddingProvider     (* interface only in Sprint 0)
```

---

## 11. Repository layout

```text
companyos/
├─ .planning/CANONICAL_SPEC.md        # single source of truth
├─ docs/                              # these eight deliverables
├─ apps/
│  ├─ desktop/                        # Electron main + preload (composition root)
│  └─ renderer/                       # React 19 + Vite
├─ packages/
│  ├─ contracts/                      # shared pure types + zod + canonicalize()
│  ├─ core/                           # 7 bounded contexts, ports, lifecycle machine
│  │  └─ src/lifecycle/lifecycle-machine.ts
│  ├─ adapters/
│  │  ├─ persistence/                 # node:sqlite EntityStore + migrations
│  │  └─ platform/                    # clock, ids, logger sinks, secrets
│  ├─ ipc/                            # typed channel registry
│  └─ pack-sdk/                       # PackManifest + capability registration
├─ packs/
│  ├─ devcompany/  article/  video/  ecommerce/
├─ scripts/
│  ├─ check-boundaries.mjs
│  └─ __fixtures__/boundary-violation/
├─ AGENTS.md
└─ PROJECT_HANDOFF.md
```

## 12. Non-goals for V1.1 (explicit)

Model Router, Agent Runtime, DevCompany/Coding Agent, Workflow Designer UI, 多模型调度, multi-user/team features, cloud sync, marketplace, SSO, billing. Per CANONICAL_SPEC §6 these must not be built, scaffolded, or stubbed with logic in Sprint 0, and P2/P3 items may only be *designed* (as done in these docs), never implemented, until their phase opens.
