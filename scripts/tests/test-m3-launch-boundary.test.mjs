import './offline-test-profile.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const guard = require('../test-offline-guard.cjs').installOfflineGuard();
const { M3_MATH_TEST, M3_MATH_SOURCES } = require('../test-offline-package.cjs');
const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
const argv = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['-c', 'npm test'];
const denied = fn => assert.throws(fn, /OFFLINE_TEST_EXECUTION_DENIED/);
const run = dir => cp.spawnSync(shell, argv, { cwd: dir, encoding: 'utf8', timeout: 5000 });
const fixture = body => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-testcheck-'));
  try {
    mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({scripts:{test:'node --test tests/math.test.ts'}}));
    writeFileSync(join(dir, 'tests/math.test.ts'), M3_MATH_TEST);
    writeFileSync(join(dir, 'src/math.ts'), M3_MATH_SOURCES[0]);
    return body(dir);
  } finally { rmSync(dir, {recursive:true, force:true}); }
};

test('M3 exact templates execute real pass and failing assertions with observed exits', () => fixture(dir => {
  for (const [index, source] of M3_MATH_SOURCES.entries()) {
    writeFileSync(join(dir, 'src/math.ts'), source);
    guard.registerPackageSnapshot(dir);
    const result = run(dir), trace = guard.packageTraces.at(-1);
    assert.equal(result.status, index === 0 ? 0 : 1);
    assert.match(result.stdout, index === 0 ? /pass 1/ : /fail 1/);
    assert.equal(trace.exitObserved, true); assert.equal(trace.exitCode, result.status);
    assert.ok(trace.PID > 0); assert.equal(trace.node, process.execPath);
    assert.deepEqual(trace.expandedArgv, ['--test', 'tests/math.test.ts']);
  }
}));
test('M3 snapshot must be explicitly registered, not automatically admitted by matching bytes', () => fixture(dir => {
  denied(() => run(dir)); assert.equal(guard.packageTraces.some(row => row.cwd === dir), false);
}));
test('M3 unrelated code and downstream DSH/Provider/ACL module requests are refused', () => fixture(dir => {
  for (const code of ["require('child_process').spawn('powershell.exe',[])", "import '../.companyos-embedded/dsh-runtime/runtime/apps/cli/lib/bin.js'", "fetch('https://external.invalid')", "require('child_process').spawn('icacls.exe',[])", M3_MATH_SOURCES[0] + '// altered']) {
    writeFileSync(join(dir, 'src/math.ts'), code); denied(() => guard.registerPackageSnapshot(dir));
  }
  assert.equal(guard.packageTraces.some(row => row.cwd === dir), false);
}));
test('M3 npm/cmd wrapping and alternate arguments cannot bypass finite contract admission', () => fixture(dir => {
  guard.registerPackageSnapshot(dir);
  denied(() => cp.spawn(shell, [...argv, '&& npm run kernel'], {cwd:dir}));
  denied(() => cp.spawn(shell, argv, {cwd:dir, shell:true}));
  denied(() => cp.spawn('npm', ['test'], {cwd:dir}));
  denied(() => cp.spawn('powershell.exe', ['-Command', 'npm test'], {cwd:dir}));
}));
test('M3 identity and module drift after registration fail closed without new process', () => fixture(dir => {
  guard.registerPackageSnapshot(dir);
  writeFileSync(join(dir, 'src/math.ts'), M3_MATH_SOURCES[1]); denied(() => run(dir));
  guard.registerPackageSnapshot(dir);
  writeFileSync(join(dir, 'tests/other.ts'), 'process.exit(0)'); denied(() => run(dir));
  assert.equal(guard.packageTraces.some(row => row.cwd === dir), false);
}));
test('M3 exact test imports no credential-reading or downstream execution script', () => fixture(dir => {
  assert.equal(readFileSync(join(dir, 'tests/math.test.ts'), 'utf8'), M3_MATH_TEST);
  assert.doesNotMatch(M3_MATH_TEST, /child_process|fetch|process\.env|icacls|powershell|https?:/i);
  guard.registerPackageSnapshot(dir);
  const result = cp.spawnSync(shell, argv, {cwd:dir, encoding:'utf8', timeout:5000, env:{...process.env,COS_MODEL_API_KEY:'SYNTHETIC',ACCESS_TOKEN:'SYNTHETIC'}});
  assert.equal(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC/);
  const cleaned = require('../test-offline-guard.cjs').safeEnvironment({COS_MODEL_API_KEY:'SYNTHETIC',ACCESS_TOKEN:'SYNTHETIC'});
  assert.equal(cleaned.COS_MODEL_API_KEY, undefined); assert.equal(cleaned.ACCESS_TOKEN, undefined);
}));
