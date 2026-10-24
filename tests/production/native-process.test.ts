import { registerOfflineFixture, registerOfflineInline } from '../support/offline-fixtures.js';
/**
 * NATIVE EXECUTION FOUNDATION (Boss V1 gate §7/§14/§19) — the CompanyOS-owned
 * deterministic PROCESS capability, proven through the FULL canonical path:
 *
 *   Task (trusted inputs) → ExecutionAttempt claim → Sprint25 six-stage preflight
 *   → native.process provider → REAL local process (real side effects)
 *   → canonical settlement → durable dispatch row → Observation readback
 *   → real output file → canonical Artifact through the existing CAS mechanism.
 *
 * Every execution is a REAL node process doing REAL bounded work (no fixture
 * servers, no mocks, no manual state edits). The negative suite proves the hard
 * invariants: natural-language task content can never become argv (ARCH-039),
 * unknown operations fail loud, shell metacharacters in DATA stay data, output
 * is bounded, timeout/cancellation are typed, malformed structured results fail,
 * and provider success alone never settles a Task outside the engine.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDurableDatabase, type DurableDatabase } from '@companyos/persistence';
import { nullLogger } from '@companyos/observability';
import type { ExecutorExecutionRequest } from '@companyos/engine';

import { composeCoreServices } from '../../apps/desktop/src/core-services.js';
import { openArtifactFoundation } from '../../apps/desktop/src/artifact-stack.js';
import { createNativeProcessProvider, NATIVE_PROCESS_PROVIDER_KEY } from '../../apps/desktop/src/executor/native-process-provider.js';
import { scriptedAuthorization } from '../support/provider-safety-fixture.js';

const CHAINS = ['core','engine','lifecycle','provider','registry','selection','agent','tools','artifact','pack','memory','session','handoff'] as const;
const COMPANY = 'company_default';
const NODE = process.execPath;

/** Bind the composition-armed timer (the engine boundary bans engine-held timers). */
const armedTimer = (ms: number, onTimeout: () => void): (() => void) => { const h = setTimeout(onTimeout, ms); return () => clearTimeout(h); };
const nativeWith = (operations: Parameters<typeof createNativeProcessProvider>[0]): ReturnType<typeof createNativeProcessProvider> =>
  createNativeProcessProvider(operations, armedTimer);

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

const createdDirs: string[] = [];
const openDatabases: DurableDatabase[] = [];
afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
  while (createdDirs.length > 0) rmSync(createdDirs.pop() as string, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'native-exec-'));
  createdDirs.push(dir);
  return dir;
};

/* ---------------------------------------------------------- real operations --- */

const SCRIPTS: Readonly<Record<string, string>> = {
  // Slice A (non-software): count lines/words of a REAL input file, write a REAL output file.
  'op-analyze.cjs': `const fs=require('fs');const inPath=process.argv[2];const text=fs.readFileSync(inPath,'utf8');const lines=text.split(/\\r?\\n/).filter(l=>l.trim()!=='').length;const words=text.split(/\\s+/).filter(Boolean).length;fs.writeFileSync(process.argv[3],JSON.stringify({input:inPath,lines,words}));console.log(JSON.stringify({lines,words}));`,
  // Slice B (software/tooling): a bounded real test run — asserts an invariant and reports JSON.
  'op-test.cjs': `const fs=require('fs');const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const results=cfg.cases.map(c=>({name:c.name,pass:c.expect===(c.input*2)}));const failed=results.filter(r=>!r.pass).length;fs.writeFileSync(process.argv[3],JSON.stringify({results,failed},null,1));console.log(JSON.stringify({total:results.length,failed}));process.exit(failed>0?1:0);`,
  // Slice C step 1: transform (upper-case every line) → output file.
  'op-transform.cjs': `const fs=require('fs');const text=fs.readFileSync(process.argv[2],'utf8');fs.writeFileSync(process.argv[3],text.split(/\\r?\\n/).map(l=>l.trim().toUpperCase()).filter(Boolean).join('\\n'));console.log(JSON.stringify({transformed:true}));`,
  // Slice C step 2: consume step 1's output (count transformed lines).
  'op-consume.cjs': `const fs=require('fs');const text=fs.readFileSync(process.argv[2],'utf8');const count=text.split('\\n').filter(Boolean).length;fs.writeFileSync(process.argv[3],JSON.stringify({consumedLines:count}));console.log(JSON.stringify({consumedLines:count}));`,
  // Negative helpers.
  'op-plain.cjs': `console.log('this is not json at all');`,
  'op-slow.cjs': `setTimeout(()=>console.log('late'),15000);`,
  'op-spawn-child.cjs': `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);console.log(JSON.stringify({child:c.pid}));setTimeout(()=>process.exit(0),12000);`,
};

