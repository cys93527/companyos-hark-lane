/**
 * RepositoryPathPolicy (Sprint 17 — Task-17-02; ADR-0028 D5/D6/D7/D11–D24).
 *
 * THE single authority for "may this relative path be touched, and where does it land".
 * Every future repository adapter (filesystem/search/git/process cwd) MUST route through
 * this policy — no adapter may `path.join(root, input)` on its own (T17-02 §10).
 *
 * Rejected outright (platform-independent lexical layer): non-string / empty input,
 * absolute POSIX paths, Windows drive paths (`C:` form), UNC shares, device paths
 * (`\\?\`, `\\.\`), NUL, empty segments, and any `..` traversal — normalization runs
 * first, so a `startsWith('../')` test is never sufficient (ADR-0028 D11–D13).
 *
 * Containment is platform-aware (never a raw `startsWith(root)`, which would accept
 * `/tmp/repo-evil` for root `/tmp/repo`), and symlink/junction/reparse traversal of any
 * EXISTING segment is refused (V1 fails closed — a link pointing back inside the root is
 * still refused; ADR-0028 D6/D17).
 */
import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, resolve, sep, win32 } from 'node:path';

import type { RepositoryOperation, WorkspaceContext } from './workspace.js';

export interface ResolveRepositoryPathInput {
  readonly context: WorkspaceContext;
  /** Untrusted input: a workspace-relative path string from a model/agent. */
  readonly input: unknown;
  readonly operation: RepositoryOperation;
  /** Only operations that explicitly allow the workspace root may name it (`'.'`). */
  readonly allowRoot?: boolean;
}

/** Controlled resolution result. `internalAbsolutePath` never enters a Tool output (D23). */
export interface ResolvedRepositoryPath {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly internalAbsolutePath: string;
}

export interface RepositoryPathPolicy {
  resolve(input: ResolveRepositoryPathInput): Result<ResolvedRepositoryPath, DomainError>;
  /** Is this relative path inside `.git`? (read/search excluded by default; write forbidden) */
  isGitInternal(relativePath: string): boolean;
}

/** One literal backslash taken from the platform table — never a hand-escaped regex. */
const BACKSLASH = win32.sep;

/** Treat both `/` and `\\` as separators for every escape decision (ADR-0028 D13). */
const normalizeSeparators = (value: string): string => value.split(BACKSLASH).join('/');

const segmentsOf = (value: string): string[] =>
  normalizeSeparators(value).split('/').filter((segment) => segment.length > 0);

const containsParentTraversal = (value: string): boolean =>
  segmentsOf(value).some((segment) => segment === '..');

const containsEmptySegment = (value: string): boolean => {
  const normalized = normalizeSeparators(value);
  return normalized.startsWith('/') || normalized.endsWith('/') || normalized.includes('//');
};

const hasDriveLetter = (value: string): boolean => /^[a-zA-Z]:/.test(value);

const isUncLike = (value: string): boolean =>
  normalizeSeparators(value).startsWith('//') || value.startsWith(BACKSLASH + BACKSLASH);

const isDeviceLike = (value: string): boolean => {
  const normalized = normalizeSeparators(value);
  if (value.startsWith(BACKSLASH + BACKSLASH + '?') || value.startsWith(BACKSLASH + BACKSLASH + '.')) return true;
  return normalized.startsWith('//?') || normalized.startsWith('//.');
};

/** `.git` as a real path segment only — `.gitignore` and `my.git.txt` are fine (D47). */
const isGitInternalRelative = (relativePath: string): boolean => {
  const segments = segmentsOf(relativePath);
  return segments.length > 0 && segments[0]!.toLowerCase() === '.git';
};

/** Platform-aware containment: case-folded where the filesystem requires it (never a raw prefix). */
const caseFold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);

const insideRoot = (root: string, candidate: string): boolean => {
  if (caseFold(candidate) === caseFold(root)) return true;
  const withSep = root.endsWith(sep) ? root : root + sep;
  return caseFold(candidate).startsWith(caseFold(withSep));
};

/** Every EXISTING segment path of the target (root first), so a link on the way out is always seen. */
const collectExistingSegments = (
  canonicalRoot: string,
  segments: readonly string[],
  lstat: (p: string) => unknown,
): string[] => {
  const existing: string[] = [canonicalRoot];
  let current = canonicalRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      lstat(current);
      existing.push(current);
    } catch {
      break;
    }
  }
  return existing;
};

