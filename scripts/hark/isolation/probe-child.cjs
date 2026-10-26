'use strict';
/**
 * H16 isolation probe — child side. Runs under the identity being probed (the runner user
 * for the control pass, the dedicated agent account for the isolated passes) and records
 * what that identity can reach. Never asserts; the orchestrator (probe.ps1) judges.
 * usage: node probe-child.cjs <spec.json>
 *   spec: { out, brokerPort, otherPort, reads: {name: path}, writes: {name: path}, children: bool }
 */
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { spawnSync } = require('node:child_process');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const result = { identity: process.env.USERNAME ?? null, pid: process.pid, net: {}, files: {}, children: {} };

const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve({ outcome: 'TIMEOUT' }), ms))]);
const tcp = (host, port) => withTimeout(new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.once('connect', () => { s.destroy(); resolve({ outcome: 'REACHED' }); });
  s.once('error', (e) => resolve({ outcome: 'BLOCKED', code: e.code ?? String(e.message).slice(0, 80) }));
}), 8000);
const get = (mod, url) => withTimeout(new Promise((resolve) => {
  const req = mod.get(url, { timeout: 8000 }, (res) => { res.resume(); resolve({ outcome: 'REACHED', status: res.statusCode }); });
  req.once('error', (e) => resolve({ outcome: 'BLOCKED', code: e.code ?? String(e.message).slice(0, 80) }));
  req.once('timeout', () => { req.destroy(); resolve({ outcome: 'TIMEOUT' }); });
}), 10000);

const tryRead = (p) => { try { const b = fs.readFileSync(p); return { outcome: 'READ', bytes: b.length }; } catch (e) { return { outcome: 'DENIED', code: e.code }; } };
const tryList = (p) => { try { return { outcome: 'LISTED', entries: fs.readdirSync(p).length }; } catch (e) { return { outcome: 'DENIED', code: e.code }; } };
const tryWrite = (p) => { try { fs.writeFileSync(p, 'h16 probe'); fs.rmSync(p, { force: true }); return { outcome: 'WRITTEN' }; } catch (e) { return { outcome: 'DENIED', code: e.code }; } };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 25000, windowsHide: true });
  return { status: r.status, signal: r.signal, error: r.error ? String(r.error.code ?? r.error.message) : null,
    stdout: String(r.stdout ?? '').slice(-300), stderr: String(r.stderr ?? '').slice(-300) };
};

(async () => {
  result.net.brokerLoopback = await get(http, `http://127.0.0.1:${spec.brokerPort}/probe`);
  result.net.otherLoopback = await get(http, `http://127.0.0.1:${spec.otherPort}/probe`);
  result.net.brokerLoopbackV6 = await tcp('::1', spec.brokerPort);
  result.net.tcp_1_1_1_1_443 = await tcp('1.1.1.1', 443);
  result.net.https_deepseek = await get(https, 'https://api.deepseek.com/');
  result.net.https_github = await get(https, 'https://github.com/');
  result.net.dns = await withTimeout(new Promise((resolve) => dns.lookup('api.deepseek.com', (e, a) => resolve(e ? { outcome: 'BLOCKED', code: e.code } : { outcome: 'RESOLVED', address: a }))), 8000);
  for (const [name, p] of Object.entries(spec.reads ?? {})) result.files[`read:${name}`] = fs.existsSync(p) && fs.statSync(p).isDirectory() ? tryList(p) : tryRead(p);
  for (const [name, p] of Object.entries(spec.writes ?? {})) result.files[`write:${name}`] = tryWrite(p);
  if (spec.children) {
    result.children.pwshWeb = run('powershell.exe', ['-NoProfile', '-Command',
      "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 https://api.deepseek.com/).StatusCode; 'REACHED' } catch { if ($_.Exception.Response) { 'REACHED' } else { 'BLOCKED ' + $_.Exception.Message } }"]);
    result.children.nodeHttp = run(process.execPath, ['-e',
      "require('https').get('https://api.deepseek.com/',{timeout:8000},r=>{console.log('REACHED',r.statusCode);process.exit(0)}).on('error',e=>{console.log('BLOCKED',e.code);process.exit(0)}).on('timeout',()=>{console.log('TIMEOUT');process.exit(0)})"]);
    result.children.git = run('git', ['ls-remote', '--heads', 'https://github.com/git/git.git', 'master']);
  }
  fs.writeFileSync(spec.out, JSON.stringify(result, null, 2));
})().catch((e) => { try { fs.writeFileSync(spec.out, JSON.stringify({ fatal: String(e && e.stack || e) })); } catch { /* nothing */ } process.exit(3); });
