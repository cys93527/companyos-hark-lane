import './support/mini-dom.js';
import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { LocalDraftControls } from '../src/local-draft-controls.js';
import { createLocalDraftStore } from '../src/local-draft-store.js';
import { ComposerView } from '../src/composer.js';
import { createSubmissionController, type SubmissionIntentRecord } from '../src/submission-intent.js';
import { createExecutionSafetyCoordinator } from '../../desktop/src/execution-safety-coordinator.js';
import type { DurableDatabase } from '@companyos/persistence';
import { createContainer, removeContainer, clickableWithText, dispatchMiniEvent, type MiniElement } from './support/mini-dom.js';

const memory = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
};
const workspace = 'F:\\isolated\\workspace';
let root: Root | null = null;
let container: MiniElement | null = null;
const render = async (element: ReturnType<typeof h>) => {
  if (container === null) { container = createContainer(); root = createRoot(container as unknown as Element); }
  await act(async () => { root?.render(element); });
  return container;
};
const close = async () => {
  await act(async () => { root?.unmount(); });
  if (container !== null) removeContainer(container);
  root = null; container = null;
};
const click = async (label: string) => {
  const target = clickableWithText(container!, label);
  expect(target).not.toBeNull();
  await act(async () => { dispatchMiniEvent(target!, 'click'); });
};
afterEach(async () => { await close(); vi.unstubAllGlobals(); });

describe('LOCAL_DRAFT bounded non-authoritative storage', () => {
  it('restores the exact text with a new store instance without creating an outbox', () => {
    const storage = memory(); createLocalDraftStore(storage).save('c', workspace, '创建 hello.txt');
    expect(createLocalDraftStore(storage).load('c', workspace)).toEqual({state:'LOCAL_DRAFT',companyId:'c',workspaceRoot:workspace,objective:'创建 hello.txt'});
    expect([...storage.data.keys()]).toHaveLength(1);
    expect([...storage.data.keys()][0]).toMatch(/^companyos.local-draft.v1:/);
    expect(storage.getItem('companyos.submission-intent.v1')).toBeNull();
  });
  it('isolates Workspace, company and profile storage', () => {
    const storage = memory(), store = createLocalDraftStore(storage);
    store.save('c', workspace, 'A'); store.save('c', workspace + '-other', 'B');
    expect(store.load('c', workspace)?.objective).toBe('A');
    expect(store.load('c', workspace + '-other')?.objective).toBe('B');
    expect(store.load('other', workspace)).toBeNull();
    expect(createLocalDraftStore(memory()).load('c', workspace)).toBeNull();
  });
  it('refuses malformed records and cross-scope substitution', () => {
    const storage = memory(), store = createLocalDraftStore(storage); store.save('c', workspace, 'A');
    const key = [...storage.data.keys()][0]!;
    storage.data.set(key, '{'); expect(() => store.load('c',workspace)).toThrow();
    storage.data.set(key, JSON.stringify({state:'LOCAL_DRAFT', companyId:'other', workspaceRoot:workspace, objective:'A'}));
    expect(() => store.load('c',workspace)).toThrow('LOCAL_DRAFT_RECORD_INVALID');
  });
  it('does not persist credential assignments or oversized input', () => {
    const storage = memory(), store = createLocalDraftStore(storage);
    for (const text of ['API_KEY=synthetic-test-only', 'Bearer synthetic-test-only', 'x'.repeat(2001)]) expect(() => store.save('c',workspace,text)).toThrow();
    expect(storage.data.size).toBe(0);
  });
  it('propagates unavailable storage and quota errors, never silently claiming save', () => {
    expect(() => createLocalDraftStore(null).save('c',workspace,'A')).toThrow();
    expect(() => createLocalDraftStore({getItem:()=>null,setItem:()=>{throw new Error('Quota');}}).save('c',workspace,'A')).toThrow('Quota');
  });
});

const harness = (submit = vi.fn(async () => {}), scope = workspace) => {
  function Harness() {
    const [text, setText] = useState('');
    return h('div', null,
      h('output', {'aria-label':'editor-value'}, text),
      h(LocalDraftControls, {companyId:'c',workspaceRoot:scope,objective:text,busy:false,onRestore:setText}),
      h(ComposerView, {draft:text,ready:true,busy:false,authority:{mode:'read-only',basis:'test',mutable:false},modelLabel:'offline',workspaceLabel:scope,pendingIntent:false,onDraftChange:setText,onSubmit:()=>{void submit();},onChangeWorkspace:()=>{},onOpenTools:()=>{},onOpenAuthority:()=>{},onOpenModel:()=>{},authorityOpen:false,modelOpen:false}));
  }
  return h(Harness);
};