/** Refuse traversal through any symlink/junction/reparse point (V1 fails closed). */
const assertNoReparseEscapeThrowing = (
  canonicalRoot: string,
  targetPath: string,
  lstat: (p: string) => { isSymbolicLink(): boolean },
): void => {
  let current = targetPath;
  for (;;) {
    if (lstat(current).isSymbolicLink()) {
      throw domainError('INVALID_ARGUMENT', 'The path traverses a symlink/junction/reparse point — refused.', {
        reason: 'REPOSITORY_PATH_REPARSE_POINT',
      });
    }
    if (caseFold(current) === caseFold(canonicalRoot)) return;
    const parent = resolve(current, '..');
    if (parent === current) return;
    current = parent;
  }
};

/**
 * ABSOLUTE-path containment for the trusted workspace root (Sprint25).
 *
 * Distinct from `resolve()` above, which takes an untrusted workspace-RELATIVE
 * string from a model: this takes an ABSOLUTE path — the executor's spawn cwd, or
 * a write target — that a TRUSTED caller (or a validated composition value)
 * supplies, and answers one question: is it the canonical root or inside it?
 *
 * The comparison is a PATH COMPONENT BOUNDARY test, never a raw string prefix:
 * `root + sep` is compared as a prefix, so `C:\work\foo` accepts
 * `C:\work\foo\bar` and refuses `C:\work\foobar`. Case folding follows the
 * platform (Windows paths are case-insensitive), and the caller is expected to
 * normalize first (`node:path.resolve`) so that `root\..\other` cannot pass.
 */
export const assertPathWithinCanonicalRoot = (input: {
  readonly candidate: string;
  readonly canonicalRoot: string;
  /** Defaults to the host platform; injected so the decision is testable on any OS. */
  readonly platform?: NodeJS.Platform;
}): Result<true, DomainError> => {
  const platform = input.platform ?? process.platform;
  if (input.candidate.includes(String.fromCharCode(0))) {
    return err(
      domainError('INVALID_ARGUMENT', 'The path must not contain NUL.', {
        reason: 'REPOSITORY_PATH_NUL',
      }),
    );
  }
  if (isDeviceLike(input.candidate)) {
    return err(
      domainError('INVALID_ARGUMENT', 'Device paths are refused.', {
        reason: 'REPOSITORY_PATH_DEVICE',
      }),
    );
  }
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value);
  const root = fold(input.canonicalRoot);
  const candidate = fold(input.candidate);
  if (candidate === root) return ok(true);
  // H14: the separator of the platform the decision is FOR (the injected one), not the host's.
  const platformSep = platform === 'win32' ? win32.sep : posix.sep;
  const withSep = root.endsWith(platformSep) ? root : `${root}${platformSep}`;
  if (candidate.startsWith(withSep)) return ok(true);
  return err(
    domainError('INVALID_ARGUMENT', 'The path is outside the trusted workspace root.', {
      reason: 'REPOSITORY_PATH_OUTSIDE_ROOT',
    }),
  );
};

/**
 * Refuse traversal through any symlink/junction/reparse point between an absolute
 * target and the canonical root (Sprint25, same law as the relative-path policy:
 * V1 fails closed). The walk starts at the target and stops at the root, so a
 * link planted anywhere on the path out is always seen.
 */
export const assertNoReparseEscape = (input: {
  readonly canonicalRoot: string;
  readonly targetPath: string;
  readonly lstat: (p: string) => { isSymbolicLink(): boolean };
  readonly platform?: NodeJS.Platform;
}): Result<true, DomainError> => {
  const platform = input.platform ?? process.platform;
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value);
  let current = input.targetPath;
  for (;;) {
    let link: { isSymbolicLink(): boolean };
    try {
      link = input.lstat(current);
    } catch {
      // A missing intermediate path is not an escape: containment was already
      // proven on the canonical form, and the caller validates existence.
      return ok(true);
    }
    if (link.isSymbolicLink()) {
      return err(
        domainError('INVALID_ARGUMENT', 'The path traverses a symlink/junction/reparse point — refused.', {
          reason: 'REPOSITORY_PATH_REPARSE_POINT',
        }),
      );
    }
    if (fold(current) === fold(input.canonicalRoot)) return ok(true);
    const parent = (platform === 'win32' ? win32 : posix).resolve(current, '..');
    if (parent === current) return ok(true);
    current = parent;
  }
};

