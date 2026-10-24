/**
 * Model Selection Policy (Sprint 7.5) — the RULES about choosing a model.
 *
 * It is deliberately NOT a router: nothing in this module scores, ranks, compares quality,
 * benchmarks or picks anything. It answers three questions and nothing else:
 *
 *   1. Given a set of scoped policies, which one wins? (`resolvePolicy`)
 *   2. Given a MANUAL choice, is it admissible — and if not, exactly why?
 *      (`evaluateManualSelection`)
 *   3. Given a HYBRID policy, what is the candidate set the (future) router would be
 *      allowed to choose from? (`hybridCandidates`)
 *
 * The AUTO mode is a CONTRACT ONLY here: it is stored and explained, never executed.
 * Benchmark metadata never enters any of these functions (Sprint 7.5 test R).
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import { AUTHORITIES, isAuthority, type Authority } from './role-authority.js';
import type { ModelRecord } from './model-registry.js';

/* ------------------------------------------------------------------- shapes --- */

export const SELECTION_MODES = ['MANUAL', 'AUTO', 'HYBRID'] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

export const POLICY_SCOPE_TYPES = ['COMPANY', 'WORKFLOW', 'ROLE', 'TASK'] as const;
export type PolicyScopeType = (typeof POLICY_SCOPE_TYPES)[number];

export const FALLBACK_MODES = ['NEVER', 'ASK', 'AUTO_WITHIN_POLICY'] as const;
export type FallbackMode = (typeof FALLBACK_MODES)[number];

/** Least specific first; the LAST match wins (most specific policy). */
export const SCOPE_SPECIFICITY: readonly PolicyScopeType[] = ['COMPANY', 'WORKFLOW', 'ROLE', 'TASK'];

/** The frozen precedence ladder (ADR-0011). Higher index = stronger. */
export const PRECEDENCE_LADDER = [
  'GLOBAL_DEFAULT',
  'ROUTER_RECOMMENDATION',
  'COMPANY_POLICY',
  'WORKFLOW_POLICY',
  'ROLE_POLICY',
  'TASK_OVERRIDE',
  'EXPLICIT_USER_CHOICE',
] as const;
export type PrecedenceLevel = (typeof PRECEDENCE_LADDER)[number];

export interface ModelSelectionPolicy {
  readonly id: string;
  readonly scopeType: PolicyScopeType;
  /** `*` for a global company default. */
  readonly scopeId: string;
  readonly mode: SelectionMode;
  /** MANUAL: the model the user pinned. */
  readonly manualModelKey: string | null;
  readonly allowedModels: readonly string[];
  readonly preferredModels: readonly string[];
  readonly blockedModels: readonly string[];
  readonly allowedProviders: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly maxCost: number | null;
  readonly maxLatency: number | null;
  readonly allowFallback: FallbackMode;
  readonly requireApprovalForOverride: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const SELECTION_CAPABILITIES = [
  'streaming',
  'structuredOutput',
  'toolCalling',
  'vision',
  'reasoning',
  'audio',
] as const;
export type SelectionCapability = (typeof SELECTION_CAPABILITIES)[number];

export const isSelectionCapability = (value: unknown): value is SelectionCapability =>
  typeof value === 'string' && (SELECTION_CAPABILITIES as readonly string[]).includes(value);

/* -------------------------------------------------------------- validation --- */

export interface PolicyDraft {
  readonly id: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly mode: string;
  readonly manualModelKey?: string | null;
  readonly allowedModels?: readonly string[];
  readonly preferredModels?: readonly string[];
  readonly blockedModels?: readonly string[];
  readonly allowedProviders?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  readonly maxCost?: number | null;
  readonly maxLatency?: number | null;
  readonly allowFallback?: string;
  readonly requireApprovalForOverride?: boolean;
  readonly createdBy: string;
  readonly now: string;
}

/**
 * Order-preserving variant for lists whose ORDER carries meaning (10A.0.3 §二): `preferredModels`
 * is a preference ranking, so it must never be sorted. Trim/lowercase/dedupe only.
 */
const normalizeOrderedList = (values: readonly string[] | undefined): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const key = value.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
};

const normalizeList = (values: readonly string[] | undefined): readonly string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort();

