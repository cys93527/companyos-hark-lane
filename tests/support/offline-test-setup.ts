import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Applies even to a raw Vitest invocation that did not use the named wrapper.
const guard = require('../../scripts/test-offline-guard.cjs') as { installOfflineGuard(): unknown; safeEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv };
guard.installOfflineGuard();
const clean = guard.safeEnvironment(process.env);
for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
Object.assign(process.env, clean);
const parent = fileURLToPath(new URL('../../.tmp/offline-gates/', import.meta.url));
mkdirSync(parent, {recursive: true});
const root = mkdtempSync(join(parent, 'worker-'));
for (const key of ['TEMP','TMP','TMPDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA']) process.env[key] = root;
