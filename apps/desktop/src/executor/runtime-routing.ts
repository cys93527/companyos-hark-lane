/**
 * STAGE 8B — the RUNTIME bridge between canonical CompanyOS state and the
 * Stage 8 Smart Model Router (decision layer).
 *
 * This module owns NO truth of its own. Everything it produces is a
 * deterministic derivation from canonical inputs:
 *   - the canonical `roles` table (via a seeded RoleCatalog) supplies the role
 *     responsibility and capabilities; unknown roles fall back to Stage 7's
 *     deterministic dynamic synthesis — never a hidden default employee;
 *   - the Work Package projection (the canonical derived execution view of ONE
 *     task) supplies the task complexity and the risk class;
 *   - the ModelPool (the Stage 6 registry) supplies the candidate profiles;
 *   - the Stage 8 Smart Router makes ONE deterministic decision per attempt.
 *
 * RoutingMode (Boss Stage 8B §9): an attempt has exactly ONE selection
 * authority path. DETERMINISTIC_V1 keeps the Stage 6 deterministic selector as
 * the selection owner (zero behavior change); SMART_ROUTER_V1 routes the
 * attempt's selection through the Smart Router BEFORE the kernel is invoked and
 * the provider consumes the decision. The two never compete for one attempt.
 */
import {
  canonicalJson,
  domainError,
  err,
  ok,
  sha256Hex,
  type DomainError,
  type ProfessionalResponsibilityDeclaration,
  type Result,
} from '@companyos/core';
import type {SelectedModelRoute} from '@companyos/engine';

import type {ModelPool, ModelProfile, RoutingProfileId, SelectedModelSnapshot} from './model-pool.js';
import {
  RoleCatalog,
  resolveRole,
  type ExecutionBudget,
  type ProfessionalResponsibilityRequirement,
  type RoleInstance,
  type ResolvedRoleSpecification,
} from './role-orchestration.js';
import {
  routeModelForAttempt,
  type ModelRoutingPolicyV1,
  type RoutingDecision,
  type TaskComplexity,
  type RoutingRiskLevel,
} from './smart-model-router.js';
import type {WorkPackage} from '@companyos/engine';

// ---------------------------------------------------------------------------
// Routing mode (Boss §9 — one selection authority per attempt)
// ---------------------------------------------------------------------------

export type RoutingMode = 'DETERMINISTIC_V1' | 'SMART_ROUTER_V1';

export type {ProfessionalResponsibilityDeclaration};

export const DEFAULT_ROUTING_MODE: RoutingMode = 'DETERMINISTIC_V1';

/** Canonical role rows (the frozen `roles` table shape) the catalog seeds from. */
export interface CanonicalRoleRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly requiredCapabilities: readonly string[];
}

/**
 * Seed a Stage 7 RoleCatalog from the CANONICAL roles table. The catalog stays
 * a pack-extensible registry (industry-neutral); canonical roles are one
 * registration source. A deployment that adds packs registers more.
 */
export const seedRoleCatalogFromCanonical = (rows: readonly CanonicalRoleRow[]): RoleCatalog => {
  const catalog = new RoleCatalog();
  for (const row of rows) {
    catalog.register({
      roleDefinitionId: row.key === '' ? row.id : row.key,
      displayName: row.name,
      professionalResponsibility: row.description === '' ? row.name : row.description,
      responsibilityDescription: row.description === '' ? row.name : row.description,
      requiredCapabilities: [...row.requiredCapabilities],
      preferredCapabilities: [],
      toolNeeds: [],
      contextNeeds: [],
      validationResponsibilities: [],
      independenceClass: 'implementer',
      defaultExecutionBudget: {maxTurns: 20, maxToolCalls: 50, tokenBudget: 32_768},
      packOwner: 'canonical-roles',
      domain: 'canonical',
    });
  }
  return catalog;
};

// ---------------------------------------------------------------------------
// PlanItem → ProfessionalResponsibility → resolved seat (Boss Stage 8C §1-§6)
// ---------------------------------------------------------------------------

