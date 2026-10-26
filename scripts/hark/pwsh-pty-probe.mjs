#!/usr/bin/env node
/**
 * Hark lane H15c — raw evidence for the embedded kernel's persistent pwsh terminal on a
 * real Windows host (hark-live-goal 40266877047: `Get-Location; Get-ChildItem` ran into
 * the 300 s terminal timeout). Spawns pwsh through the SHIPPED kernel's own node-pty
 * (resolved from the verified attempt stage, exactly the module the kernel loads) with
 *   (a) the production argv (-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File <guard>)
 *   (b) the upstream default argv (-NoLogo -NoProfile)
 * writes the kernel's own startup bootstrap (UTF-8 preamble + prompt function emitting
 * OSC 133;D + BEL then 'dsh> '), then one command, and records whether the readiness
 * marker and the printable prompt ever reach the PTY reader. Diagnostic only: exit 0
 * always; the report is evidence (no network, no credentials).
 * Usage: node scripts/hark/pwsh-pty-probe.mjs <agent-kernel/<version> dir> <report.json>
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [kernelDir, reportPath] = process.argv.slice(2);
if (!kernelDir || !reportPath) { console.error('usage: pwsh-pty-probe.mjs <kernelDir> <report.json>'); process.exit(2); }
const report = { platform: process.platform, release: null, cases: [] };
const done = () => { writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.race?.variants?.map((v) => ({ name: v.name, ready: v.ready, of: report.race.iterations })) ?? null)); console.log(JSON.stringify(report.cases.map((c) => ({ name: c.name, markerSeen: c.markerSeen, promptSeen: c.promptSeen, commandEchoed: c.commandOutputSeen, error: c.error ?? null })))); process.exit(0); };
try {
  const os = await import('node:os');
  report.release = os.release();
  const { resolveEmbeddedDshRuntime } = await import(pathToFileURL(join(root, 'apps/desktop/dist/executor/embedded-dsh-runtime.js')).href);
  const resolved = resolveEmbeddedDshRuntime({ managedRoot: kernelDir, stateRoot: mkdtempSync(join(tmpdir(), 'companyos-pty-probe-state-')) });
  if (!resolved.ok) { report.error = resolved.error.message; done(); }
  const stage = resolved.value.prepareAttemptStage({ attemptId: 'pty-probe' });
  if (!stage.ok) { report.error = stage.error.message; done(); }
  const runtimeRoot = join(stage.value.stageRoot, 'runtime');
  report.runtimeRoot = runtimeRoot;
  const req = createRequire(join(runtimeRoot, 'packages', 'subprocess', 'subprocess-local', 'package.json'));
  let pty;
  try { pty = req('node-pty'); report.nodePty = req('node-pty/package.json').version; } catch (e) { report.error = `node-pty: ${String(e?.message ?? e)}`; done(); }
  const guard = join(stage.value.stageRoot, 'headless-shell-guard.ps1');
  report.guard = guard;
  const ESC = '\u001b';
  const preamble = '[Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8; ';
  const promptSetup = "function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); 'dsh> ' }";
  const ws = mkdtempSync(join(tmpdir(), 'companyos-pty-probe-ws-'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cases = [
    { name: 'production-guard', args: ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', (guard ?? '').split('\\').join('/')] },
    { name: 'upstream-default', args: ['-NoLogo', '-NoProfile'] },
  ];
  // (c)/(d) the kernel's workspace-write confinement: on win32 the terminal argv is wrapped by
  // the windows-acl runner ([node, runner.js, --workspace, --temp, --mode, --, argv...]) and the
  // shell runs under the WRITE_RESTRICTED Low-integrity token (sandbox-local windowsAclRunnerInvocation).
  const runnerJs = join(runtimeRoot, 'packages', 'sandbox', 'sandbox-windows-acl', 'lib', 'runner.js');
  const nodeExe = stage.value.nodeExecutablePath ?? process.execPath;
  const tempRoot = mkdtempSync(join(tmpdir(), 'companyos-pty-probe-temp-'));
  report.runner = { runnerJs, nodeExe };
  const wrap = (argv) => ({ file: nodeExe, args: [runnerJs, '--workspace', ws, '--temp', tempRoot, '--mode', 'workspace-write', '--', ...argv] });
  cases.push({ name: 'runner-cmd-echo', ...wrap([join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'cmd.exe'), '/c', 'echo RUNNER-OK']) });
  cases.push({ name: 'runner-pwsh-production', ...wrap(['pwsh.exe', ...cases[0].args]) });
  cases.push({ name: 'runner-pwsh-default', ...wrap(['pwsh.exe', '-NoLogo', '-NoProfile']) });
  for (const c of cases) {
    const rec = { name: c.name, file: c.file ?? 'pwsh.exe', args: c.args, timeline: [], markerSeen: false, promptSeen: false, commandOutputSeen: false };
    let out = '';
    const t0 = Date.now();
    try {
      const p = pty.spawn(c.file ?? 'pwsh.exe', c.args, { name: 'xterm-256color', cols: 160, rows: 40, cwd: ws, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } });
      p.onData((d) => { out += d; rec.timeline.push({ ms: Date.now() - t0, bytes: d.length }); });
      let exited = null;
      p.onExit((e) => { exited = e; });
      await sleep(4000);
      rec.beforeSetup = JSON.stringify(out.slice(-1500));
      p.write(`${preamble}${promptSetup}\r`);
      await sleep(5000);
      rec.afterSetup = JSON.stringify(out.slice(-2000));
      rec.markerAfterSetup = out.includes(`${ESC}]133;D;`);
      p.write('Get-Location; Write-Output PROBE-$((1+1))\r');
      await sleep(6000);
      rec.markerSeen = out.includes(`${ESC}]133;D;`);
      rec.promptSeen = out.includes('dsh> ');
      rec.commandOutputSeen = out.includes('PROBE-2');
      rec.osc133Count = out.split(`${ESC}]133;D;`).length - 1;
      rec.tail = JSON.stringify(out.slice(-3000));
      rec.exited = exited;
      try { p.kill(); } catch (e) { rec.killError = String(e); }
    } catch (e) {
      rec.error = String(e?.stack ?? e);
    }
    report.cases.push(rec);
  }
  // H15c race evidence: the kernel writes its bootstrap IMMEDIATELY after spawn (not after a
  // 4 s settle like the cases above) and judges readiness by the printable text after the LAST
  // OSC 133;D marker being exactly 'dsh> ' (terminal-bash sanitizer). Repeat that startup under
  // the production confinement with (a) the guard WITHOUT the H15c ordered prompt and (b) the
  // shipped guard, and count how often readiness is reachable.
  const { readFileSync, writeFileSync: writeGuard } = await import('node:fs');
  const shipped = readFileSync(guard, 'utf8');
  const cut = shipped.indexOf('# H15c: readiness-ordered prompt');
  const legacyGuard = join(tempRoot, 'guard-legacy.ps1');
  writeGuard(legacyGuard, cut >= 0 ? shipped.slice(0, cut) : shipped);
  report.race = { shippedHasOrderedPrompt: cut >= 0, iterations: 12, variants: [] };
  const E = String.fromCharCode(27); const BEL = String.fromCharCode(7);
  const OSC_RE = new RegExp(`${E}\\][^${BEL}${E}]*(?:${BEL}|${E}\\\\)`, 'gu');
  const CSI_RE = new RegExp(`${E}\\[[0-?]*[ -/]*[@-~]`, 'gu');
  const ESC2_RE = new RegExp(`${E}.`, 'gu');
  const strip = (t) => t.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC2_RE, '').replace(/\r/gu, '');
  const kernelReady = (t) => { const i = t.lastIndexOf(`${ESC}]133;D;`); if (i < 0) return false; const after = t.slice(t.indexOf('\u0007', i) + 1); return strip(after) === 'dsh> '; };
  const { spawnSync } = await import('node:child_process');
  for (const v of [{ name: 'legacy-guard', file: legacyGuard }, { name: 'shipped-guard', file: guard }]) {
    const rv = { name: v.name, ready: 0, runs: [] };
    for (let i = 0; i < report.race.iterations; i += 1) {
      const run = { readyMs: null, promptType: null, markers: 0, killMs: null, survivors: null, tailOnFail: null };
      let out = ''; let lastData = Date.now(); const t0 = Date.now();
      try {
        const w = wrap(['pwsh.exe', '-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', v.file.split('\\').join('/')]);
        const p = pty.spawn(w.file, w.args, { name: 'xterm-256color', cols: 160, rows: 40, cwd: ws, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } });
        p.onData((d) => { out += d; lastData = Date.now(); });
        p.write(`${preamble}${promptSetup}\r`);
        while (Date.now() - t0 < 15_000) {
          await sleep(50);
          if (kernelReady(out) && Date.now() - lastData >= 200) { run.readyMs = Date.now() - t0; break; }
        }
        run.markers = out.split(`${ESC}]133;D;`).length - 1;
        if (run.readyMs !== null) {
          rv.ready += 1;
          const mark = out.length;
          p.write('Write-Output ("PCT=" + (Get-Command prompt).CommandType)\r');
          await sleep(2500);
          const m = /PCT=(\w+)/u.exec(strip(out.slice(mark)).replace(/PCT=" \+/gu, ''));
          run.promptType = m ? m[1] : null;
        } else {
          run.tailOnFail = JSON.stringify(out.slice(-1200));
        }
        const k0 = Date.now();
        spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 });
        run.killMs = Date.now() - k0;
        await sleep(500);
        const list = spawnSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${v.file.split('\\').pop()}*' -and $_.Name -eq 'pwsh.exe' }).Count`], { encoding: 'utf8', timeout: 30_000 });
        run.survivors = Number.parseInt(String(list.stdout).trim(), 10);
      } catch (e) { run.error = String(e?.stack ?? e); }
      rv.runs.push(run);
    }
    report.race.variants.push(rv);
  }
} catch (e) {
  report.error = String(e?.stack ?? e);
}
done();
