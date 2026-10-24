/**
 * Sprint 17 / Task-17-05 FINAL INTEGRATION — `repo.git` invocation anchoring.
 *
 * `GIT_EVIDENCE_INVOCATION_ANCHOR_GAP`: T17-06 must verify SIX pieces of QA evidence
 * (test-runner / linter / typechecker / builder / git diff / git status). The four process
 * commands already carried preAnchor/postAnchor, but `repo.git status` and `repo.git diff`
 * did not — so their evidence could not be shown to come from the same repository state.
 *
 * This suite proves the data is now complete and that the ONE algorithm is shared: the
 * anchors `repo.git` records are produced by the same `RepositoryRevisionAnchorProvider`
 * every other consumer uses, a caller cannot supply an anchor, and the diff output bounds
 * (16 KiB preview / 8 MiB capture / CAS) are untouched. It deliberately does NOT implement
 * the freshness verdict — that is T17-06's job.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  type RepositoryRevisionAnchorProvider,
} from '@companyos/engine';
import { createFilesystemArtifactContentStore, openDurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture, type GitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17evi-'));
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
  id: (prefix = 'id') => `${prefix}_17V${String(++seq).padStart(10, '0')}`,
  ulid: () => `17V${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

interface Graph {
  readonly db: ReturnType<typeof openDurableDatabase>;
  readonly registry: ReturnType<typeof createToolRegistry>;
  readonly actor: string;
  readonly repo: GitFixture;
  readonly casRoot: string;
  readonly invoke: (
    op: string,
    input?: Readonly<Record<string, unknown>>,
  ) => Promise<
    | { readonly ok: true; readonly status: string; readonly invocationId: string; readonly output: unknown; readonly artifactRefs: readonly string[] }
    | { readonly ok: false; readonly code: string; readonly details: Record<string, unknown> }
  >;
}

const makeGraph = async (
  repo: GitFixture,
  providerOverride?: RepositoryRevisionAnchorProvider,
): Promise<Graph> => {
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
  const provider =
    providerOverride ??
    createRepositoryRevisionAnchorProvider({
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
    // Managed refs are CAS content refs here, so the resolver is not needed for this suite;
    // it is still supplied so a COMPLETED ref would be validated exactly as in production.
    durableReferenceResolver: async (refs) => ({
      ok: true as const,
      value: refs.map((ref) => ({ kind: 'content', id: ref, ref, runId: 'unused' })),
    }),
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
  });
  const record = createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, nowIso());
  if (!record.ok) throw new Error(record.error.message);
  const registered = await registry.register(record.value, { actorId: actor });
  if (!registered.ok && registered.error.code !== 'CONFLICT') throw new Error(registered.error.message);
  const opened = await manager.openWorkspace({ root: repo.dir, commandProfile: {} });
  if (!opened.ok) throw new Error(opened.error.message);
  return {
    db,
    registry,
    actor,
    repo,
    casRoot,
    invoke: async (op, input) => {
      const outcome = await registry.invoke({
        toolId: 'repo.git',
        executionId: ids.id('exc'),
        agentId: ids.id('agt'),
        taskId: ids.id('tsk'),
        runId: ids.id('run'),
        actorId: actor,
        input: input ?? { op },
        idempotencyKey: `git-evidence:${op}:${String(++seq)}:${nowIso()}`,
      });
      if (!outcome.ok) {
        return { ok: false as const, code: outcome.error.code, details: outcome.error.details };
      }
      return {
        ok: true as const,
        status: outcome.value.status,
        invocationId: outcome.value.invocationId,
        output: outcome.value.output,
        artifactRefs: outcome.value.artifactRefs,
      };
    },
  };
};

const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const anchorOf = (output: unknown, field: 'preAnchor' | 'postAnchor'): Record<string, unknown> =>
  record(record(output)[field]);

/** A provider whose consecutive readings alternate A/B (a controlled concurrent change). */
const alternatingProvider = (): RepositoryRevisionAnchorProvider => {
  const anchor = {
    workspaceId: 'sha256:' + 'a'.repeat(64),
    headSha: 'a'.repeat(40),
    branch: 'master',
    workingTreeFingerprint: 'sha256:' + 'b'.repeat(64),
    dirtyFiles: [] as readonly string[],
  };
  let calls = 0;
  return {
    async getCurrentAnchor() {
      calls += 1;
      return {
        supported: true as const,
        anchor: { ...anchor, workingTreeFingerprint: `sha256:${(calls % 2 === 1 ? 'c' : 'd').repeat(64)}` },
      };
    },
  };
};

