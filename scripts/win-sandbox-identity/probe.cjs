/** Stage 5D identity probe CLI: node scripts/win-sandbox-identity/probe.cjs <kind> */
const {mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync} = require('node:fs');

const {join} = require('node:path');
const {execFileSync} = require('node:child_process');
const {SandboxIdentity} = require('./identity-lab.cjs');

const kind = process.argv[2] ?? 'help';
let asyncCleanup = false;
const labRoot = 'C:\\CompanyOS-SandboxLab';
if (!existsSync(labRoot)) mkdirSync(labRoot, {recursive: true});
const ws = mkdtempSync(join(labRoot, 'ws-'));
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const toolchains = ['C:\\Program Files\\nodejs', 'E:\\GIT\\Git'];
const t0 = Date.now();
const box = new SandboxIdentity({workspaceRoot: ws, toolchainRoots: toolchains});
console.log('SID:', box.sid, 'setupMs:', Date.now() - t0, JSON.stringify(box.timings));

const ENV = {
  SystemRoot: 'C:\\Windows', windir: 'C:\\Windows',
  PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\nodejs;E:\\GIT\\Git\\cmd',
  TEMP: box.homeDir, TMP: box.homeDir, HOME: box.homeDir, USERPROFILE: box.homeDir,
  GIT_CONFIG_GLOBAL: join(box.homeDir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
writeFileSync(join(box.homeDir, 'gitconfig'), "[safe]\n\tdirectory = *\n[user]\n\temail = agent@companyos.local\n\tname = CompanyOS Agent\n", 'utf8');
writeFileSync(join(ws, 'seed.txt'), 'SEED', 'utf8');

const ps = (script) => box.run({program: PS, argv: ['-NoProfile', '-Command', script], env: ENV});
let r;
try {
  switch (kind) {
    case 'node':
      r = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: ['--version'], env: ENV});
      console.log(JSON.stringify({exit: r.exitCode, out: r.stdout.trim(), err: r.stderr.slice(0, 200)}));
      writeFileSync(join(ws, 't.cjs'), 'const fs=require("node:fs");const cp=require("node:child_process");const ws=process.argv[2];const p=require("node:path");fs.writeFileSync(p.join(ws,"w.txt"),"W-"+fs.readFileSync(p.join(ws,"seed.txt"),"utf8"));const c=cp.spawnSync("C:/Windows/System32/cmd.exe",["/c","echo CHILD-OK"],{encoding:"utf8"});console.log("CHILD:"+c.stdout.trim());');
      r = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: [join(ws, 't.cjs'), ws], env: ENV, cwd: ws});
      console.log('[node-script]', JSON.stringify({exit: r.exitCode, out: r.stdout.trim(), err: r.stderr.slice(0, 300)}));
      try { console.log('[w-file]', JSON.stringify(readFileSync(join(ws, 'w.txt'), 'utf8'))); } catch { console.log('[w-file] MISSING'); }
      break;
    case 'git':
      execFileSync('git', ['init', '-q'], {cwd: ws});
      r = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['--version'], env: ENV});
      console.log('version:', r.exitCode, r.stdout.trim(), r.stderr.slice(0, 150));
      r = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', ws, 'status', '--porcelain'], env: ENV});
      console.log('status:', r.exitCode, r.stdout.trim().slice(0, 100), r.stderr.slice(0, 150));
      r = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', ws, '-c', 'user.email=a@b', '-c', 'user.name=agent', 'add', 'seed.txt'], env: ENV});
      console.log('add:', r.exitCode, r.stderr.slice(0, 150));
      r = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', ws, '-c', 'user.email=a@b', '-c', 'user.name=agent', 'commit', '-qm', 'initial'], env: ENV});
      console.log('commit:', r.exitCode, r.stderr.slice(0, 200));
      r = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', ws, 'diff', 'HEAD~0', '--stat'], env: ENV});
      console.log('diff:', r.exitCode, r.stdout.trim().slice(0, 80), r.stderr.slice(0, 100));
      break;
    case 'ps':
      r = ps(`Get-Content -LiteralPath '${join(ws, 'seed.txt')}'`);
      console.log('read:', r.exitCode, JSON.stringify(r.stdout.trim()));
      r = ps(`Set-Content -LiteralPath '${join(ws, 'p.txt')}' 'PS-WROTE'`);
      console.log('write:', r.exitCode, readFileSync(join(ws, 'p.txt'), 'utf8').trim());
      break;
    case 'outside-read': {
      const sib = mkdtempSync(join(labRoot, 'sib-'));
      writeFileSync(join(sib, 'secret.txt'), 'SIBLING-SECRET', 'utf8');
      r = ps(`foreach ($p in @('${join(sib, 'secret.txt')}', '${process.cwd()}\\package.json', '${process.env.USERPROFILE || 'C:\\Users\\Administrator'}\\.ssh\\config')) { try { $null = Get-Content -LiteralPath $p -ErrorAction Stop; Write-Output ($p + '=READ-POSSIBLE') } catch { Write-Output ($p + '=READ-BLOCKED') } }`);
      console.log(r.stdout.trim());
      r = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: ['-e', `try{require('node:fs').readFileSync('${join(sib, 'secret.txt').replaceAll('\\', '\\\\')}');console.log('NODE-READ=POSSIBLE')}catch(e){console.log('NODE-READ=' + e.code)}`], env: ENV});
      console.log('node sibling read:', r.exitCode, r.stdout.trim());
      r = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', sib, 'status'], env: ENV});
      console.log('git -C outside:', r.exitCode, r.stderr.slice(0, 120).trim() || r.stdout.trim().slice(0, 120));
      break;
    }
    case 'outside-write': {
      const out = mkdtempSync(join(labRoot, 'out-'));
      const secret = join(out, 'secret.txt');
      writeFileSync(secret, 'SAFE', 'utf8');
      r = ps(`try { Set-Content -LiteralPath '${secret}' 'PWNED' -ErrorAction Stop; 'MOD=POSSIBLE' } catch { 'MOD=BLOCKED' }; try { New-Item -ItemType File '${join(out, 'new.txt')}' -ErrorAction Stop | Out-Null; 'NEW=POSSIBLE' } catch { 'NEW=BLOCKED' }`);
      console.log('ps:', r.stdout.trim());
      r = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: ['-e', `const fs=require('node:fs');try{fs.writeFileSync('${join(out, 'n.txt').replaceAll('\\', '\\\\')}','X');console.log('NODE-WRITE=POSSIBLE')}catch(e){console.log('NODE-WRITE=' + e.code)}`], env: ENV});
      console.log('node:', r.exitCode, r.stdout.trim(), 'secretStill:', readFileSync(secret, 'utf8'));
      break;
    }
    case 'network': {
      const http = require('node:http');
      const os = require('node:os');
      const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
      const startSrv = (host) => new Promise((res) => {
        const hits = [];
        const srv = http.createServer((rq, rs) => { hits.push(rq.url); rs.writeHead(200).end('OK'); });
        srv.listen(0, host, () => res({srv, hits, port: srv.address().port}));
      });
      const main = async () => {
        const loop = await startSrv('127.0.0.1');
        const ext = await startSrv(lan.address);
        const script = [
          `try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 'http://${lan.address}:${ext.port}/lan').Content; 'IWR-LAN=POSSIBLE' } catch { 'IWR-LAN=BLOCKED' }`,
          `try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 'http://127.0.0.1:${loop.port}/loop').Content; 'IWR-LOOP=POSSIBLE' } catch { 'IWR-LOOP=BLOCKED' }`,
          `try { $c=New-Object Net.Sockets.TcpClient; $null=$c.ConnectAsync('${lan.address}',${ext.port}).Wait(4000); 'TCP='+$c.Connected } catch { 'TCP=BLOCKED' }`,
          `try { Resolve-DnsName github.com -ErrorAction Stop | Out-Null; 'DNS=POSSIBLE' } catch { 'DNS=BLOCKED' }`,
        ].join('; ');
        const boxResult = ps(script);
        console.log('box:', boxResult.stdout.trim().replace(/\r?\n/g, ' '));
        const gitResult = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['ls-remote', `http://${lan.address}:${ext.port}/x.git`], env: ENV, timeoutMs: 30000});
        console.log('git ls-remote exit:', gitResult.exitCode, (gitResult.stderr || gitResult.stdout).trim().slice(0, 120));
        writeFileSync(join(ws, 'net.cjs'), `const http=require('node:http');const req=http.get('http://${lan.address}:${ext.port}/node',res=>{console.log('NODE-HTTP='+res.statusCode);process.exit(0)});req.on('error',e=>{console.log('NODE-HTTP=ERR:'+e.code);process.exit(0)});req.on('socket',s=>{s.setTimeout(4000,()=>{console.log('NODE-HTTP=TIMEOUT');req.destroy();process.exit(0)})});`);
        const nodeResult = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: [join(ws, 'net.cjs')], env: ENV, timeoutMs: 30000});
        console.log('node http:', nodeResult.exitCode, nodeResult.stdout.trim().slice(0, 80));
        console.log('canary hits (loop lan):', loop.hits.length, ext.hits.length);
        loop.srv.close(); ext.srv.close();
      };
      main().then(() => {
        const t1 = Date.now();
        box.dispose();
        console.log('disposeMs:', Date.now() - t1, JSON.stringify(box.timings));
        rmSync(ws, {recursive: true, force: true});
      });
      asyncCleanup = true;
      return;
    }
    case 'junction': {
      const outside = mkdtempSync(join(labRoot, 'junc-'));
      writeFileSync(join(outside, 'target.txt'), 'SAFE', 'utf8');
      execFileSync('cmd', ['/c', 'mklink', '/J', join(ws, 'link-out'), outside]);
      r = ps(`try { Get-Content -LiteralPath '${join(ws, 'link-out', 'target.txt')}' -ErrorAction Stop | Out-Null; 'J-READ=POSSIBLE' } catch { 'J-READ=BLOCKED' }; try { Set-Content -LiteralPath '${join(ws, 'link-out', 'target.txt')}' 'PWNED' -ErrorAction Stop; 'J-WRITE=POSSIBLE' } catch { 'J-WRITE=BLOCKED' }`);
      console.log('static:', r.stdout.trim().replace(/\r?\n/g, ' '));
      writeFileSync(join(ws, 'jr.cjs'), `const fs=require('node:fs');try{fs.writeFileSync('link-out/target.txt','PWNED-N');console.log('NJ=POSSIBLE')}catch(e){console.log('NJ=' + e.code)}`);
      r = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: [join(ws, 'jr.cjs')], env: ENV, cwd: ws});
      console.log('node junction write:', r.exitCode, r.stdout.trim());
      console.log('outside target still:', readFileSync(join(outside, 'target.txt'), 'utf8'));
      break;
    }
    case 'tree': {
      const marker = 'sbx-tree-' + Math.random().toString(36).slice(9);
      const script = `Start-Process cmd -ArgumentList '/c ping -n 120 127.0.0.1 & rem ${marker}' -WindowStyle Hidden; Start-Job -Name j -ScriptBlock { cmd /c "ping -n 120 127.0.0.1 & rem ${marker}job" } | Out-Null; Start-Sleep -Seconds 120`;
      const runner = ps(script);
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      void (async () => {
        await wait(20000);
        const during = Number.parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'").Count`], {encoding: 'utf8'}).trim() || '0', 10);
        const r2 = await runner; // times out at 90s -> terminate job
        console.log('timedOut:', r2.timedOut, 'during:', during);
        await wait(6000);
        const after = Number.parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'").Count`], {encoding: 'utf8'}).trim() || '0', 10);
        console.log('after:', after);
      })();
      break;
    }
    case 'cross': {
      const wsB = mkdtempSync(join(labRoot, 'wsB-'));
      writeFileSync(join(wsB, 'b.txt'), 'B', 'utf8');
      r = ps(`try { Get-Content -LiteralPath '${join(wsB, 'b.txt')}' -ErrorAction Stop | Out-Null; 'B=POSSIBLE' } catch { 'B=BLOCKED' }`);
      console.log('cross-task/company read:', r.stdout.trim());
      r = box.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: ['-e', `const fs=require('node:fs');try{fs.readFileSync('${join(wsB, 'b.txt').replaceAll('\\', '\\\\')}');console.log('NB=POSSIBLE')}catch(e){console.log('NB=' + e.code)}`], env: ENV});
      console.log('node cross read:', r.stdout.trim());
      break;
    }
    case 'env-home':
      r = ps(`Write-Output ('HOME=' + $env:HOME); Write-Output ('USERPROFILE=' + $env:USERPROFILE); Write-Output ('SECRET-SEEN=' + [bool]$env:COS_CANARY_SECRET); try { Get-Content -LiteralPath '${(process.env.USERPROFILE || 'C:\\Users\\Administrator') + '\\\\.gitconfig'}' -ErrorAction Stop | Out-Null; 'REAL-HOME=READABLE' } catch { 'REAL-HOME=BLOCKED' }`);
      console.log(r.stdout.trim().replace(/\r?\n/g, ' | '));
      break;
    default:
      console.log('probes: node | git | ps | outside-read | outside-write | network | junction | tree | cross | env-home');
  }
} finally {
  if (!asyncCleanup) {
    const t1 = Date.now();
    box.dispose();
    console.log('disposeMs:', Date.now() - t1, JSON.stringify(box.timings));
    rmSync(ws, {recursive: true, force: true});
  }
}

