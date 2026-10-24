/**
 * LIVE-SMOKE-FIX-08B — explicit-extension headless guard
 * (WINDOWS_HEADLESS_SCRIPT_ASSOCIATION_ESCAPE full closure) + inner tool
 * invocation durability (TIMEOUT_TOOL_INVOCATION_EVIDENCE_CLOSURE LEVEL B).
 *
 * FIX-08 closed the extensionless form (PATHEXT); the CONFIRMED residual was
 * `cmd /c path\\probe.js` — cmd.exe association-dispatches EXPLICIT-extension
 * paths regardless of PATHEXT (registry-only territory). 08B closes the normal
 * unattended path at the pwsh terminal seam: the rendered kernel patch loads a
 * CompanyOS-authored headless shell guard at shell startup (`-NoExit -File`),
 * which installs `cmd` / `cmd.exe` FUNCTIONS (PowerShell resolves functions
 * before applications) that reject WSH-associated scripts in the cmd /c|/k
 * COMMAND POSITION — `cmd /c node app.js` (explicit runtime + script argument)
 * passes; `cmd /c app.js` fails fast with actionable text. LEVEL B: every
 * kernel `tool_call` stdout line becomes a durable, redacted
 * `executor.tool_invocation_requested` event AT ARRIVAL.
 */

import {mkdtempSync, rmSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {openDurableDatabase, type DurableDatabase} from '@companyos/persistence';


import {dshToolCallTapOf} from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import {registerOfflineInline} from '../support/offline-fixtures.js';
import {createProcessExecutorProvider} from '@companyos/engine';

const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-fix08b-'));
  createdDirs.push(dir);
  return dir;
};

const EMBEDDED_ROOT = resolve(process.cwd(), '.companyos-embedded/dsh-runtime');
const GUARD_SCRIPT = join(EMBEDDED_ROOT, 'headless-shell-guard.ps1');
const PATCH_TEMPLATE = join(EMBEDDED_ROOT, 'profile-patch-template.yml');

describe('LIVE-SMOKE-FIX-08B — artifacts (materialized guard + patch template)', () => {
  it('the staged headless shell guard script exists and installs both cmd functions', () => {
    expect(existsSync(GUARD_SCRIPT)).toBe(true);
    const guard = readFileSync(GUARD_SCRIPT, 'utf8');
    expect(guard).toContain("New-Item -Path Function: -Name 'global:cmd'");
    expect(guard).toContain("New-Item -Path Function: -Name 'global:cmd.exe'");
    expect(guard).toContain("'.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh'");
  });

  it('the patch template configures the EXISTING terminal-pwsh row (top level, not a duplicate insert)', () => {
    const template = readFileSync(PATCH_TEMPLATE, 'utf8');
    expect(template).toContain('- id: terminal-pwsh');
    expect(template).toContain("'{{DSH_SHELL_GUARD}}'");
    // The guard entry is TOP LEVEL (column-0 `- id:`), not inside the insert list.
    const topLevel = /^- id: terminal-pwsh$/m.test(template);
    expect(topLevel).toBe(true);
  });

  it('the materialize SCRIPT (repo source of truth) authors the guard + top-level patch entry', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/materialize-embedded-dsh.mjs'), 'utf8');
    expect(script).toContain("join(target, 'headless-shell-guard.ps1')");
    expect(script).toContain('shellGuardScript:');
    expect(script).toContain("'{{DSH_SHELL_GUARD}}'");
  });
});