/**
 * Derive one plan item's ProfessionalResponsibilityRequirement (Stage 7 §4):
 * the DECLARED responsibility when the plan carries one (an optional model
 * REQUEST), else a deterministic fallback from the item's own semantics —
 * the objective IS the responsibility intent, and a deployment-declared
 * operation kind (a verify/evaluate gate) is independent evaluator work.
 * Deterministic only: no LLM, no keyword matching, no fixed role template.
 */
export const professionalResponsibilityOfPlanItem = (input: {
  readonly objective: string;
  readonly taskKind: string;
  readonly workKind: string;
  readonly declared?: ProfessionalResponsibilityDeclaration;
}): ProfessionalResponsibilityRequirement => ({
  responsibilityIntent: input.declared?.responsibilityIntent ?? input.objective,
  requiredCapabilities: [...(input.declared?.requiredCapabilities ?? [])],
  expectedOutputKind: (input.declared?.independenceRequired ?? input.taskKind !== input.workKind) ? 'validation' : 'artifact',
  validationExpectation: (input.declared?.independenceRequired ?? input.taskKind !== input.workKind)
    ? 'independent review of the predecessor work'
    : 'acceptance criteria met',
  independenceRequired: input.declared?.independenceRequired ?? input.taskKind !== input.workKind,
  riskLevel: input.declared?.riskLevel ?? 'low',
});

/**
 * The deterministic seat id of a DYNAMIC professional role: a stable hash of
 * the canonical requirement (intent + sorted capabilities + independence +
 * risk). Identical responsibility ⇒ identical seat, so compilation is
 * idempotent and a restart reconstructs the same seat from durable truth.
 */
export const dynamicProfessionalSeatIdOf = (requirement: ProfessionalResponsibilityRequirement): string => {
  const canonical = canonicalJson({
    responsibilityIntent: requirement.responsibilityIntent,
    requiredCapabilities: [...requirement.requiredCapabilities].sort(),
    independenceRequired: requirement.independenceRequired,
    riskLevel: requirement.riskLevel,
  });
  return `drole_${sha256Hex(canonical).slice(0, 16)}`;
};

export interface ResolvedProfessionalSeat {
  /** The canonical seat id pinned into the task profile (catalog key or drole_*). */
  readonly seatId: string;
  readonly specification: ResolvedRoleSpecification;
}

/**
 * Resolve one responsibility into the professional seat (Boss Stage 8C §4):
 * the Stage 7 RoleResolver — deterministic catalog match on the declared
 * capabilities first, DETERMINISTIC_DYNAMIC_ROLE_SPEC otherwise. A
 * responsibility with NO declared capabilities skips catalog matching (an
 * empty requirement would match arbitrary templates) and synthesizes the
 * dynamic spec directly. Never rol.worker, never a fixed team template.
 */
export const resolveProfessionalSeat = (
  catalog: RoleCatalog,
  requirement: ProfessionalResponsibilityRequirement,
): ResolvedProfessionalSeat => {
  if (requirement.requiredCapabilities.length > 0) {
    const spec = resolveRole(catalog, requirement);
    if (!spec.ok) {
      // resolveRole's dynamic synthesis never fails; a failure here is a
      // programming error — fail loud rather than guessing a seat.
      throw new Error(`professional seat resolution failed: ${spec.error.message}`);
    }
    return {
      seatId: spec.value.roleDefinitionId ?? dynamicProfessionalSeatIdOf(requirement),
      specification: spec.value,
    };
  }
  const seatId = dynamicProfessionalSeatIdOf(requirement);
  return {
    seatId,
    specification: {
      roleDefinitionId: null,
      displayName: requirement.responsibilityIntent.slice(0, 60),
      professionalResponsibility: requirement.responsibilityIntent,
      requiredCapabilities: [],
      toolNeeds: [],
      contextNeeds: [],
      independenceClass: requirement.independenceRequired ? 'independent-reviewer' : 'implementer',
      executionBudget: {maxTurns: 20, maxToolCalls: 50, tokenBudget: 32_768},
      origin: 'dynamic-synthesis',
      packOwner: null,
      domain: 'dynamic',
      routingPreference: null,
    },
  };
};

