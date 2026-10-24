/**
 * STAGE 5B test helper: upgrade a hand-built fixture managed root to the
 * execution-closure contract. The fixture writes its manifest WITHOUT
 * closureGeneration first; this helper derives the closure with the REAL
 * derivation module (scripts/lib/runtime-execution-closure.mjs — the same
 * graph walk production materialization uses), writes closure-manifest.json,
 * and records closureGeneration in manifest.json.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

export const writeFixtureExecutionClosure = (managedRoot: string, manifest: Record<string, unknown>): void => {
  // Load the REAL derivation module (the same graph walk production materialization uses).
  const libPath = join(process.cwd(), 'scripts', 'lib', 'runtime-execution-closure.mjs');
  const require = createRequire(import.meta.url);
  const { deriveRuntimeExecutionClosure } = require(libPath) as {
    deriveRuntimeExecutionClosure: (input: { managedRoot: string; manifest: Record<string, unknown> }) => {
      generation: string;
      counts: { totalCritical: number };
    };
  };
  const clean = { ...manifest };
  delete clean.integrityManifest;
  delete clean.closureGeneration;
  writeFileSync(join(managedRoot, 'manifest.json'), JSON.stringify(clean), 'utf8');
  const closure = deriveRuntimeExecutionClosure({ managedRoot, manifest: clean });
  writeFileSync(join(managedRoot, 'closure-manifest.json'), JSON.stringify(closure), 'utf8');
  const withGeneration = {
    ...clean,
    closureGeneration: createHash('sha256').update(readFileSync(join(managedRoot, 'closure-manifest.json'))).digest('hex'),
  };
  writeFileSync(join(managedRoot, 'manifest.json'), JSON.stringify(withGeneration), 'utf8');
};
