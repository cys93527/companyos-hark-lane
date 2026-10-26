#!/usr/bin/env node
/**
 * Hark lane H15 — package the materialized, exact-pinned DSH kernel as the
 * RELOCATABLE install resource `resources/agent-kernel/<version>/`
 * (DSH_KERNEL_DISTRIBUTION_UPDATE_SPEC §3).
 *
 * Input: a managed root produced by scripts/materialize-embedded-dsh.mjs (official
 * repo at the pinned SHA, frozen-lockfile install, unmodified host build, execution
 * closure). Output (layoutVersion 2):
 *
 *   <out>/<AGENT_KERNEL_VERSION_DIR>/
 *     manifest.json            exact pin + managed-root-relative paths + kernelVersion
 *                              + nodeRuntime + closureGeneration
 *     closure-manifest.json    100% sha256 of every execution-critical file (+ node)
 *     runtime/...              ONLY the closure files (pnpm junctions are recreated
 *                              from closure.links when the app stages the kernel)
 *     node/node(.exe)          pinned Node runtime, sha256-verified against the
 *                              official SHASUMS256.txt when given
 *     sbom.cdx.json            CycloneDX 1.5 SBOM of every shipped package
 *     packages.txt             name@version allowlist snapshot (update-gate diff input)
 *     licenses/INDEX.json      per-package licence + licence file path
 *     licenses/*.md|LICENSE    upstream root LICENSE, THIRD_PARTY_NOTICES, SAFETY
 *     (every package-level LICENSE/NOTICE file is kept beside its package)
 *
 * Refuses (exit != 0): unpinned/dirty source, a denylisted (worldview/account/
 * telemetry) package in the shipped closure, a node binary whose sha256 is not
 * the official one, a closure file missing from the managed root.
 *
 * Usage: node scripts/hark/pack-agent-kernel.mjs --managed <dir> --out <dir>
 *          --node <path to node executable> [--node-shasums <SHASUMS256.txt> --node-dist-name win-x64/node.exe]
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const AGENT_KERNEL_VERSION_DIR = 'dsh-v0.2.0-rc.2';
export const PINNED_SHA = '639ed015397290b3745d163aafe02ffee4aa3f84';
export const PINNED_TAG = 'dsh-v0.2.0-rc.2';

import { KERNEL_DENYLIST } from '../lib/runtime-execution-closure.mjs';

/** The shipped-closure denylist (single source: scripts/lib/runtime-execution-closure.mjs). */
export const DENYLIST = KERNEL_DENYLIST;

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const die = (code, message) => { console.error(`[pack-agent-kernel] REFUSED ${code}: ${message}`); process.exit(1); };
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const main = () => {
  const managed = arg('managed');
  const outRoot = arg('out');
  const nodePath = arg('node');
  if (!managed || !outRoot || !nodePath) die('USAGE', 'usage: --managed <dir> --out <dir> --node <node executable>');
  const manifest = JSON.parse(readFileSync(join(managed, 'manifest.json'), 'utf8'));
  const closure = JSON.parse(readFileSync(join(managed, 'closure-manifest.json'), 'utf8'));
  if (manifest.upstreamSha !== PINNED_SHA || manifest.upstreamTag !== PINNED_TAG) die('PIN', `manifest pin ${manifest.upstreamSha}/${manifest.upstreamTag} != ${PINNED_SHA}/${PINNED_TAG}`);
  if (createHash('sha256').update(readFileSync(join(managed, 'closure-manifest.json'))).digest('hex') !== manifest.closureGeneration) die('CLOSURE_DRIFT', 'closure-manifest.json does not match closureGeneration');
  const runtimeAbs = manifest.runtimeRoot;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runtimeAbs, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: runtimeAbs, encoding: 'utf8' }).trim();
    if (head !== PINNED_SHA) die('PIN', `runtime HEAD ${head}`);
    if (dirty !== '') die('DIRTY', `tracked upstream files modified:\n${dirty}`);
  } catch (error) {
    if (error && error.status !== undefined) die('GIT', String(error.message));
    throw error;
  }
  const rel = (abs) => abs.slice(managed.length + 1).split('\\').join('/');
  const runtimeRel = rel(runtimeAbs);

  const vdir = join(outRoot, AGENT_KERNEL_VERSION_DIR);
  rmSync(vdir, { recursive: true, force: true });
  mkdirSync(vdir, { recursive: true });

  /* ---- 2. package inventory (nearest package.json of every closure file) ---- */
  const packages = new Map(); // relDir -> {name, version, license}
  const pkgDirOf = (relative) => {
    let parts = relative.split('/');
    parts = parts.slice(0, -1);
    while (parts.length > 0) {
      const candidate = parts.join('/');
      if (packages.has(candidate)) return candidate;
      const pj = join(managed, ...parts, 'package.json');
      if (existsSync(pj)) {
        let parsed = null;
        try { parsed = JSON.parse(readFileSync(pj, 'utf8')); } catch { parsed = null; }
        if (parsed && typeof parsed.name === 'string' && typeof parsed.version === 'string') {
          const license = typeof parsed.license === 'string' ? parsed.license
            : parsed.license && typeof parsed.license.type === 'string' ? parsed.license.type
              : Array.isArray(parsed.licenses) ? parsed.licenses.map((l) => l.type ?? l).join(' OR ') : 'UNDECLARED';
          packages.set(candidate, { name: parsed.name, version: parsed.version, license, private: parsed.private === true });
          return candidate;
        }
      }
      parts = parts.slice(0, -1);
    }
    return null;
  };
  for (const relative of Object.keys(closure.files)) pkgDirOf(relative);

  /* ---- 3. denylist ---- */
  const denied = [...packages.values()].filter((p) => DENYLIST.some((re) => re.test(p.name)));
  if (denied.length > 0) die('DENYLIST', `worldview/account packages in the shipped closure: ${[...new Set(denied.map((p) => p.name))].sort().join(', ')}`);

  /* ---- 1. closure files only ---- */
  for (const relative of Object.keys(closure.files)) {
    const source = join(managed, ...relative.split('/'));
    if (!existsSync(source)) die('CLOSURE_FILE_MISSING', relative);
    if (sha256(source) !== closure.files[relative].sha256) die('CLOSURE_FILE_DRIFT', relative);
    const target = join(vdir, ...relative.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }

  /* ---- 4. licences ---- */
  const LICENSE_FILE = /^(licen[cs]e|copying|notice|third_party_notices)(\.[a-z0-9]+)?$/iu;
  const upstreamRootLicense = join(runtimeAbs, 'LICENSE');
  const index = [];
  for (const [relDir, pkg] of [...packages.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const abs = join(managed, ...relDir.split('/'));
    const files = readdirSync(abs).filter((name) => LICENSE_FILE.test(name) && statSync(join(abs, name)).isFile());
    for (const name of files) {
      const target = join(vdir, ...relDir.split('/'), name);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(abs, name), target);
    }
    const workspacePkg = relDir.startsWith(`${runtimeRel}/`) && !relDir.includes('node_modules');
    index.push({
      name: pkg.name, version: pkg.version, license: pkg.license, path: relDir,
      licenseFiles: files.map((f) => `${relDir}/${f}`),
      // Upstream workspace packages are covered by the repository root MIT LICENSE.
      coveredBy: files.length === 0 && workspacePkg ? 'licenses/LICENSE (deepseek-harness root, MIT)' : null,
    });
  }
  const licensesDir = join(vdir, 'licenses');
  mkdirSync(licensesDir, { recursive: true });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'SAFETY.md']) {
    const src = join(runtimeAbs, name);
    if (!existsSync(src)) die('UPSTREAM_LICENSE_MISSING', name);
    copyFileSync(src, join(licensesDir, name));
  }
  if (!readFileSync(upstreamRootLicense, 'utf8').includes('MIT License')) die('LICENSE', 'upstream root LICENSE is not MIT');
  const uncovered = index.filter((p) => p.licenseFiles.length === 0 && p.coveredBy === null);
  writeFileSync(join(licensesDir, 'INDEX.json'), JSON.stringify({ upstream: { repo: manifest.upstreamRepo, sha: PINNED_SHA, tag: PINNED_TAG, license: 'MIT' }, packages: index, packagesWithoutLicenseFile: uncovered.map((p) => `${p.name}@${p.version} (${p.license})`) }, null, 2) + '\n');

  /* ---- 5. pinned Node runtime ---- */
  const nodeName = process.platform === 'win32' || nodePath.toLowerCase().endsWith('.exe') ? 'node.exe' : 'node';
  const nodeRel = `node/${nodeName}`;
  const nodeTarget = join(vdir, 'node', nodeName);
  mkdirSync(dirname(nodeTarget), { recursive: true });
  copyFileSync(nodePath, nodeTarget);
  const nodeSha = sha256(nodeTarget);
  const nodeVersion = execFileSync(nodeTarget, ['--version'], { encoding: 'utf8' }).trim();
  let nodeOfficial = 'NOT_CHECKED';
  const shasums = arg('node-shasums');
  if (shasums !== undefined) {
    const distName = arg('node-dist-name') ?? 'win-x64/node.exe';
    const line = readFileSync(shasums, 'utf8').split(/\r?\n/u).find((l) => l.trim().endsWith(`  ${distName}`));
    if (line === undefined) die('NODE_SHASUMS', `no ${distName} line in SHASUMS256.txt`);
    if (line.split(/\s+/u)[0].toLowerCase() !== nodeSha) die('NODE_SHA', `${distName} sha256 ${nodeSha} is not the official ${line.split(/\s+/u)[0]}`);
    nodeOfficial = `MATCHES official SHASUMS256.txt (${distName})`;
  }
  const nodeLicense = join(dirname(nodePath), 'LICENSE');
  if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(vdir, 'node', 'LICENSE'));

  /* ---- 6. closure rewrite (relative to the new root; + node) ---- */
  const files = { ...closure.files, [nodeRel]: { class: 'NATIVE_CRITICAL', sha256: nodeSha } };
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  const counts = { EXECUTABLE_CRITICAL: 0, CONFIG_CRITICAL: 0, NATIVE_CRITICAL: 0 };
  for (const entry of Object.values(sorted)) counts[entry.class] += 1;
  const generation = createHash('sha256').update(JSON.stringify({ files: sorted })).digest('hex');
  const packedClosure = {
    ...closure,
    generation,
    derivation: { ...closure.derivation, packagedBy: 'scripts/hark/pack-agent-kernel.mjs', nodeRuntimeAdded: nodeRel },
    counts: { ...counts, totalCritical: counts.EXECUTABLE_CRITICAL + counts.CONFIG_CRITICAL + counts.NATIVE_CRITICAL, samplingUsed: false },
    files: sorted,
  };
  const closureText = JSON.stringify(packedClosure);
  writeFileSync(join(vdir, 'closure-manifest.json'), closureText, 'utf8');

  /* ---- 7. SBOM + allowlist snapshot ---- */
  const kernelVersion = JSON.parse(readFileSync(join(runtimeAbs, 'apps', 'cli', 'package.json'), 'utf8')).version;
  const components = [...new Map(index.map((p) => [`${p.name}@${p.version}`, p])).values()]
    .sort((a, b) => (`${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1))
    .map((p) => ({ type: 'library', name: p.name, version: p.version, purl: `pkg:npm/${p.name.replace('@', '%40')}@${p.version}`, licenses: [{ expression: p.license }] }));
  components.push({ type: 'application', name: 'node', version: nodeVersion, hashes: [{ alg: 'SHA-256', content: nodeSha }], licenses: [{ license: { id: 'MIT' } }] });
  const sbom = {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: {
      component: { type: 'application', name: '@deepseek-ai/dsh', version: kernelVersion, licenses: [{ license: { id: 'MIT' } }],
        externalReferences: [{ type: 'vcs', url: `${manifest.upstreamRepo}/tree/${PINNED_SHA}` }] },
      properties: [{ name: 'companyos:closureGeneration', value: generation }, { name: 'companyos:upstreamTag', value: PINNED_TAG }],
    },
    components,
  };
  writeFileSync(join(vdir, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2) + '\n');
  writeFileSync(join(vdir, 'packages.txt'), [...new Set(index.map((p) => `${p.name}@${p.version}`))].sort().join('\n') + '\n');

  /* ---- 8. relocatable manifest ---- */
  const relOf = (abs) => rel(abs);
  const packed = {
    ...manifest,
    layoutVersion: 2,
    kernelVersion,
    runtimeRoot: runtimeRel,
    dshHomeTemplateDir: relOf(manifest.dshHomeTemplateDir),
    profilePatchTemplate: relOf(manifest.profilePatchTemplate),
    ...(manifest.shellGuardScript === undefined ? {} : { shellGuardScript: relOf(manifest.shellGuardScript) }),
    nodeRuntime: { path: nodeRel, version: nodeVersion, sha256: nodeSha, official: nodeOfficial },
    sbom: 'sbom.cdx.json',
    licenses: 'licenses/INDEX.json',
    closureGeneration: createHash('sha256').update(closureText).digest('hex'),
  };
  writeFileSync(join(vdir, 'manifest.json'), JSON.stringify(packed, null, 2) + '\n');
  let bytes = 0;
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else bytes += st.size; } };
  walk(vdir);
  console.log(JSON.stringify({
    packed: vdir, kernelVersion, upstreamSha: PINNED_SHA, packages: packages.size, components: components.length,
    closureFiles: Object.keys(sorted).length, links: (closure.links ?? []).length, node: { version: nodeVersion, sha256: nodeSha, official: nodeOfficial },
    packagesWithoutLicenseFile: uncovered.length, bytes, generation, basename: basename(vdir),
  }, null, 2));
};

main();
