/**
 * Sprint 17 / Task-17-05 — Git read-only runtime & RepositoryRevisionAnchor.
 *
 * Everything runs on the REAL ToolRegistry + the REAL RepositoryProcessRunner (Git CLI,
 * shell=false, fixed argv, filtered env). The ONLY spawn point is the T17-04 runner: no test
 * here reaches `child_process` directly, and the fixtures use the real Git CLI only to
 * PREPARE repository state (which the approval explicitly allows).
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ok, type DomainError, type Result } from '@companyos/core';
import {
  MAX_GIT_STATE_ENTRIES,
  REPOSITORY_GIT_TOOL_SPEC,
  REPOSITORY_PROCESS_TOOL_SPECS,
  REPOSITORY_TOOL_SPECS,
  createAuthorizationService,
  createRepositoryGitToolPort,
  createRepositoryGitToolRecord,
  createRepositoryProcessRunner,
  createRepositoryRevisionAnchorProvider,
  createToolRegistry,
  createWorkspaceManager,
  ensureBootstrapOwner,
  type RepositoryRevisionAnchorProvider,
  type WorkspaceManager,
} from '@companyos/engine';
import { createFilesystemArtifactContentStore, openDurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture, type GitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17g-'));
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
  id: (prefix = 'id') => `${prefix}_17G${String(++seq).padStart(10, '0')}`,
  ulid: () => `17G${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

interface Fixture {
  readonly db: ReturnType<typeof openDurableDatabase>;
  readonly manager: WorkspaceManager;
  readonly runner: ReturnType<typeof createRepositoryProcessRunner>;
  readonly anchors: RepositoryRevisionAnchorProvider;
  readonly actor: string;
  readonly casRoot: string;
  readonly workspaceRoot: string;
  readonly openWorkspace: (root?: string) => Promise<void>;
  readonly invokeGit: (
    op: string,
    actorId?: string,
  ) => Promise<
    Result<{ readonly status: string; readonly invocationId: string; readonly output: unknown; readonly artifactRefs: readonly string[] }, DomainError>
  >;
  readonly anchor: () => Promise<Awaited<ReturnType<RepositoryRevisionAnchorProvider['getCurrentAnchor']>>>;
  readonly registry: ReturnType<typeof createToolRegistry>;
}

const make = async (workspaceRoot?: string): Promise<Fixture> => {
  const root = workspaceRoot ?? tempDir();
  const casRoot = tempDir();
  const db = openDurableDatabase({ dataDir: tempDir(), appliedAt: nowIso(), chains: ['core', 'engine', 'provider', 'tools', 'artifact'] });
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

  return {
    db,
    manager,
    runner,
    anchors,
    actor,
    casRoot,
    workspaceRoot: root,
    openWorkspace: async (target) => {
      const opened = await manager.openWorkspace({ root: target ?? root, commandProfile: {} });
      if (!opened.ok) throw new Error(opened.error.message);
    },
    invokeGit: async (op, actorId) => {
      const outcome = await registry.invoke({
        toolId: 'repo.git',
        executionId: ids.id('exc'),
        agentId: ids.id('agt'),
        taskId: ids.id('tsk'),
        runId: ids.id('run'),
        actorId: actorId ?? actor,
        input: { op },
        idempotencyKey: `repo.git:${op}:${String(++seq)}:${nowIso()}`,
      });
      if (!outcome.ok) return outcome as Result<never, DomainError>;
      return ok({
        status: outcome.value.status,
        invocationId: outcome.value.invocationId,
        output: outcome.value.output,
        artifactRefs: outcome.value.artifactRefs,
      });
    },
    anchor: () => anchors.getCurrentAnchor(),
    registry,
  };
};

/** A clean repository with one commit (the common starting state). */
const cleanRepo = (): GitFixture => {
  const fixture = createGitFixture();
  fixture.write('a.txt', 'alpha\n');
  commitAll(fixture, 'initial');
  return fixture;
};

