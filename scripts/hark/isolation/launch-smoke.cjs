// H16b-2 smoke of companyos-isolated-launch.exe, spawned from Node exactly like the app spawns the kernel
// (stdio pipes, kill on timeout). CI only (hark-isolation lifecycle L3b). Writes JSON to argv[7].
// usage: node launch-smoke.cjs <launcher.exe> <credential.dpapi> <account> <cwd> <node.exe> <out.json>
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const [launcher, credential, account, cwd, nodeExe, outPath] = process.argv.slice(2);

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(launcher, ['--account', account, '--credential', opts.credential ?? credential, '--cwd', cwd, '--', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (opts.onStdout) opts.onStdout(stdout, child); });
    child.stderr.on('data', (d) => { stderr += d; });
    if (opts.stdin !== undefined) { child.stdin.write(opts.stdin); child.stdin.end(); }
    const t = setTimeout(() => { child.kill(); }, opts.timeoutMs ?? 60000);
    child.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) }); });
  });
}
function alive(pid) {
  try { return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid)); } catch { return null; }
}

(async () => {
  const checks = [];
  const check = (id, ok, observed) => checks.push({ id, ok: Boolean(ok), observed });

  const t1 = await run([nodeExe, '-e', "console.log('OUT ' + require('os').userInfo().username + ' ' + JSON.stringify(process.argv.slice(1))); console.error('ERR line'); process.exit(7)", 'a b', 'q"x', 'c:\\p\\']);
  check('L3b.identity', t1.stdout.includes(`OUT ${account} `), t1);
  check('L3b.argvVerbatim', t1.stdout.includes(JSON.stringify(['a b', 'q"x', 'c:\\p\\'])), t1.stdout);
  check('L3b.stderrPiped', t1.stderr.includes('ERR line'), t1.stderr);
  check('L3b.exitCodePropagated', t1.code === 7, t1.code);

  const t2 = await run([nodeExe, '-e', "process.stdin.on('data', d => process.stdout.write('ECHO ' + d)); process.stdin.on('end', () => process.exit(0))"], { stdin: 'ping\n' });
  check('L3b.stdinPiped', t2.stdout.includes('ECHO ping') && t2.code === 0, t2);

  let grandPid = null;
  const t3 = await run([nodeExe, '-e', "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log('GRAND ' + c.pid); setInterval(()=>{},1000)"], {
    timeoutMs: 30000,
    onStdout: (s, child) => { const m = /GRAND (\d+)/.exec(s); if (m && grandPid === null) { grandPid = Number(m[1]); setTimeout(() => child.kill(), 1500); } },
  });
  await new Promise((r) => setTimeout(r, 3000));
  const grandAlive = grandPid === null ? null : alive(grandPid);
  check('L3b.killLauncherReapsTree', grandPid !== null && grandAlive === false, { grandPid, grandAlive, t3 });

  const badCred = `${credential}.bad`; fs.writeFileSync(badCred, Buffer.from('not dpapi'));
  const t4 = await run([nodeExe, '-e', 'process.exit(0)'], { credential: badCred });
  check('L3b.badCredentialFailsClosed', t4.code === 121 && t4.stderr.includes('ISOLATED_LAUNCH_CREDENTIAL_UNREADABLE'), t4);

  const t5 = await run([nodeExe, '-e', "require('https').get('https://api.deepseek.com', r => { console.log('REACHED ' + r.statusCode); process.exit(0) }).on('error', e => { console.log('BLOCKED ' + e.code); process.exit(0) })"]);
  check('L3b.internetBlockedThroughLauncher', t5.stdout.includes('BLOCKED') && !t5.stdout.includes('REACHED'), t5.stdout);

  fs.writeFileSync(outPath, JSON.stringify({ schema: 'companyos/h16-isolated-launch-smoke/1', checks }, null, 2));
  console.log(`launch-smoke ${checks.filter((c) => c.ok).length}/${checks.length}`);
})().catch((e) => { fs.writeFileSync(outPath, JSON.stringify({ fatal: String(e && e.stack || e) })); process.exit(1); });
