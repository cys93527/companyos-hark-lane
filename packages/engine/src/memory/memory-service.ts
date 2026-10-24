import { createMemoryRecord, domainError, err, ok, retrieveMemories, transitionMemory, type Clock, type CreateMemoryInput, type DomainError, type MemoryRecord, type MemoryRetrievalInput, type MemoryRetrievalResult, type MemoryStorePort, type Result } from '@companyos/core';

export interface MemoryAudit { emit(type: string, payload: { readonly memoryId: string; readonly version: number; readonly actorId: string; readonly scope: string; readonly kind: string; readonly status: string; readonly sourceType: string; readonly traceId: string }): Promise<void>; }
export interface MemoryProvenanceVerifier { verify(input: { readonly sourceType: string; readonly sourceRefs: readonly string[]; readonly companyId: string }): Promise<Result<'VERIFIED'|'ASSERTED'|'INFERRED', DomainError>>; }
export interface MemoryServiceDeps {
  readonly store: MemoryStorePort; readonly clock: Clock; readonly ids: { id(prefix?: string): string };
  readonly authorize: (i: { actorId:string; authority:'memory.create'|'memory.read'|'memory.supersede'|'memory.retract'; scopeId?:string })=>Promise<Result<true,DomainError>>;
  readonly audit?: MemoryAudit; readonly provenance?: MemoryProvenanceVerifier;
  readonly transaction?: <T>(fn:()=>Promise<Result<T,DomainError>>)=>Promise<Result<T,DomainError>>;
}
export interface MemoryService {
  create(input: Omit<CreateMemoryInput,'memoryId'|'createdAt'|'version'> & { actorId:string }): Promise<Result<MemoryRecord,DomainError>>;
  get(memoryId:string, version:number|null, actorId:string):Promise<Result<MemoryRecord,DomainError>>;
  history(memoryId:string, actorId:string):Promise<Result<readonly MemoryRecord[],DomainError>>;
  retrieve(input: MemoryRetrievalInput & { actorId:string }):Promise<Result<MemoryRetrievalResult,DomainError>>;
  supersede(input:{memoryId:string; version:number; actorId:string; next:Omit<CreateMemoryInput,'memoryId'|'createdAt'|'version'|'supersedes'>}):Promise<Result<{previous:MemoryRecord; next:MemoryRecord},DomainError>>;
  markStale(input:{memoryId:string;version:number;actorId:string;reason:string}):Promise<Result<MemoryRecord,DomainError>>;
  retract(input:{memoryId:string;version:number;actorId:string;reason?:string}):Promise<Result<MemoryRecord,DomainError>>;
}
const scopeKey=(s:{type:string;id:string})=>`${s.type}:${s.id}`;
export function createMemoryService(d:MemoryServiceDeps):MemoryService {
  const permit = (actorId:string, authority:'memory.create'|'memory.read'|'memory.supersede'|'memory.retract', scopeId?:string) => d.authorize({actorId,authority,scopeId});
  const load = async (id:string,v:number|null) => { const x=await d.store.get(id,v); return x?ok(x):err(domainError('NOT_FOUND',`Memory "${id}" not found.`)); };
  const audit = async (type:string,r:MemoryRecord,a:string) => d.audit?.emit(type,{memoryId:r.memoryId,version:r.version,actorId:a,scope:scopeKey(r.scope),kind:r.kind,status:r.status,sourceType:r.sourceType,traceId:r.traceId});
  return {
    async create(input) {
      const p=await permit(input.actorId,'memory.create',scopeKey(input.scope)); if(!p.ok)return p;
      const untrustedInput = input as Record<string, unknown>;
      if (input.trust === 'VERIFIED' || ['confidence','verified','effectiveTrust','serverVerified','provenanceVerified'].some(key => key in untrustedInput)) return err(domainError('INVALID_ARGUMENT','Trust is server-derived and cannot be supplied by the client.'));
      if (input.sourceType === 'SYSTEM') return err(domainError('VALIDATION_FAILED','SYSTEM memory provenance is reserved for trusted runtime writers.'));
      let trust: 'VERIFIED'|'ASSERTED'|'INFERRED' = input.sourceType === 'USER' ? 'ASSERTED' : 'ASSERTED';
      if (input.sourceType !== 'USER') {
        if (!d.provenance) return err(domainError('VALIDATION_FAILED','Non-user memory requires server provenance verification.'));
        const v=await d.provenance.verify({sourceType:input.sourceType,sourceRefs:input.sourceRefs??[],companyId:input.companyId}); if(!v.ok)return v; trust=v.value;
      }
      const made=createMemoryRecord({...input,memoryId:d.ids.id('mem'),createdAt:d.clock.nowIso(),version:1,trust}); if(!made.ok)return made;
      try { await d.store.create(made.value); } catch(e) { return err(domainError('CONFLICT','Memory version already exists.',{cause:String(e)})); }
      await audit('memory.created',made.value,input.actorId); return made;
    },
    async get(id,v,a){const p=await permit(a,'memory.read',id);if(!p.ok)return p;return load(id,v);},
    async history(id,a){const p=await permit(a,'memory.read',id);if(!p.ok)return p;return ok(await d.store.listVersions(id));},
    async retrieve(input){const p=await permit(input.actorId,'memory.read',input.companyId);if(!p.ok)return p;return ok(d.store.retrieve?await d.store.retrieve(input):retrieveMemories(await d.store.listAll(),input));},
    async supersede(input){const p=await permit(input.actorId,'memory.supersede',input.memoryId);if(!p.ok)return p; if(input.next.trust==='VERIFIED' || ['confidence','verified','effectiveTrust','serverVerified','provenanceVerified'].some(key => key in (input.next as Record<string, unknown>))) return err(domainError('INVALID_ARGUMENT','Trust is server-derived and cannot be supplied by the client.')); if(input.next.sourceType==='SYSTEM') return err(domainError('VALIDATION_FAILED','SYSTEM memory provenance is reserved for trusted runtime writers.')); const old=await load(input.memoryId,input.version);if(!old.ok)return old; let trust: 'VERIFIED'|'ASSERTED'|'INFERRED' = input.next.sourceType === 'USER' ? 'ASSERTED' : 'ASSERTED'; if(input.next.sourceType!=='USER'){if(!d.provenance)return err(domainError('VALIDATION_FAILED','Non-user memory requires server provenance verification.'));const v=await d.provenance.verify({sourceType:input.next.sourceType,sourceRefs:input.next.sourceRefs??[],companyId:input.next.companyId});if(!v.ok)return v;trust=v.value;} const made=createMemoryRecord({...input.next,memoryId:input.memoryId,version:input.version+1,supersedes:`${input.memoryId}:${input.version}`,createdAt:d.clock.nowIso(),trust});if(!made.ok)return made;const work=async()=>{const tr=transitionMemory(old.value,'SUPERSEDED',d.clock.nowIso());if(!tr.ok)return tr;await d.store.create(made.value);await d.store.update(tr.value);return ok({previous:tr.value,next:made.value});};const out=d.transaction?await d.transaction(work):await work();if(out.ok)await audit('memory.superseded',made.value,input.actorId);return out;},
    async markStale(input){const p=await permit(input.actorId,'memory.supersede',input.memoryId);if(!p.ok)return p;const x=await load(input.memoryId,input.version);if(!x.ok)return x;const y=transitionMemory(x.value,'STALE',d.clock.nowIso(),input.reason);if(!y.ok)return y;await d.store.update(y.value);await audit('memory.stale',y.value,input.actorId);return y;},
    async retract(input){const p=await permit(input.actorId,'memory.retract',input.memoryId);if(!p.ok)return p;const x=await load(input.memoryId,input.version);if(!x.ok)return x;const y=transitionMemory(x.value,'RETRACTED',d.clock.nowIso(),input.reason);if(!y.ok)return y;await d.store.update(y.value);await audit('memory.retracted',y.value,input.actorId);return y;},
  };
}
