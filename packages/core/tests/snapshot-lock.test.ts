/**
 * Sprint 0 acceptance: a run pins an immutable snapshot, and any drift in the
 * pinned fields is detected as `SNAPSHOT_MISMATCH`.
 */
import { describe, expect, it } from 'vitest';

import {
  FixedClock,
  SequenceIdFactory,
  createRunSnapshot,
  createTemplateLock,
  createWorkflowVersion,
  isLockActive,
  releaseTemplateLock,
  unwrap,
  verifyRunSnapshot,
  type WorkflowGraph,
} from '../src/index.js';

const graph: WorkflowGraph = {
  nodes: [{ id: 'n1', kind: 'generic.start', title: 'Start', config: {} }],
  edges: [],
};

const buildFixture = () => {
  const ids = new SequenceIdFactory();
  const clock = new FixedClock();
  const version = createWorkflowVersion({
    templateId: 'tpl_1',
    semver: '1.0.0',
    graph,
    createdBy: 'user_1',
    createdAt: clock.nowIso(),
    ids,
  });
  const lock = unwrap(
    createTemplateLock({
      templateId: version.templateId,
      versionId: version.id,
      scope: 'run',
      reason: 'run in flight',
      lockedBy: 'user_1',
      lockedAt: clock.nowIso(),
      ids,
    }),
  );
  const snapshot = unwrap(
    createRunSnapshot({
      runId: 'run_1',
      orgId: 'org_1',
      version,
      lock,
      packVersions: { 'pack-dev': '1.0.0' },
      memoryViewRef: 'mem_1',
      createdBy: 'user_1',
      createdAt: clock.nowIso(),
      ids,
    }),
  );
  return { ids, clock, version, lock, snapshot };
};

describe('run snapshot', () => {
  it('pins the version, the lock and the pack versions', () => {
    const { snapshot, version, lock } = buildFixture();
    expect(snapshot.workflowVersionId).toBe(version.id);
    expect(snapshot.templateLockId).toBe(lock.id);
    expect(snapshot.packVersions).toEqual({ 'pack-dev': '1.0.0' });
    expect(snapshot.snapshotId).toBe(snapshot.id);
    expect(snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies an untouched snapshot', () => {
    const { snapshot, version } = buildFixture();
    expect(verifyRunSnapshot(snapshot, version).ok).toBe(true);
  });

  it('detects a tampered snapshot and a foreign version', () => {
    const { snapshot, version } = buildFixture();
    const tampered = { ...snapshot, memoryViewRef: 'mem_other' };
    expect(verifyRunSnapshot(tampered, version).ok).toBe(false);

    const foreignVersion = { ...version, id: 'ver_other' };
    const result = verifyRunSnapshot(snapshot, foreignVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SNAPSHOT_MISMATCH');
  });

  it('refuses to pin a draft (non-immutable) version or a released lock', () => {
    const { version, lock, ids, clock } = buildFixture();
    const draft = { ...version, immutable: false } as unknown as typeof version;
    expect(
      createRunSnapshot({
        runId: 'run_2',
        orgId: 'org_1',
        version: draft,
        lock,
        memoryViewRef: 'mem_1',
        createdBy: 'user_1',
        createdAt: clock.nowIso(),
        ids,
      }).ok,
    ).toBe(false);

    const released = unwrap(releaseTemplateLock(lock, { releasedBy: 'user_1', releasedAt: clock.nowIso() }));
    expect(isLockActive(released)).toBe(false);
    expect(
      createRunSnapshot({
        runId: 'run_3',
        orgId: 'org_1',
        version,
        lock: released,
        memoryViewRef: 'mem_1',
        createdBy: 'user_1',
        createdAt: clock.nowIso(),
        ids,
      }).ok,
    ).toBe(false);
  });
});
