/**
 * RunSnapshot — the immutability pin that makes a historical run reproducible
 * (ADR-0007). A run reads its snapshot and never live template state.
 */
import { LifecycleError } from '../kernel/errors.js';
import { contentHash } from '../kernel/hash.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import type { TemplateLock } from './template-lock.js';
import type { WorkflowVersion } from './version.js';

import { isDraftSemver } from './version.js';
import { isLockActive } from './template-lock.js';

export interface RunSnapshotRef {
  readonly snapshotId: string;
  readonly snapshotHash: string;
}

export interface RunSnapshot extends RunSnapshotRef {
  readonly id: string;
  readonly runId: string;
  readonly orgId: string;
  readonly templateId: string;
  readonly workflowVersionId: string;
  readonly templateLockId: string;
  /** packId → exact pack version in force for this run. */
  readonly packVersions: Readonly<Record<string, string>>;
  /** logical binding name → provider/model id; empty until Sprint 7 ships the router. */
  readonly modelBindings: Readonly<Record<string, string>>;
  /** Opaque handle to the frozen memory view of this run. */
  readonly memoryViewRef: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface CreateSnapshotInput {
  readonly runId: string;
  readonly orgId: string;
  readonly version: WorkflowVersion;
  readonly lock: TemplateLock;
  readonly packVersions?: Readonly<Record<string, string>>;
  readonly modelBindings?: Readonly<Record<string, string>>;
  readonly memoryViewRef: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly ids: IdFactory;
}

/** The pinned fields the fingerprint covers — ids and timestamps are excluded. */
export type SnapshotPinnedFields = Pick<
  RunSnapshot,
  | 'orgId'
  | 'templateId'
  | 'workflowVersionId'
  | 'templateLockId'
  | 'packVersions'
  | 'modelBindings'
  | 'memoryViewRef'
>;

/** Hash covers the pinned fields only — never timestamps or the id itself. */
export const snapshotHashOf = (snapshot: SnapshotPinnedFields): string =>
  contentHash({
    orgId: snapshot.orgId,
    templateId: snapshot.templateId,
    workflowVersionId: snapshot.workflowVersionId,
    templateLockId: snapshot.templateLockId,
    packVersions: snapshot.packVersions,
    modelBindings: snapshot.modelBindings,
    memoryViewRef: snapshot.memoryViewRef,
  });

/**
 * Hash a version's *published identity* — the fingerprint a run pins to prove it
 * executed exactly this version content (Sprint 4 requirement 9). Unlike
 * `snapshotHashOf`, it covers no run-time fields, so it is stable per version and can
 * be persisted on the version row and re-verified later.
 */
export const versionSnapshotHash = (version: WorkflowVersion): string =>
  contentHash({
    versionId: version.id,
    templateId: version.templateId,
    semver: version.semver,
    contentHash: version.contentHash,
  });

export function createRunSnapshot(input: CreateSnapshotInput): Result<RunSnapshot, LifecycleError> {
  // A draft version is not pinnable. `immutable` is `true` for drafts too, so the
  // `-draft` prerelease is the effective test (Sprint 4 review LOW-2); the `immutable`
  // check stays as a defensive guard for untyped/JSON callers.
  if (!input.version.immutable || isDraftSemver(input.version.semver)) {
    return err(
      new LifecycleError('SNAPSHOT_MISMATCH', 'Only a released, immutable version can be pinned by a run snapshot.', {
        versionId: input.version.id,
        semver: input.version.semver,
      }),
    );
  }
  if (!isLockActive(input.lock) || input.lock.versionId !== input.version.id) {
    return err(
      new LifecycleError('LOCKED_TEMPLATE', 'A run must pin an ACTIVE lock on the version it executes.', {
        versionId: input.version.id,
        lockId: input.lock.id,
      }),
    );
  }
  const base = {
    orgId: input.orgId,
    templateId: input.version.templateId,
    workflowVersionId: input.version.id,
    templateLockId: input.lock.id,
    packVersions: input.packVersions ?? {},
    modelBindings: input.modelBindings ?? {},
    memoryViewRef: input.memoryViewRef,
  };
  const id = input.ids.id('snp');
  return ok({
    id,
    snapshotId: id,
    ...base,
    runId: input.runId,
    snapshotHash: snapshotHashOf(base),
    createdAt: input.createdAt,
    createdBy: input.createdBy,
  });
}

/**
 * Verify that a persisted snapshot still matches the version it pins.
 * `packVersions` drift is reported but tolerated (packs are additive); a
 * version content-hash drift is fatal (`SNAPSHOT_MISMATCH`).
 */
export function verifyRunSnapshot(
  snapshot: RunSnapshot,
  version: WorkflowVersion,
): Result<true, LifecycleError> {
  if (snapshot.workflowVersionId !== version.id) {
    return err(
      new LifecycleError('SNAPSHOT_MISMATCH', 'Snapshot pins a different version.', {
        snapshotId: snapshot.id,
        pinned: snapshot.workflowVersionId,
        actual: version.id,
      }),
    );
  }
  const expected = snapshotHashOf({
    orgId: snapshot.orgId,
    templateId: snapshot.templateId,
    workflowVersionId: snapshot.workflowVersionId,
    templateLockId: snapshot.templateLockId,
    packVersions: snapshot.packVersions,
    modelBindings: snapshot.modelBindings,
    memoryViewRef: snapshot.memoryViewRef,
  });
  if (expected !== snapshot.snapshotHash) {
    return err(
      new LifecycleError('SNAPSHOT_MISMATCH', 'Snapshot hash does not match its pinned fields (tampering or corruption).', {
        snapshotId: snapshot.id,
        expected,
        actual: snapshot.snapshotHash,
      }),
    );
  }
  return ok(true);
}
