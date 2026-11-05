#!/usr/bin/env node
/**
 * TEST-SPEED — run only the tests affected by this branch (docs/hark-lane/TEST_SPEED.md).
 *
 *   node scripts/hark/test-changed.mjs [vitest filters/options...]
 *   pnpm test:changed [vitest filters/options...]
 *
 * Base ref: $TEST_BASE_REF when set, otherwise the first that exists of `origin/hark-lane`
 * (CI checkouts, clones) and `hark-lane` (the lane's local repository has no remote). The
 * selection is `vitest run --changed <merge-base of HEAD and the base>`: committed branch
 * changes plus staged/unstaged edits. A missing base is a typed error, never a silent full
 * or empty run.
 *
 * This is a DEV-LOOP shortcut. It never replaces the full suite: `pnpm test` / `vitest run`
 * stays mandatory in CI (hark-ubuntu) and before any tag/release.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const exists = (ref) => {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

const candidates = process.env.TEST_BASE_REF ? [process.env.TEST_BASE_REF] : ['origin/hark-lane', 'hark-lane'];
const base = candidates.find(exists);
if (!base) {
  console.error(`TEST_CHANGED_BASE_MISSING: none of ${candidates.join(', ')} resolves to a commit; set TEST_BASE_REF`);
  process.exit(2);
}
const mergeBase = git('merge-base', 'HEAD', base);
console.log(`test:changed base ${base} (merge-base ${mergeBase.slice(0, 12)})`);

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const run = spawnSync(process.execPath, [cli, 'run', '--changed', mergeBase, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(run.status ?? 1);
