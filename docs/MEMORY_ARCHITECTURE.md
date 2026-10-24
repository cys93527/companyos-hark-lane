> Source of truth: .planning/CANONICAL_SPEC.md (RECONSTRUCTED — diff against 规划书 before Sprint 1)

# CompanyOS V1.1 — Memory / Knowledge Substrate Architecture

| Field | Value |
|---|---|
| Document | MEMORY_ARCHITECTURE.md — scopes, promotion, records, retrieval ports, provenance, sensitivity, capacity |
| Owning context | **Memory** (`@companyos/core`, CANONICAL_SPEC §3.5) |
| Ports declared | `MemoryReader`, `MemoryWriter`, `EmbeddingProvider` — **interface only in Phase 0/1; no model calls** (CANONICAL_SPEC §4, §6; ADR-0011) |
| Related ADR | **ADR-0013** — vector-store deferral (in this document; cross-referenced from the ADR log in `docs/ARCHITECTURE_REVIEW.md` §8) |
| Tables | `memory_records`, `memory_records_fts`, `memory_promotions`, `artifacts` (`docs/STATE_MACHINE.md` §10) |

---

## 1. Purpose and principles

The memory substrate is what makes runs **accumulative** rather than stateless: a role's work references prior context, a run leaves behind episodic evidence, and the org accumulates semantic knowledge — all without ever calling a model in Phase 0/1.

| # | Principle | Consequence |
|---|---|---|
| M1 | **Scoped by lifetime, not by kind.** A record's value decays differently depending on scope; scope decides storage, TTL, and mutability. | `working` records expire; `semantic` records persist; the same content may be re-scoped as it is promoted |
| M2 | **Every claim is traceable.** | `provenance[]` is mandatory (≥ 1 entry); a record without provenance cannot be written |
| M3 | **Retrieval is deny-by-default by sensitivity.** | `MemoryReader.query()` filters by the caller's clearance and by `sensitivity`; nothing leaks by omission of a filter |
| M4 | **Promotion is a decision, not a side effect.** | `working → episodic → semantic` happens through explicit promotion rules with recorded actors |
| M5 | **No model in the loop for Phase 0/1.** | `EmbeddingProvider` is an interface with no implementation; retrieval is lexical (SQLite FTS5) |
| M6 | **Content-addressed, immutable content.** | `contentRef = sha256:<hex>` (same canonical hashing discipline as `contentHash`) |
| M7 | **Reads are cheap and bounded.** | Retrieval has an explicit result cap, a latency budget, and an index-first plan (NFR §9.1) |
| M8 | **Memory never mutates workflow state.** | The Memory context has no access to lifecycle commands (`docs/WORKFLOW_LIFECYCLE.md` INV-WF-08 analogue) |

---

## 2. Memory scopes

Five scopes. `working`, `episodic`, `semantic`, `artifact` are canonical (CANONICAL_SPEC §3.5). **`policy` is marked `[EXT]`** — it is mandated by the V1.1 architecture brief but is not listed in the canonical spec's Memory parenthesis; it is represented as a Governance-owned, Memory-exposed **read-only view** rather than a new store, so the canonical four scopes remain the only writable scopes.

| Scope | Purpose | Lifetime (default) | Storage | Mutability | Owner | Writable by |
|---|---|---|---|---|---|---|
| `working` | Scratch context for an in-flight run/node: intermediate reasoning notes, partial outputs, retrieved context handles | **TTL 24 h** or run terminal + 1 h, whichever is first | `memory_records` (+ `contentRef` into `artifacts` when > 8 KiB); optionally RAM-only cache for the current node | Mutable (append-heavy; overwrite allowed within the run) | Execution (the run) | `MemoryWriter`, run scope only |
| `episodic` | What happened in one run: decisions, node outputs, handoffs, failures — the evidence layer | **180 days** (aligned with run retention) | `memory_records`, content in `artifacts` | Immutable after the run reaches a terminal state | Execution → Memory | `MemoryWriter` on checkpoint/terminal |
| `semantic` | What the org has learned: stable, distilled knowledge (rules, procedures, facts) | **Indefinite** (until superseded or explicitly retired) | `memory_records` + `memory_records_fts` | Superseded, never edited in place (new record + `supersedes` link) | Memory (+ Governance for `restricted`) | `MemoryWriter` via promotion only |
| `artifact` | The content-addressed blob store referenced by `contentRef` (documents, JSON outputs, images, evidence bundles) | Lifetime of the referencing records; compaction for orphans | File store under `%APPDATA%\CompanyOS\artifacts/` + `artifacts` index table | Immutable (content-addressed; a change is a new hash) | Memory | `MemoryWriter` (via artifact store port) |
| `policy` `[EXT]` | Read-only projection of Governance's active policies and their human-readable summaries, surfaced through the Memory query API so roles can cite *why* something was refused | Bounded by the policy's own validity window | **No new store** — read-only view over Governance's `policies` table | **Read-only** | Governance | nobody (Memory does not write it) |

