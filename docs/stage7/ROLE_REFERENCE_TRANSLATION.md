# STAGE 7 — ROLE REFERENCE TRANSLATION

Approved mechanisms from external projects, translated into CompanyOS-native ownership (Boss §58).

## Orca

| Mechanism | CompanyOS Gap | Decision | Owner | Forbidden |
|---|---|---|---|---|
| Professional role responsibility | No role concept in execution layer | **ADAPT** | `role-orchestration.ts` RoleDefinition.professionalResponsibility | — |
| Role-specific bounded context | Full context shared to all agents | **ADAPT** | `role-orchestration.ts` RoleContextEnvelope | — |
| Deterministic core / selective AI | N/A (already deterministic) | **COMBINE** | Existing Engine + RoleResolver (deterministic priority) | Every step calls LLM |
| Human intervention on authority/risk | N/A (already has Approval) | **COMBINE** | Existing Authority/Approval system | — |
| Goal-oriented orchestration | Already exists (Goal→Plan→Task) | **REJECT second truth** | Existing canonical chain | Orca Goal/Task/Workflow/Memory system |

## Claude Code

| Mechanism | CompanyOS Gap | Decision | Owner | Forbidden |
|---|---|---|---|---|
| Subagent isolated context | No per-role context isolation | **ADAPT** | RoleContextEnvelope (excludes raw transcripts) | — |
| Agent profile (role/model/tools/permissions/budget) | No unified role profile | **COMBINE** | RoleDefinition + selectModelForAttempt + computeEffectiveExecutionPolicy | — |
| Plan/review separation | Exists in Task/Validation | **COMBINE** | Reviewer RoleDefinition independenceClass | — |
| Agent team coordination | N/A for V1 | **DEFER** | — | Claude Team Task system as CompanyOS Task Truth |
| Free-form agent messaging | Not needed for V1 | **REJECT** | — | Unauditable peer chat runtime |
| Fixed agent list | Contradicts dynamic roles | **REJECT** | — | Fixed "Agent 1/2/3" as CompanyOS Role system |

## OpenClaude

| Mechanism | CompanyOS Gap | Decision | Owner | Forbidden |
|---|---|---|---|---|
| Role→ModelProfile routing | Stage 6 has pool but no role input | **ADAPT** | `selectModelForAttempt` connects RoleInstance modelSelectionRequirements → ModelPool (Stage 7B corrected owner) | — |
| Per-attempt model lock | No lock mechanism | **ADAPT** | ExecutionAttempt owns the SelectedModelSnapshot (Stage 7B correction; `RoleInstance.modelLock` REMOVED — ARCH-042) | Per-role modelLock |
| maxSteps/execution budget | No per-role budget | **ADAPT** | ExecutionBudget + `roleExecutionBudgetExhausted` | Infinite agent loop |
| Usage/cost observability | Stage 6 has contract | **COMBINE** | ModelUsageRecord shape in model-pool.ts | — |
| Provider-neutral routing | Already exists | **COMBINE** | ModelPool endpointURL as data | — |
| Hidden fallback | Contradicts fail-closed | **REJECT** | — | Silent model switch on retry |
| Plaintext key | Contradicts secret law | **REJECT** | — | Raw key in child env |
| Agent name = fixed model | Contradicts Role≠Model | **REJECT** | — | roleId→modelId binding |

## Stage 8 — collaboration + smart routing additions

Approved mechanisms from the same external references, translated for Stage 8 §A/§B.

| Mechanism | CompanyOS Gap | Decision | Owner | Forbidden |
|---|---|---|---|---|
| Professional handoff between roles | No structured cross-role transfer | **ADAPT** | `role-collaboration.ts` ProfessionalHandoff (durable refs + summaries) | Raw chain-of-thought / transcript / hidden reasoning on a handoff |
| Role collaboration read model | No way to observe a team | **ADAPT** | `RoleCollaborationProjection` (DERIVED only) | A second collaboration truth (role_messages / agent_chat / team_task_store / scheduler) |
| PM/coordinator role | — | **COMBINE** | Coordinator RoleDefinition + handoffs it produces | PM as a scheduler; task-state mutators in collaboration |
| Reviewer independence | Review could share implementation context | **COMBINE** | `assertReviewerIndependence` + separate RoleInstance/ExecutionAttempt | Reviewing the producer's own attempt |
| Ordinal quality/cost/latency tiers | Numeric price scoring = false precision | **ADAPT** | `model-pool.ts` QualityTier/CostTier/LatencyTier/ReliabilityClass + ordinal ladders | Floating "score = quality × 2.3" precision |
| Policy fixtures (quality-first / balanced / cost-aware) | No deterministic weighting | **ADAPT** | `ROUTING_POLICIES` + `ModelRoutingPolicyV1` (versioned) | Adaptive/historical weighting |
| Pack routing preference | Packs know their domain needs | **ADAPT** | `RoleDefinition.routingPreference` (policy fixture + minimum tiers) | Pack pinning a commercial model; pack granting authority |
| Operator pin | Sometimes a human must force a route | **ADAPT** | `routeModelForAttempt(pinnedProfileId)` — audit-visible, fail-closed | Pack-level pins; silent fallback when the pin is invalid |
| RETRY vs REROUTE | "Same model" conflated with "rerouted" | **ADAPT** | `classifyRoutingChange` (closed cause set) | Claiming determinism while inputs changed silently |
| Smart router (LLM/tournament/adaptive) | — | **REJECT** | — | LLM-as-router, model tournament/voting, adaptive learning, hidden fallback |
| Peer chat runtime | — | **REJECT** | — | Free-form agent messaging as collaboration truth |