describe('LIVE-SMOKE-FIX-08B — LEVEL B inner tool invocation durability', () => {
  const CHAINS = ['core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent', 'tools', 'artifact', 'pack', 'memory', 'session', 'handoff'] as const;
  const openDatabases: DurableDatabase[] = [];
  afterEach(() => { while (openDatabases.length > 0) openDatabases.pop()?.close(); });

  it('the tap: kernel tool_call lines become redacted, attempt-linked events AT ARRIVAL (non-tool lines ignored)', async () => {
    const appended: {type: string; payload: Record<string, unknown>}[] = [];
    const secret = 'fix08b-levelb-marker-secret-77c1';
    let n = 0;
    const tap = dshToolCallTapOf(
      {
        append: async (events) => {
          for (const event of events as {type: string; payload: unknown}[]) {
            appended.push({type: event.type, payload: event.payload as Record<string, unknown>});
          }
        },
        secrets: () => [secret],
        ids: {id: () => `evt_fix08b_${String(n += 1).padStart(4, '0')}`, ulid: () => `evt_fix08b_${String(n).padStart(4, '0')}`},
        onFailure: () => undefined,
      },
      {attemptId: 'exa_fix08b_000000000000000000000001', taskId: 'tsk_fix08b', runId: 'run_fix08b', roleId: 'rol_fix08b', cwd: 'W:/ws'},
    );
    // The exact LEVEL B discrimination: node vs bare vs cmd-wrapped forms survive identifiably.
    tap('tool_call pwsh {"command":"node bin\\cli.js [1,2,3,4]"}');
    tap('tool_call pwsh {"command":"bin\\cli.js [1,2,3,4]"}');
    tap('tool_call pwsh {"command":"cmd /c bin\\cli.js [1,2,3,4] ' + secret + '"}');
    tap('tool_result call_00_x completed done'); // ignored
    tap('plain output line'); // ignored
    await new Promise((r) => setTimeout(r, 30));
    expect(appended).toHaveLength(3);
    expect(appended.map((e) => e.type)).toEqual(['executor.tool_invocation_requested', 'executor.tool_invocation_requested', 'executor.tool_invocation_requested']);
    expect(appended[0]!.payload['tool']).toBe('pwsh');
    expect(String(appended[0]!.payload['argsHead'])).toContain('node bin\\cli.js');
    expect(String(appended[1]!.payload['argsHead'])).toContain('bin\\cli.js');
    expect(String(appended[1]!.payload['argsHead'])).not.toContain('node');
    expect(String(appended[2]!.payload['argsHead'])).toContain('cmd /c bin\\cli.js');
    expect(appended.map((e) => e.payload['sequence'])).toEqual([1, 2, 3]);
    expect(JSON.stringify(appended)).not.toContain(secret);
    expect(JSON.stringify(appended)).toContain('[redacted]');
    expect(appended[0]!.payload['attemptId']).toBe('exa_fix08b_000000000000000000000001');
    expect(appended[0]!.payload['cwd']).toBe('W:/ws');
    expect(typeof appended[0]!.payload['argsSha256']).toBe('string');
  }, 15_000);

  it('process-executor tap delivery: lines stream to the tap BEFORE the child settles (pre-kill attribution ordering)', async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const marker = `TOOLCALL_BEFORE_KILL_${Date.now()}`;
    const code = `console.log(${JSON.stringify('tool_call pwsh {"command":"node bin\\cli.js"}')});console.log(${JSON.stringify(marker)});setInterval(()=>{},1000)`;
    registerOfflineInline(code);
    const provider = createProcessExecutorProvider({
      providerKey: 'fix08b.stream',
      capabilities: ['cancellation', 'timeout'],
      executable: process.execPath,
      baseArgv: ['-e', code],
      buildArgs: () => [],
      fallbackCwd: null,
      trustedRoot: process.cwd(),
      timer: (ms, onTimeout) => { const h = setTimeout(onTimeout, ms); return () => clearTimeout(h); },
      tapStdoutLine: (line) => { lines.push(line); },
    });
    const outcome = await provider.start({
      companyId: 'company_fixture', runId: 'run_fix08b', taskId: 'tsk_fix08b', attemptId: 'exa_fix08b_000000000000000000000002',
      attemptNumber: 1, roleId: 'rol_fix08b', taskKind: 'companyos:work',
      work: {objective: 'stream'},
      taskText: `echo tool_call pwsh {"command":"node bin\\cli.js"} && echo ${marker} && ping -n 20 127.0.0.1 > NUL`,
      dispatchKey: 'dsp_fix08b_stream_000000000000000001',
      requiredCapabilities: [],
      structured: false,
      workspace: {cwd: dir, root: dir},
      timeoutMs: 1200,
    });
    expect(outcome.kind).toBe('timeout');
    // The tool_call line was delivered to the tap WHILE the child was still running
    // (its output precedes the kill); the bounded stdout tail keeps it too.
    expect(lines.some((line) => line.includes('tool_call pwsh') && line.includes('bin\\cli.js'))).toBe(true);
    expect(lines.some((line) => line.includes(marker))).toBe(true);
    if (outcome.kind === 'timeout') {
      expect(outcome.stdoutText ?? '').toContain('tool_call pwsh');
    }
  }, 30_000);

  it('timeout + restart: the inner command evidence survives in the REAL event store (independent of PSReadLine/home/process)', async () => {
    const dataDir = tempDir();
    const db = openDurableDatabase({dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS]});
    openDatabases.push(db);
    let n = 0;
    const tap = dshToolCallTapOf(
      {
        append: async (events) => { await db.events.append(events as never); },
        secrets: () => [],
        ids: {id: () => `evt_fix08b_t_${String(n += 1).padStart(4, '0')}`, ulid: () => `evt_fix08b_t_${String(n).padStart(4, '0')}`},
        onFailure: () => undefined,
      },
      {attemptId: 'exa_fix08b_000000000000000000000003', taskId: 'tsk_fix08b', runId: 'run_fix08b', roleId: 'rol_fix08b', cwd: 'W:/ws'},
    );
    // Simulate the kernel stream of a timed-out attempt: the last tool_call is
    // delivered (its tool_result never arrives — the process was killed).
    tap('tool_call pwsh {"command":"node bin\\cli.js [1,2,3,4]"}');
    tap('tool_call pwsh {"command":"cmd /c bin\\cli.js [1,2,3,4]"}'); // <- the FINAL command, killed mid-flight
    await new Promise((r) => setTimeout(r, 50));
    db.close();
    openDatabases.pop();
    const reopened = openDurableDatabase({dataDir, appliedAt: 'reopen-fix08b', chains: [...CHAINS]});
    openDatabases.push(reopened);
    const rows = reopened.db.prepare("SELECT payload FROM events WHERE type = 'executor.tool_invocation_requested' ORDER BY rowid").all() as {payload: string}[];
    expect(rows).toHaveLength(2);
    const last = JSON.parse(rows[1]!.payload) as Record<string, unknown>;
    expect(String(last['argsHead'])).toContain('cmd /c bin\\cli.js');
    expect(last['sequence']).toBe(2);
    expect(last['attemptId']).toBe('exa_fix08b_000000000000000000000003');
  }, 20_000);
});
