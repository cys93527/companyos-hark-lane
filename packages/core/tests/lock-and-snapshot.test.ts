import { describe, expect, it } from 'vitest';

import {
  activeLocksFor,
  assertForkable,
  assertMutable,
  createRunSnapshot,
  createTemplateLock,
  createWorkflowVersion,
  isLockActive,
  lockPolicyFor,
  publishInitialVersion,
  createWorkflowTemplate,
  releaseTemplateLock,
  verifyRunSnapshot,
  type TemplateLock,
} from '@companyos/core';

import { makeCtx, simpleGraph, singleNodeGraph } from './support/fixtures.js';

function fixture() {
  const ctx = makeCtx();
  const draft = createWorkflowTemplate({
    orgId: 'org_acme',
    name: 'SOP',
    actorId: ctx.actorId,
    now: ctx.now,
    ids: ctx.ids,
    traceId: ctx.traceId,
  }).template;
  const published = publishInitialVersion(draft, { graph: simpleGraph(), ctx });
  if (!published.ok) throw new Error('publish failed');
  return { ctx, template: published.value.template, version: published.value.version! };
}

function lock(ctx: ReturnType<typeof makeCtx>, versionId: string, scope: 'run' | 'global'): TemplateLock {
  const result = createTemplateLock({
    templateId: 'tpl_x',
    versionId,
    scope,
    reason: 'run in flight',
    lockedBy: 'user_runner',
    lockedAt: ctx.now,
    ids: ctx.ids,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('template lock and run snapshot', () => {
  it('creates a lock and refuses empty reasons', () => {
    const ctx = makeCtx();
    const created = createTemplateLock({
      templateId: 'tpl_x',
      versionId: 'ver_x',
      scope: 'run',
      reason: 'real reason',
      lockedBy: 'user_runner',
      lockedAt: ctx.now,
      ids: ctx.ids,
    });
    expect(created.ok).toBe(true);
    expect(createTemplateLock({
      templateId: 'tpl_x',
      versionId: 'ver_x',
      scope: 'run',
      reason: '',
      lockedBy: 'user_runner',
      lockedAt: ctx.now,
      ids: ctx.ids,
    }).ok).toBe(false);
  });

  it('blocks mutation while any lock is active and blocks fork only for global scope', () => {
    const run = lock(makeCtx(), 'ver_1', 'run');
    const global = lock(makeCtx(), 'ver_1', 'global');

    expect(assertMutable([run], 'tpl_x').ok).toBe(false);
    expect(assertForkable([run], 'tpl_x').ok).toBe(true);
    expect(assertForkable([global], 'tpl_x').ok).toBe(false);
    expect(assertMutable([], 'tpl_x').ok).toBe(true);

    const blocked = assertMutable([run], 'tpl_x');
    if (!blocked.ok) expect(blocked.error.code).toBe('LOCKED_TEMPLATE');
  });

  it('releases a lock once and refuses a double release', () => {
    const ctx = makeCtx();
    const created = lock(ctx, 'ver_1', 'run');
    const released = releaseTemplateLock(created, { releasedBy: 'user_owner', releasedAt: ctx.now });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(isLockActive(released.value)).toBe(false);
    expect(activeLocksFor([released.value], 'tpl_x')).toHaveLength(0);
    const twice = releaseTemplateLock(released.value, { releasedBy: 'user_owner', releasedAt: ctx.now });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error.code).toBe('CONFLICT');
  });

  it('derives a lock policy per template state', () => {
    const { template } = fixture();
    const global = { ...lock(makeCtx(), 'ver_1', 'global'), templateId: template.id };
    const policy = lockPolicyFor(template, [global]);
    expect(policy.mutable).toBe(false);
    expect(policy.forkable).toBe(false);
    expect(policy.reason).toContain('locked by');
    expect(lockPolicyFor(template, []).mutable).toBe(true);
  });

  it('pins a run to an immutable version + active lock and detects tampering', () => {
    const { ctx, version } = fixture();
    const templateLock = { ...lock(ctx, version.id, 'run'), templateId: version.templateId };
    const snapshot = createRunSnapshot({
      runId: 'run_1',
      orgId: 'org_acme',
      version,
      lock: templateLock,
      packVersions: { 'pack-devcompany': '0.1.0' },
      memoryViewRef: 'memview_run_1',
      createdBy: 'user_runner',
      createdAt: ctx.now,
      ids: ctx.ids,
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.snapshotId).toBe(snapshot.value.id);
    expect(snapshot.value.snapshotHash).toHaveLength(64);
    expect(verifyRunSnapshot(snapshot.value, version).ok).toBe(true);

    const tampered = { ...snapshot.value, memoryViewRef: 'memview_run_2' };
    const verdict = verifyRunSnapshot(tampered, version);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('SNAPSHOT_MISMATCH');

    const otherVersion = createWorkflowVersion({
      templateId: version.templateId,
      semver: '9.9.9',
      graph: singleNodeGraph('other'),
      createdBy: ctx.actorId,
      createdAt: ctx.now,
      ids: ctx.ids,
    });
    const mismatch = verifyRunSnapshot(snapshot.value, otherVersion);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('SNAPSHOT_MISMATCH');
  });

  it('refuses a snapshot that does not pin an active lock on its version', () => {
    const { ctx, version } = fixture();
    const staleLock = {
      ...lock(ctx, version.id, 'run'),
      templateId: version.templateId,
      releasedAt: ctx.now,
      releasedBy: 'user_owner',
    };
    const result = createRunSnapshot({
      runId: 'run_2',
      orgId: 'org_acme',
      version,
      lock: staleLock,
      memoryViewRef: 'memview',
      createdBy: 'user_runner',
      createdAt: ctx.now,
      ids: ctx.ids,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('LOCKED_TEMPLATE');
  });
});
