/**
 * Artifact persistence port (Sprint 13A — ADR-0015).
 *
 * Lives in Core so the engine materializes artifacts and the persistence layer stores
 * them, while Core owns the shape both sides agree on. Artifacts are immutable
 * (Option A): there is deliberately NO update or delete method — a "correction" is a
 * new artifact with a new id anchored to the run that produced it.
 *
 * Permanent creation idempotency (Option B): the store persists `creationCommandId` /
 * `creationCommandFingerprint` as ROW METADATA alongside the artifact. These are NOT
 * fields of the Sprint 1 domain `Artifact` type — they travel through this port as
 * persistence operation metadata so the ArtifactService can recover the original
 * identity after the bounded command ledger has trimmed the command. The STORE returns
 * durable data only; deciding replay vs CONFLICT is the ArtifactService's policy.
 */
import type { Artifact } from '../domain/artifact.js';
import type { ArtifactId, WorkflowRunId } from '../kernel/identifiers.js';

/** Persistence operation metadata attached to one durable create. Never a domain field. */
export interface ArtifactCreationMetadata {
  /** The commandId whose CreateArtifact command produced this row. */
  readonly creationCommandId: string;
  /** Content fingerprint of that command; same-key-different-content is CONFLICT material. */
  readonly creationCommandFingerprint: string;
}

/** Artifact plus its durable creation metadata, as recovered by `getByCreationCommand`. */
export interface DurableArtifactLookup {
  readonly artifact: Artifact;
  readonly creationCommandId: string;
  readonly creationCommandFingerprint: string;
}

export interface ArtifactStorePort {
  /**
   * Insert one immutable artifact row together with its creation metadata.
   * Duplicate `creation_command_id` (one command → exactly one artifact) is refused by
   * the store's unique index, never overwritten.
   */
  create(artifact: Artifact, creation: ArtifactCreationMetadata): Promise<void>;
  get(artifactId: ArtifactId): Promise<Artifact | null>;
  /**
   * Permanent idempotency lookup: recover the artifact AND its creation fingerprint by
   * the command that created it — even after the command ledger trimmed that command.
   * Returns the durable facts; the service compares fingerprints (replay / CONFLICT).
   */
  getByCreationCommand(creationCommandId: string): Promise<DurableArtifactLookup | null>;
  /** Every artifact produced by one run, newest first (provenance anchor). */
  listByRun(runId: WorkflowRunId): Promise<readonly Artifact[]>;
  /** Content-identity lookup: same bytes may back several artifacts. */
  listByHash(contentHash: string): Promise<readonly Artifact[]>;
  /**
   * Full enumeration for STARTUP INTEGRITY RECONCILIATION ONLY (ADR-0015 D11,
   * Task-13-10): every durable artifact row, integrity-validated through the store
   * (a corrupt row fails closed). Not an application listing API.
   */
  listAll(): Promise<readonly Artifact[]>;
}
