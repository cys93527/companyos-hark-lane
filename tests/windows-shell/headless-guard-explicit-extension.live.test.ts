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
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';






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


/** Dialog-free dual-runtime probe: WSH sleeps+exits 7; Node exits 3 instantly. */
const PROBE = 'var wsh = (typeof WScript !== "undefined"); if (wsh) { WScript.Sleep(1200); WScript.Quit(7); } else { process.exit(3); }\n';

interface ShellOutcome { readonly code: number | null; readonly out: string; readonly err: string; readonly ms: number }

/**
 * Drive ONE command through the EXACT production shell shape: a persistent
 * PowerShell session booted with the guard (`-NoLogo -NoProfile -NoExit
 * -ExecutionPolicy Bypass -File <guard>`), the command submitted via
 * Invoke-Expression — mirroring the kernel's persistent-pwsh wrapper.
 */
const runInGuardedPwsh = (cwd: string, command: string): Promise<ShellOutcome> =>
  new Promise((resolvePromise) => {
    const started = Date.now();
    const child: ChildProcess = spawn('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', GUARD_SCRIPT],
      {cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    let out = ''; let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolvePromise({code, out, err, ms: Date.now() - started});
    };
    child.on('close', (code: number | null) => finish(code));
    setTimeout(() => { child.stdin?.write(`${command}\n`); }, 500);
    setTimeout(() => { child.stdin?.write("Write-Output ('EXITCODE=' + $LASTEXITCODE)\n"); }, 1500);
    setTimeout(() => { child.stdin?.write('exit\n'); }, 2400);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish(-1); }, 12_000);
  });

describe('LIVE-SMOKE-FIX-08B — explicit-extension guard through the production shell shape', () => {
  it('A: node workspace\\probe.js — explicit runtime PASS', {timeout: 20_000}, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const r = await runInGuardedPwsh(dir, 'node probe.js');
    expect(r.out).toContain('EXITCODE=3');
    expect(r.err).not.toContain('refusing');
  });

  it('B: bare probe.js in PowerShell — no WSH, fast fail', {timeout: 20_000}, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const r = await runInGuardedPwsh(dir, '.\\probe.js');
    expect(r.out).not.toContain('EXITCODE=7');
    expect(r.out).toContain('EXITCODE='); // the session itself stayed alive and reported
  });

  it('C: cmd /c probe.js — fast safe rejection, NO WSH, actionable text', {timeout: 20_000}, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const r = await runInGuardedPwsh(dir, 'cmd /c probe.js');
    expect(r.err).toContain('refusing WSH desktop-association dispatch');
    expect(r.err).toContain('explicit runtime required');
    expect(r.out).toContain('EXITCODE=1');
    expect(r.out).not.toContain('EXITCODE=7'); // the WSH probe never ran
    expect(r.ms).toBeLessThan(6000); // command-policy latency, not attempt-timeout latency
  });

  it('D: cmd.exe /c probe.js — the FUNCTION shadow intercepts the dotted name too', {timeout: 20_000}, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const r = await runInGuardedPwsh(dir, 'cmd.exe /c probe.js');
    expect(r.err).toContain('refusing WSH desktop-association dispatch');
    expect(r.out).not.toContain('EXITCODE=7');
  });

  it('E: cmd /c node probe.js — explicit runtime INSIDE cmd passes (runtime+script argument discrimination)', {timeout: 20_000}, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const r = await runInGuardedPwsh(dir, 'cmd /c node probe.js');
    expect(r.out).toContain('EXITCODE=3');
    expect(r.err).not.toContain('refusing');
  });

  it('F: ordinary cmd command + BAT/CMD compatibility', {timeout: 20_000}, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    writeFileSync(join(dir, 'thing.bat'), '@echo off\r\necho BAT-OK\r\nexit /b 0\r\n', 'utf8');
    const echo = await runInGuardedPwsh(dir, 'cmd /c echo hello-guard');
    expect(echo.out).toContain('hello-guard');
    expect(echo.err).not.toContain('refusing');
    const bat = await runInGuardedPwsh(dir, 'cmd /c thing.bat');
    expect(bat.out).toContain('BAT-OK');
  });

  it('G: case-insensitive script extension handling (PROBE.JS rejected)', {timeout: 20_000}, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'probe.js'), PROBE, 'utf8');
    const r = await runInGuardedPwsh(dir, 'cmd /c PROBE.JS');
    expect(r.err).toContain('refusing WSH desktop-association dispatch');
    expect(r.out).not.toContain('EXITCODE=7');
  });

  it('H: NO wscript/cscript processes and NO modal dialogs across the whole matrix', () => {
    const wsh = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq wscript.exe'], {encoding: 'utf8'});
    const csh = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq cscript.exe'], {encoding: 'utf8'});
    expect(/wscript\.exe\s+\d+/.test(String(wsh.stdout))).toBe(false);
    expect(/cscript\.exe\s+\d+/.test(String(csh.stdout))).toBe(false);
  });
});
