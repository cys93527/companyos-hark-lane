#!/usr/bin/env node
/**
 * T0.1 — workspace integrity check.
 *
 * Verifies that every workspace directory has a manifest, that names are unique
 * and correctly namespaced, and prints a one-line summary. Exits 1 on the first
 * structural problem so CI fails loudly instead of silently skipping a package.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Globs from pnpm-workspace.yaml, resolved to directories. */
const WORKSPACE_ROOTS = ['packages', 'apps', 'packs'];

const problems = [];
const packages = [];

for (const root of WORKSPACE_ROOTS) {
  const absolute = join(ROOT, root);
  if (!existsSync(absolute)) continue;
  for (const entry of readdirSync(absolute)) {
    const dir = join(absolute, entry);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) {
      problems.push(`${root}/${entry} has no package.json`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      problems.push(`${root}/${entry}/package.json is not valid JSON: ${error.message}`);
      continue;
    }
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      problems.push(`${root}/${entry}/package.json has no "name"`);
      continue;
    }
    if (manifest.name !== 'companyos' && !manifest.name.startsWith('@companyos/')) {
      problems.push(`${root}/${entry} name "${manifest.name}" must be scoped as @companyos/*`);
    }
    if (manifest.private !== true) {
      problems.push(`${root}/${entry} must be private (Sprint 0 ships no publishable package)`);
    }
    packages.push({ dir: `${root}/${entry}`, name: manifest.name, version: manifest.version ?? '0.0.0' });
  }
}

const names = packages.map((pkg) => pkg.name);
const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
if (duplicates.length > 0) problems.push(`duplicate package names: ${[...new Set(duplicates)].join(', ')}`);

const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
for (const required of ['check', 'lint', 'typecheck', 'test', 'build']) {
  if (typeof rootManifest.scripts?.[required] !== 'string') {
    problems.push(`root package.json has no "${required}" script`);
  }
}
if (rootManifest.private !== true) problems.push('root package.json must be private');
if (!existsSync(join(ROOT, 'pnpm-lock.yaml'))) problems.push('pnpm-lock.yaml is missing (run pnpm install)');

if (problems.length > 0) {
  console.error(`❌ workspace check FAILED — ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`   ${problem}`);
  process.exit(1);
}

console.log(`✅ workspace ok: ${packages.length} packages`);
for (const pkg of packages) console.log(`   ${pkg.name.padEnd(26)} ${pkg.version}  (${pkg.dir})`);
process.exit(0);
