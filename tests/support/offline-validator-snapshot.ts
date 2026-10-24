import {afterEach, vi} from 'vitest';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type * as RepoTestProcess from '../../apps/desktop/src/repo-test-process.js';
import {saveOfflinePackageTraces} from './offline-fixtures.js';

const evidence=vi.hoisted(()=>({denials:[] as {stage:string;reason:string}[]}));
// Test-only wiring into the unchanged production process port. A denied launch
// remains an infrastructure error, never evidence of a business validator FAIL.
vi.mock('../../apps/desktop/src/repo-test-process.js',async importOriginal=>{
  const actual=await importOriginal<typeof RepoTestProcess>();
  const {registerOfflinePackageSnapshot}=await import('./offline-fixtures.js');
  return {...actual,runRepoTestContract:async(input:Parameters<typeof actual.runRepoTestContract>[0])=>{
    try {
      registerOfflinePackageSnapshot(input.cwd);
      return await actual.runRepoTestContract(input);
    } catch(error) {
      if (error instanceof Error && error.message.includes('OFFLINE_TEST_EXECUTION_DENIED')) {
        evidence.denials.push({stage:'repo.test-check launch',reason:error.message});
      }
      throw error;
    }
  }};
});
afterEach(()=>{
  saveOfflinePackageTraces();
  const denials=evidence.denials.splice(0);
  if(denials.length){
    writeFileSync(join(tmpdir(),`validator-launch-denial-${Date.now()}.json`),JSON.stringify(denials,null,2)+'\n',{encoding:'utf8',flag:'wx'});
    throw new Error(`OFFLINE_VALIDATOR_INFRASTRUCTURE_FAILURE: ${JSON.stringify(denials)}`);
  }
});
