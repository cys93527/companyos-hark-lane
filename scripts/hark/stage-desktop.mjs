#!/usr/bin/env node
// Hark lane H8: assemble the portable CompanyOS desktop app (no new dependencies).
// Usage: node scripts/hark/stage-desktop.mjs <electronDistDir> <outDir> [<agentKernelDir> [<nativeJobDir> [<isolationDir>]]]
//   H16b-3: <isolationDir> = setup.ps1 + wfp-persistent.cs + companyos-isolated-launch.exe (built in-box csc),
//   copied to <out>/resources/isolation (the app's start-time status check + the isolated kernel launcher).
//   H15b: <nativeJobDir> = the packed native.job resource (scripts/hark/pack-native-job.mjs), copied to
//   <out>/resources/native (pinned koffi binding + manifest, operations.json, operation scripts).
//   H15: <agentKernelDir> = the packed resources/agent-kernel tree (scripts/hark/pack-agent-kernel.mjs);
//   it is copied verbatim to <out>/resources/agent-kernel (immutable install resource).
// Requires `pnpm run build` first. Layout:
//   <out>/CompanyOS.exe (renamed electron.exe) + Electron runtime files
//   <out>/resources/app/{package.json, apps/desktop/{dist,preload,package.json}, apps/renderer/dist,
//                        node_modules/@companyos/<pkg>/{package.json,dist}, node_modules/<third-party prod deps>}
// Writes <out>/../stage-manifest.json (every file + sha256) for evidence.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [electronDist, out, agentKernel, nativeJob, isolation] = process.argv.slice(2);
if (!electronDist || !out) { console.error('usage: stage-desktop.mjs <electronDistDir> <outDir>'); process.exit(2); }
const must = (p) => { if (!existsSync(p)) { console.error(`missing: ${p}`); process.exit(3); } return p; };

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(must(electronDist), out, { recursive: true });
rmSync(join(out, 'resources', 'default_app.asar'), { force: true });
renameSync(must(join(out, 'electron.exe')), join(out, 'CompanyOS.exe'));

const app = join(out, 'resources', 'app');
if (agentKernel) {
  cpSync(must(agentKernel), join(out, 'resources', 'agent-kernel'), { recursive: true });
  console.log(`staged agent kernel from ${agentKernel}`);
}
if (nativeJob) {
  cpSync(must(nativeJob), join(out, 'resources', 'native'), { recursive: true });
  console.log(`staged native.job resource from ${nativeJob}`);
}
if (isolation) {
  for (const required of ['setup.ps1', 'wfp-persistent.cs', 'companyos-isolated-launch.exe']) must(join(isolation, required));
  cpSync(must(isolation), join(out, 'resources', 'isolation'), { recursive: true });
  console.log(`staged isolation helper + launcher from ${isolation}`);
}
const desktopPkg = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
mkdirSync(app, { recursive: true });
writeFileSync(join(app, 'package.json'), JSON.stringify({
  name: 'companyos', productName: 'CompanyOS', version: desktopPkg.version, private: true, type: 'module',
  main: 'apps/desktop/dist/main.js',
}, null, 2));
const copy = (from, to) => cpSync(must(join(root, from)), join(app, to), { recursive: true, filter: (s) => !s.endsWith('.tsbuildinfo') && !s.endsWith('.map') });
copy('apps/desktop/dist', 'apps/desktop/dist');
copy('apps/desktop/preload', 'apps/desktop/preload');
copy('apps/desktop/package.json', 'apps/desktop/package.json');
copy('apps/renderer/dist', 'apps/renderer/dist');

// Workspace packages (prod dependency closure from apps/desktop) + their third-party prod deps.
const workspaceDir = { };
for (const name of readdirSync(join(root, 'packages'))) {
  const pj = join(root, 'packages', name, 'package.json');
  if (existsSync(pj)) workspaceDir[JSON.parse(readFileSync(pj, 'utf8')).name] = join(root, 'packages', name);
}
const seen = new Set();
const visit = (fromDir, deps) => {
  for (const dep of Object.keys(deps ?? {})) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const target = join(app, 'node_modules', ...dep.split('/'));
    let srcDir;
    if (workspaceDir[dep]) {
      srcDir = workspaceDir[dep];
      mkdirSync(target, { recursive: true });
      cpSync(join(srcDir, 'package.json'), join(target, 'package.json'));
      // Honour the package's own "files" list (persistence ships migrations/ beside dist/).
      const entries = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8')).files ?? ['dist'];
      for (const entry of entries) {
        cpSync(must(join(srcDir, entry)), join(target, entry), { recursive: true, filter: (s) => !s.endsWith('.tsbuildinfo') && !s.endsWith('.map') });
      }
    } else {
      srcDir = realpathSync(must(join(fromDir, 'node_modules', ...dep.split('/'))));
      cpSync(srcDir, target, { recursive: true, dereference: true });
    }
    const pkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'));
    // pnpm puts a third-party package's own deps beside it in .pnpm/<id>/node_modules.
    visit(workspaceDir[dep] ? srcDir : join(srcDir, ...dep.split('/').map(() => '..'), '..'), pkg.dependencies);
  }
};
visit(join(root, 'apps/desktop'), desktopPkg.dependencies);

// Self-check: every migrations directory the staged persistence package resolves must exist.
const persistence = await import(new URL(`file:///${join(app, 'node_modules/@companyos/persistence/dist/index.js').split('\\').join('/').replace(/^\/+/u, '')}`).href);
const missingDirs = Object.entries(persistence)
  .filter(([k, v]) => /MigrationsDir$/u.test(k) && typeof v === 'function')
  .map(([k, v]) => [k, v()])
  .filter(([, dir]) => !existsSync(dir));
if (missingDirs.length > 0) { console.error('staged migrations missing:', JSON.stringify(missingDirs)); process.exit(4); }
console.log('staged migrations: all resolvable directories exist');

const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(out);
const manifest = files.sort().map(p => ({ path: relative(out, p).split('\\').join('/'), bytes: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') }));
writeFileSync(join(out, '..', 'stage-manifest.json'), JSON.stringify({ packages: [...seen].sort(), files: manifest }, null, 2));
console.log(`staged ${manifest.length} files; packages: ${[...seen].sort().join(', ')}`);
