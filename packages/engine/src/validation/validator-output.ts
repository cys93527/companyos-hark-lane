/**
 * Validator output decoder (Sprint 13 / Task-13-06, R2).
 *
 * A validator tool expresses its verdict through a STRICT additive envelope inside the
 * ordinary ToolResult output — never a blind cast of arbitrary stdout. Anything that
 * does not decode is a validator malfunction and becomes `status: 'error'` evidence
 * (ADR-0016: ERROR = the validator itself failed to complete; FAIL = it ran and judged
 * the target non-compliant).
 */
import {
  VALIDATION_EVIDENCE_PATTERN,
  domainError,
  err,
  ok,
  type DomainError,
  type ReportArtifactDescriptor,
  type Result,
} from '@companyos/core';

export const VALIDATOR_VERDICTS = ['pass', 'fail', 'skipped'] as const;
export type ValidatorVerdict = (typeof VALIDATOR_VERDICTS)[number];

export interface DecodedValidatorOutput {
  readonly verdict: ValidatorVerdict;
  readonly evidenceRefs: readonly string[];
  readonly report: ReportArtifactDescriptor | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Decode the frozen envelope: `{ verdict, evidenceRefs?, report? }`.
 * `status: 'error'`-worthy outputs (the validator malfunctioned) are returned as errors
 * so the service can record ERROR evidence instead of trusting garbage.
 */
export function decodeValidatorOutput(output: unknown): Result<DecodedValidatorOutput, DomainError> {
  if (!isRecord(output)) {
    return err(domainError('VALIDATION_FAILED', 'Validator output is not a structured envelope.', { reason: 'VALIDATOR_OUTPUT_INVALID' }));
  }
  const { verdict } = output;
  if (typeof verdict !== 'string' || !(VALIDATOR_VERDICTS as readonly string[]).includes(verdict)) {
    return err(domainError('VALIDATION_FAILED', 'Validator output must carry a pass/fail/skipped verdict.', { reason: 'VALIDATOR_VERDICT_INVALID' }));
  }

  const rawEvidence = output.evidenceRefs;
  let evidenceRefs: readonly string[] = [];
  if (rawEvidence !== undefined) {
    if (!Array.isArray(rawEvidence) || rawEvidence.some((ref) => typeof ref !== 'string' || !VALIDATION_EVIDENCE_PATTERN.test(ref))) {
      return err(domainError('VALIDATION_FAILED', 'Validator evidence refs must be addressable ("artifact:<id>" / "command:<name>").', { reason: 'VALIDATOR_EVIDENCE_INVALID' }));
    }
    evidenceRefs = rawEvidence as readonly string[];
  }

  const rawReport = output.report;
  let report: ReportArtifactDescriptor | null = null;
  if (rawReport !== undefined && rawReport !== null) {
    if (
      !isRecord(rawReport) ||
      typeof rawReport.kind !== 'string' || rawReport.kind.trim() === '' ||
      typeof rawReport.label !== 'string' || rawReport.label.trim() === '' ||
      typeof rawReport.content !== 'string'
    ) {
      return err(domainError('VALIDATION_FAILED', 'Validator report must be { kind, label, content }.', { reason: 'VALIDATOR_REPORT_INVALID' }));
    }
    report = {
      kind: rawReport.kind,
      label: rawReport.label,
      content: rawReport.content,
    };
  }

  return ok({ verdict: verdict as ValidatorVerdict, evidenceRefs, report });
}
