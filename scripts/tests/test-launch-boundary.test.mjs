import './offline-test-profile.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const guard = require('../test-offline-guard.cjs').installOfflineGuard();
const denied = fn => assert.throws(fn, /OFFLINE_TEST_EXECUTION_DENIED/);
const disposable = body => { const dir=mkdtempSync(join(tmpdir(),'launch-boundary-')); try { body(dir); } finally { rmSync(dir,{recursive:true,force:true}); } };
const git = (cwd,...argv) => cp.execFileSync('git',argv,{cwd,encoding:'utf8'});

test('registered Git fixture permits local init/add/commit/read without a shell',()=>disposable(dir=>{
  guard.registerGitWorkspace(dir);
  git(dir,'init','-q'); git(dir,'config','user.name','offline'); git(dir,'config','user.email','offline@example.invalid');
  writeFileSync(join(dir,'data.txt'),'deterministic'); git(dir,'add','data.txt'); git(dir,'commit','-m','fixture','--no-gpg-sign');
  assert.match(git(dir,'rev-parse','HEAD').trim(),/^[0-9a-f]{40}$/); assert.equal(git(dir,'status','--porcelain').trim(),'');
}));
test('Git requires registered temporary workspace and denies transport/aliases/config injection',()=>disposable(dir=>{
  denied(()=>git(dir,'init'));
  guard.registerGitWorkspace(dir); git(dir,'init','-q');
  for (const args of [['clone','https://external.invalid/repo'],['fetch'],['push'],['submodule','update'],['-c','alias.attack=!powershell','attack'],['config','filter.attack.clean','powershell'],['config','include.path','foreign']]) denied(()=>git(dir,...args));
  denied(()=>git(dir,'add','../outside')); denied(()=>git(dir,'status','--output=outside'));
}));
test('native Git hook cannot wrap a DSH, shell or model request',()=>disposable(dir=>{
  const row=guard.registerGitWorkspace(dir); git(dir,'init','-q');
  git(dir,'config','user.name','offline'); git(dir,'config','user.email','offline@example.invalid');
  const marker=join(dir,'hook-ran');
  mkdirSync(join(dir,'.git','hooks'),{recursive:true});
  writeFileSync(join(dir,'.git','hooks','pre-commit'),`#!/bin/sh\necho forbidden > '${marker.replaceAll('\\','/')}'\n`);
  writeFileSync(join(dir,'data'),'offline'); git(dir,'add','data'); git(dir,'commit','-m','hook suppression','--no-gpg-sign');
  assert.equal(existsSync(marker),false);
  writeFileSync(join(row.hooks.path,'foreign'),'blocked'); denied(()=>git(dir,'status'));
}));
test('Git executable impostor and local executable filters fail closed',()=>disposable(dir=>{
  guard.registerGitWorkspace(dir); git(dir,'init','-q');
  const fake=join(dir,'git.exe'); writeFileSync(fake,'not a binary'); denied(()=>cp.spawn(fake,['status'],{cwd:dir}));
  const config=join(dir,'.git','config'); writeFileSync(config,readFileSync(config,'utf8')+'\n[filter "attack"]\n clean = powershell\n');
  denied(()=>git(dir,'add','.'));
}));
test('registered Node entry cannot be replaced by a shell wrapper or earlier loader',()=>disposable(dir=>{
  const file=join(dir,'safe.cjs'); writeFileSync(file,"console.log('offline')"); guard.registerFixture(file);
  assert.equal(cp.execFileSync(process.execPath,[file],{encoding:'utf8'}).trim(),'offline');
  for (const shell of ['cmd.exe','powershell.exe','pwsh.exe','wscript.exe']) denied(()=>cp.spawn(shell,['/c',process.execPath,file],{cwd:dir}));
  denied(()=>cp.spawn(process.execPath,['--import',file,file])); denied(()=>cp.spawn(process.execPath,[file],{shell:true}));
}));
test('registered nonzero Node result stays an actual failed process, not a fake PASS',()=>{
  const code='process.exit(23)'; guard.registerInline(code);
  const result=cp.spawnSync(process.execPath,['-e',code]); assert.equal(result.status,23);
  assert.throws(()=>cp.execFileSync(process.execPath,['-e',code]),error=>error.status===23);
});
test('Git removes inherited external helpers, credentials and deployment environment',()=>disposable(dir=>{
  guard.registerGitWorkspace(dir); git(dir,'init','-q');
  // Policy-only inspection; these synthetic values are never real credentials.
  const {createGitPolicy}=require('../test-offline-git.cjs');
  const policy=createGitPolicy(reason=>{throw Error(reason);},()=>false); policy.register(dir);
  const request=policy.request('git',['status'],{cwd:dir,env:{GIT_SSH_COMMAND:'powershell',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'alias.attack',GIT_CONFIG_VALUE_0:'!powershell'}});
  assert.equal(request.options.env.GIT_SSH_COMMAND,undefined); assert.equal(request.options.env.GIT_CONFIG_COUNT,undefined);
  assert.equal(request.options.env.GIT_TERMINAL_PROMPT,'0'); assert.ok(request.argv.includes('protocol.allow=never'));
}));
test('unowned tree termination and a same-name taskkill binary are denied',()=>disposable(dir=>{
  const fake=join(dir,'taskkill.exe'); writeFileSync(fake,'not a binary');
  denied(()=>cp.spawn(fake,['/PID',String(process.pid),'/T','/F']));
  denied(()=>cp.spawn('taskkill',['/PID',String(process.pid),'/T','/F']));
  mkdirSync(join(dir,'unused'));
}));
test('modeled missing executable is an explicit spawn error, never OS execution or success',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'missing-fixture-'));
  try {
    const file=join(dir,'absent.exe'); guard.registerSpawnFailure(file);
    const child=cp.spawn(file,[]); assert.equal(child.pid,undefined);
    await new Promise(resolve=>child.once('error',error=>{assert.equal(error.code,'ENOENT');resolve();}));
    writeFileSync(file,'now exists'); denied(()=>cp.spawn(file,[]));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('Git discovery cannot escape a registered empty fixture into its parent repository',()=>disposable(dir=>{
  guard.registerGitWorkspace(dir); git(dir,'init','-q');
  const empty=join(dir,'not-a-repository'); mkdirSync(empty);guard.registerGitWorkspace(empty);
  const result=cp.spawnSync('git',['rev-parse','--show-toplevel'],{cwd:empty,encoding:'utf8'});
  assert.equal(result.status,128); assert.match(result.stderr,/not a git repository/i);
}));
test('framework entry cannot select live config, external reporter or a custom setup',()=>{
  const entry=require.resolve('vitest/vitest.mjs');
  for (const args of [['--config','vitest.kernel.config.ts'],['--reporter=foreign.mjs'],['--setupFiles','foreign.ts'],['--config']]) {
    denied(()=>guard.check(process.execPath,[entry,'run',...args]));
  }
});
