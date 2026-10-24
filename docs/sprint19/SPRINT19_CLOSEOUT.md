# Sprint 19 Closeout — Session / Context Runtime

Scope (frozen): T19-01 recon → T19-02 durable session kernel → T19-03 Developer durable
session integration → T19-04 Reviewer/QA bounded context completion. No further feature
belongs to Sprint 19.

## 1. Final role-context architecture

| Role | Strategy | Context builder |
| --- | --- | --- |
| Supervisor | STATE-RECONSTRUCTED TURN | T18-06 `supervisor-runtime.buildContext` (unchanged; audited) |
| Developer | DURABLE TASK-SCOPED MULTI-TURN SESSION | T19-03 `work-session-runtime` (trusted registration, active residue, residue-first round) |
| Reviewer | ISOLATED BOUNDED STATE-RECONSTRUCTED | T19-04 `bounded-agent-context.projectReview` |
| QA | ISOLATED BOUNDED STATE-RECONSTRUCTED | T19-04 `bounded-agent-context.projectValidation` |

There is no fifth strategy: every model-calling production path resolves to exactly one of
these four, by composition wiring that no model, caller or payload can reach.

## 2. Session truth boundary

Session structures are bounded operational context ONLY. Canonical business state remains
the existing authoritative stores; nothing in Sprint 19 added a writer, mutator or
authority to them from a session path:

```text
canonical truth: runs / tasks / decisions / review artifacts / validations /
                 artifacts / templates+versions (WorkflowVersion) / agent_executions
session:         sessions + session_entries (append-only, bounded, no status machine)
```

Every projection states canonical facts read fresh per invocation; a session entry can
never mean DONE / PASS / valid, and no session read path mutates canonical state.

## 3. Developer durability ordering (T19-03 closeout, Shape B)

```text
agentRuntime.prepare (READY)
  → ONE provider invoke (runWithOutput; execution stays RUNNING)
  → session residue DURABLE (permanent command turn:<executionId>)
  → AgentExecution terminal settlement (COMPLETED)
  → StageHandlerOutcome → Task.outputs / DONE (the existing T18-07 path)
```

- Forbidden state (`COMPLETED` + residue missing + no reconstructible carrier) is
  IMPOSSIBLE by construction; proven by the whole-database invariant query in
  `t19-03b-durability` (test 1: zero COMPLETED-without-residue rows; test 10 re-proves it
  at every crash checkpoint).
- Residue-callback failure ⇒ execution CANCELLED (never fabricated success).
- Crash windows (`after_provider_result_before_session_residue`,
  `after_session_residue_before_execution_settlement`) leave either
  (residue missing + RUNNING) or (residue durable + RUNNING) — never a terminal success
  without its residue.

### Active-residue eligibility

An entry that records an execution enters the active context ONLY when that execution is
durably `COMPLETED`. `RUNNING` / `FAILED` / `CANCELLED` / `INTERRUPTED` / unknown / unreadable
⇒ excluded (kept durable as history). Foreign executions are rejected at append
(`SESSION_EXECUTION_MISSING` / `_RUN_MISMATCH` / `_TASK_MISMATCH`) — kernel-side, before any
row is written.

## 4. Role isolation (structural)

- The bounded projectors hold **no session-kernel dependency** (import graph:
  `bounded-agent-context.ts` → core + token-budget + qa-evidence only); Reviewer/QA cannot
  reach `SessionKernel` or any transcript API — proven by dependency trace, not naming.
- The Supervisor runtime predates sessions and imports none of it; it reconstructs
  Goal/Run/subject/latest Review/latest Validation/lineage/allowed actions/Decision history
  per turn.
- Developer residue enters the active context only through the session runtime's
  eligibility-gated read. Production message capture (t19-04 §44) proves: Developer sees
  `# Session residue`; Reviewer, QA and Supervisor never do.

## 5. Token budgeting

Developer, Reviewer and QA each gate the COMPLETE rendered request BEFORE the provider with
the same T19-02 kernel (stateless mode for Reviewer/QA — no Session is created for
budgeting): trusted catalog context window via the run's pinned binding (unknown ⇒ fail
closed), reserved output 1 024, fixed safety margin 256, per-UTF-8-byte conservative
estimate (`estimated ≥ byte length` + explicit framing; the bytes/3 rule is NOT
reintroduced and no exact provider tokenization is claimed), overflow ⇒ zero provider calls,
no silent truncation (count caps surface `truncated` flags). The Supervisor keeps its own
frozen T18-06 contract: 16 KiB rendered-context refusal (`SUPERVISOR_CONTEXT_TOO_LARGE`)
with the same no-truncation rule — reported separately, unchanged, and it is the one
model-calling runtime without a window budget by frozen design.

## 6. Compaction semantics

