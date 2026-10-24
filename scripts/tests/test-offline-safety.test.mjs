import './offline-test-profile.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const { installOfflineGuard, safeEnvironment } = require('../test-offline-guard.cjs');
const { requireRealDshApproval } = require('../real-dsh-approval.cjs');
const guard = installOfflineGuard();
const denied = fn => assert.throws(fn, /OFFLINE_TEST_EXECUTION_DENIED/);
const root = fileURLToPath(new URL('../../', import.meta.url));

test('default startup denies actual embedded Kernel and a staged alias before spawn', () => {
  for (const script of [join(root, '.companyos-embedded/dsh-runtime/runtime/apps/cli/lib/bin.js'), join(root, '.dsh-stages/attempt/bin.js')]) {
    denied(() => cp.spawn(process.execPath, [script]));
    denied(() => guard.registerFixture(script));
  }
});
test('unknown executable, business PowerShell, shell and unreviewed inline requests are denied', () => {
  for (const exe of ['pwsh.exe', 'powershell.exe', 'cmd.exe']) denied(() => cp.spawn(exe, []));
  denied(() => cp.exec('echo forbidden')); denied(() => cp.execSync('echo forbidden'));
  denied(() => cp.spawn(process.execPath, ['-e', 'process.exit(0)'], {shell: true}));
  denied(() => cp.spawn(process.execPath, ['-e', 'process.exit(0)']));
});
test('live opt-in cannot turn the default setup live', () => {
  process.env.COMPANYOS_REAL_DSH_APPROVAL = 'MOCK_NOT_A_REAL_APPROVAL';
  assert.equal(process.env.COMPANYOS_TEST_MODE, 'OFFLINE');
  assert.throws(() => requireRealDshApproval(), /offline-mode-cannot-opt-in/);
  delete process.env.COMPANYOS_REAL_DSH_APPROVAL;
});
test('missing approval, unbounded and forged opt-in fail closed without a child', () => {
  assert.throws(() => requireRealDshApproval({}), /explicit-approval-and-hash-required/);
  const dir = mkdtempSync(join(tmpdir(), 'offline-policy-'));
  try {
    const file = join(dir, 'mock.json'); writeFileSync(file, '{}');
    assert.throws(() => requireRealDshApproval({COMPANYOS_REAL_DSH_APPROVAL: file, COMPANYOS_REAL_DSH_APPROVAL_SHA256: '0'.repeat(64)}), /approval-hash-mismatch/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
const withMockApproval = (body) => {
  const dir=mkdtempSync(join(tmpdir(),'MOCK_DSH_12345-'));
  try {
    const roots={};
    for(const key of ['workspaceRoot','tempRoot','evidenceRoot','managedRoot']) {roots[key]=join(dir,key);mkdirSync(roots[key]);}
    const evidence=join(dir,'mock-evidence.json');writeFileSync(evidence,'{"MOCK":true,"NOT_AN_ACL_AUTHORIZATION":true}');
    const proof={path:evidence,sha256:createHash('sha256').update(readFileSync(evidence)).digest('hex')};
    const approval={...roots,authority:'ChatGPT Boss',mode:'REAL_DSH_INTEGRATION',windowsAclApproved:true,providerPolicy:'LOOPBACK_SYNTHETIC_ONLY',runId:'MOCK_DSH_12345',expiresAt:new Date(Date.now()+60000).toISOString(),maxKernelStarts:1,maxDurationMs:1000,windowsPreflight:proof,aclRollbackPlan:proof};
    const file=join(dir,'mock-approval.json');
    const input=()=>{writeFileSync(file,JSON.stringify(approval));return {COMPANYOS_REAL_DSH_APPROVAL:file,COMPANYOS_REAL_DSH_APPROVAL_SHA256:createHash('sha256').update(readFileSync(file)).digest('hex')};};
    body(approval,input);
  } finally {rmSync(dir,{recursive:true,force:true});}
};
test('MOCK complete manifest is static-only; even it cannot enable unsupervised real integration', (t) => {
  withMockApproval((approval,input)=>{
    if(process.platform==='win32') {
      assert.equal(requireRealDshApproval(input(),Date.now(),{preflightOnly:true}).runId,approval.runId);
      assert.throws(()=>requireRealDshApproval(input()),/bounded-live-supervisor-not-implemented/);
    } else {
      assert.doesNotMatch(approval.workspaceRoot,/^F:[\\/]/i);
      assert.throws(()=>requireRealDshApproval(input(),Date.now(),{preflightOnly:true}),/non-disposable-root/);
      assert.throws(()=>requireRealDshApproval(input()),/non-disposable-root/);
      t.diagnostic(`${process.platform}: PLATFORM_FAIL_CLOSED_BEFORE_DOWNSTREAM_CHECKS; static acceptance and supervisor check NOT RUN`);
    }
  });
});

test('MOCK expiry, zero limits and overlapping managed roots remain fail-closed', (t) => {
  withMockApproval((approval,input)=>{
    const expiry=approval.expiresAt;approval.expiresAt='2000-01-01T00:00:00Z';
    assert.throws(()=>requireRealDshApproval(input(),Date.now(),{preflightOnly:true}),/expired-or-unbounded-approval/);
    approval.expiresAt=expiry;approval.maxKernelStarts=0;
    if(process.platform==='win32') {
      assert.throws(()=>requireRealDshApproval(input(),Date.now(),{preflightOnly:true}),/bounded-run-required/);
      approval.maxKernelStarts=1;approval.managedRoot=approval.workspaceRoot;
      assert.throws(()=>requireRealDshApproval(input(),Date.now(),{preflightOnly:true}),/overlapping-roots/);
    } else {
      assert.doesNotMatch(approval.workspaceRoot,/^F:[\\/]/i);
      assert.throws(()=>requireRealDshApproval(input(),Date.now(),{preflightOnly:true}),/non-disposable-root/);
      approval.maxKernelStarts=1;approval.managedRoot=approval.workspaceRoot;
      assert.throws(()=>requireRealDshApproval(input(),Date.now(),{preflightOnly:true}),/non-disposable-root/);
      t.diagnostic(`${process.platform}: PLATFORM_FAIL_CLOSED_BEFORE_DOWNSTREAM_CHECKS; bounded-run-required and overlapping-roots checks NOT RUN`);
    }
  });
});

test('content-identical Kernel copy cannot be registered as an offline fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-alias-'));
  try {
    const copy = join(dir, 'innocent.js');
    writeFileSync(copy, readFileSync(join(root, '.companyos-embedded/dsh-runtime/runtime/apps/cli/lib/bin.js')));
    denied(() => guard.registerFixture(copy));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
test('only registered deterministic Node fixture runs; identity drift is denied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-fixture-'));
  try {
    const file = join(dir, 'protocol.cjs');
    writeFileSync(file, "console.log(JSON.stringify({kind:'succeeded',value:17,credential:process.env.API_KEY??null,mode:globalThis[Symbol.for('companyos.offline-test-guard')].mode}));");
    guard.registerFixture(file);
    const row = JSON.parse(cp.execFileSync(process.execPath, [file], {encoding: 'utf8', env: {...process.env, API_KEY: 'SYNTHETIC_TEST_CANARY'}}));
    assert.deepEqual(row, {kind:'succeeded', value:17, credential:null, mode:'OFFLINE'});
    writeFileSync(file, 'console.log(99)'); denied(() => cp.spawn(process.execPath, [file]));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
test('reviewed child inherits spawn guard and cannot start PowerShell or unregistered Node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-inherited-'));
  try {
    const file = join(dir, 'nested.cjs');
    writeFileSync(file, "const cp=require('node:child_process');let n=0;for(const [f,a] of [['pwsh.exe',[]],[process.execPath,['-e','process.exit(0)']]]){try{cp.spawn(f,a)}catch(e){if(e.code==='OFFLINE_TEST_EXECUTION_DENIED')n++}}console.log(n)");
    guard.registerFixture(file);
    assert.equal(cp.execFileSync(process.execPath, [file], {encoding:'utf8'}).trim(), '2');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
test('no early Node loader can precede the registered inline code', () => {
  const code = 'console.log(17)'; guard.registerInline(code);
  denied(() => cp.spawn(process.execPath, ['--require', 'unknown.cjs', '-e', code]));
  denied(() => cp.spawn(process.execPath, ['-e', code, '--require', 'unknown.cjs']));
  denied(() => cp.spawn(process.execPath, ['-e', code], {cwd:'E:\\DeepSeek.gzq\\companyos'}));
});
test('cleanup refuses unrelated PID and network refuses external address before connect', () => {
  denied(() => cp.spawn('taskkill.exe', ['/PID', String(process.pid), '/T', '/F']));
  const socket = new (require('node:net').Socket)();
  denied(() => socket.connect({host:'external.invalid', port:443})); socket.destroy();
});
test('synthetic credentials and security-changing env options are not inherited', () => {
  const env = safeEnvironment({API_KEY:'synthetic', DSH_ANY:'synthetic', COS_MODEL_KEY:'synthetic', ELECTRON_DISABLE_SANDBOX:'1', NODE_OPTIONS:'--import unknown', SYSTEMROOT:'C:\\Windows'});
  assert.equal(env.API_KEY, undefined); assert.equal(env.DSH_ANY, undefined); assert.equal(env.COS_MODEL_KEY, undefined);
  assert.equal(env.ELECTRON_DISABLE_SANDBOX, undefined); assert.equal(env.SYSTEMROOT, 'C:\\Windows');
  assert.match(env.NODE_OPTIONS, /test-offline-guard\.cjs/);
});
test('Vite optional mapped-drive probe receives denial, never a fake successful network map', async () => {
  await new Promise(resolve => {
    const child=cp.exec('net use',(error,stdout) => {assert.equal(error.code,'OFFLINE_TEST_EXECUTION_DENIED'); assert.equal(stdout,''); assert.equal(child.pid,undefined); resolve();});
  });
});
