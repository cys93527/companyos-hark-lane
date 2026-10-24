import {registerOfflineInline} from '../support/offline-fixtures.js';
/**
 * LIVE-SMOKE-FIX-08 — Windows headless script-association guard
 * (WINDOWS_HEADLESS_SCRIPT_ASSOCIATION_ESCAPE) + durable timeout tool-invocation
 * evidence (TIMEOUT_TOOL_INVOCATION_EVIDENCE_GAP).
 *
 * Smoke-07 live evidence: a WSH modal dialog for `workspace\bin\cli.js` during real
 * DSH work; the killed TIMEOUT attempts kept NO durable command evidence. Phase-B
 * reproduction (deterministic, dialog-free probe) CONFIRMED:
 *   - `cmd /c probe` (extensionless, default PATHEXT with .JS…) → WSH runs it;
 *   - `cmd /c probe.js` (explicit path) → WSH runs it EVEN with sanitized PATHEXT
 *     (cmd association-dispatches explicit non-executable paths; closing that form
 *     needs registry/IFEO/global-WSH — all out of bounds) — pinned here as the
 *     documented RESIDUAL;
 *   - PowerShell bare `.\probe.js` → fast shell failure, never WSH;
 *   - explicit `node probe.js` → works under every configuration.
 *
 * Closed contract: the DSH child environment carries a REFINED PATHEXT (WSH-hosted
 * extensions removed, everything else preserved; the host environment is never
 * touched); timeout outcomes keep the captured stdout tail; every provider dispatch
 * appends `executor.dispatch_requested` BEFORE launch and `executor.dispatch_settled`
 * after (redacted, correlated by attemptId/dispatchId) — evidence only, the
 * ExecutionAttempt row remains the canonical truth.
 */

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';
import {nullLogger} from '@companyos/observability';

import {createProcessExecutorProvider} from '@companyos/engine';
import {sanitizePathextForHeadlessChild} from '../../apps/desktop/src/executor/dsh-executor-provider.js';
const SANITIZED = '.COM;.EXE;.BAT;.CMD;.MSC';
const HOST_PATHEXT_LIVE = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-fix08-'));
  createdDirs.push(dir);
  return dir;
};

describe('LIVE-SMOKE-FIX-08 — headless PATHEXT guard (unit)', () => {
  it('removes exactly the WSH-hosted extensions and preserves everything else', () => {
    expect(sanitizePathextForHeadlessChild(HOST_PATHEXT_LIVE)).toBe(SANITIZED);
    expect(sanitizePathextForHeadlessChild('.COM;.EXE;.PY;.BAT')).toBe('.COM;.EXE;.PY;.BAT'); // custom entries preserved
    expect(sanitizePathextForHeadlessChild(undefined)).toBe('.COM;.EXE;.BAT;.CMD'); // fallback
    expect(sanitizePathextForHeadlessChild('  .JS ; .VBS ')).toBe('.COM;.EXE;.BAT;.CMD'); // nothing left → fallback
    expect(sanitizePathextForHeadlessChild('.js;.exe')).toBe('.exe'); // case-insensitive removal
  });
});

