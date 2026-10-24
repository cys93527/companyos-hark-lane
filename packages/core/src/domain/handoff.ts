/**
 * Structured Handoff (Sprint 11) — the CONTRACT.
 *
 * A handoff is "a structured work-transfer packet one execution role submits to another".
 * It is NOT chat history, NOT memory, NOT an artifact, NOT a workflow transition and NOT the
 * agent runtime: it carries a bounded summary plus explicit REFERENCES (artifact/decision/
 * validation/execution), never a copy of the previous context.
 *
 * Everything here is pure and deterministic: no clock, no randomness, no LLM summarisation.
 */
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';

/* ------------------------------------------------------------------ lifecycle --- */

/** The handoff state machine is INDEPENDENT of L1/L2/L3, execution and invocation machines. */
export const HANDOFF_STATES = [
  'DRAFT',
  'READY',
  'ACCEPTED',
  'REJECTED',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

export const HANDOFF_TRANSITIONS: Readonly<Record<HandoffState, readonly HandoffState[]>> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['ACCEPTED', 'REJECTED', 'CANCELLED', 'SUPERSEDED'],
  ACCEPTED: ['SUPERSEDED'],
  REJECTED: ['SUPERSEDED'],
  SUPERSEDED: [],
  CANCELLED: [],
};

export const canTransitionHandoff = (from: HandoffState, to: HandoffState): boolean =>
  (HANDOFF_TRANSITIONS[from] ?? []).includes(to);

/** An illegal handoff transition is a CONFLICT, never a silent no-op. */
export function applyHandoffTransition(from: HandoffState, to: HandoffState): Result<HandoffState, DomainError> {
  if (!canTransitionHandoff(from, to)) {
    return err(
      domainError('CONFLICT', `Handoff cannot move from ${from} to ${to}.`, {
        from,
        to,
        allowed: HANDOFF_TRANSITIONS[from] ?? [],
      }),
    );
  }
  return ok(to);
}

/* ---------------------------------------------------------------- rejection --- */

export const HANDOFF_REJECTION_REASONS = [
  'MISSING_ARTIFACT',
  'MISSING_VALIDATION',
  'INCOMPLETE_SUMMARY',
  'ACCEPTANCE_NOT_MET',
  'KNOWN_RISK_TOO_HIGH',
  'CONTEXT_INSUFFICIENT',
  'WRONG_TARGET_ROLE',
  'OTHER',
] as const;
export type HandoffRejectionReason = (typeof HANDOFF_REJECTION_REASONS)[number];

/* --------------------------------------------------------------------- refs --- */

export const HANDOFF_REF_KINDS = ['artifact', 'decision', 'validation', 'execution'] as const;
export type HandoffRefKind = (typeof HANDOFF_REF_KINDS)[number];

export interface HandoffRef {
  readonly kind: HandoffRefKind;
  /** An opaque identifier only - never a path, a body or a serialized object. */
  readonly refId: string;
}

const REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Refs are validated for FORMAT only in Sprint 11 (the artifact/decision systems land later). */
export function validateHandoffRefs(refs: readonly HandoffRef[]): Result<true, DomainError> {
  for (const ref of refs) {
    if (!HANDOFF_REF_KINDS.includes(ref.kind)) {
      return err(domainError('VALIDATION_FAILED', `Unknown handoff ref kind "${String(ref.kind)}".`, { ref }));
    }
    if (!REF_ID_PATTERN.test(ref.refId)) {
      return err(
        domainError('VALIDATION_FAILED', 'A handoff ref id must be an opaque identifier, not a path or payload.', {
          kind: ref.kind,
        }),
      );
    }
  }
  return ok(true);
}

/* ------------------------------------------------------------------- packet --- */

export interface HandoffModelBinding {
  readonly modelKey: string;
  readonly providerId: string;
}

