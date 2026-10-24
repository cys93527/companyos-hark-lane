/**
 * STAGE 6 — CompanyOS MODEL POOL (deterministic selection infrastructure).
 *
 * CompanyOS is the sole owner of Model Pool, Model Selection, Credential
 * Ownership, and Provider Configuration (Boss §2). DSH never picks a model;
 * it receives the CompanyOS-selected route through the loopback broker.
 *
 * V1 selection is DETERMINISTIC (Boss §11-§12): capability filtering +
 * deterministic ordering — no LLM-calling-LLM, no randomness, no adaptive
 * routing. Rules are testable, explainable, reproducible.
 */
import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';

// ---------------------------------------------------------------------------
// Model Profile contract (Boss §6)
// ---------------------------------------------------------------------------

/** A CompanyOS-native model profile: the unit of execution model selection. */
export interface ModelProfile {
  readonly modelProfileId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  /** The upstream provider endpoint (broker routes here after injecting the credential). */
  readonly endpointURL: string;
  /**
   * Reference to the CompanyOS SecretVault entry — NEVER a raw key. EMPTY when (and
   * only when) `authentication === 'NONE'`: a no-auth profile declares absence
   * explicitly, never a fake pointer.
   */
  readonly credentialRef: string;
  /**
   * NO-AUTH MODELPOOL CLOSURE (PROD-01C): the profile's EXPLICIT authentication
   * contract — REQUIRED (the backward-compatible default; a non-empty
   * credentialRef must then resolve before dispatch) or NONE (this profile's
   * endpoint requires no credential; a credentialRef must then be ABSENT — a
   * present ref under NONE is a typed invalid config, never silently ignored).
   * The requirement belongs to the profile/provider contract alone: never to a
   * Role, Task, router policy or the kernel.
   */
  readonly authentication?: 'REQUIRED' | 'NONE';
  readonly enabled: boolean;
  readonly capabilities: ReadonlySet<ModelCapability>;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsTools: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsStreaming: boolean;
  /**
   * STAGE 8: static routing traits for the deterministic Smart Router.
   * OPTIONAL — a profile without traits is not routable by the Smart Router
   * (it is rejected with an explanation, never guessed around). Stage 6
   * capability selection does not require traits.
   */
  readonly routingTraits?: ModelRoutingTraits;
  /** Optional cost metadata for ESTIMATED telemetry (never authoritative). */
  readonly costPerMillionInputTokens?: number;
  readonly costPerMillionOutputTokens?: number;
  /** Monotonic configuration version for reproducibility. */
  readonly configurationVersion: number;
}

export type ModelCapability = 'tool-calling' | 'structured-output' | 'streaming' | 'long-context';

// ---------------------------------------------------------------------------
// STAGE 8 — static routing traits (Boss Stage 8 §B)
//
// Ordinal tiers — deliberately NOT prices or numeric scores. They keep the
// router honest: "STRONG is stronger than BALANCED" is a fact; "STRONG is 2.3×
// better" would be false precision. The Smart Router (smart-model-router.ts)
// owns the deterministic scoring over these tiers; this file owns the contract.
// ---------------------------------------------------------------------------

export type QualityTier = 'ECONOMY' | 'BALANCED' | 'STRONG' | 'PREMIUM';
export type CostTier = 'LOW' | 'MEDIUM' | 'HIGH';
export type LatencyTier = 'FAST' | 'BALANCED' | 'SLOW';
export type ReliabilityClass = 'STANDARD' | 'HIGH' | 'CRITICAL';

/** Which deterministic policy fixture a routing preference selects (Stage 8 §B). */
export type RoutingProfileId = 'QUALITY_FIRST' | 'BALANCED' | 'COST_AWARE';

export interface ModelRoutingTraits {
  readonly qualityTier: QualityTier;
  readonly costTier: CostTier;
  readonly latencyTier: LatencyTier;
  readonly reliabilityClass: ReliabilityClass;
}

/** Requirements the deterministic selector evaluates (Boss §12). */
export interface ModelSelectionRequirements {
  readonly requiredCapabilities?: readonly ModelCapability[];
  readonly requiresTools?: boolean;
  readonly requiresStructuredOutput?: boolean;
  readonly minimumContextTokens?: number;
  /** Optional explicit profile pin (deterministic policy override). */
  readonly pinnedProfileId?: string;
}

/** Machine-readable selection explanation (Boss §31 — audit, not chain-of-thought). */
export interface ModelSelectionExplanation {
  readonly selectedProfileId: string | null;
  readonly matchedCapabilities: readonly ModelCapability[];
  readonly rejectedCandidates: readonly {
    readonly profileId: string;
    readonly reason: string;
  }[];
  readonly selectionPolicy: 'pinned' | 'capability-filter-deterministic';
}

