/**
 * STAGE 5B — upgrade an ALREADY-MATERIALIZED managed root to the execution-closure
 * contract in place (no rebuild): derives the closure from the existing tree,
 * writes closure-manifest.json, and records closureGeneration in manifest.json.
 * Development convenience ONLY — the canonical path is a fresh materialization.
 *
 * Usage: node scripts/write-runtime-execution-closure.mjs [--target <managedRoot>]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { deriveRuntimeExecutionClosure } from './lib/runtime-execution-closure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const target = (() => {
  const at = process.argv.indexOf('--target');
  return at >= 0 ? resolve(process.argv[at + 1]) : join(REPO_ROOT, '.companyos-embedded', 'dsh-runtime');
})();

const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
delete manifest.integrityManifest; // superseded by the Stage 5B closure contract
delete manifest.closureGeneration;
writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const closure = deriveRuntimeExecutionClosure({ managedRoot: target, manifest });
writeFileSync(join(target, 'closure-manifest.json'), JSON.stringify(closure), 'utf8');

const withGeneration = {
  ...manifest,
  closureGeneration: createHash('sha256').update(readFileSync(join(target, 'closure-manifest.json'))).digest('hex'),
};
writeFileSync(join(target, 'manifest.json'), JSON.stringify(withGeneration, null, 2) + '\n', 'utf8');
console.log(`[closure] ${String(closure.counts.totalCritical)} critical files (exec ${String(closure.counts.EXECUTABLE_CRITICAL)} / config ${String(closure.counts.CONFIG_CRITICAL)} / native ${String(closure.counts.NATIVE_CRITICAL)}), generation ${closure.generation.slice(0, 16)}…`);
