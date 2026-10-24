import { describe, expect, it } from 'vitest';

import {
  acceptChangeProposal,
  archiveTemplate,
  createWorkflowTemplate,
  currentVersion,
  deprecateTemplate,
  forkTemplate,
  isRunnable,
  isVersionIntact,
  openRevision,
  openChangeProposal,
  publishInitialVersion,
  publishRevision,
  releasedVersions,
  type WorkflowTemplate,
} from '@companyos/core';

import { makeCtx, simpleGraph, singleNodeGraph } from './support/fixtures.js';

function createDraft(name = 'Quarterly planning SOP'): {
  template: WorkflowTemplate;
  traceIds: string[];
} {
  const ctx = makeCtx();
  const created = createWorkflowTemplate({
    orgId: 'org_acme',
    name,
    actorId: ctx.actorId,
    now: ctx.now,
    ids: ctx.ids,
    traceId: ctx.traceId,
  });
  return { template: created.template, traceIds: created.events.map((e) => e.type) };
}

describe('workflow template lifecycle walkthrough', () => {
  it('walks draft → published → revision → fork → deprecated → archived', () => {
    const ctx = makeCtx();
    const { template: draft, traceIds } = createDraft();
    expect(traceIds).toEqual(['workflow.template.created']);
    expect(draft.state).toBe('draft');
    expect(draft.currentVersionId).toBeNull();
    expect(isRunnable(draft)).toBe(false);

    // 1. Draft --publish--> Published (1.0.0)
    const published = publishInitialVersion(draft, { graph: simpleGraph(), ctx });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const mutation = published.value;
    const v1 = mutation.version;
    expect(v1?.semver).toBe('1.0.0');
    expect(v1?.immutable).toBe(true);
    expect(isVersionIntact(v1!)).toBe(true);
    expect(mutation.template.state).toBe('published');
    expect(isRunnable(mutation.template)).toBe(true);
    expect(mutation.events.map((e) => e.type)).toEqual([
      'workflow.version.created',
      'workflow.template.published',
    ]);

    // 2. Open a revision — only an ACCEPTED proposal unlocks this door
    const proposal = openChangeProposal({
      targetTemplateId: mutation.template.id,
      baseVersionId: v1!.id,
      subject: { summary: 'add review node', ops: [{ op: 'add_node', path: '/nodes/2', after: { id: 'n3' } }] },
      rationale: 'The SOP lacks an explicit review gate before handoff.',
      authorId: 'user_author',
      calledAt: ctx.now,
      ids: ctx.ids,
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;

    const premature = openRevision(mutation.template, {
      proposal: proposal.value,
      graph: simpleGraph(),
      ctx,
    });
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.error.code).toBe('PROPOSAL_NOT_ACCEPTED');

    const accepted = acceptChangeProposal(proposal.value, { decidedBy: 'user_owner', decidedAt: ctx.now });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const revising = openRevision(mutation.template, {
      proposal: accepted.value,
      graph: simpleGraph(),
      ctx,
    });
    expect(revising.ok).toBe(true);
    if (!revising.ok) return;
    const revision = revising.value;
    expect(revision.version?.semver).toBe('1.1.0-draft');
    expect(revision.template.state).toBe('published');
    expect(revision.template.currentVersionId).toBe(v1!.id);
    expect(releasedVersions(revision.template)).toHaveLength(1);

    // 3. Publish the revision — the draft is released, the old version is untouched
    const released = publishRevision(revision.template, ctx);
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    const release = released.value;
    expect(release.version?.semver).toBe('1.1.0');
    expect(release.template.currentVersionId).toBe(revision.version?.id);
    expect(release.template.draftVersionId).toBeNull();
    expect(releasedVersions(release.template)).toHaveLength(2);
    const stillV1 = release.template.versions.find((v) => v.id === v1!.id);
    expect(stillV1).toEqual(v1);

    // 4. Fork into a new draft template, keeping lineage
    const forked = forkTemplate(release.template, { name: 'Quarterly planning SOP (fork)', ctx });
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    expect(forked.value.template.id).not.toBe(release.template.id);
    expect(forked.value.template.state).toBe('draft');
    expect(forked.value.origin).toMatchObject({
      templateId: release.template.id,
      versionId: release.template.currentVersionId,
      semver: '1.1.0',
    });
    expect(forked.value.events[0]?.type).toBe('workflow.template.forked');

    // 5. Deprecate then archive the original
    const deprecated = deprecateTemplate(release.template, { reason: 'Replaced by the fork.', ctx });
    expect(deprecated.ok).toBe(true);
    if (!deprecated.ok) return;
    expect(deprecated.value.template.state).toBe('deprecated');
    expect(isRunnable(deprecated.value.template)).toBe(false);
    expect(currentVersion(deprecated.value.template)).not.toBeNull();

    const archived = archiveTemplate(deprecated.value.template, ctx);
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.template.state).toBe('archived');
    expect(archiveTemplate(archived.value.template, ctx).ok).toBe(false);
  });

  it('refuses to publish an invalid graph and leaves the template in draft', () => {
    const ctx = makeCtx();
    const { template } = createDraft();
    const empty = publishInitialVersion(template, { graph: { nodes: [], edges: [] }, ctx });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('VALIDATION_FAILED');

    const dangling = publishInitialVersion(template, {
      graph: { nodes: [singleNodeGraph().nodes[0]!], edges: [{ from: 'n1', to: 'nope' }] },
      ctx,
    });
    expect(dangling.ok).toBe(false);
    expect(template.state).toBe('draft');
  });

  it('never changes the source template when forking', () => {
    const ctx = makeCtx();
    const { template } = createDraft();
    const published = publishInitialVersion(template, { graph: singleNodeGraph(), ctx });
    if (!published.ok) throw new Error('publish failed');
    const before = JSON.stringify(published.value.template);
    const forked = forkTemplate(published.value.template, { name: 'clone', ctx });
    expect(forked.ok).toBe(true);
    expect(JSON.stringify(published.value.template)).toBe(before);
  });

  it('refuses to archive a template that is still published', () => {
    const ctx = makeCtx();
    const { template } = createDraft();
    const published = publishInitialVersion(template, { graph: singleNodeGraph(), ctx });
    if (!published.ok) throw new Error('publish failed');
    const result = archiveTemplate(published.value.template, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('requires a reason to deprecate', () => {
    const ctx = makeCtx();
    const { template } = createDraft();
    const published = publishInitialVersion(template, { graph: singleNodeGraph(), ctx });
    if (!published.ok) throw new Error('publish failed');
    const result = deprecateTemplate(published.value.template, { reason: '   ', ctx });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });
});
