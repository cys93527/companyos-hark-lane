#!/usr/bin/env node
/**
 * Hark lane H15 — run the PRODUCT first-start kernel health check against a packaged
 * kernel directory (requires the desktop dist: pnpm run build).
 * Usage: node scripts/hark/kernel-health-smoke.mjs <agent-kernel/<version> dir> [<state dir>] [<report.json>] [--pong]
 * Exit 0 only on HEALTHY (version readback == manifest, staged closure verified).
 * --pong: additionally run ONE real headless profile turn of the packaged kernel against a
 * loopback scripted OpenAI-compatible endpoint (zero credentials, zero network): the model
 * asks the kernel's fs tool to write pong.txt inside the workspace, then answers PONG.
 * Proves the shipped closure is sufficient for a real composition run (Distribution spec
 * §2 gate: headless start -> PONG -> clean exit), not only for --version.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const pong = process.argv.includes('--pong');
const [kernelDir, stateArg, reportPath] = positional;
if (!kernelDir) { console.error('usage: kernel-health-smoke.mjs <kernelDir> [stateDir] [report.json]'); process.exit(2); }
const { resolveEmbeddedDshRuntime } = await import(pathToFileURL(join(root, 'apps/desktop/dist/executor/embedded-dsh-runtime.js')).href);
const { checkEmbeddedKernelHealth } = await import(pathToFileURL(join(root, 'apps/desktop/dist/executor/kernel-health.js')).href);
const stateRoot = stateArg ?? mkdtempSync(join(tmpdir(), 'companyos-kernel-state-'));
const resolved = resolveEmbeddedDshRuntime({ managedRoot: kernelDir, stateRoot });
let report;
if (!resolved.ok) {
  report = { status: 'REFUSED', reasonCode: 'RESOLVE_FAILED', detail: resolved.error.message, reason: resolved.error.details };
} else {
  report = await checkEmbeddedKernelHealth(resolved.value, { timeoutMs: 60_000 });
  report = { ...report, layoutVersion: resolved.value.manifest.layoutVersion ?? null, closureFiles: Object.keys(resolved.value.closure.files).length, links: (resolved.value.closure.links ?? []).length };
}
const runPong = async (runtime) => {
  // H15c: on Windows the turn also drives the persistent pwsh terminal (the production
  // terminal-pwsh row with the headless shell guard) — hark-live-goal 40266877047 hung 300 s
  // in `Get-Location; Get-ChildItem`; the smoke must prove a pwsh command returns promptly.
  const withPwsh = process.platform === 'win32';
  const scenario = [
    ...(withPwsh ? [{ tool_call: { name: 'pwsh', arguments: { command: 'Get-Location; Write-Output PWSH-$((20+22))' } } }] : []),
    { tool_call: { name: 'write', arguments: { file_path: 'PLACEHOLDER', content: 'PONG' } } },
    { text: 'PONG' },
  ];
  const workspace = mkdtempSync(join(tmpdir(), 'companyos-kernel-pong-ws-'));
  scenario[withPwsh ? 1 : 0].tool_call.arguments.file_path = join(workspace, 'pong.txt');
  const exchangeTimes = [];
  const toolResults = [];
  let calls = 0;
  const requestBytes = [];
  const capFields = [];
  const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return; }
    const bodyChunks = [];
    req.on('data', (c) => bodyChunks.push(c));
    req.on('end', () => {
      calls += 1;
      exchangeTimes.push({ call: calls, requestAt: Date.now() });
      requestBytes.push(Buffer.concat(bodyChunks).length);
      try { const b = JSON.parse(Buffer.concat(bodyChunks).toString('utf8')); const msgs = Array.isArray(b.messages) ? b.messages : []; const tool = msgs.filter((m) => m && m.role === 'tool').pop(); if (tool !== undefined) toolResults.push(typeof tool.content === 'string' ? tool.content.slice(0, 6000) : JSON.stringify(tool.content).slice(0, 6000)); capFields.push({ max_tokens: b.max_tokens ?? null, max_completion_tokens: b.max_completion_tokens ?? null, store: b.store ?? null }); } catch { capFields.push(null); }
      if (process.env.KERNEL_PONG_DUMP) writeFileSync(`${process.env.KERNEL_PONG_DUMP}-${calls}.json`, Buffer.concat(bodyChunks));
      const step = scenario[Math.min(calls - 1, scenario.length - 1)];
      const id = `pong-${calls}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] });
      if (step.tool_call) {
        sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name: step.tool_call.name, arguments: JSON.stringify(step.tool_call.arguments) } }] } }] });
        sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: step.text } }] });
        sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } });
      }
      res.write('data: [DONE]\n\n');
      res.end();
      exchangeTimes[exchangeTimes.length - 1].respondedAt = Date.now();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const stage = runtime.prepareAttemptStage({ attemptId: 'pong' });
    if (!stage.ok) return { ok: false, reason: 'STAGE', detail: stage.error.message };
    const route = { providerId: 'companyos-loopback', modelId: 'loopback-model', baseURL: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'COMPANYOS_LOOPBACK_KEY', apiKeyValue: 'loopback', contextWindow: 128000, maxTokens: 4096,
      // H15c: render the DeepSeek wire compat exactly as a real DeepSeek route does (the kernel must parse it
      // and cap output with max_tokens) while every byte still goes to this local fake upstream.
      upstreamBaseURL: 'https://api.deepseek.com' };
    const home = stage.value.newDshHome({ attemptId: 'pong', workspaceRoot: workspace, route });
    if (!home.ok) return { ok: false, reason: 'HOME', detail: home.error.message };
    // Smoke-only: bound the pwsh terminal at 60 s (production 300 s) so a hung terminal still
    // returns its tool result (the kernel's own readiness verdict + viewport) as evidence.
    const shortened = [];
    if (withPwsh) {
      const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.ya?ml$/u.test(e.name)) { const t = readFileSync(f, 'utf8'); if (t.includes('timeoutMs: 300000')) { writeFileSync(f, t.replaceAll('timeoutMs: 300000', 'timeoutMs: 60000')); shortened.push(f); } } } };
      walk(home.value.dshHome);
    }
    const env = { DSH_HOME: home.value.dshHome, HOME: home.value.dshHome, USERPROFILE: home.value.dshHome, APPDATA: join(home.value.dshHome, 'appdata'), COMPANYOS_LOOPBACK_KEY: 'loopback', NO_COLOR: '1' };
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT', 'ComSpec']) if (process.env[k]) env[k] = process.env[k];
    const node = stage.value.nodeExecutablePath ?? process.execPath;
    // H15c diag: on win32 the kernel runs under the V8 inspector; if the pwsh tool has not
    // returned 90 s after the tool call, pause it (Debugger.pause) and record the JS stack plus
    // the kernel's process tree — a hung tool that also ignores its own 60 s terminal deadline
    // means the kernel's event loop itself is blocked (hark-installer 40276998749).
    const hangDiag = { inspector: null, pausedFrames: null, processTree: null, error: null };
    const captureHang = async (pid, wsUrl) => {
      try {
        const { execFileSync } = await import('node:child_process');
        hangDiag.processTree = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$all = Get-CimInstance Win32_Process; function walk($p, $d) { $all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { ('  ' * $d) + $_.ProcessId + ' ' + $_.Name + ' ' + $_.CommandLine; walk $_.ProcessId ($d + 1) } }; walk ${pid} 0`], { encoding: 'utf8', timeout: 30_000 }).slice(0, 8000);
      } catch (e) { hangDiag.processTree = `failed: ${String(e?.message ?? e)}`; }
      if (wsUrl === null) return;
      await new Promise((resolveWs) => {
        const ws = new WebSocket(wsUrl);
        const done = setTimeout(() => { try { ws.close(); } catch { /* */ } resolveWs(); }, 20_000);
        ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: 'Debugger.enable' })); ws.send(JSON.stringify({ id: 2, method: 'Debugger.pause' })); };
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data));
          if (msg.method === 'Debugger.paused') {
            hangDiag.pausedFrames = msg.params.callFrames.slice(0, 40).map((f) => `${f.functionName || '<anon>'} ${f.url}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`);
            ws.send(JSON.stringify({ id: 3, method: 'Debugger.resume' }));
            clearTimeout(done); setTimeout(() => { try { ws.close(); } catch { /* */ } resolveWs(); }, 500);
          }
        };
        ws.onerror = (e) => { hangDiag.error = `ws: ${String(e?.message ?? 'error')}`; };
      });
    };
    const out = await new Promise((resolvePromise) => {
      let stdout = ''; let stderr = '';
      const args = [...(withPwsh ? ['--inspect=127.0.0.1:0'] : []), stage.value.cliEntryPath, runtime.manifest.profileName, '--json', 'Write PONG into pong.txt in the workspace, then reply PONG.'];
      const child = spawn(node, args, { cwd: workspace, env, windowsHide: true });
      const timer = setTimeout(() => child.kill(), withPwsh ? 300_000 : 180_000);
      let diagTimer = null;
      child.stdout.on('data', (c) => {
        stdout += c;
        if (withPwsh && diagTimer === null && stdout.includes('"type":"tool_call"')) {
          diagTimer = setTimeout(() => { if (exchangeTimes.length < 2) void captureHang(child.pid, hangDiag.inspector); }, 90_000);
        }
      });
      child.stderr.on('data', (c) => { stderr += c; const m = /Debugger listening on (ws:\/\/\S+)/u.exec(stderr); if (m && hangDiag.inspector === null) hangDiag.inspector = m[1]; });
      child.on('close', (code) => { clearTimeout(timer); if (diagTimer) clearTimeout(diagTimer); resolvePromise({ code, stdout, stderr }); });
      child.on('error', (e) => { clearTimeout(timer); resolvePromise({ code: -1, stdout, stderr: String(e) }); });
    });
    let startupLog = '';
    try {
      const logDir = join(home.value.dshHome, 'logs');
      if (existsSync(logDir)) for (const name of readdirSync(logDir)) startupLog += `--- ${name}\n${readFileSync(join(logDir, name), 'utf8').slice(-6000)}\n`;
    } catch { /* diagnostics only */ }
    home.value.dispose();
    const fileText = existsSync(join(workspace, 'pong.txt')) ? readFileSync(join(workspace, 'pong.txt'), 'utf8') : null;
    const finalLine = out.stdout.split(/\r?\n/u).filter((l) => l.includes('"type":"final"') || l.includes('"type": "final"')).pop() ?? null;
    const post = stage.value.verifyStaged();
    // pwsh tool latency = gap between the model's pwsh tool_call response and the next model request.
    const pwshToolMs = withPwsh && exchangeTimes.length >= 2 && exchangeTimes[0].respondedAt !== undefined ? exchangeTimes[1].requestAt - exchangeTimes[0].respondedAt : null;
    const pwshResult = withPwsh ? (out.stdout.split(/\r?\n/u).find((l) => l.includes('PWSH-42')) ?? null) : null;
    const pwshOk = !withPwsh || (pwshToolMs !== null && pwshToolMs <= 90_000 && pwshResult !== null);
    const ok = pwshOk && out.code === 0 && fileText === 'PONG' && finalLine !== null && finalLine.includes('PONG') && calls >= (withPwsh ? 3 : 2) && post.ok
      && capFields.length >= 1 && capFields.every((c) => c !== null && c.max_tokens === 4096 && c.max_completion_tokens === null && c.store === null);
    return { ok, ...(withPwsh ? { pwsh: { ok: pwshOk, toolMs: pwshToolMs, resultLine: pwshResult === null ? null : pwshResult.slice(0, 600), terminalTimeoutShortenedIn: shortened, toolResults, hangDiag } } : {}), exitCode: out.code, modelCalls: calls, requestBytes, capFields, fileWritten: fileText, finalLine, postSpawnVerified: post.ok, stdoutTail: out.stdout.slice(-3000), stderrTail: out.stderr.slice(-3000), ...(out.code === 0 && pwshOk ? {} : { startupLog }) };
  } finally {
    server.close();
  }
};
if (pong && report.status === 'HEALTHY') {
  report = { ...report, pong: await runPong(resolved.value) };
  if (!report.pong.ok) report = { ...report, status: 'REFUSED', reasonCode: 'KERNEL_PONG_FAILED' };
}
const text = JSON.stringify(report, null, 2);
console.log(text);
if (reportPath) writeFileSync(reportPath, text + '\n');
process.exit(report.status === 'HEALTHY' ? 0 : 1);
