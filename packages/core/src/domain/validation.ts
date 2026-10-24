/**
 * Validation — the recorded outcome of running a Validator (规划书 §四 Core 概念 13;
 * §三十二 Validation System; §二原则 7 真实结果优先于 AI 自述).
 *
 * A validation is evidence, not opinion: it stores the command, the exit code and
 * the artifact references. `pass` without an exit code of 0 is rejected.
 *
 * Sprint 13A reconciliation (ADR-0017): `targetRef` durably binds the validation to
 * the EXACT artifact being validated — a concept the Sprint 1 contract lacked. It is
 * deliberately separate from `evidenceRefs` (target ≠ evidence): targetRef identifies
 * the validated object, evidenceRefs list the references supporting the verdict.
 * `null` is legacy Sprint 1 compatibility only; Sprint 13 durable artifact validations
 * must carry a targetRef (enforced by the future ValidationService, fail closed).
 */
import { brand, type Brand } from '../kernel/brand.js';
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import {
  makeId,
  type StageId,
  type TaskId,
  type ValidationId,
  type WorkflowRunId,
} from '../kernel/identifiers.js';

export const VALIDATION_STATUSES = ['pass', 'fail', 'error', 'skipped'] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/**
 * Evidence must be *addressable* (review finding: `['']` must not count as proof).
 * Accepted forms: `artifact:<id>` (a Core Artifact) or `command:<name>` (a recorded
 * tool invocation). A prefix with nothing after it is rejected.
 */
export const VALIDATION_EVIDENCE_PATTERN = /^(artifact|command):\s*\S.*$/;

/**
 * Controlled target ref (ADR-0017): the only Sprint 13 form is
 * `artifact:<artifactId>` where the id carries the frozen `art_` prefix and a ULID
 * body (Crockford base32). Core validates the STRUCTURE only — it never resolves the
 * ref against SQLite, the filesystem, or an ArtifactStore.
 */
const VALIDATION_TARGET_REF_PATTERN = /^artifact:art_[0-9A-HJKMNP-TV-Z]{10,40}$/;

export type ValidationTargetRef = Brand<string, 'ValidationTargetRef'>;

/** Mint the canonical target ref for an artifact under validation. */
export const artifactTargetRef = (artifactId: string): ValidationTargetRef =>
  brand(`artifact:${artifactId}`);

export const isValidationTargetRef = (value: unknown): value is ValidationTargetRef =>
  typeof value === 'string' && VALIDATION_TARGET_REF_PATTERN.test(value);

export interface Validation {
  readonly id: ValidationId;
  readonly runId: WorkflowRunId;
  readonly stageId: StageId | null;
  readonly taskId: TaskId | null;
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly status: ValidationStatus;
  /** The exact command that was run (copy-pasteable), or `null` for non-command validators. */
  readonly command: string | null;
  readonly exitCode: number | null;
  /** Blocking validators gate the transition to the next stage (规划书 §三十二). */
  readonly blocking: boolean;
  readonly evidenceRefs: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /**
   * The exact artifact under validation (ADR-0017). `null` = legacy Sprint 1 record;
   * legacy untargeted validations can never serve as targeted quality-gate evidence.
   */
  readonly targetRef: ValidationTargetRef | null;
}

export interface CreateValidationInput {
  readonly runId: WorkflowRunId;
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly status: ValidationStatus;
  readonly startedAt: string;
  readonly ids: IdFactory;
  readonly stageId?: StageId;
  readonly taskId?: TaskId;
  readonly command?: string;
  readonly exitCode?: number;
  readonly blocking?: boolean;
  readonly evidenceRefs?: readonly string[];
  readonly finishedAt?: string;
  /** Sprint 13 (ADR-0017): required for durable artifact validations; null = legacy. */
  readonly targetRef?: ValidationTargetRef | null;
}

export function createValidation(input: CreateValidationInput): Result<Validation, DomainError> {
  if (input.validatorId.trim().length === 0) {
    return err(domainError('INVALID_ARGUMENT', 'validatorId must not be empty.', {}));
  }
  if (input.validatorVersion.trim().length === 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'validatorVersion must not be empty (evidence needs a version).', {
        validatorId: input.validatorId,
      }),
    );
  }
  const exitCode = input.exitCode ?? null;
  const evidenceRefs = input.evidenceRefs ?? [];

  const malformedEvidence = evidenceRefs.filter((ref) => !VALIDATION_EVIDENCE_PATTERN.test(ref));
  if (malformedEvidence.length > 0) {
    return err(
      domainError(
        'INVALID_ARGUMENT',
        'Every evidence reference must look like "artifact:<id>" or "command:<name>" and must not be blank.',
        { validatorId: input.validatorId, malformedEvidence },
      ),
    );
  }

  if (input.status === 'pass' && exitCode !== null && exitCode !== 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'A "pass" validation cannot carry a non-zero exit code.', {
        validatorId: input.validatorId,
        exitCode,
      }),
    );
  }
  if (input.status === 'pass' && exitCode !== 0 && evidenceRefs.length === 0) {
    // Review finding BLOCKER-2: "pass with nothing attached" is exactly the
    // AI-self-report failure mode that 规划书 §二原则 7 forbids. A pass must carry
    // a command that exited 0, or at least one evidence artifact.
    return err(
      domainError(
        'VALIDATION_FAILED',
        'A "pass" verdict needs evidence: exit code 0 or at least one evidence reference.',
        { validatorId: input.validatorId, exitCode, evidenceRefCount: evidenceRefs.length },
      ),
    );
  }
  if (input.status === 'fail' && exitCode === 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'A "fail" validation cannot carry exit code 0.', {
        validatorId: input.validatorId,
        exitCode,
      }),
    );
  }
  // ADR-0017: the target ref is structure-validated here (Core never resolves it).
  // Omitted/undefined = legacy Sprint 1 record (persisted as null).
  let targetRef: ValidationTargetRef | null = null;
  if (input.targetRef !== undefined && input.targetRef !== null) {
    if (!isValidationTargetRef(input.targetRef)) {
      return err(
        domainError(
          'INVALID_ARGUMENT',
          'targetRef must be a canonical artifact target ref ("artifact:art_<ulid>").',
          { validatorId: input.validatorId, targetRef: input.targetRef },
        ),
      );
    }
    targetRef = input.targetRef;
  }
  return ok({
    id: makeId<'ValidationId'>('validation', input.ids),
    runId: input.runId,
    stageId: input.stageId ?? null,
    taskId: input.taskId ?? null,
    validatorId: input.validatorId,
    validatorVersion: input.validatorVersion,
    status: input.status,
    command: input.command ?? null,
    exitCode,
    blocking: input.blocking ?? true,
    evidenceRefs,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    targetRef,
  });
}

export const isBlockingFailure = (validation: Validation): boolean =>
  validation.blocking && validation.status !== 'pass';

/**
 * 质量门（规划书 §三十二）：
 *   - **没有阻塞 Validator ⇒ 不通过**（"没有证据" 不等于 "通过"，review finding BLOCKER-2）；
 *   - 所有阻塞 Validator 必须 `pass`。
 */
export const qualityGatePassed = (validations: readonly Validation[]): boolean => {
  const blocking = validations.filter((validation) => validation.blocking);
  if (blocking.length === 0) return false;
  return blocking.every((validation) => validation.status === 'pass');
};

export const blockingFailures = (validations: readonly Validation[]): readonly Validation[] =>
  validations.filter(isBlockingFailure);