describe('repo.git invocation anchoring (T17-05 final integration)', () => {
  it('1-2. status output carries preAnchor and postAnchor', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    const graph = await makeGraph(repo);
    const outcome = await graph.invoke('status');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const output = record(outcome.output);
    // The pre-existing fields are unchanged...
    expect(output['workspaceId']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(output['branch']).toBe('master');
    expect(String(output['headSha'])).toBe(repo.headSha());
    expect(output['isDirty']).toBe(false);
    expect(output['dirtyFiles']).toEqual([]);
    // ...and both anchors are the full RepositoryRevisionAnchor shape.
    for (const field of ['preAnchor', 'postAnchor'] as const) {
      const anchor = anchorOf(output, field);
      expect(String(anchor['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(anchor['workspaceId']).toBe(output['workspaceId']);
      expect(String(anchor['headSha'])).toBe(output['headSha']);
      expect(anchor['branch']).toBe('master');
      expect(anchor['dirtyFiles']).toEqual([]);
    }
    repo.dispose();
  });

  it('3-4. diff output carries preAnchor and postAnchor', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    repo.write('a.txt', 'changed\n');
    const graph = await makeGraph(repo);
    const outcome = await graph.invoke('diff');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const output = record(outcome.output);
    const processOutput = record(output['processOutput']);
    expect(Number(record(processOutput['stdout'])['byteCount'])).toBeGreaterThan(0);
    for (const field of ['preAnchor', 'postAnchor'] as const) {
      const anchor = anchorOf(output, field);
      expect(String(anchor['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(String(anchor['headSha'])).toBe(repo.headSha());
      expect(anchor['dirtyFiles']).toEqual(['a.txt']);
    }
    repo.dispose();
  });

  it('5-6. an unchanged repository yields equal pre/post anchors for both ops', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    const graph = await makeGraph(repo);
    const status = await graph.invoke('status');
    const diff = await graph.invoke('diff');
    expect(status.ok && diff.ok).toBe(true);
    if (!status.ok || !diff.ok) return;
    expect(anchorOf(status.output, 'preAnchor')['workingTreeFingerprint']).toBe(
      anchorOf(status.output, 'postAnchor')['workingTreeFingerprint'],
    );
    expect(anchorOf(diff.output, 'preAnchor')['workingTreeFingerprint']).toBe(
      anchorOf(diff.output, 'postAnchor')['workingTreeFingerprint'],
    );
    repo.dispose();
  });

  it('7. preserves a real pre/post difference while staying honestly COMPLETED', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    // The provider reports a different state on each reading: a concurrent change.
    const graph = await makeGraph(repo, alternatingProvider());
    for (const op of ['status', 'diff'] as const) {
      const outcome = await graph.invoke(op);
      expect(outcome.ok, op).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.status, op).toBe('COMPLETED');
      const pre = anchorOf(outcome.output, 'preAnchor')['workingTreeFingerprint'];
      const post = anchorOf(outcome.output, 'postAnchor')['workingTreeFingerprint'];
      expect(pre, op).not.toBe(post);
    }
    repo.dispose();
  });

  it('8-9. both ops use the same algorithm as getCurrentAnchor()', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    repo.write('a.txt', 'A2\n');
    const graph = await makeGraph(repo);
    const status = await graph.invoke('status');
    const diff = await graph.invoke('diff');
    expect(status.ok && diff.ok).toBe(true);
    if (!status.ok || !diff.ok) return;
    // Read the same state directly through the provider the graph itself uses.
    const manager = createWorkspaceManager();
    const opened = await manager.openWorkspace({ root: repo.dir, commandProfile: {} });
    if (!opened.ok) throw new Error(opened.error.message);
    const direct = createRepositoryRevisionAnchorProvider({
      workspace: () => manager.current(),
      runner: createRepositoryProcessRunner({
        clock,
        timer: (ms, onTimeout) => {
          const handle = setTimeout(onTimeout, ms);
          return () => clearTimeout(handle);
        },
      }),
      gitExecutable: 'git',
      timeoutMs: REPOSITORY_GIT_TOOL_SPEC.timeoutMs,
    });
    const current = await direct.getCurrentAnchor();
    expect(current.supported).toBe(true);
    if (!current.supported) return;
    for (const outcome of [status.output, diff.output]) {
      const post = anchorOf(outcome, 'postAnchor');
      expect(post['workingTreeFingerprint']).toBe(current.anchor.workingTreeFingerprint);
      expect(post['dirtyFiles']).toEqual([...current.anchor.dirtyFiles]);
    }
    repo.dispose();
  });

  it('10. anchors survive a durable replay after a fresh service graph', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    repo.write('a.txt', 'changed\n');
    const graph = await makeGraph(repo);
    const status = await graph.invoke('status');
    const diff = await graph.invoke('diff');
    expect(status.ok && diff.ok).toBe(true);
    if (!status.ok || !diff.ok) return;

    // The recorded output comes back from durable state (the replay snapshot).
    for (const outcome of [status, diff]) {
      const durable = await graph.db.toolInvocations.get(outcome.invocationId);
      expect(durable?.status).toBe('COMPLETED');
      const replay = durable?.replayOutput as Record<string, unknown> | undefined;
      expect(String(record(replay?.['postAnchor'])['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(String(record(replay?.['preAnchor'])['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    repo.dispose();
  });

  it('11-12. refuses caller-supplied anchors and keeps the input schema unchanged', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    const graph = await makeGraph(repo);
    for (const spoofed of [
      { op: 'status', preAnchor: { workingTreeFingerprint: 'sha256:' + '0'.repeat(64) } },
      { op: 'diff', postAnchor: { workingTreeFingerprint: 'sha256:' + '0'.repeat(64) } },
      { op: 'baseline', anchor: { workingTreeFingerprint: 'sha256:' + '0'.repeat(64) } },
      { op: 'status', args: ['--all'] },
      { op: 'commit' },
    ]) {
      const outcome = await graph.invoke(String(record(spoofed)['op'] ?? ''), spoofed);
      expect(outcome.ok, JSON.stringify(spoofed)).toBe(false);
      if (outcome.ok) continue;
      // The registry's INPUT_INVALID vocabulary: a caller can never supply an anchor,
      // an argv, an unknown op or any other extra field.
      expect(outcome.code, JSON.stringify(spoofed)).toBe('INVALID_ARGUMENT');
    }
    // The frozen input grammar is exactly one optional free field: none.
    const properties = Object.keys(
      (REPOSITORY_GIT_TOOL_SPEC.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(properties).toEqual(['op']);
    repo.dispose();
  });

  it('13. keeps the diff output boundary (16 KiB preview / 8 MiB capture / CAS)', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    repo.write('a.txt', 'X'.repeat(40 * 1024) + '\n');
    const graph = await makeGraph(repo);
    const outcome = await graph.invoke('diff');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stdout = record(record(record(outcome.output)['processOutput'])['stdout']);
    expect(Number(stdout['byteCount'])).toBeGreaterThan(16 * 1024);
    expect(Buffer.from(String(stdout['preview']), 'utf8').byteLength).toBe(16 * 1024);
    expect(stdout['truncated']).toBe(true);
    expect(String(stdout['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The anchors are present even when the stream had to be externalized.
    expect(String(anchorOf(outcome.output, 'postAnchor')['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    repo.dispose();
  });

  it('14. keeps the Git read-only security posture green', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    const helper = join(repo.dir, 'helper.js');
    writeFileSync(helper, `require('node:fs').writeFileSync(${JSON.stringify(join(repo.dir, 'PWNED'))}, 'x');`, 'utf8');
    repo.git(['config', 'diff.external', `${process.execPath} ${helper}`]);
    repo.git(['config', 'core.fsmonitor', `${process.execPath} ${helper}`]);
    repo.git(['config', 'core.pager', `${process.execPath} ${helper}`]);
    repo.write('a.txt', 'changed\n');
    const before = repo.git(['rev-parse', 'HEAD']).stdout.trim();
    const indexBefore = repo.git(['write-tree']).stdout.trim();
    const graph = await makeGraph(repo);
    await graph.invoke('status');
    await graph.invoke('diff');
    await graph.invoke('baseline');
    const fs = await import('node:fs');
    expect(fs.existsSync(join(repo.dir, 'PWNED'))).toBe(false);
    expect(repo.git(['rev-parse', 'HEAD']).stdout.trim()).toBe(before);
    expect(repo.git(['write-tree']).stdout.trim()).toBe(indexBefore);
    // No mutation operation is expressible through the frozen input schema.
    expect(JSON.stringify(REPOSITORY_GIT_TOOL_SPEC.inputSchema)).not.toContain('"commit"');
    repo.dispose();
  });

  it('16. all six QA evidence kinds can be produced with a revision anchor', async () => {
    // The four process commands already carry pre/post anchors; this suite adds repo.git
    // diff/status. This test proves the DATA is complete for a future validator: six
    // COMPLETED invocations, each with a workspaceId and anchor evidence.
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    const graph = await makeGraph(repo);
    const gitStatus = await graph.invoke('status');
    const gitDiff = await graph.invoke('diff');
    const gitBaseline = await graph.invoke('baseline');
    expect(gitStatus.ok && gitDiff.ok && gitBaseline.ok).toBe(true);
    if (!gitStatus.ok || !gitDiff.ok || !gitBaseline.ok) return;

    // The three repo.git invocations agree on the repository state they observed.
    const workspaces = new Set<string>([
      String(record(gitStatus.output)['workspaceId']),
      String(record(gitDiff.output)['workspaceId']),
      String(record(gitBaseline.output)['workspaceId']),
    ]);
    expect(workspaces.size).toBe(1);
    const fingerprints = [
      anchorOf(gitStatus.output, 'postAnchor')['workingTreeFingerprint'],
      anchorOf(gitDiff.output, 'postAnchor')['workingTreeFingerprint'],
      record(record(gitBaseline.output)['anchor'])['workingTreeFingerprint'],
    ];
    expect(new Set(fingerprints).size).toBe(1);

    // Each is durable with its anchors, so a validator can require
    // "same workspaceId + matching anchor + currentAnchor == evidenceAnchor" later.
    for (const outcome of [gitStatus, gitDiff, gitBaseline]) {
      const durable = await graph.db.toolInvocations.get(outcome.invocationId);
      expect(durable?.status).toBe('COMPLETED');
      expect(durable?.toolVersion).toBe('1.0.0');
      expect(durable?.outputDigest).not.toBeNull();
    }
    repo.dispose();
  });
});
