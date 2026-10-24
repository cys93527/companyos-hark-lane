import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { prepareOfflineResources } from './prepare-offline-resources.mjs';
// Supply only pinned, read-only test bytes before the Guard pins Kernel identity.
prepareOfflineResources();
const require = createRequire(import.meta.url);
const { safeEnvironment } = require('./test-offline-guard.cjs');
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = require.resolve('vitest/vitest.mjs');
const args = process.argv.slice(2);
// Default quality gate cannot select a live or an alternate unguarded config.
if (args.some((arg) => /^(?:--config(?:=|$)|-c$|--project(?:=|$)|--workspace(?:=|$)|--root(?:=|$)|--dir(?:=|$))/.test(arg))) {
  throw new Error('OFFLINE_TEST_CONFIG_OVERRIDE_DENIED');
}
console.log('OFFLINE QUALITY GATE — real DSH integration is a separate, unverified gate');
// Do not inherit deployment configuration or the real user's credentials/profile.
// Preserve this unique gate directory, including failures, for later inspection.
const parent = join(root, '.tmp', 'offline-gates');
mkdirSync(parent, { recursive: true });
const dataRoot = mkdtempSync(join(parent, 'run-'));
const input = {};
for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'CI', 'NO_COLOR', 'FORCE_COLOR']) {
  if (process.env[key] !== undefined) input[key] = process.env[key];
}
for (const key of ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) input[key] = dataRoot;
console.log(`Owned offline data: ${dataRoot}`);
const child = spawn(process.execPath, [cli, 'run', ...args], { cwd: root, env: safeEnvironment(input), stdio: 'inherit', shell: false });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
