/**
 * Repository workspace primitives (Sprint 17 — Task-17-02; ADR-0028 D2–D7/D25–D27).
 *
 * Layering ( Placement Recon ): the engine already owns OS-touching runtime primitives
 * (`node:crypto` in artifact-service, `node:async_hooks` in engine), while Core/Contracts
 * must stay pure domain (boundary gate LAW 1b). So:
 *   - the GENERIC workspace/path contract (operation-aware policy, controlled result
 *     shapes, error taxonomy) lives in Core — OS-agnostic, industry-neutral;
 *   - the FS-backed implementation (realpath/lstat/containment) lives HERE, in the engine,
 *     next to the other runtime primitives.
 *
 * Nothing in this module spawns processes, reads the environment or touches Git: it is the
 * "which directory am I allowed to touch" boundary only (T17-03/T17-04 add the tools).
 */
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from '@companyos/core';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/* ------------------------------------------------------------------ types --- */

/** The only operations the V1 policy distinguishes (ADR-0028 D24; no DELETE/RENAME/CHMOD). */
export type RepositoryOperation = 'READ' | 'WRITE' | 'SEARCH';

/** One trusted command slot descriptor (ADR-0028 D10/D25/D26). */
export interface RepositoryCommandDescriptor {
  readonly commandKey: string;
  readonly executable: string;
  readonly baseArgv: readonly string[];
  /** V1: the only supported cwd policy is the workspace root. */
  readonly cwd: 'workspace-root';
  /** Additions to the filtered base environment; never secrets (ADR-0028 D12). */
  readonly safeEnvAdditions: Readonly<Record<string, string>>;
}

/** Trusted, composition-supplied command table (the model can only name a commandKey). */
export type RepositoryCommandProfile = Readonly<Record<string, RepositoryCommandDescriptor>>;

/**
 * Process-local workspace context. `canonicalRoot` is internal: consumers outside this
 * module only ever see `workspaceId` (ADR-0028 D3/D9).
 */
export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly canonicalRoot: string;
  readonly commandProfile: RepositoryCommandProfile;
}

/**
 * The controlled result of a path resolution. `internalAbsolutePath` must never enter an
 * ordinary serialized Tool output (ADR-0028 D23).
 */
export interface ResolvedRepositoryPath {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly internalAbsolutePath: string;
}

export interface OpenWorkspaceInput {
  /** Trusted composition input: an absolute path resolved by the application, never a model/prompt value. */
  readonly root: string;
  readonly commandProfile: RepositoryCommandProfile;
}

/* ------------------------------------------------------------- error codes --- */

const WORKSPACE_ERRORS = {
  ROOT_NOT_ABSOLUTE: 'REPOSITORY_ROOT_NOT_ABSOLUTE',
  ROOT_MISSING: 'REPOSITORY_ROOT_MISSING',
  ROOT_NOT_DIRECTORY: 'REPOSITORY_ROOT_NOT_DIRECTORY',
  ALREADY_OPEN: 'REPOSITORY_WORKSPACE_ALREADY_OPEN',
  PROFILE_MISMATCH: 'REPOSITORY_COMMAND_PROFILE_MISMATCH',
  NOT_OPEN: 'REPOSITORY_WORKSPACE_NOT_OPEN',
  MISMATCH: 'REPOSITORY_WORKSPACE_MISMATCH',
  EMPTY_PATH: 'REPOSITORY_PATH_EMPTY',
  ABSOLUTE_PATH: 'REPOSITORY_PATH_ABSOLUTE',
  DRIVE_PATH: 'REPOSITORY_PATH_DRIVE_QUALIFIED',
  UNC_PATH: 'REPOSITORY_PATH_UNC',
  DEVICE_PATH: 'REPOSITORY_PATH_DEVICE',
  PARENT_ESCAPE: 'REPOSITORY_PATH_PARENT_ESCAPE',
  OUTSIDE_ROOT: 'REPOSITORY_PATH_OUTSIDE_ROOT',
  REPARSE_POINT: 'REPOSITORY_PATH_REPARSE_POINT',
  GIT_PATH: 'REPOSITORY_PATH_GIT_INTERNAL',
  EMPTY_SEGMENT: 'REPOSITORY_PATH_EMPTY_SEGMENT',
  NOT_STRING: 'REPOSITORY_PATH_NOT_STRING',
} as const;

/** Errors carry the rejected relative input + reason + workspaceId — never the physical root (ADR-0028 D48). */
const pathError = (
  code: string,
  message: string,
  workspaceId: string,
  input: unknown,
): DomainError =>
  domainError('INVALID_ARGUMENT', message, {
    reason: code,
    workspaceId,
    relativeInput: typeof input === 'string' ? input : null,
  });

/* --------------------------------------------------------------- workspace --- */

/**
 * The process-local single-workspace registry (ADR-0028 D27: 0 or 1 active context).
 *
 * Opening is a TRUSTED application action (composition root), never an agent/tool input;
 * there is deliberately no "open-root" tool and no model-controlled root (ADR-0028 D2/D6).
 */
export interface WorkspaceManager {
  /** Fresh process => no active workspace (never restored from durable state). */
  current(): WorkspaceContext | null;
  openWorkspace(input: OpenWorkspaceInput): Promise<Result<WorkspaceContext, DomainError>>;
  closeWorkspace(): Result<true, DomainError>;
  /** Fail closed when a handle from a previous/different workspace is presented. */
  require(stated: { readonly workspaceId: string }): Result<WorkspaceContext, DomainError>;
}