/**
 * Resolve a canonical role id into a run-scoped RoleInstance (Stage 7
 * resolver: catalog match → deterministic dynamic synthesis). The roleId is the
 * task's pinned execution seat — the SAME seat the ExecutionAttempt claim
 * records — so the role truth and the attempt truth agree by construction.
 */
export const resolveCanonicalRole = (
  catalog: RoleCatalog,
  input: {
    readonly roleId: string;
    readonly roleName?: string;
    readonly roleCapabilities?: readonly string[];
    /** STAGE 8C: the DERIVED requirement pinned beside the task profile (durable truth). */
    readonly pinnedResponsibility?: ProfessionalResponsibilityDeclaration | null;
    readonly runId: string;
    readonly companyId: string;
    readonly roleInstanceId: string;
  },
): Result<RoleInstance, DomainError> => {
  const requirement: ProfessionalResponsibilityRequirement = input.pinnedResponsibility !== undefined && input.pinnedResponsibility !== null
    ? {
        responsibilityIntent: input.pinnedResponsibility.responsibilityIntent,
        requiredCapabilities: [...(input.pinnedResponsibility.requiredCapabilities ?? [])],
        expectedOutputKind: (input.pinnedResponsibility.independenceRequired ?? false) ? 'validation' : 'artifact',
        validationExpectation: (input.pinnedResponsibility.independenceRequired ?? false) ? 'independent review' : 'acceptance criteria met',
        independenceRequired: input.pinnedResponsibility.independenceRequired ?? false,
        riskLevel: input.pinnedResponsibility.riskLevel ?? 'low',
      }
    : {
        responsibilityIntent: input.roleName ?? `Professional responsibility of role ${input.roleId}`,
        requiredCapabilities: input.roleCapabilities ?? [],
    expectedOutputKind: 'artifact',
    validationExpectation: 'validated',
    independenceRequired: false,
    riskLevel: 'low',
  };
  const resolution = catalogRoleResolution(catalog, requirement, input.roleId);
  if (!resolution.ok) return resolution;
  return ok({
    roleInstanceId: input.roleInstanceId,
    runId: input.runId,
    companyId: input.companyId,
    specification: resolution.value,
    professionalResponsibility: resolution.value.professionalResponsibility,
    capabilityRequirements: [...resolution.value.requiredCapabilities],
    contextPolicy: {
      includeGoalSummary: true,
      includePlanItem: true,
      includeRelevantDecisions: true,
      includeArtifactRefs: true,
      includeAcceptanceCriteria: true,
      excludeRawTranscripts: true,
      excludeIrrelevantTaskContext: true,
    },
    executionBudget: resolution.value.executionBudget,
    associatedTaskIds: [],
    modelSelectionRequirements: deriveSelectionRequirements(resolution.value.requiredCapabilities),
  });
};

/**
 * Catalog match on the canonical role id first (deterministic Stage 7
 * priority), then deterministic dynamic synthesis from the responsibility
 * requirement itself. Fail-closed when neither yields a specification.
 */
const catalogRoleResolution = (
  catalog: RoleCatalog,
  requirement: ProfessionalResponsibilityRequirement,
  roleId: string,
): Result<ResolvedRoleSpecification, DomainError> => {
  const found = catalog.get(roleId);
  if (found.ok) {
    return ok({
      roleDefinitionId: found.value.roleDefinitionId,
      displayName: found.value.displayName,
      professionalResponsibility: found.value.professionalResponsibility,
      requiredCapabilities: [...found.value.requiredCapabilities],
      toolNeeds: [...found.value.toolNeeds],
      contextNeeds: [...found.value.contextNeeds],
      independenceClass: found.value.independenceClass,
      executionBudget: found.value.defaultExecutionBudget,
      origin: 'catalog-match',
      packOwner: found.value.packOwner,
      domain: found.value.domain,
      routingPreference: found.value.routingPreference ?? null,
    });
  }
  // Deterministic dynamic synthesis (Stage 7 §12) — never a hidden default role.
  return ok({
    roleDefinitionId: null,
    displayName: requirement.responsibilityIntent.slice(0, 60),
    professionalResponsibility: requirement.responsibilityIntent,
    requiredCapabilities: [...requirement.requiredCapabilities],
    toolNeeds: [],
    contextNeeds: [],
    independenceClass: 'implementer',
    executionBudget: {maxTurns: 20, maxToolCalls: 50, tokenBudget: 32_768},
    origin: 'dynamic-synthesis',
    packOwner: null,
    domain: 'dynamic',
    routingPreference: null,
  });
};