export function createRepositoryPathPolicy(fs?: {
  readonly lstat?: (p: string) => { isSymbolicLink(): boolean };
  readonly realpath?: (p: string) => string;
}): RepositoryPathPolicy {
  const lstat = fs?.lstat ?? ((p: string) => lstatSync(p));
  const realpath = fs?.realpath ?? ((p: string) => realpathSync(p));

  return {
    isGitInternal(relativePath: string): boolean {
      return isGitInternalRelative(relativePath);
    },

    resolve(input: ResolveRepositoryPathInput): Result<ResolvedRepositoryPath, DomainError> {
      const { context } = input;
      const reject = (reason: string, message: string): Result<ResolvedRepositoryPath, DomainError> =>
        err(
          domainError('INVALID_ARGUMENT', message, {
            reason,
            workspaceId: context.workspaceId,
            relativeInput: typeof input.input === 'string' ? input.input : null,
          }),
        );

      if (typeof input.input !== 'string') {
        return reject('REPOSITORY_PATH_NOT_STRING', 'The repository path must be a string.');
      }
      const raw = input.input;
      if (raw.trim() === '') return reject('REPOSITORY_PATH_EMPTY', 'The repository path must not be empty.');
      if (raw.includes(String.fromCharCode(0))) {
        return reject('REPOSITORY_PATH_NUL', 'The repository path must not contain NUL.');
      }

      // Most-specific reasons first: a drive-qualified or device path is also "absolute".
      if (isDeviceLike(raw)) return reject('REPOSITORY_PATH_DEVICE', 'Device paths are refused.');
      if (hasDriveLetter(raw)) return reject('REPOSITORY_PATH_DRIVE_QUALIFIED', 'Drive-qualified paths are refused.');
      if (isUncLike(raw)) return reject('REPOSITORY_PATH_UNC', 'UNC paths are refused.');
      const normalizedSeparators = normalizeSeparators(raw);
      if (isAbsolute(normalizedSeparators) || normalizedSeparators.startsWith('/')) {
        return reject('REPOSITORY_PATH_ABSOLUTE', 'Absolute paths are refused; pass a workspace-relative path.');
      }
      if (containsEmptySegment(normalizedSeparators)) {
        return reject('REPOSITORY_PATH_EMPTY_SEGMENT', 'The repository path has an empty segment.');
      }
      if (containsParentTraversal(normalizedSeparators)) {
        return reject('REPOSITORY_PATH_PARENT_ESCAPE', 'Parent traversal is refused.');
      }

      // Normalize "." segments lexically (an escape would already have been rejected).
      const cleanSegments = segmentsOf(normalizedSeparators).filter((segment) => segment !== '.');
      if (cleanSegments.length === 0) {
        if (input.allowRoot === true) {
          return ok({ workspaceId: context.workspaceId, relativePath: '.', internalAbsolutePath: context.canonicalRoot });
        }
        return reject('REPOSITORY_PATH_EMPTY', 'The repository path must not be empty.');
      }
      const relativePath = cleanSegments.join('/');

      // Git internals are reachable only through repo.git; SEARCH may enumerate around them.
      if (isGitInternalRelative(relativePath) && input.operation !== 'SEARCH') {
        return reject('REPOSITORY_PATH_GIT_INTERNAL', 'The .git directory is not directly accessible.');
      }

      const target = resolve(context.canonicalRoot, ...cleanSegments);
      // Layer 1: platform-aware lexical containment (never a raw prefix test — D14).
      if (!insideRoot(context.canonicalRoot, target)) {
        return reject('REPOSITORY_PATH_OUTSIDE_ROOT', 'The resolved path escapes the workspace root.');
      }
      // Layer 2: real filesystem — every existing segment must be real (D15/D16/D17).
      try {
        const existingSegments = collectExistingSegments(context.canonicalRoot, cleanSegments, lstat);
        for (const segmentPath of existingSegments) {
          assertNoReparseEscapeThrowing(context.canonicalRoot, segmentPath, lstat);
        }
        if (existingSegments.length === cleanSegments.length + 1) {
          const canonicalTarget = realpath(target);
          if (!insideRoot(context.canonicalRoot, canonicalTarget)) {
            return reject('REPOSITORY_PATH_OUTSIDE_ROOT', 'The resolved path escapes the workspace root.');
          }
        }
      } catch (error) {
        const reason = (error as { details?: { reason?: string } }).details?.reason;
        if (reason === 'REPOSITORY_PATH_REPARSE_POINT') return err(error as DomainError);
        return reject('REPOSITORY_PATH_OUTSIDE_ROOT', 'The resolved path escapes the workspace root.');
      }

      return ok({
        workspaceId: context.workspaceId,
        relativePath,
        internalAbsolutePath: target,
      });
    },
  };
}
