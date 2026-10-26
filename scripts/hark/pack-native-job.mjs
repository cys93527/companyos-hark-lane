#!/usr/bin/env node
// Hark lane H15b: pack the native.job install resource (copied to <install>/resources/native).
// Usage: node scripts/hark/pack-native-job.mjs --koffi <npm install dir holding node_modules/koffi>
//          --kernel <packed agent-kernel/<version> dir> --out <dir>
// Layout written:
//   <out>/koffi-3.3.3/node_modules/{koffi,@koromix/koffi-win32-x64}/**   (exact files of the
//        sha512-integrity-checked npm install; nothing else) + binding-manifest.json (sha256 of every file)
//   <out>/operations/workspace-inventory.cjs
//   <out>/operations.json  (trusted deployment data: task kind -> operation; paths are
//        resource-relative, every executable/input sha256-pinned; resolved at runtime by
//        apps/desktop/src/production-composition.ts productionNativeJob())
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const koffiDir = arg('--koffi'); const kernelDir = arg('--kernel'); const out = arg('--out');
if (!koffiDir || !kernelDir || !out) { console.error('usage: pack-native-job.mjs --koffi <dir> --kernel <dir> --out <dir>'); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const list = (dir) => { const r = []; const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else r.push(relative(dir, p).split(sep).join('/')); } }; walk(dir); return r.sort(); };

const KOFFI_VERSION = '3.3.3';
const pkgs = ['koffi', '@koromix/koffi-win32-x64'];
for (const p of pkgs) {
  const pj = join(koffiDir, 'node_modules', ...p.split('/'), 'package.json');
  if (!existsSync(pj)) { console.error(`missing ${pj}`); process.exit(3); }
  const v = JSON.parse(readFileSync(pj, 'utf8')).version;
  if (v !== KOFFI_VERSION) { console.error(`${p} is ${v}, expected ${KOFFI_VERSION}`); process.exit(3); }
}
rmSync(out, { recursive: true, force: true });
const binding = join(out, `koffi-${KOFFI_VERSION}`);
for (const p of pkgs) cpSync(join(koffiDir, 'node_modules', ...p.split('/')), join(binding, 'node_modules', ...p.split('/')), { recursive: true });
const files = Object.fromEntries(list(binding).map((f) => [f, sha(join(binding, ...f.split('/')))]));
writeFileSync(join(binding, 'binding-manifest.json'), JSON.stringify({ package: 'koffi', version: KOFFI_VERSION, files }, null, 2) + '\n');

mkdirSync(join(out, 'operations'), { recursive: true });
const script = join(out, 'operations', 'workspace-inventory.cjs');
cpSync(join(root, 'scripts', 'hark', 'native-operations', 'workspace-inventory.cjs'), script);
const kernelVersion = basename(kernelDir);
const node = join(kernelDir, 'node', 'node.exe');
if (!existsSync(node)) { console.error(`missing kernel node runtime ${node}`); process.exit(3); }
const operations = {
  schema: 'companyos.native-job-operations.v1',
  operations: {
    'companyos:native-inventory': {
      operationId: 'workspace-inventory',
      executable: { resource: `agent-kernel/${kernelVersion}/node/node.exe`, sha256: sha(node) },
      inputs: [{ resource: 'native/operations/workspace-inventory.cjs', sha256: sha(script) }],
      args: ['{input:0}'],
      timeoutMs: 120000,
      environment: { TEMP: '{workspace}/.companyos/tmp', TMP: '{workspace}/.companyos/tmp' },
    },
  },
};
writeFileSync(join(out, 'operations.json'), JSON.stringify(operations, null, 2) + '\n');
console.log(JSON.stringify({ binding: { version: KOFFI_VERSION, files: Object.keys(files).length }, operations: Object.keys(operations.operations) }));
