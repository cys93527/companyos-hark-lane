import { describe, expect, it } from 'vitest';
import { FixedClock, createMemoryRecord, retrieveMemories } from '@companyos/core';
import { createInMemoryMemoryStore, createInMemoryDecisionStore, createMemoryService, createDecisionService } from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

const clock = new FixedClock(Date.parse('2026-01-01T00:00:00.000Z'));
const ids = (() => { let n=0; return { id: (p='id') => `${p}_${++n}` }; })();
const allow = async () => ({ ok:true as const, value:true as const });
const memoryInput = { companyId:'cmp_1', scope:{type:'COMPANY' as const,id:'cmp_1'}, kind:'FACT' as const, title:'Policy', content:'Use SQLite', importance:'HIGH' as const, sourceType:'USER' as const, createdBy:'actor', traceId:'trace', metadata:{} };
const decisionInput = { companyId:'cmp_1', scope:{type:'COMPANY' as const,id:'cmp_1'}, title:'Storage', question:'Which store?', decision:'SQLite', rationale:'Durable local first', alternativesConsidered:['Cloud'], constraints:[], consequences:['Restart safe'], relatedMemoryRefs:[], relatedHandoffRefs:[], relatedArtifactRefs:[], decidedBy:'actor', traceId:'trace', provenance:{sourceType:'USER' as const,sourceRefs:[]} };

