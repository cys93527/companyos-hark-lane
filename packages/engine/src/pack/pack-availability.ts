/**
 * Pack live-availability policy (T15-04 corrective — PACK_LIVE_CAPABILITY_DISABLE_GAP).
 *
 * Answers one question for the subsystem services that materialize pack content
 * (authorization for Roles, lifecycle for WorkflowTemplates): is this durable entity
 * still backed by a LIVE pack installation in THIS company?
 *
 * The answer is derived, never stored: `PackContentRef` (provenance) →
 * `PackInstallation.status` (availability). Disabling a pack therefore removes new-use
 * availability without deleting a single row — history, audit and existing Runs keep
 * resolving against the same entities (ADR-0025 Decision 4/7).
 *
 * Company scope is structural: the lookup walks the installations of the company the
 * entity belongs to, so disabling a pack in one company can never affect another.
 * `ok(false)` is a POLICY ANSWER (not a failure); store failures come back as `err`.
 */
import {
  ok,
  type DomainError,
  type PackAvailabilityPolicy,
  type PackContentKind,
  type PackContentRefStore,
  type PackInstallationStore,
  type Result,
} from '@companyos/core';

export interface PackAvailabilityPolicyDeps {
  readonly packInstallations: PackInstallationStore;
  readonly packContentRefs: PackContentRefStore;
}

export function createPackAvailabilityPolicy(deps: PackAvailabilityPolicyDeps): PackAvailabilityPolicy {
  return {
    async isMaterializedContentAvailable(input: {
      readonly companyId: string;
      readonly contentKind: PackContentKind;
      readonly entityId: string;
    }): Promise<Result<boolean, DomainError>> {
      const installations = await deps.packInstallations.listByCompany(input.companyId);
      if (!installations.ok) return installations;
      let owned = false;
      for (const installation of installations.value) {
        const refs = await deps.packContentRefs.listByInstallation(installation.id);
        if (!refs.ok) return refs;
        const owns = refs.value.some(
          (ref) => ref.contentKind === input.contentKind && ref.materializedEntityRef === input.entityId,
        );
        if (!owns) continue;
        owned = true;
        // Any-live-owner: a shared entity stays available while ANY owner is installed.
        if (installation.status === 'installed') return ok(true);
      }
      // Not pack-derived content is never gated; pack-owned content with no live owner is not.
      return ok(!owned);
    },
  };
}