const deriveSelectionRequirements = (capabilities: readonly string[]) => ({
  requiredCapabilities: capabilities.filter(
    (cap) => cap === 'tool-calling' || cap === 'structured-output' || cap === 'streaming' || cap === 'long-context',
  ),
  requiresTools: capabilities.some((cap) => cap.startsWith('tool') || cap.startsWith('file') || cap.startsWith('process') || cap.startsWith('build') || cap.startsWith('test')),
  requiresStructuredOutput: capabilities.some((cap) => cap.startsWith('validation') || cap.startsWith('review') || cap.startsWith('structured')),
});

// ---------------------------------------------------------------------------
// Complexity + risk derivation (canonical data only — no LLM inference)
// ---------------------------------------------------------------------------

/**
 * The plan-shape-invariant semantic complexity factors of one Work Package
 * (LIVE-SMOKE-FIX-05). DETAIL IS NOT DIFFICULTY: the ONE canonical semantic
 * signal is the breadth of genuine prerequisite integration — the number of
 * DISTINCT pinned-DAG predecessor stages whose outputs the task must consume.
 * Presentation-level raw counts are EXCLUDED by contract because the same
 * semantic work is representable at any granularity without changing what the
 * executor must actually do:
 *
 *   - acceptanceCriteriaCount: planner validation verbosity (one composite
 *     criterion vs five equivalent atomic rows). The criteria are the frozen
 *     VALIDATION contract consumed by validators/QA — not execution difficulty.
 *   - taskInputsCount: a normalized reference map (it even carries purely
 *     administrative keys such as corrective lineage); no per-key difficulty
 *     semantics exist.
 *   - artifactRefsCount: how many pieces the PREDECESSOR chose to publish its
 *     output in (files vs documents) — the predecessor's publishing style, and
 *     already implied by the dependency's existence.
 *
 * The dependency count itself is canonical, not planner prose: the Work Package
 * projector derives it from the PINNED workflow version's DAG edges, deduplicated
 * by predecessor stage id and order-free. Required capabilities and risk remain
 * SEMANTIC signals but act through their OWN canonical lanes — the router's hard
 * capability filters and the risk reliability floor — never through complexity.
 */
export interface RuntimeComplexityFactors {
  /** Distinct pinned-DAG predecessor stages whose outputs this task integrates. */
  readonly dependencyCount: number;
}

/**
 * Deterministic task complexity from the ONE canonical semantic factor. The
 * ladder thresholds are unchanged from V1 (0 LOW, 1 MEDIUM, 2-3 HIGH, 4+
 * VERY_HIGH) — only the INPUT changed: from a representation-sensitive sum of
 * raw list lengths to the deduplicated canonical prerequisite count. Splitting
 * a criterion, duplicating references, reordering, or planner verbosity cannot
 * move a task across classes; adding one more GENUINE prerequisite stage can
 * (monotone in real orchestration breadth only).
 */
export const deriveRuntimeTaskComplexity = (factors: RuntimeComplexityFactors): TaskComplexity => {
  if (factors.dependencyCount <= 0) return 'LOW';
  if (factors.dependencyCount === 1) return 'MEDIUM';
  if (factors.dependencyCount <= 3) return 'HIGH';
  return 'VERY_HIGH';
};

/**
 * Deterministic risk class from canonical facts: a run approval requirement or
 * a deployment-declared high-risk task kind raises the class. The kind sets are
 * TRUSTED DEPLOYMENT DATA (the same authority class as the provider routes).
 */
export const deriveRuntimeRiskLevel = (input: {
  readonly taskKind: string;
  readonly approvalRequired: boolean;
  readonly highRiskKinds?: readonly string[];
  readonly mediumRiskKinds?: readonly string[];
}): RoutingRiskLevel => {
  if (input.approvalRequired) return 'high';
  if (input.highRiskKinds?.includes(input.taskKind) === true) return 'high';
  if (input.mediumRiskKinds?.includes(input.taskKind) === true) return 'medium';
  return 'low';
};

