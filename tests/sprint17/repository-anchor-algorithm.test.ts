import {registerOfflineCommonJsFixture} from '../support/offline-fixtures.js';
/**
 * Sprint 17 / Task-17-05 CORRECTIVE (part 2) — the index identity is a REAL input, and the
 * corrected algorithm is the one every consumer uses.
 *
 * §26 asserts something stronger than "the anchor changed": there must be a state pair that
 * is IDENTICAL in everything the old inputs could see (HEAD, branch, XY class, path, and the
 * working-tree bytes) and STILL produces different anchors. That is only possible if the
 * staged index object identity is an independent input.
 *
 * It also proves the ONE algorithm is shared: repo.git, the QA tools' pre/post anchors and
 * `getCurrentAnchor()` all move together (there is no per-consumer variant), and the anchors
 * a QA success stores survive a restart through the durable replay snapshot.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REPOSITORY_GIT_TOOL_SPEC,
  REPOSITORY_PROCESS_TOOL_SPECS,
  createAuthorizationService,
  createRepositoryGitToolPort,
  createRepositoryGitToolRecord,
  createRepositoryProcessRunner,
  createRepositoryProcessToolPort,
  createRepositoryProcessToolRecord,
  createRepositoryRevisionAnchorProvider,
  createToolRegistry,
  createWorkspaceManager,
  ensureBootstrapOwner,
} from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17alg-'));
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
  id: (prefix = 'id') => `${prefix}_17Y${String(++seq).padStart(10, '0')}`,
  ulid: () => `17Y${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const QA_SCRIPT = `process.stdout.write('qa run' + String.fromCharCode(10));process.exit(0);`;

/** HEAD = A, INDEX = B, WORKTREE = C for one tracked file. */
const threeLayerState = (): ReturnType<typeof createGitFixture> => {
  const repo = createGitFixture();
  repo.write('a.txt', 'A\n');
  commitAll(repo, 'initial');
  repo.write('a.txt', 'B\n');
  repo.git(['add', 'a.txt']);
  repo.write('a.txt', 'C\n');
  return repo;
};

