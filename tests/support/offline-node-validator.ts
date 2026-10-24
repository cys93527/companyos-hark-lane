import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {registerOfflineFixture} from './offline-fixtures.js';

/** A real bounded Node assertion; no test discovery, loaders or external imports. */
export const createOfflineNodeValidator= (root:string, fail=false) => {
  const file=join(root,'offline-validation.cjs');
  writeFileSync(file,`const {test}=require('node:test'); const assert=require('node:assert/strict'); test('isolated validator assertion',()=>assert.equal(2+2,${fail?'5':'4'}));\n`,'utf8');
  registerOfflineFixture(file,{argv:[],cwd:root});
  return async()=> {
    try {
      const result=await new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{
        execFile(process.execPath,[file],{cwd:root,timeout:5000,maxBuffer:32768,shell:false,encoding:'utf8'},(error,stdout,stderr)=>{
          if(error)reject(Object.assign(error,{stdout,stderr}));
          else resolve({stdout,stderr});
        });
      });
      return {verdict:'pass' as const,exitCode:0,output:result.stdout+result.stderr};
    }catch(error){
      if(error instanceof Error && error.message.includes('OFFLINE_TEST_EXECUTION_DENIED')) throw error;
      const failure=error as Error & {code?:unknown;stdout?:string;stderr?:string;killed?:boolean};
      if(typeof failure.code!=='number' || failure.killed) throw error;
      return {verdict:'fail' as const,exitCode:failure.code,output:(failure.stdout??'')+(failure.stderr??'')};
    }
  };
};