describe('LIVE-SMOKE-FIX-08 — durable dispatch evidence (timeout/kill attribution)', () => {
  const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
  const openDatabases: DurableDatabase[] = [];
  afterEach(() => { while (openDatabases.length > 0) openDatabases.pop()?.close(); });

  const longRunningEchoProvider = (secret = ''): {provider: ReturnType<typeof createProcessExecutorProvider>; marker: string} => {
    const marker = `FIX08_TIMEOUT_MARKER_${Date.now()}`;
    const code = `console.log(${JSON.stringify(marker + ' ' + secret)});setInterval(()=>{},1000)`;
    registerOfflineInline(code);
    const provider = createProcessExecutorProvider({
      providerKey: 'fix08.slow',
      capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics'],
      executable: process.execPath,
      baseArgv: ['-e', code],
      buildArgs: () => [],
      fallbackCwd: null,
      trustedRoot: process.cwd(),
      timer: (ms, onTimeout) => { const h = setTimeout(onTimeout, ms); return () => clearTimeout(h); },
    });
    return {provider, marker};
  };

  it('a TIMEOUT outcome carries the captured-so-far stdout tail (the killed attempt stays attributable)', async () => {
    const {provider, marker} = longRunningEchoProvider();
    const outcome = await provider.start({
      companyId: 'company_fixture', runId: 'run_f8', taskId: 'tsk_f8', attemptId: 'exa_f8_0000000000000000000000002',
      attemptNumber: 1, roleId: 'rol_f8', taskKind: 'companyos:work',
      work: {objective: 'slow'},
      taskText: `echo ${marker} && ping -n 30 127.0.0.1 > NUL`,
      dispatchKey: 'dsp_fix08_slow_00000000000000000001',
      requiredCapabilities: [],
      structured: false,
      workspace: {cwd: process.cwd(), root: process.cwd()},
      timeoutMs: 1500,
    });
    expect(outcome.kind).toBe('timeout');
    if (outcome.kind === 'timeout') {
      expect(outcome.stdoutText ?? '').toContain(marker); // pre-kill output survived
    }
  }, 20_000);

  it('requested/settled events persist through the REAL event store and survive restart; secrets are redacted', async () => {
    const dataDir = tempDir();
    const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    openDatabases.push(db);
    // A NON-credential-shaped marker value (>=6 chars): exercises value redaction without tripping the shipped-file credential scanner.
    const secret = 'fix08-evidence-redaction-marker-9f3a';
    const appended: {type: string; payload: Record<string, unknown>}[] = [];
    const {createProviderDispatchExecution} = await import('../../apps/desktop/src/executor/provider-dispatch.js');
    const {provider, marker} = longRunningEchoProvider(secret);
    void marker;
    const registry = {
      resolve: (key: string) => (key === 'fix08.slow' ? provider : null),
      register: () => undefined,
    } as never;
    const dispatch = createProviderDispatchExecution({
      registry,
      dispatches: db.providerDispatches,
      clock: {nowIso: () => new Date().toISOString()},
      attemptTimeoutMs: 1200,
      workspaceOf: () => process.cwd(),
      requiredCapabilitiesOf: () => [],
      workPackageTextOf: async () => `echo ${marker} ${secret} && ping -n 30 127.0.0.1 > NUL`,
      configOf: () => ({providerKey: 'fix08.slow', fields: [{name: 'profile', value: 'fix08', source: 'composition'}], fingerprint: 'scfg_fix08'}),
      authorizationOf: async () => ({present: true, source: 'composition-policy'}),
      dispatchAudit: {
        append: async (events) => {
          for (const event of events) {
            appended.push({type: event.type, payload: event.payload as Record<string, unknown>});
          }
          await db.events.append(events as never);
        },
        secrets: () => [secret],
        ids: {id: () => `evt_fix08_${String(appended.length).padStart(4, '0')}`, ulid: () => `evt_fix08_${String(appended.length).padStart(4, '0')}`},
      },
    });
    const request = {
      companyId: 'company_fixture', runId: 'run_f8', taskId: 'tsk_f8',
      attemptId: 'exa_f8_0000000000000000000000003', attemptNumber: 1,
      roleId: 'rol_f8', taskKind: 'companyos:work',
    };
    const result = await dispatch.execute(request, 'fix08.slow');
    // The provider TIMED OUT: the dispatch failed honestly, but the attribution survived.
    expect(result.output).toBe('failed');
    expect(result.state).toBe('UNCERTAIN');
    // REQUESTED event exists with the pre-launch attribution; SETTLED correlates it.
    expect(appended.map((e) => e.type)).toEqual(['executor.dispatch_requested', 'executor.dispatch_settled']);
    const requested = appended[0]!.payload;
    expect(requested['attemptId']).toBe(request.attemptId);
    expect(requested['providerKey']).toBe('fix08.slow');
    expect(typeof requested['taskTextSha256']).toBe('string');
    expect(String(requested['taskTextHead'])).toContain(marker);
    const settled = appended[1]!.payload;
    expect(settled['outcome']).toBe('timeout');
    expect(settled['attemptId']).toBe(request.attemptId);
    // Redaction: a secret planted in the command text never survives into evidence.
    expect(JSON.stringify(appended)).not.toContain(secret);
    expect(JSON.stringify(appended)).toContain('[redacted]');
    // Restart readback: a FRESH connection still reads BOTH events from the log.
    db.close();
    openDatabases.pop();
    const reopened = openDurableDatabase({dataDir, appliedAt: 'reopen-fix08', chains: [...CHAINS]});
    openDatabases.push(reopened);
    const rows = reopened.db.prepare("SELECT payload FROM events WHERE type LIKE 'executor.dispatch%' ORDER BY rowid").all() as {payload: string}[];
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0]!.payload).toContain(request.attemptId);
  }, 30_000);

  it('a launch-crashed provider keeps its REQUESTED evidence (pre-launch durability)', async () => {
    const {createProviderDispatchExecution} = await import('../../apps/desktop/src/executor/provider-dispatch.js');
    const appended: string[] = [];
    const crashing = {
      descriptor: {providerKey: 'fix08.crash', capabilities: ['cancellation', 'timeout']},
      async start(): Promise<never> { throw new Error('boom: launch failed'); },
    } as never;
    const dispatch = createProviderDispatchExecution({
      registry: {resolve: (key: string) => (key === 'fix08.crash' ? crashing : null), register: () => undefined} as never,
      dispatches: {
        claim: async () => ({ok: true, value: {dispatchId: 'pdi_fix08_crash_0000000000001', replayed: false}}),
        get: async () => null,
        byAttempt: async () => [],
        markUncertain: async () => ({ok: true, value: undefined}),
        publish: async () => ({ok: true, value: undefined}),
        recordInvocation: async () => ({ok: true, value: undefined}),
        settle: async () => ({ok: true, value: undefined}),
        recordConfigFingerprint: async () => ({ok: true, value: undefined}),
      } as never,
      clock: {nowIso: () => new Date().toISOString()},
      attemptTimeoutMs: 5000,
      workspaceOf: () => process.cwd(),
      requiredCapabilitiesOf: () => [],
      configOf: () => ({providerKey: 'fix08.crash', fields: [{name: 'profile', value: 'fix08', source: 'composition'}], fingerprint: 'scfg_fix08c'}),
      authorizationOf: async () => ({present: true, source: 'composition-policy'}),
      dispatchAudit: {
        append: async (events) => { appended.push(...events.map((e) => e.type)); },
        secrets: () => [],
        ids: {id: () => `evt_fix08c_${String(appended.length).padStart(4, '0')}`, ulid: () => `evt_fix08c_${String(appended.length).padStart(4, '0')}`},
      },
    });
    // The provider CRASHES at launch (throws): the dispatch propagates the crash —
    // but the REQUESTED event was durable BEFORE the launch and survives it.
    await expect(dispatch.execute({
      companyId: 'company_fixture', runId: 'run_f8', taskId: 'tsk_f8',
      attemptId: 'exa_f8_0000000000000000000000004', attemptNumber: 1,
      roleId: 'rol_f8', taskKind: 'companyos:work',
    }, 'fix08.crash')).rejects.toThrow('boom: launch failed');
    expect(appended[0]).toBe('executor.dispatch_requested');
  }, 20_000);
});
void nullLogger;