describe('the corrected anchor algorithm is shared and irreducible (T17-05 corrective)', () => {
  it('26. cannot be reconstructed from HEAD + branch + XY + path + worktree bytes', async () => {
    const repo = threeLayerState();
    const scriptDir = tempDir();
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
    const opened = await manager.openWorkspace({ root: repo.dir, commandProfile: {} });
    if (!opened.ok) throw new Error(opened.error.message);
    const runner = createRepositoryProcessRunner({
      clock,
      timer: (ms, onTimeout) => {
        const handle = setTimeout(onTimeout, ms);
        return () => clearTimeout(handle);
      },
    });
    const provider = createRepositoryRevisionAnchorProvider({
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
      anchorProvider: provider,
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
    const gitRecord = createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, nowIso());
    if (!gitRecord.ok) throw new Error(gitRecord.error.message);
    await registry.register(gitRecord.value, { actorId: actor });
    const invokeGit = async (op: string) => {
      const outcome = await registry.invoke({
        toolId: 'repo.git',
        executionId: ids.id('exc'),
        agentId: ids.id('agt'),
        taskId: ids.id('tsk'),
        runId: ids.id('run'),
        actorId: actor,
        input: { op },
        idempotencyKey: `alg:${op}:${String(++seq)}:${nowIso()}`,
      });
      if (!outcome.ok) throw new Error(outcome.error.message);
      return outcome.value.output as Record<string, unknown>;
    };

    // State 1: HEAD=A, INDEX=B, WORKTREE=C.
    const providerAnchor1 = await provider.getCurrentAnchor();
    expect(providerAnchor1.supported).toBe(true);
    if (!providerAnchor1.supported) return;
    const toolAnchor1 = await invokeGit('baseline');
    // The repo.git tool and the provider agree (ONE algorithm, not two).
    const anchor1 = toolAnchor1['anchor'] as Record<string, unknown>;
    expect(anchor1['workingTreeFingerprint']).toBe(providerAnchor1.anchor.workingTreeFingerprint);

    // Everything the OLD inputs could see stays identical: same HEAD, same branch, same XY
    // class, same path, and the SAME working-tree bytes.
    const statusBefore = repo.git(['status', '--porcelain=v2', 'a.txt']).stdout.trim();
    expect(statusBefore.startsWith('1 MM')).toBe(true);
    const worktreeBefore = repo.read('a.txt');

    // Only the staged blob moves B -> D (test setup only).
    const stagedD = repo.git(['hash-object', '-w', '--stdin'], 'D\n').stdout.trim();
    expect(stagedD).toMatch(/^[0-9a-f]{40}$/);
    const swapped = repo.git(['update-index', '--cacheinfo', `100644,${stagedD},a.txt`]);
    expect(swapped.status).toBe(0);

    const statusAfter = repo.git(['status', '--porcelain=v2', 'a.txt']).stdout.trim();
    expect(statusAfter.startsWith('1 MM')).toBe(true);
    expect(repo.read('a.txt')).toBe(worktreeBefore);
    // Only the index object id differs in the porcelain line.
    expect(statusAfter.slice(0, statusAfter.indexOf(' a.txt'))).not.toBe(
      statusBefore.slice(0, statusBefore.indexOf(' a.txt')),
    );

    const providerAnchor2 = await provider.getCurrentAnchor();
    const toolAnchor2 = await invokeGit('baseline');
    const anchor2 = toolAnchor2['anchor'] as Record<string, unknown>;
    expect(providerAnchor2.supported).toBe(true);
    if (!providerAnchor2.supported) return;
    expect(providerAnchor2.anchor.workingTreeFingerprint).toBe(anchor2['workingTreeFingerprint']);
    // Therefore the anchor is NOT a function of (HEAD, branch, XY, path, worktree bytes).
    expect(anchor2['workingTreeFingerprint']).not.toBe(anchor1['workingTreeFingerprint']);
    expect(anchor2['headSha']).toBe(anchor1['headSha']);
    void scriptDir;
    repo.dispose();
  });

  it('11-12. QA pre/post anchors use the corrected algorithm and survive a restart', async () => {
    const repo = threeLayerState();
    const scriptDir = tempDir();
    writeFileSync(join(scriptDir, 'qa.js'), QA_SCRIPT, 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'qa.js'));
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
    });
    const anchors = createRepositoryRevisionAnchorProvider({
      workspace: () => manager.current(),
      runner,
      gitExecutable: 'git',
      timeoutMs: REPOSITORY_GIT_TOOL_SPEC.timeoutMs,
    });
    const spec = REPOSITORY_PROCESS_TOOL_SPECS.find((entry) => entry.toolId === 'repo.test-runner');
    if (spec === undefined) throw new Error('no spec');
    const opened = await manager.openWorkspace({
      root: repo.dir,
      commandProfile: {
        tests: {
          commandKey: 'tests',
          executable: process.execPath,
          baseArgv: [join(scriptDir, 'qa.js')],
          cwd: 'workspace-root',
          safeEnvAdditions: {},
        },
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const registry = createToolRegistry({
      ids,
      clock,
      records: db.toolRecords,
      invocations: db.toolInvocations,
      invocationArtifacts: db.toolInvocationArtifacts,
      adapters: new Map([
        [
          'repo.test-runner',
          createRepositoryProcessToolPort(spec, {
            workspace: () => manager.current(),
            clock,
            runner,
            anchorProvider: anchors,
          }),
        ],
      ]),
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
    const record = createRepositoryProcessToolRecord(spec, nowIso());
    if (!record.ok) throw new Error(record.error.message);
    await registry.register(record.value, { actorId: actor });

    // The provider reading of the CURRENT (three-layer) state.
    const before = await anchors.getCurrentAnchor();
    expect(before.supported).toBe(true);
    if (!before.supported) return;

    // A QA success anchors the state it STARTED from.
    const qa = await registry.invoke({
      toolId: 'repo.test-runner',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: ids.id('tsk'),
      runId: ids.id('run'),
      actorId: actor,
      input: {},
    });
    expect(qa.ok).toBe(true);
    if (!qa.ok) return;
    const firstOutput = qa.value.output as Record<string, unknown>;
    const firstPre = firstOutput['preAnchor'] as Record<string, unknown>;
    // The QA tool's preAnchor agrees with the provider (ONE algorithm, index-aware).
    expect(firstPre['workingTreeFingerprint']).toBe(before.anchor.workingTreeFingerprint);

    // Only the staged blob moves B -> D; the QA tool must see the new index state.
    const stagedD = repo.git(['hash-object', '-w', '--stdin'], 'D' + String.fromCharCode(10)).stdout.trim();
    repo.git(['update-index', '--cacheinfo', `100644,${stagedD},a.txt`]);
    const after = await anchors.getCurrentAnchor();
    expect(after.supported).toBe(true);
    if (!after.supported) return;

    const second = await registry.invoke({
      toolId: 'repo.test-runner',
      executionId: ids.id('exc'),
      agentId: ids.id('agt'),
      taskId: ids.id('tsk'),
      runId: ids.id('run'),
      actorId: actor,
      input: {},
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondInvocationId = second.value.invocationId;
    const secondOutput = second.value.output as Record<string, unknown>;
    const pre = secondOutput['preAnchor'] as Record<string, unknown>;
    const post = secondOutput['postAnchor'] as Record<string, unknown>;
    // The second run's preAnchor is the NEW (index-aware) state, and it differs from the first.
    expect(pre['workingTreeFingerprint']).toBe(after.anchor.workingTreeFingerprint);
    expect(pre['workingTreeFingerprint']).not.toBe(firstPre['workingTreeFingerprint']);
    // Nothing mutated during the run, so post equals pre.
    expect(post['workingTreeFingerprint']).toBe(pre['workingTreeFingerprint']);

    // The anchors are durable through the replay snapshot (restart recovery).
    const durable = await db.toolInvocations.get(secondInvocationId);
    const replay = durable?.replayOutput as Record<string, unknown> | undefined;
    expect((replay?.['postAnchor'] as Record<string, unknown> | undefined)?.['workingTreeFingerprint']).toBe(
      post['workingTreeFingerprint'],
    );
    repo.dispose();
  });
});
