import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {afterEach,describe,expect,it} from 'vitest';
import {runRepoTestContract} from '../apps/desktop/src/repo-test-process.js';
import {registerOfflinePackageSnapshot,saveOfflinePackageTraces} from './support/offline-fixtures.js';
const require=createRequire(import.meta.url);
const api=require('../scripts/test-offline-guard.cjs') as {installOfflineGuard():{packageTraces:{PID:number|null;exitObserved:boolean;exitCode:number|null;signal:string|null}[]}};
const dirs:string[]=[];
afterEach(()=>{saveOfflinePackageTraces();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const snapshot=(code:string)=>{
 const dir=mkdtempSync(join(tmpdir(),'companyos-testcheck-'));dirs.push(dir);
 writeFileSync(join(dir,'package.json'),JSON.stringify({scripts:{test:`node -e ${JSON.stringify(code)}`}}),'utf8');
 registerOfflinePackageSnapshot(dir);return dir;
};
describe('TWO-CHAIN: unchanged production capture/deadline port over reviewed offline Node expansion',()=>{
 it('reports an actual nonzero Node exit rather than manufacturing success',async()=>{
  const result=await runRepoTestContract({cwd:snapshot('process.exit(23)'),timeoutMs:5000});
  expect(result.exitCode).toBe(23);expect(result.timedOut).toBe(false);
  expect(api.installOfflineGuard().packageTraces.at(-1)).toMatchObject({exitObserved:true,exitCode:23});
 });
 it('captures actual stdout from a successfully executed script',async()=>{
  const result=await runRepoTestContract({cwd:snapshot("console.log('two-chain-marker')"),timeoutMs:5000});
  expect(result).toEqual({exitCode:0,timedOut:false,outputTail:'two-chain-marker'});
 });
 it('deadline terminates its real Node root and records close before fixture cleanup',async()=>{
  const result=await runRepoTestContract({cwd:snapshot('setInterval(() => {}, 1000)'),timeoutMs:100});
  expect(result.timedOut).toBe(true);expect(result.exitCode).not.toBe(0);
  const trace=api.installOfflineGuard().packageTraces.at(-1)!;
  expect(trace.PID).toBeGreaterThan(0);expect(trace.exitObserved).toBe(true);
  // Signal 0 is a read-only liveness query; never terminate a PID by guess.
  expect(()=>process.kill(trace.PID!,0)).toThrow();
 });
 it('production env allowlist and guard drop synthetic credentials without recording their values',async()=>{
  const code="console.log(JSON.stringify({key:process.env.COS_MODEL_API_KEY??null,token:process.env.ACCESS_TOKEN??null,proxy:process.env.HTTPS_PROXY??null}))";
  const keys=['COS_MODEL_API_KEY','ACCESS_TOKEN','HTTPS_PROXY'];const previous=keys.map(key=>process.env[key]);
  try{
   for(const key of keys)process.env[key]='SYNTHETIC_TWO_CHAIN';
   const result=await runRepoTestContract({cwd:snapshot(code),timeoutMs:5000});
   expect(result.exitCode).toBe(0);expect(JSON.parse(result.outputTail)).toEqual({key:null,token:null,proxy:null});expect(result.outputTail).not.toContain('SYNTHETIC_TWO_CHAIN');
  }finally{keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});}
 });
});