**Scope invariants**

| ID | Invariant |
|---|---|
| SMEM-01 | Only `working`, `episodic`, `semantic`, `artifact` are writable stores; `policy` is a read-only view. |
| SMEM-02 | `working` records are never the sole source of a `semantic` claim; promotion requires ≥ 1 `episodic` support. |
| SMEM-03 | A record's `scope` never changes in place: promotion creates a **new** record in the target scope with a `promotedFrom` link, and the source is marked `promoted` (or expired). |
| SMEM-04 | `episodic` and `semantic` records are immutable after write; corrections are new records with `supersedes`. |
| SMEM-05 | Every record has ≥ 1 `provenance` entry and a `sensitivity` level. |

---

## 3. Memory record schema

```ts
/**
 * MemoryRecord — the single persisted shape for every memory scope.
 * Owning context: Memory. Persisted in `memory_records`; large content lives in the artifact store.
 * See docs/MEMORY_ARCHITECTURE.md §2 (scopes), §5 (provenance), §6 (sensitivity).
 */
export type MemoryScope = 'working' | 'episodic' | 'semantic' | 'artifact';
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

export interface MemoryRecord {
  /** ULID from the IdFactory port. Globally unique, sortable. */
  readonly id: string;

  /** Lifetime scope (§2). Promotion creates a NEW record in the target scope (SMEM-03). */
  readonly scope: MemoryScope;

  /** Owning org. Retrieval is always scoped to the caller's org (no cross-org reads in V1.1). */
  readonly orgId: string;

  /** Present for `working` and `episodic`; absent for distilled `semantic` knowledge. */
  readonly runId?: string;

  /** Content-addressed pointer: `sha256:<64 hex>`. For small content this may be a data: URI-like
   *  inline hash reference; binary and > 8 KiB content MUST live in the artifact store (§9). */
  readonly contentRef: string;

  /** Human- and retrieval-facing summary. Used for FTS5 indexing and for UI lists.
   *  MUST NOT contain secrets and MUST NOT be the only locator of the content. */
  readonly summary: string;

  /** Optional embedding pointer. ALWAYS null in Phase 0/1 (no model calls — ADR-0013). */
  readonly embeddingRef?: string | null;

  /** Mandatory evidence chain, ≥ 1 entry (§5). A record without provenance is rejected at write. */
  readonly provenance: readonly ProvenanceEntry[];

  /** 0..1 confidence in the record's content. Deterministic derivations are 1.0;
   *  human-authored notes default to 0.8; promotion requires ≥ the scope's threshold (§4). */
  readonly confidence: number;

  /** Classification (§6). Retrieval is deny-by-default above the caller's clearance. */
  readonly sensitivity: Sensitivity;

  /** ISO-8601 from the Clock port. */
  readonly createdAt: string;

  /** Optional expiry instant. `working` always has one; `semantic` normally does not. */
  readonly ttl?: string | null;

  // ---- promotion/supersession metadata (nullable; not part of the logical key) ----
  /** Set when this record was created by promoting another record (SMEM-03). */
  readonly promotedFrom?: string | null;
  /** The promotion decision that created this record (audited, with an actor). */
  readonly promotionId?: string | null;
  /** Semantic supersession link: this record replaces the referenced older record. */
  readonly supersedes?: string | null;
  /** Set when a record has been retired (`expired` | `superseded` | `promoted`). */
  readonly retiredReason?: 'expired' | 'superseded' | 'promoted' | 'compacted' | null;
  /** Namespace for pack-owned memory (§7 retrieval scoping). */
  readonly namespace?: string | null;
}

export interface ProvenanceEntry {
  /** What kind of evidence this is. */
  readonly kind: 'run_output' | 'node_execution' | 'handoff' | 'human_note' | 'external_doc' | 'policy' | 'derivation';
  /** Stable reference into the evidence (node execution id, handoff envelope id, artifact contentRef, …). */
  readonly ref: string;
  /** Correlating run, when the evidence came from a run. */
  readonly runId?: string;
  /** Emitting role for human/agent-authored evidence — pack/org declared, never a Core title. */
  readonly actorRole?: string;
  /** ISO-8601 instant the evidence was produced. */
  readonly occurredAt: string;
  /** Integrity of the cited evidence, so a citation can be verified later. */
  readonly contentHash?: string;
  /** Citation rendering hint, used by the UI and by `WorkProduct` footnotes. */
  readonly citationLabel?: string;
}

/** Persistence contract notes (see docs/STATE_MACHINE.md §10 for the SQL form):
 *   memory_records(id PK, scope, org_id, run_id NULL, content_ref, summary, embedding_ref NULL,
 *                  provenance_json, confidence, sensitivity, created_at, ttl_at NULL,
 *                  promoted_from NULL, promotion_id NULL, supersedes NULL, retired_reason NULL,
 *                  namespace NULL)
 *   memory_records_fts(summary, content_text)           -- FTS5 virtual table, §9
 *   memory_promotions(id PK, from_record_id, to_record_id, rule_id, actor, decided_at, rationale)
 *   artifacts(content_ref PK, media_type, bytes, sensitivity, created_at, last_referenced_at)
 */
```

