// In-box ACL visibility diagnostics via PowerShell (which runs in the box).
const {mkdtempSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {LowBoxAttempt} = require('./lowbox.cjs');

const ws = mkdtempSync(join(tmpdir(), 'lb-diag-'));
const box = new LowBoxAttempt({workspaceRoot: ws, toolchainRoots: ['C:\\Program Files\\nodejs', 'C:\\Program Files\\Git']});
console.log('SID:', box.sid);
writeFileSync(join(box.homeDir, 'gitconfig'), '', 'utf8');

const script = [
  "Write-Output ('node-exe-visible: ' + (Test-Path 'C:\\Program Files\\nodejs\\node.exe'))",
  "Write-Output ('git-exe-visible: ' + (Test-Path 'C:\\Program Files\\Git\\cmd\\git.exe'))",
  "Write-Output ('git-mingw-visible: ' + (Test-Path 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe'))",
  "Write-Output ('sys32-visible: ' + (Test-Path 'C:\\Windows\\System32\\cmd.exe'))",
  "Write-Output ('winini-visible: ' + (Test-Path 'C:\\Windows\\win.ini'))",
  "$count = (Get-ChildItem 'C:\\Program Files\\nodejs' -ErrorAction SilentlyContinue | Measure-Object).Count",
  "Write-Output ('nodejs-listing-count: ' + $count)",
  "$ver = & 'C:\\Program Files\\Git\\cmd\\git.exe' --version 2>&1 | Out-String",
  "Write-Output ('git-version: ' + $ver.Trim())",
].join('; ');
const result = box.run({
  program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  argv: ['-NoProfile', '-Command', script],
  env: {
    SystemRoot: 'C:\\Windows', windir: 'C:\\Windows',
    PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd',
    TEMP: box.homeDir, TMP: box.homeDir, HOME: box.homeDir, USERPROFILE: box.homeDir,
    GIT_CONFIG_GLOBAL: join(box.homeDir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  },
});
console.log('exit:', result.exitCode);
console.log('stdout:\n' + result.stdout);
console.log('stderr:\n' + result.stderr.slice(0, 400));
box.dispose();
rmSync(ws, {recursive: true, force: true});
