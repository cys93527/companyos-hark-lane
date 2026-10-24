/**
 * Run snapshot verifier (Sprint 18 / Task-18-02) — closes `SNAPSHOT_VERIFY_PRODUCTION_GAP`.
 *
 * Recon proved `verifyRunSnapshot` (Core) exists but is never called from a production path:
 * `engine.advance` compares a `snapshotId` STRING, so a durable snapshot whose pinned content
 * was tampered with — same id, different fields — would execute as if it were intact.
 *
 * This module is the production reader for that one canonical Core verifier:
 *   Run.snapshotId → the durable RunSnapshot → the run's pinned template version →
 *   `verifyRunSnapshot(snapshot, version)`.
 *
 * It READS ONLY and never repairs: a missing snapshot, a missing template, a missing pinned
 * version or a hash mismatch are all fail-closed outcomes. There is no `repairSnapshot`,
 * no `updateSnapshot`, and no regeneration of a replacement snapshot — a Run whose pin cannot
 * be proven must not continue executing.
 *
 * It is deliberately NOT a second integrity algorithm: the hash comparison and the version
 * drift check live in Core and are called exactly once, from here.
 */
import { verifyRunSnapshot, domainError, err, ok, type DomainError, type EntityStore, type Result, type RunSnapshot, type WorkflowTemplate } from '@companyos/core';

export interface RunSnapshotVerifierDeps {
  readonly templates: EntityStore<WorkflowTemplate>;
  readonly snapshots: EntityStore<RunSnapshot>;
}

export interface RunSnapshotVerifier {
  /**
   * Prove the run's pin before any execution. `runId` and `snapshotId` are both required:
   * a snapshot that belongs to another run is a fail-closed outcome, not a reusable fact.
   */
  verify(input: { readonly runId: string; readonly snapshotId: string }): Promise<Result<true, DomainError>>;
}

export function createRunSnapshotVerifier(deps: RunSnapshotVerifierDeps): RunSnapshotVerifier {
  return {
    async verify(input): Promise<Result<true, DomainError>> {
      const snapshot = await deps.snapshots.get(input.snapshotId as never);
      if (snapshot === null) {
        return err(
          domainError('NOT_FOUND', `Run "${input.runId}" pins snapshot "${input.snapshotId}", which does not exist; execution cannot be proven.`, {
            reason: 'RUN_SNAPSHOT_MISSING',
            runId: input.runId,
            snapshotId: input.snapshotId,
          }),
        );
      }
      if (snapshot.runId !== input.runId) {
        return err(
          domainError('VALIDATION_FAILED', 'The run pins a snapshot that belongs to a different run.', {
            reason: 'RUN_SNAPSHOT_WRONG_RUN',
            runId: input.runId,
            snapshotId: input.snapshotId,
            snapshotRunId: snapshot.runId,
          }),
        );
      }
      const template = await deps.templates.get(snapshot.templateId as never);
      if (template === null) {
        return err(
          domainError('NOT_FOUND', `The template "${String(snapshot.templateId)}" pinned by the run snapshot is missing.`, {
            reason: 'RUN_SNAPSHOT_TEMPLATE_MISSING',
            runId: input.runId,
            snapshotId: input.snapshotId,
          }),
        );
      }
      const version = template.versions.find((entry) => entry.id === snapshot.workflowVersionId);
      if (version === undefined) {
        return err(
          domainError('NOT_FOUND', `The pinned version "${String(snapshot.workflowVersionId)}" is missing from the pinned template.`, {
            reason: 'RUN_SNAPSHOT_VERSION_MISSING',
            runId: input.runId,
            snapshotId: input.snapshotId,
          }),
        );
      }
      // The ONE canonical verifier. A version content-hash drift is fatal; pack drift is
      // reported by Core and tolerated (packs are additive) — that ruling is Core's, not ours.
      const verified = verifyRunSnapshot(snapshot, version);
      if (!verified.ok) return err(verified.error);
      return ok(true);
    },
  };
}