Deterministic active-window METADATA only (schema / coveredThroughSequence / entryCounts /
refsDigest / token accounting), same permanent command identity ⇒ idempotent replay, empty
window refused. Old entries are NEVER rewritten or deleted. There is no model summary, no
semantic/long-term memory, no AI compression, no recall.

## 7. Restart guarantees

- Session kernel: append-only rows; restart = fresh read; parent immutable; no state
  machine to restore (`t19-02` restart matrix).
- Developer: same session identity re-derived (deterministic sha256 scope), residue
  survives, canonical facts re-read fresh; restart never re-invokes a provider to recreate
  durable output, never duplicates seed/residue/execution (`t19-03` §49,
  `t19-03b` 5/6/14).
- Reviewer/QA: stateless projectors — restart is a fresh invocation reconstructing the same
  required facts from canonical state (`t19-04` 11/28).
- Whole-stack E2E with composition restart between meaningful points: `t19-04` 11/27-28 and
  `t19-03` §49/§52.

## 8. Recovery routing (closeout §19 — final)

`routeTask` (recovery) classifies envelopes by EXPLICIT trusted classification, never by
"sink lookup returned none":

- Exactly ONE kind is classified as having NO canonical sink — `WORK_ROLE_OUTPUT_KIND`
  (`companyos:work-role-work`, the Work-role turn envelope; its canonical evidence arrives
  through the review/validation roles). Recovery skips exactly this kind (`ok(null)`).
- The two candidate kinds (`companyos:review-findings-candidate`,
  `companyos:validation-candidate`) route to their canonical sinks after provenance
  verification (execution exists / same run / same task / COMPLETED).
- EVERY other kind — including unknown kinds — fails closed
  (`STAGE_OUTPUT_KIND_UNROUTABLE`), even with fully verifiable provenance
  (closeout §20 test 2). The forbidden `if (!sink) return;` shape does not exist.
- The LIVE path (`routeOutput`) is unchanged and strict: every envelope the handler just
  produced must verify and route or the unit fails.

## 9. Workspace anchor (closeout §21/§22)

With a REAL opened Git workspace (trusted host seam `repositoryRuntime.openWorkspace`),
all three projections carry the CURRENT canonical anchor identity — Developer
(`anchorIdentity` + `workspace-anchor` ref), Reviewer and QA (`anchor` seat) — as identity
refs only, never repository contents. A legal anchor change (close → open a different
workspace) reaches the NEXT projection; session residue cannot freeze it
(`sprint19-closeout` §21/§22). With no workspace open the seat is an honest `null`.

## 10. Frozen latest semantics (closeout §25 — precise)

Not a vague "latest wins":

- **Latest applicable Review selection**: readers use the newest canonical review report
  across the run's review anchors by `createdAt` (tie-break artifactId) —
  `getLatestReviewReport` per anchor; the newest report regardless of verdict
  (anti-cherry-pick: a stale PASS can never hide a newer CHANGES_REQUESTED). The T18-06
  supervisor proposal gate additionally enforces the **consumed-verdict rule** (`reviewVerdictConsumedBy`):
  a CHANGES_REQUESTED already cited by a REQUEST_CORRECTIVE decision is consumed — it does
  not block CONTINUE and is not re-applied; a PASS is never consumed.
- **Validation batch semantics**: `listByRun` returns newest-first; the applicator's
  required-validator policy and the engine gate decide on the run's CURRENT batch set; an
  older PASS never beats a newer FAIL and vice versa (newest batch decides).
- **Anti-cherry-pick**: newest-report/newest-batch reads are the only selections the role
  contexts perform; nothing lets a caller or model pick a favorable older row.

## 11. Placeholders, neutrality, secrets, tenants, authority

- No false placeholders remain in any Sprint-19 production context: real
  company/workflow/version identities everywhere (T19-04 §23 + closeout re-audit);
  unavailable facts are labeled `null` (`acceptanceCriteria`), never fabricated.
- Provider neutrality: no conversation/thread/provider ids anywhere in the session schema
  or context envelopes.
- Secrets: no provider keys/headers/vault values/repository credentials are persisted or
  projected; redaction rides the existing append seams.
- Isolation: foreign company ⇒ NOT_FOUND / fail closed with zero role invocations; foreign
  run/task/execution ⇒ rejected at every seam (kernel append, carrier provenance,
  projector scope). No existence leakage.
- Authority: Sprint 19 added NO authority — no tool, no risk change, no approval path, no
  lease, no validator grant, no lifecycle mutation from any session/context/output path.

## 12. Known non-goals / remaining V1 work (allowed open)

Planning / task decomposition, Structured Handoff / Work Package (the context-seed seam is
the MINIMAL handoff seam Sprint 19 leaves), Architecture Guard, minimal observability, real
production provider/executor integration, human goal / product control plane, context
optimization / recall / learned memory (ContextGovernor-family explicitly deferred).
Acceptance criteria, change-set summaries and explicit dependency lists remain NOT
CANONICALLY AVAILABLE until those phases exist.
