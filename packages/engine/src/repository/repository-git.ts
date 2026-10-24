/**
 * RepositoryRevisionAnchor + the read-only Git runtime (Sprint 17 — Task-17-05).
 *
 * ONE anchor algorithm, shared by `repo.git`, the QA process tools and (later) the T17-06
 * validator: nothing here is computed twice, and the anchor itself is never a durable entity
 * — it lives inside structured Tool output that the existing ToolInvocation persists.
 *
 * Every Git CLI call goes through THE ONE repository process runner (T17-04): no second
 * spawn, no shell, no free-form argv. The executable is trusted composition data; the model
 * can only name an operation. The safety prefix below disables the repository-config driven
 * external programs (external diff drivers, textconv filters, fsmonitor hooks) and the
 * optional-lock refresh that would otherwise let a "read-only" query mutate the index.
 *
 * The anchor is a read-only VALUE: `workspaceId`, `headSha` (null for an unborn HEAD),
 * `branch`, a `workingTreeFingerprint` that is content-sensitive (never mtime-sensitive),
 * and the bounded relative dirty paths. It never carries the canonical root.
 */
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

import { domainError, err, ok, type DomainError, type Result } from '@companyos/core';

import type { RepositoryProcessRunner, ProcessRunOutcome } from './repository-process-runner.js';
import type { WorkspaceContext } from './workspace.js';

/* ------------------------------------------------------- frozen limits ------ */

/** Boss freeze (T17-05 §29): no unbounded repository state. */
export const MAX_GIT_STATE_ENTRIES = 10_000;
/** Streaming read size for working-tree content hashing (never a whole file in memory). */
const HASH_CHUNK_BYTES = 64 * 1024;

/** Fixed safety argv for EVERY Git invocation (T17-05 §7–§10). */
export const GIT_SAFETY_ARGV: readonly string[] = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
];
/** Extra suppression for diff: no external driver, no textconv, no colour (§9). */
export const GIT_DIFF_SAFETY_ARGV: readonly string[] = ['--no-ext-diff', '--no-textconv', '--no-color'];

/**
 * Trusted environment additions: no optional-lock refresh (a read must not write the index)
 * and no interactive credential prompt (§8).
 */
export const GIT_SAFE_ENV_ADDITIONS: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
};

/** Stable reason codes (T17-05 §66) — the existing taxonomy's vocabulary, not new errors. */
export const GIT_REASONS = {
  NOT_OPEN: 'WORKSPACE_NOT_OPEN',
  UNAVAILABLE: 'GIT_UNAVAILABLE',
  NOT_A_REPOSITORY: 'NOT_A_GIT_REPOSITORY',
  ROOT_OUTSIDE: 'GIT_ROOT_OUTSIDE_WORKSPACE',
  WORKTREE: 'GIT_WORKTREE_UNSUPPORTED',
  BARE: 'GIT_BARE_REPOSITORY_UNSUPPORTED',
  SUBMODULE: 'GIT_SUBMODULE_UNSUPPORTED',
  NESTED_REPOSITORY: 'GIT_NESTED_REPOSITORY_UNSUPPORTED',
  PATH_ENCODING: 'GIT_PATH_ENCODING_UNSUPPORTED',
  STATE_LIMIT: 'GIT_STATE_LIMIT_EXCEEDED',
  COMMAND_FAILED: 'GIT_COMMAND_FAILED',
  OUTPUT_LIMIT: 'OUTPUT_LIMIT_EXCEEDED',
  TIMEOUT: 'PROCESS_TIMEOUT',
} as const;

/* ------------------------------------------------------------- the anchor --- */

export interface RepositoryRevisionAnchor {
  readonly workspaceId: string;
  /** HEAD object id, or null for an unborn repository. */
  readonly headSha: string | null;
  /** Current branch name, or null for a detached HEAD. */
  readonly branch: string | null;
  /** Content-sensitive digest of the working tree (never mtime-sensitive). */
  readonly workingTreeFingerprint: string;
  /** Bounded, unique, deterministically sorted workspace-relative dirty paths. */
  readonly dirtyFiles: readonly string[];
}

/** An anchor the caller may trust, or the honest reason why this workspace has none. */
export type AnchorResult =
  | { readonly supported: true; readonly anchor: RepositoryRevisionAnchor }
  | { readonly supported: false; readonly reason: string; readonly detail?: string };

export type RepositoryRevisionAnchorProvider = {
  /** Current anchor, computed fresh (no ToolInvocation required). */
  getCurrentAnchor(): Promise<AnchorResult>;
};

/* --------------------------------------------------------- git invocation --- */