export interface HandoffPacket {
  readonly handoffId: string;
  /** Handoff versions are explicit: a rejected version is never edited, a new one supersedes it. */
  readonly handoffVersion: number;
  readonly companyId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly taskId: string;
  readonly fromAgentId: string;
  readonly fromRoleId: string;
  readonly toRoleId: string;
  readonly toAgentId: string | null;
  readonly objective: string;
  readonly status: HandoffState;
  readonly summary: string;
  readonly completedWork: readonly string[];
  readonly remainingWork: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly artifactRefs: readonly HandoffRef[];
  readonly decisionRefs: readonly HandoffRef[];
  readonly validationRefs: readonly HandoffRef[];
  readonly knownRisks: readonly string[];
  readonly openQuestions: readonly string[];
  readonly recommendedNextAction: string;
  readonly modelBinding: HandoffModelBinding | null;
  /** Reference to the producing AgentExecution (an id, never the execution history). */
  readonly executionRef: string | null;
  /** The version this one replaces, if any (rework / correction chain). */
  readonly supersedes: string | null;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReasons: readonly HandoffRejectionReason[];
  readonly rejectionComment: string | null;
  readonly traceId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateHandoffInput {
  readonly handoffId: string;
  readonly companyId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly taskId: string;
  readonly fromAgentId: string;
  readonly fromRoleId: string;
  /** MUST be supplied by the workflow/task/application layer - the runtime never decides this. */
  readonly toRoleId: string;
  readonly toAgentId?: string | null;
  readonly objective: string;
  readonly summary: string;
  readonly recommendedNextAction: string;
  readonly completedWork?: readonly string[];
  readonly remainingWork?: readonly string[];
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly artifactRefs?: readonly HandoffRef[];
  readonly decisionRefs?: readonly HandoffRef[];
  readonly validationRefs?: readonly HandoffRef[];
  readonly knownRisks?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly modelBinding?: HandoffModelBinding | null;
  readonly executionRef?: string | null;
  readonly supersedes?: string | null;
  readonly traceId: string;
  readonly createdAt: string;
}

/** Fields that must be non-empty before a handoff may become READY (§六). */
export const HANDOFF_REQUIRED_AT_READY = ['handoffId', 'taskId', 'fromRoleId', 'toRoleId', 'objective', 'summary', 'recommendedNextAction'] as const;

/** Secret-shaped content is refused: a handoff must never carry credentials. */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /Bearer\s+[A-Za-z0-9._-]{16,}/i,
  /-----BEGIN [A-Z ]+-----/,
  /api[_-]?key\s*[:=]\s*\S{8,}/i,
] as const;

/** Validate a packet for unsafe content (secrets) and unbounded bodies. */
export function assertHandoffSafety(packet: HandoffPacket): Result<true, DomainError> {
  const texts = [
    packet.summary,
    packet.objective,
    packet.recommendedNextAction,
    ...packet.completedWork,
    ...packet.remainingWork,
    ...packet.constraints,
    ...packet.acceptanceCriteria,
    ...packet.knownRisks,
    ...packet.openQuestions,
    packet.rejectionComment ?? '',
  ];
  for (const text of texts) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        return err(
          domainError('POLICY_DENIED', 'A handoff must not contain credentials or key material.', {
            reason: 'SECRET_IN_HANDOFF',
          }),
        );
      }
    }
    if (text.length > 4_000) {
      return err(
        domainError('LIMIT_EXCEEDED', 'A handoff field is too long: a handoff is a summary, not a dump.', {
          reason: 'HANDOFF_FIELD_TOO_LONG',
          length: text.length,
        }),
      );
    }
  }
  return ok(true);
}

const nonEmpty = (value: string): boolean => value.trim().length > 0;

