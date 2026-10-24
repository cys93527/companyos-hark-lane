/**
 * STAGE 8B — the RUNTIME bridge between the Stage 8 Professional Handoff
 * Contract (decision layer) and the EXISTING canonical handoff persistence
 * (Sprint-11 HandoffService over the frozen `handoffs` / `handoff_refs`
 * tables).
 *
 * This module creates NO second handoff truth:
 *   - the WRITE path maps the Stage 8 contract 1:1 onto the canonical
 *     CreateHandoffInput and persists through the ONE HandoffService
 *     (createDraft → ready → accept) — the same service the desktop bootstrap
 *     wires, with the same durable-reference resolver (refs must resolve or the
 *     write fails closed);
 *   - the READ path builds the consumer's RoleContextEnvelope from the
 *     canonical Work Package projection, which already carries the ACCEPTED
 *     durable handoff views — so a restarted process rebuilds the identical
 *     context from durable truth, never from a producer transcript.
 *
 * Raw chain-of-thought, full private transcripts and hidden reasoning are
 * structurally excluded: the contract carries refs and professional summaries
 * only (Stage 8 §A), and the canonical handoff rejects secret-shaped content.
 */
import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';
import {
  handoffToAgentContextView,
  type HandoffContextView,
  type HandoffPacket,
  type HandoffRef,
} from '@companyos/core';
import type { WorkPackage } from '@companyos/engine';

import type { ProfessionalHandoff } from './role-collaboration.js';

// ---------------------------------------------------------------------------
// Stage 8 contract -> canonical CreateHandoffInput (adapter mapping only)
// ---------------------------------------------------------------------------

/** The canonical identities the application layer supplies (never the model). */
export interface RuntimeHandoffMapping {
  readonly handoffId: string;
  readonly companyId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly taskId: string;
  readonly fromAgentId: string;
  readonly fromRoleId: string;
  readonly toRoleId: string;
  readonly objective: string;
  readonly recommendedNextAction: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly modelBinding?: { readonly modelKey: string; readonly providerId: string } | null;
  readonly executionRef?: string | null;
}

const ref = (kind: HandoffRef['kind'], id: string): HandoffRef => ({kind, refId: id});

/**
 * Map the Stage 8 Professional Handoff onto the canonical handoff creation
 * input. The mapping is 1:1 onto existing columns — no new field, no second
 * schema. The producer/consumer role instances name the canonical from/to
 * roles; the source task is the handoff's task; the consumer's task objective
 * is the handoff objective.
 */
export const stage8HandoffToCreateInput = (
  handoff: ProfessionalHandoff,
  mapping: RuntimeHandoffMapping,
): {
  handoffId: string;
  companyId: string;
  workflowId: string;
  workflowVersionId: string;
  workflowRunId: string;
  stageId: string;
  taskId: string;
  fromAgentId: string;
  fromRoleId: string;
  toRoleId: string;
  objective: string;
  summary: string;
  recommendedNextAction: string;
  completedWork: readonly string[];
  remainingWork: readonly string[];
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
  artifactRefs: readonly HandoffRef[];
  decisionRefs: readonly HandoffRef[];
  validationRefs: readonly HandoffRef[];
  knownRisks: readonly string[];
  openQuestions: readonly string[];
  modelBinding: { readonly modelKey: string; readonly providerId: string } | null;
  executionRef: string | null;
  traceId: string;
  createdAt: string;
} => ({
  handoffId: mapping.handoffId,
  companyId: mapping.companyId,
  workflowId: mapping.workflowId,
  workflowVersionId: mapping.workflowVersionId,
  workflowRunId: mapping.workflowRunId,
  stageId: mapping.stageId,
  taskId: handoff.sourceTaskId,
  fromAgentId: mapping.fromAgentId,
  fromRoleId: mapping.fromRoleId,
  toRoleId: mapping.toRoleId,
  objective: mapping.objective,
  summary: handoff.handoffReason,
  recommendedNextAction: mapping.recommendedNextAction,
  completedWork: [handoff.handoffReason],
  remainingWork: [...handoff.remainingQuestions],
  constraints: [...handoff.knownRisks],
  acceptanceCriteria: [...handoff.acceptanceCriteria],
  artifactRefs: handoff.artifactRefs.map((id) => ref('artifact', id)),
  decisionRefs: handoff.decisionRefs.map((id) => ref('decision', id)),
  validationRefs: handoff.evidenceRefs.map((id) => ref('validation', id)),
  knownRisks: [...handoff.knownRisks],
  openQuestions: [...handoff.remainingQuestions],
  modelBinding: mapping.modelBinding ?? null,
  executionRef: mapping.executionRef ?? null,
  traceId: mapping.traceId,
  createdAt: mapping.createdAt,
});

// ---------------------------------------------------------------------------
// Consumer context from durable canonical state (Boss §4/§11-§12)
// ---------------------------------------------------------------------------

/** The bounded role context a consumer role receives, built from canonical truth only. */
export interface ConsumerRoleContext {
  readonly goalSummary: string;
  readonly planItem: string | null;
  readonly taskObjective: string;
  readonly relevantDecisionSummaries: readonly string[];
  readonly hardConstraints: readonly string[];
  readonly requiredOutput: string;
  readonly acceptanceCriteria: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly knownRisks: readonly string[];
  readonly remainingQuestions: readonly string[];
  readonly handoffRefs: readonly { readonly handoffId: string; readonly version: number }[];
}

