/**
 * STAGE 8 PART A — ROLE COLLABORATION V1 (Boss Stage 8 §A).
 *
 * CompanyOS-native durable-object collaboration. Roles NEVER chat peer-to-peer:
 * professional work crosses between roles through the canonical durable objects
 * (Task, Artifact, Evidence, Decision, ExecutionAttempt) via the Professional
 * Handoff Contract defined here.
 *
 * Frozen properties (Boss Stage 8 §A):
 *   1. Collaboration state is NOT a second truth. There is no role_messages /
 *      agent_chat_truth / team_task_store / agent_team_scheduler /
 *      peer_workflow_state in this module — handoffs are durable objects and
 *      every collaboration view is DERIVED from canonical Task/Attempt state.
 *   2. A handoff carries refs and professional summaries — NEVER raw
 *      chain-of-thought, never a full private transcript, never hidden reasoning.
 *   3. Collaboration failures are LOUD (closed reason set below) — there is no
 *      silent fallback to "just run it anyway".
 *   4. The PM coordinates by producing handoffs; it is NOT a scheduler and owns
 *      no scheduling truth. Status is always derived from canonical Task state.
 *   5. Reviewer independence is mechanical: a separate RoleInstance, a separate
 *      ExecutionAttempt and a context envelope that structurally excludes the
 *      producer's raw transcript.
 */
import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';
import {
  buildRoleContextEnvelope,
  computeEffectiveExecutionPolicy,
  type RoleContextEnvelope,
  type RoleInstance,
} from './role-orchestration.js';

// ---------------------------------------------------------------------------
// Canonical state vocabulary (mirrors the Task lifecycle states Stage 7 derives from)
// ---------------------------------------------------------------------------

export type CanonicalTaskState = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

