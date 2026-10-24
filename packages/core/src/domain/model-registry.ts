/**
 * Model Registry domain (Sprint 7): CompanyOS-owned, curated model records.
 *
 * Two layers, on purpose (ADR-0010):
 *   - the provider **catalogue** (`provider_models`) is the raw, adapter-declared snapshot;
 *   - a **ModelRecord** is the curated entry CompanyOS owns: a stable `modelKey`, an
 *     owner-facing description, capability profile, enabled flag, availability/health.
 *
 * HARD LINE: this module **never chooses** a model. `resolveAlias` maps one exact alias to
 * one model; there is no scoring, no ranking, no fallback, no "best model". Routing is a
 * different, later concern (and a different ADR).
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { ModelCapabilities, ModelInfo, ModelPricing } from '../ports/model-provider.js';

/** Stable, provider-independent key: lower-case, dot/dash/underscore separated. */
export const MODEL_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Alias: same shape as a key, but resolved in its own namespace. */
export const ALIAS_PATTERN = MODEL_KEY_PATTERN;

export const MODEL_AVAILABILITY = ['available', 'degraded', 'unavailable', 'disabled'] as const;
export type ModelAvailability = (typeof MODEL_AVAILABILITY)[number];

export interface ModelRecord {
  readonly id: string;
  readonly modelKey: string;
  readonly providerId: string;
  /** The provider's own model id (what an adapter understands). */
  readonly providerModelId: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: ModelCapabilities;
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  readonly pricing: ModelPricing | null;
  readonly enabled: boolean;
  readonly availability: ModelAvailability;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly registeredAt: string;
  readonly updatedAt: string;
  readonly registeredBy: string;
}

/** A human-friendly name for one model. One alias -> exactly one model, ever. */
export interface LogicalAlias {
  /** `EntityStore` key: `<scope>:<alias>`. */
  readonly id: string;
  readonly alias: string;
  readonly modelKey: string;
  readonly scope: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export const normalizeModelKey = (raw: string): string => raw.trim().toLowerCase();
export const isModelKey = (raw: string): boolean => MODEL_KEY_PATTERN.test(normalizeModelKey(raw));
export const normalizeAlias = (raw: string): string => raw.trim().toLowerCase();
export const isAliasName = (raw: string): boolean => ALIAS_PATTERN.test(normalizeAlias(raw));

export interface CreateModelRecordInput {
  readonly id: string;
  readonly modelKey: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly capabilities: ModelCapabilities;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number | null;
  readonly pricing?: ModelPricing | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly now: string;
  readonly actorId: string;
}

/** Validate + normalize a registry entry. Never mutates the caller's input. */
export function createModelRecord(input: CreateModelRecordInput): Result<ModelRecord, DomainError> {
  const modelKey = normalizeModelKey(input.modelKey);
  if (!MODEL_KEY_PATTERN.test(modelKey)) {
    return err(
      domainError('VALIDATION_FAILED', `"${input.modelKey}" is not a valid model key.`, {
        modelKey: input.modelKey,
        pattern: MODEL_KEY_PATTERN.source,
      }),
    );
  }
  if (input.contextWindow <= 0) {
    return err(
      domainError('VALIDATION_FAILED', 'A model needs a positive context window.', { modelKey, contextWindow: input.contextWindow }),
    );
  }
  if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null && input.maxOutputTokens <= 0) {
    return err(
      domainError('VALIDATION_FAILED', 'maxOutputTokens must be positive when set.', { modelKey, maxOutputTokens: input.maxOutputTokens }),
    );
  }
  return ok({
    id: input.id,
    modelKey,
    providerId: input.providerId,
    providerModelId: input.providerModelId,
    displayName: input.displayName ?? modelKey,
    description: input.description ?? '',
    capabilities: { ...input.capabilities },
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens ?? null,
    pricing: input.pricing ?? null,
    enabled: true,
    availability: 'available',
    metadata: { ...(input.metadata ?? {}) },
    registeredAt: input.now,
    updatedAt: input.now,
    registeredBy: input.actorId,
  });
}

/** Build a record straight from a provider catalogue entry. */
export function modelRecordFromProviderModel(input: {
  readonly id: string;
  readonly modelKey?: string;
  readonly providerId: string;
  readonly model: ModelInfo;
  readonly description?: string;
  readonly now: string;
  readonly actorId: string;
}): Result<ModelRecord, DomainError> {
  const modelKey = input.modelKey ?? `${input.providerId}.${input.model.modelId}`;
  return createModelRecord({
    id: input.id,
    modelKey,
    providerId: input.providerId,
    providerModelId: input.model.modelId,
    displayName: input.model.displayName,
    ...(input.description === undefined ? {} : { description: input.description }),
    capabilities: input.model.capabilities,
    contextWindow: input.model.contextWindow,
    maxOutputTokens: input.model.maxOutputTokens,
    pricing: input.model.pricing,
    metadata: input.model.metadata ?? {},
    now: input.now,
    actorId: input.actorId,
  });
}

