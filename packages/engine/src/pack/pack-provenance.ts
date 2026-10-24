/**
 * Pack provenance primitives — the ONE shared implementation of two questions the
 * Industry Pack layer must answer identically everywhere (T15-05):
 *
 *   1. which PackInstallations own a materialized entity (Role / WorkflowTemplate)? —
 *      used by the availability policy (is it live?) and by the run provenance resolver
 *      (what does a new Run pin?).
 *   2. what is the exact-version dependency closure of a set of packs? — extracted from
 *      the T15-04 PackService so the run resolver NEVER grows a second implementation.
 *
 * Everything here is derived from durable provenance (PackContentRef → PackInstallation →
 * PackVersion). Nothing is stored for these answers, so no migration is involved.
 */
import {
  domainError,
  err,
  ok,
  type DomainError,
  type PackContentKind,
  type PackContentRefStore,
  type PackInstallation,
  type PackInstallationStore,
  type PackManifest,
  type PackVersion,
  type PackVersionStore,
  type Result,
} from '@companyos/core';

/** The three pack stores a provenance question needs (Core ports; no persistence here). */
export interface PackProvenanceStores {
  readonly packInstallations: PackInstallationStore;
  readonly packContentRefs: PackContentRefStore;
  readonly packVersions: PackVersionStore;
}

/**
 * Every installation of THIS company that owns the materialized entity, in any status.
 *
 * Callers decide what a status means: the availability policy counts `installed` owners as
 * live; the run resolver pins exactly those live owners. Company scope is structural (the
 * walk starts from one company's installations), so owners are never cross-tenant.
 */
export const findPackOwnersOfMaterializedEntity = async (
  stores: PackProvenanceStores,
  companyId: string,
  contentKind: PackContentKind,
  entityId: string,
): Promise<Result<readonly PackInstallation[], DomainError>> => {
  const installations = await stores.packInstallations.listByCompany(companyId);
  if (!installations.ok) return installations;
  const owners: PackInstallation[] = [];
  for (const installation of installations.value) {
    const refs = await stores.packContentRefs.listByInstallation(installation.id);
    if (!refs.ok) return refs;
    const owns = refs.value.some(
      (ref) => ref.contentKind === contentKind && ref.materializedEntityRef === entityId,
    );
    if (owns) owners.push(installation);
  }
  return ok(owners);
};

/**
 * The exact-version dependency closure of `roots` (roots included), requiring every hop to
 * be INSTALLED in the company (status is the availability source — a disabled pack exposes
 * nothing). Fails closed with the T15-04 vocabulary:
 *   PACK_DEPENDENCY_MISSING / PACK_DEPENDENCY_UNKNOWN / PACK_DEPENDENCY_CYCLE /
 *   PACK_DEPENDENCY_SELF / PACK_MULTIPLE_INSTALLED_VERSIONS.
 *
 * Cycle detection runs BEFORE the availability check (a circular graph is malformed whatever
 * is installed), the recursion is bounded by the on-stack set, and the resolved map is keyed
 * by `packId`, so a corrupted durable state can never produce an infinite walk.
 */
