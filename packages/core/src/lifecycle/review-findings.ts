/**
 * Structured review findings — the pure domain contract (Sprint 18 / Task-18-04).
 *
 * REVIEW IS SEMANTIC EVIDENCE, REVIEW IS NOT QA. A reviewer report is a durable semantic CLAIM
 * about reviewed work: it may drive corrective work later (T18-06), but it can never stand in
 * for Validation evidence, and a PASS verdict is not a QA pass.
 *
 * The report itself is carried by the run-owned immutable Artifact primitive (the T18-02
 * carrier), so nothing here owns storage: this module owns the versioned envelope, the verdict
 * vocabulary, the finding shape, the deterministic finding identity and the canonical
 * fingerprints. The writer that turns a validated payload into durable bytes lives in the
 * engine.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { canonicalJson, sha256Hex } from '../kernel/hash.js';
import { err, ok, type Result } from '../kernel/result.js';

/** Canonical artifact kind of a review report (ours by convention; Core never interprets kinds). */
export const REVIEW_FINDINGS_ARTIFACT_KIND = 'companyos:review-findings';

/** Envelope version carried inside the durable bytes. */
export const REVIEW_FINDINGS_SCHEMA = 'companyos/review-findings/1';

/**
 * V1 verdict vocabulary. `PASS` means "no blocking semantic finding within the reviewed scope"
 * and is deliberately NOT a QA verdict; no overlapping second taxonomy is introduced.
 */