### 3.1 Write-time validation

| Check | Failure |
|---|---|
| `provenance.length ≥ 1` | `VALIDATION_FAILED` (`memory.provenance.required`) |
| `provenance[].ref` resolvable for `kind ∈ {run_output, node_execution, handoff}` | `VALIDATION_FAILED` (dangling citation) |
| `confidence ∈ [0,1]` | `VALIDATION_FAILED` |
| `scope ∈ {working, episodic, semantic, artifact}` | `VALIDATION_FAILED` (never `policy` — SMEM-01) |
| `sensitivity` present and ≥ the strongest sensitivity of its provenance | `SENSITIVITY_ESCALATION_REQUIRED` |
| `summary` matches the redaction allow-list scan (no secret patterns) | `VALIDATION_FAILED` + security event |
| content > 8 KiB must be referenced, not inlined | `VALIDATION_FAILED` |

---

## 4. Retention and promotion

### 4.1 Retention rules

| Scope | Retention | Deletion path | Notes |
|---|---|---|---|
| `working` | TTL **24 h** or run-terminal + **1 h** | Expiry sweeper sets `retiredReason='expired'`; content released for compaction | Never referenced by audit |
| `episodic` | **180 days** (aligned with run/node retention — `docs/WORKFLOW_LIFECYCLE.md` §9.3) | Purged after the run's retention window closes; the run row purge and the episodic purge are the same job | Promoted records survive via their `semantic` copies |
| `semantic` | **Indefinite** | Retired only by `supersede` (a new record) or an explicit human `retire` with a reason | Never auto-deleted; retiring is audited |
| `artifact` | Lifetime of referencing records | Compaction: unreferenced (`last_referenced_at` older than 180 days) artifacts are collected | Content-addressed ⇒ safe to delete when unreferenced |
| `policy` `[EXT]` | Owned by Governance's policy validity window | n/a (read-only view) | Memory never deletes policy rows |

Retention mechanics:

1. Retention is enforced by a **single maintenance job** (idempotent, resumable, logged with counts).
2. Deletion is **soft first**: `retiredReason` is stamped, then content is released; hard deletion happens only in the compaction pass so that an interrupted job is recoverable.
3. Purging a record never breaks a citation: `WorkProduct` citations that point at purged episodic records resolve to a **tombstone** (`{status:'purged', purgedAt}`) rather than a broken link.
4. Anything referenced by the hash-chained audit log is exempt from purge.

### 4.2 Promotion rules

```text
PROMOTION LADDER

  working ──(run checkpoint / run terminal)──► episodic ──(consolidation)──► semantic

  R-W→E  working → episodic
    Trigger : checkpoint written, or run reached a terminal state
    Guards  : confidence ≥ 0.6
              provenance complete (every entry resolvable)
              content still exists (not already compacted)
              sensitivity ≤ the run's declared max sensitivity
    Effect  : NEW episodic record (scope='episodic', runId set, promotedFrom=<working id>)
              source working record marked retiredReason='promoted'
    Actor   : the run engine (recorded in memory_promotions.actor = run:<runId>)
    Idempotent: promotion key = (workingRecordId, ruleId='R-W→E') — re-running is a no-op

  R-E→S  episodic → semantic
    Trigger : scheduled consolidation (daily) OR an explicit human "promote" action
    Guards  : SUPPORT   ≥ 3 distinct episodic records (distinct runIds) agree on the claim
              AGREEMENT: no contradicted claim among the latest 5 candidate records
              STABILITY: oldest supporting record ≥ 7 days old
              DEDUPE   : no existing semantic record with the same normalized claim + namespace
              CLEARANCE: if sensitivity ≥ 'confidential', a human decision is REQUIRED
                         (no automatic promotion of confidential knowledge — deny-by-default)
    Effect  : NEW semantic record with provenance = the supporting episodic records
                       + a 'derivation' provenance entry citing the consolidation run
              supporting episodic records marked retiredReason='promoted' (retained until 180 d)
    Actor   : consolidation job (actor = job:consolidate) or human (actor = user:<id>)
    Idempotent: promotion key = (claimFingerprint, ruleId='R-E→S', namespace)

  CONTRADICTION HANDLING
    Two candidate semantic claims contradict ⇒ neither is promoted; a ChangeProposal-style
    review item is opened in Governance ("semantic conflict"), citing both evidence sets.
    The org never silently keeps both.
```

