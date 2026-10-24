/**
 * Sprint25 — the WORKSPACE / CWD AUTHORITY (Boss §22-§28/§41).
 *
 * The law under test: the trusted root is an application-supplied value; every spawn
 * cwd is proven to be that root or inside it BY PATH COMPONENT BOUNDARY (never a raw
 * string prefix — `C:\work\foo` must not accept `C:\work\foobar`); normalization runs
 * before the comparison, so `root\..\other` is not a way past it; symlink/junction
 * escapes are refused; the write boundary is the same boundary.
 *
 * Honest scope (no over-claiming): these tests prove an AUTHORIZATION boundary. They
 * do not prove isolation. The TOCTOU window between "validated" and "spawned" is a
 * documented residual exposure, not something these tests pretend to close.
 */
import { describe, expect, it } from 'vitest';

import {
  assertExecutionCwdAllowed,
  assertWritePathWithinRoot,
  resolveTrustedWorkspaceRoot,
  type WorkspaceFsSeams,
} from '@companyos/engine';

/** Filesystem seams the test controls: nothing here touches the real disk. */
const seamsOf = (input: {
  readonly existing?: readonly string[];
  readonly directories?: readonly string[];
  readonly links?: Readonly<Record<string, boolean>>;
  readonly realpaths?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
} = {}): WorkspaceFsSeams => {
  const existing = new Set(input.existing ?? []);
  const directories = new Set(input.directories ?? []);
  const links = input.links ?? {};
  const realpaths = input.realpaths ?? {};
  return {
    platform: input.platform ?? 'win32',
    realpath: (p) => {
      const mapped = realpaths[p];
      if (mapped !== undefined) return mapped;
      if (!existing.has(p)) throw new Error(`ENOENT: ${p}`);
      return p;
    },
    stat: (p) => {
      if (!existing.has(p)) throw new Error(`ENOENT: ${p}`);
      // Real `statSync` on an existing FILE does not throw: it answers isDirectory() === false.
      return { isDirectory: () => directories.has(p) };
    },
    lstat: (p) => {
      if (!existing.has(p)) throw new Error(`ENOENT: ${p}`);
      return { isSymbolicLink: () => links[p] === true };
    },
  };
};

const ROOT = 'C:\\work\\project';

/** A root that exists and is a directory, with nothing else present. */
const rootSeams = (over: Parameters<typeof seamsOf>[0] = {}): WorkspaceFsSeams =>
  seamsOf({ existing: [ROOT], directories: [ROOT], ...over });

describe('S25 workspace — the trusted root (§22-§23)', () => {
  it('1. an application-supplied absolute root canonicalizes to itself', () => {
    const resolved = resolveTrustedWorkspaceRoot({ root: ROOT, ...rootSeams() });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.canonicalRoot).toBe(ROOT);
  });

  it('2. a RELATIVE root is refused (a relative root makes "canonical" meaningless)', () => {
    const resolved = resolveTrustedWorkspaceRoot({ root: 'work\\project', ...seamsOf() });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(String(resolved.error.details['reason'])).toBe('EXECUTION_WORKSPACE_ROOT_NOT_ABSOLUTE');
  });

  it('3. a missing or non-directory root is refused, never guessed', () => {
    const missing = resolveTrustedWorkspaceRoot({ root: 'C:\\work\\absent', ...seamsOf() });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(String(missing.error.details['reason'])).toBe('EXECUTION_WORKSPACE_ROOT_MISSING');

    const file = resolveTrustedWorkspaceRoot({
      root: 'C:\\work\\file.txt',
      ...seamsOf({ existing: ['C:\\work\\file.txt'], directories: [] }),
    });
    expect(file.ok).toBe(false);
    if (file.ok) return;
    expect(String(file.error.details['reason'])).toBe('EXECUTION_WORKSPACE_ROOT_NOT_DIRECTORY');
  });
});