const validate = (draft: PolicyDraft): Result<true, DomainError> => {
  if (!(SELECTION_MODES as readonly string[]).includes(draft.mode)) {
    return err(domainError('VALIDATION_FAILED', `Unknown selection mode "${draft.mode}".`, { allowed: SELECTION_MODES }));
  }
  if (!(POLICY_SCOPE_TYPES as readonly string[]).includes(draft.scopeType)) {
    return err(domainError('VALIDATION_FAILED', `Unknown policy scope "${draft.scopeType}".`, { allowed: POLICY_SCOPE_TYPES }));
  }
  if (draft.scopeId.trim().length === 0) {
    return err(domainError('VALIDATION_FAILED', 'A policy needs a non-empty scopeId ("*" for the global default).', {}));
  }
  if (draft.mode === 'MANUAL' && (draft.manualModelKey ?? '').trim().length === 0) {
    return err(domainError('VALIDATION_FAILED', 'MANUAL requires manualModelKey.', { mode: draft.mode }));
  }
  for (const capability of draft.requiredCapabilities ?? []) {
    if (!isSelectionCapability(capability)) {
      return err(domainError('VALIDATION_FAILED', `Unknown required capability "${capability}".`, {
        allowed: SELECTION_CAPABILITIES,
      }));
    }
  }
  if (draft.maxCost !== undefined && draft.maxCost !== null && draft.maxCost < 0) {
    return err(domainError('VALIDATION_FAILED', 'maxCost must be >= 0.', { maxCost: draft.maxCost }));
  }
  if (draft.maxLatency !== undefined && draft.maxLatency !== null && draft.maxLatency <= 0) {
    return err(domainError('VALIDATION_FAILED', 'maxLatency must be > 0.', { maxLatency: draft.maxLatency }));
  }
  const fallbackMode = draft.allowFallback ?? 'NEVER';
  if (!(FALLBACK_MODES as readonly string[]).includes(fallbackMode)) {
    return err(domainError('VALIDATION_FAILED', `Unknown fallback mode "${fallbackMode}".`, { allowed: FALLBACK_MODES }));
  }
  return ok(true);
};

/** Build a validated, normalized policy. Pure: no IO, no clock, no randomness. */
export function createPolicy(draft: PolicyDraft): Result<ModelSelectionPolicy, DomainError> {
  const validated = validate(draft);
  if (!validated.ok) return validated;
  const mode = draft.mode as SelectionMode;
  return ok({
    id: draft.id,
    scopeType: draft.scopeType as PolicyScopeType,
    scopeId: draft.scopeId.trim(),
    mode,
    manualModelKey: mode === 'MANUAL' ? (draft.manualModelKey ?? '').trim().toLowerCase() : null,
    allowedModels: normalizeList(draft.allowedModels),
    preferredModels: normalizeOrderedList(draft.preferredModels),
    blockedModels: normalizeList(draft.blockedModels),
    allowedProviders: normalizeList(draft.allowedProviders),
    requiredCapabilities: normalizeList(draft.requiredCapabilities),
    maxCost: draft.maxCost ?? null,
    maxLatency: draft.maxLatency ?? null,
    allowFallback: (draft.allowFallback ?? 'NEVER') as FallbackMode,
    requireApprovalForOverride: draft.requireApprovalForOverride === true,
    createdBy: draft.createdBy,
    createdAt: draft.now,
    updatedAt: draft.now,
  });
}

/* --------------------------------------------------------------- resolution --- */

export interface PolicyScopeRef {
  readonly scopeType: PolicyScopeType;
  readonly scopeId: string;
}

export const policyId = (scopeType: PolicyScopeType, scopeId: string): string => `${scopeType}:${scopeId}`;

/**
 * Least-specific-wins fix: the policy whose scope matches and is the MOST specific.
 * A `COMPANY` policy with scopeId `*` matches everything; a `TASK` policy matches only its
 * own task. This is resolution, not judgement — no mode is compared or preferred here.
 */
export function resolvePolicy(
  policies: readonly ModelSelectionPolicy[],
  scopes: readonly PolicyScopeRef[],
): ModelSelectionPolicy | null {
  let winner: ModelSelectionPolicy | null = null;
  let winnerRank = -1;
  for (const policy of policies) {
    const matches = scopes.some(
      (scope) => scope.scopeType === policy.scopeType && scope.scopeId === policy.scopeId,
    );
    const globalCompany = policy.scopeType === 'COMPANY' && policy.scopeId === '*';
    if (!matches && !globalCompany) continue;
    const rank = SCOPE_SPECIFICITY.indexOf(policy.scopeType);
    if (rank > winnerRank) {
      winner = policy;
      winnerRank = rank;
    }
  }
  return winner;
}

