import {registerOfflineCommonJsFixture,registerOfflineGitWorkspace} from '../support/offline-fixtures.js';
/**
 * Sprint 17 / Task-17-05 — QA process tools under revision anchoring (§41–§46).
 *
 * A QA command's value as future evidence is that it can prove WHICH repository state it ran
 * against. These tests therefore drive the four QA tools through the REAL registry with the
 * shared anchor provider attached: a success stores pre/post anchors, a repository-mutating
 * command produces DIFFERENT anchors (a fact the T17-06 validator will judge), the anchors
 * survive a restart through the durable replay snapshot, and a workspace with no supported
 * Git repository fails closed instead of returning an unverifiable success.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REPOSITORY_GIT_TOOL_SPEC,
  REPOSITORY_PROCESS_TOOL_SPECS,
  createAuthorizationService,
  createRepositoryProcessRunner,
  createRepositoryProcessToolPort,
  createRepositoryProcessToolRecord,
  createRepositoryRevisionAnchorProvider,
  createToolRegistry,
  createWorkspaceManager,
  ensureBootstrapOwner,
} from '@companyos/engine';
import { createFilesystemArtifactContentStore, openDurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17qa-'));
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
  id: (prefix = 'id') => `${prefix}_17Q${String(++seq).padStart(10, '0')}`,
  ulid: () => `17Q${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

const OK_SCRIPT = `process.stdout.write('clean run' + String.fromCharCode(10));process.exit(0);`;
/** A command that MUTATES the repository (writes an untracked file into the workspace). */
const MUTATING_SCRIPT = `require('node:fs').writeFileSync(process.cwd() + '/MUTATED', 'written by the command');process.stdout.write('mutated' + String.fromCharCode(10));process.exit(0);`;

const specOf = (toolId: string) => {
  const spec = REPOSITORY_PROCESS_TOOL_SPECS.find((entry) => entry.toolId === toolId);
  if (spec === undefined) throw new Error(`no spec for ${toolId}`);
  return spec;
};

/** A registry with ONE QA tool, the shared runner and the shared anchor provider. */
const makeGraph = async (
  workspaceRoot: string,
  script: 'ok' | 'mutating' = 'ok',
): Promise<{
  readonly db: ReturnType<typeof openDurableDatabase>;
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly actor: string;
  readonly invoke: (toolId: string) => Promise<
    | { readonly ok: true; readonly status: string; readonly output: unknown }
    | { readonly ok: false; readonly error: { code: string; details: Record<string, unknown> } }
  >;
}> => {
  const scriptDir = tempDir();
  registerOfflineGitWorkspace(workspaceRoot);
  writeFileSync(join(scriptDir, 'ok.js'), OK_SCRIPT, 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'ok.js'));
  writeFileSync(join(scriptDir, 'mutating.js'), MUTATING_SCRIPT, 'utf8');
  registerOfflineCommonJsFixture(join(scriptDir, 'mutating.js'));
  const casRoot = tempDir();
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
    contentStore: createFilesystemArtifactContentStore({ casRoot }),
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
  const spec = specOf('repo.test-runner');
  const opened = await manager.openWorkspace({
    root: workspaceRoot,
    commandProfile: {
      tests: {
        commandKey: 'tests',
        executable: process.execPath,
        baseArgv: [join(scriptDir, `${script}.js`)],
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
  return {
    db,
    registry,
    actor,
    invoke: async (toolId) => {
      const outcome = await registry.invoke({
        toolId,
        executionId: ids.id('exc'),
        agentId: ids.id('agt'),
        taskId: ids.id('tsk'),
        runId: ids.id('run'),
        actorId: actor,
        input: {},
      });
      if (!outcome.ok) {
        return { ok: false as const, error: { code: outcome.error.code, details: outcome.error.details } };
      }
      return { ok: true as const, status: outcome.value.status, output: outcome.value.output };
    },
  };
};

const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

describe('QA process tools under revision anchoring (T17-05)', () => {
  it('30-32. stores pre/post anchors on success and keeps them across a restart', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'alpha\n');
    commitAll(repo, 'initial');
    const graph = await makeGraph(repo.dir);

    const first = await graph.invoke('repo.test-runner');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.status).toBe('COMPLETED');
    const output = record(first.output);
    const pre = record(output['preAnchor']);
    const post = record(output['postAnchor']);
    expect(String(pre['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(post['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(first.output)).not.toContain(repo.dir);

    // The anchors are durable through the replay snapshot.
    const durable = (await graph.db.toolInvocations.list({ limit: 10 })).items.find(
      (item) => item.toolId === 'repo.test-runner',
    );
    const replay = durable?.replayOutput as Record<string, unknown> | undefined;
    expect(String(record(replay?.['postAnchor'])['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    repo.dispose();
  });

  it('31. records a repository-mutating command as DIFFERENT pre/post anchors', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'alpha\n');
    commitAll(repo, 'initial');
    // The COMMAND itself mutates the repository between the two anchors.
    const graph = await makeGraph(repo.dir, 'mutating');
    const outcome = await graph.invoke('repo.test-runner');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const output = record(outcome.output);
    const pre = record(output['preAnchor']);
    const post = record(output['postAnchor']);
    if (pre['workingTreeFingerprint'] === post['workingTreeFingerprint']) {
      console.log('DEBUG pre:', JSON.stringify(pre), 'post:', JSON.stringify(post));
    }
    expect(pre['workingTreeFingerprint']).not.toBe(post['workingTreeFingerprint']);
    expect(post['dirtyFiles']).toEqual(['MUTATED']);
    // T17-05 records the FACT only: the invocation stays COMPLETED, the validator decides.
    expect(outcome.status).toBe('COMPLETED');
    repo.dispose();
  });

  it('42. fails closed without a supported Git repository', async () => {
    const plain = tempDir();
    const graph = await makeGraph(plain);
    const outcome = await graph.invoke('repo.test-runner');
    // No unverifiable QA success: the tool refuses before spawning anything.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('NOT_A_GIT_REPOSITORY');
  });
});
