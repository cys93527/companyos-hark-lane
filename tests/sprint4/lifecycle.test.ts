/**
 * Sprint 4 tests A, B, C, D, E, F, I, M, N:
 * Draft → Review → Publish, immutability, versioning, snapshot binding, archive.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { isVersionIntact, verifyRunSnapshot, type WorkflowRun, type WorkflowTemplate } from '@companyos/core';

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
  must(await fixture.lifecycle().saveDraftGraph({ templateId: created.id, graph: fixture.graph(), actorId: 'user_designer' }));
  return must(await fixture.lifecycle().publish({ templateId: created.id, actorId: 'user_designer' }));
};

describe('A/B. a draft is editable, a published template is not', () => {
  it('A: keeps saving the draft graph and persists every revision', async () => {
    const fixture = make();
    const created = must(
      await fixture.lifecycle().createTemplate({ orgId: 'org_1', name: 'SOP', actorId: 'user_designer' }),
    );
    must(await fixture.lifecycle().saveDraftGraph({ templateId: created.id, graph: fixture.graph(2), actorId: 'user_designer' }));
    const second = must(
      await fixture.lifecycle().saveDraftGraph({ templateId: created.id, graph: fixture.graph(3), actorId: 'user_designer' }),
    );

    expect(second.state).toBe('draft');
    expect(second.versions).toHaveLength(1);
    expect(second.versions[0]?.graph.nodes).toHaveLength(3);
    expect(second.draftVersionId).toBe(second.versions[0]?.id);

    // Survives a reopen.
    fixture.restart();
    const reloaded = (await fixture.lifecycle().readTemplate(created.id)) as WorkflowTemplate;
    expect(reloaded.versions[0]?.graph.nodes).toHaveLength(3);
  });

  it('B: refuses to touch a published template or its released version', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);

    const refusedDraft = await shouldFail(
      await fixture.lifecycle().saveDraftGraph({
        templateId: published.id,
        graph: fixture.graph(4),
        actorId: 'user_designer',
      }),
    );
    expect(refusedDraft.code).toBe('ILLEGAL_TRANSITION');

    // Rewriting the released version through the store is refused too (storage-level law).
    await expect(
      fixture.database().templates.put({
        ...published,
        versions: published.versions.map((version) => ({ ...version, contentHash: 'tampered' })),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    fixture.restart();
    const reloaded = (await fixture.lifecycle().readTemplate(published.id)) as WorkflowTemplate;
    expect(reloaded.state).toBe('published');
    expect(reloaded.versions).toHaveLength(1);
    expect(isVersionIntact(reloaded.versions[0]!)).toBe(true);
  });
});

describe('C/D. fork creates a new draft; a revision publishes a new version', () => {
  it('C: forks into an independent draft with lineage', async () => {
    const fixture = make();
    const source = await publishedTemplate(fixture);
    const clone = must(
      await fixture.lifecycle().fork({ templateId: source.id, name: 'SOP (fork)', actorId: 'user_designer' }),
    );

    expect(clone.id).not.toBe(source.id);
    expect(clone.state).toBe('draft');
    expect(clone.versions).toHaveLength(0);
    expect(clone.forkedFrom?.templateId).toBe(source.id);
    expect(clone.forkedFrom?.versionId).toBe(source.currentVersionId);

    // The source is untouched.
    const untouched = (await fixture.lifecycle().readTemplate(source.id)) as WorkflowTemplate;
    expect(untouched.state).toBe('published');
    expect(untouched.versions).toHaveLength(1);

    // …and the clone is editable (= a real draft).
    must(await fixture.lifecycle().saveDraftGraph({ templateId: clone.id, graph: fixture.graph(3), actorId: 'user_designer' }));
  });

  it('D: publishes a revision as a new immutable version, keeping the old one', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const firstVersionId = published.currentVersionId;

    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'the second step needs an extra validation node',
        summary: 'add validation',
        ops: fixture.ops(),
        actorId: 'user_designer',
      }),
    );
    must(
      await fixture.lifecycle().decideProposal({
        proposalId: proposal.id,
        decision: 'accept',
        actorId: 'user_lead',
        note: 'ok',
      }),
    );
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
    expect(revised.currentVersionId).not.toBe(firstVersionId);
    expect(revised.draftVersionId).toBeNull();
    const semvers = revised.versions.map((version) => version.semver).sort();
    expect(semvers).toEqual(['1.0.0', '1.1.0']);
    expect(revised.versions.every((version) => isVersionIntact(version))).toBe(true);

    // Requirement 9: both hashes are persisted for every version.
    const rows = fixture
      .database()
      .db.prepare(
        'SELECT semver, content_hash, snapshot_hash FROM workflow_template_versions WHERE template_id = ? ORDER BY created_at',
      )
      .all(published.id) as readonly { semver: string; content_hash: string; snapshot_hash: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // The publish window lock is released again (a pin, not a mutex).
    expect(fixture.database().activeLockOf(published.id)).toBeNull();
  });
});

describe('E/F/N. run snapshot binding', () => {
  it('E: an upgraded template does not touch a run created on the old version', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const oldVersionId = published.currentVersionId;

    const created = must(
      await fixture.lifecycle().createRun({
        templateId: published.id,
        companyId: 'cmp_1',
        workflowId: 'wfl_1',
        actorId: 'user_owner',
      }),
    );
    expect(created.run.versionId).toBe(oldVersionId);
    expect(created.snapshot.workflowVersionId).toBe(oldVersionId);

    // Publish 1.1.0 while the run is still IDLE.
    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'upgrade the SOP while a run is pinned to 1.0.0',
        summary: 'upgrade',
        ops: fixture.ops(),
        actorId: 'user_designer',
      }),
    );
    must(await fixture.lifecycle().decideProposal({ proposalId: proposal.id, decision: 'accept', actorId: 'user_lead' }));
    must(
      await fixture.lifecycle().openRevision({
        templateId: published.id,
        proposalId: proposal.id,
        graph: fixture.graph(4),
        actorId: 'user_designer',
      }),
    );
    must(await fixture.lifecycle().publishRevision({ templateId: published.id, actorId: 'user_lead' }));

    // The old run keeps its pinned version and still completes.
    const task = await fixture.engine().drive(created.run.id, {
      stage: { stageId: STAGE_ID, taskIds: [] },
    });
    expect(task.ok).toBe(true);
    const stored = (await fixture.database().runs.get(created.run.id)) as WorkflowRun;
    expect(stored.versionId).toBe(oldVersionId);
    expect(stored.state).toBe('COMPLETED');

    const snapshot = (await fixture.lifecycle().readSnapshot(created.snapshot.snapshotId))!;
    const pinnedVersion = (
      (await fixture.lifecycle().readTemplate(published.id)) as WorkflowTemplate
    ).versions.find((version) => version.id === oldVersionId);
    expect(pinnedVersion?.semver).toBe('1.0.0');
    // The pinned version still carries the ORIGINAL graph (2 nodes), while the template
    // moved on to a 4-node version — so the upgrade really did not touch it.
    expect(pinnedVersion?.graph.nodes).toHaveLength(2);
    expect(
      ((await fixture.lifecycle().readTemplate(published.id)) as WorkflowTemplate).versions.find(
        (version) => version.id !== oldVersionId,
      )?.graph.nodes,
    ).toHaveLength(4);
    expect(verifyRunSnapshot(snapshot, pinnedVersion!)).toEqual({ ok: true, value: true });
  });

  it('F: a new run pins the new version', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const firstVersionId = published.currentVersionId;

    const proposal = must(
      await fixture.lifecycle().openProposal({
        templateId: published.id,
        rationale: 'publish a second version before starting the next run',
        summary: 'upgrade',
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
    const revised = must(
      await fixture.lifecycle().publishRevision({ templateId: published.id, actorId: 'user_lead' }),
    );

    const second = must(
      await fixture.lifecycle().createRun({
        templateId: published.id,
        companyId: 'cmp_1',
        workflowId: 'wfl_1',
        actorId: 'user_owner',
      }),
    );
    expect(second.run.versionId).toBe(revised.currentVersionId);
    expect(second.run.versionId).not.toBe(firstVersionId);
    expect(second.snapshot.workflowVersionId).toBe(revised.currentVersionId);
  });

  it('N: detects snapshot-hash tampering', async () => {
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

    fixture
      .database()
      .db.prepare('UPDATE run_snapshots SET snapshot_hash = ? WHERE id = ?')
      .run('tampered', created.snapshot.snapshotId);

    const snapshot = (await fixture.lifecycle().readSnapshot(created.snapshot.snapshotId))!;
    const version = (published.versions[0] ?? null)!;
    const verified = verifyRunSnapshot(snapshot, version);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.code).toBe('SNAPSHOT_MISMATCH');
  });
});

describe('I/M. archive is read-only, duplicate version numbers are refused', () => {
  it('I: an archived template can be read but never written again', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    must(
      await fixture.lifecycle().deprecate({
        templateId: published.id,
        reason: 'replaced by the fork',
        actorId: 'user_lead',
      }),
    );
    const archived = must(await fixture.lifecycle().archive({ templateId: published.id, actorId: 'user_lead' }));
    expect(archived.state).toBe('archived');

    const refusedDraft = await shouldFail(
      await fixture.lifecycle().saveDraftGraph({ templateId: archived.id, graph: fixture.graph(), actorId: 'user_designer' }),
    );
    expect(refusedDraft.code).toBe('ARCHIVED_READONLY');

    const refusedFork = await shouldFail(
      await fixture.lifecycle().fork({ templateId: archived.id, name: 'nope', actorId: 'user_designer' }),
    );
    expect(refusedFork.code).toBe('ARCHIVED_READONLY');

    const refusedDelete = await fixture.database().templates.delete(archived.id).then(
      () => null,
      (error: { code?: string }) => error,
    );
    expect(refusedDelete?.code).toBe('CONFLICT');

    // Still readable — retention for audit.
    const readable = (await fixture.lifecycle().readTemplate(archived.id)) as WorkflowTemplate;
    expect(readable.state).toBe('archived');
    expect(readable.versions).toHaveLength(1);
  });

  it('M: rejects a duplicate version number', async () => {
    const fixture = make();
    const published = await publishedTemplate(fixture);
    const version = published.versions[0]!;

    const duplicated = await fixture
      .database()
      .templates.put({
        ...published,
        versions: [...published.versions, { ...version, id: 'ver_duplicate' }],
      })
      .then(
        () => null,
        (error: { code?: string; details?: Readonly<Record<string, unknown>> }) => error,
      );
    expect(duplicated?.code).toBe('CONFLICT');
    expect(String(duplicated?.details?.['semver'])).toBe('1.0.0');
  });
});
