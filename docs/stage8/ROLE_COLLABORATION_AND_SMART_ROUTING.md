# ROLE COLLABORATION + SMART MODEL ROUTING — Stage 8

Status: FROZEN (Stage 8)
Date: 2026-10-02

Stage 8 adds two tightly-coupled capabilities on top of Stage 6 (ModelPool) and
Stage 7/7B (Dynamic Role Orchestration):

- **A. Role Collaboration V1** — roles transfer professional work through
  DURABLE OBJECTS via the Professional Handoff Contract. No peer chat, no
  second truth.
- **B. Smart Model Routing V1** — deterministic, explainable, non-adaptive
  routing inside the existing CompanyOS selection seam. No LLM router, no
  tournament, no hidden fallback, no learning.

```
Goal → Plan → Task → ProfessionalResponsibilityRequirement
    → RoleResolver (catalog match / deterministic dynamic synthesis)
    → RoleInstance (run-scoped; requirements + routing hint, NO model truth)
    → ProfessionalHandoff → acceptHandoff → RoleContextEnvelope (bounded)
    → Smart Router (hard filter → weighted scoring → tie-break)
    → RoutingDecision → ExecutionAttempt.SelectedModelSnapshot (ATTEMPT-owned)
    → ExecutorProvider (via broker; credential injected by CompanyOS)
```

## A. Role Collaboration V1 (`apps/desktop/src/executor/role-collaboration.ts`)

### Professional Handoff Contract (closed field set)

| Field | Meaning |
|---|---|
| handoffId | deterministic id of the handoff object |
| producerRoleInstanceId / consumerRoleInstanceId | the two run-scoped roles (never equal) |
| sourceTaskId / targetTaskId | the canonical Tasks the work moves between (never equal) |
| artifactRefs / evidenceRefs / decisionRefs | DURABLE object references (ids only, never content) |
| acceptanceCriteria | what the consumer's output must satisfy |
| knownRisks | risks transferred with the work |
| remainingQuestions | open questions to resolve or escalate |
| handoffReason | professional rationale (not chatter) |

There is deliberately NO message/transcript field, so raw chain-of-thought, a
full private transcript, or hidden reasoning cannot be smuggled through the
contract. `FORBIDDEN_HANDOFF_FIELDS` states the exclusion mechanically.

### Failure semantics (closed set, fail loud, never silent fallback)

`HANDOFF_INPUT_MISSING` · `HANDOFF_ARTIFACT_INVALID` ·
`HANDOFF_AUTHORITY_MISMATCH` · `HANDOFF_CONTEXT_BUILD_FAILED` ·
`REVIEW_INDEPENDENCE_VIOLATION` · `COLLABORATION_DEPENDENCY_BLOCKED`

### Derived projection (read model, never truth)

`projectRoleCollaboration` derives every role status from canonical Task state
and lists pending handoffs with `waitingOn: 'source-not-done' |
'consumer-not-started'`. The projection stores nothing and mutates nothing:
the PM/coordinator coordinates by PRODUCING handoffs — it is not a scheduler
and owns no scheduling truth. No new persistence table is introduced; durable
handoffs live in the existing frozen `handoffs` / `handoff_refs` inventory.

### Reviewer independence

An independent reviewer must be a different RoleInstance AND a different
ExecutionAttempt; its context envelope is structurally summary-only (refs,
criteria, decision summaries). A smuggled raw-context key on the envelope is a
`REVIEW_INDEPENDENCE_VIOLATION` — mechanically checked.

## B. Smart Model Routing V1 (`apps/desktop/src/executor/smart-model-router.ts`)

### Static traits (`ModelProfile.routingTraits`, optional)

| Trait | Values |
|---|---|
| qualityTier | ECONOMY / BALANCED / STRONG / PREMIUM |
| costTier | LOW / MEDIUM / HIGH |
| latencyTier | FAST / BALANCED / SLOW |
| reliabilityClass | STANDARD / HIGH / CRITICAL |

Ordinal tiers only — the router never invents a numeric price. A Stage 6
profile without traits stays fully usable for Stage 6 selection; the Smart
Router rejects it with `ROUTING_TRAITS_ABSENT` rather than guessing.

### Pipeline (order is the contract)

1. **Hard filter** (`ROUTING_HARD_FILTER_STAGES`): disabled → traits absent →
   capabilities → tools → structured output → context window → provider
   allow-list → exclusions → policy quality floor → policy cost ceiling →
   policy latency ceiling → risk reliability floor → complexity quality floor
   → pack floors. Rejected candidates never resurrect.
