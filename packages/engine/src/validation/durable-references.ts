/**
 * Shared durable-reference resolution for Agent / Tool / Handoff / Decision records
 * (Sprint 13B — Task-13-09; ADR-0017 canonical identity, ADR-0015 D4).
 *
 * One tiny application helper, reused by every referencing subsystem (§31/§32 — no
 * per-subsystem `startsWith('artifact:')` copies, no global entity graph). It answers
 * exactly one question: "does this string resolve to a DURABLE Artifact or Validation
 * row right now?"
 *
 * Reference semantics (frozen by Task-13-09):
 *   - identity reference only: no content reads, no CAS, no ownership, no cascade
 *   - durable-before-reference: a missing row is a DENIAL, never deferred
 *   - malformed grammar is a DENIAL, never "store first, resolve later"
 *   - store integrity errors PROPAGATE (§15) instead of degrading to "not found, but okay"
 *   - Validation status (pass/fail/error/skipped) and legacy targetRef=null do NOT
 *     disqualify a reference (§18) — gate verdicts belong to the evidence guard
 *
 * Canonical grammars (each subsystem keeps its own envelope; the identity inside is
 * always the branded durable id — no second identity system, §4):
 *   Artifact   — `artifact:art_<ulid>` (ADR-0017 canonical form, parsed via
 *                isValidationTargetRef) or the bare branded ArtifactId
 *   Validation — the bare branded ValidationId (`val_<ulid>`, checked via hasIdPrefix)
 */
import {
  domainError,
  hasIdPrefix,
  isValidationTargetRef,
  type ArtifactStorePort,
  type DomainError,
  type ValidationStorePort,
} from '@companyos/core';

export type DurableReference =
  | { readonly kind: 'artifact'; readonly id: string; readonly ref: string }
  | { readonly kind: 'validation'; readonly id: string; readonly ref: string };

export type DurableReferenceDenial =
  | { readonly status: 'malformed' }
  | { readonly status: 'missing' };

export type DurableReferenceResolution =
  | { readonly ok: true; readonly reference: DurableReference }
  | { readonly ok: false; readonly denial: DurableReferenceDenial; readonly error: DomainError };

/** Resolve one reference string to a durable Artifact identity (metadata only). */
export async function resolveArtifactReference(
  ref: string,
  artifactStore: ArtifactStorePort,
): Promise<DurableReferenceResolution> {
  let id: string;
  if (isValidationTargetRef(ref)) id = ref.slice('artifact:'.length);
  else if (hasIdPrefix('artifact', ref)) id = ref;
  else
    return {
      ok: false,
      denial: { status: 'malformed' },
      error: domainError('INVALID_ARGUMENT', `Not a canonical artifact reference: "${ref}".`, {
        reason: 'ARTIFACT_REFERENCE_MALFORMED',
        reference: ref,
      }),
    };
  let artifact;
  try {
    artifact = await artifactStore.get(id as never);
  } catch (error) {
    return {
      ok: false,
      denial: { status: 'missing' },
      error: domainError('PERSISTENCE_FAILED', 'Artifact store read failed while resolving a reference.', {
        reason: 'ARTIFACT_REFERENCE_STORE_ERROR',
        cause: String(error),
      }),
    };
  }
  if (artifact === null) {
    return {
      ok: false,
      denial: { status: 'missing' },
      error: domainError('NOT_FOUND', `Referenced artifact "${ref}" does not exist.`, {
        reason: 'ARTIFACT_REFERENCE_MISSING',
        reference: ref,
      }),
    };
  }
  return { ok: true, reference: { kind: 'artifact', id: artifact.id, ref } };
}

/** Resolve one reference string to a durable Validation identity (metadata only). */
export async function resolveValidationReference(
  ref: string,
  validationStore: ValidationStorePort,
): Promise<DurableReferenceResolution> {
  if (!hasIdPrefix('validation', ref)) {
    return {
      ok: false,
      denial: { status: 'malformed' },
      error: domainError('INVALID_ARGUMENT', `Not a canonical validation reference: "${ref}".`, {
        reason: 'VALIDATION_REFERENCE_MALFORMED',
        reference: ref,
      }),
    };
  }
  let validation;
  try {
    validation = await validationStore.get(ref as never);
  } catch (error) {
    return {
      ok: false,
      denial: { status: 'missing' },
      error: domainError('PERSISTENCE_FAILED', 'Validation store read failed while resolving a reference.', {
        reason: 'VALIDATION_REFERENCE_STORE_ERROR',
        cause: String(error),
      }),
    };
  }
  if (validation === null) {
    return {
      ok: false,
      denial: { status: 'missing' },
      error: domainError('NOT_FOUND', `Referenced validation "${ref}" does not exist.`, {
        reason: 'VALIDATION_REFERENCE_MISSING',
        reference: ref,
      }),
    };
  }
  return { ok: true, reference: { kind: 'validation', id: validation.id, ref } };
}

/**
 * Resolve-ALL-before-write: every ref in the set must resolve to a durable row, or the
 * whole set is denied (§36/§50 — no partial persistence, no half-written entities).
 */
export async function resolveDurableReferences(
  refs: readonly string[],
  stores: {
    readonly artifactStore: ArtifactStorePort;
    readonly validationStore: ValidationStorePort;
  },
): Promise<
  | { readonly ok: true; readonly references: readonly DurableReference[] }
  | { readonly ok: false; readonly denial: DurableReferenceDenial; readonly error: DomainError }
> {
  const resolved: DurableReference[] = [];
  for (const ref of refs) {
    if (ref.startsWith('artifact:')) {
      const r = await resolveArtifactReference(ref, stores.artifactStore);
      if (!r.ok) return r;
      resolved.push(r.reference);
      continue;
    }
    if (hasIdPrefix('validation', ref)) {
      const r = await resolveValidationReference(ref, stores.validationStore);
      if (!r.ok) return r;
      resolved.push(r.reference);
      continue;
    }
    if (hasIdPrefix('artifact', ref)) {
      const r = await resolveArtifactReference(ref, stores.artifactStore);
      if (!r.ok) return r;
      resolved.push(r.reference);
      continue;
    }
    // Unknown grammar — the caller decides per its own ref-kind rules; here it is a
    // malformed durable reference by definition (only artifact/validation are known).
    return {
      ok: false,
      denial: { status: 'malformed' },
      error: domainError('INVALID_ARGUMENT', `Unknown durable reference grammar: "${ref}".`, {
        reason: 'DURABLE_REFERENCE_MALFORMED',
        reference: ref,
      }),
    };
  }
  return { ok: true, references: resolved };
}
