/**
 * LIVE-CONTRACT-FILL run 17 (hark-live-goal 42730130436): a corrective task (reason
 * VALIDATION_FAILED) reached the coding kernel with only the cited ids in its inputs
 * (`causeEvidenceRefs: ["val_…", "art_…"]`). The validators' durable reports (the
 * repo.test-check verdict with its timeout and output tail, the evidence.grounding-check
 * list of unsupported claims) were never shown, so three corrective rounds searched the
 * workspace for the validation id, re-did unrelated work and the goal hit the corrective
 * cap with every test passing but the test contract still over its deadline.
 *
 * This module resolves the cited FAILING validations to their validator reports (durable
 * truth: validation row → its report artifact → CAS bytes) and renders a bounded, plain
 * explanation the executor can act on. Transport/context only: it never changes the
 * verdict, the cause, the corrective lineage or any authority.
 */

export interface CorrectiveCauseValidation {
  readonly validatorId: string;
  readonly status: string;
  readonly evidenceRefs: readonly string[];
}

export interface CorrectiveCauseArtifact {
  readonly kind: string;
  readonly contentRef: string;
}

export interface CorrectiveCauseReader {
  readonly validation: (validationId: string) => Promise<CorrectiveCauseValidation | null>;
  readonly artifact: (artifactId: string) => Promise<CorrectiveCauseArtifact | null>;
  readonly content: (contentRef: string) => Promise<Uint8Array | null>;
}

export const CORRECTIVE_CAUSE_LIMITS = {
  /** Cited validations resolved per task. */
  maxValidations: 6,
  /** Report bytes read per validation. */
  maxReportBytes: 64 * 1024,
  /** Characters of a test contract's output tail shown per validation. */
  maxOutputTailChars: 1_800,
  /** Unsupported grounding claims listed per validation. */
  maxClaims: 12,
  /** Characters of the whole rendered block. */
  maxTotalChars: 6_000,
} as const;

/** Report kinds this module knows how to explain (others render their reasons only). */
const REPORT_KIND_SUFFIX = '-report';

export const CORRECTIVE_CAUSE_HEADER =
  'Why this step is being redone: CompanyOS validators rejected the previous result. Fix exactly these problems ' +
  '(the ids in Task inputs are internal references, do not search the workspace for them):';

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);
const tailOf = (text: string, max: number): string => (text.length <= max ? text : `…${text.slice(text.length - max)}`);

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];

/** The cited validation ids of a corrective task's inputs (canonical T18-05 lineage). */
export const correctiveValidationIdsOf = (taskInputs: Readonly<Record<string, unknown>> | null | undefined): string[] => {
  const raw = taskInputs?.['corrective'];
  if (typeof raw !== 'object' || raw === null) return [];
  const refs = stringsOf((raw as Record<string, unknown>)['causeEvidenceRefs']);
  return [...new Set(refs.map((ref) => (ref.startsWith('validation:') ? ref.slice('validation:'.length) : ref)).filter((ref) => ref.startsWith('val_')))]
    .slice(0, CORRECTIVE_CAUSE_LIMITS.maxValidations);
};

const parseReport = (bytes: Uint8Array | null): Record<string, unknown> | null => {
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > CORRECTIVE_CAUSE_LIMITS.maxReportBytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** One validator report rendered as plain lines. */
export const renderValidatorReport = (validatorId: string, report: Record<string, unknown> | null): string[] => {
  const lines: string[] = [];
  if (report === null) {
    lines.push(`- ${validatorId} failed (its report could not be read).`);
    return lines;
  }
  const reasons = stringsOf(report['reasons']);
  const command = typeof report['command'] === 'string' ? report['command'] : null;
  const timedOut = report['timedOut'] === true;
  const exitCode = typeof report['exitCode'] === 'number' ? report['exitCode'] : null;
  const head: string[] = [`- ${validatorId} failed`];
  if (command !== null && command !== '') head.push(`running \`${cut(command, 300)}\` in a fresh copy of the workspace`);
  if (timedOut) head.push('the test command did not finish before the validator deadline, so it was stopped (all tests must finish well inside it: make slow tests fast, reuse one expensive setup instead of repeating it, and never wait on a program that can hang)');
  else if (exitCode !== null) head.push(`exit code ${String(exitCode)}`);
  lines.push(`${head.join('; ')}.`);
  for (const reason of reasons.slice(0, 4)) lines.push(`  reason: ${cut(reason, 400)}`);
  const claims = stringsOf(report['unsupported']);
  if (claims.length > 0) {
    lines.push('  unsupported claims in your final answer (name only files that exist in the workspace, or remove the claim):');
    for (const claim of claims.slice(0, CORRECTIVE_CAUSE_LIMITS.maxClaims)) lines.push(`  - ${cut(claim, 300)}`);
    if (claims.length > CORRECTIVE_CAUSE_LIMITS.maxClaims) lines.push(`  - … ${String(claims.length - CORRECTIVE_CAUSE_LIMITS.maxClaims)} more`);
  }
  const outputTail = typeof report['outputTail'] === 'string' ? report['outputTail'].trim() : '';
  if (outputTail !== '') {
    lines.push('  last output of the test command:');
    lines.push(tailOf(outputTail, CORRECTIVE_CAUSE_LIMITS.maxOutputTailChars));
  }
  return lines;
};

/**
 * The bounded explanation block for a corrective task, or [] when the task is not a
 * validation corrective or none of its cited validations failed. Never throws: an
 * unreadable store degrades to "report could not be read" for that validator.
 */
export const correctiveCauseLinesOf = async (
  taskInputs: Readonly<Record<string, unknown>> | null | undefined,
  reader: CorrectiveCauseReader,
): Promise<string[]> => {
  const ids = correctiveValidationIdsOf(taskInputs);
  if (ids.length === 0) return [];
  const body: string[] = [];
  for (const id of ids) {
    let validation: CorrectiveCauseValidation | null = null;
    try { validation = await reader.validation(id); } catch { validation = null; }
    if (validation === null || validation.status === 'pass') continue;
    let report: Record<string, unknown> | null = null;
    for (const ref of validation.evidenceRefs) {
      if (!ref.startsWith('artifact:')) continue;
      try {
        const artifact = await reader.artifact(ref.slice('artifact:'.length));
        if (artifact === null || !artifact.kind.endsWith(REPORT_KIND_SUFFIX)) continue;
        report = parseReport(await reader.content(artifact.contentRef));
        if (report !== null) break;
      } catch {
        // an unreadable report degrades to the plain line below
      }
    }
    body.push(...renderValidatorReport(validation.validatorId, report));
  }
  if (body.length === 0) return [];
  const lines = [CORRECTIVE_CAUSE_HEADER];
  let total = CORRECTIVE_CAUSE_HEADER.length;
  for (const line of body) {
    if (total + line.length > CORRECTIVE_CAUSE_LIMITS.maxTotalChars) {
      lines.push('… (further validator detail omitted)');
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines;
};
