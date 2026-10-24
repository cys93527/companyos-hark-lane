import { registerOfflineGitWorkspace } from './support/offline-fixtures.js';
/**
 * Git fixtures for the Sprint 17 repository-runtime tests.
 *
 * Test-only helper: it drives the REAL Git CLI to PREPARE repository state (init, commit,
 * stage, worktrees…), which the approval explicitly allows for fixtures. The production
 * runtime adapter never exposes any of this: it is read-only by construction.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface GitFixture {
  readonly dir: string;
  /** Run a raw git command inside the fixture (test setup only). */
  git(args: readonly string[], stdin?: string): { readonly status: number; readonly stdout: string };
  /** Write a workspace-relative file. */
  write(relativePath: string, content: string): void;
  /** Read a workspace-relative file. */
  read(relativePath: string): string;
  /** Current HEAD object id ('' when unborn). */
  headSha(): string;
  /** Destroy the fixture directory. */
  dispose(): void;
}

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(process.env['TEMP'] ?? '/tmp', 'companyos-t17-git-noglobal'),
  HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

export const createGitFixture = (options: { readonly bare?: boolean } = {}): GitFixture => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-t17git-'));
  registerOfflineGitWorkspace(dir);
  const git = (args: readonly string[], stdin?: string): { status: number; stdout: string } => {
    const result = spawnSync('git', args as string[], {
      cwd: dir,
      encoding: 'utf8',
      input: stdin,
      env: { ...process.env, ...GIT_ENV, GIT_DIR: options.bare === true ? dir : undefined } as never,
    });
    if (result.error) throw result.error;
    return { status: result.status ?? -1, stdout: result.stdout ?? '' };
  };
  git(['init', ...(options.bare === true ? ['--bare'] : [])]);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'fixture']);
  git(['config', 'core.autocrlf', 'false']);
  return {
    dir,
    git,
    write: (relativePath, content) => {
      const target = join(dir, relativePath);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content, 'utf8');
    },
    read: (relativePath) => readFileSync(join(dir, relativePath), 'utf8'),
    headSha: () => git(['rev-parse', 'HEAD']).stdout.trim(),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/** Commit everything currently staged (test setup only). */
export const commitAll = (fixture: GitFixture, message = 'fixture'): string => {
  fixture.git(['add', '-A']);
  const result = fixture.git(['commit', '-m', message, '--no-gpg-sign']);
  return result.stdout;
};