/** Deterministic workspace identity from the canonical real root (no clock/random/pid/company). */
export const workspaceIdOf = (canonicalRoot: string): string => {
  // Imported lazily-free: core exposes the qualified sha256 helper.
  return qualifiedWorkspaceId(canonicalRoot);
};

// Kept in one place so the derivation stays a single authority.
import { sha256Ref } from '@companyos/core';
const qualifiedWorkspaceId = (canonicalRoot: string): string => sha256Ref(canonicalRoot);

export interface WorkspaceManagerOptions {
  readonly realpath?: (p: string) => string;
  readonly isDirectory?: (p: string) => boolean;
  /**
   * T17-07: a guard consulted before the workspace may be closed. A process-local lease
   * service is wired here so a leased repository execution cannot have its workspace closed
   * (which also closes the close→open bypass). Omitted in every non-leasing composition.
   */
  readonly busy?: () => Result<true, DomainError>;
}

export function createWorkspaceManager(
  fsOrOptions?: WorkspaceManagerOptions | {
    readonly realpath?: (p: string) => string;
    readonly isDirectory?: (p: string) => boolean;
  },
): WorkspaceManager {
  const realpath = fsOrOptions?.realpath ?? ((p: string) => realpathSync(p));
  const isDirectory = fsOrOptions?.isDirectory ?? defaultIsDirectory;
  const busy = (fsOrOptions as WorkspaceManagerOptions | undefined)?.busy;

  let active: WorkspaceContext | null = null;

  return {
    current(): WorkspaceContext | null {
      return active;
    },

    async openWorkspace(input: OpenWorkspaceInput): Promise<Result<WorkspaceContext, DomainError>> {
      // A relative root would make "canonical" meaningless: the application must resolve first.
      if (typeof input.root !== 'string' || input.root.trim() === '') {
        return err(pathError(WORKSPACE_ERRORS.ROOT_NOT_ABSOLUTE, 'The workspace root must be a non-empty absolute path.', '', input.root));
      }
      if (!isAbsolute(input.root)) {
        return err(pathError(WORKSPACE_ERRORS.ROOT_NOT_ABSOLUTE, 'The workspace root must be an absolute path.', '', input.root));
      }
      let canonicalRoot: string;
      try {
        canonicalRoot = realpath(input.root);
      } catch {
        return err(pathError(WORKSPACE_ERRORS.ROOT_MISSING, 'The workspace root does not exist (or is unreadable).', '', input.root));
      }
      try {
        if (!isDirectory(canonicalRoot)) {
          return err(pathError(WORKSPACE_ERRORS.ROOT_NOT_DIRECTORY, 'The workspace root is not a directory.', '', canonicalRoot));
        }
      } catch {
        return err(pathError(WORKSPACE_ERRORS.ROOT_MISSING, 'The workspace root does not exist (or is unreadable).', '', input.root));
      }

      const workspaceId = qualifiedWorkspaceId(canonicalRoot);
      if (active !== null) {
        if (active.workspaceId !== workspaceId) {
          // A second, different workspace is a hard refusal — V1 never swaps roots.
          return err(pathError(WORKSPACE_ERRORS.ALREADY_OPEN, 'A different workspace is already open; close it first.', active.workspaceId, null));
        }
        if (!commandProfilesMatch(active.commandProfile, input.commandProfile)) {
          // Never silently replace the active security policy: close and re-open.
          return err(pathError(WORKSPACE_ERRORS.PROFILE_MISMATCH, 'The command profile changed for the open workspace; close and re-open.', workspaceId, null));
        }
        return ok(active); // idempotent re-open of the same canonical workspace + profile
      }
      const context: WorkspaceContext = { workspaceId, canonicalRoot, commandProfile: input.commandProfile };
      active = context;
      return ok(context);
    },

    closeWorkspace(): Result<true, DomainError> {
      // T17-07: a leased repository execution owns the workspace until it terminates.
      if (busy !== undefined) {
        const permitted = busy();
        if (!permitted.ok) return permitted;
      }
      active = null; // process-local only: no filesystem/durable side effect (ADR-0028 D31)
      return ok(true);
    },

    require(stated: { readonly workspaceId: string }): Result<WorkspaceContext, DomainError> {
      if (active === null) {
        return err(pathError(WORKSPACE_ERRORS.NOT_OPEN, 'No workspace is open; the trusted application must open one first.', '', stated.workspaceId));
      }
      if (active.workspaceId !== stated.workspaceId) {
        return err(pathError(WORKSPACE_ERRORS.MISMATCH, 'The presented workspace handle does not match the active workspace.', active.workspaceId, stated.workspaceId));
      }
      return ok(active);
    },
  };
}

const commandProfilesMatch = (a: RepositoryCommandProfile, b: RepositoryCommandProfile): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (left === undefined || right === undefined) return false;
    if (left.executable !== right.executable) return false;
    if (left.cwd !== right.cwd) return false;
    if (left.baseArgv.length !== right.baseArgv.length) return false;
    for (let i = 0; i < left.baseArgv.length; i += 1) {
      if (left.baseArgv[i] !== right.baseArgv[i]) return false;
    }
    const envKeys = new Set([...Object.keys(left.safeEnvAdditions), ...Object.keys(right.safeEnvAdditions)]);
    for (const envKey of envKeys) {
      if (left.safeEnvAdditions[envKey] !== right.safeEnvAdditions[envKey]) return false;
    }
  }
  return true;
};

const defaultIsDirectory = (p: string): boolean => statSync(p).isDirectory();
