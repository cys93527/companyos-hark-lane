import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { COMPANY, composeF5, createdDirs, openDatabases } from './helpers/f5-fixture.js';
import { GOAL_WORK_KIND } from '../../apps/desktop/src/control-plane.js';

afterEach(() => { while (openDatabases.length) openDatabases.pop()?.close(); while (createdDirs.length) rmSync(createdDirs.pop()!, { recursive: true, force: true }); });
const text = 'Hello CompanyOS V1';
const hash = createHash('sha256').update(text).digest('hex');
const files = [{ criterionId: 'file-delivery-1', relativePath: 'hello.txt', maxBytes: 18, expectedSizeBytes: 18, expectedSha256: hash }];

const run = async (mode: 'correct' | 'wrong' | 'missing') => {

  let executed = 0;
  const f: Awaited<ReturnType<typeof composeF5>> = await composeF5({
    executionSafety: { policyId:'OFFLINE_ONLY_FILE_E2E',maxCalls:100,maxTokens:10000000,maxCostMicros:1000000,durationMs:120000,boundOf:({modelKey})=>({modelKey,inputTokens:20000,outputTokens:16000,costMicros:1,evidenceRef:'DETERMINISTIC_LOCAL_ONLY',validUntilMs:Date.now()+120000}),costOf:()=>1 },
    planItems: [
      {planItemId:'produce',objective:'Write the declared file.',dependencyPlanItemIds:[],acceptanceCriterionRefs:['file-delivery-1'],taskKind:GOAL_WORK_KIND},
      {planItemId:'inspect',objective:'Read and check the delivered file independently.',dependencyPlanItemIds:['produce'],acceptanceCriterionRefs:['inspect-1'],taskKind:GOAL_WORK_KIND},
    ],
    acceptanceCriteria:[{criterionId:'file-delivery-1',requirement:'Deliver the exact declared UTF-8 bytes.'},{criterionId:'inspect-1',requirement:'Independently read and check the actual file.'}],
    execute:async(request,workspace)=>{
      executed += 1;
      const pkg=await f.core.workPackageProjector!.project({companyId:COMPANY,runId:request.runId,taskId:request.taskId});
      if(!pkg.ok)throw pkg.error;
      const producing=pkg.value.acceptance.criteria.some(c=>c.criterionId==='file-delivery-1');
      const now=new Date().toISOString();
      if(producing){
        if(mode!=='missing')writeFileSync(join(workspace,'hello.txt'),mode==='correct'?text:'wrong','utf8');
        const goalRunId=await f.core.database.executionBudget.goalOf(request.runId);
        return {kind:'succeeded',exitCode:0,stdoutText:JSON.stringify({schema:'companyos/business-files/1',goalRunId,runId:request.runId,taskId:request.taskId,files:[{relativePath:'hello.txt',sizeBytes:18,sha256:hash}]}),startedAt:now,finishedAt:now};
      }
      expect(readFileSync(join(workspace,'hello.txt'),'utf8')).toBe(text);
      return {kind:'succeeded',exitCode:0,stdoutText:'Independent local file inspection.',structured:{artifactContent:'Read actual file; byte identity '+hash},startedAt:now,finishedAt:now};
    },
  });
  const cp=f.core.controlPlane!;
  const created=await cp.handle({operation:'goal.create',payload:{companyId:COMPANY,commandId:'file-e2e-'+mode,objective:'Create the exact requested file and verify delivery.',structured:{fileDeliveries:files}}});
  expect(created.ok,JSON.stringify(created)).toBe(true);if(!created.ok)throw created.error;
  const goal=String((created.value as {runId:string}).runId);let child='';
  for(let i=0;i<30;i++){
    const v=await cp.handle({operation:'goal.advance',payload:{companyId:COMPANY,runId:goal}});
    if(!v.ok)break;
    child=String((v.value as {executionRunId?:string}).executionRunId??child);
    const row=await f.core.database.runs.get(goal);
    if(row?.state==='COMPLETED'||row?.state==='FAILED')break;
  }
  return {f,goal,child,cp,executed};
};

it('offline canonical two-stage file workflow produces verified Artifact/Handoff and terminal Goal',async()=>{
  const t=await run('correct');
  expect((await t.f.core.database.runs.get(t.goal))?.state,JSON.stringify({runs:t.f.core.database.db.prepare('SELECT id,state,failure_reason FROM runs').all(),tasks:t.f.core.database.db.prepare('SELECT * FROM tasks').all()})).toBe('COMPLETED');
  expect((await t.f.core.database.runs.get(t.child))?.state).toBe('COMPLETED');
  expect(readFileSync(join(t.f.workspace,'hello.txt'))).toEqual(Buffer.from(text));
  const artifacts=t.f.core.database.db.prepare("SELECT * FROM artifacts WHERE kind LIKE 'companyos:business-file:%'").all() as {artifact_id:string;run_id:string}[];
  expect(artifacts).toHaveLength(1);expect(artifacts[0]?.run_id).toBe(t.child);
  const rows=t.f.core.database.db.prepare('SELECT handoff_id,status FROM handoffs').all() as {handoff_id:string;status:string}[];
  expect(rows).toHaveLength(1);expect(rows[0]?.status).toBe('READY');
  const h=await t.f.core.database.handoffStore!.get(rows[0]!.handoff_id,1);
  expect(h?.artifactRefs.some(r=>r.refId===artifacts[0]?.artifact_id)).toBe(true);
  expect(h?.validationRefs.length).toBeGreaterThan(0);
  for(const ref of h!.validationRefs)expect((await t.f.core.database.validationStore!.get(ref.refId as never))?.status).toBe('pass');
  console.log('PHASE3B_E2E_IDENTITY',JSON.stringify({goalId:t.goal,runId:t.child,plan:t.f.core.database.db.prepare('SELECT id,state FROM runs').all(),tasks:t.f.core.database.db.prepare('SELECT id,state FROM tasks').all(),artifact:artifacts[0],handoff:h,executionCount:t.executed,contentSha256:hash}));
  const before=JSON.stringify(rows);
  await t.cp.handle({operation:'goal.advance',payload:{companyId:COMPANY,runId:t.goal}});
  expect(JSON.stringify(t.f.core.database.db.prepare('SELECT handoff_id,status FROM handoffs').all())).toBe(before);
});
for(const mode of ['wrong','missing'] as const)it(mode+' actual file cannot produce successful delivery',async()=>{
  const t=await run(mode);
  expect(t.executed).toBeGreaterThan(0);
  expect((await t.f.core.database.runs.get(t.goal))?.state).not.toBe('COMPLETED');
  expect(t.f.core.database.db.prepare('SELECT handoff_id FROM handoffs').all()).toHaveLength(0);
  expect(t.f.core.database.db.prepare("SELECT artifact_id FROM artifacts WHERE kind LIKE 'companyos:business-file:%'").all()).toHaveLength(0);
});
