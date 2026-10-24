/**
 * Sprint 4 test L + requirement 17: proposals, locks, versions and snapshots survive a
 * restart, and an interrupted lifecycle operation leaves no partial state.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createWorkflowLifecycle, type WorkflowLifecycle } from '@companyos/engine';
import type { WorkflowTemplate } from '@companyos/core';

import { makeLifecycleFixture, must, shouldFail, type LifecycleFixture } from '../support/lifecycle-fixture.js';

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
    await fixture.lifecycle().saveDraftGraph({ templateId: created.id, graph: fixture.graph(), actorId: 'user_designer' }),
  );
  return must(await fixture.lifecycle().publish({ templateId: created.id, actorId: 'user_designer' }));
};

describe('L. governance state survives a restart', () => {
  it('L: keeps proposal, lock, versions and snapshot across a reopen', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'plan the revision before the process restarts',
        summary: 'revise',
        ops: fixture.ops(),
        actorId: 'user_designer',
      }),
    );
    must(await fixture.lifecycle().decideProposal({ proposalId: proposal.id, decision: 'accept', actorId: 'user_lead' }));
    const run = must(
      await fixture.lifecycle().createRun({
        templateId: published.id,
        companyId: 'cmp_1',
        workflowId: 'wfl_1',
        actorId: 'user_owner',
      }),
    );
    const lock = must(
      await fixture.lifecycle().lock({
        templateId: published.id,
        scope: 'run',
        reason: 'survives restart',
        actorId: 'user_ops',
      }),
    );

    fixture.restart();

    // Proposal
    const storedProposal = (await fixture.database().proposals.get(proposal.id))!;
    expect(storedProposal.status).toBe('accepted');
    expect(storedProposal.decidedBy).toBe('user_lead');
    // Lock
    expect(fixture.database().activeLockOf(published.id)?.id).toBe(lock.id);
    // Versions
    const storedTemplate = (await fixture.lifecycle().readTemplate(published.id)) as WorkflowTemplate;
    expect(storedTemplate.versions).toHaveLength(1);
    expect(storedTemplate.currentVersionId).toBe(published.currentVersionId);
    // Snapshot binding
    const snapshot = (await fixture.lifecycle().readSnapshot(run.snapshot.snapshotId))!;
    expect(snapshot.snapshotHash).toBe(run.snapshot.snapshotHash);
    expect(snapshot.workflowVersionId).toBe(published.currentVersionId);

    // …and the work continues on the rebuilt service.
    const released = must(await fixture.lifecycle().unlock({ lockId: lock.id, actorId: 'user_ops' }));
    expect(released.releasedAt).not.toBeNull();
    must(
      await fixture.lifecycle().openRevision({
        templateId: published.id,
        proposalId: proposal.id,
        graph: fixture.graph(3),
        actorId: 'user_designer',
      }),
    );
    const revised = must(
      await fixture.lifecycle().publishRevision({ templateId: published.id, actorId: 'user_lead' }),
    );
    expect(revised.versions).toHaveLength(2);
  });

  it('L: an open proposal can still be decided after a restart', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'decision happens in the next process',
        summary: 'revise',
        ops: fixture.ops(),
        actorId: 'user_designer',
      }),
    );

    fixture.restart();

    const decided = must(
      await fixture.lifecycle().decideProposal({
        proposalId: proposal.id,
        decision: 'accept',
        actorId: 'user_lead',
      }),
    );
    expect(decided.status).toBe('accepted');
  });
});

/** A lifecycle service over the SAME open database but with a broken event sink. */
const brokenLifecycle = (fixture: LifecycleFixture): WorkflowLifecycle => {
  const database = fixture.database();
  return createWorkflowLifecycle({
    ids: fixture.ids,
    clock: fixture.clock,
    templates: database.templates,
    locks: database.locks,
    proposals: database.proposals,
    snapshots: database.snapshots,
    runs: database.runs,
    events: {
      append: async () => {
        throw new Error('injected event-store failure');
      },
      readFrom: (position: number, limit: number) => database.events.readFrom(position, limit),
      lastPosition: () => database.events.lastPosition(),
      readByAggregate: (type: string, id: string) => database.events.readByAggregate(type, id),
    },
    unitOfWork: database.unitOfWork,
  });
};

describe('17. crash safety of lifecycle writes', () => {
  it('rolls a failed publish back completely (no version, no state change, no lock)', async () => {
    const fixture = make();
    const created = must(
      await fixture.lifecycle().createTemplate({ orgId: 'org_1', name: 'SOP', actorId: 'user_designer' }),
    );

    const refused = await shouldFail(
      await brokenLifecycle(fixture).saveDraftGraph({
        templateId: created.id,
        graph: fixture.graph(),
        actorId: 'user_designer',
      }),
    );
    expect(refused.code).toBe('PERSISTENCE_FAILED');

    // Nothing half-written: no draft version, still a draft, no locks.
    const stored = (await fixture.lifecycle().readTemplate(created.id)) as WorkflowTemplate;
    expect(stored.versions).toHaveLength(0);
    expect(stored.draftVersionId).toBeNull();
    expect(stored.state).toBe('draft');
    expect(fixture.database().activeLockOf(created.id)).toBeNull();

    // The same database is healthy again once the sink is repaired: draft → publish.
    const drafted = must(
      await fixture.lifecycle().saveDraftGraph({
        templateId: created.id,
        graph: fixture.graph(),
        actorId: 'user_designer',
      }),
    );
    expect(drafted.versions).toHaveLength(1);
    const published = must(await fixture.lifecycle().publish({ templateId: created.id, actorId: 'user_designer' }));
    expect(published.state).toBe('published');
    expect(published.versions).toHaveLength(1);
  });

  it('rolls a failed revision publish back and leaves the template publishable', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'the publish will be interrupted mid-flight',
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

    const refused = await shouldFail(
      await brokenLifecycle(fixture).publishRevision({ templateId: published.id, actorId: 'user_lead' }),
    );
    expect(refused.code).toBe('PERSISTENCE_FAILED');

    // No lock wedged, draft still open, versions unchanged.
    expect(fixture.database().activeLockOf(published.id)).toBeNull();
    const afterFailure = (await fixture.lifecycle().readTemplate(published.id)) as WorkflowTemplate;
    expect(afterFailure.versions).toHaveLength(2); // 1.0.0 + the open draft
    expect(afterFailure.draftVersionId).not.toBeNull();
    expect(afterFailure.currentVersionId).toBe(published.currentVersionId);

    // The retry on a healthy service succeeds.
    const retried = must(
      await fixture.lifecycle().publishRevision({ templateId: published.id, actorId: 'user_lead' }),
    );
    expect(retried.versions.filter((version) => !version.semver.includes('draft'))).toHaveLength(2);
    expect(retried.versions).toHaveLength(2);
  });
});
