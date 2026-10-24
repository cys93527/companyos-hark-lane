/**
 * The provider registry (Sprint 6) - the executable half of the provider layer.
 *
 * What it is: a name -> adapter binding, with persistence, capability normalization,
 * pre-flight limit checks, error normalization and secret hygiene.
 *
 * What it is deliberately NOT: a router. There is no ranking, no scoring, no fallback and
 * no "best model" logic - a caller must name the provider it wants. Model routing is
 * Sprint 7+ and stays out of this file (ADR-0009).
 */
import {
  DomainError,
  assertNoSecrets,
  assertWithinContextWindow,
  defineEvent,
  domainError,
  err,
  estimateContext,
  normalizeProviderError,
  ok,
  providerErrorToDomainError,
  redactSecrets,
  redactValue,
  type Clock,
  type EntityStore,
  type EventStorePort,
  type HealthReport,
  type IdFactory,
  type InvocationRequest,
  type InvocationResult,
  type Logger,
  type ModelCapabilities,
  type ModelInfo,
  type ModelProviderPort,
  type NormalizedProviderError,
  type ProviderErrorKind,
  type ProviderModelRecord,
  type ProviderRegistration,
  type ProviderRegistryPort,
  type ProviderSelection,
  type RawModelInfo,
  type Result,
  type SecretResolver,
  type StreamChunk,
  FAULT_CHECKPOINTS,
  type FaultCheckpointPort,
} from '@companyos/core';

export interface ProviderRegistryDeps {
  readonly ids: IdFactory;
  readonly clock: Clock;
  readonly registrations: EntityStore<ProviderRegistration>;
  readonly models?: EntityStore<ProviderModelRecord>;
  /** Used only to detect/redact known secret values; never passed to a provider. */
  readonly secretResolver?: SecretResolver;
  readonly logger?: Logger;
  /** Values to mask in every outbound string (test N). */
  readonly secrets?: () => Promise<readonly string[]>;
  /**
   * Authorization policy (Sprint 7, closing the Sprint 6 debt). When wired, every mutating
   * or cost-incurring operation asks for `provider.register` / `provider.invoke` /
   * `provider.read` first. Omitted ⇒ allow-all with a single warning.
   */
  readonly authorize?: (input: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }) => Promise<Result<true, DomainError>>;
  /** Audit sink (Sprint 7): provider.registered / invoked / health_checked / failed. */
  readonly events?: EventStorePort;
  /** Actor used when a caller does not name one (composition root decides). */
  readonly systemActor?: string;
  /**
   * Task-18-08 deterministic fault-injection seam: absent in production (zero overhead),
   * armed by a test harness to prove the descriptor/bind split across restart.
   */
  readonly faultCheckpoints?: FaultCheckpointPort;
}

export interface ProviderRegistry extends ProviderRegistryPort {
  /** Adapters currently bound in this process. */
  boundProviderIds(): readonly string[];
  /** Values that must never leave the process. */
  knownSecrets(): readonly string[];
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: false,
  structuredOutput: false,
  toolCalling: false,
  vision: false,
  audio: false,
  reasoning: false,
};

/** Deterministic capability normalization: absent = unsupported (test D). */
export function normalizeCapabilities(partial?: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    streaming: partial?.streaming === true,
    structuredOutput: partial?.structuredOutput === true,
    toolCalling: partial?.toolCalling === true,
    vision: partial?.vision === true,
    audio: partial?.audio === true,
    reasoning: partial?.reasoning === true,
  };
}

/** Deterministic model normalization: display name, output cap and pricing get defaults. */
export function normalizeModelInfo(raw: RawModelInfo): ModelInfo {
  return {
    modelId: raw.modelId,
    displayName: raw.displayName ?? raw.modelId,
    contextWindow: raw.contextWindow,
    maxOutputTokens: raw.maxOutputTokens ?? null,
    capabilities: normalizeCapabilities(raw.capabilities),
    pricing: raw.pricing ?? null,
    metadata: raw.metadata ?? {},
  };
}

