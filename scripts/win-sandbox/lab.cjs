/**
 * STAGE 5C PHASE A lab CLI — one-shot diagnostics over the LowBox attempt.
 * Usage: node scripts/win-sandbox/lab.cjs <probe>
 * Probes: cmd | powershell | node | node-nojob | node-nosusp | where | git | echo
 */
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {LowBoxAttempt} = require('./lowbox.cjs');

const probe = process.argv[2] ?? 'echo';
const ws = mkdtempSync(join(tmpdir(), 'lb-lab-'));
const toolchains = ['C:\\Program Files\\nodejs', 'E:\\GIT\\Git'];
const box = new LowBoxAttempt({workspaceRoot: ws, toolchainRoots: toolchains});
console.log('SID:', box.sid);

const MIN_ENV = {
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\mingw64\\bin',
  TEMP: box.homeDir, TMP: box.homeDir,
  HOME: box.homeDir, USERPROFILE: box.homeDir, APPDATA: join(box.homeDir, 'appdata'),
  GIT_CONFIG_GLOBAL: join(box.homeDir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
require('node:fs').writeFileSync(join(box.homeDir, 'gitconfig'), '', 'utf8');

let result;
const main = async () => {
switch (probe) {
  case 'cmd':
    result = box.run({program: 'C:\\Windows\\System32\\cmd.exe', argv: ['/c', 'echo CMD-OK'], env: MIN_ENV});
    break;
  case 'powershell':
    result = box.run({program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', argv: ['-NoProfile', '-Command', 'echo PS-OK'], env: MIN_ENV});
    break;
  case 'node':
    result = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: ['--version'], env: MIN_ENV});
    break;
  case 'node-bare':
    // Inherited environment, no batch sets — isolates whether one of our env
    // values (TEMP/HOME/APPDATA redirection) breaks node's init.
    result = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: ['--version']});
    break;
  case 'node-nosusp':
    // Diagnostic: skip suspended+job (races acceptable in the lab) — isolates
    // whether CREATE_SUSPENDED/job assignment interacts with node's init.
    result = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: ['--version'], env: MIN_ENV, noSuspend: true});
    break;
  case 'where':
    result = box.run({program: 'C:\\Windows\\System32\\where.exe', argv: ['/R', 'C:\\Windows\\System32', 'cmd.exe'], env: MIN_ENV});
    break;
  case 'git':
    result = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['--version'], env: MIN_ENV});
    break;
  case 'net-ps': {
    const http = require('node:http');
    const os = require('node:os');
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    const start = (host) => new Promise((res) => {
      const hits = [];
      const srv = http.createServer((rq, rs) => { hits.push(rq.url); rs.writeHead(200).end('CANARY-REACHED'); });
      srv.listen(0, host, () => res({srv, hits, port: srv.address().port}));
    });
    const loop = await start('127.0.0.1');
    const ext = await start(lan.address);
    const script = [
      `try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://${lan.address}:${ext.port}/lan').Content; Write-Output 'LAN=POSSIBLE' } catch { Write-Output 'LAN=BLOCKED' }`,
      `try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:${loop.port}/loop').Content; Write-Output 'LOOP=POSSIBLE' } catch { Write-Output 'LOOP=BLOCKED' }`,
      `try { $c = New-Object Net.Sockets.TcpClient; $null = $c.ConnectAsync('${lan.address}', ${ext.port}).Wait(5000); Write-Output ('TCP=' + $c.Connected) } catch { Write-Output 'TCP=BLOCKED' }`,
      `try { Resolve-DnsName github.com -ErrorAction Stop | Out-Null; Write-Output 'DNS=POSSIBLE' } catch { Write-Output 'DNS=BLOCKED' }`,
      `& 'C:\\Windows\\System32\\curl.exe' -s --max-time 5 'http://${lan.address}:${ext.port}/curl' 2>&1 | Select-Object -First 1`,
    ].join('; ');
    const netResult = await new Promise((resolve) => { const r = box.run({program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', argv: ['-NoProfile', '-Command', script], env: MIN_ENV, timeoutMs: 90000}); resolve(r); });
    console.log(JSON.stringify({exit: netResult.exitCode, out: netResult.stdout.trim().slice(0, 300), err: netResult.stderr.trim().slice(0, 200)}));
    console.log('canary hits loop/lan:', loop.hits.length, ext.hits.length);
    loop.srv.close(); ext.srv.close();
    result = {exitCode: netResult.exitCode, pid: 0, jobAssigned: true, timedOut: netResult.timedOut, stdout: netResult.stdout, stderr: netResult.stderr};
    break;
  }
  case 'hostname':
    result = box.run({program: 'C:\\Windows\\System32\\hostname.exe', argv: [], env: MIN_ENV});
    break;
  case 'whoami':
    result = box.run({program: 'C:\\Windows\\System32\\whoami.exe', argv: [], env: MIN_ENV});
    break;
  case 'where-simple':
    result = box.run({program: 'C:\\Windows\\System32\\where.exe', argv: ['cmd.exe'], env: MIN_ENV});
    break;
  case 'node-via-ps':
    result = box.run({program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      argv: ['-NoProfile', '-Command', "& 'C:\\Program Files\\nodejs\\node.exe' --version 2>&1 | Out-String"], env: MIN_ENV});
    break;
  case 'node-via-ps-code':
    result = box.run({program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      argv: ['-NoProfile', '-Command', "$p = Start-Process -FilePath 'C:\\Program Files\\nodejs\\node.exe' -ArgumentList '--version' -NoNewWindow -Wait -PassThru -RedirectStandardError 'C:\\Windows\\Temp\\nodeerr.txt' -RedirectStandardOutput 'C:\\Windows\\Temp\\nodeout.txt'; Write-Output ('exit=' + $p.ExitCode)"], env: MIN_ENV});
    break;
  default:
    result = box.run({program: 'C:\\Windows\\System32\\cmd.exe', argv: ['/c', 'echo ECHO-OK'], env: MIN_ENV});
}
console.log(JSON.stringify({exitCode: result.exitCode, pid: result.pid, jobAssigned: result.jobAssigned, timedOut: result.timedOut, stdout: result.stdout.slice(0, 200), stderr: result.stderr.slice(0, 300)}, null, 2));
};
main().catch((e) => { console.error('LAB-ERR', e); process.exitCode = 1; }).finally(() => { box.dispose(); rmSync(ws, {recursive: true, force: true}); });
