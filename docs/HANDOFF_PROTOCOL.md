> Source of truth: .planning/CANONICAL_SPEC.md (RECONSTRUCTED — diff against 规划书 before Sprint 1)

# CompanyOS V1.1 — Inter-Agent / Inter-Role Handoff Protocol

| Field | Value |
|---|---|
| Document | HANDOFF_PROTOCOL.md — HandoffEnvelope contract, delivery semantics, DLQ, HITL gates |
| Owning context | **Execution** (`Handoff` aggregate; CANONICAL_SPEC §3.4) |
| Ports involved | `EventBus`, `EntityStore<Handoff>`, `Clock`, `IdFactory`, `AgentRuntime` (interface only), `ModelGateway` (interface only) |
| Machine | `HandoffState` (`docs/STATE_MACHINE.md` §6) |
| Implementation sprint | **Sprint 5** (P1). Contracts fixed in Sprint 0/1; no implementation in Sprint 0 (CANONICAL_SPEC §6). |

---

## 1. Goals

| # | Goal | How the protocol achieves it |
|---|---|---|
| G1 | **Every unit of inter-role work is an explicit, persisted, auditable artefact.** | A handoff is a row (`handoffs`) + envelope, not an in-memory call. |
| G2 | **Exactly-once effect, at-least-once delivery.** | Outbox + dedupe table keyed by `idempotencyKey`, applied in one transaction (SM-H-01/SM-H-03). |
| G3 | **Crash-safe.** A crash mid-handoff never loses or duplicates work. | Envelope and the producing node's state change share one transaction; dispatch is a post-commit outbox drain. |
| G4 | **Bounded and observable.** Every handoff has a deadline, a budget, and a retry policy. | `deadline`, `budget`, `attempt`, plus `HandoffState` transitions with timers. |
| G5 | **Human-in-the-loop is a first-class handoff, not a special case.** | Approval gates are handoffs with `intent: 'approval'` and a single-use decision token. |
| G6 | **Framework-agnostic.** Works with no agent framework (ADR-0011) and with P2 runtimes. | The envelope is plain data (zod-validated JSON); the transport is a port. |
| G7 | **Reproducible under replay.** A replayed run produces the same handoff sequence. | Deterministic backoff from an injected RNG; ordering by allocated `seq`. |
| G8 | **Contract-versioned.** Envelope schema evolution never breaks a persisted envelope. | `contractVersion` on every envelope + upcasters on read. |

**Non-goals:** distributed consensus, multi-machine delivery, bidirectional streaming, and cross-org federation. V1.1 is local-first single-user (ADR-0012); the transport is in-process (main process ↔ worker pool), and the protocol is designed so a future networked transport is an adapter swap.

---

## 2. `HandoffEnvelope` schema

Canonical TypeScript definition. This is the wire/persistence contract; the zod schema in `@companyos/contracts` is generated to match it exactly, and a test asserts the two agree.

