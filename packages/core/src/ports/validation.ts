/**
 * Validation persistence port + validator report DTO (Sprint 13A — ADR-0016).
 *
 * Lives in Core so the engine records validations and the persistence layer stores
 * them, while Core owns the shape both sides agree on. Validations are append-only
 * evidence: there is deliberately NO update or delete method — re-validation under a
 * NEW commandId appends new rows, it never rewrites history.
 *
 * Permanent creation idempotency (Option B, batch-aware): one RunValidation command may
 * execute N validators and persist N rows. The store keeps `creationCommandId` /
 * `creationCommandFingerprint` as ROW METADATA (never fields of the Sprint 1 domain
 * `Validation` type) keyed uniquely per (creation_command_id, validator_id), so the
 * ValidationService can recover the COMPLETE validationId set after the command ledger
 * trimmed the command. The STORE returns durable data only; replay vs CONFLICT stays
 * with the service.
 */
import type { Validation } from '../domain/validation.js';
import type { ValidationId, WorkflowRunId } from '../kernel/identifiers.js';

/** Persistence operation metadata attached to every row of one durable validation batch. */
export interface ValidationCreationMetadata {
  /** The commandId whose RunValidation command produced this row. */
  readonly creationCommandId: string;
  /** Content fingerprint of that command; shared by every row of the same batch. */
  readonly creationCommandFingerprint: string;
}

/** A complete validation batch (V1…VN) plus its durable creation metadata. */
export interface DurableValidationLookup {
  /** Every row persisted under this commandId — never a single validation. */
  readonly validations: readonly Validation[];
  readonly creationCommandId: string;
  readonly creationCommandFingerprint: string;
  /** The one target shared by the whole batch (ADR-0017 cardinality); null = legacy. */
  readonly targetRef: Validation['targetRef'];
}

export interface ValidationStorePort {
  /**
   * Insert one immutable validation row together with its batch creation metadata.
   * A duplicate (creation_command_id, validator_id) is refused by the store's unique
   * index, never overwritten.
   */
  record(validation: Validation, creation: ValidationCreationMetadata): Promise<void>;
  get(validationId: ValidationId): Promise<Validation | null>;
  /**
   * Permanent idempotency lookup: recover the COMPLETE set of validations produced by
   * one command (V1…VN) AND its creation fingerprint — even after the command ledger
   * trimmed that command. Returns durable facts; the service decides replay/CONFLICT.
   */
  getByCreationCommand(creationCommandId: string): Promise<DurableValidationLookup | null>;
  /** Every validation recorded for one run, newest first. */
  listByRun(runId: WorkflowRunId): Promise<readonly Validation[]>;
  /**
   * Target binding query (ADR-0017): every durable validation bound to one exact
   * artifact — the future evidence guard resolves "belongs to Artifact A" through
   * this, never by guessing across listByRun. Deterministic order.
   */
  listByTargetRef(targetRef: Validation['targetRef']): Promise<readonly Validation[]>;
  /**
   * Batch query (ADR-0020 §16): every COMPLETE durable RunValidation batch bound to
   * one exact target — grouped by creation command, with durable metadata restored
   * and corrupt mixed-anchor batches failing closed. The store returns durable FACTS
   * only; selecting the "latest winner" is Evidence-Guard policy, never store policy.
   */
  listBatchesByTargetRef(targetRef: Validation['targetRef']): Promise<readonly DurableValidationLookup[]>;
}

/**
 * Application-level DTO a Validator returns alongside its result when its run produced
 * a durable report (e.g. a test-result artifact). The ValidationService hands it to the
 * ArtifactService, which hashes the actual bytes and mints the real `Artifact` with
 * `producedBy = validator:<validatorId>@<version>`. Validators themselves never touch
 * ArtifactStore, the CAS, SQLite, or the workflow.
 */
export interface ReportArtifactDescriptor {
  /** Pack-defined opaque kind (e.g. `pack-x:report`) — Core never interprets it. */
  readonly kind: string;
  /** Short human label for the report. */
  readonly label: string;
  /**
   * UTF-8 report content. The digest is computed from these actual bytes at
   * materialization time — a caller-supplied hash claim would never be trusted
   * (ADR-0015, hash spoofing boundary).
   */
  readonly content: string;
}
