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
  const scenario = [
    { tool_call: { name: 'write', arguments: { file_path: 'PLACEHOLDER', content: 'PONG' } } },
    { text: 'PONG' },
  ];
  const workspace = mkdtempSync(join(tmpdir(), 'companyos-kernel-pong-ws-'));
  scenario[0].tool_call.arguments.file_path = join(workspace, 'pong.txt');
  let calls = 0;
  const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return; }
    req.resume();
    req.on('end', () => {
      calls += 1;
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
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const stage = runtime.prepareAttemptStage({ attemptId: 'pong' });
    if (!stage.ok) return { ok: false, reason: 'STAGE', detail: stage.error.message };
    const route = { providerId: 'companyos-loopback', modelId: 'loopback-model', baseURL: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'COMPANYOS_LOOPBACK_KEY', apiKeyValue: 'loopback', contextWindow: 128000, maxTokens: 4096 };
    const home = stage.value.newDshHome({ attemptId: 'pong', workspaceRoot: workspace, route });
    if (!home.ok) return { ok: false, reason: 'HOME', detail: home.error.message };
    const env = { DSH_HOME: home.value.dshHome, HOME: home.value.dshHome, USERPROFILE: home.value.dshHome, APPDATA: join(home.value.dshHome, 'appdata'), COMPANYOS_LOOPBACK_KEY: 'loopback', NO_COLOR: '1' };
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT', 'ComSpec']) if (process.env[k]) env[k] = process.env[k];
    const node = stage.value.nodeExecutablePath ?? process.execPath;
    const out = await new Promise((resolvePromise) => {
      let stdout = ''; let stderr = '';
      const child = spawn(node, [stage.value.cliEntryPath, runtime.manifest.profileName, '--json', 'Write PONG into pong.txt in the workspace, then reply PONG.'], { cwd: workspace, env, windowsHide: true });
      const timer = setTimeout(() => child.kill(), 180_000);
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
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
    const ok = out.code === 0 && fileText === 'PONG' && finalLine !== null && finalLine.includes('PONG') && calls >= 2 && post.ok;
    return { ok, exitCode: out.code, modelCalls: calls, fileWritten: fileText, finalLine, postSpawnVerified: post.ok, stdoutTail: out.stdout.slice(-3000), stderrTail: out.stderr.slice(-3000), ...(out.code === 0 ? {} : { startupLog }) };
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
