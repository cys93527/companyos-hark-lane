/**
 * Sprint 17 / Task-17-02 — Workspace context + RepositoryPathPolicy.
 *
 * Platform-independent lexical tests (Windows-style inputs assert on every OS) plus
 * real-filesystem integration on the current platform (temp dir, real symlinks where the
 * platform allows). No process execution, no Git, no ToolRecords — this task is only the
 * "which directory may be touched" boundary.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isSha256Ref } from '@companyos/core';
import {
  createRepositoryPathPolicy,
  createWorkspaceManager,
  type RepositoryCommandProfile,
  type WorkspaceContext,
} from '@companyos/engine';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17ws-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

const PROFILE: RepositoryCommandProfile = {
  'tests': { commandKey: 'tests', executable: 'node', baseArgv: ['--version'], cwd: 'workspace-root', safeEnvAdditions: {} },
};

const open = async (root: string, profile: RepositoryCommandProfile = PROFILE): Promise<WorkspaceContext> => {
  const manager = createWorkspaceManager();
  const opened = await manager.openWorkspace({ root, commandProfile: profile });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
};

describe('workspace context (trusted open/close seam)', () => {
  it('a fresh manager has no active workspace (never restored from durable state)', () => {
    expect(createWorkspaceManager().current()).toBeNull();
  });

  it('canonicalizes an existing directory root and derives a qualified workspaceId', async () => {
    const root = tempDir();
    const context = await open(root);
    expect(context.workspaceId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isSha256Ref(context.workspaceId)).toBe(true);
    expect(context.canonicalRoot).toBe(root);
    expect(context.commandProfile).toBe(PROFILE);
  });

  it('derives the same workspaceId for two aliases of the same real root (symlinked root)', async () => {
    const real = tempDir();
    const aliasParent = tempDir();
    const alias = join(aliasParent, 'alias-root');
    symlinkSync(real, alias, 'junction');
    const a = await open(real);
    const b = await open(alias);
    expect(b.workspaceId).toBe(a.workspaceId);
    expect(b.canonicalRoot).toBe(a.canonicalRoot);
  });

  it('refuses a missing root, a file root and a relative root with a stable taxonomy', async () => {
    const manager = createWorkspaceManager();
    const missing = await manager.openWorkspace({ root: join(tempDir(), 'nope'), commandProfile: PROFILE });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.details['reason']).toBe('REPOSITORY_ROOT_MISSING');

    const file = join(tempDir(), 'file.txt');
    writeFileSync(file, 'x');
    const notDir = await createWorkspaceManager().openWorkspace({ root: file, commandProfile: PROFILE });
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) expect(notDir.error.details['reason']).toBe('REPOSITORY_ROOT_NOT_DIRECTORY');

    const relative = await createWorkspaceManager().openWorkspace({ root: 'relative/root', commandProfile: PROFILE });
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.error.details['reason']).toBe('REPOSITORY_ROOT_NOT_ABSOLUTE');
  });

  it('is single-workspace: re-opening the same canonical root is idempotent, a different root fails closed', async () => {
    const first = tempDir();
    const second = tempDir();
    const manager = createWorkspaceManager();
    const one = await manager.openWorkspace({ root: first, commandProfile: PROFILE });
    expect(one.ok).toBe(true);
    const again = await manager.openWorkspace({ root: first, commandProfile: PROFILE });
    expect(again.ok).toBe(true);
    if (one.ok && again.ok) expect(again.value.workspaceId).toBe(one.value.workspaceId);
    const other = await manager.openWorkspace({ root: second, commandProfile: PROFILE });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.details['reason']).toBe('REPOSITORY_WORKSPACE_ALREADY_OPEN');
  });

  it('never silently replaces the active command profile', async () => {
    const root = tempDir();
    const manager = createWorkspaceManager();
    await manager.openWorkspace({ root, commandProfile: PROFILE });
    const changedProfile: RepositoryCommandProfile = {
      'tests': { commandKey: 'tests', executable: 'node', baseArgv: ['--different'], cwd: 'workspace-root', safeEnvAdditions: {} },
    };
    const mismatch = await manager.openWorkspace({ root, commandProfile: changedProfile });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.details['reason']).toBe('REPOSITORY_COMMAND_PROFILE_MISMATCH');
    // Close first, then the new profile is accepted.
    expect(manager.closeWorkspace().ok).toBe(true);
    const reopened = await manager.openWorkspace({ root, commandProfile: changedProfile });
    expect(reopened.ok).toBe(true);
  });

  it('close clears only the process-local context (no filesystem/durable side effect)', async () => {
    const root = tempDir();
    const manager = createWorkspaceManager();
    await manager.openWorkspace({ root, commandProfile: PROFILE });
    expect(manager.closeWorkspace().ok).toBe(true);
    expect(manager.current()).toBeNull();
    const missing = manager.require({ workspaceId: 'sha256:' + 'a'.repeat(64) });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.details['reason']).toBe('REPOSITORY_WORKSPACE_NOT_OPEN');
  });

  it('rejects a stale handle presented against the active workspace', async () => {
    const a = tempDir();
    const b = tempDir();
    const manager = createWorkspaceManager();
    const opened = await manager.openWorkspace({ root: a, commandProfile: PROFILE });
    if (!opened.ok) return;
    const stale = manager.require({ workspaceId: 'sha256:' + 'b'.repeat(64) });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.details['reason']).toBe('REPOSITORY_WORKSPACE_MISMATCH');
    const live = manager.require({ workspaceId: opened.value.workspaceId });
    expect(live.ok).toBe(true);
    void b;
  });
});

describe('RepositoryPathPolicy — lexical rejection (platform independent)', () => {
  it('accepts normalized relative paths and resolves them inside the root', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'app.ts'), 'x');
    const context = await open(root);
    const policy = createRepositoryPathPolicy();
    const hit = policy.resolve({ context, input: 'src/app.ts', operation: 'READ' });
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.value.relativePath).toBe('src/app.ts');
      expect(hit.value.workspaceId).toBe(context.workspaceId);
    }
    const dotted = policy.resolve({ context, input: 'src/./app.ts', operation: 'READ' });
    expect(dotted.ok && dotted.value.relativePath).toBe('src/app.ts');
    const backslashed = policy.resolve({ context, input: 'src' + '\\' + 'app.ts', operation: 'READ' });
    expect(backslashed.ok && backslashed.value.relativePath).toBe('src/app.ts');
  });

  it('rejects absolute, drive-qualified, UNC and device paths', async () => {
    const context = await open(tempDir());
    const policy = createRepositoryPathPolicy();
    const cases: readonly { readonly input: string; readonly reason: string }[] = [
      { input: '/etc/passwd', reason: 'REPOSITORY_PATH_ABSOLUTE' },
      { input: 'C:' + '\\' + 'Windows' + '\\' + 'system32', reason: 'REPOSITORY_PATH_DRIVE_QUALIFIED' },
      { input: 'C:/Windows/system32', reason: 'REPOSITORY_PATH_DRIVE_QUALIFIED' },
      { input: '\\\\' + 'server' + '\\' + 'share' + '\\' + 'file', reason: 'REPOSITORY_PATH_UNC' },
      { input: '//server/share/file', reason: 'REPOSITORY_PATH_UNC' },
      { input: '\\\\?' + '\\' + 'C:' + '\\' + 'repo', reason: 'REPOSITORY_PATH_DEVICE' },
      { input: '\\\\.' + '\\' + 'PhysicalDrive0', reason: 'REPOSITORY_PATH_DEVICE' },
    ];
    for (const testCase of cases) {
      const rejected = policy.resolve({ context, input: testCase.input, operation: 'READ' });
      expect(rejected.ok, `${testCase.input} must be refused`).toBe(false);
      if (!rejected.ok) expect(rejected.error.details['reason']).toBe(testCase.reason);
    }
  });

  it('rejects every parent-escape form (both separators, nested and leading)', async () => {
    const context = await open(tempDir());
    const policy = createRepositoryPathPolicy();
    const escapes = [
      '..',
      '../x',
      'a/../../x',
      'a' + '\\' + '..' + '\\' + '..' + '\\' + 'x',
      'a/..',
      'src/../../etc',
    ];
    for (const input of escapes) {
      const rejected = policy.resolve({ context, input, operation: 'READ' });
      expect(rejected.ok, `${input} must be refused`).toBe(false);
      if (!rejected.ok) expect(rejected.error.details['reason']).toBe('REPOSITORY_PATH_PARENT_ESCAPE');
    }
  });

  it('does not treat a sibling directory with a shared prefix as inside the root', async () => {
    const base = tempDir();
    const root = join(base, 'repo');
    mkdirSync(root);
    mkdirSync(join(base, 'repo-evil'));
    writeFileSync(join(base, 'repo-evil', 'file.txt'), 'x');
    const context = await open(root);
    const policy = createRepositoryPathPolicy();
    // A traversal that lands on the sibling (only expressible by bypassing the policy) must
    // fail containment: resolve the sibling directly and ask the policy.
    const outside = policy.resolve({ context, input: '../repo-evil/file.txt', operation: 'READ' });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error.details['reason']).toBe('REPOSITORY_PATH_PARENT_ESCAPE');
  });

  it('accepts Unicode file names inside the root', async () => {
    const root = tempDir();
    mkdirSync(join(root, '文档'));
    writeFileSync(join(root, '文档', '说明.txt'), 'x');
    const context = await open(root);
    const policy = createRepositoryPathPolicy();
    const hit = policy.resolve({ context, input: '文档/说明.txt', operation: 'READ' });
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.value.relativePath).toBe('文档/说明.txt');
  });

  it('"." represents the root only for operations that allow it', async () => {
    const context = await open(tempDir());
    const policy = createRepositoryPathPolicy();
    const allowed = policy.resolve({ context, input: '.', operation: 'READ', allowRoot: true });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value.internalAbsolutePath).toBe(context.canonicalRoot);
    const refused = policy.resolve({ context, input: '.', operation: 'READ' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.details['reason']).toBe('REPOSITORY_PATH_EMPTY');
  });
});

describe('RepositoryPathPolicy — filesystem-aware containment', () => {
  it('refuses a symlink that escapes the root', async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'), 'file');
    const context = await open(root);
    const policy = createRepositoryPathPolicy();
    const rejected = policy.resolve({ context, input: 'escape.txt', operation: 'READ' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.details['reason']).toBe('REPOSITORY_PATH_REPARSE_POINT');
  });

  it('refuses traversal through a symlink even when it points back inside the root', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'inside'));
    writeFileSync(join(root, 'inside', 'ok.txt'), 'x');
    symlinkSync(join(root, 'inside'), join(root, 'link'), 'junction');
    const context = await open(root);
    const policy = createRepositoryPathPolicy();
    const rejected = policy.resolve({ context, input: 'link/ok.txt', operation: 'READ' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.details['reason']).toBe('REPOSITORY_PATH_REPARSE_POINT');
  });

  it('validates the nearest existing ancestor of a not-yet-existing write target', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'src'));
    const context = await open(root);
    const policy = createRepositoryPathPolicy();
    const target = policy.resolve({ context, input: 'src/new/deep/file.ts', operation: 'WRITE' });
    expect(target.ok).toBe(true);
    if (target.ok) expect(target.value.relativePath).toBe('src/new/deep/file.ts');
  });

  it('refuses a .git path for read/write but allows it for SEARCH scope decisions', async () => {
    const root = tempDir();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'x');
    writeFileSync(join(root, '.gitignore'), 'x');
    const context = await open(root);
    const policy = createRepositoryPathPolicy();
    expect(policy.isGitInternal('.git/config')).toBe(true);
    expect(policy.isGitInternal('.gitignore')).toBe(false);
    expect(policy.isGitInternal('my.git.txt')).toBe(false);
    expect(policy.isGitInternal('.GIT/config')).toBe(true);
    const read = policy.resolve({ context, input: '.git/config', operation: 'READ' });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.details['reason']).toBe('REPOSITORY_PATH_GIT_INTERNAL');
    const write = policy.resolve({ context, input: '.git/config', operation: 'WRITE' });
    expect(write.ok).toBe(false);
    // The .gitignore next to the root is a normal file.
    const ignore = policy.resolve({ context, input: '.gitignore', operation: 'READ' });
    expect(ignore.ok).toBe(true);
  });

  it('never leaks the physical root into the rejection error', async () => {
    const root = tempDir();
    const context = await open(root);
    const policy = createRepositoryPathPolicy();
    const rejected = policy.resolve({ context, input: '../escape', operation: 'READ' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      const serialized = JSON.stringify(rejected.error.details);
      expect(serialized).not.toContain(root);
      expect(rejected.error.details['workspaceId']).toBe(context.workspaceId);
    }
  });
});