export interface RepositoryGitDeps {
  /** The ONE shared repository process runner (never a second spawn point). */
  readonly runner: RepositoryProcessRunner;
  /** Trusted composition-supplied Git executable (a model can never name it). */
  readonly gitExecutable: string;
  readonly canonicalRoot: string;
  readonly workspaceId: string;
  /** Milliseconds for one Git invocation (bounded; the runner also enforces its own cap). */
  readonly timeoutMs: number;
}

interface GitRun {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly outcome: ProcessRunOutcome;
}

/** Run ONE fixed Git invocation through the shared runner; returns its bounded stdout bytes. */
const runGit = async (
  deps: RepositoryGitDeps,
  argv: readonly string[],
  executionId: string,
): Promise<Result<GitRun, DomainError>> => {
  const ran = await deps.runner.run({
    descriptor: {
      commandKey: 'git',
      executable: deps.gitExecutable,
      baseArgv: [...GIT_SAFETY_ARGV, ...argv],
      cwd: 'workspace-root',
      safeEnvAdditions: { ...GIT_SAFE_ENV_ADDITIONS },
    },
    canonicalRoot: deps.canonicalRoot,
    workspaceId: deps.workspaceId,
    executionId,
    timeoutMs: deps.timeoutMs,
    includeStreamBytes: true,
  });
  if (!ran.ok) {
    const reason = ran.error.details['reason'];
    return err(
      domainError(
        ran.error.code === 'TIMEOUT' ? 'TIMEOUT' : 'AGENT_UNAVAILABLE',
        'The Git command did not complete normally.',
        {
          reason: typeof reason === 'string' ? reason : GIT_REASONS.COMMAND_FAILED,
          command: argv[0] ?? '',
          workspaceId: deps.workspaceId,
        },
      ),
    );
  }
  const outcome = ran.value;
  if (outcome.exitCode !== 0) {
    // A failing Git command is a stable, sanitized failure: the raw stream evidence (which
    // may contain host paths) stays in the run's own summaries, never in the message.
    return err(
      domainError('AGENT_UNAVAILABLE', 'The Git command failed.', {
        reason: GIT_REASONS.COMMAND_FAILED,
        command: argv[0] ?? '',
        exitCode: outcome.exitCode,
        workspaceId: deps.workspaceId,
      }),
    );
  }
  // The runner already caps the captured bytes at 8 MiB per stream.
  return ok({ exitCode: outcome.exitCode, stdout: outcome.stdoutBytes ?? new Uint8Array(0), outcome });
};

/* ------------------------------------------------------ porcelain v2 parse --- */

interface StatusEntry {
  /** Two-character XY state ('.' == unchanged in that column). */
  readonly xy: string;
  readonly path: string;
  readonly isUntracked: boolean;
  readonly isDirectory: boolean;
  readonly worktreeDiffers: boolean;
  readonly stagedDiffers: boolean;
  /* --- three-layer identity (T17-05 corrective: the INDEX layer is its own input) --- */
  /** HEAD mode (e.g. 100644); '' when unavailable. */
  readonly headMode: string;
  /** HEAD object id; '' when the entry is not in HEAD. */
  readonly headOid: string;
  /** INDEX mode — an executable-bit change is a repository state change. */
  readonly indexMode: string;
  /** INDEX object id: the staged content identity. */
  readonly indexOid: string;
  /** Working-tree mode as Git observed it. */
  readonly worktreeMode: string;
  /** The original path of a rename ('' otherwise). */
  readonly originalPath: string;
}

const ZERO_OID = '0000000000000000000000000000000000000000';

const absent = (value: string): string => (value === '' || value === ZERO_OID ? '' : value);

interface ParsedStatus {
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly entries: readonly StatusEntry[];
}