```ts
/**
 * HandoffEnvelope — the only payload shape that crosses a role boundary.
 * Owning context: Execution. See docs/HANDOFF_PROTOCOL.md and docs/STATE_MACHINE.md §6.
 *
 * Invariants:
 *  - envelopeId / traceId / runId are ULIDs (IdFactory port); envelopeId is globally unique.
 *  - idempotencyKey is unique per (runId, fromRole, toRole, intent) — unique index uq_handoffs_idem.
 *  - The canonical serialization for `signature` EXCLUDES the `signature` field itself.
 *  - contractVersion is required and never inferred.
 */
export interface HandoffEnvelope {
  /** Stable identity of this handoff attempt-envelope. ULID. */
  readonly envelopeId: string;

  /** Correlation id shared by every event, log line, and artifact of one end-to-end flow. */
  readonly traceId: string;

  /** The run this handoff belongs to. A handoff never outlives its run (SM-H-05). */
  readonly runId: string;

  /** Emitting role. A pack-declared RoleArchetype key or an org WorkRole id — never a Core title. */
  readonly fromRole: string;

  /** Receiving role. Must hold authority for the declared `intent` (deny-by-default). */
  readonly toRole: string;

  /** What is being asked. Namespaced: `<domain>.<verb>` e.g. 'work.review', 'work.approve', 'work.produce'. */
  readonly intent: string;

  /** Small structured input. Inline JSON ONLY up to INLINE_PAYLOAD_LIMIT (§9). */
  readonly payload: Readonly<Record<string, unknown>>;

  /** Large/immutable outputs: references into the artifact store, never raw blobs. */
  readonly artifacts: readonly HandoffArtifactRef[];

  /** Hard constraints the receiver must honour (see HandoffConstraints). */
  readonly constraints: HandoffConstraints;

  /** ISO-8601 instant from the injected Clock port. Expiry ⇒ HandoffState.expired. */
  readonly deadline: string;

  /** Spend envelope for the receiving side; overspend is refused, not truncated. */
  readonly budget: HandoffBudget;

  /** Exactly-once key. Unique per (runId, fromRole, toRole, intent). */
  readonly idempotencyKey: string;

  /** 1-based delivery attempt. Increments only on a transition INTO `dispatched`. */
  readonly attempt: number;

  /** ISO-8601 instant the envelope was created (Clock port, never Date.now()). */
  readonly createdAt: string;

  /** Integrity/authenticity over the canonical serialization minus this field. */
  readonly signature: HandoffSignature;

  /** Schema version of THIS envelope. Required; unknown major ⇒ dead-letter, never guess. */
  readonly contractVersion: 1;
}

export interface HandoffArtifactRef {
  /** Content-addressed reference: `sha256:<64 hex>` (same canonical hashing discipline as contentHash). */
  readonly contentRef: string;
  readonly mediaType: string;      // IANA type, e.g. 'application/json', 'text/markdown'
  readonly bytes: number;
  /** Human-readable purpose, shown in the audit trail. */
  readonly role: string;           // e.g. 'input', 'reference', 'evidence', 'output'
  /** Sensitivity inherited by the artifact; retrieval is deny-by-default above clearance. */
  readonly sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
}

export interface HandoffConstraints {
  /** May the receiver delegate further? Depth-bounded to prevent handoff storms. */
  readonly maxHops: number;                 // default 3; a hop beyond the bound is dead-lettered
  /** Must the receiver produce an artifact, or is an acknowledgement enough? */
  readonly requiresArtifact: boolean;
  /** Permitted side effects for the receiver's capability sandbox. */
  readonly allowedEffects: readonly ('read_memory' | 'write_memory' | 'produce_artifact' | 'call_model')[];
  /** If true, the receiver must not proceed without a human decision (HITL gate, §8). */
  readonly humanApprovalRequired: boolean;
  /** Guard expression evaluated against the receiver's inputs before work starts. */
  readonly precondition?: string;            // e.g. "payload.briefRef != null"
}

export interface HandoffBudget {
  /** Wall-clock ms the receiver may consume. Exceeding it ⇒ nack('BUDGET_EXCEEDED'). */
  readonly maxWallClockMs: number;
  /** Model token budget; 0 in Phase 0/1 (no model calls — ADR-0011). */
  readonly maxTokens: number;
  /** USD ceiling; 0 in Phase 0/1. */
  readonly maxCostUsd: number;
}

export interface HandoffSignature {
  readonly algo: 'sha256';
  /** hex digest over canonicalSerialize(envelope minus signature). */
  readonly digest: string;
  /** Key id from SecretResolver; 'local-dev' only in Phase 0/1. */
  readonly keyId: string;
}
```

### 2.1 Example envelope (canonical JSON, sorted keys)

```jsonc
{
  "artifacts": [
    { "bytes": 41233, "contentRef": "sha256:9a1f…c7", "mediaType": "application/json",
      "role": "input", "sensitivity": "internal" }
  ],
  "attempt": 1,
  "budget": { "maxCostUsd": 0, "maxTokens": 0, "maxWallClockMs": 600000 },
  "constraints": {
    "allowedEffects": ["read_memory", "produce_artifact"],
    "humanApprovalRequired": false,
    "maxHops": 3,
    "precondition": "payload.briefRef != null",
    "requiresArtifact": true
  },
  "contractVersion": 1,
  "createdAt": "2026-01-12T09:14:03.221Z",
  "deadline": "2026-01-12T09:24:03.221Z",
  "envelopeId": "01JG7Q2K3M4N5P6R7S8T9V0W1X",
  "fromRole": "archetype.planner",
  "idempotencyKey": "01JG7Q2K3M4N5P6R7S8T9V0W2A",
  "intent": "work.produce",
  "payload": { "briefRef": "sha256:9a1f…c7", "specKey": "spec.intake.v3" },
  "runId": "01JG7P9A1B2C3D4E5F6G7H8J9K",
  "signature": { "algo": "sha256", "digest": "3f7c…21", "keyId": "local-dev" },
  "toRole": "archetype.builder",
  "traceId": "01JG7P0000000000000000000A"
}
```

### 2.2 Validation order (normative)