/** A durable object a handoff may reference (Artifact / Evidence / Decision). */
export interface DurableObjectRef {
  readonly kind: 'artifact' | 'evidence' | 'decision';
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Professional Handoff Contract (Boss Stage 8 §A)
// ---------------------------------------------------------------------------

/**
 * The ONE way professional work crosses between role instances.
 *
 * The field set is CLOSED: there is deliberately no channel property, no
 * message body and no transcript property, so raw reasoning cannot be smuggled
 * through the contract itself. Everything carried is a reference or a
 * professional summary.
 */
export interface ProfessionalHandoff {
  readonly handoffId: string;
  readonly producerRoleInstanceId: string;
  readonly consumerRoleInstanceId: string;
  readonly sourceTaskId: string;
  readonly targetTaskId: string;
  /** Durable Artifact ids the consumer must read (refs, never content). */
  readonly artifactRefs: readonly string[];
  /** Durable Evidence ids supporting the handoff. */
  readonly evidenceRefs: readonly string[];
  /** Durable Decision ids the consumer must respect. */
  readonly decisionRefs: readonly string[];
  /** Acceptance criteria the consumer's output must satisfy. */
  readonly acceptanceCriteria: readonly string[];
  /** Known risks the producer is transferring with the work. */
  readonly knownRisks: readonly string[];
  /** Open questions the consumer must resolve or escalate. */
  readonly remainingQuestions: readonly string[];
  /** Why this handoff exists (professional rationale, not chatter). */
  readonly handoffReason: string;
}

/**
 * Fields a handoff must NEVER carry (Boss Stage 8 §A: 禁止传 raw chain-of-thought,
 * 完整私有 transcript, 隐藏 reasoning). Exported so tests and architecture guards
 * can mechanically assert the exclusion.
 */
export const FORBIDDEN_HANDOFF_FIELDS = [
  'chainOfThought',
  'rawTranscript',
  'hiddenReasoning',
  'reasoningTrace',
  'peerMessage',
  'chatTranscript',
  'privateTranscript',
] as const;

/**
 * The closed failure-reason set for role collaboration (fail loud, no silent
 * fallback — Boss Stage 8 §A).
 */
export const COLLABORATION_ERROR_REASONS = [
  'HANDOFF_INPUT_MISSING',
  'HANDOFF_ARTIFACT_INVALID',
  'HANDOFF_AUTHORITY_MISMATCH',
  'HANDOFF_CONTEXT_BUILD_FAILED',
  'REVIEW_INDEPENDENCE_VIOLATION',
  'COLLABORATION_DEPENDENCY_BLOCKED',
] as const;

export type CollaborationErrorReason = (typeof COLLABORATION_ERROR_REASONS)[number];

/**
 * Second-truth names that must never exist for collaboration (Boss Stage 8 §A:
 * no role_messages / agent_chat_truth / team_task_store / agent_team_scheduler /
 * peer_workflow_state). Exported for the negative-claim tests and the
 * architecture guard.
 */
export const FORBIDDEN_COLLABORATION_TRUTH = [
  'role_messages',
  'agent_chat_truth',
  'agent_chat',
  'team_task_store',
  'agent_team_scheduler',
  'peer_workflow_state',
  'peer_message_truth',
] as const;

const collaborationError = (reason: CollaborationErrorReason, message: string): DomainError =>
  domainError('VALIDATION_FAILED', message, { reason });

const requireText = (value: string | undefined, field: string): string | null =>
  value === undefined || value.trim() === '' ? field : null;

// ---------------------------------------------------------------------------
// Handoff builder (Boss Stage 8 §A)
// ---------------------------------------------------------------------------

/**
 * Build a Professional Handoff from durable references.
 *
 * Validation order is the contract; the first failure wins and fails LOUD:
 *   1. required fields present, producer ≠ consumer, source task ≠ target task
 *   2. every artifact/evidence/decision ref resolves to a registered durable object
 *   3. the source task is DONE — there must be finished work to hand off
 */
export const buildProfessionalHandoff = (input: {
  readonly handoffId: string;
  readonly producerRoleInstanceId: string;
  readonly consumerRoleInstanceId: string;
  readonly sourceTaskId: string;
  readonly targetTaskId: string;
  readonly artifactRefs: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly decisionRefs?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly knownRisks?: readonly string[];
  readonly remainingQuestions?: readonly string[];
  readonly handoffReason: string;
  /** The durable objects registered for this run (Artifact/Evidence/Decision). */
  readonly durableObjects: readonly DurableObjectRef[];
  /** Canonical state of the source task (handoff needs finished work). */
  readonly sourceTaskState: CanonicalTaskState;
}): Result<ProfessionalHandoff, DomainError> => {
  for (const [value, field] of [
    [input.handoffId, 'handoffId'],
    [input.producerRoleInstanceId, 'producerRoleInstanceId'],
    [input.consumerRoleInstanceId, 'consumerRoleInstanceId'],
    [input.sourceTaskId, 'sourceTaskId'],
    [input.targetTaskId, 'targetTaskId'],
    [input.handoffReason, 'handoffReason'],
  ] as const) {
    const missing = requireText(value, field);
    if (missing !== null) {
      return err(collaborationError('HANDOFF_INPUT_MISSING', `Professional handoff requires "${missing}".`));
    }
  }
  if (input.producerRoleInstanceId === input.consumerRoleInstanceId) {
    return err(
      collaborationError(
        'HANDOFF_INPUT_MISSING',
        'A handoff cannot have the same producer and consumer role instance — professional transfer requires two roles.',
      ),
    );
  }
  if (input.sourceTaskId === input.targetTaskId) {
    return err(
      collaborationError('HANDOFF_INPUT_MISSING', 'A handoff cannot point a task at itself — sourceTaskId must differ from targetTaskId.'),
    );
  }

  const artifactRefs = [...input.artifactRefs];
  if (artifactRefs.length === 0) {
    return err(
      collaborationError('HANDOFF_ARTIFACT_INVALID', 'A professional handoff must reference at least one durable Artifact.'),
    );
  }

  // Every reference must resolve to a REGISTERED durable object of the right kind.
  const registered = new Map<string, DurableObjectRef>(input.durableObjects.map((o) => [`${o.kind}:${o.id}`, o]));
  const unresolved: string[] = [];
  for (const id of artifactRefs) {
    if (!registered.has(`artifact:${id}`)) unresolved.push(`artifact:${id}`);
  }
  for (const id of input.evidenceRefs ?? []) {
    if (!registered.has(`evidence:${id}`)) unresolved.push(`evidence:${id}`);
  }
  for (const id of input.decisionRefs ?? []) {
    if (!registered.has(`decision:${id}`)) unresolved.push(`decision:${id}`);
  }
  if (unresolved.length > 0) {
    return err(
      collaborationError(
        'HANDOFF_ARTIFACT_INVALID',
        `Handoff references unresolved durable objects: ${unresolved.join(', ')}. Collaboration never fabricates artifacts.`,
      ),
    );
  }

  if (input.sourceTaskState !== 'done') {
    return err(
      collaborationError(
        'COLLABORATION_DEPENDENCY_BLOCKED',
        `Handoff requires the source task to be done (found "${input.sourceTaskState}") — a dependency is still blocked.`,
      ),
    );
  }

  const handoff: ProfessionalHandoff = {
    handoffId: input.handoffId,
    producerRoleInstanceId: input.producerRoleInstanceId,
    consumerRoleInstanceId: input.consumerRoleInstanceId,
    sourceTaskId: input.sourceTaskId,
    targetTaskId: input.targetTaskId,
    artifactRefs,
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    decisionRefs: [...(input.decisionRefs ?? [])],
    acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
    knownRisks: [...(input.knownRisks ?? [])],
    remainingQuestions: [...(input.remainingQuestions ?? [])],
    handoffReason: input.handoffReason,
  };
  // Structural exclusion: the closed field set above is the primary defense;
  // this assertion makes a smuggled raw-context field mechanically impossible.
  for (const forbidden of FORBIDDEN_HANDOFF_FIELDS) {
    if (Object.hasOwn(handoff as unknown as Record<string, unknown>, forbidden)) {
      return err(
        collaborationError(
          'HANDOFF_CONTEXT_BUILD_FAILED',
          `Handoff carries the forbidden raw-context field "${forbidden}".`,
        ),
      );
    }
  }
  return ok(handoff);
};

// ---------------------------------------------------------------------------
// Handoff acceptance → Role Context Envelope (Boss Stage 8 §A)
// ---------------------------------------------------------------------------

/** A durable Artifact as the consumer may see it: a professional summary + refs. */
export interface DurableArtifactView {
  readonly artifactId: string;
  /** Professional summary of the artifact — NOT its raw content stream. */
  readonly summary: string;
}

/**
 * Accept a handoff: build the consumer's bounded context envelope.
 *
 * Fails loud on: missing canonical task objective (HANDOFF_CONTEXT_BUILD_FAILED),
 * an artifact the consumer cannot read (HANDOFF_CONTEXT_BUILD_FAILED), an
 * effective authority that covers none of the consumer's professional needs
 * (HANDOFF_AUTHORITY_MISMATCH), and a reviewer that is not independent of the
 * producer (REVIEW_INDEPENDENCE_VIOLATION).
 *
 * The envelope carries NO model truth: the model is selected per attempt by the
 * Stage 8 Smart Router AFTER acceptance, and the attemptModel field stays null
 * here (Stage 7B ownership rule — ExecutionAttempt owns the selected model).
 */
export const acceptHandoff = (input: {
  readonly handoff: ProfessionalHandoff;
  readonly consumerRole: RoleInstance;
  readonly targetTaskObjective: string;
  readonly requiredOutput: string;
  readonly durableArtifacts: readonly DurableArtifactView[];
  readonly decisions?: readonly {readonly summary: string}[];
  readonly constraints?: readonly string[];
  readonly taskAuthority: ReadonlySet<string>;
  readonly systemPolicy: ReadonlySet<string>;
  readonly effectiveTools?: ReadonlySet<string>;
  /** Attempt ids are required when the consumer is an independent reviewer. */
  readonly producerAttemptId?: string;
  readonly consumerAttemptId?: string;
}): Result<RoleContextEnvelope, DomainError> => {
  if (requireText(input.targetTaskObjective, 'targetTaskObjective') !== null || requireText(input.requiredOutput, 'requiredOutput') !== null) {
    return err(
      collaborationError(
        'HANDOFF_CONTEXT_BUILD_FAILED',
        'Handoff acceptance requires the canonical target task objective and required output.',
      ),
    );
  }
  const available = new Map(input.durableArtifacts.map((a) => [a.artifactId, a]));
  const unreadable = input.handoff.artifactRefs.filter((id) => !available.has(id));
  if (unreadable.length > 0) {
    return err(
      collaborationError(
        'HANDOFF_CONTEXT_BUILD_FAILED',
        `Handoff artifacts are not readable by the consumer: ${unreadable.join(', ')}.`,
      ),
    );
  }

  // Authority: the consumer's professional needs must intersect BOTH the task
  // authority and the system policy. A consumer with no effective capability
  // cannot accept a professional handoff (fail loud, never widen silently).
  const authority = computeEffectiveExecutionPolicy({
    taskAuthority: input.taskAuthority,
    roleCapabilityNeeds: input.consumerRole.capabilityRequirements,
    systemPolicy: input.systemPolicy,
  });
  if (!authority.ok) return authority;
  if (authority.value.effectiveAuthority.size === 0) {
    return err(
      collaborationError(
        'HANDOFF_AUTHORITY_MISMATCH',
        'Consumer effective authority is empty — the handoff would transfer work the consumer may not perform.',
      ),
    );
  }

  // Reviewer independence is mechanical, not advisory (Boss Stage 8 §A).
  if (input.consumerRole.specification.independenceClass === 'independent-reviewer') {
    const independence = assertReviewerIndependence({
      reviewer: {
        roleInstanceId: input.consumerRole.roleInstanceId,
        attemptId: input.consumerAttemptId ?? null,
        envelope: null,
      },
      producer: { roleInstanceId: input.handoff.producerRoleInstanceId, attemptId: input.producerAttemptId ?? null },
      requireAttemptIds: true,
    });
    if (!independence.ok) return independence;
  }

  const envelope = buildRoleContextEnvelope({
    goalSummary: input.handoff.handoffReason,
    planItem: null,
    taskObjective: input.targetTaskObjective,
    role: input.consumerRole,
    decisions: input.decisions ?? [],
    constraints: input.constraints ?? [],
    requiredOutput: input.requiredOutput,
    acceptanceCriteria: input.handoff.acceptanceCriteria,
    artifactRefs: [...input.handoff.artifactRefs],
    effectiveAuthority: authority.value.effectiveAuthority,
    effectiveTools: input.effectiveTools ?? new Set<string>(),
    // Stage 7B ownership: the attempt model is selected AFTER acceptance by the
    // Smart Router and recorded on the ExecutionAttempt, never carried by the
    // collaboration object.
    attemptModel: null,
  });
  return ok(envelope);
};

// ---------------------------------------------------------------------------
// Reviewer Independence (Boss Stage 8 §A)
// ---------------------------------------------------------------------------

/**
 * Prove a reviewer is independent of the producer: different RoleInstance,
 * different ExecutionAttempt, and an envelope that carries summaries only.
 *
 * When `requireAttemptIds` is set (reviewer acceptance), both attempt ids must
 * be present and different — a reviewer that shares the producer's attempt is
 * reviewing its own work.
 */
export const assertReviewerIndependence = (input: {
  readonly reviewer: {
    readonly roleInstanceId: string;
    readonly attemptId: string | null;
    readonly envelope: RoleContextEnvelope | null;
  };
  readonly producer: { readonly roleInstanceId: string; readonly attemptId: string | null };
  readonly requireAttemptIds?: boolean;
}): Result<true, DomainError> => {
  if (input.reviewer.roleInstanceId === input.producer.roleInstanceId) {
    return err(
      collaborationError(
        'REVIEW_INDEPENDENCE_VIOLATION',
        'The reviewer must be a different RoleInstance than the producer.',
      ),
    );
  }
  if (input.requireAttemptIds === true && (input.reviewer.attemptId === null || input.producer.attemptId === null)) {
    return err(
      collaborationError(
        'REVIEW_INDEPENDENCE_VIOLATION',
        'An independent reviewer must run in its own ExecutionAttempt; attempt ids are required.',
      ),
    );
  }
  if (input.reviewer.attemptId !== null && input.reviewer.attemptId === input.producer.attemptId) {
    return err(
      collaborationError(
        'REVIEW_INDEPENDENCE_VIOLATION',
        'The reviewer shares the producer ExecutionAttempt — a reviewer never reviews its own attempt.',
      ),
    );
  }
  // The envelope is structurally summary-only; an extra smuggled key is a violation.
  if (input.reviewer.envelope !== null) {
    const serialized = JSON.stringify(input.reviewer.envelope);
    for (const forbidden of [...FORBIDDEN_HANDOFF_FIELDS, 'producerTranscript']) {
      if (serialized.includes(`"${forbidden}"`)) {
        return err(
          collaborationError(
            'REVIEW_INDEPENDENCE_VIOLATION',
            `The reviewer envelope carries the forbidden raw-context field "${forbidden}".`,
          ),
        );
      }
    }
  }
  return ok(true);
};

// ---------------------------------------------------------------------------
// Derived Collaboration Projection (Boss Stage 8 §A — read model, never truth)
// ---------------------------------------------------------------------------

export interface ProjectedCollaborationRole {
  readonly roleInstanceId: string;
  readonly displayName: string;
  readonly independenceClass: string;
  readonly associatedTaskIds: readonly string[];
  /** DERIVED from canonical Task state (Stage 7 deriveRoleStatus) — never stored. */
  readonly derivedStatus: 'working' | 'waiting' | 'completed' | 'blocked';
}

export interface ProjectedPendingHandoff {
  readonly handoffId: string;
  readonly producerRoleInstanceId: string;
  readonly consumerRoleInstanceId: string;
  readonly sourceTaskId: string;
  readonly targetTaskId: string;
  readonly waitingOn: 'source-not-done' | 'consumer-not-started';
}

/**
 * The collaboration read model. EVERY field is derived from canonical Task
 * state and the durable handoffs — the projection owns no state, no status and
 * no scheduling decision (the PM coordinates handoffs, it does not schedule).
 */
export interface RoleCollaborationProjection {
  readonly runId: string;
  readonly viewVersion: 1;
  readonly roles: readonly ProjectedCollaborationRole[];
  readonly handoffs: readonly ProfessionalHandoff[];
  readonly pendingHandoffs: readonly ProjectedPendingHandoff[];
}

export const projectRoleCollaboration = (input: {
  readonly runId: string;
  readonly roles: readonly RoleInstance[];
  readonly tasks: readonly {readonly taskId: string; readonly roleInstanceId: string; readonly state: CanonicalTaskState}[];
  readonly handoffs: readonly ProfessionalHandoff[];
}): RoleCollaborationProjection => {
  const taskState = new Map(input.tasks.map((t) => [t.taskId, t.state]));
  const roles: ProjectedCollaborationRole[] = input.roles.map((role) => {
    const own = input.tasks.filter((t) => t.roleInstanceId === role.roleInstanceId);
    const states = own.map((t) => t.state);
    const derivedStatus: ProjectedCollaborationRole['derivedStatus'] = states.includes('running')
      ? 'working'
      : states.includes('blocked')
        ? 'blocked'
        : states.length === 0 || states.every((s) => s === 'done')
          ? 'completed'
          : 'waiting';
    return {
      roleInstanceId: role.roleInstanceId,
      displayName: role.specification.displayName,
      independenceClass: role.specification.independenceClass,
      associatedTaskIds: own.map((t) => t.taskId),
      derivedStatus,
    };
  });

  const pendingHandoffs: ProjectedPendingHandoff[] = [];
  for (const handoff of input.handoffs) {
    const source = taskState.get(handoff.sourceTaskId);
    const target = taskState.get(handoff.targetTaskId);
    if (source !== undefined && source !== 'done') {
      pendingHandoffs.push({
        handoffId: handoff.handoffId,
        producerRoleInstanceId: handoff.producerRoleInstanceId,
        consumerRoleInstanceId: handoff.consumerRoleInstanceId,
        sourceTaskId: handoff.sourceTaskId,
        targetTaskId: handoff.targetTaskId,
        waitingOn: 'source-not-done',
      });
    } else if (target === undefined || target === 'pending') {
      pendingHandoffs.push({
        handoffId: handoff.handoffId,
        producerRoleInstanceId: handoff.producerRoleInstanceId,
        consumerRoleInstanceId: handoff.consumerRoleInstanceId,
        sourceTaskId: handoff.sourceTaskId,
        targetTaskId: handoff.targetTaskId,
        waitingOn: 'consumer-not-started',
      });
    }
  }

  return {
    runId: input.runId,
    viewVersion: 1,
    roles: [...roles].sort((a, b) => a.roleInstanceId.localeCompare(b.roleInstanceId)),
    handoffs: [...input.handoffs].sort((a, b) => a.handoffId.localeCompare(b.handoffId)),
    pendingHandoffs: [...pendingHandoffs].sort((a, b) => a.handoffId.localeCompare(b.handoffId)),
  };
};
