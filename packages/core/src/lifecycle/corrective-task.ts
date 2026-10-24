/**
 * Corrective task lineage — the pure domain contract (Sprint 18 / Task-18-05).
 *
 * A corrective task is a RUNTIME EXECUTION WORK ITEM, not a workflow-definition mutation: the
 * frozen WorkflowVersion / RunSnapshot / stage graph are untouched, and the new work item lives
 * in the existing Task domain, in the stage the original work belonged to.
 *
 * The lineage rides the existing Task payload seam (`Task.inputs`) under one versioned,
 * namespaced key, so the work payload and the lineage never mix and the shape can evolve:
 *
 *   inputs: { ...work payload, corrective: { schemaVersion, companyId, runId, originDecisionId,
 *            originDecisionVersion, reasonCode, parentTaskId, rootTaskId, round,
 *            causeEvidenceRefs, fingerprint } }
 *
 * The authoritative lineage source is the Decision (why the corrective is authorized); the Task
 * payload records which lineage the work item belongs to; the two cross-verify.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { canonicalJson, sha256Hex } from '../kernel/hash.js';
import { err, ok, type Result } from '../kernel/result.js';

/** Envelope version of the corrective lineage carried inside `Task.inputs`. */
export const CORRECTIVE_TASK_SCHEMA = 'companyos/corrective-task/1';

/** The namespaced payload key the lineage lives under (never a bare work-payload key). */
export const CORRECTIVE_TASK_INPUTS_KEY = 'corrective';

/**
 * V1 supported corrective causes. `TASK_FAILED` / `TOOL_FAILED` are deliberately absent: no
 * machine-verifiable durable cause contract exists for them yet, so they are refused rather
 * than provisioned from free text.
 */
export const CORRECTIVE_TASK_CAUSES = ['REVIEW_FINDING', 'VALIDATION_FAILED'] as const;
export type CorrectiveTaskCause = (typeof CORRECTIVE_TASK_CAUSES)[number];

export interface CorrectiveTaskLineage {
  readonly schemaVersion: typeof CORRECTIVE_TASK_SCHEMA;
  readonly companyId: string;
  readonly runId: string;
  /** The exact Decision version that authorized this corrective work item. */
  readonly originDecisionId: string;
  readonly originDecisionVersion: number;
  readonly reasonCode: CorrectiveTaskCause;
  /** The work task that requires correction (never the review task itself). */
  readonly parentTaskId: string;
  /** The original work task of the whole corrective chain. */
  readonly rootTaskId: string;
  /** 1 for the first corrective of the root, +1 per nesting level. */
  readonly round: number;
  /** The durable cause evidence (report artifacts), never free text. */
  readonly causeEvidenceRefs: readonly string[];
  /** Deterministic fingerprint over the lineage meaning. */
  readonly fingerprint: string;
}

/**
 * Sprint21 stale-descendant ruling (§14): the permanent identity of a DESCENDANT
 * reassessment — one per (corrective cause, descendant stage), forever. Same corrective +
 * same descendant stage ⇒ the same task; a different corrective ⇒ a different task.
 */
export const descendantReassessmentTaskIdOf = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly correctiveTaskId: string;
  readonly descendantStageId: string;
}): string =>
  `tsk_${sha256Hex(
    canonicalJson({
      purpose: 'companyos/descendant-reassessment/1',
      companyId: input.companyId,
      runId: input.runId,
      correctiveTaskId: input.correctiveTaskId,
      descendantStageId: input.descendantStageId,
    }),
  ).slice(0, 26)}` as ReturnType<typeof correctiveTaskIdOf>;

/**
 * Sprint21 final corrective (Boss §19): the permanent identity of the GENERIC REASSESSMENT
 * task the corrective provisioner creates for the finding's PRODUCER stage — one per
 * corrective task, forever, derived (never caller-suppliable), so replays and concurrent
 * provisioning converge on the same row.
 */
export const reassessmentTaskIdOf = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly correctiveTaskId: string;
}): string =>
  `tsk_${sha256Hex(
    canonicalJson({
      purpose: 'companyos/reassessment-task/1',
      companyId: input.companyId,
      runId: input.runId,
      correctiveTaskId: input.correctiveTaskId,
    }),
  ).slice(0, 26)}` as ReturnType<typeof correctiveTaskIdOf>;

/**
 * Permanent, tenant-scoped task identity. The caller can never supply it: it is derived from
 * the namespace, company, run and the exact Decision version that authorized the work, so one
 * Decision version maps to at most one corrective task id forever.
 */
export const correctiveTaskIdOf = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly originDecisionId: string;
  readonly originDecisionVersion: number;
}): string =>
  `tsk_${sha256Hex(
    canonicalJson({
      purpose: CORRECTIVE_TASK_SCHEMA,
      companyId: input.companyId,
      runId: input.runId,
      originDecisionId: input.originDecisionId,
      originDecisionVersion: input.originDecisionVersion,
    }),
  ).slice(0, 26)}`;

