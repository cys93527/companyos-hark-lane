import './offline-test-profile.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOfflineResources, renderFixtureText, TEXT_HASHES } from '../prepare-offline-resources.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const source = readFileSync(path.join(ROOT, 'scripts/materialize-embedded-dsh.mjs'), 'utf8');
const owned = () => mkdtempSync(path.join(process.env.TEMP, 'resource-regression-'));
const B_PATH = '.companyos-embedded/dsh-runtime/runtime/apps/cli/lib/bin.js';

test('exact B fixture is 11697 bytes with its pinned SHA and upstream MIT notice', () => {
  const bytes = readFileSync(path.join(ROOT, 'tests/fixtures/kernel-readonly/bin.js.txt'));
  assert.equal(bytes.length, 11697);
  assert.equal(hash(bytes), '1A03DEE18683483FF6A1B27B2A1E650230DA6BCCA9A0F55F7D81B3308C3F307F');
  const license = readFileSync(path.join(ROOT, 'tests/fixtures/kernel-readonly/LICENSE'), 'utf8');
  assert.match(license, /Copyright \(c\) 2026 DeepSeek/);
  assert.match(license, /Permission is hereby granted/);
  const attributes = readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\/tests\/fixtures\/kernel-readonly\/bin\.js\.txt -text$/m);
});

for (const name of Object.keys(TEXT_HASHES)) {
  test(`${name}: reviewed LF and CRLF source produce the exact historical bytes`, () => {
    const lf = source.replaceAll('\r\n', '\n');
    const bytes = renderFixtureText(lf, name);
    assert.equal(hash(bytes), TEXT_HASHES[name]);
    assert.deepEqual(renderFixtureText(lf.replaceAll('\n', '\r\n'), name), bytes);
    assert.deepEqual(readFileSync(path.join(ROOT, '.companyos-embedded/dsh-runtime', name)), bytes);
  });
}

test('changed source literal fails before evaluation; unknown and ambiguous templates fail', () => {
  assert.throws(() => renderFixtureText(source.replace('mode: workspace-write', 'mode: arbitrary'), 'profile-patch-template.yml'), /template-source-drift/);
  assert.throws(() => renderFixtureText(source, '../unknown'), /unknown-text/);
  assert.throws(() => renderFixtureText(source + source, 'headless-shell-guard.ps1'), /ambiguous-template/);
  assert.throws(() => renderFixtureText('', 'headless-shell-guard.ps1'), /ambiguous-template/);
});

test('empty owned fixture receives exactly three verified files; subsequent preparation does not rewrite', () => {
  const root = owned();
  const first = prepareOfflineResources(root);
  assert.equal(first.length, 3);
  assert.equal(first.filter(row => row.created).length, 3);
  const identities = first.map(row => statSync(path.join(root, row.relativePath), { bigint: true }).ino);
  const second = prepareOfflineResources(root);
  assert.equal(second.filter(row => row.created).length, 0);
  assert.deepEqual(second.map(row => statSync(path.join(root, row.relativePath), { bigint: true }).ino), identities);
  for (const row of second) assert.equal(hash(readFileSync(path.join(root, row.relativePath))), row.sha256);
});

test('existing resource drift fails without correcting bytes or creating later resources', () => {
  const root = owned();
  const file = path.join(root, B_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'do not overwrite');
  assert.throws(() => prepareOfflineResources(root), /existing-resource-drift/);
  assert.equal(readFileSync(file, 'utf8'), 'do not overwrite');
  assert.throws(() => readFileSync(path.join(root, '.companyos-embedded/dsh-runtime/profile-patch-template.yml')), { code: 'ENOENT' });
});

test('unapproved root and directory traversal are denied without writes', () => {
  assert.throws(() => prepareOfflineResources(path.dirname(ROOT)), /unapproved-root/);
  assert.throws(() => prepareOfflineResources(process.env.TEMP + path.sep + ['..', '..', '..'].join(path.sep)), /path-traversal/);
});

test('target junction/symlink escape is refused, including a root alias', () => {
  const root = owned();
  const outside = owned();
  symlinkSync(outside, path.join(root, '.companyos-embedded'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareOfflineResources(root), /link-escape/);
  assert.throws(() => prepareOfflineResources(path.join(root, '.companyos-embedded')), /unapproved-root/);
});

test('resource preparation precedes Guard initialization in both existing offline entries', () => {
  for (const rel of ['scripts/test-offline.mjs', 'scripts/tests/offline-test-profile.mjs']) {
    const entry = readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(entry.indexOf('prepareOfflineResources();') < entry.indexOf("require('"));
    assert.match(entry, /prepare-offline-resources\.mjs/);
  }
});

test('Ubuntu CI retains exact check identity and all original checks, with no ignored failures', () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /^ {2}check:$/m);
  assert.ok(ci.includes('name: check (node ${{ matrix.node }})'));
  assert.match(ci, /runs-on: ubuntu-24\.04/);
  assert.ok(ci.indexOf('run: node scripts/prepare-offline-resources.mjs') < ci.indexOf('run: pnpm check'));
  for (const value of ['pnpm check', 'pnpm test:scripts', 'node scripts/check-workspace.mjs', 'pnpm install --frozen-lockfile', "'22.x'", "'24.x'", 'version: 11.25.0']) assert.ok(ci.includes(value), value);
  assert.doesNotMatch(ci, /continue-on-error|--exclude|\.skip\(/);
  const gates = readFileSync(path.join(ROOT, 'docs/WINDOWS_V1_RELEASE_GATES.md'), 'utf8');
  for (const phrase of ['Windows candidate freeze', 'Windows V1 formal release', 'Ubuntu compatibility CI', 'Shared correctness/security', 'merge must', 'NOT ACCEPTED']) assert.ok(gates.includes(phrase), phrase);
});

test('unchanged non-production TLS fixture matches its loopback certificate without opening sockets', () => {
  const keyBytes = readFileSync(path.join(ROOT, 'tests/fixtures/broker-test-key.pem'));
  const cert = new X509Certificate(readFileSync(path.join(ROOT, 'tests/fixtures/broker-test-cert.pem')));
  // Git line-ending normalization can differ on Linux; the test key itself never changes.
  assert.equal(hash(keyBytes.toString('utf8').replaceAll('\r\n', '\n')), 'CA1A9D6CD8B71199921072B90D22EB90939D3136D0AF20016AA334F21F37E980');
  assert.deepEqual(createPublicKey(createPrivateKey(keyBytes)).export({ type: 'spki', format: 'der' }), cert.publicKey.export({ type: 'spki', format: 'der' }));
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
});
