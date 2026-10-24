#!/usr/bin/env node
/**
 * Aggregate-gate self-test (T0.12).
 *
 * `pnpm check` must fail fast: a non-zero step stops the run immediately, prints
 * the per-step summary, and exits non-zero. We prove that with `--only boundaries`
 * pointed at a deliberately broken fixture tree, so the assertion never depends on
 * breaking the real repository.
 *
 *   node --test scripts/tests/
 */
import './offline-test-profile.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHECK = join(ROOT, 'scripts', 'check.mjs');
const guard = createRequire(import.meta.url)('../test-offline-guard.cjs').installOfflineGuard();
guard.registerFixture(CHECK);
const created = [];

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-gate 路径-'));
  created.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dir, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const runCheck = (args) =>
  spawnSync(process.execPath, [CHECK, ...args], { cwd: ROOT, encoding: 'utf8' });

after(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

test('prints a per-step summary and exits 0 when the executed step passes', () => {
  const root = fixture({
    'packages/core/package.json': JSON.stringify({ name: '@companyos/core', version: '0.0.0' }),
    'packages/core/src/index.ts': 'export const fine = true;\n',
  });
  const result = runCheck(['--only', 'boundaries', '--root', root]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CompanyOS pnpm check — summary/);
  assert.match(result.stdout, /✅ PASS\s+boundaries/);
  assert.match(result.stdout, /1× PASS/);
});

test('fails the gate when the step fails', () => {
  const root = fixture({
    'packages/core/package.json': JSON.stringify({ name: '@companyos/core', version: '0.0.0' }),
    'packages/core/src/index.ts': 'export const repository = true;\n',
  });
  const result = runCheck(['--only', 'boundaries', '--root', root]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /❌ pnpm check FAILED at step "boundaries"/);
});

test('rejects an unknown step instead of silently passing', () => {
  const result = runCheck(['--only', 'does-not-exist']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown step/);
});