export const REVIEW_VERDICTS = ['PASS', 'CHANGES_REQUESTED', 'BLOCKED'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/* ------------------------------------------------------------------- bounds (documented) */

export const REVIEW_FINDINGS_LIMITS = {
  /** A report is a structured summary, never a diff, a log or a source file. */
  maxFindings: 64,
  maxSummaryChars: 2_000,
  maxDetailChars: 8_000,
  maxEvidenceRefsPerFinding: 16,
  maxEvidenceRefsPerReport: 64,
  maxLocatorPathChars: 400,
  maxCodeChars: 64,
  maxSubjectChars: 200,
} as const;

/** A repo-relative informational locator. A path string is NEVER durable evidence. */
export interface ReviewFindingLocator {
  /** Repo-relative path (forward slashes, no drive, no UNC, no leading slash, no `..`). */
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly symbol?: string;
}

export interface ReviewFinding {
  /** System-generated identity — a model may never mint an authoritative one. */
  readonly findingId: string;
  readonly code: string;
  readonly summary: string;
  readonly detail: string;
  readonly blocking: boolean;
  readonly subject?: string | null;
  readonly locator?: ReviewFindingLocator | null;
  /** Existing durable grammar only: `artifact:art_…` / `art_…` / `val_…`. */
  readonly evidenceRefs: readonly string[];
  /** Deterministic fingerprint, for repeated-failure detection (T18-07). */
  readonly fingerprint: string;
}

export interface ReviewProvenance {
  readonly agentId: string;
  readonly roleId: string;
  /** The durable AgentExecution that produced the review (always present). */
  readonly executionId: string;
  /** The trusted orchestration identity that recorded the report. */
  readonly decidedBy: string;
}

export interface ReviewReportPayload {
  readonly schemaVersion: typeof REVIEW_FINDINGS_SCHEMA;
  readonly companyId: string;
  readonly runId: string;
  readonly reviewStageId: string;
  readonly reviewTaskId: string;
  /** Durable execution identity: the proven AgentExecution, or the reviewed task attempt. */
  readonly reviewExecutionId: string;
  readonly reviewAttempt: number;
  readonly subjectTaskId: string;
  readonly verdict: ReviewVerdict;
  readonly findings: readonly ReviewFinding[];
  /** Reviewer provenance DERIVED from the AgentExecution row (never caller-supplied). */
  readonly reviewer: ReviewProvenance;
  /** The binding the execution ACTUALLY used, read from the AgentExecution row. */
  readonly executionBinding: {
    readonly modelKey: string;
    readonly providerId: string;
    readonly providerModelId: string;
  };
  readonly modelBindingKey: string | null;
  readonly resolvedModelKey: string | null;
  readonly evidenceRefs: readonly string[];
  /** Report-level semantic fingerprint (audit); the artifact fingerprint stays authoritative. */
  /**
   * Report-level semantic fingerprint (audit); the artifact fingerprint stays authoritative.
   *
   * Deliberately NOT carried here: the creation instant and the author live on the immutable
   * artifact row (Artifact.createdAt / Artifact.producedBy), so the durable bytes of one
   * logical review execution stay byte-identical across replays.
   */
  readonly reportFingerprint?: string;
}

/* ------------------------------------------------------------------ identity & fingerprint */

const COMMAND_PREFIX = `${REVIEW_FINDINGS_SCHEMA}`;

/** Tenant-scoped creation command identity — company first, so no T18-03-style collision. */
export const reviewFindingsCommandId = (
  companyId: string,
  runId: string,
  reviewTaskId: string,
  reviewExecutionIdentity: string,
): string => `${COMMAND_PREFIX}:${companyId}:${runId}:${reviewTaskId}:${reviewExecutionIdentity}`;

/**
 * Deterministic finding identity: `rf_<sha256(...)>` over the semantic fields only — never a
 * timestamp, never a random id, never array order. A model cannot mint one.
 */
export const reviewFindingIdOf = (input: {
  readonly runId: string;
  readonly reviewTaskId: string;
  readonly code: string;
  readonly blocking: boolean;
  readonly summary: string;
  readonly detail: string;
  readonly subject: string | null;
  readonly locator: ReviewFindingLocator | null;
  readonly evidenceRefs: readonly string[];
}): string => `rf_${sha256Hex(canonicalJson(findingIdentityInput(input))).slice(0, 24)}`;

/**
 * The finding fingerprint: normalized code/blocking/summary/detail/subject/locator and SORTED
 * evidence refs. `createdAt`, random ids and array order never participate.
 */
export const reviewFindingFingerprint = (input: {
  readonly code: string;
  readonly blocking: boolean;
  readonly summary: string;
  readonly detail: string;
  readonly subject: string | null;
  readonly locator?: ReviewFindingLocator | null;
  readonly evidenceRefs: readonly string[];
}): string => sha256Hex(canonicalJson(findingIdentityInput({ ...input, runId: '', reviewTaskId: '' })));

const findingIdentityInput = (input: {
  readonly runId?: string;
  readonly reviewTaskId?: string;
  readonly code: string;
  readonly blocking: boolean;
  readonly summary: string;
  readonly detail: string;
  readonly subject: string | null;
  readonly locator?: ReviewFindingLocator | null;
  readonly evidenceRefs: readonly string[];
}): Record<string, unknown> => ({
  purpose: 'review.finding/1',
  ...(input.runId === undefined ? {} : { runId: input.runId }),
  ...(input.reviewTaskId === undefined ? {} : { reviewTaskId: input.reviewTaskId }),
  code: input.code.trim().toLowerCase(),
  blocking: input.blocking,
  summary: input.summary.trim(),
  detail: input.detail.trim(),
  subject: input.subject === null ? null : input.subject.trim(),
  locator: input.locator ?? null,
  evidenceRefs: [...input.evidenceRefs].sort(),
});

/**
 * The report-level semantic fingerprint recorded INSIDE the payload. The authoritative
 * permanent idempotency stays with `ArtifactService` (its trusted fingerprint covers the exact
 * content digest); this documents the semantic coverage Boss §20 requires.
 */
export const reviewFindingsArtifactFingerprint = (input: {
  readonly companyId: string;
  readonly runId: string;
  readonly reviewStageId: string;
  readonly reviewTaskId: string;
  readonly reviewExecutionId: string;
  readonly reviewAttempt: number;
  readonly subjectTaskId: string;
  readonly verdict: ReviewVerdict;
  readonly findings: readonly { readonly findingId: string; readonly fingerprint: string }[];
  readonly reviewer: ReviewProvenance;
  readonly executionBinding: { readonly modelKey: string; readonly providerId: string; readonly providerModelId: string };
  readonly modelBindingKey: string | null;
  readonly resolvedModelKey: string | null;
  readonly evidenceRefs: readonly string[];
  readonly contentDigest: string;
}): string =>
  sha256Hex(
    canonicalJson({
      purpose: 'review.findings.artifact/1',
      companyId: input.companyId,
      runId: input.runId,
      reviewStageId: input.reviewStageId,
      reviewTaskId: input.reviewTaskId,
      reviewExecutionId: input.reviewExecutionId,
      reviewAttempt: input.reviewAttempt,
      subjectTaskId: input.subjectTaskId,
      verdict: input.verdict,
      findings: [...input.findings]
        .map((finding) => ({ findingId: finding.findingId, fingerprint: finding.fingerprint }))
        .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
      reviewer: input.reviewer,
      modelBindingKey: input.modelBindingKey,
      resolvedModelKey: input.resolvedModelKey,
      evidenceRefs: [...input.evidenceRefs].sort(),
      contentDigest: input.contentDigest,
    }),
  );

/* -------------------------------------------------------------------------- validation */

const hasControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f) return true;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
};