export type ModelSelectionResult = Result<
  { readonly profile: ModelProfile; readonly explanation: ModelSelectionExplanation },
  DomainError
>;

// ---------------------------------------------------------------------------
// Model Pool (Boss §8) — register/enable/disable/inspect/resolve/list
// ---------------------------------------------------------------------------

export class ModelPool {
  readonly #profiles = new Map<string, ModelProfile>();
  #nextVersion = 1;

  register(input: Omit<ModelProfile, 'configurationVersion'>): Result<ModelProfile, DomainError> {
    if (input.modelProfileId === '' || input.providerId === '' || input.modelId === '') {
      return err(domainError('VALIDATION_FAILED', 'ModelProfile requires modelProfileId, providerId, and modelId.'));
    }
    if (!isValidURL(input.endpointURL)) {
      return err(domainError('VALIDATION_FAILED', `ModelProfile "${input.modelProfileId}" endpointURL is not a valid URL.`));
    }
    const authentication = input.authentication ?? 'REQUIRED';
    if (authentication === 'NONE') {
      if (input.credentialRef !== '') {
        return err(
          domainError(
            'VALIDATION_FAILED',
            `ModelProfile "${input.modelProfileId}" declares authentication NONE yet carries a credentialRef ("${input.credentialRef}"): remove the ref or declare authentication REQUIRED — a declared credential is never silently ignored.`,
            {reason: 'MODEL_PROFILE_AUTH_CONTRACT_INVALID'},
          ),
        );
      }
    } else if (input.credentialRef === '') {
      return err(
        domainError(
          'VALIDATION_FAILED',
          `ModelProfile "${input.modelProfileId}" requires a credentialRef (SecretVault pointer) — or an explicit authentication: 'NONE' contract for a no-auth endpoint.`,
          {reason: 'MODEL_PROFILE_AUTH_CONTRACT_INVALID'},
        ),
      );
    }
    if (this.#profiles.has(input.modelProfileId)) {
      return err(domainError('CONFLICT', `ModelProfile "${input.modelProfileId}" is already registered.`));
    }
    const profile: ModelProfile = {...input, authentication, configurationVersion: this.#nextVersion};
    this.#nextVersion += 1;
    this.#profiles.set(profile.modelProfileId, profile);
    return ok(profile);
  }

  setEnabled(modelProfileId: string, enabled: boolean): Result<ModelProfile, DomainError> {
    const existing = this.#profiles.get(modelProfileId);
    if (existing === undefined) {
      return err(domainError('NOT_FOUND', `ModelProfile "${modelProfileId}" is not registered.`));
    }
    const updated: ModelProfile = {...existing, enabled};
    this.#profiles.set(modelProfileId, updated);
    return ok(updated);
  }

  inspect(modelProfileId: string): Result<ModelProfile, DomainError> {
    const profile = this.#profiles.get(modelProfileId);
    if (profile === undefined) {
      return err(domainError('NOT_FOUND', `ModelProfile "${modelProfileId}" is not registered.`));
    }
    return ok(profile);
  }

  list(): readonly ModelProfile[] {
    return [...this.#profiles.values()].sort((a, b) => a.modelProfileId.localeCompare(b.modelProfileId));
  }

  listEnabled(): readonly ModelProfile[] {
    return this.list().filter((p) => p.enabled);
  }

  listCapabilities(modelProfileId: string): Result<readonly ModelCapability[], DomainError> {
    const profile = this.#profiles.get(modelProfileId);
    if (profile === undefined) {
      return err(domainError('NOT_FOUND', `ModelProfile "${modelProfileId}" is not registered.`));
    }
    return ok([...profile.capabilities]);
  }
}

const isValidURL = (text: string): boolean => {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Deterministic Model Selection V1 (Boss §11-§12)
// ---------------------------------------------------------------------------

/**
 * Select exactly ONE ModelProfile deterministically (Boss §11).
 *
 * Filtering order (Boss §12): capability → tool → structured-output → context
 * → enabled → credential. Deterministic ordering: alphabetical by profile id.
 * Returns a machine-readable explanation with rejected candidates.
 */
export const selectModelProfile = (
  pool: ModelPool,
  requirements: ModelSelectionRequirements,
): ModelSelectionResult => {
  const rejectedCandidates: {profileId: string; reason: string}[] = [];
  const reject = (profile: ModelProfile, reason: string): void => {
    rejectedCandidates.push({profileId: profile.modelProfileId, reason});
  };

  // Pinned profile: deterministic policy override (Boss §12 "explicit CompanyOS policy constraints").
  if (requirements.pinnedProfileId !== undefined) {
    const pinned = pool.inspect(requirements.pinnedProfileId);
    if (!pinned.ok) {
      return err(domainError('NOT_FOUND', `Pinned ModelProfile "${requirements.pinnedProfileId}" is not registered.`, {
        reason: 'MODEL_PROFILE_UNAVAILABLE',
      }));
    }
    if (!pinned.value.enabled) {
      return err(domainError('VALIDATION_FAILED', `Pinned ModelProfile "${requirements.pinnedProfileId}" is disabled.`, {
        reason: 'MODEL_PROFILE_UNAVAILABLE',
      }));
    }
    return ok({
      profile: pinned.value,
      explanation: {
        selectedProfileId: pinned.value.modelProfileId,
        matchedCapabilities: [...pinned.value.capabilities],
        rejectedCandidates,
        selectionPolicy: 'pinned',
      },
    });
  }

  const enabled = pool.listEnabled();
  if (enabled.length === 0) {
    return err(domainError('VALIDATION_FAILED', 'The model pool has no enabled profiles.', {
      reason: 'MODEL_POOL_EMPTY',
    }));
  }

  const required = new Set(requirements.requiredCapabilities ?? []);
  if (requirements.requiresTools === true) required.add('tool-calling');
  if (requirements.requiresStructuredOutput === true) required.add('structured-output');

  const eligible: ModelProfile[] = [];
  for (const profile of enabled) {
    // Capability set check
    const missing = [...required].filter((cap) => !profile.capabilities.has(cap));
    if (missing.length > 0) {
      reject(profile, `missing capabilities: ${missing.join(', ')}`);
      continue;
    }
    // Boolean capability check (the `supportsTools`/`supportsStructuredOutput` fields are
    // the authoritative capability facts; the set is the selection vocabulary).
    if (requirements.requiresTools === true && !profile.supportsTools) {
      reject(profile, 'supportsTools=false but tools required');
      continue;
    }
    if (requirements.requiresStructuredOutput === true && !profile.supportsStructuredOutput) {
      reject(profile, 'supportsStructuredOutput=false but structured output required');
      continue;
    }
    // Context window check (Boss §21)
    if (requirements.minimumContextTokens !== undefined && profile.contextWindowTokens < requirements.minimumContextTokens) {
      reject(profile, `contextWindow ${String(profile.contextWindowTokens)} < required ${String(requirements.minimumContextTokens)}`);
      continue;
    }
    eligible.push(profile);
  }

  if (eligible.length === 0) {
    return err(domainError('VALIDATION_FAILED', 'No enabled model profile satisfies the required capabilities.', {
      reason: 'MODEL_CAPABILITY_MISMATCH',
      rejectedCandidates,
    }));
  }

  // Deterministic ordering: alphabetical by profile id (Boss §12 — reproducible).
  const selected = [...eligible].sort((a, b) => a.modelProfileId.localeCompare(b.modelProfileId))[0]!;
  return ok({
    profile: selected,
    explanation: {
      selectedProfileId: selected.modelProfileId,
      matchedCapabilities: [...selected.capabilities],
      rejectedCandidates,
      selectionPolicy: 'capability-filter-deterministic',
    },
  });
};

// ---------------------------------------------------------------------------
// Selected Model Snapshot (Boss §10) — per-attempt execution evidence
// ---------------------------------------------------------------------------

export interface SelectedModelSnapshot {
  readonly modelProfileId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configurationVersion: number;
}

export const snapshotOf = (profile: ModelProfile): SelectedModelSnapshot => ({
  modelProfileId: profile.modelProfileId,
  providerId: profile.providerId,
  modelId: profile.modelId,
  configurationVersion: profile.configurationVersion,
});

// ---------------------------------------------------------------------------
// Usage Telemetry (Boss §18) — per-request normalized evidence
// ---------------------------------------------------------------------------

export interface ModelUsageRecord {
  readonly modelProfileId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly attemptId: string;
  readonly requestDurationMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly providerRequestId: string | null;
  readonly classification: 'completed' | 'error';
  readonly errorKind?: 'MODEL_PROFILE_UNAVAILABLE' | 'MODEL_CREDENTIAL_MISSING' | 'MODEL_PROVIDER_UNAVAILABLE' | 'timeout' | 'rate-limit' | 'bad-response';
  readonly estimatedCostUSD?: number;
}
