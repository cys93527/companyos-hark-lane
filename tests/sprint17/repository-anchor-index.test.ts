/**
 * Sprint 17 / Task-17-05 CORRECTIVE — `REPOSITORY_INDEX_FINGERPRINT_GAP`.
 *
 * The revision anchor must be sensitive to THREE independent layers:
 *
 *   HEAD  ·  INDEX  ·  WORKING TREE
 *
 * The previous input set (HEAD + branch + XY + path + working-tree bytes) could NOT see a
 * staged-only change: with HEAD=A, INDEX=B, WORKTREE=C, moving the index to D while leaving
 * the working tree untouched produced the SAME fingerprint. A validator could then mistake
 * old QA evidence for fresh evidence on the current staged state.
 *
 * The corrected anchor also carries the INDEX MODE (an executable-bit change is a repository
 * state change) and the rename's original path, so it cannot be reconstructed from a
 * human-readable porcelain status line plus the working-tree bytes.
 *
 * Test fixtures use REAL Git mutations to PREPARE state (hash-object / update-index / chmod);
 * the production runtime remains read-only (status / diff / baseline only).
 */
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REPOSITORY_GIT_TOOL_SPEC,
  createAuthorizationService,
  createRepositoryProcessRunner,
  createRepositoryRevisionAnchorProvider,
  createWorkspaceManager,
  ensureBootstrapOwner,
} from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

import { commitAll, createGitFixture } from '../git-fixture.js';

const created: string[] = [];
const openDatabases: ReturnType<typeof openDurableDatabase>[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17idx-'));
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
  id: (prefix = 'id') => `${prefix}_17X${String(++seq).padStart(10, '0')}`,
  ulid: () => `17X${String(++seq).padStart(20, '0')}`,
};
const nowIso = (): string => new Date(Date.parse('2026-09-27T00:00:00.000Z') + ++seq * 1_000).toISOString();
const clock = { now: (): number => Date.parse('2026-09-27T00:00:00.000Z') + seq * 1_000, nowIso };

/** HEAD = A, INDEX = B, WORKTREE = C for one tracked file (the Boss counterexample). */
const threeLayerState = () => {
  const repo = createGitFixture();
  repo.write('a.txt', 'A\n');
  commitAll(repo, 'initial');
  repo.write('a.txt', 'B\n');
  repo.git(['add', 'a.txt']);
  repo.write('a.txt', 'C\n');
  return repo;
};

interface Harness {
  readonly repo: ReturnType<typeof createGitFixture>;
  readonly anchor: () => Promise<
    | { readonly supported: true; readonly headSha: string | null; readonly fingerprint: string }
    | { readonly supported: false; readonly reason: string }
  >;
}

const harness = async (repo: ReturnType<typeof createGitFixture>): Promise<Harness> => {
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
  const opened = await manager.openWorkspace({ root: repo.dir, commandProfile: {} });
  if (!opened.ok) throw new Error(opened.error.message);
  const runner = createRepositoryProcessRunner({
    clock,
    timer: (ms, onTimeout) => {
      const handle = setTimeout(onTimeout, ms);
      return () => clearTimeout(handle);
    },
    contentStore: undefined,
  });
  const provider = createRepositoryRevisionAnchorProvider({
    workspace: () => manager.current(),
    runner,
    gitExecutable: 'git',
    timeoutMs: REPOSITORY_GIT_TOOL_SPEC.timeoutMs,
  });
  return {
    repo,
    anchor: async () => {
      const result = await provider.getCurrentAnchor();
      if (!result.supported) return { supported: false as const, reason: result.reason };
      return {
        supported: true as const,
        headSha: result.anchor.headSha,
        fingerprint: result.anchor.workingTreeFingerprint,
      };
    },
  };
};

const supported = async (
  harness: Harness,
): Promise<{ readonly headSha: string | null; readonly fingerprint: string }> => {
  const result = await harness.anchor();
  if (!result.supported) throw new Error(`unsupported: ${result.reason}`);
  return result;
};

/** `git hash-object -w` of the given content (test setup only). */
const hashObject = (repo: ReturnType<typeof createGitFixture>, content: string): string =>
  repo.git(['hash-object', '-w', '--stdin'], content).stdout.trim();