/**
 * The report is not a path container: reuse the T17 grammar — repo-relative only, so a review
 * report can never become a workspace path-policy bypass.
 */
export const isReviewLocatorPath = (value: string): boolean => {
  if (value.length === 0 || value.length > REVIEW_FINDINGS_LIMITS.maxLocatorPathChars) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.startsWith('\\\\')) return false;
  if (value.startsWith('~')) return false;
  return value.split(/[\\/]/).every((segment) => segment !== '..');
};

/** Shape-only check of the existing durable reference grammar (no store access here). */
export const isReviewEvidenceRefShape = (value: string): boolean =>
  /^artifact:art_[0-9A-HJKMNP-TV-Z]{10,40}$/.test(value) ||
  /^art_[0-9A-HJKMNP-TV-Z]{10,40}$/.test(value) ||
  /^val_[0-9A-Za-z]{10,40}$/.test(value);

/** A caller-supplied finding, validated. Identity and fingerprint are derived by the sink. */
export type DraftReviewFinding = Omit<ReviewFinding, 'findingId' | 'fingerprint'>;

export function validateReviewFinding(
  input: unknown,
  context: { readonly runId: string; readonly reviewTaskId: string; readonly index: number },
): Result<DraftReviewFinding, DomainError> {
  const finding = input as Record<string, unknown> | null;
  if (typeof finding !== 'object' || finding === null || Array.isArray(finding)) {
    return err(domainError('INVALID_ARGUMENT', `Finding ${context.index} is not an object.`, { reason: 'REVIEW_FINDING_INVALID', index: context.index }));
  }
  const code = typeof finding['code'] === 'string' ? finding['code'].trim() : '';
  if (code === '' || code.length > REVIEW_FINDINGS_LIMITS.maxCodeChars) {
    return err(
      domainError('INVALID_ARGUMENT', `Finding ${context.index} needs a non-empty code of at most ${REVIEW_FINDINGS_LIMITS.maxCodeChars} characters.`, {
        reason: 'REVIEW_FINDING_CODE_INVALID',
        index: context.index,
      }),
    );
  }
  const summary = typeof finding['summary'] === 'string' ? finding['summary'].trim() : '';
  if (summary === '' || summary.length > REVIEW_FINDINGS_LIMITS.maxSummaryChars || hasControlCharacters(summary)) {
    return err(
      domainError('INVALID_ARGUMENT', `Finding ${context.index} needs a plain-text summary within ${REVIEW_FINDINGS_LIMITS.maxSummaryChars} characters.`, {
        reason: 'REVIEW_FINDING_SUMMARY_INVALID',
        index: context.index,
      }),
    );
  }
  const detail = typeof finding['detail'] === 'string' ? finding['detail'].trim() : '';
  if (detail.length > REVIEW_FINDINGS_LIMITS.maxDetailChars || hasControlCharacters(detail)) {
    return err(
      domainError('INVALID_ARGUMENT', `Finding ${context.index} detail is limited to ${REVIEW_FINDINGS_LIMITS.maxDetailChars} plain-text characters.`, {
        reason: 'REVIEW_FINDING_DETAIL_INVALID',
        index: context.index,
      }),
    );
  }
  if (typeof finding['blocking'] !== 'boolean') {
    return err(domainError('INVALID_ARGUMENT', `Finding ${context.index} must declare a boolean blocking flag.`, { reason: 'REVIEW_FINDING_BLOCKING_INVALID', index: context.index }));
  }

  const subject = typeof finding['subject'] === 'string' && finding['subject'].trim() !== '' ? finding['subject'].trim() : null;
  if (subject !== null && subject.length > REVIEW_FINDINGS_LIMITS.maxSubjectChars) {
    return err(
      domainError('INVALID_ARGUMENT', `Finding ${context.index} subject is limited to ${REVIEW_FINDINGS_LIMITS.maxSubjectChars} characters.`, {
        reason: 'REVIEW_FINDING_SUBJECT_INVALID',
        index: context.index,
      }),
    );
  }

  let locator: ReviewFindingLocator | null = null;
  const rawLocator = finding['locator'];
  if (rawLocator !== undefined && rawLocator !== null) {
    const candidate = rawLocator as Record<string, unknown>;
    const path = typeof candidate['path'] === 'string' ? candidate['path'] : '';
    if (!isReviewLocatorPath(path)) {
      return err(
        domainError('INVALID_ARGUMENT', `Finding ${context.index} locator must be a repo-relative path (no absolute, drive, UNC or "..").`, {
          reason: 'REVIEW_FINDING_LOCATOR_INVALID',
          index: context.index,
        }),
      );
    }
    const symbol = typeof candidate['symbol'] === 'string' ? candidate['symbol'] : undefined;
    if (symbol !== undefined && symbol.length > REVIEW_FINDINGS_LIMITS.maxSubjectChars) {
      return err(domainError('INVALID_ARGUMENT', `Finding ${context.index} locator symbol is too long.`, { reason: 'REVIEW_FINDING_LOCATOR_INVALID', index: context.index }));
    }
    locator = {
      path,
      ...(typeof candidate['line'] === 'number' ? { line: candidate['line'] } : {}),
      ...(typeof candidate['endLine'] === 'number' ? { endLine: candidate['endLine'] } : {}),
      ...(symbol === undefined ? {} : { symbol }),
    };
  }

  const rawRefs = finding['evidenceRefs'];
  const refs: string[] = [];
  if (rawRefs !== undefined && rawRefs !== null) {
    if (!Array.isArray(rawRefs) || rawRefs.length > REVIEW_FINDINGS_LIMITS.maxEvidenceRefsPerFinding) {
      return err(
        domainError('INVALID_ARGUMENT', `Finding ${context.index} may carry at most ${REVIEW_FINDINGS_LIMITS.maxEvidenceRefsPerFinding} evidence refs.`, {
          reason: 'REVIEW_FINDING_EVIDENCE_INVALID',
          index: context.index,
        }),
      );
    }
    for (const ref of rawRefs) {
      if (typeof ref !== 'string' || !isReviewEvidenceRefShape(ref)) {
        return err(
          domainError('INVALID_ARGUMENT', `Finding ${context.index} carries an evidence ref that is not a legal durable reference.`, {
            reason: 'REVIEW_FINDING_EVIDENCE_INVALID',
            index: context.index,
          }),
        );
      }
      refs.push(ref);
    }
  }

  return ok({ code, summary, detail, blocking: finding['blocking'] as boolean, subject, locator, evidenceRefs: refs });
}

