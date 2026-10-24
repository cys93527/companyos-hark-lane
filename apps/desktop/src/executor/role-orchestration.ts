/**
 * STAGE 7 — DYNAMIC ROLE ORCHESTRATION (Boss §1-§56).
 *
 * CompanyOS-native implementation translating the approved mechanisms from
 * Orca (professional role, bounded context, deterministic core, selective AI),
 * Claude Code (isolated subagent context, agent profile composition), and
 * OpenClaude (per-attempt model lock, role-aware routing) — into the existing
 * CompanyOS canonical truth chain. No second Goal/Task/Workflow/Authority/
 * Model/ExecutionAttempt truth is created (Boss §1/§13/§57).
 *
 * The Core is INDUSTRY-NEUTRAL (Boss §5): it understands Professional
 * Responsibility, Required Capabilities, Independence Requirements, and
 * Execution Budget — never software-specific role names. Concrete role
 * templates belong to Packs via the RoleCatalog (Boss §7).
 */
import {domainError, err, ok, type DomainError, type Result} from '@companyos/core';
import {
  type ModelPool,
  type ModelSelectionRequirements,
  type QualityTier,
  type ReliabilityClass,
  type RoutingProfileId,
  type SelectedModelSnapshot,
  selectModelProfile,
} from './model-pool.js';

// ---------------------------------------------------------------------------
// Professional Responsibility (Boss §4/§9-§10)
// ---------------------------------------------------------------------------

/** What a PlanItem/Work Item needs professionally — NOT a role name (Boss §10). */
export interface ProfessionalResponsibilityRequirement {
  /** Free-text intent: "需要独立检查实现是否符合安全边界" */
  readonly responsibilityIntent: string;
  readonly requiredCapabilities: readonly string[];
  readonly expectedOutputKind: string;
  readonly validationExpectation: string;
  /** Independence/segregation constraints (Boss §34). */
  readonly independenceRequired: boolean;
  /** Risk level drives authority checks (Boss §22-§23). */
  readonly riskLevel: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// RoleDefinition + RoleCatalog (Boss §6-§7)
// ---------------------------------------------------------------------------

/**
 * A Pack's routing HINT for roles it defines (Stage 8 §B).
 *
 * A Pack may express WHICH deterministic policy fixture its roles prefer and
 * minimum tiers — it may NEVER pin a commercial model (no pin field exists) and
 * NEVER grant authority. The pack hint adjusts policy selection and scoring
 * weights only; the operator/task-level pin remains the one audit-visible
 * override, and it is never the normal user model-selection path.
 */
export interface PackRoutingPreference {
  readonly routingProfile: RoutingProfileId;
  readonly minimumQualityTier?: QualityTier;
  readonly minimumReliabilityClass?: ReliabilityClass;
}

/** A reusable professional responsibility template from a Pack (Boss §6). */
export interface RoleDefinition {
  readonly roleDefinitionId: string;
  readonly displayName: string;
  readonly professionalResponsibility: string;
  readonly responsibilityDescription: string;
  readonly requiredCapabilities: readonly string[];
  readonly preferredCapabilities: readonly string[];
  readonly toolNeeds: readonly string[];
  readonly contextNeeds: readonly string[];
  readonly validationResponsibilities: readonly string[];
  readonly independenceClass: 'independent-reviewer' | 'implementer' | 'coordinator' | 'analyst';
  readonly defaultExecutionBudget: ExecutionBudget;
  /** The Pack that owns this template (Boss §7). */
  readonly packOwner: string;
  readonly domain: string;
  /** STAGE 8 §B: optional pack routing HINT (never a pin, never authority). */
  readonly routingPreference?: PackRoutingPreference;
  readonly version: number;
}

export interface ExecutionBudget {
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly tokenBudget?: number;
  readonly timeBudgetMs?: number;
}

/**
 * Pack-extensible Role Catalog (Boss §7). NOT a fixed employee list (Boss §45).
 * Core never hardcodes entries; Packs register their own.
 */
export class RoleCatalog {
  readonly #definitions = new Map<string, RoleDefinition>();

  register(definition: Omit<RoleDefinition, 'version'>): Result<RoleDefinition, DomainError> {
    if (definition.roleDefinitionId === '' || definition.professionalResponsibility === '') {
      return err(domainError('VALIDATION_FAILED', 'RoleDefinition requires roleDefinitionId and professionalResponsibility.'));
    }
    if (this.#definitions.has(definition.roleDefinitionId)) {
      return err(domainError('CONFLICT', `RoleDefinition "${definition.roleDefinitionId}" is already registered.`));
    }
    const versioned: RoleDefinition = {...definition, version: 1};
    this.#definitions.set(definition.roleDefinitionId, versioned);
    return ok(versioned);
  }

