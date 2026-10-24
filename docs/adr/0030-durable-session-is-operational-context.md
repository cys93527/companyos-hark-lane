# ADR-0030: Durable Session Is Operational Context, Not Canonical Truth

- **Status**: Accepted
- **Date**: Sprint 19 closeout
- **Context**: Sprint 19 (T19-01..T19-04, ADR-superseding docs `docs/sprint19/*`)

## Decision

CompanyOS separates **persistent history** from **LLM working context**. The durable Session
kernel (T19-02: `sessions` + append-only `session_entries`, one migration, no state machine)
is a bounded OPERATIONAL CONTEXT container for exactly one role — the Developer — and is
never canonical business truth. Canonical state remains the existing authoritative stores
(Run/Task/Decision/Review/Validation/Artifact/WorkflowVersion/AgentExecution/RunSnapshot);
a session residue entry never means Task DONE, Review PASS or Validation PASS, and no
session read path can mutate any of them.

## Role-context strategies (frozen)

| Role | Strategy |
| --- | --- |
| Supervisor | STATE-RECONSTRUCTED per turn (T18-06 context projection; unchanged) |
| Developer | DURABLE TASK-SCOPED MULTI-TURN SESSION (per company+run+task+trusted roleKey; corrective child = new session, parent = lineage only, NO transcript inheritance) |
| Reviewer | ISOLATED BOUNDED STATE-RECONSTRUCTED context (T19-04 projector; zero session dependency) |
| QA | ISOLATED BOUNDED STATE-RECONSTRUCTED context (T19-04 projector; zero session dependency) |

## Consequences

1. **Residue-first durability (T19-03 closeout, Shape B)**: provider result → session residue
   durable → AgentExecution terminal settlement. A COMPLETED execution can never lack its
   durable residue; active context consumes execution-associated residue only when the
   execution is durably COMPLETED.
2. **Truth separation**: authoritative facts (Goal/Task/lineage/latest Review/latest
   Validation/anchor/WorkflowVersion) are re-read fresh on EVERY legal invocation for every
   role; session residue can never override newer canonical truth.
3. **Bounded by construction**: count caps + visible truncation flags + a provider-neutral
   pre-invocation token budget (per-UTF-8-byte conservative estimate, fail closed, zero
   provider calls on overflow) for Developer/Reviewer/QA. Compaction is deterministic
   active-window metadata only — never model summaries or semantic memory.
4. **No authority**: sessions, context seeds, projectors and model output grant nothing —
   no tool, risk, approval, lease, validator or lifecycle authority.
5. **Provider neutrality**: no conversation/thread/provider ids in the session schema;
   provider adapter state stays outside session truth.

## Alternatives rejected

- Session as business truth / completion evidence (violates single-truth).
- Per-role durable sessions for Reviewer/QA (their responsibilities are stateless; durable
  transcripts would add a second truth without need).
- Model-summary compaction / semantic memory / recall (future research backlog only).
- Global ContextGovernor (explicitly out of scope; projectors stay per-role and bounded).
