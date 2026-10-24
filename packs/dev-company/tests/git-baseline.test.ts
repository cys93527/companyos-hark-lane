/**
 * DevCompany pack fixture — Sprint 17 / Task-17-05 git baseline (roadmap naming; AC17.2).
 *
 * IMPORTANT: this file only exercises the GENERIC repository runtime (the engine's read-only
 * Git tool + repository revision anchor). Nothing here is a DevCompany product behaviour, and
 * no implementation lives in the Pack — DevCompany 1.0.0 stays DATA/CONFIG ONLY and immutable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REPOSITORY_GIT_TOOL_SPEC,
  createAuthorizationService,
  createRepositoryGitToolPort,
  createRepositoryGitToolRecord,
  createRepositoryProcessRunner,
  createRepositoryRevisionAnchorProvider,
  createToolRegistry,
  createWorkspaceManager,
  ensureBootstrapOwner,
} from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture } from '../../../tests/git-fixture.js';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17dc-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

let seq = 0;
const ids = {
  id: (prefix = 'id') => `${prefix}_17D${String(++seq).padStart(10, '0')}`,
  ulid: () => `17D${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

describe('repository git baseline (generic runtime)', () => {
  it('produces a baseline the way a real Task-start would consume it', async () => {
    const repo = createGitFixture();
    repo.write('src/app.ts', 'export const one = 1;\n');
    commitAll(repo, 'initial');
    repo.write('src/app.ts', 'export const one = 2;\n');

    const db = openDurableDatabase({
      dataDir: tempDir(),
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'provider', 'tools', 'artifact'],
    });
    openDatabases.push(db);
    const actor = 'user_owner';
    const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
    const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);

    const manager = createWorkspaceManager();
    const runner = createRepositoryProcessRunner({
      clock,
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
      contentStore: undefined,
      resolveExecutionId: async (invocationId) => {
        const invocation = await db.toolInvocations.get(invocationId);
        return invocation === null ? null : invocation.executionId;
      },
    });
    const anchors = createRepositoryRevisionAnchorProvider({
      workspace: () => manager.current(),
      runner,
      gitExecutable: 'git',
      timeoutMs: REPOSITORY_GIT_TOOL_SPEC.timeoutMs,
    });
    const gitPort = createRepositoryGitToolPort(REPOSITORY_GIT_TOOL_SPEC, {
      workspace: () => manager.current(),
      clock,
      runner,
      gitExecutable: 'git',
      timeoutMs: REPOSITORY_GIT_TOOL_SPEC.timeoutMs,
      anchorProvider: anchors,
    });
    const registry = createToolRegistry({
      ids,
      clock,
      records: db.toolRecords,
      invocations: db.toolInvocations,
      invocationArtifacts: db.toolInvocationArtifacts,
      adapters: new Map([['repo.git', gitPort]]),
      authorize: async (input) => authz.decide(input),
      events: db.events,
      secrets: async () => [],
      ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
      ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });
    const record = createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, nowIso());
    if (!record.ok) throw new Error(record.error.message);
    const registered = await registry.register(record.value, { actorId: actor });
    if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);

    const runId = ids.id('run');
    const taskId = ids.id('tsk');
    const opened = await manager.openWorkspace({ root: repo.dir, commandProfile: {} });
    if (!opened.ok) throw new Error(opened.error.message);

    // A baseline invocation, carrying the run/task anchors a real Task start would supply.
    const baseline = await registry.invoke({
      toolId: 'repo.git',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId,
      runId,
      actorId: actor,
      input: { op: 'baseline' },
      idempotencyKey: 'devcompany-git-baseline',
    });
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const value = baseline.value.output as Record<string, unknown>;
    const anchor = value['anchor'] as Record<string, unknown>;
    expect(String(anchor['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(value['dirtyFiles']).toEqual(['src/app.ts']);
    expect(JSON.stringify(baseline.value.output)).not.toContain(repo.dir);

    // The baseline is DURABLE evidence with its run/task anchors.
    const durable = (await db.toolInvocations.list({ limit: 5 })).items[0];
    expect(durable?.toolId).toBe('repo.git');
    expect(durable?.status).toBe('COMPLETED');
    expect(durable?.runId).toBe(runId);
    expect(durable?.taskId).toBe(taskId);

    // The current anchor changes once the working tree changes again (§47 provider API).
    const before = await anchors.getCurrentAnchor();
    repo.write('src/app.ts', 'export const one = 3;\n');
    const after = await anchors.getCurrentAnchor();
    expect(before.supported && after.supported).toBe(true);
    if (!before.supported || !after.supported) return;
    expect(before.anchor.workingTreeFingerprint).not.toBe(after.anchor.workingTreeFingerprint);
    repo.dispose();
  });

  it('refuses to operate on a parent repository that merely contains the workspace', async () => {
    const parent = createGitFixture();
    parent.write('seed.txt', 'seed\n');
    commitAll(parent, 'initial');
    const child = join(parent.dir, 'workspace-child');
    const fs = await import('node:fs');
    fs.mkdirSync(child, { recursive: true });

    const db = openDurableDatabase({
      dataDir: tempDir(),
      appliedAt: nowIso(),
      chains: ['core', 'engine', 'provider', 'tools'],
    });
    openDatabases.push(db);
    const actor = 'user_owner';
    const authz = createAuthorizationService({ ids, clock, roles: db.roles, assignments: db.roleAssignments });
    const bootstrap = await ensureBootstrapOwner(authz, { actorId: actor, companyId: 'company_default' });
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    const manager = createWorkspaceManager();
    const runner = createRepositoryProcessRunner({
      clock,
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
      resolveExecutionId: async () => null,
    });
    const anchors = createRepositoryRevisionAnchorProvider({
      workspace: () => manager.current(),
      runner,
      gitExecutable: 'git',
      timeoutMs: REPOSITORY_GIT_TOOL_SPEC.timeoutMs,
    });
    const gitPort = createRepositoryGitToolPort(REPOSITORY_GIT_TOOL_SPEC, {
      workspace: () => manager.current(),
      clock,
      runner,
      gitExecutable: 'git',
      timeoutMs: REPOSITORY_GIT_TOOL_SPEC.timeoutMs,
      anchorProvider: anchors,
    });
    const registry = createToolRegistry({
      ids,
      clock,
      records: db.toolRecords,
      invocations: db.toolInvocations,
      invocationArtifacts: db.toolInvocationArtifacts,
      adapters: new Map([['repo.git', gitPort]]),
      authorize: async (input) => authz.decide(input),
      events: db.events,
      secrets: async () => [],
      ...(db.toolInvocationClaims === null ? {} : { claims: db.toolInvocationClaims }),
      ...(db.toolInvocationIndex === null ? {} : { invocationIndex: db.toolInvocationIndex }),
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });
    const record = createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, nowIso());
    if (!record.ok) throw new Error(record.error.message);
    await registry.register(record.value, { actorId: actor });
    const opened = await manager.openWorkspace({ root: child, commandProfile: {} });
    if (!opened.ok) throw new Error(opened.error.message);
    const outcome = await registry.invoke({
      toolId: 'repo.git',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: ids.id('tsk'),
      runId: ids.id('run'),
      actorId: actor,
      input: { op: 'baseline' },
      idempotencyKey: 'devcompany-git-parent-escape',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('GIT_ROOT_OUTSIDE_WORKSPACE');
    parent.dispose();
  });
});
