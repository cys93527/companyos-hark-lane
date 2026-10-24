import './offline-test-profile.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,isAbsolute } from 'node:path';
import { runStages,runCommand } from '../check-runner.mjs';
import { checkEnvironment } from '../check.mjs';
const require=createRequire(import.meta.url);
const {ROOT,STAGES,createCheckPlan,parseCheckArgs,verifyBuildScripts}=require('../check-plan.cjs');
const guard=require('../test-offline-guard.cjs').installOfflineGuard();
const cp=require('node:child_process');
const plan=createCheckPlan();
const success={code:0,nativeExitCode:0,kind:'SUCCESS',started:true,closeObserved:true,stdout:'',stderr:''};
const simulate=async(execute,steps=plan)=>{
  const calls=[],logs=[],out=[],err=[],failures=[];
  const result=await runStages(steps,{env:{CI:'1',MARKER:'mock'},execute:async(c,o)=>{calls.push({command:c,options:o});return execute(c,o,calls.length);},log:x=>logs.push(x),stdout:x=>out.push(x),stderr:x=>err.push(x),persist:(...args)=>{failures.push(args);return 'mock-failure.log';}});
  return {...result,calls,logs,out,err,failures};
};
function childFixture() {
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.pid=42;child.exitCode=null;child.signalCode=null;
  return child;
}
function clock() {
  let next=0;const jobs=new Map();
  return {setTimeout(fn,ms){const id=++next;jobs.set(id,{fn,ms});return id;},clearTimeout(id){jobs.delete(id);},fire(ms){for(const [id,job] of [...jobs]) if(job.ms===ms){jobs.delete(id);job.fn();}},jobs};
}
const denied=fn=>assert.throws(fn,/OFFLINE_TEST_EXECUTION_DENIED/);

