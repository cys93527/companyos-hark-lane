# T19-02 — Durable Session Kernel

Status: implemented (kernel ONLY — no role integration; Supervisor stays state-reconstructed,
Developer/Reviewer/QA keep their Sprint-18 behavior until T19-03+). Baseline `109ccc5`.

## 1. Schema (migration `session/0001_session.sql` — one migration, two tables, non-destructive)

```
sessions(session_id PK, company_id, run_id, task_id, role_key, parent_session_id NULLABLE,
         created_at, UNIQUE(company_id, run_id, task_id, role_key))
session_entries(session_id, sequence, command_id, entry_kind, text, refs_json,
               execution_id NULLABLE, input_token_estimate, output_token_count NULLABLE,
               fingerprint, created_at,
               PK(session_id, sequence), UNIQUE(session_id, command_id))
indexes: sessions(company_id, run_id), sessions(parent_session_id),
         session_entries(session_id, entry_kind, sequence)
```

Rollback/non-destructive behavior: `CREATE ... IF NOT EXISTS` only; re-running is a no-op and
dropping the `session` chain leaves every earlier schema untouched. No existing table was
modified. No session state machine exists (no status/FAILED/DONE/RUNNING/WAITING columns).

## 2. Identity

`ses_ + sha256("companyos/session/1:" + companyId + ":" + runId + ":" + taskId + ":" + roleKey)[0:26]`
(`packages/core/src/lifecycle/session.ts` `sessionIdOf` — the same convention as
`supervisorDecisionIdOf`). Inputs are ONLY the immutable scope. `parentSessionId`, display
names, provider/model ids, execution ids, model output, timestamps and random UUIDs are all
excluded. Creation is idempotent: same scope resolves to the same row (the UNIQUE index
arbitrates races); a stored scope that conflicts with a request fails closed
(`SESSION_SCOPE_CONFLICT`), never rewritten. `parentSessionId` is lineage/audit metadata only
— it is not an identity input and grants nothing (same company, same run, exists, no self,
no cycle are validated; same task is deliberately NOT required for future corrective
children).

## 3. Append contract

Append-only; no update/delete path exists anywhere. Entries carry bounded text
(≤65,536 UTF-8 bytes, oversize rejected — never truncated), ≤64 validated canonical refs
(typed pointer envelopes: goal/task/decision/artifact/review/validation/tool-invocation/
agent-execution/repository-anchor), an optional executionId, and the two DISTINCT token
numbers (`inputTokenEstimate` = deterministic pre-invocation upper bound;
`outputTokenCount` = provider-reported actual; they never overwrite each other). Sequence is
per-session, 1-based, monotonic, allocated in the kernel and enforced by the PRIMARY KEY; a
concurrent collision fails at the database level and the kernel re-allocates and retries
(bounded ≤32) so concurrent appends converge with no duplicate sequence, no lost entry and no
duplicated permanent command. All appends pass the redaction seam before the durable write.

## 4. Replay contract

Every append carries `commandId = "companyos/session-entry/1:<sessionId>:<callerCommandId>"`
plus a semantic FNV-1a fingerprint over the entry's meaning. Same command + same fingerprint ⇒
the existing entry (both before and after restart, including compaction commands); same
command + different fingerprint ⇒ `SESSION_ENTRY_FINGERPRINT_MISMATCH` (fail closed). This is
the decision-sink permanent-identity pattern; the bounded command ledger is NOT the truth.

## 5. Parent semantics

Validated at creation: same company (foreign = `SESSION_PARENT_MISSING` — NOT_FOUND privacy,
no existence disclosure), same run (`SESSION_PARENT_RUN_MISMATCH`), exists, no self
(`SESSION_PARENT_SELF`), no cycle (`SESSION_PARENT_CYCLE`). No automatic context inheritance
in any form: a child's log starts empty (`readActiveContext` returns zero entries; the §47/16
test proves it). A future child is seeded explicitly through a bounded ContextSeed.

## 6. Token estimator & budget kernel (hardened by the T19-02 corrective ruling A/A2/A4; NOT wired — T19-03)

`packages/engine/src/session/token-budget.ts` — a PROVIDER-NEUTRAL CONSERVATIVE FALLBACK
ESTIMATE. It is NOT exact provider tokenization: it MAY overestimate, it must never
underestimate, and it fails closed. The generic fallback is deliberately pessimistic — ONE
UTF-8 BYTE = ONE TOKEN (`estimatedInputTokens >= utf8ByteLength(rendered input)`). The
earlier bytes÷3 rule was withdrawn: a CJK character is 3 bytes but can tokenize to more than
one token, and punctuation runs can explode to one token per byte, so bytes÷3 could
underestimate (false acceptance), which the ruling forbids. Per-byte counting cannot
underestimate under the documented contract: every mainstream tokenizer, including worst-case
byte-level BPE, produces at most one token per input byte. False rejection is acceptable.