/** Create a DRAFT packet. Identity fields and the bounded summary are validated here. */
export function createHandoffPacket(input: CreateHandoffInput): Result<HandoffPacket, DomainError> {
  for (const field of HANDOFF_REQUIRED_AT_READY) {
    const value = input[field];
    if (typeof value !== 'string' || !nonEmpty(value)) {
      return err(domainError('VALIDATION_FAILED', `Handoff field "${field}" is required.`, { field }));
    }
  }
  const packet: HandoffPacket = {
    handoffId: input.handoffId,
    handoffVersion: 1,
    companyId: input.companyId,
    workflowId: input.workflowId,
    workflowVersionId: input.workflowVersionId,
    workflowRunId: input.workflowRunId,
    stageId: input.stageId,
    taskId: input.taskId,
    fromAgentId: input.fromAgentId,
    fromRoleId: input.fromRoleId,
    toRoleId: input.toRoleId,
    toAgentId: input.toAgentId ?? null,
    objective: input.objective,
    status: 'DRAFT',
    summary: input.summary,
    completedWork: [...(input.completedWork ?? [])],
    remainingWork: [...(input.remainingWork ?? [])],
    constraints: [...(input.constraints ?? [])],
    acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
    artifactRefs: [...(input.artifactRefs ?? [])],
    decisionRefs: [...(input.decisionRefs ?? [])],
    validationRefs: [...(input.validationRefs ?? [])],
    knownRisks: [...(input.knownRisks ?? [])],
    openQuestions: [...(input.openQuestions ?? [])],
    recommendedNextAction: input.recommendedNextAction,
    modelBinding: input.modelBinding ?? null,
    executionRef: input.executionRef ?? null,
    supersedes: input.supersedes ?? null,
    acceptedBy: null,
    acceptedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReasons: [],
    rejectionComment: null,
    traceId: input.traceId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  const refs = validateHandoffRefs([...packet.artifactRefs, ...packet.decisionRefs, ...packet.validationRefs]);
  if (!refs.ok) return refs;
  const safe = assertHandoffSafety(packet);
  if (!safe.ok) return safe;
  return ok(packet);
}

/**
 * DRAFT -> READY. The required fields must be present AND, when the acceptance criteria demand a
 * deliverable, at least one artifact or validation reference must exist (§六).
 */
export function markHandoffReady(
  packet: HandoffPacket,
  options: { readonly now: string; readonly requiresEvidence?: boolean },
): Result<HandoffPacket, DomainError> {
  const transition = applyHandoffTransition(packet.status, 'READY');
  if (!transition.ok) return transition;
  for (const field of HANDOFF_REQUIRED_AT_READY) {
    if (!nonEmpty(packet[field])) {
      return err(domainError('VALIDATION_FAILED', `Handoff cannot be READY without "${field}".`, { field }));
    }
  }
  const needsEvidence = options.requiresEvidence ?? packet.acceptanceCriteria.length > 0;
  if (needsEvidence && packet.artifactRefs.length === 0 && packet.validationRefs.length === 0) {
    return err(
      domainError('VALIDATION_FAILED', 'Acceptance criteria demand evidence: an artifact or validation ref is required.', {
        reason: 'MISSING_EVIDENCE',
      }),
    );
  }
  return ok({ ...packet, status: 'READY', updatedAt: options.now });
}

/** READY -> ACCEPTED. Only an actor holding the TARGET role may accept. */
export function acceptHandoffPacket(
  packet: HandoffPacket,
  options: { readonly actorId: string; readonly actorRoleIds: readonly string[]; readonly now: string },
): Result<HandoffPacket, DomainError> {
  const transition = applyHandoffTransition(packet.status, 'ACCEPTED');
  if (!transition.ok) return transition;
  if (!options.actorRoleIds.includes(packet.toRoleId)) {
    return err(
      domainError('PERMISSION_DENIED', 'Only the target role may accept this handoff.', {
        reason: 'WRONG_TARGET_ROLE',
        toRoleId: packet.toRoleId,
        actorId: options.actorId,
      }),
    );
  }
  return ok({
    ...packet,
    status: 'ACCEPTED',
    acceptedBy: options.actorId,
    acceptedAt: options.now,
    updatedAt: options.now,
  });
}

/** READY -> REJECTED with structured reasons. A rejected version is frozen forever. */
export function rejectHandoffPacket(
  packet: HandoffPacket,
  options: {
    readonly actorId: string;
    readonly reasonCodes: readonly HandoffRejectionReason[];
    readonly comment?: string | null;
    readonly now: string;
  },
): Result<HandoffPacket, DomainError> {
  const transition = applyHandoffTransition(packet.status, 'REJECTED');
  if (!transition.ok) return transition;
  if (options.reasonCodes.length === 0) {
    return err(domainError('VALIDATION_FAILED', 'A rejection needs at least one structured reason code.', {}));
  }
  for (const reason of options.reasonCodes) {
    if (!HANDOFF_REJECTION_REASONS.includes(reason)) {
      return err(domainError('VALIDATION_FAILED', `Unknown rejection reason "${String(reason)}".`, { reason }));
    }
  }
  const rejected: HandoffPacket = {
    ...packet,
    status: 'REJECTED',
    rejectedBy: options.actorId,
    rejectedAt: options.now,
    rejectionReasons: [...options.reasonCodes],
    rejectionComment: options.comment ?? null,
    updatedAt: options.now,
  };
  const safe = assertHandoffSafety(rejected);
  if (!safe.ok) return safe;
  return ok(rejected);
}

/** DRAFT/READY -> CANCELLED. */
export function cancelHandoffPacket(packet: HandoffPacket, options: { readonly now: string }): Result<HandoffPacket, DomainError> {
  const transition = applyHandoffTransition(packet.status, 'CANCELLED');
  if (!transition.ok) return transition;
  return ok({ ...packet, status: 'CANCELLED', updatedAt: options.now });
}

/**
 * Supersede a previous version with a new one: the previous version is frozen as SUPERSEDED and the
 * new packet must reference it. History is never rewritten.
 */
export function supersedeHandoff(
  previous: HandoffPacket,
  next: HandoffPacket,
): Result<{ readonly previous: HandoffPacket; readonly next: HandoffPacket }, DomainError> {
  const transition = applyHandoffTransition(previous.status, 'SUPERSEDED');
  if (!transition.ok) return transition;
  if (previous.handoffId !== next.handoffId) {
    return err(domainError('CONFLICT', 'A superseding handoff must share the same handoffId.', {}));
  }
  if (next.handoffVersion <= previous.handoffVersion) {
    return err(domainError('CONFLICT', 'A superseding handoff must have a higher version.', {}));
  }
  return ok({
    previous: { ...previous, status: 'SUPERSEDED', updatedAt: next.createdAt },
    next: { ...next, supersedes: `${previous.handoffId}@v${String(previous.handoffVersion)}` },
  });
}

/* ---------------------------------------------------------------- projection --- */

/**
 * The ONLY handoff shape the agent runtime may consume. It is deliberately bounded: no audit
 * internals, no secrets, no DB rows, no execution history, no chat transcripts.
 */
export interface HandoffContextView {
  readonly handoffId: string;
  readonly version: number;
  readonly fromRoleId: string;
  readonly toRoleId: string;
  readonly objective: string;
  readonly summary: string;
  readonly completedWork: readonly string[];
  readonly remainingWork: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly artifactRefs: readonly HandoffRef[];
  readonly decisionRefs: readonly HandoffRef[];
  readonly validationRefs: readonly HandoffRef[];
  readonly knownRisks: readonly string[];
  readonly openQuestions: readonly string[];
  readonly recommendedNextAction: string;
}

/** Deterministic projection: same packet -> same view (no clock, no random, no LLM). */
export function handoffToAgentContextView(packet: HandoffPacket): HandoffContextView {
  return {
    handoffId: packet.handoffId,
    version: packet.handoffVersion,
    fromRoleId: packet.fromRoleId,
    toRoleId: packet.toRoleId,
    objective: packet.objective,
    summary: packet.summary,
    completedWork: [...packet.completedWork],
    remainingWork: [...packet.remainingWork],
    constraints: [...packet.constraints],
    acceptanceCriteria: [...packet.acceptanceCriteria],
    artifactRefs: packet.artifactRefs.map((ref) => ({ ...ref })),
    decisionRefs: packet.decisionRefs.map((ref) => ({ ...ref })),
    validationRefs: packet.validationRefs.map((ref) => ({ ...ref })),
    knownRisks: [...packet.knownRisks],
    openQuestions: [...packet.openQuestions],
    recommendedNextAction: packet.recommendedNextAction,
  };
}

/** The runtime may only consume an ACCEPTED handoff (a READY one is still someone else's draft). */
export function handoffContextViewIfAccepted(packet: HandoffPacket): HandoffContextView | null {
  return packet.status === 'ACCEPTED' ? handoffToAgentContextView(packet) : null;
}

/**
 * Deterministic, bounded TEXT rendering of the view - the only way a structured handoff may enter
 * the agent context (Sprint 11 §五). Section order is fixed, so the same packet always renders the
 * same text; nothing else (audit internals, secrets, execution history) is added.
 */
export function serializeHandoffContextView(view: HandoffContextView): string {
  const lines: string[] = [
    '# Previous handoff',
    `handoff: ${view.handoffId} v${String(view.version)}`,
    `from: ${view.fromRoleId} -> to: ${view.toRoleId}`,
    `objective: ${view.objective}`,
    `summary: ${view.summary}`,
  ];
  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push(`${title}:`);
    for (const item of items) lines.push(`- ${item}`);
  };
  section('completed work', view.completedWork);
  section('remaining work', view.remainingWork);
  section('constraints', view.constraints);
  section('acceptance criteria', view.acceptanceCriteria);
  section('known risks', view.knownRisks);
  section('open questions', view.openQuestions);
  const refs = (title: string, items: readonly HandoffRef[]): void => {
    if (items.length === 0) return;
    lines.push(`${title}: ${items.map((ref) => `${ref.kind}:${ref.refId}`).join(', ')}`);
  };
  refs('artifacts', view.artifactRefs);
  refs('decisions', view.decisionRefs);
  refs('validations', view.validationRefs);
  lines.push(`next action: ${view.recommendedNextAction}`);
  return lines.join('\n');
}