/**
 * Complexity factors read from the canonical Work Package projection: the
 * DISTINCT predecessor stage ids of the pinned DAG (deduplicated again here —
 * the invariant belongs to the derivation, not to one producer). Order-free;
 * representation-level collections (criteria/inputs/artifact refs) are
 * deliberately NOT factors (see RuntimeComplexityFactors).
 */
export const complexityFactorsOfWorkPackage = (pkg: WorkPackage): RuntimeComplexityFactors => ({
  dependencyCount: new Set(pkg.dependencies.map((dependency) => dependency.stageId)).size,
});

/**
 * The minimal PURE complexity explanation (routing auditability; LIVE-SMOKE-FIX-05
 * §9): the canonical semantic factor labels plus the derived class. Deterministic,
 * safe identifiers only — never prompt/reasoning content. This is a pure
 * projection re-derivable at any time from the durable Work Package; nothing is
 * persisted here, so no second routing truth is created (the RoutingDecision
 * remains the durable evidence owner of `taskComplexity`).
 */
export interface RuntimeComplexityExplanation {
  readonly semanticFactors: readonly string[];
  readonly complexity: TaskComplexity;
}

export const explainRuntimeTaskComplexity = (pkg: WorkPackage): RuntimeComplexityExplanation => ({
  semanticFactors: [...new Set(pkg.dependencies.map((dependency) => dependency.stageId))]
    .sort()
    .map((stageId) => `dag-predecessor:${stageId}`),
  complexity: deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(pkg)),
});

// ---------------------------------------------------------------------------
// Route + evidence projection (Boss §5-§7)
// ---------------------------------------------------------------------------

export interface RuntimeRoutingOutcome {
  readonly decision: RoutingDecision;
  /** The CompanyOS-selected route the provider consumes verbatim. */
  readonly route: SelectedModelRoute;
  /** The selection evidence recorded on the attempt's dispatch row. */
  readonly evidenceJson: string;
  /** The run-scoped role this attempt executes as (requirements owner only). */
  readonly role: RoleInstance;
  readonly roleBudget: ExecutionBudget;
}

/**
 * Route ONE ExecutionAttempt: resolve the canonical role, derive complexity and
 * risk from the Work Package, run the Smart Router, and project the decision
 * into the provider-consumable route plus the durable evidence payload.
 *
 * The RoutingDecision is selection EVIDENCE; the ExecutionAttempt owns the
 * final SelectedModelSnapshot (the route's identity fields). Raw reasoning is
 * never part of the evidence — the router's explanation is deterministic and
 * machine-readable.
 */