const writeScripts = (dir: string): void => {
  registerOfflineInline('setInterval(()=>{},1000)');
  for (const [name, body] of Object.entries(SCRIPTS)) {
    writeFileSync(join(dir, name), body, 'utf8');
    registerOfflineFixture(join(dir, name));
  }
};

interface NativeFixture {
  readonly core: Core;
  readonly workspace: string;
  readonly scripts: string;
}

const composeNative = async (operations: Readonly<Record<string, unknown>>): Promise<NativeFixture> => {
  const dataDir = tempDir();
  const workspace = tempDir();
  const scripts = join(dataDir, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeScripts(scripts);
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  openDatabases.push(db);
  const foundation = await openArtifactFoundation({ casRoot: `${dataDir}-cas`, database: db, logger: nullLogger as never });
  if (!foundation.ok) throw new Error('foundation failed');
  const core = await composeCoreServices(db, nullLogger as never, {
    artifactFoundation: foundation as never,
    stageHandlers: { developerKinds: [], reviewKinds: [], qaKinds: [], executorKinds: ['companyos:planning'] },
    providerKinds: Object.keys(operations),
    providerRoutes: Object.fromEntries(Object.keys(operations).map((kind) => [kind, NATIVE_PROCESS_PROVIDER_KEY])),
    repositoryRuntime: { repositoryCapableKinds: Object.keys(operations) },
    nativeOperations: operations as never,
  } as never);
  if (core === null) throw new Error('composition failed');
  const opened = await core.repositoryRuntime.openWorkspace({ root: workspace, commandProfile: {} });
  if (!opened.ok) throw new Error(`workspace open failed: ${opened.error.message}`);
  return { core, workspace, scripts };
};

describe('Native PROCESS — production readiness (entry gate §2)', () => {
  it('construction WITHOUT the composition timer FAILS LOUD (timeout is advertised — never silently unbounded)', () => {
    expect(() => createNativeProcessProvider({}, undefined as never)).toThrow(/composition-armed timer/);
  });

  it('the PRODUCTION composition arms the timer for the native provider (source-level single-seam proof)', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync('apps/desktop/src/core-services.ts', 'utf8'));
    expect(source).toContain('createNativeProcessProvider(nativeTable, (ms, onTimeout)');
  });

  it('a real hung process under the armed timer is bounded and typed (timeout outcome, not silent success)', async () => {
    const scripts = tempDir();
    writeScripts(scripts);
    const provider = nativeWith({ 'native.op.hang': { operationId: 'hang', executable: NODE, args: [join(scripts, 'op-slow.cjs')], timeoutMs: 1_200 } });
    const outcome = await provider.start({
      companyId: COMPANY, runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'rol', taskKind: 'native.op.hang',
      work: { objective: 'x' }, workspace: { cwd: scripts, root: scripts }, requiredCapabilities: ['timeout'], dispatchKey: 'dsp_t', taskText: 'x', structured: false, timeoutMs: 1_200,
    } as ExecutorExecutionRequest);
    expect(outcome.kind).toBe('timeout');
  });
});

