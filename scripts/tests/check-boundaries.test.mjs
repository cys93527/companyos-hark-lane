#!/usr/bin/env node
/**
 * Self-tests for the architecture boundary gate (T0.11).
 *
 * Runs scripts/check-boundaries.mjs over throw-away fixture trees so we prove the
 * gate FAILS on each of the 8 Industry-Pack nouns and PASSES on a clean tree —
 * without ever putting a violation inside the real repository.
 *
 *   node --test scripts/tests/
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../check-boundaries.mjs', import.meta.url));
const created = [];

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-boundaries-'));
  created.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dir, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const runGate = (root) => spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });

after(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Each forbidden noun must be caught when used as a Core identifier. */
const FORBIDDEN_IDENTIFIERS = ['coding', 'git', 'repository', 'developer', 'CTO', 'article', 'video', 'ecommerce'];

for (const word of FORBIDDEN_IDENTIFIERS) {
  test(`fails when Core names "${word}"`, () => {
    const root = fixture({
      'packages/core/package.json': JSON.stringify({ name: '@companyos/core', version: '0.0.0' }),
      'packages/core/src/violation.ts': `export const ${word} = 'leaked';\n`,
    });
    const result = runGate(root);
    assert.equal(result.status, 1, `gate must fail on "${word}"`);
    assert.match(result.stderr, /LAW1/);
    assert.match(result.stderr, new RegExp(`forbidden word "${word}"`, 'i'));
  });
}

test('passes on a clean Core tree', () => {
  const root = fixture({
    'packages/core/package.json': JSON.stringify({ name: '@companyos/core', version: '0.0.0' }),
    'packages/core/src/index.ts':
      'export const assignment = 1;\nexport const entityStore = 2;\n// a note about vertical packs lives in comments only\n',
  });
  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Architecture boundary check PASSED/);
});

test('ignores forbidden nouns that only appear in comments or string literals', () => {
  const root = fixture({
    'packages/core/package.json': JSON.stringify({ name: '@companyos/core', version: '0.0.0' }),
    'packages/core/src/index.ts':
      '// the word developer must not trip the gate when it is only documentation\n' +
      'export const label = "repository";\n' +
      'export const templated = `git`;\n',
  });
  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
});

test('fails when Core imports an Industry Pack', () => {
  const root = fixture({
    'packages/core/package.json': JSON.stringify({ name: '@companyos/core', version: '0.0.0' }),
    'packages/core/src/index.ts': "import { thing } from '@companyos/pack-coding';\nexport const value = thing;\n",
  });
  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LAW1b/);
});

test('fails when an inner-ring package depends on an outer-ring package', () => {
  const root = fixture({
    'packages/core/package.json': JSON.stringify({ name: '@companyos/core', version: '0.0.0' }),
    'packages/core/src/index.ts': 'export const ok = true;\n',
    'packages/observability/package.json': JSON.stringify({
      name: '@companyos/observability',
      version: '0.0.0',
      dependencies: { '@companyos/core': 'workspace:*' },
    }),
  });
  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LAW2/);
});

test('fails when Core declares runtime dependencies', () => {
  const root = fixture({
    'packages/core/package.json': JSON.stringify({
      name: '@companyos/core',
      version: '0.0.0',
      dependencies: { zod: '^3.24.1' },
    }),
    'packages/core/src/index.ts': 'export const ok = true;\n',
  });
  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must have ZERO runtime dependencies/);
});
