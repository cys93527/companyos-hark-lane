/**
 * BUG BASH closure — the canonical SINGLE-ACTIVE-WORKSPACE change lifecycle.
 *
 * Product contract (workspace-switch forensic, Boss adjudication): the engine is
 * intentionally single-active-workspace (`REPOSITORY_WORKSPACE_ALREADY_OPEN` — a second
 * open is a hard refusal, "V1 never swaps roots"), so the ONLY supported change operation
 * is this trusted main-process lifecycle:
 *
 *   current A → close (lease-guarded) → open B → read back canonical identity
 *
 * FAIL-CLOSED ATOMICITY: the close and the open happen in ONE trusted step. If the close is
 * refused (a leased repository execution owns the workspace — T17-07) A stays canonical; if
 * the open of B fails for any reason, A is re-opened immediately, so no intermediate state
 * and no ambiguous target can ever be observed. The renderer only updates its display from
 * the returned canonical result — its own intent is never authoritative, and goal.create
 * binds to the canonical workspace (never a renderer value), so a refused switch can never
 * redirect execution.
 */
import { posix, win32 } from 'node:path';

import type { DomainError, Result } from '@companyos/core';

export interface WorkspaceSwitchSeams {
  /** The currently canonical workspace root, or null when none is open. */
  readonly currentRoot: () => string | null;
  /** Release the active workspace (engine T17-07 lease guard applies). */
  readonly close: () => Result<true, DomainError>;
  /** Validate + bind a root as the active workspace. */
  readonly open: (root: string) => Promise<Result<{ readonly canonicalRoot: string }, DomainError>>;
  /**
   * AUDIT-D14 — resolve a requested root to its filesystem-canonical form (realpath: subst,
   * junction, symlink, on-disk case) or null when it cannot be resolved. Optional; the
   * lexical comparison below always applies.
   */
  readonly canonicalize?: (root: string) => string | null;
  /** AUDIT-D14 — the host platform for path identity (win32 compares case-insensitively). Defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
}

/**
 * AUDIT-D14 — workspace root identity: lexically normalised (resolved, no trailing
 * separator), case-insensitive on win32. `c:\proj\` and `C:\proj` are the SAME workspace.
 */
export const sameWorkspaceRoot = (a: string, b: string, platform: NodeJS.Platform = process.platform): boolean => {
  const lib = platform === 'win32' ? win32 : posix;
  const norm = (p: string): string => {
    const resolved = lib.resolve(p);
    const root = lib.parse(resolved).root;
    const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
};

export type WorkspaceSwitchResult =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly root: string; readonly error: string };

/**
 * The workspace errors carry their SPECIFIC code in `details.reason` (the engine's
 * pathError keeps the domain code coarse); surface the specific reason so a refusal is
 * unmistakable in the UI, falling back to the domain code.
 */
const refusalCodeOf = (error: DomainError): string => {
  const details = error.details as { reason?: unknown } | undefined;
  const reason = details?.reason;
  return typeof reason === 'string' && reason !== '' ? reason : error.code;
};

export const switchWorkspace = async (
  seams: WorkspaceSwitchSeams,
  requestedRoot: string,
): Promise<WorkspaceSwitchResult> => {
  if (typeof requestedRoot !== 'string' || requestedRoot.trim() === '') {
    return { ok: false, root: '', error: 'WORKSPACE_PATH_REQUIRED' };
  }
  const previous = seams.currentRoot();
  // Idempotent re-affirmation of the SAME canonical workspace is a no-op success. AUDIT-D14:
  // identity is compared on canonical paths (realpath when available, lexical + win32
  // case-insensitive always), and the answer is the CANONICAL root, never the raw request.
  if (previous !== null) {
    const platform = seams.platform ?? process.platform;
    const canonicalRequested = seams.canonicalize?.(requestedRoot) ?? null;
    if (sameWorkspaceRoot(previous, requestedRoot, platform) || (canonicalRequested !== null && sameWorkspaceRoot(previous, canonicalRequested, platform))) {
      return { ok: true, root: previous };
    }
  }
  const closed = seams.close();
  if (!closed.ok) {
    // Lease-guarded (or otherwise refused): A stays canonical, B never became active.
    return { ok: false, root: requestedRoot, error: refusalCodeOf(closed.error) };
  }
  const opened = await seams.open(requestedRoot);
  if (!opened.ok) {
    // Fail closed: restore the previous canonical workspace before reporting the refusal.
    if (previous !== null) {
      const restored = await seams.open(previous);
      if (!restored.ok) {
        // Cannot happen for a root that was open a moment ago; if it ever does, surface
        // the restore failure — the product must never claim a workspace is active that
        // is not canonical.
        return { ok: false, root: requestedRoot, error: `WORKSPACE_RESTORE_FAILED:${refusalCodeOf(restored.error)}` };
      }
    }
    return { ok: false, root: requestedRoot, error: refusalCodeOf(opened.error) };
  }
  return { ok: true, root: opened.value.canonicalRoot };
};