1. `contractVersion` known → else DLQ with `UNSUPPORTED_CONTRACT_VERSION`.
2. zod structural validation → else `VALIDATION_FAILED`.
3. `signature` verification over canonical serialization → else DLQ with `SIGNATURE_INVALID`, plus an audit entry and a security event.
4. Authority: `toRole` holds the capability implied by `intent` → else `POLICY_DENIED` (nack, non-retryable).
5. Precondition evaluation → else nack(`PRECONDITION_FAILED`, non-retryable).
6. Dedupe: `idempotencyKey` already consumed → return the recorded result, emit no effect (SM-H-01).
7. Budget/deadline arm → then `dispatch`.

---

## 3. Ack / nack semantics

| Response | Meaning | State effect | Retryable? |
|---|---|---|---|
| `ack` | "I have taken responsibility and will act." | `dispatched → acknowledged` | n/a — ack is not completion |
| `ack + effect_applied` | "Done; the effect is committed." | `acknowledged → effect_applied` | n/a — terminal success |
| `nack(reason)` | "I refuse / cannot proceed." | `dispatched → nacked` | Depends on `reason` (§3.1) |
| **silence past `deadline`** | No response received | `dispatched → expired` | Yes, if attempts remain |
| `cancel` | Owning run reached a terminal state | any non-terminal → `cancelled` | No — terminal |

Rules:

- **Ack ≠ completion.** An `ack` only proves the receiver accepted the work. The effect is confirmed by `effect_applied`, which requires consuming the dedupe key.
- **Nack is not an error path to swallow.** Every nack carries a machine-readable `reason` code and appears in the run timeline and the audit log.
- **Two-phase**: `ack` is optimistic (reserves capacity); `effect_applied` is authoritative.
- **Late ack after expiry**: accepted only if the dedupe key is unconsumed and policy allows; it transitions `expired → dispatched → acknowledged` via `replay` (attempt+1), so the timeline stays monotonic.

### 3.1 Nack reason taxonomy

| Reason code | Retryable | Typical cause |
|---|---|---|
| `BUSY` | ✅ | Receiver saturated; backoff and retry |
| `TRANSIENT_FAILURE` | ✅ | Worker crash, interrupted I/O |
| `DEADLINE_TOO_TIGHT` | ✅ (once) | Deadline unachievable; retry with an extended deadline only if the producer re-issues |
| `BUDGET_EXCEEDED` | ✅ | Receiver would exceed its budget; retry after the producer raises it explicitly |
| `PRECONDITION_FAILED` | ❌ | `constraints.precondition` not satisfied by the inputs |
| `INVALID_PAYLOAD` | ❌ | Schema-level rejection |
| `NOT_MY_ROLE` | ❌ | `intent` outside `toRole`'s authority |
| `POLICY_DENIED` | ❌ | Governance refused (clearance, budget policy, freeze) |
| `UNSUPPORTED_CONTRACT_VERSION` | ❌ | Receiver too old for the envelope major version |
| `SIGNATURE_INVALID` | ❌ | Integrity failure — security event, DLQ always |
| `IRREVERSIBLE_CONFLICT` | ❌ | Receiver's state contradicts the request |

### 3.2 Retry & backoff policy

```text
delayMs(attempt) = min(baseMs × 2^(attempt − 1), capMs) × jitterFactor
  baseMs        = 250        (handoffs)   / 500 (model-backed handoffs, P2)
  capMs         = 30_000
  jitterFactor  ∈ [0.8, 1.2] from an INJECTED RNG (deterministic in tests)
  maxAttempts   = 3 (default) / configurable per intent, never > 10
  full jitter on the FIRST retry only (250 ms ±20%), then exponential

Attempt ladder (default): 250 ms → 500 ms → 1 s → 2 s → 4 s … capped at 30 s
Total worst case for maxAttempts=3: ≈ 750 ms + jitter, well under any sane deadline

Rules:
  R-1  Retry is allowed only for retryable nack reasons and timeouts, and only
       while attempt < maxAttempts AND now + delay < deadline.
  R-2  Retrying past the deadline is a dead-letter, not a late dispatch.
  R-3  Retry preserves idempotencyKey and envelopeId; only `attempt` changes.
       (The receiver therefore sees the SAME dedupe key across attempts.)
  R-4  Backoff sleeps are cancellable: run cancellation aborts the wait immediately.
  R-5  A retry never re-applies an already-consumed effect — dedupe wins.
  R-6  Circuit-breaking: 5 consecutive dead-letters for the same (toRole, intent)
       within 10 minutes raises a UI/audit warning and marks the role unhealthy.
```

---

## 4. Idempotency and exactly-once effect

### 4.1 Mechanism

