/**
 * Durable validation store (Sprint 13 — ADR-0016).
 *
 * Append-only evidence persistence: INSERT-only — there is no UPDATE or DELETE here.
 * One RunValidation command persists N rows (one per validator) sharing a batch
 * `creation_command_fingerprint`; the partial unique index
 * (creation_command_id, validator_id) makes a retry of the same command idempotent at
 * the storage layer, while a NEW commandId (intentional re-validation) is never blocked.
 *
 * This store persists facts only: it never decides PASS semantics, blocking policy, or
 * replay vs CONFLICT — that is the future ValidationService's policy.
 */
import {
  DomainError,
  VALIDATION_STATUSES,
  isValidationTargetRef,
  type DurableValidationLookup,
  type Validation,
  type ValidationCreationMetadata,
  type ValidationId,
  type ValidationStorePort,
  type WorkflowRunId,
} from '@companyos/core';

import type { Database } from '../db.js';

interface ValidationRow {
  readonly validation_id: string;
  readonly run_id: string;
  readonly stage_id: string | null;
  readonly task_id: string | null;
  readonly validator_id: string;
  readonly validator_version: string;
  readonly status: string;
  readonly command: string | null;
  readonly exit_code: number | bigint | null;
  readonly blocking: number | bigint;
  readonly evidence_refs_json: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly created_at: string;
  readonly creation_command_id: string | null;
  readonly creation_command_fingerprint: string | null;
  readonly target_ref: string | null;
}

interface EvidenceRow {
  readonly creation_command_fingerprint: string | null;
}

