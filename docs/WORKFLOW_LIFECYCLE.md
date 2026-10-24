> ⚠️ **实现说明（Sprint 4 起）**：本文件是 V1.1 **规范词表（Bible）**，源自 `.planning/CANONICAL_SPEC.md`。
> 实现细节以代码 + `docs/LIFECYCLE_GOVERNANCE.md` + `docs/adr/0007-workflow-lifecycle-governance.md` 为准。
> 已知差异（AGENTS §0.1 的裁定，已记录在 `PROJECT_HANDOFF.md`）：① 首版草案版本号实现为 `1.0.0-draft`
> （T01 写作 `0.1.0-draft`）；② 首版发布时被取代的草案行会被删除，修订发布则把草案行**原地转正**
> （T03 描述为"保留只读"）；③ 版本事件的聚合键是**版本 id**（模板 id 在 payload），便于按版本审计。

> Source of truth: .planning/CANONICAL_SPEC.md (RECONSTRUCTED — diff against 规划书 before Sprint 1)

# CompanyOS V1.1 — Workflow Lifecycle Bible

| Field | Value |
|---|---|
| Document | WORKFLOW_LIFECYCLE.md — canonical vocabulary, transitions, versioning, forks, locks, proposals, metrics |
| Owning context | **Workflow** bounded context (`@companyos/core`, CANONICAL_SPEC §3.3) |
| Machine implementation | `packages/core/src/lifecycle/lifecycle-machine.ts` |
| Formal state machines | `docs/STATE_MACHINE.md` (this doc is semantic; that doc is formal) |
| Capability coverage | 10/10 (CANONICAL_SPEC §2) |

---

## 1. Purpose and scope

This document is the **semantic contract** for the Workflow bounded context: what each entity means, which transitions exist, what guards them, what they emit, and what must be true afterwards. It is the reference used by tests (`packages/core/src/lifecycle/*.spec.ts`), by the migration schema, and by the UI's action-enablement logic.

**In scope:** `WorkflowTemplate`, `WorkflowVersion`, `RunSnapshot` (pinned by Workflow, owned by Execution), `TemplateLock`, `ChangeProposal`, `WorkflowMetrics`, `ForkLineage`.
**Out of scope:** node execution semantics (`docs/HANDOFF_PROTOCOL.md`), memory promotion (`docs/MEMORY_ARCHITECTURE.md`), policy/budget rules (`docs/SECURITY_MODEL.md` §12, Governance).

---

## 2. Entity glossary

| Entity | Canonical identifier | Definition | Mutability |
|---|---|---|---|
| **WorkflowTemplate** | `WorkflowTemplate` | A named SOP/DAG container belonging to an org. Holds identity, current lifecycle state, and a pointer to its current version. Template identity survives all versioning; it is *not* the graph. | Mutable while `draft`; identity immutable |
| **WorkflowVersion** | `WorkflowVersion` | `{id, templateId, semver, contentHash, graph, createdAt, changeProposalId?}`. An immutable snapshot of the graph at publish (or a mutable pre-publish draft version). Published versions are **append-only**. | Published = **immutable forever** |
| **RunSnapshot** | `RunSnapshot` | `{id, workflowVersionId, templateLockId, packVersions, modelBindings, memoryViewRef, createdAt}`. Immutable pin of everything a run needs. A run reads its snapshot, never live template state. | Immutable |
| **TemplateLock** | `TemplateLock` | `{id, templateId, versionId, scope: 'run'\|'global', reason, lockedBy, lockedAt, releasedAt?}`. Blocks mutation/publish racing against in-flight runs; `global` locks also block forking. | Append-only; release stamps `releasedAt`, never deletes |
| **ChangeProposal** | `ChangeProposal` | `{id, targetTemplateId, baseVersionId, diff, rationale, author, status: open\|accepted\|rejected\|superseded, decidedBy?, decidedAt?}`. Only an `accepted` proposal can mint a new draft version. | Status transitions once |
| **WorkflowMetrics** | `WorkflowMetrics` | Per-version rollups: `runCount, successRate, p50DurationMs, p95DurationMs, costUsd, tokensIn/Out, humanInterventions, nodeFailureRates{}`. Read-only projections; never mutate workflow state. | Rebuildable projection |
| **ForkLineage** | `ForkLineage` | Directed edge `{childTemplateId, parentTemplateId, parentVersionId, forkedBy, forkedAt, forkEventId}` recording that a template was cloned from a specific parent **version**. A first-class graph, queryable in both directions. | Append-only |
| **Node / NodeExecution** | `NodeExecution` | One execution instance of a graph node inside a run. Owned by Execution; referenced here because transitions gate on in-flight nodes. | Lifecycle-managed by Execution |

**Terminology guards:** Core exposes `EntityStore<T>` for persistence — never `Repository` (ADR-0001). Template *content* comes from Industry Packs; Core ships template *shapes* only (ADR-0002).

---

## 3. Canonical state diagram

Reproduced verbatim from CANONICAL_SPEC §2 (this diagram is the source of truth; `lifecycle-machine.ts` must match it exactly):

```
draft --publish--> published --deprecate--> deprecated --archive--> archived
  ^                    |  |
  |                    |  +--lock(scope=run|global)--> (locked overlay)
  |                    +--fork--> NEW template(draft)
  |                    +--revise (via accepted ChangeProposal) --> NEW draft version
  +--------------------+
```

Reading rules:

- `draft`, `published`, `deprecated`, `archived` are the **template lifecycle states** of `WorkflowTemplateLifecycle`.
- `lock` is a **state overlay**, not a lifecycle state: a `published` template may be `published + locked(run)` or `published + locked(global)`. It never leaves `published`.
- `fork` and `revise` create **new** entities (a new template, or a new version of the same template). They do not move the parent.
- `archived` is **absorbing** (no outgoing edges).
- Every illegal edge throws `LifecycleError` with code `ILLEGAL_TRANSITION` (CANONICAL_SPEC §2).