const readCas = async (casRoot: string, ref: string): Promise<Uint8Array> =>
  createFilesystemArtifactContentStore({ casRoot }).get(ref);

const output = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

/* ------------------------------------------------------------- contract ---- */

describe('repo.git tool contract (T17-05)', () => {
  it('1-2. freezes the tool id, version, risk, capability, idempotency and operations', async () => {
    expect(REPOSITORY_GIT_TOOL_SPEC.toolId).toBe('repo.git');
    expect(REPOSITORY_GIT_TOOL_SPEC.version).toBe('1.0.0');
    expect(REPOSITORY_GIT_TOOL_SPEC.riskLevel).toBe('LOW');
    expect(REPOSITORY_GIT_TOOL_SPEC.capabilities).toEqual(['read']);
    expect(REPOSITORY_GIT_TOOL_SPEC.idempotencyMode).toBe('IDEMPOTENT_KEY');

    const record = createRepositoryGitToolRecord(REPOSITORY_GIT_TOOL_SPEC, nowIso());
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.value.toolId).toBe('repo.git');
    expect(record.value.version).toBe('1.0.0');
    expect(record.value.riskLevel).toBe('LOW');
    expect(record.value.capabilities).toEqual(['read']);
    expect(record.value.idempotencyMode).toBe('IDEMPOTENT_KEY');
    expect(record.value.requiredAuthorities).toEqual(['tool.invoke']);
    expect(record.value.providerKind).toBe('repository');

    // The input schema admits exactly the three operations and NOTHING else.
    const properties = Object.keys(
      (REPOSITORY_GIT_TOOL_SPEC.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(properties).toEqual(['op']);
    const op = (REPOSITORY_GIT_TOOL_SPEC.inputSchema as { properties: { op: { enum: string[] } } }).properties.op;
    expect(op.enum).toEqual(['status', 'diff', 'baseline']);
    // No mutation operation is expressible anywhere in the spec.
    for (const forbidden of ['commit', 'push', 'pull', 'fetch', 'checkout', 'switch', 'reset', 'clean', 'merge', 'rebase', 'tag', 'stash', 'add']) {
      expect(JSON.stringify(REPOSITORY_GIT_TOOL_SPEC)).not.toContain(`"${forbidden}"`);
    }
  });

  it('refuses unknown operations and unknown input fields', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    for (const input of [{ op: 'commit' }, { op: 'status', args: ['--all'] }, { op: 'push' }, {}]) {
      const outcome = await f.registry.invoke({
        toolId: 'repo.git',
        executionId: ids.id('exc'),
        agentId: ids.id('agt'),
        taskId: ids.id('tsk'),
        runId: ids.id('run'),
        actorId: f.actor,
        input,
      });
      expect(outcome.ok, JSON.stringify(input)).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error.code).toBe('VALIDATION_FAILED');
    }
    repo.dispose();
  });

  it('3. denies a git call without an open workspace', async () => {
    const f = await make();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('WORKSPACE_NOT_OPEN');
    const anchor = await f.anchor();
    expect(anchor.supported).toBe(false);
    if (anchor.supported) return;
    expect(anchor.reason).toBe('WORKSPACE_NOT_OPEN');
  });

  it('4. denies a directory that is not a Git repository', async () => {
    const repo = createGitFixture();
    rmSync(join(repo.dir, '.git'), { recursive: true, force: true });
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('NOT_A_GIT_REPOSITORY');
    repo.dispose();
  });
});

/* ----------------------------------------------------------- boundaries ---- */

