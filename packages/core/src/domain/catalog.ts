/**
 * Core Domain catalog — the FROZEN vocabulary of Core (ADR-0002).
 *
 * 规划书 §四 enumerates exactly what Core is allowed to know. That list is **23**
 * items; the earlier "24" was a miscount (it wrongly counted `Workflow Draft`,
 * which belongs to the template-lifecycle layer, not to the §四 vocabulary).
 *
 * This module is the machine-readable single source of truth for that count:
 *   - `CORE_CONCEPTS` length MUST be 23 (asserted by
 *     `packages/core/tests/domain/catalog.test.ts`);
 *   - every concept declares the bounded context that owns it and the sprint that
 *     lands it, so "who implements this" is never a matter of opinion;
 *   - the industry-owned nouns are listed only as data (strings are stripped by
 *     the boundary scanner), never as identifiers.
 */

/** Bounded contexts of Core (planning §五十五 / sprint plan). */
export const CORE_CONTEXTS = [
  'kernel',
  'org',
  'workflow',
  'execution',
  'governance',
  'memory',
  'registry',
  'observability',
  'cost',
] as const;

export type CoreContext = (typeof CORE_CONTEXTS)[number];

export interface CoreConcept {
  /** Concept name exactly as written in 规划书 §四. */
  readonly name: string;
  /** Which bounded context implements it. */
  readonly owner: CoreContext;
  /** Sprint that lands the implementation (planning §五十九). */
  readonly sprint: string;
}

export const CORE_CONCEPTS: readonly CoreConcept[] = [
  { name: 'Company', owner: 'org', sprint: 'S1' },
  { name: 'Industry Pack', owner: 'registry', sprint: 'S1' },
  { name: 'Workflow', owner: 'workflow', sprint: 'S1' },
  { name: 'Workflow Template', owner: 'workflow', sprint: 'S1' },
  { name: 'Workflow Version', owner: 'workflow', sprint: 'S1' },
  { name: 'Workflow Run', owner: 'execution', sprint: 'S1' },
  { name: 'Stage', owner: 'execution', sprint: 'S1' },
  { name: 'Task', owner: 'execution', sprint: 'S1' },
  { name: 'Role', owner: 'org', sprint: 'S1' },
  { name: 'Agent', owner: 'org', sprint: 'S1' },
  { name: 'Artifact', owner: 'execution', sprint: 'S1' },
  { name: 'Tool', owner: 'registry', sprint: 'S9' },
  { name: 'Validation', owner: 'governance', sprint: 'S1' },
  { name: 'Approval', owner: 'governance', sprint: 'S1' },
  { name: 'Risk', owner: 'governance', sprint: 'S24' },
  { name: 'Event', owner: 'kernel', sprint: 'S1' },
  { name: 'Memory', owner: 'memory', sprint: 'S12' },
  { name: 'Decision', owner: 'memory', sprint: 'S12' },
  { name: 'Handoff', owner: 'execution', sprint: 'S11' },
  { name: 'Provider', owner: 'registry', sprint: 'S6' },
  { name: 'Model', owner: 'registry', sprint: 'S7' },
  { name: 'Capability', owner: 'registry', sprint: 'S7' },
  { name: 'Cost', owner: 'cost', sprint: 'S27' },
] as const;

/** Frozen at 23 — see ADR-0002 and `docs/V1_1_RECONCILIATION.md` 冻结口径 A. */
export const CORE_CONCEPT_COUNT = 23;

export const coreConcept = (name: string): CoreConcept | null =>
  CORE_CONCEPTS.find((concept) => concept.name === name) ?? null;

export const conceptsOwnedBy = (owner: CoreContext): readonly CoreConcept[] =>
  CORE_CONCEPTS.filter((concept) => concept.owner === owner);

/**
 * Nouns that belong to Industry Packs, NOT to Core (规划书 §四 / §六十六 STEP 2).
 * Kept as data for tests and tooling; the authoritative enforcement lives in
 * `scripts/check-boundaries.mjs` and ESLint.
 */
export const INDUSTRY_OWNED_NOUNS = [
  'Coding',
  'Git',
  'Repository',
  'Developer',
  'CTO',
  'Article',
  'Video',
  'Ecommerce',
] as const;