/** Validate the whole report envelope (verdict/finding rules included). */
export function validateReviewReport(input: {
  readonly verdict: unknown;
  readonly findings: unknown;
}): Result<{ readonly verdict: ReviewVerdict }, DomainError> {
  if (typeof input.verdict !== 'string' || !(REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) {
    return err(
      domainError('INVALID_ARGUMENT', `Unknown review verdict "${String(input.verdict)}".`, {
        reason: 'REVIEW_VERDICT_INVALID',
        verdict: String(input.verdict),
      }),
    );
  }
  const verdict = input.verdict as ReviewVerdict;
  const findings = Array.isArray(input.findings) ? input.findings : null;
  if (findings === null) {
    return err(domainError('INVALID_ARGUMENT', 'A review report needs a findings array.', { reason: 'REVIEW_FINDINGS_INVALID' }));
  }
  if (findings.length > REVIEW_FINDINGS_LIMITS.maxFindings) {
    return err(
      domainError('INVALID_ARGUMENT', `A review report may carry at most ${REVIEW_FINDINGS_LIMITS.maxFindings} findings.`, {
        reason: 'REVIEW_FINDINGS_TOO_MANY',
      }),
    );
  }
  const blockingCount = findings.filter((finding) => (finding as { blocking?: unknown }).blocking === true).length;
  if (verdict === 'PASS' && blockingCount > 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'A PASS review report may not carry a blocking finding.', {
        reason: 'REVIEW_VERDICT_FINDINGS_CONFLICT',
      }),
    );
  }
  if (verdict === 'CHANGES_REQUESTED' && findings.length === 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'A CHANGES_REQUESTED review report must carry at least one finding.', {
        reason: 'REVIEW_VERDICT_FINDINGS_CONFLICT',
      }),
    );
  }
  if (verdict === 'BLOCKED' && blockingCount === 0) {
    return err(
      domainError('INVALID_ARGUMENT', 'A BLOCKED review report must carry a blocking blocker finding.', {
        reason: 'REVIEW_VERDICT_FINDINGS_CONFLICT',
      }),
    );
  }
  return ok({ verdict });
}