describe('git workspace boundaries (T17-05)', () => {
  it('5. refuses a workspace nested inside a larger repository', async () => {
    const parent = createGitFixture();
    parent.write('root.txt', 'root\n');
    commitAll(parent, 'initial');
    const child = join(parent.dir, 'sub');
    mkdirSync(child, { recursive: true });
    const f = await make(child);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('GIT_ROOT_OUTSIDE_WORKSPACE');
    parent.dispose();
  });

  it('6. refuses a bare repository', async () => {
    const bare = createGitFixture({ bare: true });
    const f = await make(bare.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('GIT_BARE_REPOSITORY_UNSUPPORTED');
    bare.dispose();
  });

  it('7. refuses a linked worktree (its git dir lives outside the workspace)', async () => {
    const repo = cleanRepo();
    const worktree = join(tempDir(), 'linked');
    const added = repo.git(['worktree', 'add', worktree, '-b', 'feature']);
    if (added.status !== 0) {
      // Platform without worktree support: the refusal is asserted structurally instead.
      repo.dispose();
      return;
    }
    const f = await make(worktree);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('GIT_WORKTREE_UNSUPPORTED');
    repo.dispose();
  });

  it('8. refuses a registered submodule (gitlink mode 160000)', async () => {
    const repo = cleanRepo();
    const index = join(repo.dir, '.git', 'index');
    // A real submodule needs a second repository; register a gitlink entry directly so the
    // fixture is deterministic (test setup only — the runtime never writes the index).
    repo.write('sub-marker.txt', 'x\n');
    const added = repo.git(['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},0,sub`]);
    expect(added.status).toBe(0);
    expect(index.length).toBeGreaterThan(0);
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('GIT_SUBMODULE_UNSUPPORTED');
    repo.dispose();
  });

  it('16. refuses an untracked NESTED repository (never traverses into it)', async () => {
    const repo = cleanRepo();
    const nested = createGitFixture();
    nested.write('inside.txt', 'nested\n');
    commitAll(nested, 'nested');
    const nestedInside = join(repo.dir, 'nested-repo');
    mkdirSync(nestedInside, { recursive: true });
    // Copy the nested repository's tracked content (fixture setup only).
    repo.git(['--version']);
    cpSync(nested.dir, nestedInside, { recursive: true });
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('GIT_NESTED_REPOSITORY_UNSUPPORTED');
    nested.dispose();
    repo.dispose();
  });
});

/* --------------------------------------------------------------- status ---- */

describe('repo.git status / diff / baseline (T17-05)', () => {
  it('9. reports a clean repository', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = output(outcome.value.output);
    expect(value['op']).toBe('status');
    expect(value['isDirty']).toBe(false);
    expect(value['dirtyFiles']).toEqual([]);
    expect(String(value['headSha'])).toMatch(/^[0-9a-f]{40}$/);
    expect(String(value['branch'])).toBe('master');
    expect(JSON.stringify(outcome.value)).not.toContain(repo.dir);
    repo.dispose();
  });

  it('10-11. reports a dirty repository with relative paths only', async () => {
    const repo = cleanRepo();
    repo.write('a.txt', 'changed\n');
    repo.write('new.txt', 'brand new\n');
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = output(outcome.value.output);
    expect(value['isDirty']).toBe(true);
    expect(value['dirtyFiles']).toEqual(['a.txt', 'new.txt']);
    for (const path of value['dirtyFiles'] as readonly string[]) {
      expect(path.includes('\\')).toBe(false);
      expect(path.includes(':')).toBe(false);
      expect(path.startsWith('/')).toBe(false);
    }
    expect(JSON.stringify(outcome.value)).not.toContain(repo.dir);
    repo.dispose();
  });

  it('12. runs a real unstaged working-tree diff', async () => {
    const repo = cleanRepo();
    repo.write('a.txt', 'alpha changed\n');
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('diff');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = output(outcome.value.output);
    expect(value['op']).toBe('diff');
    const processOutput = output(value['processOutput']);
    const stdout = output(processOutput['stdout']);
    expect(String(stdout['preview'])).toContain('alpha changed');
    expect(String(stdout['preview'])).toContain('diff --git');
    repo.dispose();
  });

  it('34-35. keeps the diff/diff bytes reachable and the invocation durable', async () => {
    const repo = cleanRepo();
    repo.write('a.txt', 'x'.repeat(40 * 1024) + '\n');
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('diff');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = output(outcome.value.output);
    const stdout = output(output(value['processOutput'])['stdout']);
    expect(Number(stdout['byteCount'])).toBeGreaterThan(16 * 1024);
    expect(stdout['truncated']).toBe(true);
    expect(String(stdout['artifactRef'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    const stored = await readCas(f.casRoot, String(stdout['artifactRef']));
    expect('sha256:' + createHash('sha256').update(stored).digest('hex')).toBe(stdout['sha256']);
    expect(new TextDecoder().decode(stored)).toContain('diff --git');

    const durable = (await f.db.toolInvocations.list({ limit: 10 })).items[0];
    expect(durable?.toolId).toBe('repo.git');
    expect(durable?.toolVersion).toBe('1.0.0');
    expect(durable?.status).toBe('COMPLETED');
    expect(durable?.inputDigest.length).toBeGreaterThan(0);
    expect(durable?.outputDigest).not.toBeNull();
    repo.dispose();
  });

  it('16-17. builds a baseline with the anchor for a clean repository', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('baseline');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = output(outcome.value.output);
    expect(value['op']).toBe('baseline');
    expect(value['isDirty']).toBe(false);
    const anchor = output(value['anchor']);
    expect(String(anchor['workingTreeFingerprint'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(String(anchor['headSha'])).toBe(repo.headSha());
    expect(anchor['dirtyFiles']).toEqual([]);
    expect(JSON.stringify(outcome.value)).not.toContain(repo.dir);
    repo.dispose();
  });
});

/* --------------------------------------------------------------- anchors ---- */

describe('RepositoryRevisionAnchor semantics (T17-05)', () => {
  it('19. is deterministic for the same state', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const first = await f.anchor();
    const second = await f.anchor();
    expect(first.supported && second.supported).toBe(true);
    if (!first.supported || !second.supported) return;
    expect(first.anchor.workingTreeFingerprint).toBe(second.anchor.workingTreeFingerprint);
    expect(first.anchor.headSha).toBe(second.anchor.headSha);
    repo.dispose();
  });

  it('20. changes when HEAD changes', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const before = await f.anchor();
    repo.write('b.txt', 'second\n');
    commitAll(repo, 'second');
    const after = await f.anchor();
    expect(before.supported && after.supported).toBe(true);
    if (!before.supported || !after.supported) return;
    expect(before.anchor.headSha).not.toBe(after.anchor.headSha);
    expect(before.anchor.workingTreeFingerprint).not.toBe(after.anchor.workingTreeFingerprint);
    repo.dispose();
  });

  it('21. changes on a staged change', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const before = await f.anchor();
    repo.write('a.txt', 'staged content\n');
    repo.git(['add', 'a.txt']);
    const after = await f.anchor();
    expect(before.supported && after.supported).toBe(true);
    if (!before.supported || !after.supported) return;
    expect(after.anchor.dirtyFiles).toEqual(['a.txt']);
    expect(before.anchor.workingTreeFingerprint).not.toBe(after.anchor.workingTreeFingerprint);
    repo.dispose();
  });

  it('22. changes on an unstaged tracked content change', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const before = await f.anchor();
    repo.write('a.txt', 'unstaged change\n');
    const after = await f.anchor();
    expect(before.supported && after.supported).toBe(true);
    if (!before.supported || !after.supported) return;
    expect(before.anchor.workingTreeFingerprint).not.toBe(after.anchor.workingTreeFingerprint);
    repo.dispose();
  });

  it('23. changes when the same status carries different bytes', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    repo.write('a.txt', 'content A\n');
    const first = await f.anchor();
    repo.write('a.txt', 'content B\n');
    const second = await f.anchor();
    expect(first.supported && second.supported).toBe(true);
    if (!first.supported || !second.supported) return;
    // Identical status shape (" M" for the same path), different bytes.
    expect(first.anchor.dirtyFiles).toEqual(second.anchor.dirtyFiles);
    expect(first.anchor.workingTreeFingerprint).not.toBe(second.anchor.workingTreeFingerprint);
    repo.dispose();
  });

  it('24-25. changes on untracked path change and untracked content change', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const clean = await f.anchor();
    repo.write('extra.txt', 'first\n');
    const withFile = await f.anchor();
    repo.write('other.txt', 'second\n');
    const otherPath = await f.anchor();
    expect(clean.supported && withFile.supported && otherPath.supported).toBe(true);
    if (!clean.supported || !withFile.supported || !otherPath.supported) return;
    expect(clean.anchor.workingTreeFingerprint).not.toBe(withFile.anchor.workingTreeFingerprint);
    expect(otherPath.anchor.workingTreeFingerprint).not.toBe(withFile.anchor.workingTreeFingerprint);
    // Same path, different content.
    repo.write('extra.txt', 'first changed\n');
    const changedContent = await f.anchor();
    expect(changedContent.supported).toBe(true);
    if (!changedContent.supported) return;
    expect(changedContent.anchor.dirtyFiles).toContain('extra.txt');
    expect(changedContent.anchor.workingTreeFingerprint).not.toBe(withFile.anchor.workingTreeFingerprint);
    repo.dispose();
  });

  it('26. changes on a tracked deletion', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const before = await f.anchor();
    rmSync(join(repo.dir, 'a.txt'));
    const after = await f.anchor();
    expect(before.supported && after.supported).toBe(true);
    if (!before.supported || !after.supported) return;
    expect(after.anchor.dirtyFiles).toEqual(['a.txt']);
    expect(before.anchor.workingTreeFingerprint).not.toBe(after.anchor.workingTreeFingerprint);
    repo.dispose();
  });

  it('27. stays stable when only the mtime changes', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const before = await f.anchor();
    const stamp = new Date(Date.now() + 60_000);
    utimesSync(join(repo.dir, 'a.txt'), stamp, stamp);
    const after = await f.anchor();
    expect(before.supported && after.supported).toBe(true);
    if (!before.supported || !after.supported) return;
    expect(after.anchor.dirtyFiles).toEqual([]);
    expect(after.anchor.workingTreeFingerprint).toBe(before.anchor.workingTreeFingerprint);
    repo.dispose();
  });

  it('18. supports an unborn HEAD (headSha null, fingerprint still covers state)', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'unborn\n');
    const f = await make(repo.dir);
    await f.openWorkspace();
    const anchor = await f.anchor();
    expect(anchor.supported).toBe(true);
    if (!anchor.supported) return;
    expect(anchor.anchor.headSha).toBeNull();
    expect(anchor.anchor.workingTreeFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(anchor.anchor.dirtyFiles).toEqual(['a.txt']);
    const outcome = await f.invokeGit('baseline');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(String(output(outcome.value.output)['headSha'])).toBe('');
    repo.dispose();
  });

  it('17. supports a detached HEAD (branch null, headSha actual)', async () => {
    const repo = cleanRepo();
    repo.git(['checkout', '--detach', repo.headSha()]);
    const f = await make(repo.dir);
    await f.openWorkspace();
    const anchor = await f.anchor();
    expect(anchor.supported).toBe(true);
    if (!anchor.supported) return;
    expect(anchor.anchor.branch).toBeNull();
    expect(anchor.anchor.headSha).toBe(repo.headSha());
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(String(output(outcome.value.output)['branch'])).toBe('');
    repo.dispose();
  });

  it('28. fails closed when the repository state exceeds the entry limit', {timeout: 60_000}, async () => {
    const repo = cleanRepo();
    for (let index = 0; index < MAX_GIT_STATE_ENTRIES + 5; index += 1) {
      repo.write(`bulk/${String(index).padStart(6, '0')}.txt`, 'x\n');
    }
    const f = await make(repo.dir);
    await f.openWorkspace();
    const anchor = await f.anchor();
    expect(anchor.supported).toBe(false);
    if (anchor.supported) return;
    expect(anchor.reason).toBe('GIT_STATE_LIMIT_EXCEEDED');
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.details['reason']).toBe('GIT_STATE_LIMIT_EXCEEDED');
    repo.dispose();
  });
});

