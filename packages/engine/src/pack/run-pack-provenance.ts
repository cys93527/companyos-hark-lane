/**
 * Run pack provenance resolver (Sprint 15 — Task-15-05; ADR-0027 Decision 1/2).
 *
 * `RunSnapshot.packVersions` is TRUSTED DERIVED DATA: the caller of `createRun` never
 * chooses it. This resolver derives it from durable provenance at NEW RUN CREATION ONLY:
 *
 *   selected WorkflowTemplate
 *     → PackContentRef (contentKind = workflowTemplate, materializedEntityRef = template id)
 *     → owning PackInstallations (company-scoped, status = installed)
 *     → those live root owners, each with its exact version
 *     → + the transitive REQUIRED exact-version dependency closure of those roots
 *
 * Rules frozen by Task-15-05:
 *   - A template with no pack owner is a LEGACY workflow: the map is `{}` (first-class).
 *   - Only `installed` owners contribute; a disabled historical owner is never a source.
 *   - Every live owner is pinned (no random pick), and the one-active-version guarantee is
 *     enforced again here (two versions of one pack ⇒ CONFLICT, never last-wins).
 *   - A missing / disabled / unknown / cyclic dependency fails the Run creation closed
 *     (0 WorkflowRun, 0 RunSnapshot) — resolution happens BEFORE the write phase.
 *   - The map is `packId`-sorted, so the same contributing set always serializes the same.
 *
 * After creation the Run never asks this resolver again: runtime reads the pinned snapshot,
 * never the current active pack (ADR-0027 Decision 3/6).
 */
import {
  ok,
  type DomainError,
  type PackRunProvenancePolicy,
  type Result,
} from '@companyos/core';

import {
  findPackOwnersOfMaterializedEntity,
  resolveExactDependencyClosure,
  sortedPackVersionMap,
  type PackProvenanceStores,
} from './pack-provenance.js';

export type RunPackProvenanceResolver = PackRunProvenancePolicy;

export function createRunPackProvenanceResolver(stores: PackProvenanceStores): RunPackProvenanceResolver {
  return {
    async resolveForWorkflow(input: Parameters<PackRunProvenancePolicy['resolveForWorkflow']>[0]): Promise<Result<Readonly<Record<string, string>>, DomainError>> {
      // Step 1: the LIVE owners of the materialized template (company-scoped). Independently
      // fail-closed — the resolver never assumes an upstream availability guard ran.
      const owners = await findPackOwnersOfMaterializedEntity(
        stores,
        input.companyId,
        'workflowTemplate',
        input.templateId,
      );
      if (!owners.ok) return owners;
      const liveRoots = owners.value
        .filter((owner) => owner.status === 'installed')
        .map((owner) => ({ packId: owner.packId, packVersion: owner.packVersion }));
      if (liveRoots.length === 0) return ok({}); // packless workflow: legacy first-class

      // Step 2: roots + their transitive exact dependency closure (one shared resolver).
      const closure = await resolveExactDependencyClosure(stores, input.companyId, liveRoots);
      if (!closure.ok) return closure;

      // Step 3: deterministic, canonical map.
      return ok(sortedPackVersionMap(closure.value));
    },
  };
}
