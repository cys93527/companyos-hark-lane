/**
 * Artifact — a business deliverable produced by a run (规划书 §四 Core 概念 11;
 * §三十一 Artifact System).
 *
 * Core knows only: which run/task produced it, an opaque `kind` (pack-defined),
 * where the bytes live (`contentRef`) and their fingerprint (`contentHash`). It
 * never interprets the content — that is exactly what keeps Core industry-agnostic.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import { makeId, type ArtifactId, type TaskId, type WorkflowRunId } from '../kernel/identifiers.js';

export interface Artifact {
  readonly id: ArtifactId;
  readonly runId: WorkflowRunId;
  /** `null` when the artifact is produced by the stage as a whole. */
  readonly taskId: TaskId | null;
  /** Opaque, pack-defined kind (e.g. `pack-x:report`). */
  readonly kind: string;
  /** Opaque locator (workspace path, blob id, URL) — never dereferenced by Core. */
  readonly contentRef: string;
  /** sha256 of the content, lowercase hex. */
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly producedBy: string;
  readonly createdAt: string;
}

export const isContentHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

export interface CreateArtifactInput {
  readonly runId: WorkflowRunId;
  readonly taskId?: TaskId;
  readonly kind: string;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly producedBy: string;
  readonly now: string;
  readonly ids: IdFactory;
}

export function createArtifact(input: CreateArtifactInput): Result<Artifact, DomainError> {
  if (input.kind.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'Artifact kind must not be empty.', {}));
  }
  if (input.contentRef.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'Artifact contentRef must not be empty.', {}));
  }
  if (!isContentHash(input.contentHash)) {
    return err(
      domainError('INVALID_ARGUMENT', 'Artifact contentHash must be a lowercase sha256 hex string.', {
        contentHash: input.contentHash,
      }),
    );
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'Artifact sizeBytes must be a non-negative integer.', {
        sizeBytes: input.sizeBytes,
      }),
    );
  }
  return ok({
    id: makeId<'ArtifactId'>('artifact', input.ids),
    runId: input.runId,
    taskId: input.taskId ?? null,
    kind: input.kind.trim(),
    contentRef: input.contentRef,
    contentHash: input.contentHash,
    sizeBytes: input.sizeBytes,
    producedBy: input.producedBy,
    createdAt: input.now,
  });
}

/** Artifacts are immutable: "verify" always means "does the fingerprint still match". */
export const isArtifactIntact = (artifact: Artifact, actualHash: string): boolean =>
  artifact.contentHash === actualHash;

/**
 * NOTE (review finding LOW-2): Core validates the *format* of `contentHash` only —
 * it never reads content. Recomputing the digest from the bytes is an outer-ring
 * responsibility (`@companyos/persistence` / the workspace adapter), and the
 * verdict is recorded as a `Validation`, never assumed from a producer's word
 * (规划书 §二原则 7).
 */

export const artifactsOfKind = (
  artifacts: readonly Artifact[],
  kind: string,
): readonly Artifact[] => artifacts.filter((artifact) => artifact.kind === kind);