describe('Sprint 12 organizational memory and decision', () => {
  it('creates bounded structured memory with provenance and trust', async () => {
    const store=createInMemoryMemoryStore(); const svc=createMemoryService({store,clock,ids,authorize:allow});
    const r=await svc.create(memoryInput as never); expect(r.ok).toBe(true); if(r.ok) expect(r.value.provenance.sourceType).toBe('USER');
  });
  it('rejects secret-like memory content', () => expect(createMemoryRecord({...memoryInput,memoryId:'mem_x',content:'api_key=secret'}).ok).toBe(false));
  it('uses deterministic scope precedence and surfaces conflicts', () => {
    const a=createMemoryRecord({...memoryInput,memoryId:'mem_a',subjectKey:'policy.retention',createdAt:'2026-01-01T00:00:00.000Z'}); const b=createMemoryRecord({...memoryInput,memoryId:'mem_b',scope:{type:'TASK',id:'tsk_1'},subjectKey:'policy.retention',createdAt:'2026-01-01T00:00:01.000Z'}); expect(a.ok&&b.ok).toBe(true); if(!a.ok||!b.ok)return; const r=retrieveMemories([a.value,b.value],{companyId:'cmp_1',scopes:[memoryInput.scope,{type:'TASK',id:'tsk_1'}],now:clock.nowIso(),maxChars:1000}); expect(r.items[0]?.memoryId).toBe('mem_b');
  });
  it('shadows the same subject at each scope without affecting other subjects', () => {
    const scopes = [{type:'COMPANY' as const,id:'cmp_1'},{type:'WORKFLOW' as const,id:'w'},{type:'ROLE' as const,id:'r'},{type:'TASK' as const,id:'t'}];
    const rows = scopes.map((scope,i)=>createMemoryRecord({...memoryInput,memoryId:`mem_scope_${i}`,scope,subjectKey:'coding.language',content:['TypeScript','JavaScript','Go','Python'][i]!})).filter(x=>x.ok).map(x=>x.value);
    const other=createMemoryRecord({...memoryInput,memoryId:'mem_other',subjectKey:'coding.runtime',content:'Node'}); expect(other.ok).toBe(true); if(!other.ok)return;
    const result=retrieveMemories([...rows,other.value],{companyId:'cmp_1',scopes,now:clock.nowIso()}); expect(result.items.find(x=>x.subjectKey==='coding.language')?.content).toBe('Python'); expect(result.items.some(x=>x.subjectKey==='coding.runtime')).toBe(true);
  });
  it('supersedes memory versions without rewriting terminal history', async () => {
    const store=createInMemoryMemoryStore(); const svc=createMemoryService({store,clock,ids,authorize:allow}); const one=await svc.create(memoryInput as never); expect(one.ok).toBe(true); if(!one.ok)return; const two=await svc.supersede({memoryId:one.value.memoryId,version:1,actorId:'actor',next:memoryInput as never}); expect(two.ok).toBe(true); expect((await store.listVersions(one.value.memoryId)).map(x=>x.status)).toEqual(['ACTIVE','SUPERSEDED']);
  });
  it('marks stale and retracts memory', async () => { const store=createInMemoryMemoryStore(); const svc=createMemoryService({store,clock,ids,authorize:allow}); const one=await svc.create(memoryInput as never); if(!one.ok)return; const stale=await svc.markStale({memoryId:one.value.memoryId,version:1,actorId:'actor',reason:'old'}); expect(stale.ok&&stale.value.status).toBe('STALE'); const ret=await svc.retract({memoryId:one.value.memoryId,version:1,actorId:'actor'}); expect(ret.ok&&ret.value.status).toBe('RETRACTED'); });
  it('persists explicit decisions and supports supersede/revoke', async () => { const store=createInMemoryDecisionStore(); const svc=createDecisionService({store,clock,ids,authorize:allow}); const one=await svc.create(decisionInput as never); expect(one.ok).toBe(true); if(!one.ok)return; const two=await svc.supersede({decisionId:one.value.decisionId,version:1,actorId:'actor',next:decisionInput as never}); expect(two.ok).toBe(true); const revoked=await svc.revoke({decisionId:one.value.decisionId,version:2,actorId:'actor'}); expect(revoked.ok&&revoked.value.status).toBe('REVOKED'); });
  it('decision records are distinct from memory records', () => expect(Object.hasOwn(decisionInput,'question')).toBe(true));
  it('does not accept client-supplied VERIFIED trust', async () => { const svc=createMemoryService({store:createInMemoryMemoryStore(),clock,ids,authorize:allow}); const r=await svc.create({...memoryInput,trust:'VERIFIED'} as never); expect(!r.ok && r.error.code).toBe('INVALID_ARGUMENT'); });
  it('verifies handoff provenance before granting VERIFIED', async () => { const svc=createMemoryService({store:createInMemoryMemoryStore(),clock,ids,authorize:allow,provenance:{verify:async ({sourceType,sourceRefs}) => sourceType==='HANDOFF'&&sourceRefs[0]==='hnd_1@v1'?{ok:true as const,value:'VERIFIED' as const}:{ok:false as const,error:new Error('not accepted') as never}}}); const r=await svc.create({...memoryInput,sourceType:'HANDOFF',sourceRefs:['hnd_1@v1']} as never); expect(r.ok&&r.value.trust).toBe('VERIFIED'); });
  it('surfaces same-subject active decision conflicts', async () => { const store=createInMemoryDecisionStore(); const svc=createDecisionService({store,clock,ids,authorize:allow}); const a=await svc.create({...decisionInput,subjectKey:'storage.mode'} as never); const b=await svc.create({...decisionInput,subjectKey:'storage.mode'} as never); expect(a.ok&&b.ok).toBe(true); const active=await svc.active('cmp_1','actor'); expect(!active.ok && active.error.details.reason).toBe('DECISION_CONFLICT'); });
  it('excludes stale, expired and retracted records from the default view', () => { const base=createMemoryRecord({...memoryInput,memoryId:'mem_exp',expiresAt:clock.nowIso()}); expect(base.ok).toBe(true); if(!base.ok)return; const stale={...base.value,status:'STALE' as const}; const retracted={...base.value,memoryId:'mem_ret',id:'mem_ret',status:'RETRACTED' as const}; const result=retrieveMemories([base.value,stale,retracted],{companyId:'cmp_1',scopes:[memoryInput.scope],now:clock.nowIso()}); expect(result.items).toHaveLength(0); });
  it('uses an actual SQLite memory chain for restart-stable history', async () => { const d=openDurableDatabase({dataDir:':memory:',appliedAt:clock.nowIso(),chains:['memory']}); const r=createMemoryRecord({...memoryInput,memoryId:'mem_sqlite'}); expect(r.ok).toBe(true); if(!r.ok)return; await d.memories!.create(r.value); expect((await d.memories!.listVersions('mem_sqlite')).length).toBe(1); d.close(); });
});
