/** Stage 5D-B probe CLI: node scripts/win-sandbox-identity/probe-v2.cjs <kind> */
const {mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync} = require('node:fs');
const {join} = require('node:path');
const {execFileSync} = require('node:child_process');
const {RestrictedSandboxParent} = require('./identity-lab-v2.cjs');

const kind = process.argv[2] ?? 'help';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const toolchains = ['C:\\Program Files\\nodejs', 'E:\\GIT\\Git', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'];

const parent = new RestrictedSandboxParent({});
const ws = mkdtempSync(join(parent.labRoot, 'ws-'));
console.log('account:', parent.accountName, 'SID:', parent.accountSid, 'setupMs:', JSON.stringify(parent.timings));

const attempt = parent.newAttempt({workspaceRoot: ws, toolchainRoots: toolchains});
console.log('restricting SID:', attempt.restrictingSid, 'attemptSetupMs:', JSON.stringify(attempt.timings));

const ENV = {
  SystemRoot: 'C:\\Windows', windir: 'C:\\Windows',
  PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\nodejs;E:\\GIT\\Git\\cmd',
  TEMP: attempt.homeDir, TMP: attempt.homeDir,
  HOME: attempt.homeDir, USERPROFILE: attempt.homeDir,
  GIT_CONFIG_GLOBAL: join(attempt.homeDir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
writeFileSync(join(attempt.homeDir, 'gitconfig'), "[safe]\n\tdirectory = *\n[user]\n\temail = agent@companyos.local\n\tname = Agent\n", 'utf8');
writeFileSync(join(ws, 'seed.txt'), 'SEED', 'utf8');

const ps = (script) => attempt.run({program: PS, argv: ['-NoProfile', '-Command', script], env: ENV});
const node = (script, timeoutMs) => attempt.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: ['-e', script], env: ENV, timeoutMs: timeoutMs ?? 30000});

let asyncCleanup = false;
try {
  switch (kind) {
    case 'node':
      { const r = attempt.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: ['--version'], env: ENV});
        console.log('[node-version]', r.exitCode, r.stdout.trim()); }
      writeFileSync(join(ws, 't.cjs'), 'const fs=require("node:fs");const p=require("node:path");const ws=process.argv[2];fs.writeFileSync(p.join(ws,"w.txt"),"W-"+fs.readFileSync(p.join(ws,"seed.txt"),"utf8"));const cp=require("node:child_process");const c=cp.spawnSync("C:/Windows/System32/cmd.exe",["/c","echo CHILD-OK"],{encoding:"utf8"});console.log("CHILD:"+c.stdout.trim());');
      { const r = attempt.run({program: 'C:\\Program Files\\nodejs\\node.exe', argv: [join(ws, 't.cjs'), ws], env: ENV});
        console.log('[node-js]', r.exitCode, r.stdout.trim().slice(0, 80));
        try { console.log('[w-file]', readFileSync(join(ws, 'w.txt'), 'utf8')); } catch { console.log('[w-file] MISSING'); } }
      break;
    case 'git': {
      execFileSync('git', ['init', '-q'], {cwd: ws});
      const g = (label, args) => { const r = attempt.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', ws, ...args], env: ENV}); console.log(`[git ${label}]`, r.exitCode, (r.stderr || r.stdout).trim().slice(0, 100)); };
      g('version', ['--version']);
      g('status', ['status', '--porcelain']);
      g('add', ['add', 'seed.txt']);
      g('commit', ['-c', 'user.email=a@b', '-c', 'user.name=x', 'commit', '-qm', 'test']);
      break;
    }
    case 'ps': {
      const r = ps(`Get-Content -LiteralPath '${join(ws, 'seed.txt')}'`);
      console.log('[ps-read]', r.exitCode, JSON.stringify(r.stdout.trim()));
      const r2 = ps(`Set-Content -LiteralPath '${join(ws, 'p.txt')}' 'WROTE'`);
      console.log('[ps-write]', r2.exitCode, readFileSync(join(ws, 'p.txt'), 'utf8').trim());
      break;
    }
    case 'world-readable': {
      // Boss §2: A-E fixtures with varying default ACLs
      const fixtures = [];
      const mk = (label, acl) => {
        const dir = mkdtempSync(join(parent.labRoot, `fix-${label}-`));
        const f = join(dir, 'secret.txt');
        writeFileSync(f, `SECRET-${label}`, 'utf8');
        if (acl) execFileSync('icacls', [f, ...acl], {stdio: 'pipe', timeout: 30000});
        fixtures.push({label, path: f});
        return f;
      };
      // A: Admins only (default after /inheritance:r)
      mk('admin-only', ['/inheritance:r', '/grant', 'Administrators:F', '/grant', 'SYSTEM:F']);
      // B: Users RX
      mk('users-rx', ['/grant', 'Users:(RX)']);
      // C: Authenticated Users RX
      mk('authusers-rx', ['/grant', '*S-1-5-11:(RX)']);
      // D: Everyone RX
      mk('everyone-rx', ['/grant', 'Everyone:(RX)']);
      // E: volume-root inheritance (default ACL from C:\ root)
      mk('default-acl', null);

      for (const {label, path} of fixtures) {
        const r = ps(`try { Get-Content -LiteralPath '${path}' -ErrorAction Stop | Out-Null; '${label}=READ-POSSIBLE' } catch { '${label}=READ-BLOCKED' }`);
        console.log('[ps]', r.stdout.trim());
      }
      // Node + cmd
      for (const {label, path} of fixtures) {
        const escaped = path.replaceAll('\\', '\\\\');
        const r = node(`const fs=require("node:fs");try{fs.readFileSync("${escaped}");console.log("${label}=NODE-READ-POSSIBLE")}catch(e){console.log("${label}=NODE-READ-" + e.code)}`);
        console.log('[node]', r.stdout.trim());
      }
      // Git
      for (const {label, path} of fixtures) {
        const r = attempt.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', join(path, '..'), 'status'], env: ENV, timeoutMs: 15000});
        const output = (r.stderr || r.stdout).trim().slice(0, 80);
        const blocked = output.includes('Permission denied') || output.includes('cannot change') || output.includes('EPERM') || r.exitCode !== 0;
        console.log('[git]', `${label}=${blocked ? 'GIT-BLOCKED' : 'GIT-POSSIBLE'} (${output.slice(0, 50)})`);
      }
      break;
    }
    case 'outside-write': {
      const out = mkdtempSync(join(parent.labRoot, 'out-'));
      const secret = join(out, 'secret.txt');
      writeFileSync(secret, 'SAFE', 'utf8');
      // Grant Authenticated Users RX on the outside dir (simulate real world)
      execFileSync('icacls', [out, '/grant', '*S-1-5-11:(M)'], {stdio: 'pipe'});
      const r = ps(`try { Set-Content -LiteralPath '${secret}' 'PWNED' -ErrorAction Stop; 'MOD=POSSIBLE' } catch { 'MOD=BLOCKED' }; try { New-Item -ItemType File '${join(out, 'new.txt')}' -ErrorAction Stop | Out-Null; 'NEW=POSSIBLE' } catch { 'NEW=BLOCKED' }`);
      console.log('[ps]', r.stdout.trim().replace(/\r?\n/g, ' '));
      const r2 = node(`const fs=require("node:fs");try{fs.writeFileSync("${join(out, 'n.txt').replaceAll('\\', '\\\\')}","X");console.log("NODE-WRITE=POSSIBLE")}catch(e){console.log("NODE-WRITE=" + e.code)}`);
      console.log('[node]', r2.stdout.trim(), 'secretStill:', readFileSync(secret, 'utf8'));
      break;
    }
    case 'junction': {
      const outside = mkdtempSync(join(parent.labRoot, 'junc-'));
      writeFileSync(join(outside, 'target.txt'), 'SAFE', 'utf8');
      execFileSync('cmd', ['/c', 'mklink', '/J', join(ws, 'link-out'), outside]);
      const r = ps(`try { Get-Content -LiteralPath '${join(ws, 'link-out', 'target.txt')}' -ErrorAction Stop | Out-Null; 'J-READ=POSSIBLE' } catch { 'J-READ=BLOCKED' }; try { Set-Content -LiteralPath '${join(ws, 'link-out', 'target.txt')}' 'PWNED' -ErrorAction Stop; 'J-WRITE=POSSIBLE' } catch { 'J-WRITE=BLOCKED' }`);
      console.log('[static]', r.stdout.trim().replace(/\r?\n/g, ' '));
      const r2 = node(`const fs=require("node:fs");try{fs.writeFileSync("${join(ws, 'link-out', 'target.txt').replaceAll('\\', '\\\\')}","PN");console.log("NJ=POSSIBLE")}catch(e){console.log("NJ=" + e.code)}`);
      console.log('[node-junction]', r2.stdout.trim(), 'still:', readFileSync(join(outside, 'target.txt'), 'utf8'));
      break;
    }
    case 'race': {
      const outside = mkdtempSync(join(parent.labRoot, 'race-'));
      writeFileSync(join(outside, 'canary.txt'), 'SAFE-RACE', 'utf8');
      const flipDir = join(ws, 'flip');
      mkdirSync(flipDir, {recursive: true});
      const raceMain = async () => {
        let flipping = true;
        const flipper = (async () => {
          let j = false;
          while (flipping) {
            try { rmSync(flipDir, {recursive: true, force: true}); if (j) mkdirSync(flipDir, {recursive: true}); else require('node:fs').symlinkSync(outside, flipDir, 'junction'); j = !j; } catch { /* mid-open; retry */ }
            await new Promise((r) => setTimeout(r, 4));
          }
        })();
        const victim = [
          `Set-Location '${ws}'`,
          'for ($i=0; $i -lt 80; $i++) {',
          "  try { Get-Content -LiteralPath 'flip\\canary.txt' -EA SilentlyContinue | Out-Null } catch {}",
          "  try { Set-Content -LiteralPath 'flip\\canary.txt' ('R'+$i) -EA SilentlyContinue } catch {}",
          "  try { New-Item -ItemType File ('flip\\n'+$i+'.txt') -EA SilentlyContinue | Out-Null } catch {}",
          "  try { Move-Item -LiteralPath ('flip\\n'+$i+'.txt') -Destination 'flip\\canary.txt' -Force -EA SilentlyContinue } catch {}",
          '}',
          "Write-Output 'RACE-DONE'",
        ].join('; ');
        const r = ps(victim);
        flipping = false;
        await flipper;
        const content = readFileSync(join(outside, 'canary.txt'), 'utf8');
        const files = require('node:fs').readdirSync(outside);
        console.log('[race]', `done=${r.stdout.includes('RACE-DONE')}`, 'canary:', JSON.stringify(content), 'files:', JSON.stringify(files));
      };
      raceMain().then(() => { attempt.dispose(); parent.dispose(); process.exit(0); });
      asyncCleanup = true;
      break;
    }
    case 'network': {
      const netMain = async () => {
      const http = require('node:http');
      const os = require('node:os');
      const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
      const dnsCanary = http.createServer((rq, rs) => { console.log('[dns-canary HIT]', rq.url); rs.writeHead(200).end('OK'); });
      const httpCanary = http.createServer((rq, rs) => { console.log('[http-canary HIT]', rq.url); rs.writeHead(200).end('OK'); });
      await new Promise((r) => dnsCanary.listen(0, '127.0.0.1', r));
      await new Promise((r) => httpCanary.listen(0, lan.address, r));
      const httpPort = httpCanary.address().port;

      // Direct DNS: set the sandbox's DNS server to our canary via env,
      // then try resolving (any hit = exfiltration possible)
      const r = ps(`try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 'http://${lan.address}:${httpPort}/lan').Content; 'IWR-LAN=POSSIBLE' } catch { 'IWR-LAN=BLOCKED' }; try { $c=New-Object Net.Sockets.TcpClient; $null=$c.ConnectAsync('${lan.address}',${httpPort}).Wait(4000); 'TCP='+$c.Connected } catch { 'TCP=BLOCKED' }`);
      console.log('[ps-net]', r.stdout.trim().replace(/\r?\n/g, ' '));
      // DNS: try nslookup against a fake server (tests if sandbox can send UDP)
      const r2 = ps(`try { nslookup test.local 127.0.0.1 2>&1 | Out-String; 'DNS-NSLOOKUP=EXECUTED' } catch { 'DNS-NSLOOKUP=BLOCKED' }`);
      console.log('[dns-nslookup]', r2.stdout.trim().slice(0, 150));
      // Normal user network check
      try {
        const resp = await new Promise((resolve, reject) => { const rq = http.get(`http://${lan.address}:${httpPort}/normal`, {timeout: 3000}, resolve); rq.on('error', reject); rq.on('timeout', () => { rq.destroy(); reject(new Error('timeout')); }); });
        console.log('[normal-user-net]', 'UNAFFECTED', resp.status);
      } catch (e) { console.log('[normal-user-net]', 'BLOCKED (unexpected!)', e.message.slice(0, 60)); }
      httpCanary.close(); dnsCanary.close();
      };
      netMain().then(() => { attempt.dispose(); parent.dispose(); process.exit(0); });
      asyncCleanup = true;
      break;
    }
    case 'cross': {
      const wsB = mkdtempSync(join(parent.labRoot, 'wsB-'));
      writeFileSync(join(wsB, 'b.txt'), 'B-SECRET', 'utf8');
      execFileSync('icacls', [wsB, '/grant', '*S-1-5-11:(RX)'], {stdio: 'pipe'}); // simulate real-world ACL
      const r = ps(`try { Get-Content -LiteralPath '${join(wsB, 'b.txt')}' -ErrorAction Stop | Out-Null; 'B=POSSIBLE' } catch { 'B=BLOCKED' }`);
      console.log('[cross-ps]', r.stdout.trim());
      const r2 = node(`const fs=require("node:fs");try{fs.readFileSync("${join(wsB, 'b.txt').replaceAll('\\', '\\\\')}");console.log("NB=POSSIBLE")}catch(e){console.log("NB=" + e.code)}`);
      console.log('[cross-node]', r2.stdout.trim());
      break;
    }
    case 'tree': {
      const marker = 'sbxtree' + Math.random().toString(36).slice(9);
      const script = `Start-Process cmd -ArgumentList '/c ping -n 120 127.0.0.1 & rem ${marker}' -WindowStyle Hidden; Start-Sleep -Seconds 120`;
      const runner = ps(script);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const treeMain = async () => {
        await wait(18000);
        const during = Number.parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'").Count`], {encoding: 'utf8'}).trim() || '0', 10);
        await runner;
        await wait(5000);
        const after = Number.parseInt(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${marker}%'").Count`], {encoding: 'utf8'}).trim() || '0', 10);
        console.log('[tree]', `during=${during} after=${after}`);
        asyncCleanup = true;
        setTimeout(() => { attempt.dispose(); parent.dispose(); process.exit(0); }, 1000);
      };
      treeMain();
      asyncCleanup = true; // prevent sync cleanup
      break;
    }
    case 'crash-recovery': {
      // Simulate crash at various states, then verify recovery cleanup
      console.log('[crash] Simulating crash after ACL grant + firewall rule...');
      // DO NOT dispose: this simulates a crash
      const staleAccount = parent.accountName;
      // Verify the stale state exists
      const userExists = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-LocalUser -Name '${staleAccount}' -EA SilentlyContinue) -ne $null`], {encoding: 'utf8'}).trim();
      console.log('[crash] stale user exists:', userExists);
      const fwExists = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-NetFirewallRule -DisplayName '${require('./identity-lab-v2.cjs').FIREWALL_RULE_NAME}' -EA SilentlyContinue) -ne $null`], {encoding: 'utf8'}).trim();
      console.log('[crash] stale firewall exists:', fwExists);
      // Recovery: detect and cleanup
      console.log('[crash] Running recovery...');
      // Remove stale firewall rule
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Remove-NetFirewallRule -DisplayName '${require('./identity-lab-v2.cjs').FIREWALL_RULE_NAME}'`], {stdio: 'pipe'});
      // Remove stale user (and its ACEs via SDDL cleanup)
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Remove-LocalUser -Name '${staleAccount}'`], {stdio: 'pipe'});
      // Verify cleanup
      const userAfter = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-LocalUser -Name '${staleAccount}' -EA SilentlyContinue) -ne $null`], {encoding: 'utf8'}).trim();
      const fwAfter = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-NetFirewallRule -DisplayName '${require('./identity-lab-v2.cjs').FIREWALL_RULE_NAME}' -EA SilentlyContinue) -ne $null`], {encoding: 'utf8'}).trim();
      console.log('[recovery] user cleaned:', userAfter === 'False', 'firewall cleaned:', fwAfter === 'False');
      asyncCleanup = true; // already cleaned manually
      break;
    }
    default:
      console.log('probes: node | git | ps | world-readable | outside-write | junction | race | network | cross | tree | crash-recovery');
  }
} finally {
  if (!asyncCleanup) {
    const t0 = Date.now();
    attempt.dispose();
    parent.dispose();
    console.log('teardownMs:', Date.now() - t0, JSON.stringify(parent.timings), JSON.stringify(attempt.timings));
  }
}