```text
producer side (inside the same transaction as the node's state change):
  1. build envelope (deterministic key: idempotencyKey, generated once per intent)
  2. INSERT INTO handoffs(state='prepared', ...)
  3. INSERT INTO handoff_outbox(handoff_id, enqueued_at, state='pending')
  4. UPDATE node_executions SET state='waiting_handoff'   -- or run state
  -- COMMIT: all four or none

dispatcher side (post-commit, separate transaction):
  5. drain handoff_outbox where state='pending' ORDER BY enqueued_at, id
  6. deliver(attempt)  → transport (in-process worker pool in V1.1)
  7. UPDATE handoff_outbox SET state='sent' WHERE id=?   (no effect on the handoff row yet)

receiver side:
  8. validate envelope (§2.2)
  9. BEGIN
       INSERT INTO handoff_dedupe(idempotency_key, handoff_id, consumed_at, result_ref)
         -- PK conflict ⇒ effect already applied ⇒ return recorded result, DO NOT re-apply
       <apply effect>            -- one logical unit
       UPDATE handoffs SET state='effect_applied', settled_at=?
     COMMIT
 10. if the transaction aborts, retry delivery; the dedupe key was never consumed
     ⇒ the effect is applied at most once across all retries.
```

### 4.2 Why both outbox **and** dedupe

| Failure | Outbox alone | Dedupe alone | Both |
|---|---|---|---|
| Node committed, process dies before send | ✗ lost forever | ✓ (never sent) | ✓ drain on restart |
| Receiver applied effect, ack lost | ✓ resent | ✓ no duplicate effect | ✓ resent, dedupe no-ops |
| Duplicate delivery from a retry | ✓ at-least-once | ✓ prevented | ✓ exactly-once effect |
| Transaction rollback mid-effect | ✗ ambiguous | ✓ atomic with effect | ✓ atomic with effect |

### 4.3 Idempotency key rules

| Rule | Detail |
|---|---|
| Scope | Unique per `(runId, fromRole, toRole, intent)` — enforced by `uq_handoffs_idem` (FR-10). Two *different* requests from the same pair use different intents or an explicit sequence discriminator in `payload`. |
| Generation | `IdFactory` ULID, generated once at `prepared` time and frozen for all attempts. |
| Consumption | Exactly one row in `handoff_dedupe`; written in the **same** transaction as the effect. |
| Replay semantics | Re-delivering a consumed key returns `result_ref` and emits no second `HandoffEffectApplied`. |
| Run-scoped lifetime | Dedupe rows are retained for the life of the run **plus** the audit retention window (they are proof of exactly-once). |
| Deterministic replay | Because runs are pinned to snapshots, a replayed run produces the same intents in the same order and therefore the same keys — a replayed run against already-consumed keys is a no-op for effects. |

---

## 5. Ordering guarantees and event log design

### 5.1 Guarantees

| Level | Guarantee | Mechanism |
|---|---|---|
| Per stream `(runId, fromRole, toRole, intent)` | **FIFO** | Monotonic `seq` allocated from the run's event-log sequence at `prepared` time; the dispatcher drains in `seq` order |
| Per run | **Causal** — a handoff is dispatched after the event that caused it | Envelope references the causing `eventId`; the dispatcher refuses out-of-causal-order dispatch |
| Per run | **Total order of state changes** observable in the event log | Single writer (main process) + `events.seq` monotonic; the log is the ordering authority |
| Across runs | **None** — runs are independent | No cross-run ordering is required or promised |
| Across roles within a run | **Partial order** — only the DAG induces ordering | The DAG, not wall-clock arrival, decides precedence |

### 5.2 Event log design

| Aspect | Decision |
|---|---|
| Shape | Append-only `events` table: `event_id` (ULID), `type`, `occurred_at`, `trace_id`, `run_id`, `org_id`, `version_id`, `payload_json`, `envelope_version` |
| Ordering authority | `event_id` is a ULID ⇒ lexicographic order = time order (monotonic within the process). A per-run `seq` column provides a stable, gap-free order for replay. |
| Envelope version | `envelope_version` (integer) allows event upcasters; old events are never rewritten. |
| Write discipline | Every state change appends exactly one event in the same transaction (INV-WF-16). No "log after commit" path exists. |
| Retention | 365 days hot, then gzipped JSONL archive; audit-relevant event types are never purged (`docs/WORKFLOW_LIFECYCLE.md` §9.3) |
| Projections | `WorkflowMetrics`, run timeline, and DLQ views are rebuilt from `events`; rebuild must be idempotent |
| Tamper evidence | Security-relevant event types are mirrored into the hash-chained `audit_log` (`docs/SECURITY_MODEL.md` §10) |
| Replay tooling | `replay(runId)` re-reads events and asserts the resulting projections match; a mismatch is an integrity finding, not an auto-repair |

---

## 6. Dead-letter queue and replay

### 6.1 DLQ admission