export const routeRuntimeAttempt = (input: {
  readonly pool: ModelPool;
  readonly catalog: RoleCatalog;
  readonly attemptId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly roleName?: string;
  readonly roleCapabilities?: readonly string[];
  /** STAGE 8C: the DERIVED requirement pinned beside the task profile (durable truth). */
  readonly pinnedResponsibility?: ProfessionalResponsibilityDeclaration | null;
  readonly runId: string;
  readonly companyId: string;
  readonly workPackage: WorkPackage;
  readonly approvalRequired?: boolean;
  readonly highRiskKinds?: readonly string[];
  readonly mediumRiskKinds?: readonly string[];
  readonly policy?: ModelRoutingPolicyV1;
  readonly pinnedProfileId?: string;
}): Result<RuntimeRoutingOutcome, DomainError> => {
  const role = resolveCanonicalRole(input.catalog, {
    roleId: input.roleId,
    roleName: input.roleName,
    roleCapabilities: input.roleCapabilities,
    pinnedResponsibility: input.pinnedResponsibility,
    runId: input.runId,
    companyId: input.companyId,
    roleInstanceId: `ri_${input.taskId}`,
  });
  if (!role.ok) return role;

  const taskComplexity = deriveRuntimeTaskComplexity(complexityFactorsOfWorkPackage(input.workPackage));
  const riskLevel = deriveRuntimeRiskLevel({
    taskKind: input.workPackage.execution.taskKind,
    approvalRequired: input.approvalRequired === true,
    highRiskKinds: input.highRiskKinds,
    mediumRiskKinds: input.mediumRiskKinds,
  });

  const routed = routeModelForAttempt(input.pool, {
    attemptId: input.attemptId,
    taskId: input.taskId,
    roleInstanceId: role.value.roleInstanceId,
    role: role.value,
    taskComplexity,
    riskLevel,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.pinnedProfileId === undefined ? {} : { pinnedProfileId: input.pinnedProfileId }),
  });
  if (!routed.ok) return routed;

  const inspected = input.pool.inspect(routed.value.selectedModelProfileId);
  if (!inspected.ok) return inspected;
  const profile: ModelProfile = inspected.value;
  const route: SelectedModelRoute = {
    modelProfileId: profile.modelProfileId,
    providerId: profile.providerId,
    modelId: profile.modelId,
    baseURL: profile.endpointURL,
    // The SecretVault POINTER — the broker resolves the real credential upstream.
    credentialRef: profile.credentialRef,
    contextWindow: profile.contextWindowTokens,
    maxTokens: profile.maxOutputTokens,
    configurationVersion: profile.configurationVersion,
  };
  return ok({
    decision: routed.value,
    route,
    evidenceJson: routingDecisionEvidenceOf(routed.value),
    role: role.value,
    roleBudget: role.value.executionBudget,
  });
};

/**
 * The durable evidence projection of a RoutingDecision (Boss §7): the fields
 * that make the selection auditable and reproducible after a restart. No raw
 * reasoning exists to persist — the decision is a deterministic function of
 * declared inputs and the frozen policy.
 */
export const routingDecisionEvidenceOf = (decision: RoutingDecision): string =>
  JSON.stringify({
    decisionId: decision.decisionId,
    attemptId: decision.attemptId,
    taskId: decision.taskId,
    roleInstanceId: decision.roleInstanceId,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    routingProfile: decision.routingProfile,
    taskComplexity: decision.taskComplexity,
    riskLevel: decision.riskLevel,
    decisionPolicy: decision.decisionPolicy,
    selectedProfileId: decision.selectedModelProfileId,
    requiredCapabilities: [...decision.requiredCapabilities],
    eligibleCandidates: [...decision.eligibleCandidates],
    rejectedCandidates: decision.rejectedCandidates.map((r) => ({ profileId: r.profileId, reason: r.reason })),
    scoreBreakdown: decision.scoreBreakdown.map((s) => ({
      profileId: s.profileId,
      quality: s.quality,
      cost: s.cost,
      latency: s.latency,
      reliability: s.reliability,
      total: s.total,
    })),
    selectedReason: decision.selectedReason,
    selectedModel: decision.selectedModel,
  });

export interface RoutingEvidenceProjection {
  readonly decisionId: string;
  readonly attemptId: string;
  readonly policyVersion: number;
  readonly selectedProfileId: string;
  readonly decisionPolicy: 'pinned' | 'hard-filter-and-weighted-score';
  readonly eligibleCandidates: readonly string[];
  readonly rejectedCandidates: readonly { readonly profileId: string; readonly reason: string }[];
  readonly scoreBreakdown: readonly { readonly profileId: string; readonly total: number }[];
}

