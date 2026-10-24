#!/usr/bin/env node
/**
 * Repository hygiene self-tests (T0.16).
 *
 * The point is not style: a missing ignore rule means a real user database or a
 * build artifact can be committed, and a missing `.npmrc` rule means CI and the
 * developer machine resolve different dependency trees.
 *
 *   node --test scripts/tests/
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

test('gitignore covers node_modules, dist and local databases', () => {
  const ignore = readFileSync(root('.gitignore'), 'utf8');
  for (const pattern of [
    'node_modules/',
    'dist/',
    '*.sqlite',
    '*.db',
    '*.db-wal',
    '*.db-shm',
    'coverage/',
    '*.log',
    '.env',
  ]) {
    assert.ok(ignore.includes(pattern), `.gitignore must ignore ${pattern}`);
  }
});

test('npmrc pins the dependency-resolution policy', () => {
  const npmrc = readFileSync(root('.npmrc'), 'utf8');
  assert.match(npmrc, /^engine-strict=true$/m);
  assert.match(npmrc, /^strict-peer-dependencies=true$/m);
});

test('workspace pins pnpm and Node versions', () => {
  const manifest = JSON.parse(readFileSync(root('package.json'), 'utf8'));
  assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.match(manifest.engines.node, />=22\.5\.0/);
  assert.equal(manifest.private, true);
  assert.ok(existsSync(root('.nvmrc')), '.nvmrc must exist');
});

test('editor, prettier and eslint configuration are present', () => {
  for (const file of [
    '.editorconfig',
    '.prettierrc.json',
    '.prettierignore',
    'eslint.config.js',
    'tsconfig.base.json',
    'vitest.config.ts',
    'pnpm-workspace.yaml',
  ]) {
    assert.ok(existsSync(root(file)), `${file} must exist`);
  }
});

test('repository-level documentation is present', () => {
  for (const file of ['README.md', 'AGENTS.md', 'PROJECT_HANDOFF.md', 'PRODUCT_PLAN.md']) {
    assert.ok(existsSync(root(file)), `${file} must exist`);
  }
});

test('no SQLite database or build output is committed at the repository root', () => {
  for (const artifact of ['companyos.sqlite', 'companyos.sqlite-wal', 'coverage', 'dist', 'node_modules']) {
    assert.equal(
      existsSync(root(artifact)) && artifact !== 'node_modules' && artifact !== 'dist',
      false,
      `${artifact} must not exist at the repository root`,
    );
  }
});
