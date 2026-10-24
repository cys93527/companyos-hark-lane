#!/usr/bin/env node
// Hark lane zero-dependency offline test entry (no node_modules required).
// Usage: node scripts/hark/test-hark-offline.mjs [exact test files...]
// Default: every apps/desktop/tests/hark-native-lifetime/*.node-test.ts file.
// Runs node:test with Node's built-in TypeScript type stripping under the
// offline guard preload. Exit code is node:test's exit code, unmodified.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'apps', 'desktop', 'tests', 'hark-native-lifetime');
const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : readdirSync(dir).filter(f => f.endsWith('.node-test.ts')).sort().map(f => relative(root, join(dir, f)));
const [major, minor] = process.versions.node.split('.').map(Number);
const strip = major > 22 || (major === 22 && minor >= 18) ? [] : ['--experimental-strip-types'];
const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', COMPANYOS_TEST_MODE: 'OFFLINE', NODE_NO_WARNINGS: '1' };
const result = spawnSync(process.execPath, [...strip, '--import', './scripts/hark/register-offline.mjs', '--test', '--test-reporter=spec', ...files], { cwd: root, env, stdio: 'inherit' });
process.exit(result.status ?? 1);