/** Where a decision actually came from - the frozen precedence ladder. */
export function precedenceLevelOf(input: {
  readonly explicitModelKey: string | null;
  readonly taskOverride: boolean;
  /** Set when a (future) router supplied the value; no router exists today. */
  readonly routerRecommendation?: boolean;
  readonly resolvedScope: PolicyScopeType | null;
}): PrecedenceLevel {
  if (input.explicitModelKey !== null) return 'EXPLICIT_USER_CHOICE';
  if (input.taskOverride) return 'TASK_OVERRIDE';
  // A TASK-scoped policy IS the task rung of the ladder, whether or not the caller flagged
  // it as an override (Closeout-7.5 MEDIUM-2: this branch used to fall through to DEFAULT).
  if (input.resolvedScope === 'TASK') return 'TASK_OVERRIDE';
  if (input.resolvedScope === 'ROLE') return 'ROLE_POLICY';
  if (input.resolvedScope === 'WORKFLOW') return 'WORKFLOW_POLICY';
  if (input.resolvedScope === 'COMPANY') return 'COMPANY_POLICY';
  if (input.routerRecommendation === true) return 'ROUTER_RECOMMENDATION';
  return 'GLOBAL_DEFAULT';
}

/* ------------------------------------------------------------ manual checks --- */

export type ManualRefusal =
  | 'MODEL_NOT_REGISTERED'
  | 'MODEL_DISABLED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_BLOCKED_BY_POLICY'
  | 'PROVIDER_NOT_ALLOWED'
  | 'CAPABILITY_MISSING'
  | 'COST_LIMIT_EXCEEDED'
  | 'LATENCY_LIMIT_EXCEEDED'
  | 'UNKNOWN_CAPABILITY';

export interface ManualSelectionVerdict {
  readonly accepted: boolean;
  /** Empty when accepted. */
  readonly refusals: readonly ManualRefusal[];
  /** Human-readable, one per refusal - the UI shows these verbatim. */
  readonly reasons: readonly string[];
  readonly fallback: FallbackMode;
  readonly allowedFallbackModelKeys: readonly string[];
  readonly precedence: PrecedenceLevel;
}

/**
 * The rule subset `evaluateManualSelection` actually needs (Sprint 10A.0.2 MEDIUM-5).
 *
 * Both a full `ModelSelectionPolicy` and a derived `RouterPolicyView` satisfy this shape, so the
 * MANUAL path, the Override path and the Router path all read ONE interpretation of a policy
 * instead of one each.
 */
export interface SelectionRules {
  /** Authoritative scope. `null` means genuinely unscoped; the field is REQUIRED (10A.0.3 §四). */
  readonly scopeType: PolicyScopeType | null;
  readonly scopeId: string | null;
  /** Authoritative fallback mode. REQUIRED: `?? 'NEVER'` fill-ins are forbidden (10A.0.3 §四). */
  readonly fallback: FallbackMode;
  readonly allowedModels: readonly string[];
  readonly blockedModels: readonly string[];
  readonly allowedProviders: readonly string[];
  /** ORDER SEMANTICS: position 0 = highest preference (0.25 weight in Router v1). */
  readonly preferredModels: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly maxCost: number | null;
  readonly maxLatency: number | null;
}

/**
 * The ONE place a stored policy becomes selection rules (10A.0.3 §七/§八). Manual, Hybrid, Auto
 * and the Router all read rules of this shape; none of them re-derives policy semantics.
 */
export function selectionRulesFromPolicy(policy: ModelSelectionPolicy | null): SelectionRules {
  return {
    scopeType: policy?.scopeType ?? null,
    scopeId: policy?.scopeId ?? null,
    fallback: policy?.allowFallback ?? 'NEVER',
    allowedModels: policy?.allowedModels ?? [],
    blockedModels: policy?.blockedModels ?? [],
    allowedProviders: policy?.allowedProviders ?? [],
    preferredModels: policy?.preferredModels ?? [],
    requiredCapabilities: policy?.requiredCapabilities ?? [],
    maxCost: policy?.maxCost ?? null,
    maxLatency: policy?.maxLatency ?? null,
  };
}

