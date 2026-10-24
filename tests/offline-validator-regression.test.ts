import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,it,expect} from 'vitest';
import {createOfflineNodeValidator} from './support/offline-node-validator.js';

describe('RC1 explicit isolated validator script',()=>{
  it.each([false,true])('executes real assertion output and exit for fail=%s',async fail=>{
    const dir=mkdtempSync(join(tmpdir(),'rc1-validator-'));
    try{
      const result=await createOfflineNodeValidator(dir,fail)();
      expect(result.verdict).toBe(fail?'fail':'pass');
      expect(result.exitCode).toBe(fail?1:0);
      expect(result.output).toContain(fail?'fail 1':'pass 1');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('does not launder a launch denial into a business fail verdict',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'rc1-validator-'));
    try{
      const validate=createOfflineNodeValidator(dir);
      writeFileSync(join(dir,'offline-validation.cjs'),'process.exit(0);','utf8');
      await expect(validate()).rejects.toThrow('OFFLINE_TEST_EXECUTION_DENIED');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
