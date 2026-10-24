/**
 * Sprint 4 tests G, H, J, K, O:
 * retired templates, lock conflicts / double publish, change-proposal rejection and the
 * lifecycle event vocabulary.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { TRANSITIONS, domainError, type WorkflowRun, type WorkflowTemplate } from '@companyos/core';
import { createWorkflowLifecycle } from '@companyos/engine';

import { makeLifecycleFixture, must, shouldFail, STAGE_ID, type LifecycleFixture } from '../support/lifecycle-fixture.js';

const fixtures: LifecycleFixture[] = [];
const make = (options: Parameters<typeof makeLifecycleFixture>[0] = {}): LifecycleFixture => {
  const fixture = makeLifecycleFixture(options);
  fixtures.push(fixture);
  return fixture;
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

const publishedTemplate = async (fixture: LifecycleFixture): Promise<WorkflowTemplate> => {
  const created = must(
    await fixture.lifecycle().createTemplate({ orgId: 'org_1', name: 'SOP', actorId: 'user_designer' }),
  );
  must(
    await fixture.lifecycle().saveDraftGraph({
      templateId: created.id,
      graph: fixture.graph(),
      actorId: 'user_designer',
    }),
  );
  return must(await fixture.lifecycle().publish({ templateId: created.id, actorId: 'user_designer' }));
};

describe('G/H. deprecation gates new runs but not running ones', () => {
  it('G: refuses to create a run on a deprecated template', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    must(
      await fixture.lifecycle().deprecate({
        templateId: published.id,
        reason: 'superseded by the new SOP',
        actorId: 'user_lead',
      }),
    );

    const refused = await shouldFail(
      await fixture.lifecycle().createRun({
        templateId: published.id,
        companyId: 'cmp_1',
        workflowId: 'wfl_1',
        actorId: 'user_owner',
      }),
    );
    expect(refused.code).toBe('DEPRECATED_TEMPLATE');
    expect(await fixture.database().runs.list()).toMatchObject({ total: 0 });
  });

  it('H: an existing run on a deprecated template still completes', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const created = must(
      await fixture.lifecycle().createRun({
        templateId: published.id,
        companyId: 'cmp_1',
        workflowId: 'wfl_1',
        actorId: 'user_owner',
      }),
    );

    must(
      await fixture.lifecycle().deprecate({
        templateId: published.id,
        reason: 'deprecated while a run is in flight',
        actorId: 'user_lead',
      }),
    );

    const driven = must(
      await fixture.engine().drive(created.run.id, { stage: { stageId: STAGE_ID, taskIds: [] } }),
    );
    expect(driven.run.state).toBe('COMPLETED');
    const stored = (await fixture.database().runs.get(created.run.id)) as WorkflowRun;
    expect(stored.state).toBe('COMPLETED');
    expect(stored.versionId).toBe(published.currentVersionId);
  });
});

describe('J. locks prevent concurrent duplicate publishing', () => {
  it('J: only ONE active lock per template can exist (database-enforced)', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);

    must(
      await fixture.lifecycle().lock({
        templateId: published.id,
        scope: 'global',
        reason: 'maintenance window',
        actorId: 'user_ops',
      }),
    );
    const second = await shouldFail(
      await fixture.lifecycle().lock({
        templateId: published.id,
        scope: 'run',
        reason: 'someone else tries to lock too',
        actorId: 'user_ops2',
      }),
    );
    expect(second.code).toBe('CONFLICT');
    expect(second.details['reason']).toBe('lock_held');

    // The partial unique index is the referee, not the application.
    const rows = fixture
      .database()
      .db.prepare('SELECT COUNT(*) AS total FROM workflow_template_locks WHERE released_at IS NULL')
      .get() as { total: number };
    expect(Number(rows.total)).toBe(1);
  });

  it('J: a held global lock blocks revise / publish / archive / fork', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    must(
      await fixture.lifecycle().lock({
        templateId: published.id,
        scope: 'global',
        reason: 'release freeze',
        actorId: 'user_ops',
      }),
    );

    const refusedRevision = await shouldFail(
      await fixture.lifecycle().openRevision({
        templateId: published.id,
        proposalId: 'chp_unknown',
        graph: fixture.graph(3),
        actorId: 'user_designer',
      }),
    );
    // Mutable operations are checked against the lock BEFORE anything else.
    expect(refusedRevision.code).toBe('LOCKED_TEMPLATE');

    const refusedPublish = await shouldFail(
      await fixture.lifecycle().publishRevision({ templateId: published.id, actorId: 'user_lead' }),
    );
    expect(refusedPublish.code).toBe('LOCKED_TEMPLATE');

    const refusedFork = await shouldFail(
      await fixture.lifecycle().fork({ templateId: published.id, name: 'blocked fork', actorId: 'user_designer' }),
    );
    expect(refusedFork.code).toBe('LOCKED_TEMPLATE');

    // Releasing the lock restores every capability.
    const active = fixture.database().activeLockOf(published.id)!;
    must(await fixture.lifecycle().unlock({ lockId: active.id, actorId: 'user_ops' }));
    must(
      await fixture.lifecycle().fork({ templateId: published.id, name: 'allowed fork', actorId: 'user_designer' }),
    );
  });

  it('J: archive is blocked by a run-scoped lock (the machine’s guard)', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    must(
      await fixture.lifecycle().lock({
        templateId: published.id,
        scope: 'run',
        reason: 'a run is pinning this version',
        actorId: 'user_ops',
      }),
    );
    must(
      await fixture.lifecycle().deprecate({
        templateId: published.id,
        reason: 'retire, but a run still holds it',
        actorId: 'user_lead',
      }),
    );
    const refused = await shouldFail(
      await fixture.lifecycle().archive({ templateId: published.id, actorId: 'user_lead' }),
    );
    expect(refused.code).toBe('LOCKED_TEMPLATE');
    expect(refused.details['scope']).toBe('run');

    const active = fixture.database().activeLockOf(published.id)!;
    must(await fixture.lifecycle().unlock({ lockId: active.id, actorId: 'user_ops' }));
    const archived = must(await fixture.lifecycle().archive({ templateId: published.id, actorId: 'user_lead' }));
    expect(archived.state).toBe('archived');
  });

  it('J: two concurrent publish revisions — exactly one wins', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);

    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'concurrent publish must be serialized by the lock',
        summary: 'revise',
        ops: fixture.ops(),
        actorId: 'user_designer',
      }),
    );
    must(await fixture.lifecycle().decideProposal({ proposalId: proposal.id, decision: 'accept', actorId: 'user_lead' }));
    must(
      await fixture.lifecycle().openRevision({
        templateId: published.id,
        proposalId: proposal.id,
        graph: fixture.graph(3),
        actorId: 'user_designer',
      }),
    );

    const [first, second] = await Promise.all([
      fixture.lifecycle().publishRevision({ templateId: published.id, actorId: 'user_lead' }),
      fixture.lifecycle().publishRevision({ templateId: published.id, actorId: 'user_lead' }),
    ]);
    const outcomes = [first, second].filter((result) => result.ok);
    expect(outcomes).toHaveLength(1);

    const after = (await fixture.lifecycle().readTemplate(published.id)) as WorkflowTemplate;
    expect(after.versions.filter((version) => !version.semver.includes('draft'))).toHaveLength(2);
    expect(after.draftVersionId).toBeNull();
    // The publish window is not left behind by the loser.
    expect(fixture.database().activeLockOf(published.id)).toBeNull();
  });
});

describe('K. change proposal decisions gate revisions', () => {
  it('K: a rejected proposal cannot open a revision', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'this proposal will be rejected by the lead',
        summary: 'questionable change',
        ops: fixture.ops(),
        actorId: 'user_designer',
      }),
    );

    must(await fixture.lifecycle().decideProposal({ proposalId: proposal.id, decision: 'reject', actorId: 'user_lead', note: 'not now' }));
    const refused = await shouldFail(
      await fixture.lifecycle().openRevision({
        templateId: published.id,
        proposalId: proposal.id,
        graph: fixture.graph(3),
        actorId: 'user_designer',
      }),
    );
    expect(refused.code).toBe('PROPOSAL_NOT_ACCEPTED');

    const stored = (await fixture.database().proposals.get(proposal.id))!;
    expect(stored.status).toBe('rejected');
    expect(stored.decidedBy).toBe('user_lead');
  });

  it('K: separation of duties — the author cannot decide their own proposal', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'author tries to approve their own change',
        summary: 'self approval',
        ops: fixture.ops(),
        actorId: 'user_designer',
      }),
    );
    const refused = await shouldFail(
      await fixture.lifecycle().decideProposal({ proposalId: proposal.id, decision: 'accept', actorId: 'user_designer' }),
    );
    expect(refused.code).toBe('VALIDATION_FAILED');
  });

  it('K: a proposal written against a stale version is refused', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'proposal written before the version moved on',
        summary: 'stale base',
        ops: fixture.ops(),
        actorId: 'user_designer',
      }),
    );
    must(await fixture.lifecycle().decideProposal({ proposalId: proposal.id, decision: 'accept', actorId: 'user_lead' }));

    // Move the current version behind the proposal's back.
    const stored = (await fixture.lifecycle().readTemplate(published.id)) as WorkflowTemplate;
    await fixture.database().templates.put({ ...stored, currentVersionId: 'ver_other' });

    const refused = await shouldFail(
      await fixture.lifecycle().openRevision({
        templateId: published.id,
        proposalId: proposal.id,
        graph: fixture.graph(3),
        actorId: 'user_designer',
      }),
    );
    expect(refused.code).toBe('PROPOSAL_NOT_ACCEPTED');
  });
});

describe('O. lifecycle events are ordered and complete', () => {
  it('O: writes the whole lifecycle trail in transition order', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);

    // Revision round: proposal → accept → open revision → publish.
    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'second version to exercise the revision events',
        summary: 'revise',
        ops: fixture.ops(),
        actorId: 'user_designer',
      }),
    );
    const proposalId = proposal.id;
    must(await fixture.lifecycle().decideProposal({ proposalId, decision: 'accept', actorId: 'user_lead' }));
    must(
      await fixture.lifecycle().openRevision({
        templateId: published.id,
        proposalId,
        graph: fixture.graph(3),
        actorId: 'user_designer',
      }),
    );
    must(await fixture.lifecycle().publishRevision({ templateId: published.id, actorId: 'user_lead' }));
    const published2 = (await fixture.lifecycle().readTemplate(published.id)) as WorkflowTemplate;
    const currentVersionId = published2.currentVersionId;

    // A fork is part of the vocabulary too: exercise it (before retiring the template,
    // because an archived template is not forkable).
    const forked = must(
      await fixture.lifecycle().fork({
        templateId: published.id,
        name: 'forked branch',
        actorId: 'user_designer',
      }),
    );
    expect(forked.id).not.toBe(published.id);
    expect(forked.state).toBe('draft');

    const lock = must(
      await fixture.lifecycle().lock({
        templateId: published.id,
        scope: 'run',
        reason: 'maintenance',
        actorId: 'user_ops',
      }),
    );
    must(await fixture.lifecycle().unlock({ lockId: lock.id, actorId: 'user_ops' }));
    must(
      await fixture.lifecycle().deprecate({
        templateId: published.id,
        reason: 'end of life',
        actorId: 'user_lead',
      }),
    );
    must(await fixture.lifecycle().archive({ templateId: published.id, actorId: 'user_lead' }));

    // A fork is part of the vocabulary too: exercise it instead of hard-coding the type.
    expect((await fixture.database().events.all()).some((entry) => entry.event.type === 'workflow.template.forked')).toBe(true);

    // Template lifecycle facts span two aggregates: `WorkflowTemplate` (addressed by the
    // template id) and `WorkflowVersion` (addressed by the VERSION id, with the template
    // id in the payload — Sprint 4 review MEDIUM-2).
    const log = (await fixture.database().events.all()).filter((entry) => {
      const domainEvent = entry.event;
      if (domainEvent.aggregateId === published.id) return true;
      if (domainEvent.aggregateType === 'WorkflowVersion') {
        return (domainEvent.payload as { templateId?: unknown } | null)?.templateId === published.id;
      }
      return false;
    });
    const types = log.map((entry) => entry.event.type);
    expect(types).toEqual([
      'workflow.template.created',
      'workflow.version.draft_created',
      'workflow.version.created',
      'workflow.template.published',
      'workflow.change_proposal.opened',
      'workflow.change_proposal.accepted',
      'workflow.version.draft_created',
      'workflow.template.revision_opened',
      'workflow.version.released',
      'workflow.template.published',
      'workflow.template.locked',
      'workflow.template.unlocked',
      'workflow.template.deprecated',
      'workflow.template.archived',
    ]);

    // Positions are dense and monotonic, like every other event in the log.
    const positions = (await fixture.database().events.all()).map((entry) => entry.globalPosition);
    expect(positions).toEqual(positions.map((_value, index) => index + 1));

    // The machine's declared vocabulary is fully exercised by this flow. The forked
    // event is addressed by the CLONE id, so coverage is checked on the whole log.
    const allTypes = new Set((await fixture.database().events.all()).map((entry) => entry.event.type));
    const declared = new Set(TRANSITIONS.flatMap((rule) => rule.emits));
    const emitted = allTypes;
    for (const type of declared) {
      expect(emitted.has(type), `${type} must have a real emitter`).toBe(true);
    }

    // Version facts are addressable by version id (review MEDIUM-2) — the audit path a
    // run snapshot needs (`run_snapshots.workflow_version_id` → its own events).
    const versionTrail = (await fixture.database().events.all()).filter(
      (entry) => entry.event.aggregateType === 'WorkflowVersion' && entry.event.aggregateId === currentVersionId,
    );
    expect(versionTrail.map((entry) => entry.event.type)).toEqual([
      'workflow.version.draft_created',
      'workflow.version.released',
    ]);
  });

  it('asks the injected policy for an authority before every mutation (governance seam)', async () => {
    const fixture = make();
    const asks: string[] = [];
    const database = fixture.database();
    const governed = createWorkflowLifecycle({
      ids: fixture.ids,
      clock: fixture.clock,
      templates: database.templates,
      locks: database.locks,
      proposals: database.proposals,
      snapshots: database.snapshots,
      runs: database.runs,
      events: database.events,
      unitOfWork: database.unitOfWork,
      authorize: (request) => {
        asks.push(request.authority);
        return request.authority === 'workflow.publish'
          ? { ok: false, error: domainError('POLICY_DENIED', 'publishing is reserved for the lead', {}) }
          : { ok: true, value: true };
      },
    });

    const created = must(
      await governed.createTemplate({ orgId: 'org_1', name: 'SOP', actorId: 'user_designer' }),
    );
    must(await governed.saveDraftGraph({ templateId: created.id, graph: fixture.graph(), actorId: 'user_designer' }));

    const refused = await shouldFail(
      await governed.publish({ templateId: created.id, actorId: 'user_designer' }),
    );
    expect(refused.code).toBe('POLICY_DENIED');
    expect(asks).toEqual(['workflow.draft.create', 'workflow.draft.edit', 'workflow.publish']);

    // Nothing was published by the refused call.
    const stored = (await governed.readTemplate(created.id)) as WorkflowTemplate;
    expect(stored.state).toBe('draft');
    expect(stored.currentVersionId).toBeNull();
  });
});
