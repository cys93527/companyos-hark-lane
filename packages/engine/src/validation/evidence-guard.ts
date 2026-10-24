/**
 * Validation Evidence Guard (Sprint 13B — Task-13-07; ADR-0020 R1-B + R2-B).
 *
 * The ONLY path that may conclude "this stage's quality gate is satisfied by durable
 * evidence". `VALIDATION_PASSED` can never again be caller-declared.
 *
 * Algorithm (ADR-0020 §19, frozen):
 *   1. artifact must exist and belong to the current run (wrong-run → fail closed)
 *   2. required validators = the IMMUTABLE stage snapshot's `config.validatorIds`
 *      (R1-B: every listed validator is blocking-required; non-listed validators never
 *      decide this stage's gate)
 *   3. candidate batches = durable RunValidation batches bound to `artifact:<id>`
 *      (grouped by creation command; corrupt mixed-anchor batches fail closed in the store)
 *   4. batch rows must anchor to the current run AND the gate's stageId
 *      (legacy stageId=null rows are NOT eligible for a staged gate — §22)
 *   5. effective batch = exactly ONE winner:
 *      max(batchFinishedAt = max(row.finishedAt)), tie-break max(validationId)
 *      (R2-B: latest durable batch wins; NO fallback to an older passing batch;
 *      NO cross-batch evidence composition)
 *   6. every required validator must have exactly one row in the effective batch,
 *      with row.blocking === true (policy authority beats row self-report — §3)
 *      and row.status === 'pass'
 *   7. non-required rows (warnings, extra blocking evidence) never decide the gate
 *
 * This guard READS ONLY: ArtifactStore + ValidationStore + the stage-policy reader.
 * It never executes validators, never writes, never repairs data (§31-§33).
 */
import {
  artifactTargetRef,
  domainError,
  err,
  ok,
  qualityGatePassed,
  type ArtifactStorePort,
  type DomainError,
  type Result,
  type Validation,
  type ValidationStorePort,
} from '@companyos/core';

export interface GateStagePolicy {
  /**
   * The immutable stage snapshot's required validator ids (R1-B: blocking-required).
   * Sourced from the run's pinned template version graph node config — the reader is
   * wired by the composition root / tests; the guard itself stays persistence-blind.
   */
  requiredValidators(input: {
    readonly runId: string;
    readonly stageId: string;
  }): Promise<Result<readonly string[], DomainError>>;
}

export interface ValidationEvidenceGuardDeps {
  readonly artifactStore: ArtifactStorePort;
  readonly validationStore: ValidationStorePort;
  readonly stagePolicy: GateStagePolicy;
}

export interface EvidenceGateInput {
  readonly runId: string;
  readonly stageId: string;
  /** The exact artifact under gate — intent supplied by the caller, verified against durable state. */
  readonly artifactId: string;
  /** Optional task anchor: when present, evidence rows must match exactly (null is never a wildcard — §23). */
  readonly taskId?: string | null;
}

export interface EvidenceGateVerdict {
  /** The ONE effective durable batch that decided the gate (audit trail). */
  readonly creationCommandId: string;
  readonly validations: readonly Validation[];
  /** The required-validator rows that passed the pure gate (R1-B authorities only). */
  readonly requiredRows: readonly Validation[];
}

export interface ValidationEvidenceGuard {
  evaluateGate(input: EvidenceGateInput): Promise<Result<EvidenceGateVerdict, DomainError>>;
}

/** R2-B ordering: batchFinishedAt = max(row.finishedAt); tie-break max(validationId). */
const batchFinishedAt = (batch: { readonly validations: readonly Validation[] }): string => {
  let max = '';
  for (const row of batch.validations) {
    const finished = row.finishedAt ?? row.startedAt;
    if (finished > max) max = finished;
  }
  return max;
};
const batchMaxValidationId = (batch: { readonly validations: readonly Validation[] }): string => {
  let max = '';
  for (const row of batch.validations) if (row.id > max) max = row.id;
  return max;
};

