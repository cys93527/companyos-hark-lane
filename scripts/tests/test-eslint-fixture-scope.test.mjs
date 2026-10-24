import './offline-test-profile.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import config from '../../eslint.config.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCOPE = '.tmp/offline-gates/**';
const before = config.map(entry => Object.keys(entry).length === 1 && entry.ignores
  ? { ignores: entry.ignores.filter(pattern => pattern !== SCOPE) }
  : entry);
const engine = (cwd, rules = config) => new ESLint({ cwd, overrideConfigFile: true, overrideConfig: rules });
const current = engine(ROOT);
const previous = engine(ROOT, before);
const location = relative => path.join(ROOT, relative);

test('exact root offline output scope is the sole new global ignore', () => {
  const ignores = config.filter(entry => Object.keys(entry).length === 1 && entry.ignores).flatMap(entry => entry.ignores);
  assert.equal(ignores.filter(pattern => pattern === SCOPE).length, 1);
  assert.equal(ignores.includes('.tmp/**'), false);
  assert.equal(ignores.includes('**/.tmp/**'), false);
});

test('old selection included nested Kernel and invalid negative outputs; new selection excludes both', async () => {
  for (const relative of [
    '.tmp/offline-gates/node-safety-owned/resource-regression-owned/.companyos-embedded/dsh-runtime/runtime/apps/cli/lib/bin.js',
    '.tmp/offline-gates/node-safety-owned/generated/broken.js',
  ]) {
    assert.equal(await previous.isPathIgnored(location(relative)), false, relative);
    assert.equal(await current.isPathIgnored(location(relative)), true, relative);
  }
});

test('other temporary directories and nested lookalikes remain lint eligible', async () => {
  for (const relative of ['.tmp/other/probe.js', '.tmp/offline-gates-extra/probe.js', 'tests/.tmp/offline-gates/probe.js']) {
    assert.equal(await previous.isPathIgnored(location(relative)), false, relative);
    assert.equal(await current.isPathIgnored(location(relative)), false, relative);
  }
});

test('all existing formal source and test paths retain identical effective lint rules', async () => {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'coverage', 'out', 'release', '.git', '.tmp'].includes(entry.name)) visit(absolute);
      } else if (entry.isFile() && /\.(?:[cm]?js|[cm]?ts|tsx)$/.test(entry.name)) files.push(absolute);
    }
  };
  for (const directory of ['apps', 'packages', 'packs', 'scripts', 'tests', 'docs']) visit(location(directory));
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:[cm]?js|[cm]?ts|tsx)$/.test(entry.name)) files.push(location(entry.name));
  }
  let eligible = 0;
  for (const file of files) {
    const oldConfig = await previous.calculateConfigForFile(file);
    const newConfig = await current.calculateConfigForFile(file);
    assert.equal(Boolean(newConfig), Boolean(oldConfig), file);
    if (oldConfig) {
      eligible += 1;
      assert.deepEqual(newConfig.rules, oldConfig.rules, file);
      assert.deepEqual(newConfig.languageOptions, oldConfig.languageOptions, file);
    }
  }
  assert.ok(eligible > 500, 'must inspect the real candidate, not just synthetic paths');
  for (const relative of ['apps/desktop/src/main.ts', 'packages/core/src/index.ts', 'tests/broker-transport.test.ts', 'scripts/tests/test-offline-safety.test.mjs']) {
    assert.ok(await current.calculateConfigForFile(location(relative)), relative);
  }
  console.log(JSON.stringify({ lintCoverage: { examined: files.length, beforeEligible: eligible, afterEligible: eligible, changedRules: 0 } }));
});

function copyFixture(relative, contents) {
  // The copy has its own config base. Never write a violation into real sources.
  const root = mkdtempSync(path.join(process.env.TEMP, 'lint-scope-copy-'));
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
  return { root, file };
}

test('deliberately invalid formal sources and tests still produce real ESLint failures in owned copies', async () => {
  for (const [relative, text, rule] of [
    ['apps/desktop/src/probe.js', 'scopeMissingSymbol();\n', 'no-undef'],
    ['tests/probe.test.ts', 'export const probe: any = 1;\n', '@typescript-eslint/no-explicit-any'],
    ['scripts/probe.mjs', 'scopeMissingSymbol();\n', 'no-undef'],
    ['.tmp/other/probe.js', 'scopeMissingSymbol();\n', 'no-undef'],
    ['.tmp/offline-gates-extra/probe.js', 'scopeMissingSymbol();\n', 'no-undef'],
  ]) {
    const { root, file } = copyFixture(relative, text);
    const [result] = await engine(root).lintFiles([file]);
    assert.ok(result.errorCount > 0, relative);
    assert.ok(result.messages.some(message => message.ruleId === rule && message.severity === 2), relative);
    const [oldResult] = await engine(root, before).lintFiles([file]);
    assert.deepEqual(result.messages, oldResult.messages, relative);
  }
});

test('physical generated negative fixture fails before the fix and is excluded afterwards without deleting it', async () => {
  const { root, file } = copyFixture('.tmp/offline-gates/generated/broken.js', 'do not overwrite');
  const [oldResult] = await engine(root, before).lintFiles([file]);
  assert.ok(oldResult.fatalErrorCount > 0);
  assert.equal(await engine(root).isPathIgnored(file), true);
  const [newResult] = await engine(root).lintFiles([file]);
  assert.equal(newResult.errorCount, 0);
  assert.ok(newResult.messages.some(message => message.message.includes('ignored')));
  assert.equal(readFileSync(file, 'utf8'), 'do not overwrite');
});