/** Core error code -> provider error kind (used when an adapter surfaces a DomainError). */
const KIND_BY_CODE: Readonly<Record<string, ProviderErrorKind>> = {
  TIMEOUT: 'timeout',
  LIMIT_EXCEEDED: 'rate_limited',
  PERMISSION_DENIED: 'auth_failed',
  INVALID_ARGUMENT: 'invalid_request',
  CAPABILITY_MISSING: 'tool_unsupported',
  AGENT_UNAVAILABLE: 'unavailable',
  POLICY_DENIED: 'content_filtered',
  NOT_FOUND: 'invalid_request',
  VALIDATION_FAILED: 'invalid_request',
  PERSISTENCE_FAILED: 'unknown',
  CONFLICT: 'unknown',
  ILLEGAL_TRANSITION: 'invalid_request',
};

/** How a provider adapter declares a specific failure kind (see MockProvider). */
export const PROVIDER_KIND_MARKER = 'companyos.provider.kind';

export function classifyProviderFailure(
  error: unknown,
  providerId: string | null,
): NormalizedProviderError {
  if (error instanceof DomainError) {
    const marked = error.details[PROVIDER_KIND_MARKER];
    const kind =
      typeof marked === 'string'
        ? (marked as ProviderErrorKind)
        : (KIND_BY_CODE[error.code] ?? 'unknown');
    const retryAfter = error.details['retryAfterMs'];
    return normalizeProviderError({
      kind,
      message: error.message,
      providerId,
      retryAfterMs: typeof retryAfter === 'number' ? retryAfter : null,
      upstreamCode:
        typeof error.details['upstreamCode'] === 'string'
          ? String(error.details['upstreamCode'])
          : null,
    });
  }
  return normalizeProviderError({
    kind: 'unknown',
    message: error instanceof Error ? error.message : String(error),
    providerId,
  });
}

/** Heuristic classification for adapters that throw raw Errors (Sprint 7.1 MEDIUM-3). */
export function classifyPlainError(
  error: unknown,
  providerId: string | null,
): NormalizedProviderError {
  const message = error instanceof Error ? error.message : String(error);
  const kind: ProviderErrorKind = /timeout|timed out|ETIMEDOUT|aborted/i.test(message)
    ? 'timeout'
    : /ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|unreachable/i.test(message)
      ? 'unavailable'
      : 'unknown';
  return normalizeProviderError({ kind, message, providerId });
}