### 4.3 Promotion record

Every promotion writes a `memory_promotions` row: `{id, fromRecordId[], toRecordId, ruleId, actor, decidedAt, rationale, evidenceCount, supportCount}` and emits `MemoryPromoted`. Promotions are auditable decisions, not background magic (principle M4).

### 4.4 Demotion and retirement

| Action | Legal? | Notes |
|---|---|---|
| `semantic → episodic` demotion | ❌ | Not supported. Correct a bad semantic record by superseding it with better evidence. |
| Retire a `semantic` record | ✅ (human, with reason) | Sets `retiredReason='superseded'` or explicit retire; audited |
| Expire a `working` record early | ✅ (run engine) | On explicit node-level "discard context" |
| Purge an `episodic` record before retention | ❌ | Retention is the only deletion path (except a legal/privacy erasure request, which is a Governance action, audited) |

---

## 5. Provenance and citation requirements

**Rule C-1 — no orphan knowledge.** A `MemoryRecord` without `provenance[]` is rejected at write (SMEM-05). There is no "general knowledge" bucket: if the org knows it, the org can say where it came from.

**Rule C-2 — citations flow into work products.** Any `WorkProduct` derived from retrieved memory must carry citations:

```ts
export interface WorkProductCitation {
  readonly memoryRecordId: string;
  readonly contentRef: string;      // so the cited evidence itself is verifiable
  readonly contentHash: string;     // integrity of the citation target
  readonly scope: 'episodic' | 'semantic';
  readonly citationLabel: string;   // human-readable, e.g. "run 01JG7P… / node n_plan"
  readonly sensitivity: Sensitivity;
}
```

**Rule C-3 — derived content inherits the maximum sensitivity.** A record derived from evidence at `confidential` is at least `confidential`. Declassification (lowering sensitivity) requires an explicit, audited Governance decision — never an implicit effect of summarization (this is the "summarization must not launder secrets" rule).

**Rule C-4 — citation resolution is verified.** When a work product cites a `contentRef`, the hash is verified on read; tampering ⇒ `HASH_MISMATCH` (raised by the `WorkflowVersionState`/memory integrity oracle) and the citation is displayed as **unverified**, never silently accepted.

**Rule C-5 — provenance survives compaction.** A purged evidence record leaves a tombstone with its `contentHash` so a citation remains checkable as "the artifact existed and had this hash", even after the content itself is gone.

**Rule C-6 — no provenance laundering through promotion.** A `semantic` record's provenance includes the *original* episodic evidence, not only the consolidation job. Promotion adds evidence; it never replaces it.

---

## 6. Sensitivity levels and the security model

| Level | Meaning | Typical content | Retrieval rule | Log/telemetry rule |
|---|---|---|---|---|
| `public` | Safe to include outside the org context | Published procedures, public docs | Readable by any role in the org | May appear in logs (still redacted for secrets) |
| `internal` | Default for org work | Run outputs, internal notes | Readable by any authenticated org role | Ids and summaries only |
| `confidential` | Commercially sensitive or personal | Client briefs, cost data, performance reviews | Requires an explicit `AuthorityGrant` with clearance `confidential`; **deny-by-default** | Never logged in content form; only `recordId` + `contentRef` |
| `restricted` | Highest | Credentials-adjacent material, legal holds, security findings | Requires clearance `restricted` **and** a policy decision per access (not a blanket grant) | Never logged; access is itself an audited event |

### 6.1 Interaction with the security model (`docs/SECURITY_MODEL.md`)