export const resolveExactDependencyClosure = async (
  stores: PackProvenanceStores,
  companyId: string,
  roots: readonly { readonly packId: string; readonly packVersion: string }[],
  rootManifests?: ReadonlyMap<string, PackVersion>,
): Promise<Result<ReadonlyMap<string, string>, DomainError>> => {
  const resolved = new Map<string, string>();
  const onStack = new Set<string>();

  const visit = async (
    packId: string,
    packVersion: string,
    manifest: PackManifest,
  ): Promise<Result<void, DomainError>> => {
    if (resolved.has(packId)) {
      // A pack id can only resolve once: two versions of one pack in one closure is a
      // corrupted guarantee, never a last-writer-wins.
      if (resolved.get(packId) !== packVersion) {
        return err(
          domainError('CONFLICT', `Pack "${packId}" resolves to two versions ("${resolved.get(packId)}" and "${packVersion}").`, {
            reason: 'PACK_MULTIPLE_INSTALLED_VERSIONS',
            packId,
          }),
        );
      }
      return ok(undefined);
    }
    if (onStack.has(packId)) {
      return err(
        domainError('CONFLICT', `Pack dependency cycle detected at "${packId}".`, {
          reason: 'PACK_DEPENDENCY_CYCLE',
          packId,
          packVersion,
        }),
      );
    }
    onStack.add(packId);
    for (const dependency of manifest.dependsOn) {
      if (dependency.packId === packId && dependency.packVersion === packVersion) {
        onStack.delete(packId);
        return err(
          domainError('CONFLICT', `Pack "${packId}" directly depends on itself.`, {
            reason: 'PACK_DEPENDENCY_SELF',
            packId,
          }),
        );
      }
      if (onStack.has(dependency.packId)) {
        return err(
          domainError('CONFLICT', `Pack dependency cycle detected at "${dependency.packId}".`, {
            reason: 'PACK_DEPENDENCY_CYCLE',
            packId: dependency.packId,
            packVersion: dependency.packVersion,
          }),
        );
      }
      // Availability is company-scoped: the exact required version must be INSTALLED here.
      const installed = await stores.packInstallations.findByCompanyPackVersion(
        companyId,
        dependency.packId,
        dependency.packVersion,
      );
      if (!installed.ok) return installed;
      if (installed.value === null || installed.value.status !== 'installed') {
        return err(
          domainError('CONFLICT', `Required pack "${dependency.packId}@${dependency.packVersion}" is not installed for this company.`, {
            reason: 'PACK_DEPENDENCY_MISSING',
            packId: dependency.packId,
            packVersion: dependency.packVersion,
          }),
        );
      }
      // A durable inconsistency: installed here, but its canonical manifest is unreadable.
      const depVersion = await stores.packVersions.get(dependency.packId, dependency.packVersion);
      if (!depVersion.ok) return depVersion;
      if (depVersion.value === null) {
        return err(
          domainError('CONFLICT', `Required pack "${dependency.packId}@${dependency.packVersion}" is unknown.`, {
            reason: 'PACK_DEPENDENCY_UNKNOWN',
            packId: dependency.packId,
            packVersion: dependency.packVersion,
          }),
        );
      }
      const visited = await visit(dependency.packId, dependency.packVersion, depVersion.value.manifest);
      if (!visited.ok) return visited;
    }
    onStack.delete(packId);
    resolved.set(packId, packVersion);
    return ok(undefined);
  };

  for (const root of roots) {
    // The root manifest comes from the caller (an install candidate is not durable yet); a
    // durable root's manifest is read from its verified PackVersion row first.
    const version = await stores.packVersions.get(root.packId, root.packVersion);
    if (!version.ok) return version;
    const manifest = version.value === null ? undefined : version.value.manifest;
    if (manifest === undefined && rootManifests !== undefined) {
      const supplied = rootManifests.get(root.packId);
      if (supplied === undefined || supplied.packVersion !== root.packVersion) continue;
      const walked = await visit(root.packId, root.packVersion, supplied.manifest);
      if (!walked.ok) return err(walked.error);
      continue;
    }
    if (manifest === undefined) {
      return err(
        domainError('CONFLICT', `Required pack "${root.packId}@${root.packVersion}" is unknown.`, {
          reason: 'PACK_DEPENDENCY_UNKNOWN',
          packId: root.packId,
          packVersion: root.packVersion,
        }),
      );
    }
    const walked = await visit(root.packId, root.packVersion, manifest);
    if (!walked.ok) return err(walked.error);
  }
  return ok(resolved);
};

/** Deterministic `packId`-sorted map — the canonical snapshot shape (never store order). */
export const sortedPackVersionMap = (
  entries: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> => {
  const sorted: Record<string, string> = {};
  for (const packId of [...entries.keys()].sort()) sorted[packId] = entries.get(packId)!;
  return sorted;
};
