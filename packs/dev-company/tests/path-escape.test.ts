/**
 * Sprint 17 / Task-17-02 — `packs/dev-company/tests/path-escape.test.ts`
 * (roadmap-named AC17.2 boundary evidence, T17-02 §52).
 *
 * This file is the ROADMAP-NAMED test, but it tests the GENERIC RepositoryPathPolicy: the
 * implementation deliberately does not live inside the DevCompany pack. DevCompany is only
 * the first consumer of the repository runtime (ADR-0028 D28/D80: no pack special-casing).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepositoryPathPolicy, createWorkspaceManager, type RepositoryCommandProfile } from '@companyos/engine';
import { DEVCOMPANY_PACK_ID } from '@companyos/pack-dev-company';

const created: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17esc-'));
  created.push(dir);
  return dir;
};
afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

/** The DevCompany V1 command profile: read-only QA slots (ADR-0028 D10/D18). */
const DEVCOMPANY_COMMAND_PROFILE: RepositoryCommandProfile = {
  'tests': { commandKey: 'tests', executable: 'node', baseArgv: ['--test'], cwd: 'workspace-root', safeEnvAdditions: {} },
  'lint': { commandKey: 'lint', executable: 'node', baseArgv: ['--lint'], cwd: 'workspace-root', safeEnvAdditions: {} },
  'typecheck': { commandKey: 'typecheck', executable: 'node', baseArgv: ['--typecheck'], cwd: 'workspace-root', safeEnvAdditions: {} },
  'build': { commandKey: 'build', executable: 'node', baseArgv: ['--build'], cwd: 'workspace-root', safeEnvAdditions: {} },
};

describe('AC17.2 — workspace path boundary (generic policy, DevCompany as first consumer)', () => {
  it('every escape form a model could send is denied before any file is touched', async () => {
    const root = tempDir();
    const manager = createWorkspaceManager();
    const opened = await manager.openWorkspace({ root, commandProfile: DEVCOMPANY_COMMAND_PROFILE });
    if (!opened.ok) throw new Error(opened.error.message);
    const policy = createRepositoryPathPolicy();
    const escapes: readonly (readonly [string, string])[] = [
      ['/etc/passwd', 'REPOSITORY_PATH_ABSOLUTE'],
      ['C:\\Windows\\system32\\drivers\\etc\\hosts', 'REPOSITORY_PATH_DRIVE_QUALIFIED'],
      ['C:/Windows/system32/drivers/etc/hosts', 'REPOSITORY_PATH_DRIVE_QUALIFIED'],
      ['\\\\server\\share\\file', 'REPOSITORY_PATH_UNC'],
      ['//server/share/file', 'REPOSITORY_PATH_UNC'],
      ['\\\\.\\PhysicalDrive0', 'REPOSITORY_PATH_DEVICE'],
      ['..', 'REPOSITORY_PATH_PARENT_ESCAPE'],
      ['../outside.txt', 'REPOSITORY_PATH_PARENT_ESCAPE'],
      ['a/../../outside.txt', 'REPOSITORY_PATH_PARENT_ESCAPE'],
      ['a\\..\\..\\outside.txt', 'REPOSITORY_PATH_PARENT_ESCAPE'],
      ['.git/config', 'REPOSITORY_PATH_GIT_INTERNAL'],
      ['.GIT/config', 'REPOSITORY_PATH_GIT_INTERNAL'],
    ];
    for (const [input, reason] of escapes) {
      const denied = policy.resolve({ context: opened.value, input, operation: 'READ' });
      expect(denied.ok, `${input} must be denied`).toBe(false);
      if (!denied.ok) expect(denied.error.details['reason']).toBe(reason);
    }
  });

  it('a legitimate in-workspace read/write target still resolves', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};');
    const manager = createWorkspaceManager();
    const opened = await manager.openWorkspace({ root, commandProfile: DEVCOMPANY_COMMAND_PROFILE });
    if (!opened.ok) throw new Error(opened.error.message);
    const policy = createRepositoryPathPolicy();
    const read = policy.resolve({ context: opened.value, input: 'src/index.ts', operation: 'READ' });
    expect(read.ok).toBe(true);
    const write = policy.resolve({ context: opened.value, input: 'src/main.ts', operation: 'WRITE' });
    expect(write.ok).toBe(true);
  });

  it('the DevCompany requirements stay requirements: the policy is pack-agnostic', () => {
    // The generic runtime never branches on the pack identity that consumes it.
    const policy = createRepositoryPathPolicy();
    expect(policy.isGitInternal('.git/HEAD')).toBe(true);
    expect(DEVCOMPANY_PACK_ID).toBe('dev-company');
  });
});