Reconstruction of the ambiguous arrows in text form (the ASCII art's `+----+` loop):

```text
revise produces a new draft version of the SAME template:
  published(v1.2.0) --revise(via accepted ChangeProposal)--> draft(v1.3.0-draft) --publish--> published(v1.3.0)

fork produces a new template:
  published(v1.2.0) --fork--> NEW template#2(state=draft, forkedFrom={template#1, v1.2.0})

the `^ ... +----+` edge means: publishing the revised draft version returns the
template to `published` — i.e. a template is never "stuck" in draft while it has
a published history; `state` always reflects the newest non-archived version.
```

---

## 4. Transition table

Legend — **Idempotent**: repeating the same command with the same idempotency key is a no-op returning the original result. **Emitted events** are appended to the event log inside the same transaction as the state write (outbox; `docs/HANDOFF_PROTOCOL.md` §5).

### 4.1 Template lifecycle transitions

| # | From | Event (command) | Guard | Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|---|
| T01 | *(none)* | `template.create` | org exists; actor holds `workflow.draft.create` | Creates `WorkflowTemplate{state:'draft'}` + `WorkflowVersion{id, semver:'0.1.0-draft', contentHash:null(or draftHash), graph}` | `WorkflowTemplateCreated`, `WorkflowDraftCreated` | `POLICY_DENIED`, `ORG_NOT_FOUND` |
| T02 | `draft` | `template.update` | actor holds `workflow.draft.edit`; **no** `global` lock on the template; template not `archived` | Mutates the draft version's graph in place (draft is the only mutable version) | `WorkflowDraftUpdated` | `LOCKED_TEMPLATE`, `ARCHIVED_READONLY` |
| T03 | `draft` | `publish` | graph passes validation (acyclic, all `capabilityId`s resolvable against registered packs, all required inputs declared); actor holds `workflow.publish`; **no** active `run`/`global` lock on the version; `contentHash` computed and not already used by another version of this template | Mints immutable `WorkflowVersion{semver, contentHash}`, sets `state:'published'`, sets `publishedVersionId`; draft version is superseded (kept, read-only) | `WorkflowPublished`, `WorkflowVersionMinted` | `ILLEGAL_TRANSITION` (if not `draft`), `LOCKED_TEMPLATE`, `VALIDATION_FAILED`, `HASH_MISMATCH` (recompute ≠ recorded) |
| T04 | `published` | `revise` | `ChangeProposal.status === 'accepted'` for `baseVersionId`; actor holds `workflow.revise`; no active lock on the base version | Creates **new** draft version (`1.2.0` → `1.3.0-draft`) referencing `changeProposalId`; parent version unchanged; template `state` stays `published` (it still has a published version) | `WorkflowVersionRevised`, `WorkflowDraftCreated` | `PROPOSAL_NOT_ACCEPTED`, `LOCKED_TEMPLATE`, `ARCHIVED_READONLY` |
| T05 | `published` \| `deprecated` | `fork` | actor holds `workflow.fork`; **no `global` lock** on the source (a `run`-scope lock does **not** block fork); source version still loadable | Creates a **new** `WorkflowTemplate{state:'draft'}` + draft version copying the source graph, plus `ForkLineage{childTemplateId, parentTemplateId, parentVersionId}` | `WorkflowForked`, `ForkLineageRecorded`, `WorkflowDraftCreated` | `LOCKED_TEMPLATE` (scope=global), `ILLEGAL_TRANSITION` (source is `draft`/`archived`) |
| T06 | `published` | `deprecate` | actor holds `workflow.deprecate` | `state: published → deprecated`; new runs are **refused**; already-issued `RunSnapshot`s keep running on their pinned version | `WorkflowDeprecated` | `ILLEGAL_TRANSITION` (not `published`), `LOCKED_TEMPLATE` (global lock) |
| T07 | `deprecated` | `archive` | actor holds `workflow.archive`; **no in-flight run** holds a `run`/`global` lock on any version of this template | `state: deprecated → archived`; `archivedAt` stamped; template becomes read-only forever | `WorkflowArchived` | `ILLEGAL_TRANSITION` (not `deprecated`), `LOCKED_TEMPLATE` (in-flight run) |
| T08 | `archived` | *(any command)* | — | none; **absorbing** | — | `ARCHIVED_READONLY` (and `ILLEGAL_TRANSITION` for lifecycle commands) |
| T09 | `draft` | `publish` **re-attempt** with identical `contentHash` | — | Idempotent: returns the existing published version; no new version minted | `none` (or `WorkflowPublishReplayed` on the audit channel) | `ILLEGAL_TRANSITION` only if a *different* hash is being published as the same semver |
| T10 | `published` | `unpublish` / `revert to draft` | — | **Not supported in V1.1.** A published version is permanent (ADR-0006). The supported correction path is `revise` → `publish` a new semver. | — | `ILLEGAL_TRANSITION` (explicitly unreachable by design) |

### 4.2 Lock transitions (overlay)

| # | From | Event (command) | Guard | Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|---|
| L01 | no lock | `lock(scope:'run')` | at least one in-flight run pins this `versionId`; actor is that run's engine or holds `workflow.lock` | Inserts `TemplateLock{scope:'run', lockedAt, releasedAt:null}` | `TemplateLockAcquired` | `ILLEGAL_TRANSITION` if the version is `archived`; `LOCKED_TEMPLATE` if an incompatible lock exists |
| L02 | no lock | `lock(scope:'global')` | actor holds `workflow.lock.global` (admin/maintenance intent, e.g. pack upgrade) | Inserts `TemplateLock{scope:'global'}` | `TemplateLockAcquired` | `LOCKED_TEMPLATE` if any lock exists |
| L03 | `scope:'run'` | `lock(scope:'run')` **same run** | same `runId` | Idempotent — no second row | `none` | — |
| L04 | `scope:'run'` | `lock(scope:'global')` | no other lock; actor holds global authority | Escalates: inserts a `global` lock (the `run` lock stays and is subsumed for guard purposes) | `TemplateLockEscalated` | `LOCKED_TEMPLATE` |
| L05 | any lock | `release(lockId)` | actor owns the lock **or** holds `workflow.lock.release`; for `scope:'run'`, no other in-flight run needs this version | Stamps `releasedAt` (never deletes) | `TemplateLockReleased` | `ILLEGAL_TRANSITION` if already released |
| L06 | `scope:'run'` | `release` when another run still pins the version | — | Lock is **transferred**: the row is released and a new `run` lock row is inserted for the surviving run, in one transaction | `TemplateLockReleased`, `TemplateLockAcquired` | — (this is the anti-premature-release path) |
| L07 | any lock | sweep: owning run became terminal while lock open | run state ∈ `{succeeded, failed, cancelled, timed_out}` | Stamps `releasedAt` with `reason:'sweep'`; emits `TemplateLockReleased` | `TemplateLockReleased` | — |
| L08 | `scope:'global'` | `fork` | — | Refused while the global lock is held | — | `LOCKED_TEMPLATE` |
| L09 | any lock | `publish` / `revise` on the locked version | — | Refused while locked | — | `LOCKED_TEMPLATE` |

### 4.3 Change proposal transitions

| # | From | Event (command) | Guard | Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|---|
| C01 | *(none)* | `proposal.open` | actor holds `workflow.proposal.open`; `baseVersionId` belongs to `targetTemplateId` and is `published` or `deprecated`; `diff` parses against the base graph | Creates `ChangeProposal{status:'open'}`; prior `open` proposals for the same `baseVersionId` + overlapping node set are auto-`superseded` | `ChangeProposalOpened`, `ChangeProposalSuperseded` | `POLICY_DENIED`, `VALIDATION_FAILED` (unparseable diff) |
| C02 | `open` | `proposal.decide(accepted)` | decider holds `workflow.proposal.decide`; decider ≠ author unless the org's policy explicitly permits self-approval (deny-by-default); proposal not stale (base version still exists) | `status:'accepted'`, `decidedBy`, `decidedAt` stamped | `ChangeProposalAccepted` | `ILLEGAL_TRANSITION` (not `open`), `POLICY_DENIED` (self-approval), `STALE_PROPOSAL` |
| C03 | `open` | `proposal.decide(rejected)` | decider authority as C02 | `status:'rejected'` + `decidedBy`/`decidedAt` + required `reason` | `ChangeProposalRejected` | `ILLEGAL_TRANSITION`, `POLICY_DENIED` |
| C04 | `open` | `proposal.supersede` | a newer proposal targets the same base/overlap, or the author withdraws | `status:'superseded'` | `ChangeProposalSuperseded` | `ILLEGAL_TRANSITION` |
| C05 | `accepted` | `revise` consumed | — | Proposal is **consumed**: `accepted` is a one-shot token. Consumed proposals record `consumedByVersionId` and become non-reusable. | `ChangeProposalConsumed` | second `revise` on the same proposal ⇒ `PROPOSAL_NOT_ACCEPTED` |
| C06 | `rejected` \| `superseded` | `revise` | — | Refused | — | `PROPOSAL_NOT_ACCEPTED` |
| C07 | `accepted` \| `rejected` \| `superseded` | `proposal.decide` again | — | Refused (terminal) | — | `ILLEGAL_TRANSITION` |

### 4.4 Version and run-pinning transitions

| # | From | Event (command) | Guard | Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|---|
| V01 | `draft` version | `version.mint` | on `publish` only | Creates the immutable published version; assigns semver + `contentHash` | `WorkflowVersionMinted` | `ILLEGAL_TRANSITION` |
| V02 | `deprecated` version | `run.create` | — | Refused; existing snapshots unaffected | — | `DEPRECATED_TEMPLATE` |
| V03 | `draft` version | `run.create` | — | Refused; no production runs from `draft` (CANONICAL_SPEC §2) | — | `ILLEGAL_TRANSITION` (`DRAFT_NOT_RUNNABLE`) |
| V04 | `archived` template | `run.create` | — | Refused globally for that template | — | `ARCHIVED_READONLY` |
| V05 | `published` version | `run.create` | policy gate passes; lock acquirable | Pins `RunSnapshot{workflowVersionId, templateLockId, packVersions, modelBindings, memoryViewRef}`; run reads snapshot only | `RunSnapshotPinned`, `RunQueued` | `LOCKED_TEMPLATE`, `POLICY_DENIED`, `SNAPSHOT_MISMATCH` (pin verification fails) |
| V06 | pinned snapshot | `snapshot.verify` (on resume/replay) | recorded `contentHash` recomputes equal; `packVersions` still loadable at the pinned versions; `memoryViewRef` resolvable | Verification passes; run proceeds | `RunSnapshotVerified` | `SNAPSHOT_MISMATCH`, `HASH_MISMATCH` |

**Transition count:** 10 template-lifecycle + 9 lock + 7 proposal + 6 version/run paths = **32 enumerated transitions**, every one with an explicit enforcement point in `lifecycle-machine.ts`.

---

## 5. Versioning rules

### 5.1 Semver policy

| Change class | Semver bump | Examples |
|---|---|---|
| Breaking: input/output contract change, node removed, capability contract pinned to an incompatible range, handoff intent renamed | **MAJOR** | a required input added and no longer defaultable; a step's output contract changed incompatibly |
| Additive: new optional node, new optional input, new recovery path, relaxed guard | **MINOR** | adding an approval gate; adding an optional branch |
| Cosmetic/behaviour-preserving: label text, description, layout coordinates, comment | **PATCH** | renaming a display label (the *node id* must not change to keep it PATCH) |
| Authoring before first publish | **`0.x.y-draft`** | `0.1.0-draft`, bumped in place while `draft` |
| Revision of a published version | **new draft `MAJOR.MINOR.(PATCH+1)-draft`** | `1.2.0` → `1.3.0-draft` (CANONICAL_SPEC §2 example) or `2.0.0-draft` if breaking |

Rules:

- **R-SEMVER-1** A published semver is never reused, even if the graph is later reverted to an identical hash (that path is a re-publish *replay*, T09, returning the existing version).
- **R-SEMVER-2** Only `0.1.0-draft` and subsequent `-draft` versions are mutable. Any version without the `-draft` suffix is immutable (ADR-0006).
- **R-SEMVER-3** `1.0.0` is the first production-ready publish; before that, `0.y.z` may break with a MINOR bump, documented as a pre-1.0 caveat in the UI.
- **R-SEMVER-4** The bump class is chosen by the **author** and *verified* by the lifecycle machine: if the graph diff exceeds the declared bump, `publish` fails with `VALIDATION_FAILED` (`semver-bump-too-small`). Under-declaring is caught mechanically; over-declaring is allowed (safe direction).

### 5.2 `contentHash` canonicalization

```text
contentHash = sha256_hex( canonicalize(graph) )

canonicalize(graph):
  1. Serialize as JSON with object keys sorted lexicographically (recursively),
     array order PRESERVED (array order is semantic for edges/inputs).
  2. Emit with no insignificant whitespace: JSON.stringify with a stable key order,
     no trailing spaces, no indentation.
  3. EXCLUDE all authoring/no-volatile metadata: createdAt, updatedAt, author, comment,
     UI layout coordinates, description strings NOT referenced by runtime semantics,
     runtime ids that are regenerated per version (versionId, templateId).
  4. INCLUDE everything runtime-relevant: node ids, node kinds (capabilityId),
     edges, guards, input schema + defaults, output contract refs, timeout/retry policy,
     approval-gate declarations, memory read/write declarations, pack capability pins.
  5. Encode as UTF-8; output lowercase hex sha256 (64 chars).

Verification:
  - On `publish`: compute, store on WorkflowVersion.contentHash, and re-compute once
    inside the write transaction; disagreement ⇒ HASH_MISMATCH, transaction aborts.
  - On `snapshot.verify`: recompute from the version's stored graph; disagreement ⇒
    HASH_MISMATCH ⇒ run fails (never silently proceeds).
  - On projection rebuild: version rows must be byte-identical to their first write.
```

**Why no timestamps:** reproducibility. Two authors who produce the same graph must get the same hash, or `RunSnapshot` pinning and cache keys become time-dependent. Hash equality therefore means **runtime-equivalence**, which is exactly the claim the product makes.

### 5.3 Immutability invariants

| ID | Invariant |
|---|---|
| INV-VER-01 | No `UPDATE` statement targets `workflow_versions` for a row whose `semver` lacks the `-draft` suffix. Enforced by a DB trigger plus a repository-level guard. |
| INV-VER-02 | `contentHash` is `NOT NULL` and unique per `(template_id, content_hash)` for published versions. |
| INV-VER-03 | `WorkflowVersion.graph` for a published version is byte-identical to its first persisted value (verified by the `snapshot.verify` path and by a periodic integrity sweep). |
| INV-VER-04 | A `RunSnapshot` references exactly one `WorkflowVersion` and never changes it. |
| INV-VER-05 | Revising a published version never mutates it; the parent's row is byte-identical after revision (test: `lifecycle.version.immutability.spec.ts`). |

---

## 6. Fork semantics and lineage

### 6.1 Fork semantics

| Aspect | Rule |
|---|---|
| Source states allowed | `published`, `deprecated`. Forking from `draft` or `archived` is `ILLEGAL_TRANSITION`. |
| Result | A **new** `WorkflowTemplate` in `draft` + a new mutable draft version copying the source graph. Semver restarts at `0.1.0-draft`. |
| Parent | Unchanged in every respect — state, version, hash, metrics. Fork is not a move. |
| Lineage recorded | `ForkLineage{childTemplateId, parentTemplateId, parentVersionId, forkedBy, forkedAt, forkEventId}` in the same transaction as the new template insert. |
| Lock interaction | A `scope:'global'` lock on the source **blocks** fork (`LOCKED_TEMPLATE`). A `scope:'run'` lock does **not** (reads are safe; fork reads only). |
| Metrics | The child starts with **empty** `WorkflowMetrics`. Metrics never inherit across a fork — attribution follows execution, not ancestry. |
| Memory | The child does **not** inherit `working`/`episodic` memory. It may read `semantic` memory permitted by the org's policy (fork is not an amnesia event). |
| Fixes forward | A fork is not a merge mechanism in V1.1. Divergence is resolved by porting a change forward manually through a `ChangeProposal` on either side. Three-way merge is explicitly out of scope for V1.1. |

### 6.2 Lineage queries

| Query | Definition | Notes |
|---|---|---|
| `ancestors(templateId)` | Walk `ForkLineage` backwards to the root; ordered nearest → root | Cycle-safe (the graph is a DAG by construction; a cycle is a corruption error) |
| `descendants(templateId, depth?)` | Walk forwards, optionally bounded | UI shows "forks of this SOP" |
| `siblings(templateId)` | Templates sharing the same `parentTemplateId` | Used to compare diverged variants |
| `forkPoints(templateId)` | Distinct `parentVersionId`s across a template's children | Answers "who forked the buggy `1.2.0`?" |
| `roots()` | Templates with no `ForkLineage` row | Canonical/original SOPs |
| `impactOf(parentVersionId)` | All descendants of a specific version | Used before `deprecate`/`archive` to notify fork owners |

Lineage storage: edge table `workflow_fork_lineage` with indexes on `child_template_id` (unique) and `parent_template_id`; ancestor walks use a recursive CTE. Lineage rows are **append-only** — a deleted template leaves its lineage edge intact for audit (soft delete only).

---

## 7. Template lock semantics

### 7.1 Scopes

| Scope | Blocks | Does **not** block | Typical holder |
|---|---|---|---|
| `scope:'run'` | `template.update`, `publish`, `revise`, `deprecate`, `archive` of the locked version | `fork`, reads, metrics rollup, other runs on the same version | the run engine, while ≥ 1 run pins the version |
| `scope:'global'` | everything `run` blocks **plus** `fork` | existing runs already pinned to a snapshot | an admin/maintenance action (pack upgrade, schema migration, incident freeze) |

Lock is an **overlay**: the template remains `published`. Guard evaluation order is: (1) archived check, (2) lock check, (3) state-machine edge check, (4) policy check. This order is fixed so that error codes are deterministic — an archived+locked template reports `ARCHIVED_READONLY`, not `LOCKED_TEMPLATE`.

### 7.2 Race and deadlock avoidance

| Hazard | Mechanism |
|---|---|
| Two runs start simultaneously on the same version | Lock insert is `INSERT ... ON CONFLICT DO NOTHING` inside a transaction, then re-read; a compatible existing `run` lock is reused. Single-writer (main process) makes the window tiny; the DB constraint makes it correct. |
| Publish racing with run start | Both take the same template-scoped write transaction. `publish` checks for an *active* `run` lock and fails with `LOCKED_TEMPLATE`; a run start checks the version is `published` and unlocked-by-global and fails likewise. Exactly one wins; the loser gets a typed error, never a partial state. |
| Revision racing with publish of the same draft | Both target the same draft version row inside one transaction; the loser sees the draft id already consumed and fails with `ILLEGAL_TRANSITION`. |
| Lock transfer while releasing (L06) | Release + re-acquire happens in **one** transaction; there is no instant where the version appears unlocked while a run still pins it. |
| Forgotten lock | `locked_at` + liveness sweep: at startup and every N minutes, locks whose owning run is terminal are released with `reason:'sweep'`. |
| Deadlock between two locks | **Single-acquisition ordering rule:** a transaction acquires locks in ascending `templateId` order and never acquires a second template's lock while holding one whose guard it has already evaluated. Nested lock acquisition across templates is prohibited in V1.1 (no cross-template transactions exist), which removes the cycle class entirely. |
| Long global lock | `scope:'global'` has a mandatory `reason` and a **max advisory TTL of 24 h**; exceeding it raises a UI warning and an audit entry. It does **not** auto-release (silent release would be worse than a stuck lock). |

---

## 8. Change proposal workflow

### 8.1 State machine

```text
        proposal.open
              │
              ▼
        ┌─────────┐   decide(accepted)   ┌──────────┐   revise (one-shot)   ┌──────────┐
        │  open   │─────────────────────►│ accepted │──────────────────────►│ consumed │
        └────┬────┘                      └──────────┘                       └──────────┘
             │  decide(rejected)   ┌──────────┐
             ├────────────────────►│ rejected │   (terminal)
             │                     └──────────┘
             │  supersede          ┌────────────┐
             └────────────────────►│ superseded │  (terminal)
                                   └────────────┘
```

Canonical statuses per CANONICAL_SPEC §2: `open | accepted | rejected | superseded`. `consumed` is a **derived flag** (`consumedByVersionId != null`) on an `accepted` proposal, not a fifth canonical status — recording it as a separate status would contradict the spec.

### 8.2 Who may decide

| Rule | Detail |
|---|---|
| Authority | Decider must hold `workflow.proposal.decide` (via `AuthorityGrant`), resolved by Governance (CANONICAL_SPEC §3.5). |
| Segregation of duties | Decider ≠ author by default. Self-approval requires an explicit org policy that names the exception and is recorded in the audit log. Deny-by-default. |
| Multiple deciders | First decision wins; the proposal becomes terminal. Concurrent decisions are serialized by the write transaction; the loser receives `ILLEGAL_TRANSITION`. |
| Staleness | If `baseVersionId` no longer exists or the base has been archived, `decide` fails with `STALE_PROPOSAL`; the proposal must be re-opened against the current base. |
| Audit | `decidedBy`, `decidedAt`, and the free-text `reason` (required for `rejected`) are persisted and emitted as events. |

### 8.3 Diff format

`ChangeProposal.diff` is a **structured** diff, not free text. Stored as JSON, versioned, validated against the base graph:

```jsonc
{
  "diffVersion": 1,
  "baseContentHash": "sha256:1f0c…",       // must match the base version's contentHash
  "bumpIntent": "minor",                    // major | minor | patch — verified at publish
  "ops": [
    { "op": "add_node",    "node": { "id": "n_review", "capabilityId": "cap.review.v1", "timeoutMs": 600000 } },
    { "op": "remove_node", "nodeId": "n_legacy_check" },
    { "op": "update_node", "nodeId": "n_plan", "patch": { "retry": { "max": 3, "backoff": "exponential" } } },
    { "op": "add_edge",    "from": "n_plan", "to": "n_review" },
    { "op": "remove_edge", "from": "n_plan", "to": "n_legacy_check" },
    { "op": "update_input","key": "brief", "patch": { "required": false, "default": "" } },
    { "op": "add_gate",    "after": "n_review", "approverRole": "REVIEWER_ARCHETYPE", "onReject": "halt" }
  ],
  "rationaleRef": "note:7f3a…"             // free-text rationale kept separately from the structural diff
}
```

Rules: ops are applied in listed order and must be **non-overlapping**; the result must be a valid DAG; `baseContentHash` must match or the proposal is rejected at `open` (`VALIDATION_FAILED`); the diff is rendered to a human-readable unified view for review, but the JSON is authoritative (rendering must never be parsed back).

---

## 9. Performance metrics

### 9.1 Definitions and exact formulas

Let a **terminal run** be one whose state ∈ `{succeeded, failed, timed_out}`; `cancelled` runs are excluded from quality metrics because user aborts are not workflow quality signals (they are still counted in `runCount` and reported separately).

| Metric | Formula | Notes |
|---|---|---|
| `runCount` | `|{ run : run.workflowVersionId = v }|` (all states) | Includes `cancelled`; counts only **started** runs (a refusal is not a run) |
| `successRate` | `|{run : state = succeeded}| / |{run : state ∈ {succeeded, failed, timed_out}}|` | `0` (not `NaN`) when the denominator is 0; `sampleSize` reported alongside |
| `cancellationRate` | `|{run : state = cancelled}| / runCount` | Reported for completeness |
| `p50DurationMs` | nearest-rank: sort durations ascending; `idx = ceil(0.50 × N)` (1-based); value at `idx` | `null` when `N < 20`; `sampleSize` always emitted |
| `p95DurationMs` | same with `idx = ceil(0.95 × N)` | `null` when `N < 20`; never interpolated (nearest-rank, not linear interpolation, so p95 is an observed value) |
| run duration (input to percentiles) | `finishedAt − startedAt`, excluding time spent `queued` and excluding `waiting_handoff` time attributable to a **human** gate | Measures the workflow, not the operator's response latency; human latency is its own metric |
| `costUsd` | `Σ run.costUsd` over terminal runs in the window | `0` in Phase 0/1 (no model calls — ADR-0011) |
| `tokensIn` / `tokensOut` | `Σ run.tokensIn`, `Σ run.tokensOut` over terminal runs | `0` in Phase 0/1 |
| `humanInterventions` | `|{ handoff : handoff.intent = 'approval' ∧ handoff.state = acknowledged }|` | Counts decision points, not messages |
| `nodeFailureRates[nodeId]` | `failures(nodeId) / executions(nodeId)` | Per node id, not per node kind; node ids are stable across versions only if the author kept them stable (see §5.1 PATCH rule) |
| `costPerSuccessfulRun` | `costUsd / |{run : state = succeeded}|` | `null` when no successes; never `Infinity` |
| window | Metrics are computed over a **rolling window** (default: last 90 days) plus an **all-time** counter pair (`allTime.runCount`, `allTime.successRate`) | Both are exposed; the UI defaults to the rolling window |

### 9.2 Projection rules

| Rule | Detail |
|---|---|
| Read-only | `WorkflowMetrics` never mutates workflow state. Writing metrics is a projection job; it cannot call a lifecycle command. |
| Rebuildable | Rebuilding from the event log must produce byte-identical rollups (test: `metrics.projection.spec.ts`). |
| Bucketing | Rollups are written per **(versionId, UTC day) bucket** plus a lifetime row. Daily buckets are **sealed** once the day ends and are never recomputed except by a full rebuild. |
| Late-arriving events | A run that finishes after its start day updates **both** the start-day bucket and the finish-day bucket counters that are not yet sealed; sealed buckets are only corrected by a rebuild, and the correction is logged. |
| Attribution | Metrics attach to the **pinned** `workflowVersionId`, never to the template's current version. Forked templates start empty. |
| Cost of computation | Percentiles come from the run table with an index on `(workflow_version_id, state, duration_ms)`; no full-table scans. |

### 9.3 Retention window

| Data | Hot retention | After | Notes |
|---|---|---|---|
| Daily metric buckets | **forever** (append-only, tiny) | — | Per-version rollups are the audit-grade record |
| Run rows + node executions | **180 days** | Purged by maintenance job, after their rollup is verified | Purge requires the lifetime counters to be up to date; purge is logged with counts |
| Run snapshots | **180 days** after the run's terminal state | Purged with the run | A snapshot pinned by a retained run is never purged |
| Event log | **365 days** hot | Archived to `artifacts/events/YYYY-MM.jsonl.gz`, then removed from the DB | Audit-relevant events (publish, deprecate, archive, proposal decisions, lock changes) are **never** purged from the audit chain |
| Audit entries | forever | — | Hash-chained, append-only (`docs/SECURITY_MODEL.md` §10) |
| Templates/versions | forever (archived = retained for audit) | — | `archived` is read-only forever (CANONICAL_SPEC §2) |

---

## 10. Invariants

| ID | Invariant | Enforced by |
|---|---|---|
| INV-WF-01 | `archived` templates have no outgoing transitions (absorbing). | state machine + `ARCHIVED_READONLY` guard |
| INV-WF-02 | A published `WorkflowVersion` is never mutated. | DB trigger + repository guard + INV-VER-03 sweep |
| INV-WF-03 | Every published version has a semver and a `contentHash`. | `NOT NULL` constraints + publish path |
| INV-WF-04 | A run's behaviour is fully determined by its `RunSnapshot`. | Execution reads snapshot only; `snapshot.verify` |
| INV-WF-05 | A new draft version exists only if an `accepted` (unconsumed) `ChangeProposal` authorized it. | T04 guard; `changeProposalId` `NOT NULL` for revised versions |
| INV-WF-06 | A `scope:'global'` lock blocks fork; a `scope:'run'` lock does not. | L08 / T05 guard tests |
| INV-WF-07 | A lock row is never deleted, only released (`releasedAt` stamped). | repository guard + append-only trigger |
| INV-WF-08 | `WorkflowMetrics` never mutates workflow state. | metrics writer is a projection job with no lifecycle access |
| INV-WF-09 | Metrics attribute to the pinned `workflowVersionId`, never to the current version. | projection key is `workflowVersionId` |
| INV-WF-10 | `draft` templates cannot start production runs. | V03 guard → `ILLEGAL_TRANSITION` (`DRAFT_NOT_RUNNABLE`) |
| INV-WF-11 | `deprecated` templates refuse **new** runs; existing snapshots continue. | V02 + T06 semantics; test asserts an in-flight snapshot is unaffected |
| INV-WF-12 | Fork lineage is append-only and preserved after source deletion (soft delete). | `workflow_fork_lineage` append-only trigger |
| INV-WF-13 | Illegal transitions throw `LifecycleError` with code `ILLEGAL_TRANSITION` and change nothing (atomic). | transaction boundary in `lifecycle-machine.ts` |
| INV-WF-14 | `contentHash` is stable across environments for the same graph (no timestamps, sorted keys). | canonicalization spec §5.2 + golden-file test |
| INV-WF-15 | A proposal decision is single-use: an `accepted` proposal mints at most one draft version. | `consumedByVersionId` unique index |
| INV-WF-16 | Every state change emits exactly one domain event within the same transaction. | outbox pattern (`docs/HANDOFF_PROTOCOL.md` §5) |

---

## 11. Failure modes and recovery

| # | Failure mode | Detection | Impact | Recovery | Data loss? |
|---|---|---|---|---|---|
| F01 | Illegal transition attempted (e.g. `archive` on `published`) | `LifecycleError` `ILLEGAL_TRANSITION` | Command refused | Caller fixes the command; no state change (atomic abort) | No |
| F02 | Publish while a run holds the version | `LOCKED_TEMPLATE` | Publish refused | Wait for run completion (or release per L06/L07); retry | No |
| F03 | Global lock forgotten (crash during maintenance) | startup/periodic sweep finds `releasedAt = NULL` with a terminal owner or > 24 h age | Fork + mutations blocked | Released by sweep (`reason:'sweep'`) or explicit release with audit entry | No |
| F04 | `HASH_MISMATCH` at publish | recompute inside write transaction differs | Publish aborts | Investigate non-determinism in the graph (usually an unsorted key or an embedded timestamp); re-publish | No |
| F05 | `HASH_MISMATCH` at snapshot verify | resume/replay recompute differs | Run fails | Treat as corruption: locate which side drifted; a pinned run cannot be "fixed" in place — start a new run from the version after investigating | No (run fails loudly) |
| F06 | `SNAPSHOT_MISMATCH` (pack version gone, memoryViewRef unresolvable) | pin verification | Run cannot start/resume | Restore the pack version, or start a new run on a fresh snapshot (explicitly recorded as a new run, not a silent re-pin) | No |
| F07 | Proposal `revise` without acceptance | `PROPOSAL_NOT_ACCEPTED` | Revision refused | Open/accept a proposal | No |
| F08 | Accepted proposal consumed twice | second `revise` → `PROPOSAL_NOT_ACCEPTED` | Refused | Open a new proposal for further changes | No |
| F09 | Draft edit racing a publish of the same draft | `ILLEGAL_TRANSITION` on the loser | One command refused | Re-read the template and retry against the current draft | No |
| F10 | Fork from an archived template | `ILLEGAL_TRANSITION` | Fork refused | Fork from a live descendant, or un-archive is **not** supported — create a new template | No |
| F11 | Metrics projection crash mid-rollup | projection cursor mismatch / job error | Metrics stale | Rebuild from event log; idempotent | No |
| F12 | Retention purge with stale lifetime counters | pre-purge verification fails | Purge aborted | Rebuild the rollup, then purge | No |
| F13 | Lineage cycle (corruption) | ancestor walk detects a repeated node | Lineage queries fail | Refuse to serve the cycle; integrity sweep + audit entry; the row is quarantined for review | No |
| F14 | Semver bump smaller than the actual diff | publish-time diff classification | Publish refused (`VALIDATION_FAILED`) | Re-declare `bumpIntent` and re-attempt | No |
| F15 | Two concurrent `decide` calls on one proposal | transaction serialization | One refused | Loser re-reads; the proposal is already decided | No |

**Recovery principles:** (1) every failure is *typed* and *atomic* — no partial state; (2) no silent repair path exists for corruption (`HASH_MISMATCH`, `SNAPSHOT_MISMATCH`), because silent repair would undermine the reproducibility claim; (3) all recovery actions emit audit events, including sweeps.

---

## 12. Example lifecycle walkthrough

Scenario: template `tpl_intake` (an intake SOP), one fork, one accepted change proposal, ending archived.

```text
Day 0   | 1.  template.create
        |     → WorkflowTemplate{id: tpl_intake, state: 'draft', orgId: ORG_A}
        |     → WorkflowVersion{id: v_iv1, semver: '0.1.0-draft', contentHash: null, graph: G1}
        |     → events: WorkflowTemplateCreated, WorkflowDraftCreated
        |
Day 0   | 2.  template.update (G1 → G2: add an approval gate after `n_plan`)
        |     → draft version v_iv1.graph = G2   (draft is the only mutable version)
        |     → event: WorkflowDraftUpdated
        |
Day 1   | 3.  publish
        |     guards: G2 is a DAG; all capabilityIds resolvable; no lock; no actor error
        |     → WorkflowVersion{id: v_iv2, semver: '1.0.0', contentHash: 'sha256:aa11…', graph: G2}
        |     → template.state: 'draft' → 'published'; publishedVersionId = v_iv2
        |     → events: WorkflowPublished, WorkflowVersionMinted
        |
Day 3   | 4.  run.create(templateId: tpl_intake, versionId: v_iv2)
        |     → TemplateLock{id: lk_1, scope: 'run', lockedAt: day3, releasedAt: null}
        |     → RunSnapshot{id: snap_1, workflowVersionId: v_iv2, templateLockId: lk_1,
        |                    packVersions: {devcompany: '0.4.2'}, modelBindings: {},
        |                    memoryViewRef: 'mv_7'}
        |     → Run{id: run_1, state: 'queued'} → 'running' → … → 'succeeded'
        |     → run_1 finished; sweep/L06 releases lk_1: releasedAt = day3 (no other run pins v_iv2)
        |     → events: TemplateLockAcquired, RunSnapshotPinned, RunQueued, RunSucceeded, TemplateLockReleased
        |
Day 5   | 5.  proposal.open(targetTemplateId: tpl_intake, baseVersionId: v_iv2, bumpIntent: 'minor')
        |     diff ops: update_node(n_plan.retry) + add_node(n_review) + add_edge(n_plan→n_review)
        |     → ChangeProposal{id: cp_1, status: 'open', author: USER_A}
        |     → event: ChangeProposalOpened
        |
Day 6   | 6.  proposal.decide(cp_1, accepted, decidedBy: USER_B)      # USER_B ≠ USER_A
        |     → status: 'accepted', decidedAt: day6
        |     → event: ChangeProposalAccepted
        |
Day 6   | 7.  revise(templateId: tpl_intake, basedOn: v_iv2, changeProposalId: cp_1)
        |     guard: cp_1 accepted & unconsumed; no lock on v_iv2
        |     → new WorkflowVersion{id: v_iv3, semver: '1.1.0-draft', changeProposalId: cp_1}
        |     → v_iv2 UNCHANGED (byte-identical: contentHash 'sha256:aa11…')
        |     → cp_1.consumedByVersionId = v_iv3
        |     → events: WorkflowVersionRevised, WorkflowDraftCreated, ChangeProposalConsumed
        |
Day 8   | 8.  publish(v_iv3)
        |     → WorkflowVersion{id: v_iv3, semver: '1.1.0', contentHash: 'sha256:bb22…'}
        |     → template.publishedVersionId = v_iv3; state stays 'published'
        |     → events: WorkflowPublished, WorkflowVersionMinted
        |
Day 10  | 9.  fork(fromVersionId: v_iv3, by: USER_C)
        |     guards: no scope:'global' lock on tpl_intake
        |     → NEW WorkflowTemplate{id: tpl_intake_eu, state: 'draft'}
        |       + WorkflowVersion{id: v_eu1, semver: '0.1.0-draft', graph: copy(G2+cp_1 ops)}
        |     → ForkLineage{childTemplateId: tpl_intake_eu, parentTemplateId: tpl_intake,
        |                    parentVersionId: v_iv3, forkedBy: USER_C, forkedAt: day10}
        |     → tpl_intake UNCHANGED, metrics for tpl_intake_eu = empty
        |     → events: WorkflowForked, ForkLineageRecorded, WorkflowDraftCreated
        |
Day 30  | 10. deprecate(tpl_intake, versionId: v_iv3)
        |     guard: template is 'published'
        |     → state: 'published' → 'deprecated'
        |     → NEW run.create on v_iv3 now fails with DEPRECATED_TEMPLATE
        |     → run_1 (day 3) keeps its pinned snapshot semantics — unaffected
        |     → event: WorkflowDeprecated
        |
Day 31  | 11. (lineage check) ancestors(tpl_intake_eu) → [tpl_intake]; forking from a deprecated
        |     source is still allowed, which is how a deprecated SOP is kept alive as a variant.
        |
Day 60  | 12. archive(tpl_intake)
        |     guards: state is 'deprecated'; NO in-flight run holds a lock on any version
        |     → state: 'deprecated' → 'archived'; archivedAt = day60; read-only forever
        |     → subsequent commands (publish/revise/fork-from/deprecate/archive) fail:
        |         ARCHIVED_READONLY (or ILLEGAL_TRANSITION for pure lifecycle edges)
        |     → WorkflowMetrics for v_iv2/v_iv3 remain queryable; audit retained
        |     → event: WorkflowArchived
        |
Day 60  | 13. run_2 (still in flight on v_iv1? impossible — v_iv1 is a draft, never runnable)
        |     A still-running run pinned to v_iv3 keeps running: archive of the TEMPLATE does not
        |     invalidate an existing RunSnapshot (CANONICAL_SPEC: snapshot pinning, ADR-0007).
        |     Its lock is released by the sweep when it reaches a terminal state.
```

**Walkthrough closure check:** 1 fork (`tpl_intake_eu`), 1 accepted change proposal (`cp_1`, consumed once), 2 published versions (`1.0.0`, `1.1.0`) both immutable, 1 deprecated→archived template that remains auditable, and zero mutation of any published record. All 10 lifecycle capabilities exercised: Draft (step 1) · Publish (3, 8) · Version (3, 7, 8) · Fork (9) · Deprecate (10) · Archive (12) · Run Snapshot (4, 13) · Template Lock (4) · Change Proposal (5–7) · Performance Metrics (implicitly rolled up after step 4 and step 8).