Framing (ruling A2): the estimator sees one string. The runtime that integrates this kernel
MUST pass the COMPLETE rendered request — message texts, role labels, tool descriptors,
responseFormat schemas and any other framing — or supply the equivalent explicitly as
`additionalFramingTokens` (additive, floored, never negative). No known request component may
be silently ignored.

`allowedInput = contextWindow − reservedOutput − fixedSafetyMargin(256)`; impossible
configurations (non-positive window, negative reservation, reservation exceeding the
margin-adjusted window) are rejected (`SESSION_TOKEN_BUDGET_IMPOSSIBLE`); an estimate over
budget refuses with `SESSION_TOKEN_BUDGET_EXCEEDED` — fail closed BEFORE any provider
invocation, no truncation, no drop, no retry. No provider invocation is wired to it in
T19-02 (no provider-specific tokenizer dependency, no network calls).

## 6b. Parent immutability (corrective ruling B)

`parentSessionId` is not part of identity AND is immutable lineage metadata after creation:
a replay of the same scope naming a DIFFERENT parent — null→P or P1→P2 — is refused with
`SESSION_PARENT_CONFLICT`; nothing is silently rewritten, and no one-time attach operation
exists.

## 6c. Execution reference scope (corrective ruling C)

An entry bearing an `executionId` is validated BEFORE the append commits: the referenced
AgentExecution must EXIST in the durable store, belong to the SAME RUN as the session, and
belong to the SAME TASK (`SESSION_EXECUTION_MISSING` / `SESSION_EXECUTION_RUN_MISMATCH` /
`SESSION_EXECUTION_TASK_MISMATCH`; tenant scope is implied because the session read is
company-scoped and the execution is proven to belong to that run). Role compatibility between
the session's trusted roleKey and the execution's roleId has NO canonical mapping and is
deliberately not guessed — reported as NOT_PROVABLE rather than invented. No AgentExecution
schema change.

## 7. Compaction semantics

Deterministic active-window compaction only (no model-generated summarization). A checkpoint
is itself an append-only entry whose text carries ONLY bounded metadata: `schema`,
`coveredThroughSequence`, per-category `entryCounts`, a `refsDigest`, and token accounting.
It can never carry business-truth fields. Old entries are NEVER deleted or rewritten — the
checkpoint only changes what a FUTURE active projection is eligible to include. Repeating the
same compaction command replays the same checkpoint; compacting with nothing new eligible is
refused (`SESSION_COMPACTION_EMPTY`).

## 8. Active context projection

`readActiveContext({companyId, sessionId, recentWindow?})` returns the canonical refs + the
eligible recent entries + the latest checkpoint metadata. It fetches NO business facts by
itself and builds no role-specific prompt. It is the seam a future renderer consumes.

## 9. Security boundaries

- Redaction seam at append (vault secrets / credentials / tokens / env handles never
  persist; tests prove a known-secret-bearing entry appends through the seam).
- Entries are inert rows: the kernel surface exposes only `ensureSession`, `appendEntry`,
  `compact`, `readActiveContext` — no grant/register/complete/dispatch/createDecision method
  exists (asserted by test), and a session write provably creates no Decision, mutates no
  run row/snapshot and registers no tool.
- Not a Tool, not IPC, no UI, no authority: the kernel is trusted process-internal
  infrastructure exposed as `core.sessionKernel` (null without the `session` chain).
- Tenant isolation on every read/write (`companyId` mandatory; foreign = NOT_FOUND).

## 10. Restart

Fresh composition over the same database reconstructs identity, scope, parent relation,
ordered entries, permanent replay identities, compaction checkpoints and token accounting —
proven by the §49 restart test (identity/order/parent/tokens/checkpoint/replay after a real
close+reopen). No process-local session truth exists.

## 11. ContextSeed seam (minimal)

The `context_seed` entry kind plus `SESSION_CONTEXT_SEED_SCHEMA` define the generic bounded
seed envelope a future T19 task uses to explicitly seed a child session. No Structured
Handoff, no Work Package, no Planning exists in T19-02.

## 12. Remaining integration gaps (deliberately open)

Developer durable multi-turn integration, AgentExecution attachment wiring, real context
rendering, corrective child seeding and the AgentRuntime token-budget wiring are T19-03+.
The corrective T0→T1 compatibility is proven at the kernel level (§53: distinct child
session, parent linkage, zero auto-inheritance, restart-safe lineage) without any Developer
integration. Growth: V1 session history is append-only and grows; compaction bounds ACTIVE
context, not durable retention; no retention/deletion policy exists in T19-02.
