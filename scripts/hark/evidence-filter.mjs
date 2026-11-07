// LIVE-CONTRACT-FILL run 6 (hark-live-goal 42385697784): the evidence workspace copy carried
// the agent's workspace-local npm cache (~900 content blobs) and, with the other runs' bundles,
// hit the repository's Actions artifact storage quota - the run's evidence was never uploaded.
// Dependency stores, package-manager caches and VCS data are never evidence; the copy is also
// bounded per file and in total so one run can never fill the quota again.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const EVIDENCE_SKIP_DIRS = Object.freeze([
  'node_modules', '.git', '.npm-cache', '.npm', 'npm-cache', '_cacache', '.pnpm-store', '.yarn',
  '.cache', '.turbo', '.gradle', '.venv', 'venv', '__pycache__', '.dsh-stages',
]);
const SKIP = new Set(EVIDENCE_SKIP_DIRS);
export const EVIDENCE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const EVIDENCE_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/** True when a workspace-relative path lies inside a skipped directory (either separator). */
export function isEvidenceSkippedPath(rel) {
  return String(rel).split(/[\\/]+/u).some((part) => SKIP.has(part));
}

/**
 * Walks `root` once: the evidence file list (skipped directories summarised, not listed) and a
 * bounded copy into `dest` when given. Returns { files, skippedDirs, copied, copiedBytes, omitted }.
 */
export function collectWorkspaceEvidence(root, dest = null, { maxFileBytes = EVIDENCE_MAX_FILE_BYTES, maxTotalBytes = EVIDENCE_MAX_TOTAL_BYTES } = {}) {
  const files = [];
  const skippedDirs = [];
  const omitted = [];
  let copied = 0;
  let copiedBytes = 0;
  if (!existsSync(root)) return { files, skippedDirs, copied, copiedBytes, omitted };
  const dirStats = (dir) => {
    let count = 0;
    let bytes = 0;
    const stack = [dir];
    while (stack.length > 0 && count < 200_000) {
      const d = stack.pop();
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else { count += 1; try { bytes += statSync(p).size; } catch { /* vanished */ } }
      }
    }
    return { count, bytes };
  };
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(dir, e.name);
      const rel = relative(root, p);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) { skippedDirs.push({ path: rel, ...dirStats(p) }); continue; }
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      let size = 0;
      try { size = statSync(p).size; } catch { continue; }
      files.push({ path: rel, bytes: size });
      if (dest === null) continue;
      if (size > maxFileBytes || copiedBytes + size > maxTotalBytes) { omitted.push({ path: rel, bytes: size }); continue; }
      const target = join(dest, rel);
      try { mkdirSync(join(target, '..'), { recursive: true }); copyFileSync(p, target); copied += 1; copiedBytes += size; } catch { omitted.push({ path: rel, bytes: size }); }
    }
  };
  walk(root);
  return { files, skippedDirs, copied, copiedBytes, omitted };
}
