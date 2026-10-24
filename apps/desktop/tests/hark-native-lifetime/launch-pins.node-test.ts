/** Hark lane 3B-3E — launch identity pinning, environment block, argv quoting (real files, no execution). */
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildEnvironmentBlock, compareEnvironmentNames, isVerifiedLaunch, LaunchRefused, quoteWindowsArgument, verifyLaunch,
} from '../../src/executor/native-lifetime/launch-pins.js';
import { baseRequest, makeWorkspace, TEST_POLICY } from './support.js';

const ws = makeWorkspace();
const refused = (fn: () => unknown, reason: string | RegExp): void => {
  assert.throws(fn, (e: unknown) => e instanceof LaunchRefused && (typeof reason === 'string' ? e.reason === reason : reason.test(e.reason)));
};

/** Reference parser: MSVC CRT / CommandLineToArgvW rules (2008+). */
function parseWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i += 1;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    for (; i < line.length; ) {
      const c = line[i]!;
      if (c === '\\') {
        let n = 0;
        while (line[i] === '\\') { n += 1; i += 1; }
        if (line[i] === '"') { arg += '\\'.repeat(Math.floor(n / 2)); if (n % 2 === 1) { arg += '"'; i += 1; } }
        else arg += '\\'.repeat(n);
        continue;
      }
      if (c === '"') {
        if (quoted && line[i + 1] === '"') { arg += '"'; i += 2; continue; }
        quoted = !quoted; i += 1; continue;
      }
      if (!quoted && (c === ' ' || c === '\t')) break;
      arg += c; i += 1;
    }
    out.push(arg);
  }
  return out;
}

describe('verifyLaunch', () => {
  it('mints an immutable, branded launch with exact pins and command line', () => {
    const v = verifyLaunch(baseRequest(ws), TEST_POLICY);
    assert.equal(isVerifiedLaunch(v), true);
    assert.equal(isVerifiedLaunch({ ...v }), false, 'a copy is not a verified launch');
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.identity) && Object.isFrozen(v.argv));
    assert.deepEqual(parseWindowsCommandLine(v.commandLine), [ws.exe, ws.script, '--mode', 'offline fixture']);
  });
  it('refuses tampered or malformed pins', () => {
    refused(() => verifyLaunch(baseRequest(ws, { executable: { path: ws.exe, sha256: '0'.repeat(64) } }), TEST_POLICY), 'pin-mismatch');
    refused(() => verifyLaunch(baseRequest(ws, { executable: { path: ws.exe, sha256: ws.exeSha.toUpperCase() } }), TEST_POLICY), 'pin-malformed');
    refused(() => verifyLaunch(baseRequest(ws, { inputs: [{ path: ws.script, sha256: ws.exeSha }] }), TEST_POLICY), 'pin-mismatch');
  });
  it('refuses relative, non-canonical, aliased and multi-link paths', () => {
    refused(() => verifyLaunch(baseRequest(ws, { executable: { path: 'fixture.exe', sha256: ws.exeSha } }), TEST_POLICY), 'path-not-absolute');
    refused(() => verifyLaunch(baseRequest(ws, { executable: { path: `${ws.root}/tmp/../fixture.exe` /* join() would normalise */, sha256: ws.exeSha } }), TEST_POLICY), 'path-not-canonical');
    // Own workspace: a hard link raises nlink of the shared fixture for every later test.
    const own = makeWorkspace();
    const linkDir = join(own.root, 'alias');
    symlinkSync(own.root, linkDir);
    refused(() => verifyLaunch(baseRequest(own, { cwd: linkDir }), TEST_POLICY), 'path-alias');
    const hard = join(own.root, 'second.exe');
    linkSync(own.exe, hard);
    refused(() => verifyLaunch(baseRequest(own, { executable: { path: hard, sha256: own.exeSha } }), TEST_POLICY), 'path-not-single-link-file');
    refused(() => verifyLaunch(baseRequest(own), TEST_POLICY), 'path-not-single-link-file');
  });
  it('refuses cwd outside the workspace, non-.exe targets, bad durations and identities', () => {
    refused(() => verifyLaunch(baseRequest(ws, { cwd: '/' }), TEST_POLICY), 'cwd-outside-workspace');
    refused(() => verifyLaunch(baseRequest(ws, { executable: { path: ws.script, sha256: ws.scriptSha } }), TEST_POLICY), 'executable-not-exe');
    for (const timeoutMs of [0, -1, 600_001, 1.5, Number.NaN]) refused(() => verifyLaunch(baseRequest(ws, { timeoutMs }), TEST_POLICY), 'duration-refused');
    refused(() => verifyLaunch(baseRequest(ws, { identity: { runId: '', taskId: 't', attemptId: 'a' } }), TEST_POLICY), 'identity-incomplete');
    refused(() => verifyLaunch(baseRequest(ws, { identity: { runId: 'r\n', taskId: 't', attemptId: 'a' } }), TEST_POLICY), 'identity-incomplete');
  });
  it('argv is literal data: NUL and line breaks are refused', () => {
    refused(() => verifyLaunch(baseRequest(ws, { argv: ['a\0b'] }), TEST_POLICY), 'argv-refused');
    refused(() => verifyLaunch(baseRequest(ws, { argv: ['a\nb'] }), TEST_POLICY), 'argv-refused');
  });
});

