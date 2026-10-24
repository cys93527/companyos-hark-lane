import type * as ComposerModule from '../src/composer.js';
import './support/mini-dom.js';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App.js';
import { createContainer, removeContainer } from './support/mini-dom.js';
import { expect, it, vi } from 'vitest';
import { fileDeliveryConstraints } from '../src/file-delivery-input.js';
import { createSubmissionController, type SubmissionIntentRecord } from '../src/submission-intent.js';
import { createSubmissionIntentStore } from '../src/intent-store.js';

it('maps general human text to the existing exact UTF-8 file contract',async()=>{
  expect(await fileDeliveryConstraints('hello.txt','Hello CompanyOS V1')).toMatchObject({fileDeliveries:[{relativePath:'hello.txt',expectedSizeBytes:18,expectedSha256:'f9dbe7985b5eecaa529cfbe1aefa00039bb3291c682ee3fc4ba6fce059e201dc'}]});
  expect(await fileDeliveryConstraints('','')).toBeUndefined();
  await expect(fileDeliveryConstraints('../escape','x')).rejects.toThrow();
  await expect(fileDeliveryConstraints('C:\\outside','x')).rejects.toThrow();
  await expect(fileDeliveryConstraints('/outside','x')).rejects.toThrow();
});
it('outbox replay retains original delivery bytes despite changed editor inputs',async()=>{
  let raw:string|null=null;const storage={getItem:()=>raw,setItem:(_k:string,v:string)=>{raw=v;},removeItem:()=>{raw=null;}};
  const structured=await fileDeliveryConstraints('result.txt','original');
  const seen:SubmissionIntentRecord[]=[];
  const make=()=>createSubmissionController({store:createSubmissionIntentStore(storage),submit:async input=>{seen.push(input as SubmissionIntentRecord);return {error:'offline transport failure'};},now:()=>'',newIntentId:()=> 'fixed'});
  await make().submitObjective('deliver','workspace',structured);
  await fileDeliveryConstraints('changed.txt','changed');await make().resolvePending();
  expect(seen).toHaveLength(2);expect(seen[1]?.structured).toEqual(structured);expect(seen[1]?.intentId).toBe('fixed');
});

const composerProbe = vi.hoisted(() => ({ current: null as null | { onSubmit: () => void; onDraftChange: (s: string) => void } }));
vi.mock('../src/composer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ComposerModule>();
  return { ...actual, ComposerView: (props: Parameters<typeof actual.ComposerView>[0]) => { composerProbe.current = props; return actual.ComposerView(props); } };
});
it('App rejects a queued duplicate while hashing and releases the lock after acknowledgement', async () => {
  const data = new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}});
  const calls: string[] = [];
  vi.stubGlobal('companyos',{appVersion:async()=> 'test',platformInfo:async()=>({platform:'win32',arch:'x64',electron:'test',node:'test',chrome:'test'}),databaseStatus:async()=>({path:'offline',journalMode:'wal',schemaVersion:1}),channels:()=>[],workflowRequest:async()=>({ok:true,value:[]}),controlPlaneRequest:async(r:{operation:string})=>{
    if(r.operation==='goal.create'){calls.push(r.operation);return {ok:true,value:{runId:'offline-goal'}};}
    return r.operation==='home.summary'?{ok:true,value:{goals:[]}}:{ok:false,error:{code:'OFFLINE_TEST'}};
  },workspaceCurrent:async()=> 'F:/owned-test',workspaceSelect:async()=>null,workspaceOpen:async()=>({ok:true,root:'F:/owned-test'}),workspaceSwitch:async()=>({ok:true,root:'F:/owned-test'})});
  const container=createContainer();const root=createRoot(container as unknown as Element);
  try {
    await act(async()=>{root.render(h(App));});
    await act(async()=>{composerProbe.current!.onDraftChange('first explicit request');});
    await act(async()=>{composerProbe.current!.onSubmit();composerProbe.current!.onSubmit();});
    expect(calls).toHaveLength(1);
    await act(async()=>{composerProbe.current!.onDraftChange('second explicit request');});
    await act(async()=>{composerProbe.current!.onSubmit();});
    expect(calls).toHaveLength(2);
  } finally {await act(async()=>{root.unmount();});removeContainer(container);vi.unstubAllGlobals();composerProbe.current=null;}
});
