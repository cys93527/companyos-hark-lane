import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixedClock, buildAgentContext, createMemoryRecord, defineEvent, expireMemory, projectDecisionContext, retrieveMemories } from '@companyos/core';
import { createDecisionService, createHandoffService, createInMemoryDecisionStore, createMemoryService } from '@companyos/engine';
import { openDurableDatabase } from '@companyos/persistence';

const clock = new FixedClock(Date.parse('2027-01-01T00:00:00.000Z'));
const auth = async () => ({ ok: true as const, value: true as const });
let sequence = 0;
const ids = { id: (prefix = 'id') => `${prefix}_${++sequence}` };
const input = { companyId:'cmp_e2e', scope:{type:'COMPANY' as const,id:'cmp_e2e'}, kind:'FACT' as const, title:'language', content:'TypeScript', importance:'NORMAL' as const, sourceType:'USER' as const, createdBy:'actor', traceId:'trace', metadata:{} };

describe('Sprint 12 closeout behavior against durable SQLite', () => {
  it('reopens memory history and preserves supersession/stale/retract visibility', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companyos-s12-')); try {
      let db = openDurableDatabase({ dataDir:dir, appliedAt:clock.nowIso(), chains:['memory'] });
      const service = createMemoryService({ store:db.memories!, clock, ids, authorize:auth, transaction:db.unitOfWork.transaction.bind(db.unitOfWork) as never });
      const first = await service.create(input as never); expect(first.ok).toBe(true); if(!first.ok)return;
      const second = await service.supersede({memoryId:first.value.memoryId,version:1,actorId:'actor',next:{...input,content:'JavaScript'} as never}); expect(second.ok).toBe(true);
      const stale = await service.create({ ...input, memoryId: undefined, content: 'stale row' } as never); expect(stale.ok).toBe(true); if (!stale.ok) return;
      expect((await service.markStale({ memoryId: stale.value.memoryId, version: 1, actorId: 'actor', reason: 'obsolete' })).ok).toBe(true);
      const retracted = await service.create({ ...input, content: 'retracted row' } as never); expect(retracted.ok).toBe(true); if (!retracted.ok) return;
      expect((await service.retract({ memoryId: retracted.value.memoryId, version: 1, actorId: 'actor', reason: 'removed' })).ok).toBe(true);
      const expired = await service.create({ ...input, content: 'expired row', expiresAt: clock.nowIso() } as never); expect(expired.ok).toBe(true);
      if (expired.ok) { const transitioned = expireMemory(expired.value, clock.nowIso()); expect(transitioned.ok).toBe(true); if (transitioned.ok) await db.memories!.update(transitioned.value); }
      db.close(); db = openDurableDatabase({ dataDir:dir, appliedAt:clock.nowIso(), chains:['memory'] });
      const all = await db.memories!.listVersions(first.value.memoryId); expect(all.map(x=>x.status)).toEqual(['ACTIVE','SUPERSEDED']);
      const rows = await db.memories!.listAll(); const visible = retrieveMemories(rows,{companyId:'cmp_e2e',scopes:[input.scope],now:clock.nowIso()}); expect(visible.items).toHaveLength(1); expect(visible.items[0]?.memoryId).toBe(first.value.memoryId);
      expect(retrieveMemories(rows,{companyId:'cmp_e2e',scopes:[input.scope],now:clock.nowIso(),includeHistorical:true}).items).toHaveLength(5); db.close();
    } finally { try { rmSync(dir,{recursive:true,force:true}); } catch { void 0; } }
  });
  it('reopens decision history and keeps only the latest active version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companyos-s12-decision-restart-')); try {
      let db = openDurableDatabase({ dataDir: dir, appliedAt: clock.nowIso(), chains: ['memory'] });
      const decision = createDecisionService({ store: db.decisions!, clock, ids, authorize: auth, transaction: db.unitOfWork.transaction.bind(db.unitOfWork) as never });
      const seed = { companyId: 'cmp_e2e', scope: input.scope, subjectKey: 'storage.mode', title: 'Storage', question: 'Which?', decision: 'SQLite', rationale: 'local', alternativesConsidered: [], constraints: [], consequences: [], relatedMemoryRefs: ['mem_ref@v1'], relatedHandoffRefs: ['hnd_ref@v2'], relatedArtifactRefs: ['art_ref@v3'], decidedBy: 'actor', traceId: 'decision-restart', provenance: { sourceType: 'USER' as const, sourceRefs: [] } };
      const first = await decision.create(seed as never); expect(first.ok).toBe(true); if (!first.ok) return;
      const second = await decision.supersede({ decisionId: first.value.decisionId, version: 1, actorId: 'actor', next: { ...seed, decision: 'Postgres' } as never }); expect(second.ok).toBe(true);
      db.close(); db = openDurableDatabase({ dataDir: dir, appliedAt: clock.nowIso(), chains: ['memory'] });
      const versions = await db.decisions!.listVersions(first.value.decisionId); expect(versions.map(x => x.status)).toEqual(['ACTIVE', 'SUPERSEDED']); expect(versions[0]?.relatedHandoffRefs).toEqual(['hnd_ref@v2']);
      expect((await db.decisions!.listActive('cmp_e2e')).map(x => x.decision)).toEqual(['Postgres']); db.close();
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { void 0; } }
  });
  it('keeps expiration boundary stable after reopening SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companyos-s12-expire-restart-')); try {
      let db = openDurableDatabase({ dataDir: dir, appliedAt: clock.nowIso(), chains: ['memory'] });
      const record = createMemoryRecord({ ...input, memoryId: 'mem_expire_restart', expiresAt: clock.nowIso() }); expect(record.ok).toBe(true); if (!record.ok) return;
      await db.memories!.create(record.value); db.close(); db = openDurableDatabase({ dataDir: dir, appliedAt: clock.nowIso(), chains: ['memory'] });
      const rows = await db.memories!.listAll(); expect(retrieveMemories(rows, { companyId: input.companyId, scopes: [input.scope], now: clock.nowIso() }).items).toHaveLength(0); expect(retrieveMemories(rows, { companyId: input.companyId, scopes: [input.scope], now: clock.nowIso(), includeHistorical: true }).items).toHaveLength(1); db.close();
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { void 0; } }
  });
  it('rolls back a failed second supersession write without an audit half-event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companyos-s12-fault-')); try {
      const db = openDurableDatabase({dataDir:dir,appliedAt:clock.nowIso(),chains:['memory']}); const base = db.memories!; const one = createMemoryRecord({...input,memoryId:'mem_fault'}); expect(one.ok).toBe(true); if(!one.ok)return; await base.create(one.value);
      const failing = {...base, update: async () => { throw new Error('injected second-step failure'); }};
      const events:string[]=[]; const service = createMemoryService({store:failing,clock,ids,authorize:auth,transaction:db.unitOfWork.transaction.bind(db.unitOfWork) as never,audit:{emit:async type=>{events.push(type);}}});
      const result = await service.supersede({memoryId:'mem_fault',version:1,actorId:'actor',next:{...input,content:'rollback'} as never}); expect(result.ok).toBe(false); expect((await base.get('mem_fault',1))?.status).toBe('ACTIVE'); expect(await base.get('mem_fault',2)).toBeNull(); expect(events).toEqual([]); db.close();
    } finally { try { rmSync(dir,{recursive:true,force:true}); } catch { /* best-effort cleanup */ } }
  });
  it('verifies accepted durable handoff provenance and rejects non-accepted states', async () => {
    const dir=mkdtempSync(join(tmpdir(),'companyos-s12-prov-')); try { const db=openDurableDatabase({dataDir:dir,appliedAt:clock.nowIso(),chains:['memory','handoff']});
      const noAudit = { created: async () => {}, ready: async () => {}, accepted: async () => {}, rejected: async () => {}, superseded: async () => {}, cancelled: async () => {} };
      const handoff = createHandoffService({ store: db.handoffStore!, clock, authorize: async () => ({ ok: true as const, value: true as const }), actorRoleIds: async () => ['r2'], audit: noAudit });
      const packet=await handoff.createDraft({handoffId:'hnd_prov',companyId:'cmp_e2e',workflowId:'w',workflowVersionId:'v',workflowRunId:'r',stageId:'s',taskId:'t',fromAgentId:'a',fromRoleId:'r1',toRoleId:'r2',objective:'o',summary:'s',recommendedNextAction:'n',completedWork:[],remainingWork:[],constraints:[],acceptanceCriteria:[],artifactRefs:[],decisionRefs:[],validationRefs:[],knownRisks:[],openQuestions:[],traceId:'tr',actorId:'a'}); expect(packet.ok).toBe(true); if(!packet.ok)return; expect((await handoff.ready({handoffId:'hnd_prov',version:1,actorId:'a'})).ok).toBe(true); expect((await handoff.accept({handoffId:'hnd_prov',version:1,actorId:'reviewer'})).ok).toBe(true); const verify=async (ref:string)=>{const m=/^(.*)@v(\d+)$/.exec(ref);const p=m?await db.handoffStore!.get(m[1]!,Number(m[2])):null;return p?.status==='ACCEPTED'};
      const verifier={verify:async ({sourceType,sourceRefs}:{sourceType:string;sourceRefs:readonly string[];companyId:string})=>sourceType==='HANDOFF'&&sourceRefs[0]&&await verify(sourceRefs[0])?{ok:true as const,value:'VERIFIED' as const}:{ok:false as const,error:new Error('not accepted') as never}};
      const service=createMemoryService({store:db.memories!,clock,ids,authorize:auth,provenance:verifier}); const made=await service.create({...input,sourceType:'HANDOFF',sourceRefs:['hnd_prov@v1']} as never); expect(made.ok&&made.value.trust).toBe('VERIFIED'); const denied=await service.create({...input,sourceType:'HANDOFF',sourceRefs:['missing@v1']} as never); expect(denied.ok).toBe(false); db.close();
    } finally { try{rmSync(dir,{recursive:true,force:true});}catch{void 0;} }
  });
  it('rolls back decision supersession when the terminal update fails', async () => {
    const dir=mkdtempSync(join(tmpdir(),'companyos-s12-decision-fault-')); try { const db=openDurableDatabase({dataDir:dir,appliedAt:clock.nowIso(),chains:['memory']}); const base=db.decisions!;
      const first=await createDecisionService({store:base,clock,ids,authorize:auth}).create({companyId:'cmp_e2e',scope:input.scope,title:'D',question:'Q',decision:'A',rationale:'R',alternativesConsidered:[],constraints:[],consequences:[],relatedMemoryRefs:[],relatedHandoffRefs:[],relatedArtifactRefs:[],decidedBy:'actor',traceId:'tr',provenance:{sourceType:'USER',sourceRefs:[]}} as never); expect(first.ok).toBe(true); if(!first.ok)return;
      const failing={...base,update:async()=>{throw new Error('injected decision failure');}}; const result=await createDecisionService({store:failing,clock,ids,authorize:auth,transaction:db.unitOfWork.transaction.bind(db.unitOfWork) as never}).supersede({decisionId:first.value.decisionId,version:1,actorId:'actor',next:{companyId:'cmp_e2e',scope:input.scope,title:'D2',question:'Q',decision:'B',rationale:'R2',alternativesConsidered:[],constraints:[],consequences:[],relatedMemoryRefs:[],relatedHandoffRefs:[],relatedArtifactRefs:[],decidedBy:'actor',traceId:'tr',provenance:{sourceType:'USER',sourceRefs:[]}} as never}); expect(result.ok).toBe(false); expect((await base.get(first.value.decisionId,1))?.status).toBe('ACTIVE'); expect(await base.get(first.value.decisionId,2)).toBeNull(); db.close();
    } finally { try{rmSync(dir,{recursive:true,force:true});}catch{void 0;} }
  });
  it('persists redacted Memory and Decision audit payloads without bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companyos-s12-audit-')); try {
      const db = openDurableDatabase({ dataDir: dir, appliedAt: clock.nowIso(), chains: ['memory'] });
      const audit = { emit: async (type: string, payload: Record<string, unknown>) => { await db.events.append([defineEvent({ type, aggregateId: String(payload.memoryId ?? payload.decisionId), aggregateType: String(payload.memoryId ? 'Memory' : 'Decision'), traceId: String(payload.traceId), actorId: String(payload.actorId), payload }, ids, clock.nowIso())]); } };
      const memory = createMemoryService({ store: db.memories!, clock, ids, authorize: auth, audit });
      const made = await memory.create({ ...input, content: 'sensitive body should not be audited' } as never); expect(made.ok).toBe(true);
      const decision = createDecisionService({ store: db.decisions!, clock, ids, authorize: auth, audit: { emit: audit.emit } });
      await decision.create({ companyId: input.companyId, scope: input.scope, title: 'Decision', question: 'Q', decision: 'A', rationale: 'R', alternativesConsidered: [], constraints: [], consequences: [], relatedMemoryRefs: [], relatedHandoffRefs: [], relatedArtifactRefs: [], decidedBy: 'actor', traceId: 'audit', provenance: { sourceType: 'USER', sourceRefs: [] } } as never);
      const events = await db.events.all(); expect(events).toHaveLength(2); for (const event of events) { const payload = event.event.payload as Record<string, unknown>; expect(payload).not.toHaveProperty('content'); expect(payload).not.toHaveProperty('question'); expect(payload).not.toHaveProperty('rationale'); expect(Object.keys(payload).every(key => ['memoryId','decisionId','version','actorId','scope','kind','status','sourceType','traceId'].includes(key))).toBe(true); } db.close();
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { void 0; } }
  });
  it('bounds a stable runtime projection and keeps decisions separate', async () => {
    const records = Array.from({length:60},(_,i)=>createMemoryRecord({...input,memoryId:`mem_${i}`,subjectKey:`key.${i}`,content:`value-${i}`})).filter(x=>x.ok).map(x=>x.value);
    const projection = retrieveMemories(records,{companyId:'cmp_e2e',scopes:[input.scope],now:clock.nowIso(),limit:10,maxChars:40}); expect(projection.totalMatched).toBeGreaterThan(projection.includedCount); expect(projection.truncated).toBe(true);
    const d = createDecisionService({store:createInMemoryDecisionStore(),clock,ids,authorize:auth}); const made=await d.create({...input,title:'Decision',question:'Q',decision:'A',rationale:'R',alternativesConsidered:[],constraints:[],consequences:[],relatedMemoryRefs:[],relatedHandoffRefs:[],relatedArtifactRefs:[],decidedBy:'actor',provenance:{sourceType:'USER',sourceRefs:[]}} as never); expect(made.ok).toBe(true); if(!made.ok)return;
    const dv=projectDecisionContext([made.value],{companyId:'cmp_e2e',scopes:[input.scope],now:clock.nowIso(),maxChars:100}); const ctx=buildAgentContext({company:{id:'cmp_e2e',label:'c'},workflow:{id:'w',label:'w'},workflowRun:{id:'r',label:'r'},task:{id:'t',label:'t'},role:{id:'role',label:'role'},workflowVersion:'v1',binding:{modelKey:'m',providerId:'p',providerModelId:'pm',source:'MANUAL'},objective:'o',memoryView:projection.items.map(x=>x.content),decisionView:dv.items.map(x=>x.decision),trace:{traceId:'t',executionId:'e',attempt:1}}); expect(ctx.ok).toBe(true); if(ctx.ok) expect(ctx.value.memoryView.length).toBeLessThanOrEqual(10);
  });
});
