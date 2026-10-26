/**
 * Hark lane H15b — production composition of native.job: fail-closed host check,
 * binding manifest verification (exact files, sha256, no extras), typed refusals,
 * never a fallback provider.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { composeNativeJobProvider, NATIVE_JOB_BINDING_MANIFEST, verifyNativeJobBinding } from '../../src/executor/native-lifetime/native-job-composition.js';

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
const WIN = { platform: 'win32', arch: 'x64' } as const;
const op = {
  operationId: 'probe',
  executable: { path: 'C:\\app\\node.exe', sha256: 'a'.repeat(64) },
  inputs: [{ path: 'C:\\app\\probe.js', sha256: 'b'.repeat(64) }],
  args: ['C:\\app\\probe.js'], timeoutMs: 60_000, environment: {},
};

const binding = (files: Record<string, string>, manifest?: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'h15b-binding-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  const m = manifest ?? { package: 'koffi', version: '3.3.3', files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])) };
  writeFileSync(join(dir, NATIVE_JOB_BINDING_MANIFEST), JSON.stringify(m));
  return dir;
};
const GOOD = { 'node_modules/koffi/package.json': '{"version":"3.3.3"}', 'node_modules/koffi/index.js': 'module.exports={}' };

describe('H15b native.job production composition', () => {
  it('non-Windows host -> NATIVE_JOB_UNSUPPORTED_PLATFORM, the loader is never called', () => {
    let loaded = 0;
    const r = composeNativeJobProvider({ bindingDir: binding(GOOD), operations: { k: op }, host: { platform: 'linux', arch: 'x64' }, load: () => { loaded += 1; throw new Error('no'); } });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reasonCode, 'NATIVE_JOB_UNSUPPORTED_PLATFORM');
    assert.equal(loaded, 0);
  });
  it('win32/arm64 is refused too (pinned x64 binding only)', () => {
    const r = composeNativeJobProvider({ bindingDir: binding(GOOD), operations: { k: op }, host: { platform: 'win32', arch: 'arm64' } });
    assert.equal(!r.ok && r.reasonCode, 'NATIVE_JOB_UNSUPPORTED_PLATFORM');
  });
  it('the exact pinned binding verifies', () => {
    assert.equal(verifyNativeJobBinding(binding(GOOD)), null);
  });
  it('a tampered, missing, extra or wrong-version binding is refused before load', () => {
    const tampered = binding(GOOD, { package: 'koffi', version: '3.3.3', files: { ...Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k, sha(v)])), 'node_modules/koffi/index.js': sha('other') } });
    assert.match(verifyNativeJobBinding(tampered) ?? '', /sha256 mismatch/u);
    const extra = binding({ ...GOOD, 'node_modules/koffi/evil.node': 'x' }, { package: 'koffi', version: '3.3.3', files: Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k, sha(v)])) });
    assert.match(verifyNativeJobBinding(extra) ?? '', /unlisted/u);
    const missing = binding(GOOD, { package: 'koffi', version: '3.3.3', files: { ...Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k, sha(v)])), 'node_modules/koffi/gone.js': sha('x') } });
    assert.match(verifyNativeJobBinding(missing) ?? '', /missing/u);
    const version = binding(GOOD, { package: 'koffi', version: '3.3.4', files: Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k, sha(v)])) });
    assert.match(verifyNativeJobBinding(version) ?? '', /not koffi 3\.3\.3/u);
    let loaded = 0;
    const r = composeNativeJobProvider({ bindingDir: tampered, operations: { k: op }, host: WIN, load: () => { loaded += 1; throw new Error('no'); } });
    assert.equal(!r.ok && r.reasonCode, 'NATIVE_JOB_BINDING_REFUSED');
    assert.equal(loaded, 0);
  });
  it('operations must be absolute and sha256-pinned with a bounded timeout', () => {
    const rel = composeNativeJobProvider({ bindingDir: binding(GOOD), operations: { k: { ...op, executable: { path: 'node.exe', sha256: 'a'.repeat(64) } } }, host: WIN });
    assert.equal(!rel.ok && rel.reasonCode, 'NATIVE_JOB_OPERATION_INVALID');
    const unpinned = composeNativeJobProvider({ bindingDir: binding(GOOD), operations: { k: { ...op, inputs: [{ path: 'C:\\x.js', sha256: 'nope' }] } }, host: WIN });
    assert.equal(!unpinned.ok && unpinned.reasonCode, 'NATIVE_JOB_OPERATION_INVALID');
    const long = composeNativeJobProvider({ bindingDir: binding(GOOD), operations: { k: { ...op, timeoutMs: 600_001 } }, host: WIN });
    assert.equal(!long.ok && long.reasonCode, 'NATIVE_JOB_OPERATION_INVALID');
    const none = composeNativeJobProvider({ bindingDir: binding(GOOD), operations: {}, host: WIN });
    assert.equal(!none.ok && none.reasonCode, 'NATIVE_JOB_NO_OPERATIONS');
  });
  it('a binding whose koffi is not exactly 3.3.3 at runtime is refused (port construction)', () => {
    const r = composeNativeJobProvider({ bindingDir: binding(GOOD), operations: { k: op }, host: WIN, load: () => ({ version: '3.3.4' }) as never });
    assert.equal(!r.ok && r.reasonCode, 'NATIVE_JOB_BINDING_REFUSED');
  });
});