A handoff enters `dead_lettered` when:

1. attempts are exhausted (`attempt >= maxAttempts`), or
2. the nack reason is non-retryable (§3.1), or
3. the envelope is invalid/unverifiable (`SIGNATURE_INVALID`, `UNSUPPORTED_CONTRACT_VERSION`, `maxHops` exceeded), or
4. the deadline passed and policy forbids late replay.

The DLQ row preserves: original envelope (verbatim JSON), full attempt history, final reason code, owning run/node, and the sensitivity of any attached artifacts.

### 6.2 DLQ record

| Column | Meaning |
|---|---|
| `id` | DLQ entry id |
| `handoff_id` / `envelope_id` | Link to the original row |
| `reason_code` | From §3.1 or `RETRY_EXHAUSTED` / `DEADLINE_EXPIRED` / `MAX_HOPS_EXCEEDED` |
| `attempts` | Highest attempt reached |
| `envelope_json` | Verbatim envelope (never mutated) |
| `first_seen_at` / `dead_lettered_at` | Timestamps |
| `replayed_at` / `replay_count` | Operator replay bookkeeping |
| `status` | `open` \| `replayed` \| `discarded` |

### 6.3 Replay semantics

| Rule | Detail |
|---|---|
| Operator-triggered only | Automatic replay of DLQ entries is forbidden: a dead-letter usually signals a policy or integrity problem, not flakiness. |
| Preconditions | Dedupe key must be unconsumed; the envelope signature must still verify; the owning run must still exist (a replayed handoff never resurrects a terminal run — it must be re-issued by a **new** run). |
| Effect | New delivery attempt with `attempt + 1`; `status='replayed'`; an audit entry records actor, reason, and the DLQ id. |
| Idempotent | If the key was consumed between dead-lettering and replay, replay returns the recorded result and applies nothing. |
| Discard | Explicit operator action; requires a reason; the row stays for audit with `status='discarded'`. |
| Bulk replay | Never supported in the UI. Batch operations hide causality; V1.1 forces per-entry decisions. |

### 6.4 Run-level interaction

A dead-lettered handoff does **not** automatically fail the run. The owning `NodeExecution` consults policy: `onHandoffDeadLetter: 'fail_run' | 'skip_node' | 'block'`. The default is `fail_run` for `requiresArtifact: true`, `skip_node` otherwise. `block` is only legal for HITL gates, where a human is expected to intervene.

---

## 7. Sequence diagram — 3-hop handoff

Roles are pack-declared archetypes (`archetype.planner` → `archetype.builder` → `archetype.reviewer`), with a human gate inserted on the third hop.

```text
   Orchestrator        HandoffStore     Outbox/Dispatch      Builder            Reviewer
   (run engine)        (EntityStore)    (in-process)         (worker role)      (+ human gate)
        │                   │                 │                   │                   │
   1    │ prepare H1        │                 │                   │                   │
        ├──────────────────►│ INSERT handoff  │                   │                   │
        │                   │ state=prepared  │                   │                   │
        │                   ├────────────────►│ enqueue(outbox)   │                   │
        │  COMMIT (handoff + outbox + node state, one txn)        │                   │
        │                   │                 │                   │                   │
   2    │                   │                 │ drain → deliver H1│                   │
        │                   │                 ├──────────────────►│                   │
   3    │                   │                 │◄──── ack(H1) ─────┤ dispatched→acknowledged
        │                   │                 │                   │                   │
   4    │                   │                 │◄── effect_applied ┤ dedupe consumed   │
        │                   │                 │  artifacts[0] = sha256:…              │
        │                   │                 │                   │                   │
   5    │ prepare H2 (planner→reviewer, intent=work.review)       │                   │
        ├──────────────────►│ INSERT            │                 │                   │
        │                   ├────────────────►│ deliver H2        │                   │
        │                   │                 ├───────────────────────────────────────►│
   6    │                   │                 │◄──── nack(BUSY) ───────────────────────┤
   7    │                   │                 │  retry: attempt2 after 250±20% ms      │
        │                   │                 ├───────────────────────────────────────►│
   8    │                   │                 │◄──── ack(H2) ──────────────────────────┤
        │                   │                 │◄── effect_applied (review notes) ──────┤
        │                   │                 │                                        │
   9    │ prepare H3 (reviewer→HUMAN, intent=work.approve, humanApprovalRequired=true)  │
        ├──────────────────►│ INSERT handoff    │                                        │
        ├───────────────────────────────────────►│ dispatch to approval queue ─────────►│
  10    │  RunState: running → waiting_handoff   │                                        │
        │                                        │      (operator decides in UI)          │
  11    │                                        │◄──── ack(H3) + effect_applied ─────────┤
        │                                        │  decision token consumed once          │
  12    │  RunState: waiting_handoff → running   │                                        │
        │  handoffClosed → next runnable nodes                                            │
        │                                        │                                        │
  13    │ deadline exceeded on any hop ⇒ expired ⇒ retry (if attempts remain) ⇒ dead_lettered
        │ run cancellation at any point ⇒ HandoffState=cancelled for all open handoffs (SM-H-05)
```

