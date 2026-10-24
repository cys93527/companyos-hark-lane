// Phase A focused diagnostics: NUL device, git real ops, node variants.
const {mkdtempSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {execFileSync} = require('node:child_process');
const {LowBoxAttempt} = require('./lowbox.cjs');

const ws = mkdtempSync(join(tmpdir(), 'lb-foc-'));
const box = new LowBoxAttempt({workspaceRoot: ws, toolchainRoots: ['C:\\Program Files\\nodejs', 'E:\\GIT\\Git']});
console.log('SID:', box.sid);
const ENV = {
  SystemRoot: 'C:\\Windows', windir: 'C:\\Windows',
  PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs;E:\\GIT\\Git\\cmd;E:\\GIT\\Git\\mingw64\\bin',
  TEMP: box.homeDir, TMP: box.homeDir, HOME: box.homeDir, USERPROFILE: box.homeDir,
  GIT_CONFIG_GLOBAL: join(box.homeDir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  NUMBER_OF_PROCESSORS: '8', USERNAME: 'agent', COMPUTERNAME: 'SANDBOX', PATHEXT: '.COM;.EXE;.BAT;.CMD',
};
writeFileSync(join(box.homeDir, 'gitconfig'), '', 'utf8');
writeFileSync(join(ws, 'repo.txt'), 'hello\n', 'utf8');

const ps = (script) => box.run({
  program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  argv: ['-NoProfile', '-Command', script], env: ENV,
});

let r;
r = box.run({program: 'C:\\Windows\\System32\\cmd.exe', argv: ['/c', 'echo x > NUL & echo NUL-OK'], env: ENV, rawArgs: true});
console.log('[NUL via cmd]', r.exitCode, JSON.stringify(r.stdout.trim()));

r = ps("$null = Get-Content NUL -ErrorAction SilentlyContinue; Write-Output ('NUL-ps: ' + $?)");
console.log('[NUL via ps]', r.exitCode, JSON.stringify(r.stdout.trim()));

// git init + status + add + commit in a workspace repo (real dev-task shape)
execFileSync('git', ['init', '-q'], {cwd: ws});
r = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', ws, 'status', '--porcelain'], env: ENV});
console.log('[git status]', r.exitCode, JSON.stringify(r.stdout.trim().slice(0, 150)), JSON.stringify(r.stderr.trim().slice(0, 150)));
r = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', ws, '-c', 'user.email=a@b', '-c', 'user.name=agent', 'add', 'repo.txt'], env: ENV});
console.log('[git add]', r.exitCode, JSON.stringify(r.stderr.trim().slice(0, 150)));
r = box.run({program: 'E:\\GIT\\Git\\cmd\\git.exe', argv: ['-C', ws, '-c', 'user.email=a@b', '-c', 'user.name=agent', 'commit', '-qm', 'initial'], env: ENV});
console.log('[git commit]', r.exitCode, JSON.stringify(r.stdout.trim().slice(0, 150)), JSON.stringify(r.stderr.trim().slice(0, 200)));

box.dispose();
rmSync(ws, {recursive: true, force: true});
