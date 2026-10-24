import './offline-test-profile.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),cp=require('node:child_process');
const guard=require('../test-offline-guard.cjs').installOfflineGuard();
const {MATH_TEST,ENV_PROBE}=require('../test-offline-package.cjs');
const argv=process.platform==='win32'?['/d','/s','/c','npm test']:['-c','npm test'];
const shell=process.platform==='win32'?'cmd.exe':'/bin/sh';
const manifest=(dir,script)=>writeFileSync(join(dir,'package.json'),JSON.stringify({scripts:{test:script}}));
const fixture=(body)=>{const dir=mkdtempSync(join(tmpdir(),'companyos-testcheck-'));try{return body(dir);}finally{rmSync(dir,{recursive:true,force:true});}};
const denied=fn=>assert.throws(fn,/OFFLINE_TEST_EXECUTION_DENIED/);
const run=dir=>cp.spawnSync(shell,argv,{cwd:dir,encoding:'utf8'});

test('fixed npm test fixture is expanded to a real pinned Node process without shell execution',()=>fixture(dir=>{
 manifest(dir,`node -e "console.log('two-chain-marker')"`);guard.registerPackageSnapshot(dir);
 const result=run(dir);assert.equal(result.status,0);assert.equal(result.stdout.trim(),'two-chain-marker');
 const trace=guard.packageTraces.at(-1);assert.equal(trace.node,process.execPath);assert.equal(trace.exitObserved,true);assert.equal(trace.exitCode,0);assert.ok(trace.PID>0);
 assert.deepEqual(trace.requestedArgv,argv);assert.deepEqual(trace.expandedArgv,['-e',"console.log('two-chain-marker')"]);
}));
test('real nonzero process exit is preserved instead of successful shell-wrapper status',()=>fixture(dir=>{
 manifest(dir,'node -e "process.exit(23)"');guard.registerPackageSnapshot(dir);
 assert.equal(run(dir).status,23);assert.equal(guard.packageTraces.at(-1).exitCode,23);
}));
test('fixed node test contract preserves actual pass and fail assertions and stdout',()=>fixture(dir=>{
 manifest(dir,'node --test tests/math.test.ts');mkdirSync(join(dir,'src'));mkdirSync(join(dir,'tests'));
 writeFileSync(join(dir,'tests/math.test.ts'),MATH_TEST);
 for(const operator of ['*','-']){
  writeFileSync(join(dir,'src/math.ts'),`export const multiply = (a: number, b: number): number => a ${operator} b;\n`);
  guard.registerPackageSnapshot(dir);const result=run(dir);
  assert.equal(result.status,operator==='*'?0:1);assert.match(result.stdout,operator==='*'?/pass 1/:/fail 1/);
 }
}));
test('unknown npm scripts, Shell chaining and npm lifecycle hooks are denied before any child',()=>fixture(dir=>{
 for(const script of ['powershell -Command anything','node --test tests/unknown.ts','node -e "process.exit(0)" && powershell','npm run nested']) {
  manifest(dir,script);denied(()=>guard.registerPackageSnapshot(dir));
 }
 for(const lifecycle of ['pretest','posttest']){
  writeFileSync(join(dir,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"',[lifecycle]:'powershell'}}));
  denied(()=>guard.registerPackageSnapshot(dir));
 }
 assert.equal(guard.packageTraces.some(row=>row.cwd===dir),false);
}));
test('unregistered snapshot, extra shell arguments, fake cmd identity and shell:true cannot bypass admission',()=>fixture(dir=>{
 manifest(dir,'node -e "process.exit(0)"');denied(()=>run(dir));guard.registerPackageSnapshot(dir);
 denied(()=>cp.spawn(shell,[...argv,'&& powershell'],{cwd:dir}));
 denied(()=>cp.spawn(shell,argv,{cwd:dir,shell:true}));
 denied(()=>cp.spawn(join(dir,'cmd.exe'),argv,{cwd:dir}));
 denied(()=>cp.spawn('powershell.exe',['-Command','npm test'],{cwd:dir}));
}));
test('package and dependency identity drift are rejected after snapshot admission',()=>fixture(dir=>{
 manifest(dir,'node -e "process.exit(0)"');guard.registerPackageSnapshot(dir);
 manifest(dir,'node -e "process.exit(23)"');denied(()=>run(dir));
 manifest(dir,'node -e "process.exit(0)"');guard.registerPackageSnapshot(dir);
 mkdirSync(join(dir,'node_modules','local-dep'),{recursive:true});
 writeFileSync(join(dir,'node_modules','local-dep','index.js'),"require('child_process').spawn('powershell.exe',[])");
 denied(()=>run(dir));denied(()=>guard.registerPackageSnapshot(dir));
}));
test('external directory aliases and unreviewed native modules are rejected before execution',()=>fixture(dir=>{
 manifest(dir,'node -e "process.exit(0)"');writeFileSync(join(dir,'unknown.node'),'not native code');denied(()=>guard.registerPackageSnapshot(dir));
 rmSync(join(dir,'unknown.node'));const victim=mkdtempSync(join(tmpdir(),'two-chain-victim-'));
 try{writeFileSync(join(victim,'keep.txt'),'unchanged');symlinkSync(victim,join(dir,'alias'),'junction');denied(()=>guard.registerPackageSnapshot(dir));assert.equal(readFileSync(join(victim,'keep.txt'),'utf8'),'unchanged');}
 finally{rmSync(join(dir,'alias'));rmSync(victim,{recursive:true,force:true});}
}));
test('expanded Node child cannot inherit synthetic model keys, tokens or deployment proxy',()=>fixture(dir=>{
 manifest(dir,`node -e ${JSON.stringify(ENV_PROBE)}`);guard.registerPackageSnapshot(dir);
 const result=cp.spawnSync(shell,argv,{cwd:dir,encoding:'utf8',env:{...process.env,COS_MODEL_API_KEY:'SYNTHETIC',ACCESS_TOKEN:'SYNTHETIC',HTTPS_PROXY:'https://external.invalid'}});
 assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),{key:null,token:null,proxy:null});assert.doesNotMatch(result.stdout,/SYNTHETIC/);
}));
test('timeout fixture remains running until explicitly killed and close/exit is actually observed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'companyos-testcheck-'));
 try{
  manifest(dir,'node -e "setInterval(() => {}, 1000)"');guard.registerPackageSnapshot(dir);
  const child=cp.spawn(shell,argv,{cwd:dir});assert.ok(child.pid>0);assert.equal(child.exitCode,null);
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  child.kill();const result=await closed;assert.equal(guard.packageTraces.at(-1).exitObserved,true);assert.ok(result.signal||result.code!==0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('actual Kernel copies and ACL/provider/tool commands are not admitted as npm scripts',()=>fixture(dir=>{
 for(const script of ['node .companyos-embedded/dsh-runtime/runtime/apps/cli/lib/bin.js','icacls . /setintegritylevel L','node -e "fetch(\'https://external.invalid\')"','node -e "require(\'child_process\').spawn(\'powershell.exe\',[])"']){
  manifest(dir,script);denied(()=>guard.registerPackageSnapshot(dir));
 }
 assert.equal(guard.packageTraces.some(row=>row.cwd===dir),false);
}));