describe('real React controls: save/restore and explicit submission are separate actions', () => {
  it('save and restore never call the submission handler; only the explicit button does', async () => {
    const storage = memory(), submit = vi.fn(async () => {}); vi.stubGlobal('localStorage',storage);
    createLocalDraftStore(storage).save('c',workspace,'hello'); await render(harness(submit));
    await click('保存草稿'); await click('恢复草稿'); expect(submit).not.toHaveBeenCalled();
    await click('提交并开始执行'); expect(submit).toHaveBeenCalledTimes(1);
  });
  it('unmount/remount restores saved editing text, but never submits on restart', async () => {
    const storage = memory(), submit = vi.fn(async () => {}); vi.stubGlobal('localStorage',storage);
    createLocalDraftStore(storage).save('c',workspace,'saved text');
    await render(harness(submit)); await click('保存草稿'); await close();
    await render(harness(submit)); expect(container?.textContent).toContain('saved text');
    expect(submit).not.toHaveBeenCalled();
  });
  it('switching Workspace clears previous editor content and loads only the target draft', async () => {
    const storage = memory(); vi.stubGlobal('localStorage',storage);
    const store = createLocalDraftStore(storage); store.save('c',workspace,'draft A'); store.save('c',workspace+'-B','draft B');
    let text = '';
    const restore = (s: string) => { text = s; };
    await render(h(LocalDraftControls,{companyId:'c',workspaceRoot:workspace,objective:'',busy:false,onRestore:restore})); expect(text).toBe('draft A');
    await render(h(LocalDraftControls,{companyId:'c',workspaceRoot:workspace+'-B',objective:text,busy:false,onRestore:restore})); expect(text).toBe('draft B');
    await render(h(LocalDraftControls,{companyId:'c',workspaceRoot:workspace+'-empty',objective:text,busy:false,onRestore:restore})); expect(text).toBe('');
  });
  it('failed saves display failure and cannot become submission', async () => {
    const submit = vi.fn(async () => {});
    vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{throw new Error('Quota');}});
    await render(harness(submit)); await click('保存草稿');
    expect(container?.textContent).toContain('保存失败'); expect(submit).not.toHaveBeenCalled();
  });
  it('unavailable storage can still render, reports errors, and does not submit', async () => {
    vi.stubGlobal('localStorage',undefined); const submit = vi.fn(async () => {});
    await render(harness(submit)); await click('保存草稿'); expect(container?.textContent).toContain('保存失败'); expect(submit).not.toHaveBeenCalled();
  });
  it('does not restore corrupt content into the editor', async () => {
    const storage = memory(); createLocalDraftStore(storage).save('c',workspace,'A'); storage.data.set([...storage.data.keys()][0]!,'broken');
    vi.stubGlobal('localStorage',storage); let text = 'previous';
    await render(h(LocalDraftControls,{companyId:'c',workspaceRoot:workspace,objective:'',busy:false,onRestore:(s)=>{text=s;}}));
    expect(text).toBe(''); expect(container?.textContent).toContain('读取草稿失败');
  });
  it('explicit submission retains the existing budget denial and never invokes a provider', async () => {
    const provider = vi.fn();
    const coordinator = createExecutionSafetyCoordinator({executionBudget:{}} as DurableDatabase,{policyId:'offline',maxCalls:4,maxTokens:32768,maxCostMicros:0,durationMs:180000},()=>0);
    let intent: SubmissionIntentRecord | null = null;
    const submit = vi.fn(async () => {
      try { await coordinator.prepareExecutor({runId:'offline',attemptId:'a',fallback:{providerId:'p',modelId:'m',maxTokens:10}}); provider(); return {runId:'unexpected'}; }
      catch (error) { expect(error).toMatchObject({code:'POLICY_DENIED',details:{reason:'GOAL_ADMISSION_BOUND_UNPROVEN'}}); return {error:'GOAL_ADMISSION_BOUND_UNPROVEN'}; }
    });
    const controller = createSubmissionController({store:{load:()=>intent,save:(v)=>{intent=v;}},submit,now:()=>'',newIntentId:()=> 'offline-intent'});
    const result = await controller.submitObjective('hello',workspace);
    expect(result.status).toBe('failed'); expect(submit).toHaveBeenCalledTimes(1); expect(provider).not.toHaveBeenCalled();
  });
  it('the actual App save path never sends a canonical Goal creation request', async () => {
    const storage = memory(); vi.stubGlobal('localStorage',storage);
    createLocalDraftStore(storage).save('company_default',workspace,'saved App objective');
    const controlPlaneRequest = vi.fn(async (r:{operation:string}) => r.operation==='home.summary' ? {ok:true,value:{companyId:'company_default',goals:[]}} : {ok:true,value:{pending:[]}});
    vi.stubGlobal('companyos',{appVersion:async()=> 'test',platformInfo:async()=>({platform:'win32',arch:'x64',electron:'test',node:'test',chrome:'test'}),databaseStatus:async()=>({path:'offline',journalMode:'wal',schemaVersion:1}),channels:()=>[],workflowRequest:async()=>({ok:true,value:[]}),controlPlaneRequest,workspaceCurrent:async()=>workspace,workspaceSelect:async()=>null,workspaceOpen:async()=>({ok:true,root:workspace}),workspaceSwitch:async()=>({ok:true,root:workspace})});
    await render(h(App)); await click('保存草稿');
    expect(createLocalDraftStore(storage).load('company_default',workspace)?.objective).toBe('saved App objective');
    expect(controlPlaneRequest.mock.calls.some(([r])=>r.operation==='goal.create'||r.operation==='goal.advance')).toBe(false);
    expect(storage.getItem('companyos.submission-intent.v1')).toBeNull();
  });
});