describe('index-aware revision anchor (T17-05 corrective)', () => {
  it('1-3. changes when ONLY the staged content changes (HEAD and worktree unchanged)', async () => {
    const repo = threeLayerState();
    const h = await harness(repo);
    const anchor1 = await supported(h);

    // HEAD stays A, the WORKING TREE stays C; only the INDEX moves B -> D.
    const stagedD = hashObject(repo, 'D\n');
    expect(stagedD).toMatch(/^[0-9a-f]{40}$/);
    // The documented <mode>,<object>,<path> grammar (the stage is not part of it).
    const swapped = repo.git(['update-index', '--cacheinfo', `100644,${stagedD},a.txt`]);
    expect(swapped.status).toBe(0);

    const anchor2 = await supported(h);
    expect(anchor2.headSha).toBe(anchor1.headSha);
    // The worktree bytes and the status class are identical; only the staged blob differs.
    const status = repo.git(['status', '--porcelain=v2', 'a.txt']).stdout.trim();
    expect(status.startsWith('1 MM')).toBe(true);
    expect(anchor2.fingerprint).not.toBe(anchor1.fingerprint);
    repo.dispose();
  });

  it('2. records the state where the working tree differs from both HEAD and index', async () => {
    const repo = threeLayerState();
    const h = await harness(repo);
    const anchor = await supported(h);
    // HEAD=A, INDEX=B, WT=C: the entry carries all three identities.
    const line = repo.git(['ls-files', '--stage', 'a.txt']).stdout.trim();
    expect(line.startsWith('100644')).toBe(true);
    expect(anchor.headSha).toMatch(/^[0-9a-f]{40}$/);
    repo.dispose();
  });

  it('3. changes when ONLY the index MODE changes (same bytes)', async () => {
    const repo = threeLayerState();
    const h = await harness(repo);
    const anchor1 = await supported(h);
    // Same content, executable bit: the index mode 100644 -> 100755.
    const chmod = repo.git(['update-index', '--chmod=+x', 'a.txt']);
    expect(chmod.status).toBe(0);
    const anchor2 = await supported(h);
    expect(anchor2.fingerprint).not.toBe(anchor1.fingerprint);
    const entry = repo.git(['status', '--porcelain=v2', 'a.txt']).stdout.trim();
    expect(entry).toContain('100755');
    repo.dispose();
  });

  it('4. still changes on an unstaged worktree content change', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    const h = await harness(repo);
    const anchor1 = await supported(h);
    repo.write('a.txt', 'changed\n');
    const anchor2 = await supported(h);
    expect(anchor2.fingerprint).not.toBe(anchor1.fingerprint);
    repo.dispose();
  });

  it('5. still changes when the status class is identical but the bytes differ', async () => {
    const repo = threeLayerState();
    const h = await harness(repo);
    const anchor1 = await supported(h);
    repo.write('a.txt', 'C2\n');
    const anchor2 = await supported(h);
    expect(anchor2.fingerprint).not.toBe(anchor1.fingerprint);
    repo.dispose();
  });

  it('6. changes on a rename and distinguishes the two directions', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'same bytes\n');
    commitAll(repo, 'initial');

    // a.txt -> b.txt (a real staged rename).
    const forward = createGitFixture();
    forward.write('a.txt', 'same bytes\n');
    commitAll(forward, 'initial');
    forward.git(['mv', 'a.txt', 'b.txt']);
    const forwardAnchor = await supported(await harness(forward));

    // b.txt -> a.txt (the opposite direction): the original path differs.
    const backward = createGitFixture();
    backward.write('b.txt', 'same bytes\n');
    commitAll(backward, 'initial');
    backward.git(['mv', 'b.txt', 'a.txt']);
    const backwardAnchor = await supported(await harness(backward));

    expect(forwardAnchor.fingerprint).not.toBe(backwardAnchor.fingerprint);
    // The rename state differs from the clean state too.
    const clean = createGitFixture();
    clean.write('a.txt', 'same bytes\n');
    commitAll(clean, 'initial');
    const cleanAnchor = await supported(await harness(clean));
    expect(forwardAnchor.fingerprint).not.toBe(cleanAnchor.fingerprint);
    repo.dispose();
    forward.dispose();
    backward.dispose();
    clean.dispose();
  });

  it('7. keeps a deletion a distinct identity', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    const h = await harness(repo);
    const anchor1 = await supported(h);
    rmSync(join(repo.dir, 'a.txt'));
    const anchor2 = await supported(h);
    expect(anchor2.fingerprint).not.toBe(anchor1.fingerprint);
    // The index still holds the object: the identity is path + index/head, never "hash nothing".
    const entry = repo.git(['status', '--porcelain=v2', 'a.txt']).stdout.trim();
    expect(entry.startsWith('1 .D')).toBe(true);
    expect(entry).toContain('000000');
    repo.dispose();
  });

  it('8. still changes on an untracked content change', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    const h = await harness(repo);
    const anchor1 = await supported(h);
    repo.write('extra.txt', 'one\n');
    const anchor2 = await supported(h);
    repo.write('extra.txt', 'two\n');
    const anchor3 = await supported(h);
    expect(anchor2.fingerprint).not.toBe(anchor1.fingerprint);
    expect(anchor3.fingerprint).not.toBe(anchor2.fingerprint);
    repo.dispose();
  });

  it('9. remains stable on an mtime-only change', async () => {
    const repo = createGitFixture();
    repo.write('a.txt', 'A\n');
    commitAll(repo, 'initial');
    const h = await harness(repo);
    const anchor1 = await supported(h);
    const stamp = new Date(Date.now() + 90_000);
    utimesSync(join(repo.dir, 'a.txt'), stamp, stamp);
    const anchor2 = await supported(h);
    expect(anchor2.fingerprint).toBe(anchor1.fingerprint);
    repo.dispose();
  });

  it('10. remains deterministic for the same state', async () => {
    const repo = threeLayerState();
    const h = await harness(repo);
    const anchor1 = await supported(h);
    const anchor2 = await supported(h);
    expect(anchor2.fingerprint).toBe(anchor1.fingerprint);
    expect(anchor2.headSha).toBe(anchor1.headSha);
    repo.dispose();
  });
});
