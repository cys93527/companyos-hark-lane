import { describe, expect, it } from 'vitest';

import {
  acceptChangeProposal,
  openChangeProposal,
  rejectChangeProposal,
  requireAcceptedProposal,
  supersedeChangeProposal,
  type ChangeProposal,
} from '@companyos/core';

import { makeCtx } from './support/fixtures.js';

const ctx = makeCtx();

function open(): ChangeProposal {
  const result = openChangeProposal({
    targetTemplateId: 'tpl_1',
    baseVersionId: 'ver_1',
    subject: { summary: 'reorder nodes', ops: [{ op: 'update_node', path: '/nodes/0/title', after: 'Review' }] },
    rationale: 'Review must happen before handoff, not after.',
    authorId: 'user_author',
    calledAt: ctx.now,
    ids: ctx.ids,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('change proposal governance', () => {
  it('opens a proposal in status open with the full audit trail', () => {
    const proposal = open();
    expect(proposal.status).toBe('open');
    expect(proposal.decidedBy).toBeNull();
    expect(proposal.decidedAt).toBeNull();
    expect(proposal.ops).toHaveLength(1);
    expect(proposal.id.startsWith('chp_')).toBe(true);
  });

  it('rejects a proposal with a too-short rationale or no operations', () => {
    const brief = openChangeProposal({
      targetTemplateId: 'tpl_1',
      baseVersionId: 'ver_1',
      subject: { summary: 'x', ops: [{ op: 'add_node', path: '/nodes/2' }] },
      rationale: 'too short',
      authorId: 'user_author',
      calledAt: ctx.now,
      ids: ctx.ids,
    });
    expect(brief.ok).toBe(false);
    if (!brief.ok) expect(brief.error.code).toBe('VALIDATION_FAILED');

    const noOps = openChangeProposal({
      targetTemplateId: 'tpl_1',
      baseVersionId: 'ver_1',
      subject: { summary: 'x', ops: [] },
      rationale: 'A long enough rationale explaining the intent.',
      authorId: 'user_author',
      calledAt: ctx.now,
      ids: ctx.ids,
    });
    expect(noOps.ok).toBe(false);
  });

  it('enforces separation of duties: the author cannot decide', () => {
    const result = acceptChangeProposal(open(), { decidedBy: 'user_author', decidedAt: ctx.now });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it('accepts, rejects and supersedes exactly once', () => {
    const accepted = acceptChangeProposal(open(), { decidedBy: 'user_owner', decidedAt: ctx.now });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.status).toBe('accepted');
    expect(accepted.value.decidedBy).toBe('user_owner');

    const twice = rejectChangeProposal(accepted.value, { decidedBy: 'user_owner', decidedAt: ctx.now });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error.code).toBe('CONFLICT');

    const rejected = rejectChangeProposal(open(), {
      decidedBy: 'user_owner',
      decidedAt: ctx.now,
      note: 'Out of scope for 1.2.0',
    });
    expect(rejected.ok && rejected.value.status).toBe('rejected');

    const superseded = supersedeChangeProposal(open(), { decidedBy: 'user_owner', decidedAt: ctx.now });
    expect(superseded.ok && superseded.value.status).toBe('superseded');
  });

  it('gates revision on an accepted proposal written against the CURRENT version', () => {
    const proposal = open();
    expect(requireAcceptedProposal(proposal, 'tpl_1', 'ver_1').ok).toBe(false);

    const accepted = acceptChangeProposal(proposal, { decidedBy: 'user_owner', decidedAt: ctx.now });
    if (!accepted.ok) throw new Error('accept failed');

    expect(requireAcceptedProposal(accepted.value, 'tpl_1', 'ver_1').ok).toBe(true);
    expect(requireAcceptedProposal(accepted.value, 'tpl_1', 'ver_2').ok).toBe(false);
    expect(requireAcceptedProposal(accepted.value, 'tpl_other', 'ver_1').ok).toBe(false);
    expect(requireAcceptedProposal(accepted.value, 'tpl_1', null).ok).toBe(false);

    const stale = requireAcceptedProposal(accepted.value, 'tpl_1', 'ver_2');
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('PROPOSAL_NOT_ACCEPTED');
  });
});