const decodePathBytes = (bytes: Uint8Array): Result<string, DomainError> => {
  try {
    return ok(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return err(
      domainError('INVALID_ARGUMENT', 'A repository path is not valid UTF-8; it cannot be fingerprinted.', {
        reason: GIT_REASONS.PATH_ENCODING,
      }),
    );
  }
};

/**
 * Parse `git status --porcelain=v2 -z --branch`. Paths arrive as raw bytes and are decoded
 * strictly: a lossy decode would silently fingerprint the wrong identity.
 */
const parsePorcelainV2 = (bytes: Uint8Array): Result<ParsedStatus, DomainError> => {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0) {
      records.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < bytes.byteLength) records.push(bytes.subarray(start));

  let headSha: string | null = null;
  let branch: string | null = null;
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    const decoded = decodePathBytes(record);
    if (!decoded.ok) return err(decoded.error);
    const text = decoded.value;
    if (text.startsWith('# branch.oid ')) {
      const oid = text.slice('# branch.oid '.length).trim();
      headSha = oid === '(initial)' ? null : oid;
      continue;
    }
    if (text.startsWith('# branch.head ')) {
      const head = text.slice('# branch.head '.length).trim();
      branch = head === '(detached)' ? null : head;
      continue;
    }
    if (text.startsWith('#')) continue;
    const space = text.indexOf(' ');
    if (space < 0) continue;
    const kind = text.slice(0, space);
    const rest = text.slice(space + 1);
    if (kind.startsWith('?')) {
      const isDirectory = rest.endsWith('/');
      entries.push({
        xy: '??',
        path: rest,
        isUntracked: true,
        isDirectory,
        worktreeDiffers: true,
        stagedDiffers: false,
        headMode: '',
        headOid: '',
        indexMode: '',
        indexOid: '',
        worktreeMode: '',
        originalPath: '',
      });
      continue;
    }
    const fields = rest.split(' ');
    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`  (ordinary change)
    // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>` + NUL record `<origPath>`
    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` (unmerged)
    const xy = fields[0] ?? '..';
    const unmerged = kind.startsWith('u');
    const identity = unmerged ? fields.slice(4) : fields.slice(2);
    const headMode = unmerged ? '' : (identity[0] ?? '');
    const indexMode = unmerged ? (identity[0] ?? '') : (identity[1] ?? '');
    const worktreeMode = unmerged ? (identity[3] ?? '') : (identity[2] ?? '');
    const headOid = unmerged ? (identity[4] ?? '') : (identity[3] ?? '');
    const indexOid = unmerged ? (identity[5] ?? '') : (identity[4] ?? '');
    // The path begins after the fixed identity columns (unmerged carries three modes/oids).
    const pathFields = unmerged ? fields.slice(9) : fields.slice(7);
    const path = pathFields.join(' ');
    let originalPath = '';
    if (kind.startsWith('2')) {
      // In -z mode the original path is its own NUL-terminated record.
      const next = records[index + 1];
      if (next !== undefined) {
        const decodedOriginal = decodePathBytes(next);
        if (!decodedOriginal.ok) return err(decodedOriginal.error);
        originalPath = decodedOriginal.value;
        index += 1;
      }
    }
    entries.push({
      xy,
      path,
      isUntracked: false,
      isDirectory: false,
      worktreeDiffers: xy[1] !== '.' && xy[1] !== undefined,
      stagedDiffers: xy[0] !== '.' && xy[0] !== undefined,
      headMode,
      headOid: absent(headOid),
      indexMode,
      indexOid: absent(indexOid),
      worktreeMode,
      originalPath,
    });
  }
  return ok({ headSha, branch, entries });
};

/* ------------------------------------------------------- content identity --- */

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Streaming digest of one regular file: a huge file is read in bounded chunks, never whole. */
const hashFileContents = (path: string): string => {
  const digest = createHash('sha256');
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const read = readSync(descriptor, buffer, 0, HASH_CHUNK_BYTES, null);
      if (read <= 0) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest('hex');
};

/** A symlink is identified by its TARGET TEXT: the link is never traversed (§27). */
const hashSymlink = (path: string): string => sha256Hex(new TextEncoder().encode('link\0' + readlinkSync(path)));

/** A safe workspace-relative reader: containment first, then lstat (never following links). */
const digestWorkingTreePath = (
  root: string,
  relativePath: string,
  onWalk: (count: number) => void,
): Result<string, DomainError> => {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    return err(domainError('INVALID_ARGUMENT', 'A repository path escaped the workspace.', { reason: GIT_REASONS.ROOT_OUTSIDE }));
  }
  const absolute = resolve(root, relativePath);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    // A tracked deletion is a real state (the entry itself said the worktree differs), so the
    // fingerprint records the absence rather than failing the whole anchor.
    return ok('absent');
  }
  if (stats.isSymbolicLink()) return ok(hashSymlink(absolute));
  if (stats.isFile()) {
    onWalk(1);
    return ok('file\0' + hashFileContents(absolute));
  }
  if (stats.isDirectory()) return ok('dir\0' + walkDirectory(root, absolute, onWalk));
  return ok('other\0' + String(stats.mode));
};

/** Walk one untracked directory: every regular file contributes path + content identity. */
const walkDirectory = (root: string, directory: string, onWalk: (count: number) => void): string => {
  const digest = createHash('sha256');
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.name === '.git') {
      // A nested repository is an unsupported state (never traversed into).
      throw new NestedRepositoryError();
    }
    const absolute = joinPath(directory, entry.name);
    const relative = relativeTo(root, absolute);
    if (entry.isSymbolicLink()) {
      digest.update(new TextEncoder().encode(relative + '\0' + hashSymlink(absolute) + '\n'));
      onWalk(1);
      continue;
    }
    if (entry.isFile()) {
      digest.update(new TextEncoder().encode(relative + '\0file\0' + hashFileContents(absolute) + '\n'));
      onWalk(1);
      continue;
    }
    if (entry.isDirectory()) {
      digest.update(new TextEncoder().encode(relative + '\0dir\0' + walkDirectory(root, absolute, onWalk) + '\n'));
    }
  }
  return digest.digest('hex');
};

const joinPath = (directory: string, name: string): string => `${directory}${sep}${name}`;
const relativeTo = (root: string, absolute: string): string =>
  absolute.startsWith(root + sep) ? absolute.slice(root.length + 1).split(sep).join('/') : absolute;

class NestedRepositoryError extends Error {}

/* ------------------------------------------------------------- the anchor --- */

export interface ComputeAnchorInput extends RepositoryGitDeps {
  /** Distinct execution id per Git invocation (the runner keys its active table on it). */
  readonly executionIds: { next: () => string };
}

/**
 * Compute the current anchor. Every failure is an explicit reason: a workspace that cannot
 * be fingerprinted yields NO anchor rather than an approximate one.
 */
export const computeRepositoryAnchor = async (input: ComputeAnchorInput): Promise<AnchorResult> => {
  const ids = input.executionIds;
  const unsupported = (reason: string, detail?: string): AnchorResult => ({
    supported: false as const,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });

  // 1. Outside any repository: the very first probe fails. A bare repository IS a repository
  //    but has no working tree, so the answer to the same probe distinguishes both states.
  const bare = await runGit(input, ['rev-parse', '--is-bare-repository'], ids.next());
  if (!bare.ok) return unsupported(GIT_REASONS.NOT_A_REPOSITORY);
  if (new TextDecoder().decode(bytesOf(bare.value)).trim() === 'true') return unsupported(GIT_REASONS.BARE);

  // 2. The Git root must be EXACTLY the open workspace (§11): a workspace inside a larger
  //    repository is refused instead of silently operating on the parent repository.
  const toplevel = await runGit(input, ['rev-parse', '--show-toplevel'], ids.next());
  if (!toplevel.ok) return unsupported(GIT_REASONS.COMMAND_FAILED, 'rev-parse');

  const reportedRoot = new TextDecoder().decode(bytesOf(toplevel.value)).trim();
  const normalizedRoot = resolve(reportedRoot);
  if (normalizedRoot.toLowerCase() !== resolve(input.canonicalRoot).toLowerCase()) {
    return unsupported(GIT_REASONS.ROOT_OUTSIDE);
  }

  // 3. The actual git dir must live INSIDE the workspace (a linked worktree points outside).
  const gitDir = await runGit(input, ['rev-parse', '--absolute-git-dir'], ids.next());
  if (!gitDir.ok) return unsupported(GIT_REASONS.COMMAND_FAILED, 'rev-parse');
  const gitDirPath = resolve(new TextDecoder().decode(bytesOf(gitDir.value)).trim());
  if (!isInside(input.canonicalRoot, gitDirPath)) return unsupported(GIT_REASONS.WORKTREE);

  // 5. A registered submodule (gitlink mode 160000) means another repository: unsupported.
  const lsFiles = await runGit(input, ['ls-files', '--stage', '-z'], ids.next());
  if (!lsFiles.ok) return unsupported(GIT_REASONS.COMMAND_FAILED, 'ls-files');
  if (hasGitlink(bytesOf(lsFiles.value))) return unsupported(GIT_REASONS.SUBMODULE);

  // 6. The full state: branch/head plus every dirty or untracked entry.
  const status = await runGit(input, ['status', '--porcelain=v2', '-z', '--branch'], ids.next());
  if (!status.ok) return unsupported(GIT_REASONS.COMMAND_FAILED, 'status');
  const parsed = parsePorcelainV2(bytesOf(status.value));
  if (!parsed.ok) return unsupported(GIT_REASONS.PATH_ENCODING);

  const state = parsed.value;
  if (state.entries.length > MAX_GIT_STATE_ENTRIES) return unsupported(GIT_REASONS.STATE_LIMIT);

  const digest = createHash('sha256');
  digest.update(new TextEncoder().encode('companyos/repository-anchor/3\n'));
  digest.update(new TextEncoder().encode(`head\0${state.headSha ?? '(unborn)'}\n`));
  digest.update(new TextEncoder().encode(`branch\0${state.branch ?? '(detached)'}\n`));

  let walked = 0;
  const dirtyFiles = new Set<string>();
  try {
    for (const entry of state.entries) {
      const cleanPath = entry.path.replace(/\/$/, '');
      dirtyFiles.add(cleanPath);
      // The THREE layers are independent inputs (T17-05 corrective): HEAD identity, INDEX
      // identity (mode + object id — the staged content) and the WORKING TREE (identity from
      // Git plus the current bytes). A staged-only change therefore alters the fingerprint
      // even when the working tree and the status class are unchanged.
      digest.update(
        new TextEncoder().encode(
          `entry\0${entry.xy}\0${cleanPath}\0${entry.isUntracked ? 'untracked' : 'tracked'}` +
            `\0orig\0${entry.originalPath}` +
            `\0head\0${entry.headMode}:${entry.headOid}` +
            `\0index\0${entry.indexMode}:${entry.indexOid}` +
            `\0worktree-mode\0${entry.worktreeMode}\n`,
        ),
      );
      if (!entry.worktreeDiffers && !entry.stagedDiffers) {
        digest.update(new TextEncoder().encode('clean\n'));
        continue;
      }
      const content = digestWorkingTreePath(input.canonicalRoot, cleanPath, (count) => {
        walked += count;
        if (walked > MAX_GIT_STATE_ENTRIES) throw new StateLimitError();
      });
      if (!content.ok) return unsupported(GIT_REASONS.COMMAND_FAILED);
      digest.update(new TextEncoder().encode(content.value + '\n'));
    }
  } catch (error) {
    if (error instanceof NestedRepositoryError) return unsupported(GIT_REASONS.NESTED_REPOSITORY);
    if (error instanceof StateLimitError) return unsupported(GIT_REASONS.STATE_LIMIT);
    throw error;
  }

  return {
    supported: true as const,
    anchor: {
      workspaceId: input.workspaceId,
      headSha: state.headSha,
      branch: state.branch,
      workingTreeFingerprint: 'sha256:' + digest.digest('hex'),
      dirtyFiles: [...dirtyFiles].sort(),
    },
  };
};

class StateLimitError extends Error {}

const isInside = (root: string, candidate: string): boolean => {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate.toLowerCase() === normalizedRoot.toLowerCase() ||
    normalizedCandidate.toLowerCase().startsWith(normalizedRoot.toLowerCase() + sep)
  );
};

const hasGitlink = (bytes: Uint8Array): boolean => {
  // `git ls-files --stage -z` rows: `<mode> <oid> <stage>\t<path>`. A gitlink is mode 160000.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  for (const row of text.split('\0')) {
    if (row.startsWith('160000 ')) return true;
  }
  return false;
};

/** The runner's bounded capture is not re-serialized here: the outcome IS the evidence. */
const bytesOf = (run: GitRun): Uint8Array => run.stdout;

export interface RepositoryGitRuntimeDeps {
  /** The process-local workspace holder (0/1 active context; T17-02). */
  readonly workspace: () => WorkspaceContext | null;
  /** THE ONE shared process runner (Git has no second spawn point). */
  readonly runner: RepositoryProcessRunner;
  /** Trusted composition-supplied Git executable (a model can never name it). */
  readonly gitExecutable: string;
  /** Milliseconds per Git invocation. */
  readonly timeoutMs: number;
}

/**
 * Build THE ONE read-only anchor provider. It resolves the CURRENT workspace on every call,
 * so a caller (repo.git, a QA tool, the future validator) never has to know which workspace
 * is open — and with no workspace open the answer is an explicit, honest "not supported".
 */
export const createRepositoryRevisionAnchorProvider = (
  deps: RepositoryGitRuntimeDeps,
): RepositoryRevisionAnchorProvider => {
  let counter = 0;
  const executionIds = { next: (): string => `revctl:${String(++counter)}` };
  return {
    async getCurrentAnchor(): Promise<AnchorResult> {
      const context = deps.workspace();
      if (context === null) {
        return { supported: false as const, reason: GIT_REASONS.NOT_OPEN };
      }
      return computeRepositoryAnchor({
        runner: deps.runner,
        gitExecutable: deps.gitExecutable,
        canonicalRoot: context.canonicalRoot,
        workspaceId: context.workspaceId,
        timeoutMs: deps.timeoutMs,
        executionIds,
      });
    },
  };
};