/**
 * Build the consumer context from the canonical Work Package projection AND the
 * durable handoff packets addressed to the consumer's task scope. Every field
 * is a derivation of durable truth: goal, plan item, task objective, canonical
 * decisions (refs), acceptance criteria, artifact/evidence refs, handoff risks
 * and open questions. The producer's raw transcript and hidden reasoning are
 * NOT inputs — they do not exist in the durable state and cannot enter here.
 *
 * Packet status is carried as a LABEL (the consumer sees whether the offered
 * work is READY or ACCEPTED); acceptance itself stays a real actor operation
 * through the existing IPC path — the runtime never fabricates it.
 */
export const consumerContextOfWorkPackage = (input: {
  readonly pkg: WorkPackage;
  readonly roleInstanceId: string;
  readonly handoffPackets: readonly HandoffPacket[];
}): Result<ConsumerRoleContext, DomainError> => {
  const pkg = input.pkg;
  const views: readonly HandoffContextView[] = input.handoffPackets.map((packet) => handoffToAgentContextView(packet));
  for (const view of views) {
    // The consumer only ever reads handoffs addressed to ITS role seat.
    if (view.toRoleId !== '' && view.toRoleId !== input.roleInstanceId && view.toRoleId !== pkg.execution.roleId) {
      return err(
        domainError('VALIDATION_FAILED', `Handoff "${view.handoffId}" is not addressed to the consuming role seat.`, {
          reason: 'HANDOFF_AUTHORITY_MISMATCH',
        }),
      );
    }
  }
  const decisionSummaries = views.flatMap((view) =>
    view.decisionRefs.map((decision) => `${view.handoffId}:decision:${decision.refId}`),
  );
  return ok({
    goalSummary: pkg.goal.objective,
    planItem: pkg.work.objective,
    taskObjective: pkg.work.objective ?? pkg.goal.objective,
    relevantDecisionSummaries: decisionSummaries,
    hardConstraints: views.flatMap((view) => view.constraints),
    requiredOutput: pkg.acceptance.criteria.map((criterion) => criterion.requirement).join('; '),
    acceptanceCriteria: pkg.acceptance.criteria.map((criterion) => criterion.requirement),
    artifactRefs: [
      ...new Set([
        ...views.flatMap((view) => view.artifactRefs.map((entry) => entry.refId)),
        ...pkg.dependencies.flatMap((dependency) => dependency.artifactRefs),
        ...(pkg.causal === null ? [] : pkg.causal.artifactRefs),
      ]),
    ],
    evidenceRefs: [
      ...new Set([
        ...views.flatMap((view) => view.validationRefs.map((entry) => entry.refId)),
        ...(pkg.causal === null ? [] : pkg.causal.validationRefs),
      ]),
    ],
    knownRisks: views.flatMap((view) => view.knownRisks),
    remainingQuestions: views.flatMap((view) => view.openQuestions),
    handoffRefs: views.map((view) => ({handoffId: view.handoffId, version: view.version})),
  });
};

// ---------------------------------------------------------------------------
// Producer-side durable recording (Boss §3)
// ---------------------------------------------------------------------------

export interface RuntimeHandoffRecorderDeps {
  readonly createDraft: (input: ReturnType<typeof stage8HandoffToCreateInput> & { actorId: string }) => Promise<Result<{ readonly handoffId: string; readonly handoffVersion: number }, DomainError>>;
  readonly ready: (input: { readonly handoffId: string; readonly version: number; readonly actorId: string; readonly requiresEvidence?: boolean }) => Promise<Result<unknown, DomainError>>;
}

/**
 * Record ONE producer→consumer handoff durably through the EXISTING canonical
 * HandoffService: DRAFT (with durable reference resolution) → READY. Consumer
 * ACCEPTANCE stays a real actor operation through the existing IPC path — the
 * runtime never fabricates acceptance on a seat's behalf.
 *
 * Idempotent per handoffId: the packet id derives from the producing attempt,
 * so a repeated write replays the same canonical packet (the store refuses a
 * second version for the same id) instead of silently duplicating work.
 */
export const recordRuntimeHandoff = async (
  deps: RuntimeHandoffRecorderDeps,
  input: {
    readonly handoff: ProfessionalHandoff;
    readonly mapping: RuntimeHandoffMapping & { readonly actorId: string };
  },
): Promise<Result<{ readonly handoffId: string; readonly handoffVersion: number }, DomainError>> => {
  const created = await deps.createDraft({
    ...stage8HandoffToCreateInput(input.handoff, input.mapping),
    actorId: input.mapping.actorId,
  });
  if (!created.ok) return created;
  const version = created.value.handoffVersion;
  const ready = await deps.ready({
    handoffId: created.value.handoffId,
    version,
    actorId: input.mapping.actorId,
    requiresEvidence: true,
  });
  if (!ready.ok) return ready;
  return ok({handoffId: created.value.handoffId, handoffVersion: version});
};