**Hop accounting:** `constraints.maxHops = 3` means the chain planner→builder→reviewer→human is at the limit; a fourth delegation is dead-lettered with `MAX_HOPS_EXCEEDED`. This is the anti-storm control.

---

## 8. Human-in-the-loop handoff (approval gates)

| Aspect | Decision |
|---|---|
| Representation | A handoff with `intent: 'work.approve'` (or `'work.reject'` as the alternative decision), `toRole` = a human authority role, `constraints.humanApprovalRequired = true`. |
| Run effect | The run enters `RunState.waiting_handoff` and **stays** there until the decision is recorded — it does not consume worker capacity and does not time out silently. |
| Decision token | The `idempotencyKey` is the decision token: single-use. A double-click on "Approve" yields one effect (SM-H-06). |
| Default on no decision | Handoff deadline → `expired` → policy decides: default for gates is `block` (i.e. the run stays waiting, a UI alert is raised, and an audit entry records the overdue gate). Auto-approval on timeout is **never** the default and must be explicitly configured per workflow, with the configuration itself audited. |
| Required context | The approval envelope must carry: what is being approved (`artifacts` refs), the consequence of approval, the requester, the deadline, and the policy that authorizes this gate. An approval without artifact references is rejected at `prepare` (`requiresArtifact = true` for gates). |
| Accountability | `decidedBy`, `decidedAt`, `decisionReason`, and the envelope digest are persisted. The human decider must hold an `AuthorityGrant` for the gate (Governance, deny-by-default). |
| Segregation of duties | For change-approval gates, the decider ≠ the author of the artifact (same rule as `ChangeProposal`, SM-P-04). |
| Multiple approvers | If policy requires quorum, each approver is a **separate** handoff with its own idempotency key; the gate closes when quorum is reached. Quorum semantics are Governance-owned, not protocol-owned. |
| Rejection | A rejection is an `effect_applied` with a negative decision in `payload.decision`; downstream nodes see it as an input, and the workflow's declared `onReject` behaviour (`halt` / `branch`) executes. |

---

## 9. Payload vs. artifact store

| Size of a value | Where it goes | Rule |
|---|---|---|
| `≤ 8 KiB` | **Inline in `payload`** | Total serialized envelope must stay `≤ 64 KiB`; JSON only, no binary |
| `> 8 KiB` and `≤ 256 KiB` | **Artifact store**, referenced from `artifacts[]`, with a `summary` in `payload` | `contentRef = sha256:<hex>`; the receiver must not require the raw content to validate its preconditions |
| `> 256 KiB` | **Artifact store only** — `artifacts[]` ref required, and payload must contain only metadata | Attempting to inline it is a `VALIDATION_FAILED` at `prepare` |
| Binary of any size | **Artifact store only** | Never base64 in `payload`; base64 inflates 33% and destroys streaming |
| Secrets | **Never in either** | Resolved through `SecretResolver` at use time; `payload` carries only a secret *handle* |

Artifact-store rules:

1. Content-addressed: identical content is stored once; the reference **is** the hash.
2. Integrity: the receiver verifies `sha256(stored) = contentRef` before use; failure ⇒ nack(`TRANSPORT_CORRUPT`, non-retryable) and an integrity audit entry.
3. Sensitivity inheritance: an artifact's `sensitivity` gates retrieval independently of the envelope.
4. Lifecycle: artifacts referenced by a retained run are retained; unreferenced artifacts are compacted per the capacity policy in `docs/MEMORY_ARCHITECTURE.md` §8.
5. Immutability: an artifact is never overwritten. A change produces a new `contentRef`.

**Rationale for the 8 KiB split:** keeping typical intents inline makes audit and debugging a single-row read; pushing anything larger out keeps the event log and handoff table small enough for the hot indexes (§10.3 of `docs/STATE_MACHINE.md`) and keeps the DB growth bounded (NFR §9.4).

---

## 10. Contract versioning of envelopes

