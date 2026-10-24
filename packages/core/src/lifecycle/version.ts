/**
 * WorkflowVersion — immutable, content-addressed version records (ADR-0006).
 *
 * The `contentHash` is a sha256 over the canonical serialization of
 * `{templateId, semver, graph}`; it is the fingerprint persisted on every
 * RunSnapshot, which is what makes a historical run reproducible.
 */
import type { IdFactory } from '../ports/id-factory.js';
import { contentHash } from '../kernel/hash.js';
import { DomainError } from '../kernel/errors.js';

export interface WorkflowNode {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  /** Opaque, pack-defined configuration. Core never interprets it. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  readonly condition?: string;
}

export interface WorkflowGraph {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

export interface WorkflowVersion {
  readonly id: string;
  readonly templateId: string;
  readonly semver: string;
  readonly contentHash: string;
  readonly graph: WorkflowGraph;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly changeProposalId: string | null;
  /** Always true — a published version can never be mutated (ADR-0006). */
  readonly immutable: true;
}

export interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export const INITIAL_SEMVER = '1.0.0';

export function parseSemver(value: string): SemverParts | null {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export const formatSemver = (parts: SemverParts): string =>
  `${parts.major}.${parts.minor}.${parts.patch}${parts.prerelease === null ? '' : `-${parts.prerelease}`}`;

export const isSemver = (value: string): boolean => parseSemver(value) !== null;

export const isDraftSemver = (value: string): boolean => parseSemver(value)?.prerelease === 'draft';

export const bumpMinor = (value: string): string => {
  const parts = parseSemver(value);
  if (parts === null) throw new DomainError('VALIDATION_FAILED', `Not a semver: "${value}"`);
  return formatSemver({ major: parts.major, minor: parts.minor + 1, patch: 0, prerelease: null });
};

export const bumpPatch = (value: string): string => {
  const parts = parseSemver(value);
  if (parts === null) throw new DomainError('VALIDATION_FAILED', `Not a semver: "${value}"`);
  return formatSemver({ major: parts.major, minor: parts.minor, patch: parts.patch + 1, prerelease: null });
};

/** The semver of the next draft opened on top of `current`. */
export const draftSemverFor = (current: string): string => `${bumpMinor(current)}-draft`;

/** Release a draft semver: `1.3.0-draft` → `1.3.0`. */
export const releaseSemver = (draft: string): string => {
  const parts = parseSemver(draft);
  if (parts === null) throw new DomainError('VALIDATION_FAILED', `Not a semver: "${draft}"`);
  return formatSemver({ ...parts, prerelease: null });
};

export interface CreateVersionInput {
  readonly templateId: string;
  readonly semver: string;
  readonly graph: WorkflowGraph;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly ids: IdFactory;
  readonly changeProposalId?: string | null;
  readonly immutable?: boolean;
}

export function createWorkflowVersion(input: CreateVersionInput): WorkflowVersion {
  return {
    id: input.ids.id('ver'),
    templateId: input.templateId,
    semver: input.semver,
    contentHash: contentHash({
      templateId: input.templateId,
      semver: input.semver,
      graph: input.graph,
    }),
    graph: input.graph,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    changeProposalId: input.changeProposalId ?? null,
    immutable: true,
  };
}

/** Recompute the fingerprint — used by persistence to detect tampering. */
export const recomputeContentHash = (version: WorkflowVersion): string =>
  contentHash({ templateId: version.templateId, semver: version.semver, graph: version.graph });

export const isVersionIntact = (version: WorkflowVersion): boolean =>
  recomputeContentHash(version) === version.contentHash;

export const isRunnableGraph = (graph: WorkflowGraph): boolean => {
  if (graph.nodes.length === 0) return false;
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (ids.size !== graph.nodes.length) return false;
  if (graph.nodes.length > 1 && graph.edges.length === 0) return false;
  return graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to));
};