| Interaction | Rule |
|---|---|
| Retrieval filter | `MemoryReader.query()` always applies `sensitivity ≤ caller.clearance` **and** org scoping. A caller cannot disable the filter; there is no "admin bypass" flag in the API. |
| Clearance source | `AuthorityGrant` (Org context), evaluated by Governance (deny-by-default). |
| Derived records | Inherit the maximum sensitivity of their provenance (C-3). |
| Cross-org | Impossible in V1.1: `orgId` is mandatory and query scoping is enforced in the store layer, not the caller. |
| Secret material | **Never** a memory record. Secrets live in the OS keychain via `SecretResolver`; memory may hold a *handle* only (§9 of `docs/SECURITY_MODEL.md`). |
| At rest | Phase 0/1: SQLite file on disk, OS-level protection only. Encryption roadmap (SQLCipher / selective field encryption) is tracked in `docs/SECURITY_MODEL.md` §9; `restricted` records are flagged for priority encryption. |
| Export/backup | Sensitivity travels with the record; a backup containing `restricted` records must be encrypted (`docs/SECURITY_MODEL.md` §9.4). |
| Audit | Writes, promotions, retirements, and every `restricted` read are audited (append-only, hash-chained). |
| Handoff artifacts | An artifact's sensitivity gates retrieval independently of the envelope (`docs/HANDOFF_PROTOCOL.md` §9). |
| Model egress (P2+) | Any future model call must declare the maximum sensitivity it will transmit, and a `restricted` record may never be sent to an external provider without an explicit policy that is audited per call. |

### 6.2 Sensitivity escalation errors

| Situation | Code |
|---|---|
| Caller lacks clearance | `SENSITIVITY_DENIED` (returned as an empty result set plus an audit entry, **not** as a distinguishable "exists but denied" signal — existence is itself information) |
| Derived record weaker than its provenance | `SENSITIVITY_ESCALATION_REQUIRED` |
| Policy denies a `restricted` read | `POLICY_DENIED` |

---

## 7. Retrieval ports (Phase 0/1: interfaces only)

```ts
/**
 * Memory retrieval ports. Declared in @companyos/core; implemented by adapters.
 * PHASE 0/1: interfaces only. NO model calls, NO EmbeddingProvider implementation,
 * NO network access anywhere on these paths (CANONICAL_SPEC §4, §6; ADR-0011, ADR-0013).
 */

export interface MemoryQuery {
  readonly orgId: string;
  readonly scopes: readonly MemoryScope[];          // 'policy' may be included (read-only view)
  readonly runId?: string;                          // present ⇒ run-scoped reads
  readonly namespace?: string;
  /** Lexical query for SQLite FTS5 (Phase 0/1). Never a vector query in V1.1. */
  readonly text?: string;
  readonly since?: string;
  readonly until?: string;
  readonly sensitivityAtMost: Sensitivity;          // MUST be ≤ caller clearance; validated, not trusted
  readonly minConfidence?: number;
  readonly limit: number;                           // REQUIRED, capped at MAX_RESULTS
  readonly cursor?: string;                         // opaque, stable pagination
}

export interface MemoryReader {
  /** Retrieval. Applies org scoping + sensitivity filter unconditionally (M3, §6.1). */
  query(q: MemoryQuery): Promise<Result<MemoryQueryResult, MemoryError>>;
  /** Exact read by id; still subject to sensitivity and org scoping. */
  get(recordId: string, ctx: MemoryCallContext): Promise<Result<MemoryRecord | null, MemoryError>>;
  /** Resolve a contentRef to a stream/bytes; verifies integrity (C-4). */
  openContent(contentRef: string, ctx: MemoryCallContext): Promise<Result<ContentHandle, MemoryError>>;
  /** Citations for a work product; returns tombstones for purged evidence (C-5). */
  citationsFor(subjectRef: string, ctx: MemoryCallContext): Promise<Result<readonly WorkProductCitation[], MemoryError>>;
}

export interface MemoryWriter {
  /** Write a record. Enforces SMEM-05, provenance validity, and the write-time checks in §3.1. */
  write(record: Omit<MemoryRecord, 'id' | 'createdAt'>, ctx: MemoryCallContext): Promise<Result<MemoryRecord, MemoryError>>;
  /** Record a promotion decision (R-W→E / R-E→S). Audited; idempotent by promotion key. */
  promote(input: PromotionRequest, ctx: MemoryCallContext): Promise<Result<PromotionOutcome, MemoryError>>;
  /** Retire/expire a record (soft retire; compaction is a separate job). */
  retire(recordId: string, reason: MemoryRecord['retiredReason'], ctx: MemoryCallContext): Promise<Result<void, MemoryError>>;
  /** Persist content into the artifact store, returning its content-addressed ref. */
  putContent(handle: ContentSource, sensitivity: Sensitivity, ctx: MemoryCallContext): Promise<Result<string, MemoryError>>;
}

/**
 * EmbeddingProvider — INTERFACE ONLY in Phase 0/1.
 * There is no implementation in this repo; `EmbeddingProvider` must not be constructed
 * anywhere before P2, and no code path may call it as part of Phase 0/1 verification.
 */
export interface EmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly dimensions: number;
  /** Contract for P2 implementations: deterministic for a given (modelId, input). */
  embed(inputs: readonly string[], opts?: { readonly signal?: AbortSignal }): Promise<Result<readonly number[][], MemoryError>>;
}

export interface MemoryCallContext {
  readonly orgId: string;
  readonly runId?: string;
  readonly actor: { readonly kind: 'run' | 'job' | 'user'; readonly id: string; readonly roleKey?: string };
  readonly clearance: Sensitivity;                  // from AuthorityGrant, resolved by Governance
  readonly traceId: string;
}

export interface MemoryQueryResult {
  readonly records: readonly MemoryRecord[];
  readonly nextCursor?: string;
  readonly truncated: boolean;                      // true when `limit` was hit
  readonly deniedCount: number;                     // count of filtered-out records (no metadata leaked)
  readonly tookMs: number;
}
```

