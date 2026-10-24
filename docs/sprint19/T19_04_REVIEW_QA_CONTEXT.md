# T19-04 — Reviewer / QA Bounded Context Completion

## 0. Mission result

Reviewer and QA now receive sufficient, fresh, authoritative, BOUNDED context for their actual
responsibilities, reconstructed from canonical state on every legal invocation. The Sprint-19
architecture is unchanged and complete:

```text
Supervisor = STATE-RECONSTRUCTED (unchanged, audited)
Developer  = DURABLE TASK-SCOPED SESSION (T19-03; placeholders corrected here)
Reviewer   = STATE-RECONSTRUCTED BOUNDED REVIEW CONTEXT (new projector)
QA         = STATE-RECONSTRUCTED BOUNDED VALIDATION CONTEXT (new projector)
```

No Reviewer/QA Session exists (§4/§5): the projectors hold NO session-kernel dependency, call
no `ensureSession`, and keep no transcript — structurally unable to reach Developer residue.

## 1. The production path (recon, §2)

`autonomousSupervisor.run` → turn head (`nextWorkUnit`, phase-aware: REVIEWING→review-kind
stages / VALIDATING→qa-kind) → `runAgentUnits` → `agentUnitRunner` (core-services) →
`composedStageHandlers` (base = repositoryRuntime.handlers()) → the `supervisor.review:<kind>`
/ `supervisor.qa:<kind>` handler → **bounded context projection (new)** → **token budget gate
(new, pre-provider)** → `pinnedAgentExecution.runRound` (prepare → ONE provider invoke →
settle; binding from the run's pinned snapshot, no model identity to override) →
`ProviderRegistry.invoke` → structured `StageHandlerOutcome` (review/validation candidate) →
`outputCarrier.routeOutput` → `ReviewFindingsSink.record` / `ValidationService.run` (canonical
sink FIRST) → Task DONE (T18-07 §12 ordering preserved).

Reviewer answers: *does the current delivered work satisfy the required task?* QA answers:
*does current work satisfy the configured validation requirements?*

## 2. The trusted bounded projectors (§7/§15)

`packages/engine/src/supervisor/bounded-agent-context.ts` — `createBoundedAgentContext(deps)`
exposes `projectReview` / `projectValidation`. Sources (all canonical, read FRESH per
invocation):

| Fact | Source | Reviewer | QA |
| --- | --- | --- | --- |
| Run Goal objective | run-goal artifact (runGoalWriter) | ✓ | ✓ |
| Goal artifact ref | artifactStore `runGoalCommandId` | ✓ (citable evidence) | ✓ (target candidate) |
| Run identities (id/companyId/workflowId/templateId/versionId) | run row | ✓ | ✓ |
| Review/QA task identity | task row | ✓ | ✓ |
| Subject/target task (kind/state/inputs/lineage/delivered envelope) | `workSubjectTaskOf` (pinned graph; corrective child wins) + task row | ✓ | ✓ |
| Prior finding (verdict/subjectTaskId/blocking findings) | latest canonical report across review anchors (anti-cherry-pick) | ✓ | verdict + artifact only |
| Latest Review verdict | same | — | ✓ |
| Workspace anchor | repositoryRuntime.currentWorkspace() (honest null when none) | ✓ | ✓ |
| Validator configuration | pinned stage policy (`validatorIdsOf`, the Sprint-13 evidence gate's authority) | — | ✓ |
| Six evidence slots | frozen `REQUIRED_QA_EVIDENCE_SLOTS` | — | ✓ |
| Latest validation batch metadata | validationStore.listByRun (newest-first) | — | ✓ |
| Acceptance criteria | NOT CANONICALLY AVAILABLE | `null` (labeled) | — |

Subject rule (§9, T18-07 subject-anchor preserved): the run's CURRENT delivering WORK task
from its own pinned graph — a corrective child (lineage parent inside the run's work tasks)
always wins (round, then recency, then id). The instrumental review/qa task is never the
business subject; the reviewer names the subject FROM its context and the canonical report
records it (proven: the round-two report's subjectTaskId is the T1 task).

Every projected field is classified (§24) in-band: `AUTHORITATIVE_FACT` / `CANONICAL_REF` /
`NON_AUTHORITY_PRESENTATION` — presentation strings never become domain truth. Bounds follow
the supervisor-context convention (count caps + visible `truncated` flags; per-byte token
estimate governs the provider window; no silent truncation).

## 3. Token safety (§14/§20)

Both handlers run the T19-02 token-budget kernel in STATELESS projection mode
(`decideBoundedContextBudget`) on the COMPLETE rendered request (projection JSON +
structured keys) BEFORE the pinned round. The window comes from the trusted durable catalog
via the run's pinned binding; unknown window fails closed (`BOUNDED_CONTEXT_WINDOW_UNKNOWN`);
overflow fails closed (`SESSION_TOKEN_BUDGET_EXCEEDED`) with provider call count 0. NO Session
is created for budgeting. Proven by §41.12-14 and §42.29-30.

## 4. Freshness, restart, crash (§12/§19/§31/§32)

Every invocation re-reads canonical state — no cached prompt exists (the handlers are
stateless functions of durable rows). A process restart is nothing but a fresh invocation:
the same required facts are reconstructed from canonical state (§41.11, §42.28 — a fresh
composition over the same database rebuilds the full review/QA context). Because there is no
transcript, no transcript can be missing. Changed truth wins: a newer subject, review or
validation is what the next invocation sees (§41.9, §42.24-26).

## 5. Placeholder cleanup (§23)

Confirmed present and REMOVED in the Reviewer/QA production context:
- `company.id = <session actor>` → the run row's REAL companyId (also projected in-band).
- `workflowVersion = 'pinned'` → the run's REAL pinned versionId; `workflow.id` → the REAL
  workflowId.
- objective placeholder → the canonical Goal objective (presentation fallback only when no
  goal artifact exists).

The Developer runtime's skeleton carried the same two placeholders; corrected to the real
`workflowId`/`versionId`, and its authoritative projection now states the real
company/run/version identities in-band (§37). Unavailable facts (acceptance criteria) are
projected as labeled nulls — never fabricated (§25/§26; Planning/Handoff remain future work).

## 6. Role separation (§6/§21/§22)

Structurally: the projectors take no session-kernel dependency; Developer residue enters the
active context ONLY through the session runtime's §9-eligible read; Reviewer/QA/Supervisor
messages never contain `# Session residue` or any Developer output text (§44.34-37). The
Supervisor was audited and NOT changed: it still reconstructs Goal/Run/subject/latest
Review/latest Validation/lineage/allowed actions/Decision history per turn, and reads no
Developer Session.

## 7. Authority and QA semantics preserved (§17/§18/§29/§30)

The strict output contracts are untouched: verdict `PASS|CHANGES_REQUESTED|BLOCKED` through
the canonical ReviewFindingsSink; the validation candidate through the canonical
ValidationService (task-keyed command identity). No prose is parsed. Validator configuration
is projected READ-ONLY from the pinned policy; QA context cannot grant validator authority,
select unauthorized validators, change the ToolRegistry or the evidence slots. The six frozen
evidence slots, latest-batch-wins, repository anchoring, anti-cherry-pick and the
EvidenceGuard are unchanged. One engine fix was required: the carrier's RECOVERY path
(`routeTask`) no longer demands a canonical sink for non-candidate envelopes (a corrective
work task's `companyos:work-role-work` envelope has none by design); the LIVE path stays
strict.

## 8. Tenants, secrets, tools (§37/§39/§40)

Company/run/task scoping is inherited from the durable rows the projectors read; a foreign
tenant hits the existing NOT_FOUND convention inside the turn and the loop surfaces it with
ZERO role invocations (§41.10, §42.27). No secret surface was added: prompts carry no keys,
vault values, headers or credentials; redaction rides the existing seams. Reviewer/QA receive
NO tools (no toolIds on the pinned round — unchanged), and no tool authority changed.

## 9. Acceptance (§45/§46)

`tests/sprint19/t19-04-bounded-context.test.ts` (17 tests): the 37 required points (§41
Reviewer 1-14, §42 QA 15-30, §43 placeholders 31-33, §44 role isolation 34-37) plus the
production acceptance (Developer → Reviewer → QA through the REAL loop, three distinct
role-appropriate contexts) and the corrective acceptance (T0 Developer → CHANGES_REQUESTED →
T1 Developer session → Reviewer PASS → QA PASS → COMPLETE, lifecycle green, T1 session
parent = T0). All against `composeCoreServices` with the trusted kind registrations, the real
session kernel, the real projectors, the real pinned executions/provider/sinks, and a
context-aware routing provider that answers each role FROM the context it received.

## 10. No schema / no authority (§47/§48)

New table NO; migration NO; Session schema change NO; AgentExecution schema change NO;
authority added NO; tool added NO; IPC NO; renderer NO.

## 11. Remaining Sprint-19 gaps

- Acceptance criteria / change-set summaries / explicit dependency lists: NOT CANONICALLY
  AVAILABLE (future Planning / Structured Handoff).
- Workspace-positive anchor projection: the seam is wired
  (`repositoryRuntime.currentWorkspace()`); the E2E suite proves the honest-null rendering —
  a workspace-open production run is covered by the Sprint-17 suites on the same seam.
- Real production provider integration (Sprint-18 closeout handoff item 6).
