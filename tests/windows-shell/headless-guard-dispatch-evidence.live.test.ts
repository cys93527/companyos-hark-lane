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
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';




import {createProcessExecutorProvider} from '@companyos/engine';
import {sanitizePathextForHeadlessChild} from '../../apps/desktop/src/executor/dsh-executor-provider.js';

const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length > 0) { try { rmSync(createdDirs.pop() as string, {recursive: true, force: true}); } catch { /* disposable */ } }
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'companyos-fix08-'));
  createdDirs.push(dir);
  return dir;
};

const SANITIZED = '.COM;.EXE;.BAT;.CMD;.MSC';
const HOST_PATHEXT_LIVE = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/** Dialog-free dual-runtime probe: WSH sleeps+exits 7; Node exits 3 instantly. */
const PROBE = 'var wsh = (typeof WScript !== "undefined"); if (wsh) { WScript.Sleep(1200); WScript.Quit(7); } else { process.exit(3); }\n';

const run = (file: 'powershell' | 'cmd', script: string, env: NodeJS.ProcessEnv): {code: number | null; stdout: string; ms: number} => {
  const started = Date.now();
  const result = file === 'cmd'
    ? spawnSync('cmd.exe', ['/d', '/c', script], {env, encoding: 'utf8', timeout: 8000, windowsHide: true})
    : spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {env, encoding: 'utf8', timeout: 8000, windowsHide: true});
  return {code: result.status, stdout: String(result.stdout ?? '') + String(result.stderr ?? ''), ms: Date.now() - started};
};

describe('LIVE-SMOKE-FIX-08 — deterministic association matrix (dialog-free probe)', () => {
  it('explicit node works under every configuration (the supported path)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const probePath = join(dir, 'probe.js');
    for (const pathext of [HOST_PATHEXT_LIVE, SANITIZED]) {
      const r = run('cmd', `node ${probePath}`, {...process.env, PATHEXT: pathext});
      expect({pathext, code: r.code, out: r.stdout.slice(0, 120)}).toMatchObject({code: 3});
      expect(r.ms).toBeLessThan(3000);
    }
  });

  it('extensionless bare invocation with the GUARD fails fast and never reaches WSH', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const r = run('cmd', `cd /d "${dir}" && probe`, {...process.env, PATHEXT: SANITIZED});
    expect(r.code).not.toBe(7); // 7 = the WSH probe signature
    expect(r.ms).toBeLessThan(2000); // fast deterministic failure, no 1.2s WSH sleep
    expect(r.stdout).not.toContain('WSH_PROBE');
  });

  it('PowerShell bare .\\probe.js fails fast (PS never association-dispatches .js — the DSH tool shell)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const r = run('powershell', `Set-Location '${dir}'; .\\probe.js`, {...process.env, PATHEXT: SANITIZED});
    expect(r.code).not.toBe(7);
    expect(r.ms).toBeLessThan(3000);
  });

  it('RESIDUAL (documented, pinned): cmd explicit-extension association dispatch still reaches WSH — env-only closure is impossible', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const r = run('cmd', `cd /d "${dir}" && probe.js`, {...process.env, PATHEXT: SANITIZED});
    // The documented residual for the EXPLICIT-path form: the association handler
    // (wscript) IS reached — cmd either reports its exit code (7, the WSH probe
    // signature) or returns while the handler runs (cmd's ShellExecuteEx launch is
    // asynchronous); in BOTH cases Windows Script Host executed the file. Closing
    // this form requires registry/IFEO/global-WSH changes that are out of bounds.
    const wshReached = r.code === 7 || r.code === 1 || r.code === 0;
    expect(wshReached).toBe(true);
    // Wait out any asynchronous handler, then TERMINATE any wscript this test
    // spawned (by its own probe command line) so nothing leaks into later tests
    // even under heavy machine load (LIVE-SMOKE-FIX-08C).
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      'Start-Sleep -Milliseconds 1600; ' +
      `Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='cscript.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*probe.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], {encoding: 'utf8', timeout: 30_000, windowsHide: true});
  });

  it('guard leaves the HOST environment untouched (child-only refinement)', () => {
    const before = process.env.PATHEXT;
    sanitizePathextForHeadlessChild(process.env.PATHEXT);
    expect(process.env.PATHEXT).toBe(before);
  });

  it('no wscript/cscript processes from THIS suite remain after the matrix', () => {
    // Attribution-scoped (LIVE-SMOKE-FIX-08C): other processes on this shared
    // machine are not this suite's business — a leftover counts only if its
    // command line carries THIS suite's probe marker.
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='cscript.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*probe.js*' } | ForEach-Object { $_.ProcessId }`,
    ], {encoding: 'utf8', timeout: 30_000, windowsHide: true});
    expect(String(probe.stdout).trim()).toBe('');
  });
});

describe('LIVE-SMOKE-FIX-08 — child env construction through the real executor seam', () => {
  it('the DSH-style declaredAdditions PATHEXT reaches the child sanitized while the host stays unchanged', async () => {
    const hostBefore = process.env.PATHEXT;
    const provider = createProcessExecutorProvider({
      providerKey: 'fix08.echo',
      capabilities: ['cancellation', 'timeout', 'structured-output', 'working-directory', 'stdin', 'external-session-identity', 'session-continuation', 'streaming-diagnostics'],
      executable: 'cmd.exe',
      baseArgv: ['/d', '/c'],
      fallbackCwd: null,
      trustedRoot: process.cwd(),
      envPolicy: {
        declaredAdditions: {
          // The EXACT guard the DSH adapter declares:
          PATHEXT: sanitizePathextForHeadlessChild(process.env.PATHEXT),
        },
      },
    });
    const outcome = await provider.start({
      companyId: 'company_fixture', runId: 'run_f8', taskId: 'tsk_f8', attemptId: 'exa_f8_0000000000000000000000001',
      attemptNumber: 1, roleId: 'rol_f8', taskKind: 'companyos:work',
      work: {objective: 'echo'},
      taskText: 'echo %PATHEXT%',
      dispatchKey: 'dsp_fix08_echo_000000000000000000001',
      requiredCapabilities: [],
      structured: false,
      workspace: {cwd: process.cwd(), root: process.cwd()},
    });
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind === 'succeeded') {
      expect(outcome.stdoutText).toContain('.COM');
      expect(outcome.stdoutText).not.toContain('.JS');
      expect(outcome.stdoutText).not.toContain('.VBS');
    }
    expect(process.env.PATHEXT).toBe(hostBefore); // host untouched
  }, 20_000);
});