2. **Deterministic weighted scoring**: integer arithmetic over ordinal ladders
   (`0/33/67/100` quality, `100/50/0` cost & latency, `0/50/100` reliability),
   with the quality weight raised by the risk bonus and the complexity bonus.
3. **Declared tie-breaker**: `profile-id-asc` | `cost-then-profile-id` |
   `quality-then-profile-id`.

Empty eligible set ⇒ `MODEL_CAPABILITY_MISMATCH` (fail loud). There is no
hidden fallback to "any enabled profile".

### Policy fixtures (`ModelRoutingPolicyV1`, versioned)

| Fixture | Weights (q/c/l/r) | Hard constraints | Tie-breaker |
|---|---|---|---|
| QUALITY_FIRST | 6/1/1/3 | min quality BALANCED | quality-then-profile-id |
| BALANCED | 3/2/2/2 | min quality ECONOMY | profile-id-asc |
| COST_AWARE | 1/6/2/1 | min quality ECONOMY, max cost MEDIUM | cost-then-profile-id |

`riskAdjustment` (reliability floor + quality-weight bonus by risk) and
`complexityAdjustment` (quality floor + quality-weight bonus by complexity)
are policy-owned, static and versioned. `policyVersion` rides on every
`RoutingDecision` so any decision is reproducible.

### Pack routing preferences vs operator pins

- `RoleDefinition.routingPreference` (pack hint): selects a policy fixture and
  may raise minimum tiers. It has NO pin field — a Pack can never pin a
  commercial model, and never grants authority.
- `pinnedProfileId` (operator/task level): audit-visible on the decision
  (`decisionPolicy: 'pinned'`, `selectedReason: 'OPERATOR_PIN'`), fail-closed
  when unknown or disabled. Not the normal user model-selection path.

### RETRY ≠ REROUTE

`classifyRoutingChange(previous, next)` returns one of `NONE` (a retry keeps
the route), `PIN_CHANGED`, `COMPLEXITY_CHANGED`, `RISK_CHANGED`,
`REQUIREMENTS_CHANGED`, `POLICY_CHANGED`, `CANDIDATE_SET_CHANGED`. Because
selection is deterministic, identical declared inputs reproduce the identical
route; a different profile with identical inputs means the candidate set
changed (e.g. a profile was disabled).

### Estimated cost contract

`RoutingCostEstimate` is always labelled: `ESTIMATED` (with
`estimatedUSD` + basis from static cost metadata) or `UNAVAILABLE` (with a
basis string). An estimate is never presented as an authoritative price, and
routing never requires one.

### Decision record (`RoutingDecision`)

`decisionId` (`route-<attemptId>`, deterministic), `attemptId`, `taskId`,
`roleInstanceId`, `selectedModelProfileId`, `selectedModel` (the
per-attempt snapshot — the ATTEMPT owns it, ARCH-042), `policyId`,
`policyVersion`, `routingProfile`, `taskComplexity`, `riskLevel`,
`decisionPolicy`, `requiredCapabilities`, `eligibleCandidates`,
`rejectedCandidates` (with closed reasons), `scoreBreakdown` (integer
per-candidate breakdown + applied weights), `selectedReason`, `estimatedCost`.

## Architecture laws (automated, both-direction probes)

| Law | Statement |
|---|---|
| ARCH-040 | Router is a pure deterministic decision function: no LLM, no tournament, no adaptive, no hidden fallback, no provider/executor import, no network call. |
| ARCH-041 | Collaboration has no second truth and no peer chat: forbidden table categories + identifier scan; no scheduling mutators. |
| ARCH-042 | The RoleInstance never owns a selected model: ExecutionAttempt owns the snapshot; routing never writes onto a role. |

## Honest boundaries (NOT claimed)

- `LIVE_ROUTING_EVIDENCE = EXTERNAL_BLOCKED` — no real provider credential is
  available in this environment; all routing evidence is deterministic,
  in-process, and reproducible.
- Collaboration is contract + projection only; no collaboration UI, no
  durable-write pipeline wiring, and no execution runtime integration ships in
  Stage 8.
- The estimated-cost contract is deliberately coarse (static metadata ×
  estimated tokens); no cost governor ships.

## Backlog (explicitly NOT started)

Adaptive Historical Router · Cost Governor · Peer Chat · Free-form
Multi-Agent Team · Browser · Memory Governor · Hardened Sandbox · Real
Project Bug Bash · V1 Freeze.
