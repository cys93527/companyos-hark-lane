/**
 * Model Registry service (Sprint 7) - the curated layer over provider catalogues.
 *
 * What it does: persist CompanyOS-owned model records (stable key, description, capability
 * profile, enabled flag, availability), bind logical aliases, expose health, and write the
 * audit trail.
 *
 * What it must never do (the whole point of the sprint): choose a model. There is no
 * scoring, no ranking, no fallback and no "best available" search in this file. Every read
 * is by key or by exact alias (ADR-0010).
 */
import {
  DomainError,
  aliasConflict,
  aliasId,
  availabilityOf,
  bindAlias,
  capabilityProfileOf,
  createModelRecord,
  defineEvent,
  domainError,
  err,
  modelRecordFromProviderModel,
  ok,
  resolveAlias,
  setModelEnabled,
  type Clock,
  type EntityStore,
  type EventStorePort,
  type IdFactory,
  type LogicalAlias,
  type Logger,
  type ModelCapabilityProfile,
  type ModelRecord,
  type ProviderRegistryPort,
  type Result,
} from '@companyos/core';

export interface ModelRegistryDeps {
  readonly ids: IdFactory;
  readonly clock: Clock;
  readonly records: EntityStore<ModelRecord>;
  readonly aliases: EntityStore<LogicalAlias>;
  /** Read-only use: the catalogue and provider health. Never asked to choose anything. */
  readonly providers: ProviderRegistryPort;
  readonly authorize?: (input: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }) => Promise<Result<true, DomainError>>;
  readonly events?: EventStorePort;
  readonly logger?: Logger;
  /** Alias scope for the default workspace; `*` means "every scope". */
  readonly scope?: string;
}

export interface RegisterModelFromProviderInput {
  readonly providerId: string;
  readonly providerModelId: string;
  /** Defaults to `<providerId>.<providerModelId>`. */
  readonly modelKey?: string;
  readonly description?: string;
  readonly actorId: string;
}

export interface ModelRegistryService {
  registerFromProvider(input: RegisterModelFromProviderInput): Promise<Result<ModelRecord, DomainError>>;
  unregister(modelKey: string, actorId: string): Promise<Result<boolean, DomainError>>;
  get(modelKey: string): Promise<ModelRecord | null>;
  list(options?: { readonly includeDisabled?: boolean }): Promise<readonly ModelRecord[]>;
  setEnabled(modelKey: string, enabled: boolean, actorId: string): Promise<Result<ModelRecord, DomainError>>;
  bindAlias(input: { readonly alias: string; readonly modelKey: string; readonly scope?: string; readonly actorId: string }): Promise<Result<LogicalAlias, DomainError>>;
  resolve(alias: string, scope?: string): Promise<Result<ModelRecord, DomainError>>;
  aliasList(): Promise<readonly LogicalAlias[]>;
  capabilityProfile(modelKey: string): Promise<Result<ModelCapabilityProfile, DomainError>>;
  /** Availability = enabled flag + whether the owning provider is still registered. */
  availability(modelKey: string): Promise<Result<ModelRecord['availability'], DomainError>>;
  /** Refresh availability for every record of one provider (persisted health only). */
  refreshProvider(providerId: string): Promise<readonly ModelRecord[]>;
  /** Explicit live probe (authority-checked + audited). */
  refreshHealth(providerId: string, actorId: string): Promise<Result<readonly ModelRecord[], DomainError>>;
}

