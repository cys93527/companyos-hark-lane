/**
 * DESKTOP STAGE 1 — workspace selection persistence (OPERATIONAL CONTEXT, not truth).
 *
 * The user's selected workspace directory is the ONE piece of Stage-1 state that must
 * survive an application restart ("select/recover same workspace/runtime context").
 * It is operational context in the ADR-0030 sense: WHICH directory the user chose to
 * work in — never canonical Goal/Plan/Run/Task truth, never consulted by the runtime's
 * settlement/recovery, and never a second Project/Workspace domain entity.
 *
 * Storage: one small JSON document in Electron's userData directory (main-process
 * only, restart-stable). Written ONLY by the main process through the bounded seam
 * below; the renderer sees a path string over allow-listed IPC and nothing else.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';

export const WORKSPACE_SELECTION_FILE = 'workspace-selection.json';

export interface WorkspaceSelection {
  /** The absolute directory path the user selected (never a file, never a URL). */
  readonly root: string;
  readonly selectedAt: string;
}

export const isValidWorkspaceSelection = (value: unknown): value is WorkspaceSelection => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { root?: unknown; selectedAt?: unknown };
  return typeof record.root === 'string' && record.root.length > 0 && typeof record.selectedAt === 'string';
};

/** Read the persisted selection, or null when absent/corrupt (corrupt = absent, never fatal). */
export const readPersistedSelection = (userDataDir: string): WorkspaceSelection | null => {
  const file = join(userDataDir, WORKSPACE_SELECTION_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isValidWorkspaceSelection(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Persist a selection atomically-enough for Stage 1 (single small document). */
export const writePersistedSelection = (
  userDataDir: string,
  selection: WorkspaceSelection,
  writeImpl: (file: string, data: string) => void = writeFileSync,
): void => {
  writeImpl(join(userDataDir, WORKSPACE_SELECTION_FILE), JSON.stringify(selection, null, 2));
};

/** Clear the persisted selection (used when the selected directory disappears). */
export const clearPersistedSelection = (userDataDir: string, unlinkImpl: (file: string) => void = (file) => rmSync(file, { force: true })): void => {
  unlinkImpl(join(userDataDir, WORKSPACE_SELECTION_FILE));
};

/** The selected path must be an existing DIRECTORY before a Goal may target it. */
export const isExistingDirectory = (root: string): boolean => {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
};
