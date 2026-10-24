/**
 * Run-pinned model bindings (Sprint 18 / Task-18-02) — the Domain half of
 * `MODEL_BINDING_RUN_PINNING_GAP`.
 *
 * `RunSnapshot.modelBindings` has existed since Sprint 4 as the pin slot for
 * "logical binding name → provider/model id", but production snapshots always carried `{}`
 * and nothing read it back: bindings were resolved fresh, per agent execution, with no
 * run-level trusted context. A future Supervisor must be able to say WHICH model context a
 * run is frozen on, so the pin has to be trustworthy and retrievable.
 *
 * V1 is deliberately minimal (Task-18-02 §24): no routing, no ranking, no fallback, no
 * provider switching. It guarantees exactly four things:
 *   1. a binding is supplied by the TRUSTED application/run-creation configuration;
 *   2. every supplied binding resolves against the real Model Registry at creation time
 *      (unknown or disabled → fail closed, never a silent default);
 *   3. the normalized map is frozen inside the immutable RunSnapshot;
 *   4. it can be read back by identity, fail closed when a required name is absent.
 *
 * What it does NOT do: choose a model. There is no "latest", no "best available" and no
 * auto-population — a run with no declared bindings stays empty, and a consumer that needs
 * one is refused rather than quietly defaulted.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import { isModelKey, normalizeModelKey } from '../domain/model-registry.js';

/** Logical binding names (any name a deployment chooses, e.g. `default`, `stage.review`). */
export const RUN_BINDING_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** The minimum the pin reads from the registry — structural, so the real service satisfies it. */
export interface RunModelBindingRecord {
  readonly modelKey: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly enabled: boolean;
  /** Derived availability (enabled flag + whether the owning provider is still registered). */
  readonly availability: string;
}

/**
 * The registry read seam. Deliberately the KEY lookup (`ModelRegistryService.get`), not the
 * alias resolver: a run pins a concrete model, and the derived availability travels with the
 * record so a model whose provider is gone can never be pinned.
 */
export interface RunModelBindingResolver {
  get(modelKey: string): Promise<RunModelBindingRecord | null>;
}

/** Availability values that make a model unpinnable (fail closed, never silently usable). */
export const UNPINNABLE_AVAILABILITY: readonly string[] = ['disabled', 'unavailable'];

/**
 * Validate the caller-supplied bindings BEFORE any run is written: an unknown or disabled
 * model must leave no run, no snapshot and nothing to roll back (the same ordering ruling the
 * pack provenance resolver follows).
 */
export async function validateRunModelBindings(
  bindings: Readonly<Record<string, string>>,
  resolver: RunModelBindingResolver,
): Promise<Result<Readonly<Record<string, string>>, DomainError>> {
  const normalized: Record<string, string> = {};
  for (const [name, rawKey] of Object.entries(bindings)) {
    if (!RUN_BINDING_KEY_PATTERN.test(name)) {
      return err(
        domainError('INVALID_ARGUMENT', `Model binding name "${name}" is not a valid logical binding name.`, {
          reason: 'RUN_BINDING_NAME_INVALID',
          bindingName: name,
        }),
      );
    }
    if (typeof rawKey !== 'string' || rawKey.trim() === '') {
      return err(
        domainError('INVALID_ARGUMENT', `Model binding "${name}" has no model key.`, {
          reason: 'RUN_BINDING_KEY_MISSING',
          bindingName: name,
        }),
      );
    }
    const modelKey = normalizeModelKey(rawKey);
    if (!isModelKey(modelKey)) {
      return err(
        domainError('INVALID_ARGUMENT', `Model binding "${name}" does not carry a valid model key.`, {
          reason: 'RUN_BINDING_KEY_INVALID',
          bindingName: name,
        }),
      );
    }
    const record = await resolver.get(modelKey);
    if (record === null || record.modelKey !== modelKey) {
      return err(
        domainError('NOT_FOUND', `Model binding "${name}" does not resolve to a registered model.`, {
          reason: 'RUN_BINDING_UNKNOWN',
          bindingName: name,
          modelKey,
        }),
      );
    }
    if (!record.enabled || UNPINNABLE_AVAILABILITY.includes(record.availability)) {
      return err(
        domainError('VALIDATION_FAILED', `Model binding "${name}" is disabled or unavailable; a run cannot pin one.`, {
          reason: record.enabled ? 'RUN_BINDING_UNAVAILABLE' : 'RUN_BINDING_DISABLED',
          bindingName: name,
          modelKey,
          availability: record.availability,
        }),
      );
    }
    normalized[name] = modelKey;
  }
  return ok(normalized);
}