/** The canonical exclusion FACTS (10A.0.4 §一/§二): one truth source for every consumer. */
export const SELECTION_EXCLUSION_CODES = [
  'MODEL_NOT_REGISTERED',
  'MODEL_DISABLED',
  'MODEL_UNAVAILABLE',
  /** The model is EXPLICITLY blocked by policy - a hard block no explicit choice may cross. */
  'MODEL_BLOCKED_BY_POLICY',
  /** The model is simply outside `allowedModels` - a RANGE exclusion, crossable by explicit choice. */
  'NOT_IN_ALLOWED_RANGE',
  'PROVIDER_NOT_ALLOWED',
  'CAPABILITY_MISSING',
  'COST_LIMIT_EXCEEDED',
] as const;
export type SelectionExclusionCode = (typeof SELECTION_EXCLUSION_CODES)[number];

export interface SelectionExclusion {
  /** The fact code. MANUAL/HYBRID/AUTO/Router must all agree on it for identical inputs. */
  readonly code: SelectionExclusionCode;
  /** The MANUAL-facing refusal, derived from `code` (never computed separately). */
  readonly fact: ManualRefusal;
  /** Presentation detail (offending capability, scope label, price...). Never a decision input. */
  readonly detail: string | null;
  /** True when the required capability is not a known capability at all. */
  readonly unknownCapability: boolean;
}

export interface SelectionContext {
  /** Explicit user choice outranks the allowed-model RANGE (not the hard block). */
  readonly explicit?: boolean;
  readonly taskOverride?: boolean;
}

/** Code → MANUAL refusal. The ONLY mapping; no consumer may invent its own. */
export const EXCLUSION_TO_MANUAL_REFUSAL: Readonly<Record<SelectionExclusionCode, ManualRefusal>> = {
  MODEL_NOT_REGISTERED: 'MODEL_NOT_REGISTERED',
  MODEL_DISABLED: 'MODEL_DISABLED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  MODEL_BLOCKED_BY_POLICY: 'MODEL_BLOCKED_BY_POLICY',
  /** Kept on the legacy MANUAL label for compatibility; the FACT is still "outside the range". */
  NOT_IN_ALLOWED_RANGE: 'MODEL_BLOCKED_BY_POLICY',
  PROVIDER_NOT_ALLOWED: 'PROVIDER_NOT_ALLOWED',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  COST_LIMIT_EXCEEDED: 'COST_LIMIT_EXCEEDED',
};

/**
 * THE authoritative candidate admission rule (10A.0.4 §一). Every path — MANUAL verdict, human
 * override, HYBRID candidate set, AUTO presentation and router hard filters — decides with this
 * function, and callers may only map its facts to their own presentation/error shapes.
 */
export function evaluateCandidateAgainstSelectionRules(
  candidate: ModelRecord | null,
  rules: SelectionRules | null,
  context: SelectionContext = {},
): readonly SelectionExclusion[] {
  const exclusions: SelectionExclusion[] = [];
  const add = (code: SelectionExclusionCode, detail: string | null = null, unknownCapability = false): void => {
    exclusions.push({ code, fact: EXCLUSION_TO_MANUAL_REFUSAL[code], detail, unknownCapability });
  };

  if (candidate === null) {
    add('MODEL_NOT_REGISTERED');
    return exclusions;
  }
  if (!candidate.enabled) add('MODEL_DISABLED');
  if (candidate.availability === 'unavailable') add('MODEL_UNAVAILABLE');
  if (rules === null) return exclusions;

  const bypassRange = context.explicit === true || context.taskOverride === true;
  if (rules.blockedModels.includes(candidate.modelKey)) {
    // HARD BLOCK: never crossable, not even by an explicit choice (ADR-0011 §3).
    add('MODEL_BLOCKED_BY_POLICY', rules.scopeType ?? 'unscoped');
  }
  if (rules.allowedModels.length > 0 && !rules.allowedModels.includes(candidate.modelKey) && !bypassRange) {
    // RANGE exclusion: a different FACT, crossable by an explicit user choice.
    add('NOT_IN_ALLOWED_RANGE', 'outside the allowed set');
  }
  if (rules.allowedProviders.length > 0 && !rules.allowedProviders.includes(candidate.providerId)) {
    add('PROVIDER_NOT_ALLOWED', candidate.providerId);
  }
  for (const capability of rules.requiredCapabilities) {
    if (!isSelectionCapability(capability)) add('CAPABILITY_MISSING', capability, true);
    else if (!capabilitySatisfied(candidate, capability)) add('CAPABILITY_MISSING', capability);
  }
  const price = candidate.pricing?.inputPerMillion ?? null;
  if (rules.maxCost !== null && price !== null && price > rules.maxCost) {
    add('COST_LIMIT_EXCEEDED', `${String(price)}>${String(rules.maxCost)}`);
  }
  return exclusions;
}