/** Storage-layer integrity guard: a recovered validation must still satisfy its invariants. */
const toValidation = (row: ValidationRow): Validation => {
  let evidenceRefs: readonly string[];
  try {
    const parsed: unknown = JSON.parse(row.evidence_refs_json);
    if (!Array.isArray(parsed) || parsed.some((ref) => typeof ref !== 'string')) {
      throw new Error('evidence refs must be a JSON array of strings');
    }
    evidenceRefs = parsed;
  } catch (error) {
    // JSON parse fail closed: a corrupt row is surfaced, never silently repaired.
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Validation row "${row.validation_id}" is corrupt: evidence_refs_json is unreadable.`,
      { details: { validationId: row.validation_id, cause: (error as Error).message, reason: 'VALIDATION_ROW_CORRUPT' } },
    );
  }
  const status = VALIDATION_STATUSES.find((candidate) => candidate === row.status);
  if (status === undefined || row.validator_id.trim() === '') {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Validation row "${row.validation_id}" is corrupt: recovered shape violates the domain invariants.`,
      { details: { validationId: row.validation_id, reason: 'VALIDATION_ROW_CORRUPT' } },
    );
  }
  // ADR-0017: target_ref must be NULL (legacy) or a canonical artifact target ref.
  if (row.target_ref !== null && !isValidationTargetRef(row.target_ref)) {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Validation row "${row.validation_id}" is corrupt: target_ref is not a canonical artifact target ref.`,
      { details: { validationId: row.validation_id, reason: 'VALIDATION_ROW_CORRUPT' } },
    );
  }
  return {
    id: row.validation_id as Validation['id'],
    runId: row.run_id as Validation['runId'],
    stageId: row.stage_id as Validation['stageId'],
    taskId: row.task_id as Validation['taskId'],
    validatorId: row.validator_id,
    validatorVersion: row.validator_version,
    status,
    command: row.command,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    blocking: Number(row.blocking) === 1,
    evidenceRefs,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    targetRef: row.target_ref as Validation['targetRef'],
  };
};

export function createSqliteValidationStore(db: Database): ValidationStorePort {
  return {
    async record(validation: Validation, creation: ValidationCreationMetadata): Promise<void> {
      try {
        db.prepare(
          `INSERT INTO validations (
             validation_id, run_id, stage_id, task_id, validator_id, validator_version,
             status, command, exit_code, blocking, evidence_refs_json, started_at,
             finished_at, created_at, creation_command_id, creation_command_fingerprint,
             target_ref
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          validation.id,
          validation.runId,
          validation.stageId,
          validation.taskId,
          validation.validatorId,
          validation.validatorVersion,
          validation.status,
          validation.command,
          validation.exitCode,
          validation.blocking ? 1 : 0,
          JSON.stringify(validation.evidenceRefs),
          validation.startedAt,
          validation.finishedAt,
          validation.startedAt,
          creation.creationCommandId,
          creation.creationCommandFingerprint,
          validation.targetRef,
        );
      } catch (error) {
        if (error instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(error.message)) {
          throw new DomainError(
            'CONFLICT',
            `Validation command "${creation.creationCommandId}" already recorded a row for validator "${validation.validatorId}".`,
            {
              details: {
                reason: 'VALIDATION_CREATION_COMMAND_EXISTS',
                creationCommandId: creation.creationCommandId,
                validatorId: validation.validatorId,
              },
            },
          );
        }
        throw error;
      }
    },

    async get(validationId: ValidationId): Promise<Validation | null> {
      const row = db.prepare('SELECT * FROM validations WHERE validation_id = ?').get(validationId) as
        | ValidationRow
        | undefined;
      return row === undefined ? null : toValidation(row);
    },

    async getByCreationCommand(commandId: string): Promise<DurableValidationLookup | null> {
      const rows = db
        .prepare(
          'SELECT * FROM validations WHERE creation_command_id = ? ORDER BY validator_id ASC, validation_id ASC',
        )
        .all(commandId) as readonly ValidationRow[];
      if (rows.length === 0) return null;

      // Integrity guard 1: one command → one batch fingerprint. Mixed fingerprints mean
      // a corrupt batch — surface it, never silently pick one (ADR-0016 decision 13).
      const fingerprints = new Set<string>();
      for (const row of rows) {
        if (row.creation_command_fingerprint === null) {
          throw new DomainError(
            'PERSISTENCE_FAILED',
            `Validation batch "${commandId}" is corrupt: a row is missing its creation fingerprint.`,
            { details: { creationCommandId: commandId, reason: 'VALIDATION_BATCH_FINGERPRINT_MISSING' } },
          );
        }
        fingerprints.add(row.creation_command_fingerprint);
      }
      if (fingerprints.size > 1) {
        throw new DomainError(
          'PERSISTENCE_FAILED',
          `Validation batch "${commandId}" is corrupt: rows carry ${String(fingerprints.size)} different creation fingerprints.`,
          {
            details: {
              creationCommandId: commandId,
              reason: 'VALIDATION_BATCH_FINGERPRINT_MISMATCH',
              fingerprintCount: fingerprints.size,
            },
          },
        );
      }

      // Integrity guard 2 (ADR-0017): one command → one target. Mixed target refs are a
      // corrupt batch — fail closed, never silently pick one.
      const targetRefs = new Set<string>();
      for (const row of rows) {
        if (row.target_ref !== null) targetRefs.add(row.target_ref);
      }
      if (targetRefs.size > 1) {
        throw new DomainError(
          'PERSISTENCE_FAILED',
          `Validation batch "${commandId}" is corrupt: rows carry ${String(targetRefs.size)} different target refs.`,
          {
            details: {
              creationCommandId: commandId,
              reason: 'VALIDATION_BATCH_TARGET_MISMATCH',
              targetRefCount: targetRefs.size,
            },
          },
        );
      }

      return {
        validations: rows.map(toValidation),
        creationCommandId: commandId,
        creationCommandFingerprint: rows[0]?.creation_command_fingerprint ?? '',
        targetRef: (rows[0]?.target_ref ?? null) as Validation['targetRef'],
      };
    },

    async listByRun(runId: WorkflowRunId): Promise<readonly Validation[]> {
      const rows = db
        .prepare('SELECT * FROM validations WHERE run_id = ? ORDER BY created_at DESC, validation_id DESC')
        .all(runId) as readonly ValidationRow[];
      return rows.map(toValidation);
    },

    async listByTargetRef(targetRef: Validation['targetRef']): Promise<readonly Validation[]> {
      const rows = db
        .prepare(
          'SELECT * FROM validations WHERE target_ref = ? ORDER BY created_at DESC, validation_id DESC',
        )
        .all(targetRef) as readonly ValidationRow[];
      return rows.map(toValidation);
    },

    async listBatchesByTargetRef(targetRef: Validation['targetRef']): Promise<readonly DurableValidationLookup[]> {
      // ADR-0020 §15/§16: candidate batches are discovered by target, then each is
      // loaded IN FULL via getByCreationCommand — which validates batch integrity
      // (mixed fingerprint / mixed targetRef fail closed) over ALL of the command's
      // rows, so a corrupt mixed-anchor batch can never slip through a filtered read.
      const commandIds = db
        .prepare('SELECT DISTINCT creation_command_id FROM validations WHERE target_ref = ? ORDER BY creation_command_id ASC')
        .all(targetRef) as readonly { creation_command_id: string | null }[];
      const batches: DurableValidationLookup[] = [];
      const self = this as { getByCreationCommand(commandId: string): Promise<DurableValidationLookup | null> };
      for (const row of commandIds) {
        if (row.creation_command_id === null) continue; // pre-T02 rows: no batch identity
        const lookup = await self.getByCreationCommand(row.creation_command_id);
        if (lookup !== null) batches.push(lookup);
      }
      return batches;
    },
  };
}

/** Exported for integrity tests: batch fingerprint count query (diagnostics only). */
export const validationBatchFingerprintCount = (db: Database, commandId: string): number => {
  const rows = db
    .prepare('SELECT DISTINCT creation_command_fingerprint FROM validations WHERE creation_command_id = ?')
    .all(commandId) as readonly EvidenceRow[];
  return rows.length;
};