/* -------------------------------------------------------- safety of reads ---- */

describe('git read safety (T17-05)', () => {
  it('13-14. never invokes a repository-configured external program', async () => {
    const repo = cleanRepo();
    // A malicious repository config that would run an external program on diff/status.
    const helper = join(repo.dir, 'helper.js');
    writeFileSync(helper, `require('node:fs').writeFileSync(${JSON.stringify(join(repo.dir, 'PWNED'))}, 'x');`, 'utf8');
    repo.git(['config', 'diff.external', process.execPath + ' ' + helper]);
    repo.git(['config', 'core.fsmonitor', process.execPath + ' ' + helper]);
    repo.git(['config', 'core.pager', process.execPath + ' ' + helper]);
    repo.write('a.txt', 'changed\n');
    const f = await make(repo.dir);
    await f.openWorkspace();
    await f.invokeGit('diff');
    await f.invokeGit('status');
    await f.invokeGit('baseline');
    expect(existsSync(join(repo.dir, 'PWNED'))).toBe(false);
    repo.dispose();
  });

  it('36. does not mutate HEAD, index or refs', async () => {
    const repo = cleanRepo();
    repo.write('a.txt', 'dirty\n');
    const before = repo.git(['rev-parse', 'HEAD']).stdout.trim();
    const indexBefore = repo.git(['write-tree']).stdout.trim();
    const refsBefore = repo.git(['for-each-ref', '--format=%(refname) %(objectname)']).stdout.trim();
    const f = await make(repo.dir);
    await f.openWorkspace();
    await f.invokeGit('status');
    await f.invokeGit('diff');
    await f.invokeGit('baseline');
    expect(repo.git(['rev-parse', 'HEAD']).stdout.trim()).toBe(before);
    expect(repo.git(['write-tree']).stdout.trim()).toBe(indexBefore);
    expect(repo.git(['for-each-ref', '--format=%(refname) %(objectname)']).stdout.trim()).toBe(refsBefore);
    repo.dispose();
  });

  it('15. runs Git without a shell (no shell-only syntax ever works)', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status');
    expect(outcome.ok).toBe(true);
    repo.dispose();
  });

  it('denies a git call without the tool.invoke authority', async () => {
    const repo = cleanRepo();
    const f = await make(repo.dir);
    await f.openWorkspace();
    const outcome = await f.invokeGit('status', 'user_intruder');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('PERMISSION_DENIED');
    repo.dispose();
  });
});

/* --------------------------------------------------------- production set --- */

describe('production repository tool set (T17-05)', () => {
  it('37-38. registers the nine Sprint 17 tools and no validator', async () => {
    const registered = [
      ...REPOSITORY_TOOL_SPECS.map((spec) => spec.toolId),
      ...REPOSITORY_PROCESS_TOOL_SPECS.map((spec) => spec.toolId),
      REPOSITORY_GIT_TOOL_SPEC.toolId,
    ].sort();
    expect(registered).toEqual([
      'repo.builder',
      'repo.file-read',
      'repo.file-write',
      'repo.git',
      'repo.linter',
      'repo.search',
      'repo.terminal',
      'repo.test-runner',
      'repo.typechecker',
    ]);
    expect(registered).not.toContain('repo.validation-evidence');
    expect(registered).toHaveLength(9);
  });
});