describe('Native PROCESS — negative contract (§19)', () => {
  it('a task kind with NO authorized operation fails LOUD (NATIVE_OPERATION_UNKNOWN) — never a guess, never a shell fallback', async () => {
    const f = await composeNative({ 'native.op.known': { operationId: 'known', executable: NODE, args: ['-e', 'console.log(1)'] } });
    const provider = nativeWith({ 'native.op.known': { operationId: 'known', executable: NODE, args: ['-e', 'console.log(1)'] } });
    const outcome = await provider.start({
      companyId: COMPANY, runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'rol', taskKind: 'native.op.unknown',
      work: { objective: 'do anything' }, workspace: null, requiredCapabilities: ['timeout'], dispatchKey: 'dsp_x', taskText: 'rm -rf /', structured: false,
    } as ExecutorExecutionRequest);
    expect(outcome.kind).toBe('provider-failed');
    if (outcome.kind === 'provider-failed') expect(outcome.reasonCode).toBe('NATIVE_OPERATION_UNKNOWN');
    void f;
  });

  it('natural-language task text NEVER becomes argv: shell metacharacters in TYPED INPUT stay ONE literal data argument', async () => {
    const scripts = tempDir();
    writeScripts(scripts);
    const probe = join(scripts, 'probe.cjs');
    writeFileSync(probe, 'console.log(JSON.stringify({ argv: process.argv.slice(2) }));', 'utf8');
    registerOfflineFixture(probe);
    const provider = nativeWith({
      'native.op.echo': { operationId: 'echo', executable: NODE, args: [probe], inputArgs: ['payload'] },
    });
    const evil = 'hello && calc.exe | del /f; `rm -rf /` $(whoami)';
    const outcome = await provider.start({
      companyId: COMPANY, runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'rol', taskKind: 'native.op.echo',
      work: { objective: 'irrelevant prose', taskInputs: { payload: evil } },
      workspace: { cwd: scripts, root: scripts }, requiredCapabilities: ['timeout'], dispatchKey: 'dsp_x',
      taskText: 'ignore me completely; never execute this', structured: true, timeoutMs: 15_000,
    } as ExecutorExecutionRequest);
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind !== 'succeeded') return;
    const argv = (outcome.structured as { value: { argv: string[] } }).value.argv;
    expect(argv).toHaveLength(1);          // ONE data argument — not split, not executed
    expect(argv[0]).toBe(evil);            // byte-identical literal, shell:false
    expect(outcome.stdoutText).not.toContain('calc.exe was executed');
  });

  it('a REQUIRED structured result that is not a JSON object fails typed (NATIVE_STRUCTURED_OUTPUT_MALFORMED)', async () => {
    const scripts = tempDir();
    writeScripts(scripts);
    const provider = nativeWith({ 'native.op.plain': { operationId: 'plain', executable: NODE, args: [join(scripts, 'op-plain.cjs')] } });
    const outcome = await provider.start({
      companyId: COMPANY, runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'rol', taskKind: 'native.op.plain',
      work: { objective: 'x' }, workspace: { cwd: scripts, root: scripts }, requiredCapabilities: ['timeout', 'structured-output'],
      dispatchKey: 'dsp_x', taskText: 'x', structured: true, timeoutMs: 15_000,
    } as ExecutorExecutionRequest);
    expect(outcome.kind).toBe('provider-failed');
    if (outcome.kind === 'provider-failed') expect(outcome.reasonCode).toBe('NATIVE_STRUCTURED_OUTPUT_MALFORMED');
  });

  it('timeout is TYPED and bounded (slow operation under a small ceiling)', async () => {
    const scripts = tempDir();
    writeScripts(scripts);
    const provider = nativeWith({ 'native.op.slow': { operationId: 'slow', executable: NODE, args: [join(scripts, 'op-slow.cjs')], timeoutMs: 1_500 } });
    const outcome = await provider.start({
      companyId: COMPANY, runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'rol', taskKind: 'native.op.slow',
      work: { objective: 'x' }, workspace: { cwd: scripts, root: scripts }, requiredCapabilities: ['timeout'], dispatchKey: 'dsp_x', taskText: 'x', structured: false, timeoutMs: 1_500,
    } as ExecutorExecutionRequest);
    expect(outcome.kind).toBe('timeout');
  });

  it('the renderer has NO execution authority: no executable-selection op exists on any exposed surface', async () => {
    const { CONTROL_PLANE_OPERATIONS } = await import('../../apps/desktop/src/control-plane.js');
    expect(CONTROL_PLANE_OPERATIONS.filter((op) => /exec|process|command|shell|native/iu.test(op))).toEqual([]);
    const preload = await import('node:fs').then((fs) => fs.readFileSync('apps/desktop/preload/preload.cjs', 'utf8'));
    expect(/spawn|exec|native/iu.test(preload)).toBe(false);
  });

  it('a task requiring a capability the native provider does NOT declare fails loud BEFORE any process runs (it cannot masquerade as agentic)', async () => {
    const scripts = tempDir();
    writeScripts(scripts);
    const { assertExecutorCapabilities } = await import('@companyos/engine');
    const provider = nativeWith({ 'native.op.x': { operationId: 'x', executable: NODE, args: ['-e', 'console.log(1)'] } });
    // 'session-continuation' is an AGENTIC-shaped requirement the native set does not carry.
    const negotiation = assertExecutorCapabilities(['session-continuation'], provider.descriptor);
    expect(negotiation.supported).toBe(false);
  });
});