| Rule | Detail |
|---|---|
| Field | `contractVersion: 1` is **required** on every envelope; it is never inferred from the app version. |
| Additive change (optional field, new `intent`, new nack reason) | **Minor** — same `contractVersion`; older receivers ignore unknown fields (zod `.passthrough()` on the optional extension bag is banned — instead, extension fields live under a namespaced `payload.ext` object). |
| Breaking change (rename, retype, semantic change, removed field) | **Major** — `contractVersion` increments; converters are written in **both** directions and tested. |
| Persisted envelopes are never rewritten | An envelope row is immutable evidence. Reading an old version uses an **upcaster**: `v1 → v2` applied on read, never on write. |
| Unsupported version | Receiver nacks/dead-letters with `UNSUPPORTED_CONTRACT_VERSION`: never guess, never best-effort partially parse. |
| Compatibility matrix | Maintained in `@companyos/contracts` as a tested table: `(writerVersion, readerVersion) → ok \| upcast \| reject`. |
| Signature stability | The canonical serialization for `signature` is fixed per major version. A major bump therefore re-signs; this is intentional so verification cannot silently change across versions. |
| Pack-declared intents | A pack may declare new intents, but each intent must specify the `contractVersion` it speaks. Core does not know the intent's meaning — only the envelope. |

---

## 11. Failure taxonomy

| # | Failure | Detection | Impact | Recovery | Owner |
|---|---|---|---|---|---|
| F1 | Producer crashed between node state change and dispatch | On restart, `handoff_outbox.state='pending'` with no `sent_at` | Handoff undelivered | Outbox drain resumes; dedupe key unconsumed ⇒ safe to send | Dispatch |
| F2 | Receiver applied effect, ack lost | Duplicate delivery; dedupe PK conflict on retry | None (no duplicate effect) | Return `result_ref`; log a `duplicate_delivery` metric | Protocol |
| F3 | Duplicate delivery of an unconsumed key | Receiver receives the same `envelopeId` twice before applying | None | Both attempts race on the dedupe PK; exactly one wins | Protocol |
| F4 | Receiver silent past deadline | Deadline sweeper (`idx_handoffs_deadline`) | Handoff `expired` | Retry with backoff if attempts remain; otherwise DLQ | Dispatch |
| F5 | Retryable nack (`BUSY`, `TRANSIENT_FAILURE`) | Nack reason code | Delay only | Backoff per §3.2; retry preserves idempotency key | Dispatch |
| F6 | Non-retryable nack (`POLICY_DENIED`, `NOT_MY_ROLE`, `PRECONDITION_FAILED`) | Nack reason code | Node cannot proceed | Immediate DLQ; owning node follows `onHandoffDeadLetter` policy | Node policy |
| F7 | Signature verification fails | Digest mismatch | Handoff refused | DLQ + security event + audit entry; investigate tampering/transport corruption | Security |
| F8 | Unknown `contractVersion` | Version check at validation step 1 | Handoff refused | DLQ; ship an upcaster or upgrade the receiver | Contracts |
| F9 | `maxHops` exceeded | Hop counter in `constraints` | Handoff refused | DLQ with `MAX_HOPS_EXCEEDED`; the DAG is likely mis-modelled | Workflow author |
| F10 | Budget exceeded (`maxWallClockMs`/`maxTokens`/`maxCostUsd`) | Receiver-side accounting | Handoff nacked | Retry once with an explicitly raised budget (audited) or DLQ | Governance |
| F11 | Artifact integrity failure (`sha256` mismatch) | Verification before use | Handoff refused | DLQ + integrity audit; re-produce the artifact | Storage |
| F12 | Handoff outlives its run | Run terminal while a handoff is non-terminal | Orphan handoff | Cascade-cancel all open handoffs (`SM-H-05`) | Run engine |
| F13 | Handoff storm (A↔B ping-pong) | Hop counter + per-`(runId,intent)` rate counter | Budget burn | `maxHops` bound; circuit breaker after 5 consecutive dead-letters (§3.2 R-6) | Protocol |
| F14 | DLQ replay of a consumed key | Dedupe check at replay | None (no effect) | Return recorded result; mark DLQ `replayed` | Operator |
| F15 | Ordering violation (dispatch before its causing event) | Causal `eventId` check | Handoff refused | Re-enqueue in causal order; a persistent violation is a bug | Dispatch |
| F16 | Approval gate overdue | Gate deadline exceeded, no decision | Run blocked | UI alert + audit entry; never auto-approve by default | Governance/HITL |

---

## 12. Test plan — Sprint 5

All tests are Vitest, deterministic (fake `Clock`, injected RNG), and run without network or model access (CANONICAL_SPEC §6 forbids model execution in Phase 1).

