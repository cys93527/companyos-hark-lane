/**
 * ChangeProposal — the ONLY door through which a published version may change
 * (ADR-0009). Accepting a proposal does not itself modify the template; it only
 * unlocks `open_revision`, which mints a new draft version.
 */
import type { ChangeOp } from './proposal-diff.js';
import { err, ok, type Result } from '../kernel/result.js';
import { LifecycleError } from '../kernel/errors.js';
import type { IdFactory } from '../ports/id-factory.js';

export const PROPOSAL_STATUSES = ['open', 'accepted', 'rejected', 'superseded'] as const;
export type ChangeProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ChangeProposal {
  readonly id: string;
  readonly targetTemplateId: string;
  readonly baseVersionId: string;
  readonly rationale: string;
  readonly ops: readonly ChangeOp[];
  readonly authorId: string;
  readonly status: ChangeProposalStatus;
  readonly createdAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
}

export interface ChangeProposalSubject {
  readonly summary: string;
  readonly ops: readonly ChangeOp[];
}

export interface OpenProposalInput {
  readonly targetTemplateId: string;
  readonly baseVersionId: string;
  readonly subject: ChangeProposalSubject;
  readonly rationale: string;
  readonly authorId: string;
  readonly calledAt: string;
  readonly ids: IdFactory;
}

export function openChangeProposal(input: OpenProposalInput): Result<ChangeProposal, LifecycleError> {
  if (input.rationale.trim().length < 10) {
    return err(
      new LifecycleError('VALIDATION_FAILED', 'A change proposal needs a rationale of >= 10 characters.', {
        templateId: input.targetTemplateId,
      }),
    );
  }
  if (input.subject.ops.length === 0) {
    return err(
      new LifecycleError('VALIDATION_FAILED', 'A change proposal needs at least one operation.', {
        templateId: input.targetTemplateId,
      }),
    );
  }
  return ok({
    id: input.ids.id('chp'),
    targetTemplateId: input.targetTemplateId,
    baseVersionId: input.baseVersionId,
    rationale: input.rationale,
    ops: input.subject.ops,
    authorId: input.authorId,
    status: 'open',
    createdAt: input.calledAt,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
  });
}

interface Decision {
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly note?: string;
}

function decide(
  proposal: ChangeProposal,
  decision: Decision,
  status: Exclude<ChangeProposalStatus, 'open'>,
): Result<ChangeProposal, LifecycleError> {
  if (proposal.status !== 'open') {
    return err(
      new LifecycleError('CONFLICT', `Proposal ${proposal.id} is already "${proposal.status}".`, {
        proposalId: proposal.id,
        status: proposal.status,
      }),
    );
  }
  if (proposal.authorId === decision.decidedBy) {
    return err(
      new LifecycleError('VALIDATION_FAILED', 'Separation of duties: the author cannot decide their own proposal.', {
        proposalId: proposal.id,
        authorId: proposal.authorId,
      }),
    );
  }
  return ok({
    ...proposal,
    status,
    decidedBy: decision.decidedBy,
    decidedAt: decision.decidedAt,
    decisionNote: decision.note ?? null,
  });
}

export const acceptChangeProposal = (proposal: ChangeProposal, decision: Decision) =>
  decide(proposal, decision, 'accepted');

export const rejectChangeProposal = (proposal: ChangeProposal, decision: Decision) =>
  decide(proposal, decision, 'rejected');

export const supersedeChangeProposal = (proposal: ChangeProposal, decision: Decision) =>
  decide(proposal, decision, 'superseded');

/** Gate used by `openRevision`: only an accepted proposal on the current version may pass. */
export function requireAcceptedProposal(
  proposal: ChangeProposal,
  templateId: string,
  currentVersionId: string | null,
): Result<ChangeProposal, LifecycleError> {
  if (proposal.status !== 'accepted') {
    return err(
      new LifecycleError('PROPOSAL_NOT_ACCEPTED', `Proposal ${proposal.id} is "${proposal.status}", not "accepted".`, {
        proposalId: proposal.id,
        status: proposal.status,
      }),
    );
  }
  if (proposal.targetTemplateId !== templateId) {
    return err(
      new LifecycleError('PROPOSAL_NOT_ACCEPTED', `Proposal ${proposal.id} targets another template.`, {
        proposalId: proposal.id,
        targetTemplateId: proposal.targetTemplateId,
        templateId,
      }),
    );
  }
  if (currentVersionId === null || proposal.baseVersionId !== currentVersionId) {
    return err(
      new LifecycleError('PROPOSAL_NOT_ACCEPTED', `Proposal ${proposal.id} was written against a stale version.`, {
        proposalId: proposal.id,
        baseVersionId: proposal.baseVersionId,
        currentVersionId,
      }),
    );
  }
  return ok(proposal);
}
