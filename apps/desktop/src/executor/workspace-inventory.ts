/**
 * LIVE-CONTRACT-FILL run 11 (hark-live-goal 42564411429): five of six steps were done and verified when
 * the run stopped; a later run (or a retry attempt) starts in the same workspace, but the kernel was never
 * told that work already exists there, so it could rebuild it from scratch and pay for it again.
 * CompanyOS now lists the files already in the attempt's workspace (bounded) in the task text, with a
 * directive to inspect, reuse and verify them first. Read-only: it never changes the workspace.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Dependency stores, caches and VCS data are not the project's own work. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', 'dist', 'build', '.next', '.cache', '.dsh', 'coverage']);

export interface WorkspaceInventoryLimits {
  readonly maxFiles: number;
  readonly maxDepth: number;
  /** Directory entries read in total, so a huge tree cannot stall the attempt start. */
  readonly maxEntries: number;
}

export const DEFAULT_WORKSPACE_INVENTORY_LIMITS: WorkspaceInventoryLimits = { maxFiles: 60, maxDepth: 4, maxEntries: 5000 };

export interface WorkspaceInventory {
  readonly files: readonly { readonly path: string; readonly sizeBytes: number }[];
  /** More files exist than were listed. */
  readonly truncated: boolean;
}

const sizeLabel = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

export const workspaceInventoryOf = (root: string, limits: WorkspaceInventoryLimits = DEFAULT_WORKSPACE_INVENTORY_LIMITS): WorkspaceInventory => {
  const files: { path: string; sizeBytes: number }[] = [];
  let entries = 0;
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (truncated) return;
    let names: string[];
    try { names = readdirSync(dir).sort((a, b) => a.localeCompare(b)); } catch { return; }
    const subdirs: string[] = [];
    for (const name of names) {
      if (++entries > limits.maxEntries) { truncated = true; return; }
      const full = join(dir, name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        if (!SKIPPED_DIRS.has(name) && depth < limits.maxDepth) subdirs.push(full);
      } else if (stat.isFile()) {
        if (files.length >= limits.maxFiles) { truncated = true; return; }
        files.push({ path: relative(root, full).split(sep).join('/'), sizeBytes: stat.size });
      }
    }
    for (const sub of subdirs) walk(sub, depth + 1);
  };
  walk(root, 1);
  return { files, truncated };
};

/** The task-text line, or null for an empty (fresh) workspace. */
export const workspaceInventoryLineOf = (inventory: WorkspaceInventory): string | null => {
  if (inventory.files.length === 0) return null;
  const listed = inventory.files.map((file) => `${file.path} (${sizeLabel(file.sizeBytes)})`).join(', ');
  return `Workspace already contains work from earlier steps, attempts or runs: ${listed}${inventory.truncated ? ', and more' : ''}. ` +
    'Inspect it first and run its existing tests; reuse, extend or fix what exists and keep work that already passes — ' +
    'never rewrite a working file from scratch or duplicate it under another name.';
};