| # | Test | Type | Asserts |
|---|---|---|---|
| T-01 | `envelope.schema.spec.ts` | unit | The TS type and the zod schema agree on every field; a missing `contractVersion` or unknown field shape is rejected |
| T-02 | `envelope.canonical.spec.ts` | unit | `canonicalSerialize` sorts keys recursively and produces a stable digest across runs and platforms (golden fixture) |
| T-03 | `envelope.signature.spec.ts` | unit | Verification succeeds for an untampered envelope; a one-byte `payload` change fails with `SIGNATURE_INVALID` |
| T-04 | `handoff.prepare.atomic.spec.ts` | integration | Envelope + outbox + node state change commit atomically; a forced failure in step 3 leaves zero rows |
| T-05 | `handoff.outbox.drain.spec.ts` | integration | A crash between commit and dispatch still delivers exactly once after restart |
| T-06 | `handoff.dedupe.exactly_once.spec.ts` | integration | 100 concurrent duplicate deliveries of one `idempotencyKey` ⇒ exactly one effect, 99 recorded replays |
| T-07 | `handoff.idempotency.scope.spec.ts` | integration | The unique index enforces `(runId, fromRole, toRole, intent)`; a different intent with the same pair is accepted |
| T-08 | `handoff.backoff.spec.ts` | unit | The attempt ladder matches §3.2 exactly with a seeded RNG; cap at 30 s; jitter bounded to ±20% |
| T-09 | `handoff.retry.preserves_key.spec.ts` | unit | Retries mutate only `attempt`; `envelopeId` and `idempotencyKey` are stable |
| T-10 | `handoff.deadline.expiry.spec.ts` | integration | A silent receiver yields `expired` at the deadline, never a late silent success |
| T-11 | `handoff.nack.retryable.spec.ts` | unit | Retryable reasons retry, non-retryable reasons dead-letter immediately |
| T-12 | `handoff.dlq.replay.spec.ts` | integration | Replay with an unconsumed key re-dispatches; with a consumed key it is a no-op returning the recorded result |
| T-13 | `handoff.dlq.never_auto.spec.ts` | integration | No automatic DLQ replay occurs under any built-in code path |
| T-14 | `handoff.ordering.fifo.spec.ts` | integration | Per-stream FIFO under 50 concurrent producers; `seq` order preserved |
| T-15 | `handoff.ordering.causal.spec.ts` | integration | A dispatch whose causing event is absent is refused and re-enqueued |
| T-16 | `handoff.cancel.on_run_terminal.spec.ts` | integration | Run `cancelled`/`failed`/`timed_out` cascade-cancels every open handoff (SM-H-05) |
| T-17 | `handoff.run_state_mirror.spec.ts` | integration | `RunState = waiting_handoff` ⇔ ∃ open handoff; closing the last one leaves the state in the same transaction (X-03) |
| T-18 | `handoff.size.thresholds.spec.ts` | unit | 8 KiB inline ok; 8 KiB+1 requires a ref; 256 KiB+1 with inline content is refused; binary base64 is refused |
| T-19 | `handoff.artifact.integrity.spec.ts` | integration | A tampered artifact fails `sha256` verification and nacks with `TRANSPORT_CORRUPT` |
| T-20 | `handoff.hitl.gate.spec.ts` | integration | Gate blocks the run; a single decision applies once; a double decision is idempotent; no auto-approve on timeout |
| T-21 | `handoff.hitl.segregation.spec.ts` | integration | The artifact author cannot approve their own gate unless org policy explicitly permits it |
| T-22 | `handoff.contract.upcast.spec.ts` | unit | A `v1` envelope read by a `v2` reader is upcast without mutating the stored row; unknown major is rejected |
| T-23 | `handoff.maxh.hops.spec.ts` | unit | The 4th hop in a 3-hop chain dead-letters with `MAX_HOPS_EXCEEDED` |
| T-24 | `handoff.sequence.three_hop.spec.ts` | integration | The §7 sequence replays end-to-end with the exact states and event order shown |
| T-25 | `handoff.metrics.spec.ts` | integration | `humanInterventions` counts acknowledged approval handoffs; retries do not inflate it |
| T-26 | `handoff.redaction.spec.ts` | security | A seeded secret placed in a payload never appears in any log sink or in the persisted envelope plaintext |
| T-27 | `handoff.perf.spec.ts` | bench | In-process dispatch round trip ≤ 15 ms p95; 1k handoffs dispatched within the index budget |
| T-28 | `handoff.snapshot.pin.spec.ts` | integration | All handoffs of one run reference the pinned `RunSnapshot`; a mid-run template mutation does not change delivery semantics |

**Sprint 5 exit criteria for handoff:** T-01…T-28 green; exactly-once proven under injected duplicate/partition faults; DLQ present with operator replay; HITL gate demonstrated end-to-end; no model or network call anywhere in the test suite.