/** True when the candidate is admissible under the rules (used for candidate sets). */
export const isCandidateAdmissible = (
  candidate: ModelRecord,
  rules: SelectionRules,
  context: SelectionContext = {},
): boolean => evaluateCandidateAgainstSelectionRules(candidate, rules, context).length === 0;

/**
 * Convenience wrapper kept for candidate-set helpers: the first exclusion's MANUAL-facing fact,
 * or null when the candidate is admissible.
 */
export function rulesExcludeCandidate(record: ModelRecord, rules: SelectionRules): ManualRefusal | null {
  const exclusions = evaluateCandidateAgainstSelectionRules(record, rules);
  // An unknown capability keeps its own MANUAL label so existing refusal vocabularies stay intact.
  const unknown = exclusions.find((exclusion) => exclusion.unknownCapability);
  if (unknown !== undefined) return 'UNKNOWN_CAPABILITY';
  return exclusions[0]?.fact ?? null;
}

export interface ManualEvaluationInput {
  readonly modelKey: string;
  /** Any derived rule view: `SelectionRules` (a full policy or a `RouterPolicyView`). */
  readonly policy: SelectionRules | null;
  readonly records: readonly ModelRecord[];
  /** Explicit user choice beats every policy (ADR-0011). */
  readonly explicit?: boolean;
  readonly taskOverride?: boolean;
  /** Reserved for the future router; no router exists in Sprint 7.5. */
  readonly routerRecommendation?: boolean;
}

const capabilitySatisfied = (record: ModelRecord, capability: SelectionCapability): boolean =>
  record.capabilities[capability] === true;

/**
 * Decide whether a named model may be used. It never substitutes another model: it either
 * accepts the choice or reports why not plus (for AUTO_WITHIN_POLICY) the fallback set the
 * caller is allowed to consider.
 */
export function evaluateManualSelection(input: ManualEvaluationInput): ManualSelectionVerdict {
  const refusals: ManualRefusal[] = [];
  const reasons: string[] = [];
  const policy = input.policy;
  const modelKey = input.modelKey.trim().toLowerCase();
  const record = input.records.find((entry) => entry.modelKey === modelKey) ?? null;

  const refuse = (refusal: ManualRefusal, reason: string): void => {
    refusals.push(refusal);
    reasons.push(reason);
  };

  // 10A.0.4 §一: the verdict is DERIVED from the authoritative rule - it never re-decides.
  const exclusions = evaluateCandidateAgainstSelectionRules(record, policy, input);
  for (const exclusion of exclusions) {
    const label = modelKey;
    const detail = exclusion.detail ?? '';
    switch (exclusion.code) {
      case 'MODEL_NOT_REGISTERED':
        refuse(exclusion.fact, `Model "${label}" is not registered.`);
        break;
      case 'MODEL_DISABLED':
        refuse(exclusion.fact, `Model "${label}" is disabled.`);
        break;
      case 'MODEL_UNAVAILABLE':
        refuse(exclusion.fact, `Model "${label}" is currently unavailable.`);
        break;
      case 'MODEL_BLOCKED_BY_POLICY':
        refuse(exclusion.fact, `Model "${label}" is blocked by ${detail} policy.`);
        break;
      case 'NOT_IN_ALLOWED_RANGE':
        refuse(exclusion.fact, `Model "${label}" is outside the allowed set.`);
        break;
      case 'PROVIDER_NOT_ALLOWED':
        refuse(exclusion.fact, `Provider "${detail}" is not allowed by policy.`);
        break;
      case 'CAPABILITY_MISSING':
        refuse(
          exclusion.unknownCapability ? 'UNKNOWN_CAPABILITY' : exclusion.fact,
          exclusion.unknownCapability
            ? `Policy requires unknown capability "${detail}".`
            : `Model "${label}" does not support "${detail}".`,
        );
        break;
      case 'COST_LIMIT_EXCEEDED':
        refuse(
          exclusion.fact,
          `Model "${label}" costs ${detail.split('>')[0] ?? ''} per 1M > maxCost ${detail.split('>')[1] ?? ''}.`,
        );
        break;
      default:
        break;
    }
  }

  // No policy at all means "no rules", which is the only case that may default to NEVER: a view
  // or policy that IS present must state its fallback explicitly (10A.0.3 §四).
  const fallback: FallbackMode = policy === null ? 'NEVER' : policy.fallback;
  const allowedFallbackModelKeys =
    fallback === 'AUTO_WITHIN_POLICY' && policy !== null
      ? input.records
          .filter((entry) => rulesExcludeCandidate(entry, policy) === null)
          .map((entry) => entry.modelKey)
          .sort()
      : [];

  return {
    accepted: refusals.length === 0,
    refusals,
    reasons,
    fallback,
    allowedFallbackModelKeys,
    precedence: precedenceLevelOf({
      // `explicit` and `taskOverride` are different rungs of the frozen ladder.
      explicitModelKey: input.explicit === true ? modelKey : null,
      taskOverride: input.taskOverride === true,
      routerRecommendation: input.routerRecommendation === true,
      resolvedScope: policy?.scopeType ?? null,
    }),
  };
}