describe('environment block', () => {
  const env = { SystemRoot: 'C:\\Windows', TEMP: ws.temp, TMP: ws.temp };
  it('closed allowlist: injection/egress variables are refused', () => {
    for (const k of ['NODE_OPTIONS', 'PATH', 'HTTPS_PROXY', 'OPENAI_API_KEY', 'ComSpec']) {
      refused(() => buildEnvironmentBlock({ ...env, [k]: 'x' }, ws.root, TEST_POLICY), `environment-not-allowlisted:${k.toUpperCase()}`);
    }
  });
  it('refuses case-insensitive duplicates, missing required names, malformed keys and wrong test mode', () => {
    refused(() => buildEnvironmentBlock({ ...env, temp: ws.temp }, ws.root, TEST_POLICY), 'environment-duplicate');
    refused(() => buildEnvironmentBlock({ TEMP: ws.temp, TMP: ws.temp }, ws.root, TEST_POLICY), 'environment-missing:SYSTEMROOT');
    refused(() => buildEnvironmentBlock({ ...env, '=C:': 'x' }, ws.root, TEST_POLICY), 'environment-malformed');
    refused(() => buildEnvironmentBlock({ ...env, COMPANYOS_TEST_MODE: 'LIVE' }, ws.root, TEST_POLICY), 'environment-test-mode');
  });
  it('profile directories must exist inside the workspace', () => {
    refused(() => buildEnvironmentBlock({ ...env, TEMP: '/' }, ws.root, TEST_POLICY), 'environment-profile-outside-workspace');
    refused(() => buildEnvironmentBlock({ ...env, TEMP: join(ws.root, 'missing') }, ws.root, TEST_POLICY), 'path-missing');
  });
  it('is ordinal case-insensitively sorted, UTF-16LE, double-NUL terminated', () => {
    const appdata = join(ws.root, 'appdata');
    mkdirSync(appdata);
    const { block, names } = buildEnvironmentBlock({ TMP: ws.temp, windir: 'C:\\Windows', COMPANYOS_TEST_MODE: 'OFFLINE', APPDATA: appdata, SystemRoot: 'C:\\Windows', TEMP: ws.temp }, ws.root, TEST_POLICY);
    assert.deepEqual(names, ['APPDATA', 'COMPANYOS_TEST_MODE', 'SystemRoot', 'TEMP', 'TMP', 'windir']);
    const text = Buffer.from(block).toString('utf16le');
    assert.ok(text.endsWith('\0\0'));
    assert.equal(text.split('\0')[0], `APPDATA=${appdata}`);
    assert.ok(compareEnvironmentNames('Z', '_') < 0, "ordinal: '_' (0x5F) sorts after 'Z' (0x5A)");
  });
});

describe('Windows argument quoting round-trips through the CRT parser', () => {
  const cases = ['plain', '', 'two words', 'tab\there', 'quote"inside', 'trailing\\', 'trail space\\', 'C:\\Program Files\\x\\', '\\\\server\\share', 'a\\\\"b', '"', '\\"', '中文 参数', 'ends with quote"'];
  for (const arg of cases) {
    it(JSON.stringify(arg), () => {
      assert.deepEqual(parseWindowsCommandLine(`prog.exe ${quoteWindowsArgument(arg)}`), ['prog.exe', arg]);
    });
  }
  it('whole argv vector', () => {
    const line = ['C:\\a b\\p.exe', ...cases].map(quoteWindowsArgument).join(' ');
    assert.deepEqual(parseWindowsCommandLine(line), ['C:\\a b\\p.exe', ...cases]);
  });
});