### 7.1 Port rules

| Rule | Detail |
|---|---|
| Phase discipline | `EmbeddingProvider` has **no implementation** until P2; adding one is a scope violation of CANONICAL_SPEC §6 and fails review. |
| Deny-by-default | Filters are applied **inside** the implementation, not by the caller; a caller passing an over-broad `sensitivityAtMost` is validated against its clearance and clamped. |
| Bounded | `limit` is required and capped (`MAX_RESULTS = 200`); there is no unbounded query. |
| Deterministic | Ordering is `(score desc, createdAt desc, id asc)` — stable across runs so tests and paging are reproducible. |
| Integrity | `openContent` verifies `sha256` against the ref; mismatch ⇒ `HASH_MISMATCH`. |
| Audited | `restricted` reads, all writes, and all promotions append audit entries. |
| No I/O in Core | Ports are defined in Core; the implementation lives in `@companyos/persistence`. |

---

## 8. Capacity and compaction policy

| Resource | Budget | Control |
|---|---|---|
| `memory_records` rows | ≤ 2 M rows steady state | Retention (§4.1) + promotion (episodic → compact semantic retains the claim, not every run) |
| `summary` text indexed by FTS5 | ≤ 4 KiB per record | `summary` is a summary by contract; long content goes to `contentRef` |
| FTS5 index size | ≤ 25% of `memory_records` payload | Periodic `INSERT INTO memory_records_fts(memory_records_fts) VALUES('optimize')` |
| FTS5 query latency | ≤ 40 ms p95 for 1 M records | Index-first plan; `limit` capped; `query` must never scan content blobs |
| Artifact store | ≤ 10 GB steady state, 20 GB hard warning | Compaction of unreferenced artifacts (> 180 days, `last_referenced_at`) |
| Orphan artifacts | 0 after compaction | A weekly job: build the referenced-contentRef set from `memory_records.provenance_json` + `handoff artifacts` + `work_product` citations; delete unreferenced blobs older than 180 days; log counts |
| Working-memory growth during a long run | ≤ 20 MB per run in RAM | Spill to `contentRef` once > 8 KiB; TTL sweep |
| DB vacuum | after any purge > 10% of file size | Explicit maintenance action; WAL checkpoint on quit |

### 8.1 Compaction passes

| Pass | Frequency | Action |
|---|---|---|
| P1 expiry sweep | every 15 min | Mark `working` records past TTL as `expired` (soft) |
| P2 retention purge | daily | Purge `episodic` records past 180 days whose run is already purged; soft → hard |
| P3 artifact compaction | weekly | Collect unreferenced artifact blobs; update `artifacts` index; report bytes reclaimed |
| P4 FTS optimize | weekly | Rebuild/optimize the FTS5 index; verify index row count == record count (drift is an integrity finding) |
| P5 dedupe audit | weekly | Detect duplicate `contentRef` rows with identical hashes; merge index rows (content is already deduplicated by addressing) |
| P6 integrity sweep | weekly | Re-verify a sampled 5% of `contentRef` hashes; any mismatch is a security event (`HASH_MISMATCH`) |