export function createProviderRegistry(deps: ProviderRegistryDeps): ProviderRegistry {
  const bound = new Map<string, ModelProviderPort>();
  let knownSecrets: readonly string[] = [];
  const systemActor = deps.systemActor ?? 'system';
  let warnedAboutPolicy = false;

  const nowIso = (): string => deps.clock.nowIso();

  const refreshSecrets = async (): Promise<void> => {
    knownSecrets = deps.secrets === undefined ? [] : await deps.secrets();
  };

  const redacted = (message: string): string => redactSecrets(message, knownSecrets);

  const notFound = (providerId: string): DomainError =>
    domainError('NOT_FOUND', `Provider "${providerId}" is not registered.`, {
      providerId,
      guard: 'provider-binding',
    });

  const requireBound = (providerId: string): ModelProviderPort => {
    const provider = bound.get(providerId);
    if (provider === undefined) throw notFound(providerId);
    return provider;
  };

  /** Fail-closed authorization when a policy is wired (Sprint 6 debt, closed in Sprint 7). */
  const permit = async (
    actorId: string | undefined,
    authority: string,
  ): Promise<Result<true, DomainError>> => {
    if (deps.authorize === undefined) {
      if (!warnedAboutPolicy) {
        warnedAboutPolicy = true;
        deps.logger?.warn('no authorization policy wired: provider permissions are not enforced');
      }
      return ok(true);
    }
    try {
      return await deps.authorize({ actorId: actorId ?? systemActor, authority });
    } catch (error) {
      return err(
        error instanceof DomainError
          ? error
          : domainError(
              'PERMISSION_DENIED',
              error instanceof Error ? error.message : String(error),
              {},
            ),
      );
    }
  };

  /** Provider audit trail (Sprint 7). Payloads are redacted and never carry credentials. */
  const audit = async (
    type: string,
    providerId: string,
    actorId: string | undefined,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    if (deps.events === undefined) return;
    await deps.events.append([
      defineEvent(
        {
          type,
          aggregateId: providerId,
          aggregateType: 'Provider',
          traceId: deps.ids.id('trace'),
          actorId: actorId ?? systemActor,
          payload: redactValue(payload, knownSecrets) as Record<string, unknown>,
        },
        deps.ids,
        nowIso(),
      ),
    ]);
  };

  const upsertModel = async (providerId: string, info: ModelInfo): Promise<void> => {
    if (deps.models === undefined) return;
    await deps.models.put({
      id: `${providerId}:${info.modelId}`,
      providerId,
      modelId: info.modelId,
      displayName: info.displayName,
      contextWindow: info.contextWindow,
      maxOutputTokens: info.maxOutputTokens,
      capabilities: info.capabilities,
      pricing: info.pricing,
      metadata: info.metadata ?? {},
      updatedAt: nowIso(),
    });
  };

  /** Capability + limit pre-flight, shared by invoke and stream (tests I, M). */
  const preflight = async (
    providerId: string,
    request: InvocationRequest,
    options: { readonly requireStreaming?: boolean } = {},
  ): Promise<ModelInfo> => {
    // F2 closure: the catalogue preflight carries the INVOCATION cancellation - a hung
    // /models call dies with the caller deadline as CANCELLED (never a retryable timeout).
    const listed = await registry.models(providerId, { signal: request.signal });
    if (!listed.ok) throw listed.error;
    const model = listed.value.find((entry: ModelInfo) => entry.modelId === request.modelId);
    if (model === undefined) {
      throw domainError(
        'NOT_FOUND',
        `Model "${request.modelId}" is unknown for provider "${providerId}".`,
        {
          providerId,
          modelId: request.modelId,
          guard: 'preflight',
        },
      );
    }
    if (options.requireStreaming === true && !model.capabilities.streaming) {
      // A declared capability is a promise, not a hint (Sprint 6 review MEDIUM-5).
      throw providerErrorToDomainError(
        normalizeProviderError({
          kind: 'streaming_unsupported',
          message: `Model "${model.modelId}" does not support streaming.`,
          providerId,
        }),
      );
    }
    if (request.responseFormat !== undefined && !model.capabilities.structuredOutput) {
      throw providerErrorToDomainError(
        normalizeProviderError({
          kind: 'structured_output_unsupported',
          message: `Model "${model.modelId}" cannot produce structured output.`,
          providerId,
        }),
      );
    }
    if (
      request.tools !== undefined &&
      request.tools.length > 0 &&
      !model.capabilities.toolCalling
    ) {
      throw providerErrorToDomainError(
        normalizeProviderError({
          kind: 'tool_unsupported',
          message: `Model "${model.modelId}" does not support tool calling.`,
          providerId,
        }),
      );
    }
    if (
      request.maxOutputTokens !== undefined &&
      model.maxOutputTokens !== null &&
      request.maxOutputTokens > model.maxOutputTokens
    ) {
      throw providerErrorToDomainError(
        normalizeProviderError({
          kind: 'invalid_request',
          message: `Requested output (${request.maxOutputTokens}) exceeds the model cap (${model.maxOutputTokens}).`,
          providerId,
        }),
      );
    }
    const estimate = estimateContext(request.messages.map((message) => message.content));
    const within = assertWithinContextWindow(estimate, model.contextWindow);
    if (!within.ok) {
      throw providerErrorToDomainError(
        normalizeProviderError({
          kind: 'context_limit',
          message: within.error.message,
          providerId,
        }),
        {
          estimatedTokens: estimate.tokens,
          contextWindow: model.contextWindow,
          breakdown: estimate.breakdown,
          conservative: estimate.conservative,
        },
      );
    }
    return model;
  };

  const guardOutbound = (payload: unknown, context: string): void => {
    const clean = assertNoSecrets(payload, knownSecrets, context);
    if (!clean.ok) throw clean.error;
  };

  const registry: ProviderRegistry = {
    boundProviderIds: () => [...bound.keys()].sort(),
    knownSecrets: () => [...knownSecrets],

    async register(provider, options = {}): Promise<Result<ProviderRegistration, DomainError>> {
      await refreshSecrets();
      const permitted = await permit(options.actorId, 'provider.register');
      if (!permitted.ok) return permitted;
      const descriptor = provider.describe();
      /** Every failed registration is audited too (Closeout-7.5 MEDIUM-1). */
      const refuse = async (
        error: DomainError,
        kind: ProviderErrorKind,
      ): Promise<Result<ProviderRegistration, DomainError>> => {
        await audit('provider.failed', descriptor.providerId, options.actorId, {
          providerId: descriptor.providerId,
          kind,
          phase: 'register',
        });
        return err(error);
      };
      if (bound.has(descriptor.providerId)) {
        return refuse(
          domainError('CONFLICT', `Provider "${descriptor.providerId}" is already registered.`, {
            providerId: descriptor.providerId,
          }),
          'invalid_request',
        );
      }
      const persisted = await deps.registrations.get(descriptor.providerId);
      if (persisted !== null) {
        /*
         * Restart semantics (descriptor/adapter split): the durable row is CONFIGURATION truth
         * and the adapter is PROCESS-LOCAL capability, so a later composition over the same
         * storage must be able to re-bind its configured adapter. The rebind is an idempotent
         * registration, and it fails closed on any drift between the trusted configured
         * adapter and the persisted descriptor — no silent replacement, ever.
         */
        const mismatches: string[] = [];
        if (persisted.kind !== descriptor.kind) mismatches.push('kind');
        if (persisted.displayName !== descriptor.displayName) mismatches.push('displayName');
        const catalogue = await provider.listModels();
        if (!catalogue.ok) {
          return refuse(catalogue.error, classifyProviderFailure(catalogue.error, descriptor.providerId).kind);
        }
        const offered = catalogue.value.map(normalizeModelInfo).map((model) => model.modelId).sort();
        const stored =
          deps.models === undefined
            ? []
            : (await deps.models.list({ limit: 500 }))
                .items.filter((row) => row.providerId === descriptor.providerId)
                .map((row) => row.modelId)
                .sort();
        if (offered.join(' ') !== stored.join(' ')) mismatches.push('models');
        if (mismatches.length > 0) {
          return refuse(
            domainError(
              'CONFLICT',
              `Provider "${descriptor.providerId}" is persisted with a different descriptor (${mismatches.join(', ')}); refusing to replace it silently.`,
              {
                providerId: descriptor.providerId,
                mismatches,
                persisted: { kind: persisted.kind, displayName: persisted.displayName },
                offered: { kind: descriptor.kind, displayName: descriptor.displayName },
              },
            ),
            'invalid_request',
          );
        }
        // Task-18-08: the durable descriptor is verified; the process-local bind has not
        // happened yet. A crash here must leave the descriptor intact and the adapter unbound.
        await deps.faultCheckpoints?.checkpoint(
          FAULT_CHECKPOINTS.providerDescriptorBeforeRuntimeBind,
        );
        bound.set(descriptor.providerId, provider);
        // `enabled` is registry STATE, not descriptor: a disabled provider stays disabled and
        // its adapter is still bound (invocation keeps its own gates).
        deps.logger?.info('provider adapter rebound', { providerId: descriptor.providerId });
        await audit('provider.rebound', descriptor.providerId, options.actorId, {
          providerId: descriptor.providerId,
          kind: descriptor.kind,
          models: offered.length,
        });
        return ok(persisted);
      }
      const raw = await provider.listModels();
      if (!raw.ok) {
        return refuse(raw.error, classifyProviderFailure(raw.error, descriptor.providerId).kind);
      }
      const models = raw.value.map(normalizeModelInfo);
      const at = nowIso();
      const registration: ProviderRegistration = {
        id: descriptor.providerId,
        providerId: descriptor.providerId,
        kind: descriptor.kind,
        displayName: descriptor.displayName,
        enabled: options.enabled !== false,
        lastHealth: null,
        registeredAt: at,
        updatedAt: at,
      };
      await deps.registrations.put(registration);
      for (const model of models) await upsertModel(descriptor.providerId, model);
      // Task-18-08: the descriptor AND catalogue are durable; the runtime bind follows.
      await deps.faultCheckpoints?.checkpoint(
        FAULT_CHECKPOINTS.providerDescriptorBeforeRuntimeBind,
      );
      bound.set(descriptor.providerId, provider);
      deps.logger?.info('provider registered', {
        providerId: descriptor.providerId,
        kind: descriptor.kind,
        models: models.length,
      });
      await audit('provider.registered', descriptor.providerId, options.actorId, {
        providerId: descriptor.providerId,
        kind: descriptor.kind,
        models: models.length,
      });
      return ok(registration);
    },

    async unregister(providerId: string, options = {}): Promise<Result<boolean, DomainError>> {
      const permitted = await permit(options.actorId, 'provider.register');
      if (!permitted.ok) return permitted;
      bound.delete(providerId);
      const removed = await deps.registrations.delete(providerId);
      // The catalogue goes with the registration, otherwise the offline branch would keep
      // serving models of a provider that no longer exists (Sprint 6 review LOW-1).
      if (deps.models !== undefined) {
        const rows = (await deps.models.list({ limit: 500 })).items.filter(
          (row) => row.providerId === providerId,
        );
        for (const row of rows) await deps.models.delete(row.id);
      }
      return ok(removed);
    },

    get(providerId: string): ModelProviderPort | null {
      return bound.get(providerId) ?? null;
    },

    async list(): Promise<readonly ProviderRegistration[]> {
      return (await deps.registrations.list({ limit: 500 })).items;
    },

    async models(providerId: string, options?: { readonly signal?: AbortSignal }): Promise<Result<readonly ModelInfo[], DomainError>> {
      const provider = bound.get(providerId);
      if (provider === undefined) {
        // Offline: serve the persisted catalogue (still a Result, never a throw).
        if (deps.models === undefined) return ok([]);
        const rows = (await deps.models.list({ limit: 500 })).items.filter(
          (row) => row.providerId === providerId,
        );
        return ok(
          rows.map((row) =>
            normalizeModelInfo({
              modelId: row.modelId,
              displayName: row.displayName,
              contextWindow: row.contextWindow,
              maxOutputTokens: row.maxOutputTokens,
              capabilities: row.capabilities,
              pricing: row.pricing,
              metadata: row.metadata,
            }),
          ),
        );
      }
      // F2 closure: the catalogue read carries the caller cancellation.
      const raw = await provider.listModels(options?.signal);
      if (!raw.ok) {
        // F2 truthfulness: a CANCELLED catalogue is the caller cancellation arriving at
        // the provider - it must NOT be laundered into a retryable provider failure.
        if (raw.error.code === 'CANCELLED') return err(raw.error);
        // A provider failure is a normalized error, never a bare data object
        // (Sprint 6 review MEDIUM-1: this used to lie about being a DomainError).
        return err(providerErrorToDomainError(classifyProviderFailure(raw.error, providerId)));
      }
      const models = raw.value.map(normalizeModelInfo);
      for (const model of models) await upsertModel(providerId, model);
      return ok(models);
    },

    async health(providerId: string, options = {}): Promise<Result<HealthReport, DomainError>> {
      const permitted = await permit(options.actorId, 'provider.read');
      if (!permitted.ok) return permitted;
      const provider = bound.get(providerId);
      if (provider === undefined) {
        const persisted = await deps.registrations.get(providerId);
        if (persisted?.lastHealth != null) return ok(persisted.lastHealth);
        return err(notFound(providerId));
      }
      const report = await provider.health();
      if (!report.ok) {
        const normalized = classifyProviderFailure(report.error, providerId);
        const existing = await deps.registrations.get(providerId);
        if (existing !== null) {
          await deps.registrations.put({
            ...existing,
            lastHealth: {
              status: 'unavailable',
              checkedAt: nowIso(),
              latencyMs: null,
              detail: normalized.message,
            },
            updatedAt: nowIso(),
          });
        }
        return err(providerErrorToDomainError(normalized));
      }
      const existing = await deps.registrations.get(providerId);
      if (existing !== null) {
        await deps.registrations.put({
          ...existing,
          lastHealth: {
            ...report.value,
            detail: report.value.detail === null ? null : redacted(report.value.detail),
          },
          updatedAt: nowIso(),
        });
      }
      await audit('provider.health_checked', providerId, options.actorId, {
        providerId,
        status: report.value.status,
        latencyMs: report.value.latencyMs,
      });
      return ok({
        ...report.value,
        detail: report.value.detail === null ? null : redacted(report.value.detail),
      });
    },

    async invoke(
      selection: ProviderSelection,
      request: InvocationRequest,
    ): Promise<Result<InvocationResult, DomainError>> {
      try {
        await refreshSecrets();
      } catch (error) {
        // Secret refresh belongs INSIDE the audited path (Closeout-7.5 MEDIUM-1).
        const normalized = classifyPlainError(error, selection.providerId);
        await audit('provider.failed', selection.providerId, selection.actorId, {
          providerId: selection.providerId,
          modelId: request.modelId,
          kind: normalized.kind,
          phase: 'secret_refresh',
        });
        return err(providerErrorToDomainError(normalized));
      }
      const permitted = await permit(selection.actorId, 'provider.invoke');
      if (!permitted.ok) return permitted;
      try {
        const provider = requireBound(selection.providerId);
        await preflight(selection.providerId, request);
        // F2 closure: a cancellation that fired while the preflight ran ends the
        // invocation HERE - the provider is never invoked on an aborted signal.
        if (request.signal?.aborted) {
          return err(domainError('CANCELLED', 'The model invocation was cancelled.', { kind: 'CANCELLED' }));
        }
        const result = await provider.invoke(request);
        if (!result.ok) {
          // Task-18-06 corrective: a cancelled invocation is NOT a provider failure. The
          // adapter honored the signal contract, so the caller's durable record must say
          // CANCELLED — re-classifying it as AGENT_UNAVAILABLE would disguise a cancellation
          // as a retryable provider outage and invite exactly the retry that is forbidden.
          if (result.error.code === 'CANCELLED') {
            deps.logger?.info('provider invocation cancelled', {
              providerId: selection.providerId,
              modelId: request.modelId,
            });
            await audit('provider.cancelled', selection.providerId, selection.actorId, {
              providerId: selection.providerId,
              modelId: request.modelId,
              phase: 'invoke',
            });
            return err(result.error);
          }
          const normalized = classifyProviderFailure(result.error, selection.providerId);
          deps.logger?.warn('provider invocation failed', {
            providerId: selection.providerId,
            kind: normalized.kind,
            message: normalized.message,
          });
          await audit('provider.failed', selection.providerId, selection.actorId, {
            providerId: selection.providerId,
            modelId: request.modelId,
            kind: normalized.kind,
            phase: 'invoke',
          });
          return err(providerErrorToDomainError(normalized));
        }
        // Nothing leaving the registry may carry a credential (requirement N).
        guardOutbound(result.value, 'provider invocation result');
        await audit('provider.invoked', selection.providerId, selection.actorId, {
          providerId: selection.providerId,
          modelId: result.value.modelId,
          inputTokens: result.value.usage.inputTokens,
          outputTokens: result.value.usage.outputTokens,
          finishReason: result.value.finishReason,
        });
        return ok({
          ...result.value,
          outputText: redacted(result.value.outputText),
        });
      } catch (error) {
        // Task-18-06 corrective: an adapter that rejects with a cancellation (instead of
        // returning the canonical `err(CANCELLED)`) is still a cancellation, and must not be
        // laundered into a provider failure by the classifier.
        if (error instanceof DomainError && error.code === 'CANCELLED') {
          await audit('provider.cancelled', selection.providerId, selection.actorId, {
            providerId: selection.providerId,
            modelId: request.modelId,
            phase: 'invoke',
          });
          return err(error);
        }
        // A provider-declared failure carries a marker: normalize it. Anything else that
        // is already a DomainError is one of our own guards (context limit, secret leak,
        // unknown model) and is returned untouched.
        if (error instanceof DomainError) {
          const marked = error.details[PROVIDER_KIND_MARKER];
          if (typeof marked === 'string') {
            const normalized = classifyProviderFailure(error, selection.providerId);
            await audit('provider.failed', selection.providerId, selection.actorId, {
              providerId: selection.providerId,
              modelId: request.modelId,
              kind: normalized.kind,
              phase: 'invoke',
            });
            return err(providerErrorToDomainError(normalized));
          }
          // Our own guards (preflight gates, binding, secret material) already carry a
          // marker: they are the answer, not an adapter failure to re-classify - but they
          // are still audited as a failed invocation (Closeout-7.5 MEDIUM-1).
          if (
            typeof error.details['kind'] === 'string' ||
            typeof error.details['guard'] === 'string'
          ) {
            await audit('provider.failed', selection.providerId, selection.actorId, {
              providerId: selection.providerId,
              modelId: request.modelId,
              kind:
                typeof error.details['kind'] === 'string'
                  ? String(error.details['kind'])
                  : 'invalid_request',
              phase: 'preflight',
            });
            return err(error);
          }
          const normalized = classifyPlainError(error, selection.providerId);
          await audit('provider.failed', selection.providerId, selection.actorId, {
            providerId: selection.providerId,
            modelId: request.modelId,
            kind: normalized.kind,
            phase: 'invoke',
          });
          return err(providerErrorToDomainError(normalized));
        }
        const normalized = classifyPlainError(error, selection.providerId);
        await audit('provider.failed', selection.providerId, selection.actorId, {
          providerId: selection.providerId,
          modelId: request.modelId,
          kind: normalized.kind,
          phase: 'invoke',
        });
        return err(providerErrorToDomainError(normalized));
      }
    },

    stream(
      selection: ProviderSelection,
      request: InvocationRequest,
    ): AsyncIterable<Result<StreamChunk, DomainError>> {
      const providerId = selection.providerId;
      const actorId = selection.actorId;
      return {
        [Symbol.asyncIterator]: () => {
          const inner = (async function* iterate() {
            try {
              await refreshSecrets();
              const provider = requireBound(providerId);
              await preflight(providerId, request, { requireStreaming: true });
              for await (const chunk of provider.stream(request)) {
                if (!chunk.ok) {
                  const normalized = classifyProviderFailure(chunk.error, providerId);
                  await audit('provider.failed', providerId, actorId, {
                    providerId,
                    modelId: request.modelId,
                    kind: normalized.kind,
                    phase: 'stream',
                  });
                  yield err(providerErrorToDomainError(normalized));
                  return;
                }
                const value = chunk.value;
                const guarded = assertNoSecrets(value, knownSecrets, 'stream chunk');
                if (!guarded.ok) {
                  await audit('provider.failed', providerId, actorId, {
                    providerId,
                    modelId: request.modelId,
                    kind: 'unknown',
                    phase: 'stream',
                    reason: 'secret_material_in_stream',
                  });
                  yield err(guarded.error);
                  return;
                }
                yield ok({ ...value, deltaText: redacted(value.deltaText) });
              }
            } catch (error) {
              // A throwing adapter must also be audited (Sprint 7.1 MEDIUM-3).
              const normalized = classifyPlainError(error, providerId);
              await audit('provider.failed', providerId, actorId, {
                providerId,
                modelId: request.modelId,
                kind: normalized.kind,
                phase: 'stream',
              });
              yield err(providerErrorToDomainError(normalized));
            }
          })();
          return inner;
        },
      };
    },
  };

  void redactValue;
  void DEFAULT_CAPABILITIES;
  return registry;
}
