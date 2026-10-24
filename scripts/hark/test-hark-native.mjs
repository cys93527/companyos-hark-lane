#!/usr/bin/env node
// Hark lane H3 NATIVE test entry. Windows x64 CI only (koffi@3.3.3 approved for
// CI only, 2026-10-24). Requires HARK_KOFFI_DIR = directory holding the
// separately installed, integrity-checked koffi. Network stays denied; the
// tests create processes only through kernel32 CreateProcessW (Job Object).
// Exit code is node:test's exit code, unmodified.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('HARK_NATIVE_HOST_REFUSED: win32/x64 only');
  process.exit(2);
}
if (!process.env.HARK_KOFFI_DIR) {
  console.error('HARK_NATIVE_HOST_REFUSED: HARK_KOFFI_DIR not set');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'apps', 'desktop', 'tests', 'hark-native-lifetime', 'native');
const files = readdirSync(dir).filter(f => f.endsWith('.win-test.ts')).sort().map(f => relative(root, join(dir, f)));
const env = {
  SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
  PATH: process.env.PATH ?? '',
  TEMP: process.env.TEMP ?? '',
  TMP: process.env.TMP ?? '',
  HARK_KOFFI_DIR: process.env.HARK_KOFFI_DIR,
  COMPANYOS_TEST_MODE: 'OFFLINE',
  NODE_NO_WARNINGS: '1',
};
const result = spawnSync(process.execPath, ['--import', './scripts/hark/register-native.mjs', '--test', '--test-concurrency=1', '--test-reporter=spec', ...files], { cwd: root, env, stdio: 'inherit' });
process.exit(result.status ?? 1);