/** Parse durable routing evidence back (restart reconstruction; unknown shapes fail loud). */
export const parseRoutingEvidence = (json: string): Result<RoutingEvidenceProjection, DomainError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return err(domainError('VALIDATION_FAILED', 'The recorded routing evidence is not valid JSON.', {
      reason: 'ROUTING_EVIDENCE_UNREADABLE',
    }));
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return err(domainError('VALIDATION_FAILED', 'The recorded routing evidence is not an object.', {
      reason: 'ROUTING_EVIDENCE_UNREADABLE',
    }));
  }
  const record = parsed as Record<string, unknown>;
  const attemptId = record['attemptId'];
  const policyVersion = record['policyVersion'];
  const selectedProfileId = record['selectedProfileId'];
  const decisionPolicy = record['decisionPolicy'];
  if (typeof attemptId !== 'string' || typeof policyVersion !== 'number' || typeof selectedProfileId !== 'string') {
    return err(domainError('VALIDATION_FAILED', 'The recorded routing evidence is missing required fields.', {
      reason: 'ROUTING_EVIDENCE_UNREADABLE',
    }));
  }
  if (decisionPolicy !== 'pinned' && decisionPolicy !== 'hard-filter-and-weighted-score') {
    return err(domainError('VALIDATION_FAILED', 'The recorded routing evidence has an unknown decision policy.', {
      reason: 'ROUTING_EVIDENCE_UNREADABLE',
    }));
  }
  return ok({
    decisionId: String(record['decisionId'] ?? ''),
    attemptId,
    policyVersion,
    selectedProfileId,
    decisionPolicy,
    eligibleCandidates: Array.isArray(record['eligibleCandidates']) ? (record['eligibleCandidates'] as string[]) : [],
    rejectedCandidates: Array.isArray(record['rejectedCandidates'])
      ? (record['rejectedCandidates'] as RoutingEvidenceProjection['rejectedCandidates'])
      : [],
    scoreBreakdown: Array.isArray(record['scoreBreakdown'])
      ? (record['scoreBreakdown'] as RoutingEvidenceProjection['scoreBreakdown'])
      : [],
  });
};

// ---------------------------------------------------------------------------
// Budget → kernel execution policy (Boss §17)
// ---------------------------------------------------------------------------

/**
 * Project the role execution budget onto the provider request: the time budget
 * becomes the kernel execution policy (the timeout the kernel runs under), and
 * the turn/tool budgets are enforced against the outcome usage by the dispatch.
 * Returns null when the role declares no time budget (no fabricated limit).
 */
export const budgetTimeoutMsOf = (budget: ExecutionBudget): number | null => budget.timeBudgetMs ?? null;

export interface AttemptUsage {
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly tokens?: number;
}

/**
 * Structured budget verdict: exhausted means the attempt ends with
 * ROLE_EXECUTION_BUDGET_EXHAUSTED while preserving what already exists
 * (artifacts/evidence are durable before this verdict is taken). An unlimited
 * budget never reports exhaustion.
 */
export const budgetVerdictOf = (
  budget: ExecutionBudget,
  usage: AttemptUsage,
): { readonly exhausted: boolean; readonly reason: 'maxTurns' | 'maxToolCalls' | 'tokenBudget' | null } => {
  if (budget.maxTurns !== undefined && (usage.turns ?? 0) > budget.maxTurns) return {exhausted: true, reason: 'maxTurns'};
  if (budget.maxToolCalls !== undefined && (usage.toolCalls ?? 0) > budget.maxToolCalls) {
    return {exhausted: true, reason: 'maxToolCalls'};
  }
  if (budget.tokenBudget !== undefined && (usage.tokens ?? 0) > budget.tokenBudget) {
    return {exhausted: true, reason: 'tokenBudget'};
  }
  return {exhausted: false, reason: null};
};

/**
 * Read the attempt usage a provider exposes in its structured payload. A
 * provider that exposes no usage reports none — the budget is then bounded by
 * the timeout only, never by a fabricated number.
 */
export const attemptUsageOf = (structured: unknown): AttemptUsage => {
  if (typeof structured !== 'object' || structured === null) return {};
  const record = structured as Record<string, unknown>;
  const usage = record['usage'];
  if (typeof usage !== 'object' || usage === null) return {};
  const u = usage as Record<string, unknown>;
  return {
    turns: typeof u['turns'] === 'number' ? u['turns'] : undefined,
    toolCalls: typeof u['toolCalls'] === 'number' ? u['toolCalls'] : undefined,
    tokens: typeof u['tokens'] === 'number' ? u['tokens'] : undefined,
  };
};

/** Snapshot label carried on the role context (evidence, never a re-selection seam). */
export const selectedModelLabelOf = (snapshot: SelectedModelSnapshot): string =>
  `${snapshot.modelProfileId}@${String(snapshot.configurationVersion)}`;

export type {RoutingProfileId};