All passes are **idempotent**, resumable, and log `{pass, scanned, affected, bytesReclaimed, durationMs}` with a `traceId`.

---

## 9. Retrieval technology: SQLite FTS5 first, vectors later

### ADR-0013 — Vector store deferral: SQLite FTS5 in V1.1, embeddings from P2

- **Status:** Accepted (owned by this document; cross-referenced in the ADR log of `docs/ARCHITECTURE_REVIEW.md` §8).
- **Context:** Memory retrieval must work in Phase 0/1, which is explicitly **local-first and free of model calls**: `EmbeddingProvider` is interface-only and `ModelGateway` has no implementation (CANONICAL_SPEC §4, §6). Phase 0/1 also forbids adding a vector database dependency (native build step, index files, background daemons) and Core's dependency budget is near-zero (ADR-0011). Yet retrieval quality on real org memory needs more than `LIKE '%term%'`.
- **Decision:** Use **SQLite FTS5** (already inside `node:sqlite`, no new dependency, no native step) as the retrieval engine for Phase 0/1:
  - `memory_records_fts(summary, content_text)` — external-content FTS5 table over `memory_records`.
  - Ranking via FTS5 `bm25()`; ordering `(bm25, createdAt desc, id asc)`.
  - Query parsing restricted to a **safe subset** (terms, phrases, `AND/OR/NOT`, prefix `*`); raw FTS5 syntax from untrusted input is sanitized to avoid malformed-MATCH errors and query amplification.
  - `MemoryRecord.embeddingRef` exists in the schema from day one and is `NULL` in V1.1, so no migration is needed to start writing embeddings later.
  - A **vector index** (plausible options: `sqlite-vec`, a FAISS/HNSW sidecar, or a hosted index) is evaluated in **P2**, behind the same `MemoryReader.query()` contract.
- **Consequences:**
  - (+) Zero new dependencies, zero native build, works offline, one file to back up, retrieval latency is predictable (`≤ 40 ms p95` budget).
  - (+) The `MemoryReader`/`MemoryWriter` port contract is vector-agnostic: adding vectors is an adapter change plus an embedding backfill job, not a domain change.
  - (+) The vector decision is deferred *with evidence*: P2 can measure lexical recall on real data before committing to an index type and an embedding model.
  - (−) Lexical-only recall will miss semantic paraphrases ("slow build" vs. "long compile"): accepted for Phase 0/1, because Phase 0/1 has no model-call capability at all — a vector index without embeddings would be dead weight.
  - (−) FTS5 query syntax could be abused by untrusted input: mitigated by sanitization and a strict term cap (≤ 12 terms, query length ≤ 512 chars).
  - (−) Two retrieval paths will eventually coexist: migration plan is hybrid retrieval (FTS5 ∪ vector, re-ranked by a deterministic scorer) behind the unchanged port; the hybrid scorer must be deterministic in tests (no model call in the ranking step for CI).

---

## 10. Test plan

All tests are Vitest, deterministic (fake `Clock`, seeded `IdFactory`), offline, with **no `EmbeddingProvider` implementation** and no model access (Phase 0/1 constraint).

