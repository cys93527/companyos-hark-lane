// Only the safety regression workers import this profile. Keep the user's real
// HOME/TEMP and deployment credentials out of their disposable child fixtures.
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const parent=fileURLToPath(new URL('../../.tmp/offline-gates/',import.meta.url));
mkdirSync(parent,{recursive:true});
const root=mkdtempSync(join(parent,'node-safety-'));
import { prepareOfflineResources } from '../prepare-offline-resources.mjs';
// Supply only pinned, read-only test bytes before the Guard pins Kernel identity.
prepareOfflineResources();
const require=createRequire(import.meta.url);
const {safeEnvironment}=require('../test-offline-guard.cjs');
const clean=safeEnvironment(process.env);
for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
Object.assign(process.env,clean);
for (const key of ['TEMP','TMP','TMPDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA']) process.env[key]=root;