describe('S25 workspace — cwd containment by component boundary (§24-§25)', () => {
  it('4. the root itself and a child directory are allowed', () => {
    const root = assertExecutionCwdAllowed({ cwd: ROOT, canonicalRoot: ROOT, ...rootSeams({ existing: [ROOT, 'C:\\work\\project\\src'], directories: [ROOT, 'C:\\work\\project\\src'] }) });
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(root.value.canonicalCwd).toBe(ROOT);

    const child = assertExecutionCwdAllowed({
      cwd: 'C:\\work\\project\\src',
      canonicalRoot: ROOT,
      ...rootSeams({ existing: [ROOT, 'C:\\work\\project\\src'], directories: [ROOT, 'C:\\work\\project\\src'] }),
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.value.canonicalCwd).toBe('C:\\work\\project\\src');
  });

  it('5. a SIBLING with a shared prefix is refused (C:\\work\\foo must not accept C:\\work\\foobar)', () => {
    const checked = assertExecutionCwdAllowed({ cwd: 'C:\\work\\project-evil', canonicalRoot: ROOT, ...rootSeams() });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(String(checked.error.details['reason'])).toBe('REPOSITORY_PATH_OUTSIDE_ROOT');
  });

  it('6. a traversal written in ABSOLUTE form normalizes before the comparison and is refused', () => {
    // `..\project-evil` lexically starts with the root's name but resolves outside it.
    const checked = assertExecutionCwdAllowed({
      cwd: 'C:\\work\\project\\..\\project-evil',
      canonicalRoot: ROOT,
      ...rootSeams({ existing: [ROOT, 'C:\\work\\project-evil'], directories: [ROOT, 'C:\\work\\project-evil'] }),
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(String(checked.error.details['reason'])).toBe('REPOSITORY_PATH_OUTSIDE_ROOT');
  });

  it('7. an absolute path whose CANONICAL form leaves the root is refused (a link out)', () => {
    const checked = assertExecutionCwdAllowed({
      cwd: 'C:\\work\\project\\out',
      canonicalRoot: ROOT,
      ...rootSeams({
        existing: [ROOT, 'C:\\work\\project\\out', 'D:\\elsewhere'],
        directories: [ROOT, 'C:\\work\\project\\out', 'D:\\elsewhere'],
        realpaths: { 'C:\\work\\project\\out': 'D:\\elsewhere' },
      }),
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(String(checked.error.details['reason'])).toBe('REPOSITORY_PATH_OUTSIDE_ROOT');
  });

  it('8. a relative cwd is refused before anything is spawned', () => {
    const checked = assertExecutionCwdAllowed({ cwd: 'src', canonicalRoot: ROOT, ...rootSeams() });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(String(checked.error.details['reason'])).toBe('EXECUTION_CWD_NOT_ABSOLUTE');
  });

  it('9. an absent cwd is refused (never a default directory)', () => {
    const missing = assertExecutionCwdAllowed({ cwd: '   ', canonicalRoot: ROOT, ...rootSeams() });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(String(missing.error.details['reason'])).toBe('EXECUTION_CWD_MISSING');

    const gone = assertExecutionCwdAllowed({ cwd: 'C:\\work\\project\\vanished', canonicalRoot: ROOT, ...rootSeams() });
    expect(gone.ok).toBe(false);
    if (gone.ok) return;
    expect(String(gone.error.details['reason'])).toBe('EXECUTION_CWD_MISSING_ON_DISK');
  });

  it('10. a cwd that exists but is a FILE is refused', () => {
    const checked = assertExecutionCwdAllowed({
      cwd: 'C:\\work\\project\\file.txt',
      canonicalRoot: ROOT,
      ...rootSeams({ existing: [ROOT, 'C:\\work\\project\\file.txt'], directories: [ROOT] }),
    });    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(String(checked.error.details['reason'])).toBe('EXECUTION_CWD_NOT_DIRECTORY');
  });

  it('11. a symlink/junction on the path out is refused (reparse escape)', () => {
    const checked = assertExecutionCwdAllowed({
      cwd: 'C:\\work\\project\\link',
      canonicalRoot: ROOT,
      ...rootSeams({ existing: [ROOT, 'C:\\work\\project\\link'], directories: [ROOT, 'C:\\work\\project\\link'], links: { 'C:\\work\\project\\link': true } }),
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(String(checked.error.details['reason'])).toBe('REPOSITORY_PATH_REPARSE_POINT');
  });

  it('12. case folding follows the platform (Windows folders, POSIX does not)', () => {
    const posix: WorkspaceFsSeams = {
      platform: 'linux',
      realpath: (p) => p,
      stat: () => ({ isDirectory: () => true }),
      lstat: () => ({ isSymbolicLink: () => false }),
    };
    // A case-sensitive filesystem must NOT accept a differently-cased root.
    const posixMatch = assertExecutionCwdAllowed({ cwd: 'C:\\repo\\ws\\app', canonicalRoot: 'C:\\Repo\\Ws', ...posix });
    expect(posixMatch.ok).toBe(false);
    if (posixMatch.ok) return;
    expect(String(posixMatch.error.details['reason'])).toBe('REPOSITORY_PATH_OUTSIDE_ROOT');

    // A Windows filesystem must accept the same pair.
    const windows: WorkspaceFsSeams = { ...posix, platform: 'win32' };
    const windowsMatch = assertExecutionCwdAllowed({ cwd: 'C:\\repo\\ws\\app', canonicalRoot: 'C:\\Repo\\Ws', ...windows });
    expect(windowsMatch.ok).toBe(true);
  });
});

describe('S25 workspace — the write boundary (§26)', () => {
  it('13. a write inside the root is allowed and one outside it is refused', () => {
    const inside = assertWritePathWithinRoot({
      targetPath: 'C:\\work\\project\\out.txt',
      canonicalRoot: ROOT,
      ...rootSeams({ existing: [ROOT], directories: [ROOT] }),
    });
    expect(inside.ok).toBe(true);

    const outside = assertWritePathWithinRoot({
      targetPath: 'C:\\work\\project\\..\\victim.txt',
      canonicalRoot: ROOT,
      ...rootSeams({ existing: [ROOT, 'C:\\work'], directories: [ROOT, 'C:\\work'] }),
    });
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(String(outside.error.details['reason'])).toBe('REPOSITORY_PATH_OUTSIDE_ROOT');
  });
});