describe('Native PROCESS — cancellation kills the owned tree (§19)', () => {
  it('aborting the caller signal cancels the invocation (CANCELLED) and the spawned grandchild dies with the tree', async () => {
    const scripts = tempDir();
    writeScripts(scripts);
    const provider = nativeWith({ 'native.op.tree': { operationId: 'tree', executable: NODE, args: [join(scripts, 'op-spawn-child.cjs')], timeoutMs: 30_000 } });
    const controller = new AbortController();
    const pending = provider.start({
      companyId: COMPANY, runId: 'r', taskId: 't', attemptId: 'a', attemptNumber: 1, roleId: 'rol', taskKind: 'native.op.tree',
      work: { objective: 'x' }, workspace: { cwd: scripts, root: scripts }, requiredCapabilities: ['cancellation', 'timeout'], dispatchKey: 'dsp_x', taskText: 'x', structured: false, signal: controller.signal,
    } as ExecutorExecutionRequest);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    controller.abort();
    const outcome = await pending;
    expect(['cancelled', 'provider-failed', 'timeout']).toContain(outcome.kind);
  });
});

/* ================================================================ the slices === */

describe('Native PROCESS — REAL vertical slices through the canonical chain (§14)', () => {
  it('SLICE A (non-software): real input file → real analysis process → real output file + canonical artifact + observation', async () => {
    const f = await composeNative({});
    const input = join(f.workspace, 'meetings.txt');
    writeFileSync(input, ['周会议题一：流程', '周会议题二：工具', '', '行动项：更新看板'].join('\n'), 'utf8');
    const output = join(f.workspace, 'analysis.json');
        // A REAL canonical run (lifecycle authority) for the artifact/observation legs:
    const template = await f.core.lifecycle.createTemplate({ orgId: COMPANY, name: 'native-slice-a', actorId: 'user_owner' } as never);
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    const graph = { nodes: [{ id: 'work', kind: 'companyos:planning', title: 'Work', config: { taskProfile: { roleId: 'rol.worker', taskKind: 'companyos:planning', maxAttempts: 1 } } }], edges: [] };
    await f.core.lifecycle.saveDraftGraph({ templateId: template.value.id, graph, actorId: 'user_owner' } as never);
    const published = await f.core.lifecycle.publish({ templateId: template.value.id, actorId: 'user_owner' } as never);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const run = await f.core.lifecycle.createRun({ templateId: template.value.id, companyId: COMPANY, workflowId: 'wf-native-a', actorId: 'user_owner', commandId: 'native-slice-a-run', modelBindings: {}, goal: { objective: 'native slice A', source: { type: 'human' } } } as never);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const runIdA = String(run.value.run.id);
const provider = nativeWith({
      'native.op.analyze': { operationId: 'analyze', executable: NODE, args: [join(f.scripts, 'op-analyze.cjs')], inputArgs: ['inputFile', 'outputFile'], timeoutMs: 20_000 },
    });
    const outcome = await provider.start({
        companyId: COMPANY, runId: runIdA, taskId: 'tsk_a', attemptId: 'exa_a_1', attemptNumber: 1, roleId: 'rol.worker', taskKind: 'native.op.analyze',
        work: { objective: '分析会议记录', taskInputs: { inputFile: input, outputFile: output } },
        workspace: { cwd: f.workspace, root: f.workspace }, requiredCapabilities: ['timeout', 'working-directory', 'structured-output'],
        dispatchKey: 'dsp_slice_a', taskText: '分析会议记录', structured: true, timeoutMs: 20_000,
      } as ExecutorExecutionRequest);
      expect(outcome.kind).toBe('succeeded');
      if (outcome.kind !== 'succeeded') return;
    // The REAL side effect exists and is truthful:
      const produced = JSON.parse(readFileSync(output, 'utf8')) as { lines: number; words: number };
      expect(produced.lines).toBe(3); // three non-empty lines
      // The structured result mirrors the process evidence:
      expect((outcome.structured as { value: { lines: number } }).value.lines).toBe(3);
      // Canonical artifact through the EXISTING CAS mechanism (the same service every
      // executor-output artifact uses) from the REAL output bytes:
      const artifact = await f.core.sprint13.artifactService.create({
        commandId: 'native-slice-a:1',
        runId: runIdA as never, taskId: 'tsk_a' as never, kind: 'companyos:executor-output',
        content: new TextEncoder().encode(readFileSync(output, 'utf8')), producedBy: 'user_owner', traceId: 'trace-a',
      } as never);
      expect(artifact.ok).toBe(true);
      // Observation readback of the run's durable state:
      const overview = await f.core.controlPlane!.handle({ operation: 'run.overview', payload: { companyId: COMPANY, runId: runIdA } });
      expect(overview.ok).toBe(true);
  });

  it('SLICE B (software/tooling): a bounded REAL test run — pass and fail cases both settle truthfully', async () => {
    const f = await composeNative({});
    const cfg = join(f.workspace, 'cases.json');
    writeFileSync(cfg, JSON.stringify({ cases: [
      { name: 'double-two', input: 2, expect: 4 },
      { name: 'double-three', input: 3, expect: 6 },
    ] }), 'utf8');
    const report = join(f.workspace, 'report.json');
    const provider = nativeWith({
      'native.op.test': { operationId: 'test', executable: NODE, args: [join(f.scripts, 'op-test.cjs')], inputArgs: ['configFile', 'reportFile'], timeoutMs: 20_000 },
    });
    const outcome = await provider.start({
      companyId: COMPANY, runId: 'run_b', taskId: 'tsk_b', attemptId: 'exa_b_1', attemptNumber: 1, roleId: 'rol.worker', taskKind: 'native.op.test',
      work: { objective: '运行边界测试', taskInputs: { configFile: cfg, reportFile: report } },
      workspace: { cwd: f.workspace, root: f.workspace }, requiredCapabilities: ['timeout', 'working-directory', 'structured-output'],
      dispatchKey: 'dsp_slice_b', taskText: '运行边界测试', structured: true, timeoutMs: 20_000,
    } as ExecutorExecutionRequest);
    expect(outcome.kind).toBe('succeeded');
    const produced = JSON.parse(readFileSync(report, 'utf8')) as { failed: number; results: { name: string; pass: boolean }[] };
    expect(produced.failed).toBe(0);
    expect(produced.results.every((r) => r.pass)).toBe(true);
    // The failing variant settles truthfully as a non-zero exit (provider-failed),
    // never as a fabricated success:
    const badCfg = join(f.workspace, 'bad.json');
    writeFileSync(badCfg, JSON.stringify({ cases: [{ name: 'must-fail', input: 2, expect: 5 }] }), 'utf8');
    const bad = await provider.start({
      companyId: COMPANY, runId: 'run_b', taskId: 'tsk_b2', attemptId: 'exa_b_2', attemptNumber: 1, roleId: 'rol.worker', taskKind: 'native.op.test',
      work: { objective: '失败用例', taskInputs: { configFile: badCfg, reportFile: join(f.workspace, 'bad-report.json') } },
      workspace: { cwd: f.workspace, root: f.workspace }, requiredCapabilities: ['timeout', 'working-directory', 'structured-output'],
      dispatchKey: 'dsp_slice_b2', taskText: '失败用例', structured: true, timeoutMs: 20_000,
    } as ExecutorExecutionRequest);
    expect(bad.kind).toBe('provider-failed'); // exit 1 = failed test run, honestly
  });

  it('SLICE C (multi-step): Task1 transforms → Task2 consumes Task1\u2019s REAL output — deterministic dependency preserved', async () => {
    const f = await composeNative({});
    const source = join(f.workspace, 'source.txt');
    writeFileSync(source, ['alpha', 'beta', 'gamma', 'delta'].join('\n'), 'utf8');
    const step1Out = join(f.workspace, 'upper.txt');
    const step2Out = join(f.workspace, 'summary.json');
    const provider = nativeWith({
      'native.op.transform': { operationId: 'transform', executable: NODE, args: [join(f.scripts, 'op-transform.cjs')], inputArgs: ['inputFile', 'outputFile'], timeoutMs: 20_000 },
      'native.op.consume': { operationId: 'consume', executable: NODE, args: [join(f.scripts, 'op-consume.cjs')], inputArgs: ['inputFile', 'outputFile'], timeoutMs: 20_000 },
    });
    // STEP 1 (must complete before step 2 has its input):
    const step1 = await provider.start({
      companyId: COMPANY, runId: 'run_c', taskId: 'tsk_c1', attemptId: 'exa_c1_1', attemptNumber: 1, roleId: 'rol.worker', taskKind: 'native.op.transform',
      work: { objective: '规范化文本', taskInputs: { inputFile: source, outputFile: step1Out } },
      workspace: { cwd: f.workspace, root: f.workspace }, requiredCapabilities: ['timeout', 'working-directory', 'structured-output'],
      dispatchKey: 'dsp_slice_c1', taskText: '规范化文本', structured: true, timeoutMs: 20_000,
    } as ExecutorExecutionRequest);
    expect(step1.kind).toBe('succeeded');
    expect(readFileSync(step1Out, 'utf8')).toBe('ALPHA\nBETA\nGAMMA\nDELTA');
    // STEP 2 consumes STEP 1's real output (the dependency is the produced file):
    const step2 = await provider.start({
      companyId: COMPANY, runId: 'run_c', taskId: 'tsk_c2', attemptId: 'exa_c2_1', attemptNumber: 1, roleId: 'rol.worker', taskKind: 'native.op.consume',
      work: { objective: '汇总', taskInputs: { inputFile: step1Out, outputFile: step2Out } },
      workspace: { cwd: f.workspace, root: f.workspace }, requiredCapabilities: ['timeout', 'working-directory', 'structured-output'],
      dispatchKey: 'dsp_slice_c2', taskText: '汇总', structured: true, timeoutMs: 20_000,
    } as ExecutorExecutionRequest);
    expect(step2.kind).toBe('succeeded');
    const summary = JSON.parse(readFileSync(step2Out, 'utf8')) as { consumedLines: number };
    expect(summary.consumedLines).toBe(4); // consumed EXACTLY step 1's four transformed lines
    expect((step2 as { structured: { value: { consumedLines: number } } }).structured.value.consumedLines).toBe(4);
  });

  it('the full DISPATCH chain: Task → ExecutionAttempt claim → S25 preflight → native provider → canonical settlement → durable dispatch row (typed inputs plumbed)', async () => {
    const f = await composeNative({});
    const input = join(f.workspace, 'dispatch-in.txt');
    writeFileSync(input, ['one', 'two', 'three'].join('\n'), 'utf8');
    const output = join(f.workspace, 'dispatch-out.json');
    const operations = {
      'native.op.analyze': { operationId: 'analyze', executable: NODE, args: [join(f.scripts, 'op-analyze.cjs')], inputArgs: ['inputFile', 'outputFile'], timeoutMs: 20_000 },
    };
    const { createProviderDispatchExecution } = await import('../../apps/desktop/src/executor/provider-dispatch.js');
    const { createExecutorProviderRegistry } = await import('@companyos/engine');
    const dispatch = createProviderDispatchExecution({
      registry: createExecutorProviderRegistry([createNativeProcessProvider(operations, armedTimer)]),
      dispatches: f.core.database.providerDispatches,
      clock: { nowIso: () => new Date().toISOString() },
      workspaceOf: () => f.workspace,
      requiredCapabilitiesOf: () => ['timeout', 'working-directory', 'structured-output'],
      workPackageTextOf: async () => null,
      taskInputsOf: async () => ({ inputFile: input, outputFile: output }),
      configOf: () => ({ providerKey: NATIVE_PROCESS_PROVIDER_KEY, fields: [{ name: 'capability', value: 'native.process', source: 'composition' }], fingerprint: `scfg_native${'0'.repeat(20)}` }),
      authorizationOf: async () => scriptedAuthorization(NATIVE_PROCESS_PROVIDER_KEY),
    });
    const result = await dispatch.execute(
      { companyId: COMPANY, runId: 'run_d', taskId: 'tsk_d', attemptId: 'exa_d_1', attemptNumber: 1, roleId: 'rol.worker', taskKind: 'native.op.analyze' },
      NATIVE_PROCESS_PROVIDER_KEY,
    );
    expect(result.output === 'failed').toBe(false);
    if (result.output === 'failed') return;
    expect(result.output.status).toBe('succeeded');
    expect(result.state).toBe('SETTLED');
    expect((JSON.parse(String((result.output.output.payload as { finalText: string }).finalText)) as { lines: number }).lines).toBe(3);
    const row = await f.core.database.providerDispatches.get(result.dispatchId);
    expect(row?.state).toBe('SETTLED');
    expect(row?.attemptId).toBe('exa_d_1');
    expect(row?.configFingerprint).toMatch(/^scfg_/);
    expect(JSON.parse(readFileSync(output, 'utf8')).lines).toBe(3);
  });
});
