/**
 * Durable ARTIFACT / VALIDATION memory provenance verification
 * (Sprint 13B — Task-13-08; ADR-0015 D10 + ADR-0017 canonical refs).
 *
 * The Memory question these helpers answer is IDENTITY, not verdict:
 *   ARTIFACT   — "is this a REAL durable Artifact row?"     (artifact:art_<ulid>, ADR-0017)
 *   VALIDATION — "is this a REAL durable Validation row?"   (bare branded ValidationId)
 *
 * Scope notes (recon-verified, frozen by the EXISTING verifier contract):
 *   - verify() receives { sourceType, sourceRefs, companyId } ONLY — there is NO runId
 *     anchor in the contract, and neither Artifact nor Validation carries a companyId,
 *     so run/company cross-checks are NOT performable here. Resolution would require a
 *     verifier-input extension (out of T08 scope); flagged in the task report.
 *   - A null store (artifact chain not yet enabled in a composition root) FAILS CLOSED —
 *     "chain not wired" is never "verified".
 *   - VALIDATION provenance accepts ANY status and legacy targetRef=null rows: it
 *     references an evidence RECORD, not a gate outcome (§13/§15 — no frozen contract
 *     restricts provenance to PASS or targeted rows; T07 owns gate semantics).
 *   - No gate re-evaluation: no qualityGatePassed, no stage policy, no latest-batch
 *     selection (§14/§30 — T07 owns those).
 *   - Read-only: no ArtifactContentStore/CAS dependency exists here — Artifact CONTENT
 *     is never read or copied into Memory (§7/§29); no ArtifactService/ValidationService
 *     calls, no validator execution (§17-§19).
 *   - Aggregation semantics follow the Sprint 12 convention exactly: sourceRefs[0] is
 *     THE reference; extra/duplicate refs neither verify nor invalidate (§32/§33).
 */
import {
  DomainError,
  domainError,
  err,
  hasIdPrefix,
  isValidationTargetRef,
  ok,
  type ArtifactStorePort,
  type Result,
  type ValidationStorePort,
} from '@companyos/core';

/** Sprint 12 verifier vocabulary reuse: a store integrity failure is a denial, never VERIFIED. */
const deny = (message: string, details: Readonly<Record<string, unknown>> = {}): Result<'VERIFIED', DomainError> =>
  err(domainError('VALIDATION_FAILED', message, details));

/** Store reads that throw (corrupt durable rows) surface as fail-closed denials (§31). */
const storeRead = async <T>(read: () => Promise<T>): Promise<Result<T, DomainError>> => {
  try {
    return ok(await read());
  } catch (error) {
    if (error instanceof DomainError) return err(error);
    return err(domainError('PERSISTENCE_FAILED', 'Provenance store read failed.', { cause: String(error) }));
  }
};

export async function verifyArtifactMemoryProvenance(input: {
  readonly sourceRefs: readonly string[];
  readonly artifactStore: ArtifactStorePort | null;
}): Promise<Result<'VERIFIED', DomainError>> {
  if (input.artifactStore === null) {
    return deny('Artifact provenance requires the artifact migration chain to be enabled.', {
      reason: 'ARTIFACT_CHAIN_NOT_ENABLED',
    });
  }
  const ref = input.sourceRefs[0] ?? '';
  // Canonical frozen form (ADR-0017): artifact:art_<ulid> — parsed by the ONE existing
  // canonical helper; no second regex, no bare-id acceptance.
  if (!isValidationTargetRef(ref)) {
    return deny('Artifact provenance must be the canonical ref "artifact:art_<id>".', {
      reason: 'ARTIFACT_PROVENANCE_REF_INVALID',
      sourceRef: ref,
    });
  }
  const artifactId = ref.slice('artifact:'.length);
  const read = await storeRead(() => input.artifactStore!.get(artifactId as never));
  if (!read.ok) return read;
  if (read.value === null) {
    return deny('Artifact provenance reference does not exist.', {
      reason: 'ARTIFACT_PROVENANCE_MISSING',
      sourceRef: ref,
    });
  }
  return ok('VERIFIED' as const);
}

export async function verifyValidationMemoryProvenance(input: {
  readonly sourceRefs: readonly string[];
  readonly validationStore: ValidationStorePort | null;
}): Promise<Result<'VERIFIED', DomainError>> {
  if (input.validationStore === null) {
    return deny('Validation provenance requires the artifact migration chain to be enabled.', {
      reason: 'ARTIFACT_CHAIN_NOT_ENABLED',
    });
  }
  const ref = input.sourceRefs[0] ?? '';
  // Canonical frozen identity: the branded ValidationId itself (val_<ulid>) — checked
  // with the existing hasIdPrefix helper; no second identity, no free-form refs.
  if (typeof ref !== 'string' || !hasIdPrefix('validation', ref)) {
    return deny('Validation provenance must be a canonical ValidationId ("val_<id>").', {
      reason: 'VALIDATION_PROVENANCE_REF_INVALID',
      sourceRef: ref,
    });
  }
  const read = await storeRead(() => input.validationStore!.get(ref as never));
  if (!read.ok) return read;
  if (read.value === null) {
    return deny('Validation provenance reference does not exist.', {
      reason: 'VALIDATION_PROVENANCE_MISSING',
      sourceRef: ref,
    });
  }
  // Present and durable ⇒ VERIFIED, regardless of status or targetRef: a FAIL/ERROR
  // Validation is exactly the audit provenance Memory may need to cite, and legacy
  // untargeted rows remain real evidence records (report documents both).
  return ok('VERIFIED' as const);
}