/** Deterministic fingerprint over everything that changes the lineage's meaning. */
export const correctiveLineageFingerprint = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly originDecisionId: string;
  readonly originDecisionVersion: number;
  readonly reasonCode: CorrectiveTaskCause;
  readonly parentTaskId: string;
  readonly rootTaskId: string;
  readonly round: number;
  readonly causeEvidenceRefs: readonly string[];
}): string =>
  sha256Hex(
    canonicalJson({
      purpose: CORRECTIVE_TASK_SCHEMA,
      companyId: input.companyId,
      runId: input.runId,
      originDecisionId: input.originDecisionId,
      originDecisionVersion: input.originDecisionVersion,
      reasonCode: input.reasonCode,
      parentTaskId: input.parentTaskId,
      rootTaskId: input.rootTaskId,
      round: input.round,
      causeEvidenceRefs: [...input.causeEvidenceRefs].sort(),
    }),
  );

/** Validate a caller-shaped lineage (the provisioner always derives the fields itself). */
export function validateCorrectiveLineage(input: unknown): Result<CorrectiveTaskLineage, DomainError> {
  const record = input as Record<string, unknown> | null;
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return err(domainError('INVALID_ARGUMENT', 'A corrective lineage must be an object.'));
  }
  if (record['schemaVersion'] !== CORRECTIVE_TASK_SCHEMA) {
    return err(
      domainError('INVALID_ARGUMENT', `Unsupported corrective lineage schema "${String(record['schemaVersion'])}".`, {
        reason: 'CORRECTIVE_LINEAGE_SCHEMA_UNSUPPORTED',
      }),
    );
  }
  for (const field of ['companyId', 'runId', 'originDecisionId', 'parentTaskId', 'rootTaskId']) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      return err(domainError('INVALID_ARGUMENT', `A corrective lineage needs a non-empty ${field}.`, { reason: 'CORRECTIVE_LINEAGE_FIELD_MISSING', field }));
    }
  }
  const version = record['originDecisionVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return err(domainError('INVALID_ARGUMENT', 'A corrective lineage needs an integer origin decision version.', { reason: 'CORRECTIVE_LINEAGE_VERSION_INVALID' }));
  }
  const round = record['round'];
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) {
    return err(domainError('INVALID_ARGUMENT', 'A corrective lineage needs a round of at least 1.', { reason: 'CORRECTIVE_LINEAGE_ROUND_INVALID' }));
  }
  if (!(CORRECTIVE_TASK_CAUSES as readonly string[]).includes(record['reasonCode'] as string)) {
    return err(domainError('INVALID_ARGUMENT', `Unsupported corrective cause "${String(record['reasonCode'])}".`, { reason: 'CORRECTIVE_LINEAGE_CAUSE_UNSUPPORTED' }));
  }
  const refs = record['causeEvidenceRefs'];
  if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== 'string' || ref.trim() === '')) {
    return err(domainError('INVALID_ARGUMENT', 'A corrective lineage needs at least one cause evidence ref.', { reason: 'CORRECTIVE_LINEAGE_EVIDENCE_MISSING' }));
  }
  if (refs.length > 64) {
    return err(domainError('INVALID_ARGUMENT', 'A corrective lineage may carry at most 64 cause evidence refs.', { reason: 'CORRECTIVE_LINEAGE_EVIDENCE_TOO_MANY' }));
  }
  const lineage: CorrectiveTaskLineage = {
    schemaVersion: CORRECTIVE_TASK_SCHEMA,
    companyId: record['companyId'] as string,
    runId: record['runId'] as string,
    originDecisionId: record['originDecisionId'] as string,
    originDecisionVersion: version,
    reasonCode: record['reasonCode'] as CorrectiveTaskCause,
    parentTaskId: record['parentTaskId'] as string,
    rootTaskId: record['rootTaskId'] as string,
    round,
    causeEvidenceRefs: refs as readonly string[],
    fingerprint: typeof record['fingerprint'] === 'string' ? (record['fingerprint'] as string) : '',
  };
  return ok(lineage);
}

/** Read the lineage out of a task payload; `null` when the task carries none. */
export function correctiveLineageOf(inputs: Readonly<Record<string, unknown>>): CorrectiveTaskLineage | null {
  const raw = inputs[CORRECTIVE_TASK_INPUTS_KEY];
  if (raw === undefined || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== CORRECTIVE_TASK_SCHEMA) return null;
  const parsed = validateCorrectiveLineage(record);
  return parsed.ok ? parsed.value : null;
}

/** Strip the lineage from a payload, so a corrective child never compounds envelopes. */
export const workPayloadOf = (inputs: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const copy: Record<string, unknown> = { ...inputs };
  delete copy[CORRECTIVE_TASK_INPUTS_KEY];
  return copy;
};