export function createValidationEvidenceGuard(deps: ValidationEvidenceGuardDeps): ValidationEvidenceGuard {
  return {
    async evaluateGate(input: EvidenceGateInput): Promise<Result<EvidenceGateVerdict, DomainError>> {
      // ---- 1. Artifact exists and belongs to the run (§7/§8) ----
      const artifact = await deps.artifactStore.get(input.artifactId as never);
      if (artifact === null) {
        return err(domainError('NOT_FOUND', `Gate target artifact "${input.artifactId}" does not exist.`, {
          reason: 'VALIDATION_GATE_TARGET_MISSING',
          artifactId: input.artifactId,
        }));
      }
      if (artifact.runId !== input.runId) {
        return err(domainError('VALIDATION_FAILED', 'Gate target artifact belongs to a different run.', {
          reason: 'VALIDATION_GATE_WRONG_RUN',
          artifactId: input.artifactId,
          artifactRunId: artifact.runId,
          gateRunId: input.runId,
        }));
      }

      // ---- 2. Authoritative required validators (R1-B: immutable stage snapshot) ----
      const required = await deps.stagePolicy.requiredValidators({
        runId: input.runId,
        stageId: input.stageId,
      });
      if (!required.ok) return required;
      const requiredIds = required.value;
      // Sprint 1 invariant preserved: NO required evidence ≠ gate passed. A stage with
      // empty validatorIds never auto-passes the Sprint 13 evidence gate (§5 ruling).
      if (requiredIds.length === 0) {
        return err(domainError('VALIDATION_FAILED', 'The stage declares no required validators; the Sprint 13 evidence gate cannot pass on no evidence.', {
          reason: 'VALIDATION_GATE_NO_REQUIREMENTS',
          runId: input.runId,
          stageId: input.stageId,
        }));
      }
      const duplicates = new Set(requiredIds);
      if (duplicates.size !== requiredIds.length) {
        return err(domainError('VALIDATION_FAILED', 'Stage policy lists a duplicate validator id.', {
          reason: 'VALIDATION_GATE_POLICY_INVALID',
          stageId: input.stageId,
        }));
      }

      // ---- 3. Durable candidate batches for this exact target (§9) ----
      const targetRef = artifactTargetRef(input.artifactId);
      const batches = await deps.validationStore.listBatchesByTargetRef(targetRef);
      if (batches.length === 0) {
        return err(domainError('VALIDATION_FAILED', `No durable validation evidence exists for "${targetRef}".`, {
          reason: 'VALIDATION_GATE_NO_EVIDENCE',
          targetRef,
        }));
      }

      // ---- 4. Anchor filter: run + stage (+ task when provided) (§10/§15/§22/§23) ----
      const eligible = batches.filter((batch) => {
        const anchors = batch.validations;
        if (anchors.length === 0) return false;
        return anchors.every(
          (row) =>
            row.runId === input.runId &&
            row.stageId === input.stageId && // legacy stageId=null is NOT eligible for a staged gate
            (input.taskId === undefined || input.taskId === null ? true : row.taskId === input.taskId),
        );
      });
      if (eligible.length === 0) {
        return err(domainError('VALIDATION_FAILED', `No validation batch for "${targetRef}" anchors to this run/stage.`, {
          reason: 'VALIDATION_GATE_NO_ELIGIBLE_BATCH',
          targetRef,
          runId: input.runId,
          stageId: input.stageId,
        }));
      }

      // ---- 5. R2-B: exactly ONE effective batch — latest wins, no fallback (§8-§13) ----
      const effective = eligible.reduce((best, candidate) => {
        const bestFinished = batchFinishedAt(best);
        const candidateFinished = batchFinishedAt(candidate);
        if (candidateFinished > bestFinished) return candidate;
        if (candidateFinished < bestFinished) return best;
        return batchMaxValidationId(candidate) > batchMaxValidationId(best) ? candidate : best;
      });

      // ---- 6. Required-validator reconciliation (§1/§3/§11/§15/§17) ----
      const requiredRows: Validation[] = [];
      for (const validatorId of requiredIds) {
        const rows = effective.validations.filter((row) => row.validatorId === validatorId);
        if (rows.length === 0) {
          // NEVER borrow from an older batch (§11).
          return err(domainError('VALIDATION_FAILED', `Required validator "${validatorId}" has no evidence in the latest validation batch.`, {
            reason: 'VALIDATION_GATE_INCOMPLETE',
            validatorId,
            creationCommandId: effective.creationCommandId,
            requiredValidators: [...requiredIds],
          }));
        }
        if (rows.length > 1) {
          return err(domainError('VALIDATION_FAILED', `Required validator "${validatorId}" appears twice in the effective batch.`, {
            reason: 'VALIDATION_GATE_EVIDENCE_INVALID',
            validatorId,
            creationCommandId: effective.creationCommandId,
          }));
        }
        const row = rows[0]!;
        // §3: stage snapshot is the policy authority — a row self-reporting
        // blocking=false cannot downgrade a blocking-required condition.
        if (!row.blocking) {
          return err(domainError('VALIDATION_FAILED', `Required validator "${validatorId}" evidence is non-blocking; stage policy requires blocking.`, {
            reason: 'VALIDATION_GATE_POLICY_MISMATCH',
            validatorId,
            creationCommandId: effective.creationCommandId,
          }));
        }
        requiredRows.push(row);
      }

      // ---- 7. Pure domain final check over EXACTLY the authoritative rows (§20/§21) ----
      if (!qualityGatePassed(requiredRows)) {
        const failing = requiredRows.filter((row) => row.status !== 'pass');
        return err(domainError('VALIDATION_FAILED', 'The quality gate rejected the latest validation batch.', {
          reason: 'VALIDATION_GATE_FAILED',
          creationCommandId: effective.creationCommandId,
          failingValidators: failing.map((row) => ({ validatorId: row.validatorId, status: row.status })),
        }));
      }

      return ok({
        creationCommandId: effective.creationCommandId,
        validations: effective.validations,
        requiredRows,
      });
    },
  };
}