test('MOCK all six stages and eight commands run in the original fail-fast order',async()=>{
  const result=await simulate(()=>success);
  assert.equal(result.code,0);assert.equal(result.calls.length,8);
  assert.deepEqual(result.results.map(r=>r.step),STAGES.map(([name])=>name));
  assert.match(result.logs.join('\n'),/6× PASS/);assert.equal(result.failures.length,0);
});
test('exact executable argv and cwd match the reviewed six-stage expansion',()=>{
  assert.deepEqual(plan.map(s=>s.cmd),STAGES.map(([,cmd])=>cmd));
  const commands=plan.flatMap(s=>s.commands);
  assert.ok(commands.every(c=>c.executable===process.execPath && isAbsolute(c.argv[0]) && isAbsolute(c.cwd)));
  assert.deepEqual(commands.map(c=>c.argv.slice(1)),[['.'],['-p','tsconfig.json','--noEmit'],[],[],['--exclude','tests/provider/**'],['-b','tsconfig.build.json'],['build'],['-b','tsconfig.json']]);
  assert.deepEqual(commands.map(c=>c.cwd),[ROOT,ROOT,ROOT,ROOT,ROOT,ROOT,join(ROOT,'apps','renderer'),join(ROOT,'apps','desktop')]);
});
test('MOCK every command receives the controlled environment and signal',async()=>{
  const result=await simulate((c,o)=>{assert.deepEqual(o.env,{CI:'1',MARKER:'mock'});assert.equal(o.signal,undefined);return success;});
  assert.equal(result.code,0);
});
for (let failed=0;failed<6;failed++) test(`MOCK nonzero stage ${STAGES[failed][0]} prevents later stages`,async()=>{
  const target=plan[failed].commands[0];
  const result=await simulate(c=>c===target?{...success,code:23,nativeExitCode:23,kind:'NONZERO_EXIT',stderr:'failure original'}:success);
  assert.equal(result.code,1);assert.equal(result.failed,plan[failed].name);
  assert.equal(result.results.length,failed+1);assert.equal(result.results.at(-1).calls.at(-1).nativeExitCode,23);
  assert.match(result.failures[0][4],/failure original/);assert.match(result.err.join('\n'),/Exit Code 1/);
});
test('MOCK build subcommand failure does not run later build commands',async()=>{
  const build=plan.at(-1);const result=await simulate(c=>c===build.commands[1]?{...success,code:7,kind:'NONZERO_EXIT'}:success,[build]);
  assert.equal(result.calls.length,2);assert.equal(result.code,1);
});
test('MOCK command throw is a failed spawn and retains the original error',async()=>{
  const result=await simulate(()=>{throw Object.assign(Error('spawn failed evidence'),{code:'ENOENT'});});
  assert.equal(result.code,1);assert.equal(result.calls.length,1);assert.match(result.failures[0][4],/spawn failed evidence/);
});
test('MOCK empty plan and unexecuted commands cannot produce a false PASS',async()=>{
  const empty=await simulate(()=>success,[]);assert.equal(empty.code,1);assert.doesNotMatch(empty.logs.join('\n'),/check PASSED/);
  const unobserved=await simulate(()=>({...success,started:false}));assert.equal(unobserved.code,1);assert.equal(unobserved.results[0].calls[0].kind,'EXECUTION_NOT_CONFIRMED');
  const absent=await simulate(()=>undefined);assert.equal(absent.code,1);assert.equal(absent.results[0].calls[0].kind,'INVALID_EXECUTION_RESULT');
  const contradictory=await simulate(()=>({...success,nativeExitCode:23}));assert.equal(contradictory.code,1);
});
test('MOCK stdout stderr and failure diagnostics retain full text including Unicode',async()=>{
  const result=await simulate(()=>({...success,code:2,kind:'NONZERO_EXIT',stdout:'全文\nline\n',stderr:'original stderr\n'}));
  assert.deepEqual(result.out,['全文\nline\n']);assert.equal(result.err[0],'original stderr\n');
  assert.match(result.failures[0][4],/全文\nline\n/);assert.match(result.failures[0][4],/original stderr/);
});
test('MOCK async launch has shell false fixed argv cwd env and separate pipes',async()=>{
  const child=childFixture(),env={CI:'1'};let observed;
  const pending=runCommand(plan[0].commands[0],{env,launch:(...args)=>{observed=args;return child;}});
  child.stdout.emit('data',Buffer.from('real bytes'));child.stderr.emit('data',Buffer.from('error bytes'));child.emit('close',0,null);
  const result=await pending;
  assert.equal(observed[2].shell,false);assert.deepEqual(observed.slice(0,2),[process.execPath,plan[0].commands[0].argv]);
  assert.equal(observed[2].cwd,ROOT);assert.equal(observed[2].env,env);assert.deepEqual(observed[2].stdio,['ignore','pipe','pipe']);
  assert.equal(result.code,0);assert.equal(result.stdout,'real bytes');assert.equal(result.stderr,'error bytes');
});
test('MOCK wall-clock timeout stops only its child and requires close evidence',async()=>{
  const child=childFixture(),timers=clock();let stopped;
  const pending=runCommand(plan[0].commands[0],{timers,timeoutMs:10,graceMs:5,launch:()=>child,stop:c=>{stopped=c;}});
  timers.fire(10);assert.equal(stopped,child);child.emit('close',null,'SIGTERM');
  const result=await pending;assert.equal(result.kind,'TIMEOUT');assert.equal(result.code,1);assert.equal(result.closeObserved,true);assert.equal(timers.jobs.size,0);
});
test('MOCK failed cleanup remains unconfirmed instead of claiming process exit',async()=>{
  const child=childFixture(),timers=clock();
  const pending=runCommand(plan[0].commands[0],{timers,timeoutMs:10,graceMs:5,launch:()=>child,stop:()=>{throw Error('stop denied');}});
  timers.fire(10);timers.fire(5);
  const result=await pending;assert.equal(result.code,1);assert.equal(result.closeObserved,false);assert.equal(result.stopError,'stop denied');
});
test('MOCK pre-launch interruption creates no child and no PASS',async()=>{
  const controller=new globalThis.AbortController();controller.abort();let launches=0;
  const result=await runCommand(plan[0].commands[0],{signal:controller.signal,launch:()=>{launches++;return childFixture();}});
  assert.equal(launches,0);assert.equal(result.kind,'INTERRUPTED');assert.equal(result.started,false);
});
test('MOCK active interruption stops the owned child and clears timers',async()=>{
  const controller=new globalThis.AbortController(),child=childFixture(),timers=clock();let count=0;
  const pending=runCommand(plan[0].commands[0],{signal:controller.signal,timers,launch:()=>child,stop:()=>{count++;}});
  controller.abort();child.emit('close',null,'SIGTERM');
  const result=await pending;assert.equal(result.code,1);assert.equal(result.kind,'INTERRUPTED');assert.equal(count,1);assert.equal(timers.jobs.size,0);
});
test('MOCK native spawn error never becomes success',async()=>{
  const child=childFixture(),timers=clock();
  const pending=runCommand(plan[0].commands[0],{timers,launch:()=>child});
  child.emit('error',Object.assign(Error('missing'),{code:'ENOENT'}));child.emit('close',null,null);
  const result=await pending;assert.equal(result.code,1);assert.equal(result.kind,'SPAWN_ERROR');assert.equal(result.spawnError,'ENOENT');
});
test('unknown check flags npm scripts and shell metacharacters are rejected',()=>{
  for(const args of [['--only','npm'],['--only'],['--only','build','--root','/foreign'],['--only','lint','; powershell'],['--eval','foreign'],['--only','test','--config','vitest.kernel.config.ts']]) assert.throws(()=>parseCheckArgs(args));
});
test('changed npm build expansion or added lifecycle hooks fail closed',()=>{
  const read=file=>JSON.parse(readFileSync(file,'utf8'));
  for(const change of [s=>{s.build+=' && foreign';},s=>{s.prebuild='powershell';},s=>{s['postbuild:libs']='foreign';}]) {
    assert.throws(()=>verifyBuildScripts(file=>{const data=read(file);if(file===join(ROOT,'package.json')) change(data.scripts);return data;}),/unreviewed build script/);
  }
});
test('guard admits exactly the finite gate argv cwd and pinned Node host',()=>{
  const registered=guard.registerCheckCommands();
  for(const c of registered.flatMap(s=>s.commands)) assert.doesNotThrow(()=>guard.check(c.executable,c.argv,{cwd:c.cwd,shell:false}));
  const c=registered[0].commands[0];
  const entry=join(ROOT,'scripts','check.mjs');
  assert.doesNotThrow(()=>guard.check(process.execPath,[entry],{cwd:ROOT}));
  denied(()=>guard.check(process.execPath,[entry,'--only','foreign'],{cwd:ROOT}));
  denied(()=>guard.check(c.executable,[...c.argv,'--config','foreign'],{cwd:c.cwd}));
  denied(()=>guard.check(c.executable,c.argv,{cwd:tmpdir()}));
  denied(()=>guard.check('cmd.exe',['/c','npm test'],{cwd:ROOT}));
  denied(()=>guard.check('pnpm',['exec','eslint','.'],{cwd:ROOT}));
  denied(()=>guard.check('powershell.exe',['icacls'],{cwd:ROOT}));
  denied(()=>guard.check(c.executable,c.argv,{cwd:c.cwd,shell:true}));
  denied(()=>guard.check(process.execPath,[join(ROOT,'.companyos-embedded','dsh-runtime','runtime','apps','cli','lib','bin.js')],{cwd:ROOT}));
});
test('controlled gate environment excludes model credentials and old profile state',()=>{
  const env=checkEnvironment({SYSTEMROOT:'C:\\Windows',PATH:'reviewed PATH',COS_MODEL_API_KEY:'synthetic',NODE_OPTIONS:'--eval attack',ELECTRON_DISABLE_SANDBOX:'1',npm_lifecycle_script:'foreign',HOME:'old profile'});
  assert.equal(env.COS_MODEL_API_KEY,undefined);assert.equal(env.ELECTRON_DISABLE_SANDBOX,undefined);assert.equal(env.npm_lifecycle_script,undefined);
  assert.match(env.NODE_OPTIONS,/test-offline-guard/);assert.equal(env.COMPANYOS_TEST_MODE,'OFFLINE');assert.notEqual(env.HOME,'old profile');assert.ok(env.HOME.startsWith(ROOT));
});
test('actual child guard ledger is inherited before user code; nonzero remains nonzero',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gate-child-'));
  try {
    const entry=join(dir,'fixture.cjs');
    writeFileSync(entry,"const state=globalThis[Symbol.for('companyos.offline-test-guard')]; if(!state || !state.gateCommands.length) process.exit(99); try { require('node:child_process').spawn('cmd.exe',['/c','npm test']); process.exit(98); } catch(e) { if(e.code!=='OFFLINE_TEST_EXECUTION_DENIED') process.exit(97); } console.log('guard loaded'); console.error('original stderr'); process.exit(23);",'utf8');
    guard.registerFixture(entry);
    const result=await runCommand({executable:process.execPath,argv:[entry],cwd:dir},{env:process.env,timeoutMs:5000});
    assert.equal(result.code,23);assert.equal(result.nativeExitCode,23);assert.equal(result.closeObserved,true);assert.match(result.stdout,/guard loaded/);assert.match(result.stderr,/original stderr/);
    assert.equal(guard.children.has(result.pid),false);
    console.log(JSON.stringify({evidence:'actual-offline-node-nonzero',PID:result.pid,exitCode:result.nativeExitCode,closeObserved:result.closeObserved}));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('actual boundary self-check from another cwd uses explicit F root and handles spaces/Unicode',()=>{
  const dir=mkdtempSync(join(tmpdir(),'gate 任意 cwd-'));
  try {
    const core=join(dir,'packages','core');require('node:fs').mkdirSync(join(core,'src'),{recursive:true});
    writeFileSync(join(core,'package.json'),JSON.stringify({name:'@companyos/core',version:'0.0.0'}));
    writeFileSync(join(core,'src','index.ts'),'export const fine = true;\n');
    const entry=join(ROOT,'scripts','check.mjs');guard.registerCheckCommands(['--only','boundaries','--root',dir],dir);
    const result=cp.spawnSync(process.execPath,[entry,'--only','boundaries','--root',dir],{cwd:dir,env:process.env,encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/1× PASS/);
    console.log(JSON.stringify({evidence:'actual-boundaries-only',PID:result.pid,exitCode:result.status,fullGate:false}));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('gate fixture cannot substitute a different cwd or protected resource root',()=>{
  const dir=mkdtempSync(join(tmpdir(),'gate-cwd-'));
  try {
    // A temporary checker fixture root is pinned by the boundary argument; the
    // real gate cwd itself remains ROOT and may not be replaced by an alias.
    guard.registerCheckCommands(['--only','boundaries','--root',dir]);
    const c=createCheckPlan(['--only','boundaries','--root',dir])[0].commands[0];
    const alias=join(dir,'other');require('node:fs').mkdirSync(alias);
    denied(()=>guard.check(c.executable,c.argv,{cwd:alias}));
    denied(()=>guard.check(c.executable,[c.argv[0],'--root',join(ROOT,'.companyos-embedded')],{cwd:ROOT}));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('actual bounded Node timeout observes process closure without killing unrelated PID',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gate-timeout-'));
  try {
    const entry=join(dir,'fixture.cjs');writeFileSync(entry,'setInterval(()=>{},1000);','utf8');guard.registerFixture(entry);
    const result=await runCommand({executable:process.execPath,argv:[entry],cwd:dir},{env:process.env,timeoutMs:200});
    assert.equal(result.kind,'TIMEOUT');assert.equal(result.code,1);assert.equal(result.closeObserved,true);assert.equal(result.stopError,undefined);assert.ok(result.pid>0);assert.equal(guard.children.has(result.pid),false);
    console.log(JSON.stringify({evidence:'actual-offline-node-timeout',PID:result.pid,kind:result.kind,nativeExitCode:result.nativeExitCode,closeObserved:result.closeObserved}));
    denied(()=>cp.spawn('taskkill',['/PID',String(process.pid),'/T','/F']));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