/* ----------------------------------------------------------------------------- encoding */

export function encodeReviewReport(payload: ReviewReportPayload): Uint8Array {
  return new TextEncoder().encode(canonicalJson(payload));
}

/** Decode durable report bytes back into a validated payload (tamper/foreign content fails). */
export function decodeReviewReport(
  bytes: Uint8Array,
  expected: { readonly runId: string; readonly companyId: string },
): Result<ReviewReportPayload, DomainError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return err(domainError('VALIDATION_FAILED', 'The durable review report is not valid JSON.', { reason: 'REVIEW_REPORT_ARTIFACT_CORRUPT' }));
  }
  const record = parsed as Record<string, unknown> | null;
  if (typeof record !== 'object' || record === null) {
    return err(domainError('VALIDATION_FAILED', 'The durable review report is not an envelope.', { reason: 'REVIEW_REPORT_ARTIFACT_CORRUPT' }));
  }
  if (record['schemaVersion'] !== REVIEW_FINDINGS_SCHEMA) {
    return err(
      domainError('VALIDATION_FAILED', `Unsupported review report schema "${String(record['schemaVersion'])}".`, {
        reason: 'REVIEW_REPORT_SCHEMA_UNSUPPORTED',
      }),
    );
  }
  if (record['runId'] !== expected.runId || record['companyId'] !== expected.companyId) {
    return err(
      domainError('VALIDATION_FAILED', 'The durable review report is not bound to this run and company.', {
        reason: 'REVIEW_REPORT_PROVENANCE_MISMATCH',
      }),
    );
  }
  const shape = validateReviewReport({ verdict: record['verdict'], findings: record['findings'] });
  if (!shape.ok) return shape;
  return ok(record as unknown as ReviewReportPayload);
}