  list(): readonly RoleDefinition[] {
    return [...this.#definitions.values()].sort((a, b) => a.roleDefinitionId.localeCompare(b.roleDefinitionId));
  }

  get(roleDefinitionId: string): Result<RoleDefinition, DomainError> {
    const def = this.#definitions.get(roleDefinitionId);
    if (def === undefined) {
      return err(domainError('NOT_FOUND', `RoleDefinition "${roleDefinitionId}" is not registered.`));
    }
    return ok(def);
  }
}

// ---------------------------------------------------------------------------
// Role Resolver (Boss §11-§12, §38-§40, §54-§55)
// ---------------------------------------------------------------------------

/** The resolved specification for a role — catalog-matched or dynamically synthesized. */
export interface ResolvedRoleSpecification {
  readonly roleDefinitionId: string | null; // null = dynamic
  readonly displayName: string;
  readonly professionalResponsibility: string;
  readonly requiredCapabilities: readonly string[];
  readonly toolNeeds: readonly string[];
  readonly contextNeeds: readonly string[];
  readonly independenceClass: RoleDefinition['independenceClass'];
  readonly executionBudget: ExecutionBudget;
  readonly origin: 'catalog-match' | 'dynamic-synthesis';
  readonly packOwner: string | null;
  readonly domain: string;
  /** STAGE 8 §B: the pack routing hint carried into routing (null when dynamic). */
  readonly routingPreference: PackRoutingPreference | null;
}

export type RoleResolutionResult = Result<ResolvedRoleSpecification, DomainError>;

/**
 * Resolve a Professional Responsibility Requirement into a role spec (Boss §11).
 *
 * Deterministic priority: 1) catalog capability match, 2) deterministic ordering,
 * 3) dynamic synthesis only when no catalog template satisfies the responsibility.
 * Fail-closed when neither path succeeds (Boss §55).
 */
export const resolveRole = (
  catalog: RoleCatalog,
  requirement: ProfessionalResponsibilityRequirement,
): RoleResolutionResult => {
  // 1. Catalog match: every required capability must be in the template.
  const candidates = catalog.list().filter((def) => {
    const has = new Set(def.requiredCapabilities);
    return requirement.requiredCapabilities.every((cap) => has.has(cap));
  });
  if (candidates.length > 0) {
    // 2. Deterministic ordering: alphabetical by roleDefinitionId (Boss §11).
    const selected = [...candidates].sort((a, b) => a.roleDefinitionId.localeCompare(b.roleDefinitionId))[0]!;
    return ok({
      roleDefinitionId: selected.roleDefinitionId,
      displayName: selected.displayName,
      professionalResponsibility: selected.professionalResponsibility,
      requiredCapabilities: [...selected.requiredCapabilities],
      toolNeeds: [...selected.toolNeeds],
      contextNeeds: [...selected.contextNeeds],
      independenceClass: selected.independenceClass,
      executionBudget: selected.defaultExecutionBudget,
      origin: 'catalog-match',
      packOwner: selected.packOwner,
      domain: selected.domain,
      routingPreference: selected.routingPreference ?? null,
    });
  }
  // 3. Dynamic synthesis: derive from the requirement itself (Boss §12).
  // This is deterministic — no LLM call. It synthesizes a task/run-scoped role
  // from the responsibility intent and required capabilities.
  return ok({
    roleDefinitionId: null,
    displayName: requirement.responsibilityIntent.slice(0, 60),
    professionalResponsibility: requirement.responsibilityIntent,
    requiredCapabilities: [...requirement.requiredCapabilities],
    toolNeeds: [],
    contextNeeds: [],
    independenceClass: requirement.independenceRequired ? 'independent-reviewer' : 'implementer',
    executionBudget: {maxTurns: 20, maxToolCalls: 50},
    origin: 'dynamic-synthesis',
    packOwner: null,
    domain: 'dynamic',
    routingPreference: null,
  });
};

// ---------------------------------------------------------------------------
// Role Instance (Boss §14-§17)
// ---------------------------------------------------------------------------

/** A run-scoped professional identity — NOT an independent state machine (Boss §15). */
export interface RoleInstance {
  readonly roleInstanceId: string;
  readonly runId: string;
  readonly companyId: string;
  readonly specification: ResolvedRoleSpecification;
  readonly professionalResponsibility: string;
  readonly capabilityRequirements: readonly string[];
  readonly contextPolicy: ContextPolicy;
  readonly executionBudget: ExecutionBudget;
  /** Tasks this instance is associated with (derived from Task assignments). */
  readonly associatedTaskIds: readonly string[];
  /** Requirements the RoleInstance contributes to model selection (Stage 7B §3). */
  readonly modelSelectionRequirements: ModelSelectionRequirements;
  // STAGE 7B §3: RoleInstance has NO modelLock / selectedModel / modelProfileId.
  // The selected model truth belongs exclusively to ExecutionAttempt.
}

export interface ContextPolicy {
  readonly includeGoalSummary: boolean;
  readonly includePlanItem: boolean;
  readonly includeRelevantDecisions: boolean;
  readonly includeArtifactRefs: boolean;
  readonly includeAcceptanceCriteria: boolean;
  /** NEVER include raw chain-of-thought or full transcripts (Boss §29-§31). */
  readonly excludeRawTranscripts: true;
  readonly excludeIrrelevantTaskContext: true;
}

/** Create a run-scoped RoleInstance (Boss §14). Status is DERIVED, never stored. */
export const createRoleInstance = (input: {
  readonly roleInstanceId: string;
  readonly runId: string;
  readonly companyId: string;
  readonly specification: ResolvedRoleSpecification;
}): RoleInstance => ({
  roleInstanceId: input.roleInstanceId,
  runId: input.runId,
  companyId: input.companyId,
  specification: input.specification,
  professionalResponsibility: input.specification.professionalResponsibility,
  capabilityRequirements: [...input.specification.requiredCapabilities],
  contextPolicy: {
    includeGoalSummary: true,
    includePlanItem: true,
    includeRelevantDecisions: true,
    includeArtifactRefs: true,
    includeAcceptanceCriteria: true,
    excludeRawTranscripts: true,
    excludeIrrelevantTaskContext: true,
  },
  executionBudget: input.specification.executionBudget,
  associatedTaskIds: [],
  // STAGE 7B: model selection REQUIREMENTS (what the role needs), not the
  // selected model truth. The Attempt selects; the Role contributes inputs.
  modelSelectionRequirements: deriveModelSelectionRequirements(input.specification.requiredCapabilities),
});

/** Derive Stage 6 ModelSelectionRequirements from role capability strings. */
const deriveModelSelectionRequirements = (capabilities: readonly string[]): ModelSelectionRequirements => ({
  requiredCapabilities: capabilities
    .filter((cap) => cap === 'tool-calling' || cap === 'structured-output' || cap === 'streaming' || cap === 'long-context'),
  requiresTools: capabilities.some((cap) => cap.startsWith('tool') || cap.startsWith('file') || cap.startsWith('process') || cap.startsWith('build') || cap.startsWith('test')),
  requiresStructuredOutput: capabilities.some((cap) => cap.startsWith('validation') || cap.startsWith('review') || cap.startsWith('structured')),
});

// ---------------------------------------------------------------------------
// Authority Intersection (Boss §22-§23)
// ---------------------------------------------------------------------------

/** The effective execution policy: Task Authority ∩ Role Needs ∩ System Policy. */
export const computeEffectiveExecutionPolicy = (input: {
  readonly taskAuthority: ReadonlySet<string>;
  readonly roleCapabilityNeeds: readonly string[];
  readonly systemPolicy: ReadonlySet<string>;
}): Result<{readonly effectiveAuthority: ReadonlySet<string>; readonly denials: readonly string[]}, DomainError> => {
  const effective = new Set<string>();
  const denials: string[] = [];
  for (const capability of input.roleCapabilityNeeds) {
    if (input.taskAuthority.has(capability) && input.systemPolicy.has(capability)) {
      effective.add(capability);
    } else {
      denials.push(capability);
    }
  }
  // Role NEVER expands Task Authority (Boss §23).
  return ok({effectiveAuthority: effective, denials});
};

// ---------------------------------------------------------------------------
// ExecutionAttempt → ModelPool (Stage 7B §2-§4, §7)
// ---------------------------------------------------------------------------

/**
 * Select a ModelProfile for ONE ExecutionAttempt (Stage 7B §2-§4).
 *
 * The correct chain: Task → RoleInstance → Required Capabilities → Model
 * Selection Requirements → ModelPool → ExecutionAttempt → SelectedModelSnapshot.
 *
 * The ATTEMPT owns the selected model (per-attempt lock, §7: no mid-loop
 * switch). The ROLE contributes requirements only — the RoleInstance is
 * unchanged by this call and holds no model truth.
 */
export const selectModelForAttempt = (
  pool: ModelPool,
  input: {
    readonly attemptId: string;
    readonly taskId: string;
    readonly role: RoleInstance;
  },
): Result<{readonly attemptId: string; readonly selectedModel: SelectedModelSnapshot}, DomainError> => {
  const selection = selectModelProfile(pool, input.role.modelSelectionRequirements);
  if (!selection.ok) return selection;
  const snapshot: SelectedModelSnapshot = {
    modelProfileId: selection.value.profile.modelProfileId,
    providerId: selection.value.profile.providerId,
    modelId: selection.value.profile.modelId,
    configurationVersion: selection.value.profile.configurationVersion,
  };
  // The snapshot is scoped to the ATTEMPT — it is execution evidence on the
  // ExecutionAttempt, not a property of the RoleInstance.
  return ok({attemptId: input.attemptId, selectedModel: snapshot});
};

// ---------------------------------------------------------------------------
// Role Context Envelope (Boss §28-§31, §65)
// ---------------------------------------------------------------------------

/** The bounded context a role receives — structurally excludes raw transcripts. */
export interface RoleContextEnvelope {
  readonly goalSummary: string;
  readonly relevantPlanItem: string | null;
  readonly currentTaskObjective: string;
  readonly roleName: string;
  readonly professionalResponsibility: string;
  readonly relevantDecisions: readonly {readonly summary: string}[];
  readonly hardConstraints: readonly string[];
  readonly requiredOutput: string;
  readonly acceptanceCriteria: readonly string[];
  readonly relevantArtifactRefs: readonly string[];
  readonly authoritySummary: readonly string[];
  readonly toolSummary: readonly string[];
  /**
   * STAGE 7B §8: the model metadata for THIS attempt, sourced from
   * ExecutionAttempt.SelectedModelSnapshot. The envelope references it —
   * it does not BECOME the model truth.
   */
  readonly attemptModel: SelectedModelSnapshot | null;
  /** PROOF field: byte size of the envelope for token-efficiency evidence. */
  readonly envelopeSizeBytes: number;
}

/** Build a role-specific bounded context envelope (Boss §28-§29). */
export const buildRoleContextEnvelope = (input: {
  readonly goalSummary: string;
  readonly planItem: string | null;
  readonly taskObjective: string;
  readonly role: RoleInstance;
  readonly decisions?: readonly {readonly summary: string}[];
  readonly constraints?: readonly string[];
  readonly requiredOutput: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly effectiveAuthority?: ReadonlySet<string>;
  readonly effectiveTools?: ReadonlySet<string>;
  /** STAGE 7B §8: sourced from ExecutionAttempt.SelectedModelSnapshot. */
  readonly attemptModel?: SelectedModelSnapshot | null;
}): RoleContextEnvelope => {
  const envelope: RoleContextEnvelope = {
    goalSummary: input.goalSummary,
    relevantPlanItem: input.planItem,
    currentTaskObjective: input.taskObjective,
    roleName: input.role.specification.displayName,
    professionalResponsibility: input.role.professionalResponsibility,
    relevantDecisions: input.decisions ?? [],
    hardConstraints: input.constraints ?? [],
    requiredOutput: input.requiredOutput,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    relevantArtifactRefs: input.artifactRefs ?? [],
    authoritySummary: [...(input.effectiveAuthority ?? new Set<string>())],
    toolSummary: [...(input.effectiveTools ?? new Set<string>())],
    attemptModel: input.attemptModel ?? null,
    envelopeSizeBytes: 0,
  };
  // Compute envelope size for token-efficiency proof (Boss §65).
  const serialized = JSON.stringify({...envelope, envelopeSizeBytes: 0});
  return {...envelope, envelopeSizeBytes: serialized.length};
};

// ---------------------------------------------------------------------------
// Derived Role Status (Boss §15, §46-§47)
// ---------------------------------------------------------------------------

export type DerivedRoleStatus = 'working' | 'waiting' | 'completed' | 'blocked';

/**
 * Derive a role's display status from canonical Task/Attempt state (Boss §15).
 * NEVER an independent role status truth.
 */
export const deriveRoleStatus = (input: {
  readonly taskStates: readonly {readonly taskId: string; readonly state: 'pending' | 'running' | 'done' | 'failed' | 'blocked'}[];
}): DerivedRoleStatus => {
  const states = new Set(input.taskStates.map((t) => t.state));
  if (states.has('running')) return 'working';
  if (states.has('blocked')) return 'blocked';
  if (states.size === 0 || (states.size === 1 && states.has('done'))) return 'completed';
  if (states.has('pending') || states.has('failed')) return 'waiting';
  return 'waiting';
};

// ---------------------------------------------------------------------------
// Failure semantics (Boss §54-§55)
// ---------------------------------------------------------------------------

export const roleExecutionBudgetExhausted = (budget: ExecutionBudget, consumed: {turns?: number; toolCalls?: number; tokens?: number}): boolean =>
  (budget.maxTurns !== undefined && (consumed.turns ?? 0) >= budget.maxTurns) ||
  (budget.maxToolCalls !== undefined && (consumed.toolCalls ?? 0) >= budget.maxToolCalls) ||
  (budget.tokenBudget !== undefined && (consumed.tokens ?? 0) >= budget.tokenBudget);