/* ------------------------------------------------------------- hybrid view --- */

export interface HybridCandidateSet {
  readonly modelKeys: readonly string[];
  /** Candidates first in the user's preferred order; the rest alphabetically. */
  readonly preferred: readonly string[];
  readonly excluded: readonly { readonly modelKey: string; readonly reason: string }[];
  readonly mode: 'HYBRID';
}

/**
 * The candidate SET for a future router. No ordering by quality, no score, no choice:
 * preferred models come first because the USER said so, then everything else alphabetically.
 */
/**
 * The candidate SET for a future router (10A.0.3 §八: it consumes the shared `SelectionRules` and
 * the shared exclusion rule - it does NOT re-implement policy semantics). No ordering by quality,
 * no score, no choice: preferred models come first because the USER said so, then the rest
 * alphabetically. The reason labels are presentation only.
 */
export function hybridCandidates(input: {
  readonly policy: SelectionRules;
  readonly records: readonly ModelRecord[];
}): HybridCandidateSet {
  const { policy } = input;
  const excluded: { modelKey: string; reason: string }[] = [];
  const admitted: string[] = [];
  for (const record of input.records) {
    const refusal = rulesExcludeCandidate(record, policy);
    if (refusal !== null) {
      let label = refusal.toLowerCase();
      if (refusal === 'MODEL_BLOCKED_BY_POLICY') {
        const blocked = evaluateCandidateAgainstSelectionRules(record, policy).some(
          (exclusion) => exclusion.code === 'MODEL_BLOCKED_BY_POLICY',
        );
        label = blocked ? 'blocked_by_policy' : 'not_in_allowed_set';
      } else if (refusal === 'CAPABILITY_MISSING') {
        const missing = policy.requiredCapabilities.find(
          (capability) => !isSelectionCapability(capability) || !capabilitySatisfied(record, capability),
        );
        label = `missing_capability:${missing ?? 'unknown'}`;
      } else if (refusal === 'COST_LIMIT_EXCEEDED') {
        label = 'over_max_cost';
      }
      excluded.push({ modelKey: record.modelKey, reason: label });
      continue;
    }
    admitted.push(record.modelKey);
  }
  const preferred = policy.preferredModels.filter((modelKey) => admitted.includes(modelKey));
  const rest = admitted.filter((modelKey) => !preferred.includes(modelKey)).sort();
  return { modelKeys: [...preferred, ...rest], preferred, excluded, mode: 'HYBRID' };
}

/** AUTO is a contract, not an implementation: this is all the system may say today. */
export const AUTO_POLICY_STATEMENT =
  'Router will decide within policy. No router is implemented in Sprint 7.5, so an AUTO policy is stored and explained but never executed.';

export interface AutoContractView {
  readonly mode: 'AUTO';
  readonly statement: string;
  readonly wouldAuthorize: readonly Authority[];
  readonly candidateSet: HybridCandidateSet;
}

/** Explain what AUTO would permit - without choosing anything (presentation only). */
export function describeAutoPolicy(input: {
  readonly policy: SelectionRules;
  readonly records: readonly ModelRecord[];
}): AutoContractView {
  const wouldAuthorize = ['model.read', 'provider.invoke'].filter(
    (authority): authority is Authority => isAuthority(authority) && AUTHORITIES.includes(authority),
  );
  return {
    mode: 'AUTO',
    statement: AUTO_POLICY_STATEMENT,
    wouldAuthorize,
    candidateSet: hybridCandidates(input),
  };
}