/** Availability is derived: disabled wins over any provider health. */
export function availabilityOf(
  record: Pick<ModelRecord, 'enabled'>,
  health: 'healthy' | 'degraded' | 'unavailable' | null = null,
): ModelAvailability {
  if (!record.enabled) return 'disabled';
  if (health === null) return record.enabled ? 'available' : 'disabled';
  return health === 'healthy' ? 'available' : health === 'degraded' ? 'degraded' : 'unavailable';
}

/** Enable / disable, recomputing availability. Never throws away other fields. */
export function setModelEnabled(
  record: ModelRecord,
  enabled: boolean,
  now: string,
): ModelRecord {
  return {
    ...record,
    enabled,
    availability: enabled ? (record.availability === 'disabled' ? 'available' : record.availability) : 'disabled',
    updatedAt: now,
  };
}

/** The capability profile shown by the UI/registry: capability + limits + price. */
export interface ModelCapabilityProfile {
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly audio: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  readonly pricing: ModelPricing | null;
}

export const capabilityProfileOf = (record: ModelRecord): ModelCapabilityProfile => ({
  streaming: record.capabilities.streaming,
  structuredOutput: record.capabilities.structuredOutput,
  toolCalling: record.capabilities.toolCalling,
  vision: record.capabilities.vision,
  reasoning: record.capabilities.reasoning,
  audio: record.capabilities.audio,
  contextWindow: record.contextWindow,
  maxOutputTokens: record.maxOutputTokens,
  pricing: record.pricing,
});

export const aliasId = (scope: string, alias: string): string => `${scope}:${normalizeAlias(alias)}`;

/** Bind an alias to a model key. Conflicts are the caller's job to detect (see below). */
export function bindAlias(input: {
  readonly alias: string;
  readonly modelKey: string;
  readonly scope: string;
  readonly now: string;
  readonly actorId: string;
}): Result<LogicalAlias, DomainError> {
  const alias = normalizeAlias(input.alias);
  const modelKey = normalizeModelKey(input.modelKey);
  if (!ALIAS_PATTERN.test(alias)) {
    return err(domainError('VALIDATION_FAILED', `"${input.alias}" is not a valid alias.`, { alias: input.alias }));
  }
  if (!MODEL_KEY_PATTERN.test(modelKey)) {
    return err(domainError('VALIDATION_FAILED', `"${input.modelKey}" is not a valid model key.`, { modelKey: input.modelKey }));
  }
  return ok({
    id: aliasId(input.scope, alias),
    alias,
    modelKey,
    scope: input.scope,
    createdAt: input.now,
    createdBy: input.actorId,
  });
}

/**
 * Resolve exactly one model. Missing alias, unknown key, or a disabled/unavailable model
 * are all refusals - never a substitute. That is what keeps this a registry, not a router.
 */
export function resolveAlias(input: {
  readonly alias: string;
  readonly scope: string;
  readonly aliases: readonly LogicalAlias[];
  readonly records: readonly ModelRecord[];
}): Result<ModelRecord, DomainError> {
  const alias = normalizeAlias(input.alias);
  const binding =
    input.aliases.find((entry) => entry.scope === input.scope && entry.alias === alias) ??
    input.aliases.find((entry) => entry.scope === '*' && entry.alias === alias) ??
    null;
  if (binding === null) {
    return err(domainError('NOT_FOUND', `Alias "${alias}" is not bound in scope "${input.scope}".`, { alias, scope: input.scope }));
  }
  const record = input.records.find((entry) => entry.modelKey === binding.modelKey) ?? null;
  if (record === null) {
    return err(
      domainError('NOT_FOUND', `Alias "${alias}" points at unknown model "${binding.modelKey}".`, {
        alias,
        modelKey: binding.modelKey,
      }),
    );
  }
  if (!record.enabled) {
    return err(
      domainError('POLICY_DENIED', `Model "${record.modelKey}" is disabled.`, {
        alias,
        modelKey: record.modelKey,
        availability: record.availability,
      }),
    );
  }
  if (record.availability === 'unavailable') {
    return err(
      domainError('AGENT_UNAVAILABLE', `Model "${record.modelKey}" is unavailable.`, {
        alias,
        modelKey: record.modelKey,
        availability: record.availability,
      }),
    );
  }
  return ok(record);
}

/** Conflict check used by the service: one alias -> one model, per scope. */
export function aliasConflict(
  aliases: readonly LogicalAlias[],
  scope: string,
  alias: string,
  modelKey: string,
): boolean {
  const normalized = normalizeAlias(alias);
  const existing = aliases.find((entry) => entry.scope === scope && entry.alias === normalized);
  return existing !== undefined && existing.modelKey !== normalizeModelKey(modelKey);
}