/** The exact text the runtime may put into `AgentContext.previousHandoff`, or null. */
export function previousHandoffTextOf(packet: HandoffPacket): string | null {
  const view = handoffContextViewIfAccepted(packet);
  return view === null ? null : serializeHandoffContextView(view);
}

/** Bounded UI view model (Sprint 11 defines it; the desktop UI lands later). */
export interface HandoffCardViewModel {
  readonly handoffId: string;
  readonly version: number;
  readonly fromRoleId: string;
  readonly toRoleId: string;
  readonly status: HandoffState;
  readonly summary: string;
  readonly artifactCount: number;
  readonly validationCount: number;
  readonly riskCount: number;
  readonly recommendedNextAction: string;
  readonly actions: readonly ('ACCEPT' | 'REJECT' | 'VIEW_ARTIFACTS')[];
}

export function handoffCardOf(packet: HandoffPacket): HandoffCardViewModel {
  const actions: HandoffCardViewModel['actions'] =
    packet.status === 'READY' ? ['ACCEPT', 'REJECT', 'VIEW_ARTIFACTS'] : ['VIEW_ARTIFACTS'];
  return {
    handoffId: packet.handoffId,
    version: packet.handoffVersion,
    fromRoleId: packet.fromRoleId,
    toRoleId: packet.toRoleId,
    status: packet.status,
    summary: packet.summary,
    artifactCount: packet.artifactRefs.length,
    validationCount: packet.validationRefs.length,
    riskCount: packet.knownRisks.length,
    recommendedNextAction: packet.recommendedNextAction,
    actions,
  };
}