export function createModelRegistry(deps: ModelRegistryDeps): ModelRegistryService {
  const nowIso = (): string => deps.clock.nowIso();
  const scope = deps.scope ?? '*';

  const loadRecords = async (): Promise<readonly ModelRecord[]> => (await deps.records.list({ limit: 500 })).items;
  const loadAliases = async (): Promise<readonly LogicalAlias[]> => (await deps.aliases.list({ limit: 500 })).items;

  const byKey = async (modelKey: string): Promise<ModelRecord | null> => {
    const normalized = modelKey.trim().toLowerCase();
    return (await loadRecords()).find((entry) => entry.modelKey === normalized) ?? null;
  };

  const audited = async (
    type: string,
    aggregateId: string,
    actorId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    if (deps.events === undefined) return;
    await deps.events.append([
      defineEvent(
        {
          type,
          aggregateId,
          aggregateType: 'ModelRecord',
          traceId: deps.ids.id('trace'),
          actorId,
          payload,
        },
        deps.ids,
        nowIso(),
      ),
    ]);
  };

  /** Fail-closed when a policy is wired; allow-all (and log once) when it is not. */
  let warned = false;
  const permit = async (actorId: string, authority: string, scopeId?: string): Promise<Result<true, DomainError>> => {
    if (deps.authorize === undefined) {
      if (!warned) {
        warned = true;
        deps.logger?.warn('no authorization policy wired: model registry permissions are not enforced');
      }
      return ok(true);
    }
    try {
      return await deps.authorize({
        actorId,
        authority,
        ...(scopeId === undefined ? {} : { scopeId }),
      });
    } catch (error) {
      return err(
        error instanceof DomainError
          ? error
          : domainError('PERMISSION_DENIED', error instanceof Error ? error.message : String(error), {}),
      );
    }
  };

  /**
   * Availability is derived from the ENABLED flag and the provider's PERSISTED health.
   *
   * Sprint 7.1 MEDIUM-4: this must never perform a live health call - a UI list would then
   * fan out N probes, write N rows and implicitly act as the system actor. Live probing is
   * an explicit, authorized, audited operation (`refreshHealth`).
   */
  const withDerivedAvailability = async (record: ModelRecord): Promise<ModelRecord> => {
    if (!record.enabled) return { ...record, availability: 'disabled' };
    const registration = (await deps.providers.list()).find(
      (entry) => entry.providerId === record.providerId,
    );
    if (registration === undefined) return { ...record, availability: 'unavailable' };
    const status = registration.lastHealth?.status ?? 'healthy';
    return { ...record, availability: availabilityOf(record, status) };
  };

  return {
    async registerFromProvider(input: RegisterModelFromProviderInput): Promise<Result<ModelRecord, DomainError>> {
      const permitted = await permit(input.actorId, 'model.register', input.providerId);
      if (!permitted.ok) return permitted;

      const catalogue = await deps.providers.models(input.providerId);
      if (!catalogue.ok) return catalogue;
      const model = catalogue.value.find((entry) => entry.modelId === input.providerModelId);
      if (model === undefined) {
        return err(
          domainError('NOT_FOUND', `Provider "${input.providerId}" has no model "${input.providerModelId}".`, {
            providerId: input.providerId,
            providerModelId: input.providerModelId,
          }),
        );
      }
      const built = modelRecordFromProviderModel({
        id: deps.ids.id('mdl'),
        ...(input.modelKey === undefined ? {} : { modelKey: input.modelKey }),
        providerId: input.providerId,
        model,
        ...(input.description === undefined ? {} : { description: input.description }),
        now: nowIso(),
        actorId: input.actorId,
      });
      if (!built.ok) return built;

      const records = await loadRecords();
      if (records.some((entry) => entry.modelKey === built.value.modelKey)) {
        return err(
          domainError('CONFLICT', `Model key "${built.value.modelKey}" is already registered.`, {
            modelKey: built.value.modelKey,
          }),
        );
      }
      if (
        records.some(
          (entry) =>
            entry.providerId === built.value.providerId &&
            entry.providerModelId === built.value.providerModelId,
        )
      ) {
        return err(
          domainError('CONFLICT', 'This provider model is already registered under another key.', {
            providerId: built.value.providerId,
            providerModelId: built.value.providerModelId,
          }),
        );
      }

      await deps.records.put(built.value);
      await audited('model.registered', built.value.modelKey, input.actorId, {
        modelKey: built.value.modelKey,
        providerId: built.value.providerId,
        providerModelId: built.value.providerModelId,
        contextWindow: built.value.contextWindow,
      });
      deps.logger?.info('model registered', {
        modelKey: built.value.modelKey,
        providerId: built.value.providerId,
      });
      return ok(built.value);
    },

    async unregister(modelKey: string, actorId: string): Promise<Result<boolean, DomainError>> {
      const permitted = await permit(actorId, 'model.write', modelKey);
      if (!permitted.ok) return permitted;
      const record = await byKey(modelKey);
      if (record === null) {
        return err(domainError('NOT_FOUND', `Model "${modelKey}" is not registered.`, { modelKey }));
      }
      const aliases = (await loadAliases()).filter((entry) => entry.modelKey === record.modelKey);
      for (const alias of aliases) await deps.aliases.delete(alias.id);
      return ok(await deps.records.delete(record.id));
    },

    async get(modelKey: string): Promise<ModelRecord | null> {
      // Sprint 7.1 MEDIUM-4: `get` returns the DERIVED record, so a caller can never see a
      // stale `available` for a provider that is gone.
      const record = await byKey(modelKey);
      return record === null ? null : withDerivedAvailability(record);
    },

    async list(options = {}): Promise<readonly ModelRecord[]> {
      const records = await loadRecords();
      const visible = options.includeDisabled === true ? records : records.filter((entry) => entry.enabled);
      const derived: ModelRecord[] = [];
      for (const record of visible) derived.push(await withDerivedAvailability(record));
      return derived.sort((left, right) => (left.modelKey < right.modelKey ? -1 : left.modelKey > right.modelKey ? 1 : 0));
    },

    async setEnabled(modelKey: string, enabled: boolean, actorId: string): Promise<Result<ModelRecord, DomainError>> {
      const permitted = await permit(actorId, 'model.write', modelKey);
      if (!permitted.ok) return permitted;
      const record = await byKey(modelKey);
      if (record === null) {
        return err(domainError('NOT_FOUND', `Model "${modelKey}" is not registered.`, { modelKey }));
      }
      const next = setModelEnabled(record, enabled, nowIso());
      await deps.records.put(next);
      await audited(enabled ? 'model.enabled' : 'model.disabled', next.modelKey, actorId, {
        modelKey: next.modelKey,
        enabled,
      });
      return ok(next);
    },

    async bindAlias(input): Promise<Result<LogicalAlias, DomainError>> {
      const permitted = await permit(input.actorId, 'model.write', input.modelKey);
      if (!permitted.ok) return permitted;
      const record = await byKey(input.modelKey);
      if (record === null) {
        return err(domainError('NOT_FOUND', `Model "${input.modelKey}" is not registered.`, { modelKey: input.modelKey }));
      }
      const bindingScope = input.scope ?? scope;
      const built = bindAlias({
        alias: input.alias,
        modelKey: record.modelKey,
        scope: bindingScope,
        now: nowIso(),
        actorId: input.actorId,
      });
      if (!built.ok) return built;

      const aliases = await loadAliases();
      if (aliasConflict(aliases, bindingScope, input.alias, record.modelKey)) {
        const existing = aliases.find(
          (entry) => entry.scope === bindingScope && entry.alias === built.value.alias,
        );
        return err(
          domainError('CONFLICT', `Alias "${built.value.alias}" is already bound to "${existing?.modelKey ?? '?'}".`, {
            alias: built.value.alias,
            scope: bindingScope,
            currentModelKey: existing?.modelKey ?? null,
            requestedModelKey: record.modelKey,
          }),
        );
      }
      await deps.aliases.put({ ...built.value, id: aliasId(bindingScope, built.value.alias) });
      await audited('model.alias_bound', record.modelKey, input.actorId, {
        alias: built.value.alias,
        modelKey: record.modelKey,
        scope: bindingScope,
      });
      return ok(built.value);
    },

    async resolve(alias: string, requestedScope?: string): Promise<Result<ModelRecord, DomainError>> {
      // Resolve against DERIVED availability: a model whose provider is gone must be
      // refused, and the stored row alone cannot know that (Sprint 7 test C).
      const stored = await loadRecords();
      const derived: ModelRecord[] = [];
      for (const record of stored) derived.push(await withDerivedAvailability(record));
      const resolved = resolveAlias({
        alias,
        scope: requestedScope ?? scope,
        aliases: await loadAliases(),
        records: derived,
      });
      if (!resolved.ok) return resolved;
      return ok(resolved.value);
    },

    async aliasList(): Promise<readonly LogicalAlias[]> {
      return loadAliases();
    },

    async capabilityProfile(modelKey: string): Promise<Result<ModelCapabilityProfile, DomainError>> {
      const record = await byKey(modelKey);
      if (record === null) {
        return err(domainError('NOT_FOUND', `Model "${modelKey}" is not registered.`, { modelKey }));
      }
      return ok(capabilityProfileOf(record));
    },

    async availability(modelKey: string): Promise<Result<ModelRecord['availability'], DomainError>> {
      const record = await byKey(modelKey);
      if (record === null) {
        return err(domainError('NOT_FOUND', `Model "${modelKey}" is not registered.`, { modelKey }));
      }
      return ok((await withDerivedAvailability(record)).availability);
    },

    async refreshProvider(providerId: string): Promise<readonly ModelRecord[]> {
      const records = (await loadRecords()).filter((entry) => entry.providerId === providerId);
      const updated: ModelRecord[] = [];
      for (const record of records) {
        updated.push(await withDerivedAvailability(record));
      }
      return updated;
    },

    /**
     * The ONLY live health probe in the registry (Sprint 7.1 MEDIUM-4): explicit,
     * authority-checked (`provider.read`) and audited by the provider registry itself
     * (`provider.health_checked`).
     */
    async refreshHealth(providerId: string, actorId: string): Promise<Result<readonly ModelRecord[], DomainError>> {
      const permitted = await permit(actorId, 'provider.read', providerId);
      if (!permitted.ok) return permitted;
      const health = await deps.providers.health(providerId, { actorId });
      if (!health.ok) return health;
      const records = (await loadRecords()).filter((entry) => entry.providerId === providerId);
      const updated: ModelRecord[] = [];
      for (const record of records) updated.push(await withDerivedAvailability(record));
      // The audit event is written by the provider registry (`provider.health_checked`), so
      // the same probe is not recorded twice (Closeout-7.5 LOW).
      return ok(updated);
    },
  };
}

/** Re-exported so callers do not have to import Core just to validate a key. */
export { createModelRecord };