| # | Test | Type | Asserts |
|---|---|---|---|
| M-01 | `memory.record.schema.spec.ts` | unit | The TS type and the persistence mapping agree; a record round-trips with all optional fields null |
| M-02 | `memory.provenance.required.spec.ts` | unit | A record with zero provenance entries is rejected with `VALIDATION_FAILED` |
| M-03 | `memory.provenance.dangling.spec.ts` | unit | Providing an unresolvable `run_output` ref is rejected; a resolution race is retried once then rejected |
| M-04 | `memory.scope.policy.readonly.spec.ts` | unit | `policy` is queryable but never writable; a write attempt with `scope='policy'` is refused |
| M-05 | `memory.working.ttl.spec.ts` | integration | A `working` record expires exactly at TTL; an expired record is invisible to `query` |
| M-06 | `memory.promotion.working_to_episodic.spec.ts` | integration | Checkpoint promotion creates a new episodic record, sets `promotedFrom`, retires the source, and is idempotent by promotion key |
| M-07 | `memory.promotion.confidence.guard.spec.ts` | unit | `confidence < 0.6` blocks R-W→E; `confidence < 0.9` blocks an automatic R-E→S claim requiring high stability |
| M-08 | `memory.promotion.support_threshold.spec.ts` | integration | R-E→S requires ≥ 3 distinct-run supports; 2 supports ⇒ no promotion; the decision is recorded as `not_promoted` with a reason |
| M-09 | `memory.promotion.contradiction.spec.ts` | integration | Two contradicting claims produce neither promotion and exactly one Governance review item |
| M-10 | `memory.promotion.confidential.requires_human.spec.ts` | integration | A `confidential` semantic promotion without a human decision does not occur |
| M-11 | `memory.promotion.provenance.preserved.spec.ts` | integration | A promoted semantic record's provenance includes the original episodic evidence (C-6) |
| M-12 | `memory.sensitivity.deny_by_default.spec.ts` | integration | A caller with `internal` clearance receives no `confidential` record and gets an indistinguishable empty result plus an audit entry |
| M-13 | `memory.sensitivity.clamp.spec.ts` | unit | An over-broad `sensitivityAtMost` is clamped to the caller's clearance, not trusted |
| M-14 | `memory.sensitivity.derivation.escalation.spec.ts` | unit | A record derived from `confidential` provenance cannot be written as `internal` (`SENSITIVITY_ESCALATION_REQUIRED`) |
| M-15 | `memory.org.isolation.spec.ts` | integration | A query for org B from an org A context returns zero records; `orgId` scoping is enforced in the store layer |
| M-16 | `memory.content.integrity.spec.ts` | integration | A tampered artifact fails `sha256` verification on `openContent` with `HASH_MISMATCH` |
| M-17 | `memory.citation.roundtrip.spec.ts` | integration | A work product's citations resolve, verify, and render labels; a purged target renders a tombstone (C-5) |
| M-18 | `memory.fts.query.sanitization.spec.ts` | unit | Malicious FTS5 syntax does not throw an unhandled error; inputs are sanitized; term and length caps enforced |
| M-19 | `memory.fts.ranking.determinism.spec.ts` | integration | Identical corpora produce identical ordering across runs and platforms |
| M-20 | `memory.retention.episodic.spec.ts` | integration | Episodic records survive 180 days and purge with their run; citations become tombstones, not broken refs |
| M-21 | `memory.compaction.orphans.spec.ts` | integration | P3 removes exactly the unreferenced blobs; referenced blobs are never collected |
| M-22 | `memory.compaction.idempotent.spec.ts` | integration | Running every compaction pass twice changes nothing (counts and bytes identical) |
| M-23 | `memory.embedding.absent.spec.ts` | unit | No implementation of `EmbeddingProvider` exists; a source scan asserts no construction site anywhere in the repo |
| M-24 | `memory.perf.query.spec.ts` | bench | FTS5 query p95 ≤ 40 ms at 1 M records; `limit` cap respected; no content-blob scan |
| M-25 | `memory.secrets.absent.spec.ts` | security | A record whose `summary` contains a seeded secret pattern is rejected at write; no secret reaches a log sink or the FTS index |
| M-26 | `memory.redaction.logs.spec.ts` | security | `confidential`/`restricted` content never appears in log output (only ids and refs) |
| M-27 | `memory.no_workflow_mutation.spec.ts` | architecture | The Memory context has no import path to lifecycle commands (boundary-style test) |
| M-28 | `memory.backup.restore.spec.ts` | integration | A copied `companyos.db` + `artifacts/` restores to an identical query surface |

**Phase 1 memory exit criteria:** M-01…M-28 green; promotion audited and idempotent; sensitivity filter proven deny-by-default; FTS5 in place with no vector dependency; `EmbeddingProvider` present as an interface with zero implementations (M-23 enforces this mechanically).

---

## Sprint 13 Provenance Sources (Task-13-08)

- **ARTIFACT provenance** = durable Artifact **identity** reference
  (`artifact:art_<id>`, the ADR-0017 canonical form). The verifier confirms the row
  exists in the artifact chain; it never reads CAS/content and never copies bytes into
  Memory. A null store (chain not wired in a composition root) fails closed.
- **VALIDATION provenance** = durable Validation **identity** reference (the bare
  branded `val_<id>`). Any status (pass/fail/error/skipped) and legacy untargeted rows
  (`targetRef=null`) remain valid provenance — citing an evidence record is not a gate
  verdict (the evidence gate belongs to Task-13-07 / ADR-0020).
- Memory does **not own or copy** Artifacts or Validations; their lifecycle stays with
  the Artifact subsystem / durable evidence layer.
- Scope note: the Sprint 12 verifier contract passes `{ sourceType, sourceRefs,
  companyId }` only — there is no run anchor, and neither Artifact nor Validation
  carries a companyId, so no run/company cross-check is performable without extending
  that contract (out of Sprint 13 scope).
