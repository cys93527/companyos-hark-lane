/**
 * STAGE 5B — RUNTIME EXECUTION CLOSURE derivation (Boss §3).
 *
 * Derives the set of embedded-runtime files that can actually EXECUTE or
 * feed execution, from the REAL package/runtime graph — never from a static
 * file-pattern guess over the whole tree:
 *
 *   1. Seeds:
 *      - the pinned CLI entry's compiled chunks (runtime/<cliEntry dir>/*.js);
 *      - every package the COMPOSITION mounts by name (the bundle
 *        cordis.patch.yml, the profile-patch template, the DSH-home template,
 *        the CLI package.json — the cordis loader loads plugins by configured
 *        name at runtime, so require-tracing alone under-approximates).
 *   2. Static import/require trace over BUILD OUTPUT (lib/dist/build) to a
 *      fixpoint, junction/realpath-aware (mirrors Node's node_modules walk).
 *   3. Per closure package, coverage is the CONSERVATIVE union — not just
 *      traced files — because child-process helpers (e.g. the windows-acl
 *      runner), lazy loads and chunk graphs are not statically visible:
 *        EXECUTABLE_CRITICAL  build-output JS/MJS/CJS (lib/dist/build/bin +
 *                               package root; test fixtures excluded by path)
 *        NATIVE_CRITICAL      .node/.exe/.dll/.ps1/.cmd/.bat anywhere in the
 *                             package
 *        CONFIG_CRITICAL      package.json + non-map JSON + non-i18n YAML in
 *                             build output + home/patch templates
 *        NON_EXECUTION_ASSET  docs, licenses, maps, TS source, i18n, tests
 *                             (recorded as counts only, NEVER hashed)
 *
 * Verdict contract (Boss §4/§8): every EXECUTABLE/CONFIG/NATIVE_CRITICAL file
 * carries a sha256 — 100% cryptographic coverage, NO sampling. A lazy or
 * dynamic load outside this closure fails loud at kernel startup, and the
 * full-kernel E2E gate proves the closure sufficient for real execution.
 *
 * @module scripts/lib/runtime-execution-closure
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const EXECUTABLE_EXT = /\.(?:js|mjs|cjs)$/iu;
const NATIVE_EXT = /\.(?:node|exe|dll|ps1|cmd|bat)$/iu;
const JSON_EXT = /\.json$/iu;
const YAML_EXT = /\.(?:yml|yaml)$/iu;
const NON_EXECUTION_DIR = /(^|\\)(tests?|__tests__|fixtures?|examples?|benchmarks?)(\\|$)/iu;
const NON_EXECUTION_FILE = /\.(?:map|tsbuildinfo)$/iu;
const I18N_YAML = /\.i18n\.ya?ml$/iu;
const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/iu;
const DIST_DIRS = ['lib', 'dist', 'build', 'bin'];

export const CLOSURE_MANIFEST_NAME = 'closure-manifest.json';
export const CLOSURE_VERSION = 1;

/** Junction-cycle-safe real walk of one directory subtree. */
const walkReal = (root, seenDirs = new Set()) => {
  const real = realpathSync(root);
  if (seenDirs.has(real)) return [];
  seenDirs.add(real);
  return readdirSync(real).flatMap((name) => {
    const full = join(real, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      const targetReal = realpathSync(full);
      if (seenDirs.has(targetReal)) return [];
      return statSync(full).isDirectory() ? walkReal(full, seenDirs) : [targetReal];
    }
    return st.isDirectory() ? walkReal(full, seenDirs) : [realpathSync(full)];
  });
};

/** Junction-cycle-safe walk that does NOT follow reparse dirs (links are handled separately). */
const walkNoLinks = (root) => {
  const seenDirs = new Set();
  const walk = (dir) => {
    const real = realpathSync(dir);
    if (seenDirs.has(real)) return [];
    seenDirs.add(real);
    return readdirSync(real).flatMap((name) => {
      const full = join(real, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) return statSync(full).isFile() ? [realpathSync(full)] : [];
      return st.isDirectory() ? walk(full) : [realpathSync(full)];
    });
  };
  return walk(root);
};

/** Static import/require specifiers in one compiled JS file. */
const SPEC_PATTERN = /(?:from\s*|import\s*|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/gu;
const staticSpecifiers = (code) => [...code.matchAll(SPEC_PATTERN)].map((m) => m[1]);

/** Resolve a relative specifier with Node's extension/index fallbacks. */
const resolveRelative = (fromFile, spec) => {
  const base = join(fromFile, '..', spec);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, join(base, 'index.js'), join(base, 'index.cjs')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  return null;
};

/** Resolve a bare specifier the way Node would from `fromDir`, over REAL paths. */
const resolveBare = (spec, fromDir, runtimeRootReal) => {
  let probeDir = fromDir;
  for (;;) {
    const candidate = join(probeDir, 'node_modules', spec);
    if (existsSync(candidate)) {
      const real = realpathSync(candidate);
      if (statSync(real).isDirectory()) return real;
    }
    const parent = join(probeDir, '..');
    const probeReal = realpathSync(probeDir);
    if (parent === probeDir || !probeReal.startsWith(runtimeRootReal)) return null;
    probeDir = parent;
  }
};

/** Extract '@scope/pkg' / 'pkg' names from composition YAML/JSON text (both `name:` YAML and `"name":` JSON spellings). */
const PATCH_NAME_PATTERN = /name["']?\s*:\s*["']?([@a-z0-9][a-z0-9._/-]*)/giu;
const SCOPED_LITERAL_PATTERN = /["'](@[a-z0-9-]+\/[a-z0-9-]+)["']/giu;
const compositionPackageNames = (texts) => {
  const names = new Set();
  for (const text of texts) {
    // Scoped package literals anywhere in the composition (bundle references,
    // "bundles": [...] arrays, plugin rows) are conservative seed candidates;
    // addPackage filters them by existence in the resolvable universe.
    for (const match of text.matchAll(SCOPED_LITERAL_PATTERN)) names.add(match[1]);
    for (const match of text.matchAll(PATCH_NAME_PATTERN)) {
      const raw = match[1];
      if (raw.startsWith('@')) names.add(raw.split('/').slice(0, 2).join('/'));
      else if (!/^(yml|yaml|json|js|ctx|process|env|number|string|true|false)$/iu.test(raw)) names.add(raw.split('/')[0]);
    }
  }
  return names;
};

/** Build-output dirs of a package (existing among lib/dist/build/bin). */
const buildOutputDirs = (pkgDir) =>
  DIST_DIRS.map((d) => join(pkgDir, d)).filter((d) => existsSync(d) && statSync(d).isDirectory());

/** Classify one managed-root-relative closure file. */
export const classifyClosureFile = (relativePath) => {
  if (NATIVE_EXT.test(relativePath)) return 'NATIVE_CRITICAL';
  if (EXECUTABLE_EXT.test(relativePath)) {
    if (NON_EXECUTION_DIR.test(relativePath) || TEST_FILE.test(relativePath)) return 'NON_EXECUTION_ASSET';
    return 'EXECUTABLE_CRITICAL';
  }
  if (I18N_YAML.test(relativePath)) return 'NON_EXECUTION_ASSET';
  if (JSON_EXT.test(relativePath)) return NON_EXECUTION_FILE.test(relativePath) ? 'NON_EXECUTION_ASSET' : 'CONFIG_CRITICAL';
  if (YAML_EXT.test(relativePath)) return NON_EXECUTION_DIR.test(relativePath) ? 'NON_EXECUTION_ASSET' : 'CONFIG_CRITICAL';
  return 'NON_EXECUTION_ASSET';
};

/**
 * Derive the execution closure for a materialized managed root.
 * @returns closure manifest object (callers persist it as closure-manifest.json).
 */
export const deriveRuntimeExecutionClosure = (input) => {
  const { managedRoot, manifest } = input;
  const runtimeRoot = manifest.runtimeRoot;
  const runtimeRootReal = realpathSync(runtimeRoot);
  const managedRootReal = realpathSync(managedRoot);
  /* ---- 1. seeds ---- */
  const compositionTexts = [readFileSync(manifest.profilePatchTemplate, 'utf8')];
  const bundlePatch = join(runtimeRoot, 'packages', 'bundle', 'sdk-minimal', 'cordis.patch.yml');
  if (existsSync(bundlePatch)) compositionTexts.push(readFileSync(bundlePatch, 'utf8'));
  const cliPkgJsonPath = join(runtimeRoot, 'apps', 'cli', 'package.json');
  if (existsSync(cliPkgJsonPath)) compositionTexts.push(readFileSync(cliPkgJsonPath, 'utf8'));
  const homeTemplateSeen = new Set();
  const homeTemplateFiles = existsSync(manifest.dshHomeTemplateDir) ? walkReal(manifest.dshHomeTemplateDir, homeTemplateSeen) : [];
  for (const file of homeTemplateFiles) {
    if (YAML_EXT.test(file) || JSON_EXT.test(file)) compositionTexts.push(readFileSync(file, 'utf8'));
  }
  const seedPackages = compositionPackageNames(compositionTexts);

  /* ---- 2. closure package fixpoint (trace BUILD OUTPUT only) ---- */
  const cliNodeModules = join(runtimeRoot, 'apps', 'cli', 'node_modules');
  const packageDirs = new Map(); // realDir -> name
  const pending = [];
  const addPackage = (pkgDir, name) => {
    if (pkgDir === null || !existsSync(pkgDir)) return false;
    const real = realpathSync(pkgDir);
    if (!real.startsWith(runtimeRootReal) || packageDirs.has(real) || !statSync(real).isDirectory()) return false;
    packageDirs.set(real, name);
    pending.push(real);
    return true;
  };
  for (const name of seedPackages) addPackage(join(cliNodeModules, ...name.split('/')), name);
  // The CLI package itself: its compiled chunks are the trace root AND closure code.
  addPackage(join(runtimeRoot, 'apps', 'cli'), 'apps/cli');

  const tracedFiles = new Set();
  const traceSpecifiers = (code, file) => {
    for (const spec of staticSpecifiers(code)) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec);
        if (target !== null) {
          // A relative import outside this package binds the containing package in.
          let probe = join(target, '..');
          let probeReal = realpathSync(probe);
          while (!packageDirs.has(probeReal) && probeReal.startsWith(runtimeRootReal)) {
            const parent = join(probe, '..');
            if (parent === probe) break;
            probe = parent;
            probeReal = realpathSync(probe);
          }
        }
        continue;
      }
      if (spec.startsWith('node:')) continue;
      // Windows drive-absolute specifiers ("C:/...") are never resolvable
      // packages; path.join would turn them into drive-relative paths.
      if (/^[a-zA-Z]:[\\/]/u.test(spec) || spec.startsWith('/') || spec.startsWith('\\')) continue;
      const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (bare === '' || /^[a-zA-Z]:$/u.test(bare)) continue;
      const resolved = resolveBare(bare, file, runtimeRootReal)
        ?? (existsSync(join(cliNodeModules, ...bare.split('/'))) ? realpathSync(join(cliNodeModules, ...bare.split('/'))) : null);
      if (resolved !== null) addPackage(resolved, bare);
    }
  };
  while (pending.length > 0) {
    const pkgDir = pending.shift();
    const walkSeen = new Set();
    // Root-level JS is traced too: packages whose entry sits at the package root
    // (main: "index.js") resolve their deps from there, not from a dist dir.
    for (const name of readdirSync(pkgDir)) {
      const rootJs = join(pkgDir, name);
      if (existsSync(rootJs) && statSync(rootJs).isFile() && EXECUTABLE_EXT.test(name)) {
        if (!tracedFiles.has(rootJs)) {
          tracedFiles.add(rootJs);
          traceSpecifiers(readFileSync(rootJs, 'utf8'), rootJs);
        }
      }
    }
    for (const distDir of buildOutputDirs(pkgDir)) {
      for (const file of walkReal(distDir, walkSeen)) {
        if (!EXECUTABLE_EXT.test(file) || tracedFiles.has(file)) continue;
        tracedFiles.add(file);
        traceSpecifiers(readFileSync(file, 'utf8'), file);
      }
    }
  }

  /* ---- 2b. resolvable-universe fixpoint ----
   * A closure package's own node_modules junctions are part of its resolution
   * surface: the runtime resolves the package's deps THROUGH them. Every
   * junction target becomes a closure package too (iterated to fixpoint), so
   * a staged tree never carries a link whose target has no verified files. */
  for (;;) {
    const before = packageDirs.size;
    for (const pkgDir of [...packageDirs.keys()]) {
      const nmDir = join(pkgDir, 'node_modules');
      if (!existsSync(nmDir)) continue;
      const visit = (nm) => {
        for (const child of readdirSync(nm)) {
          const childPath = join(nm, child);
          let st;
          try {
            st = lstatSync(childPath);
          } catch {
            continue;
          }
          if (st.isSymbolicLink()) {
            let target;
            try {
              target = realpathSync(childPath);
            } catch {
              continue;
            }
            if (statSync(target).isDirectory()) addPackage(target, child);
          } else if (st.isDirectory() && child.startsWith('@')) {
            visit(childPath);
          }
        }
      };
      visit(nmDir);
    }
    if (packageDirs.size === before) break;
  }

  /* ---- 3. closure files (managed-root-relative, classified + hashed) ---- */
  const files = new Map();
  const addFile = (absolutePath, cls) => {
    const relative = absolutePath.slice(managedRootReal.length + 1).split(sep).join('/');
    if (files.has(relative)) return;
    if (cls === undefined) cls = classifyClosureFile(relative);
    if (cls === 'NON_EXECUTION_ASSET') return;
    files.set(relative, { class: cls, sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex') });
  };
  const addPackageCoverage = (pkgDir, name) => {
    if (!realpathSync(pkgDir).startsWith(runtimeRootReal)) {
      throw new Error(`closure: package "${String(name)}" resolved outside the runtime root (${pkgDir})`);
    }
    // FULL-package walk: package layouts vary (semver keeps index.js + internal/
    // at the root; prebuilds bury .node anywhere), so coverage is the classified
    // union of every file in the package — the classifier excludes docs/tests/
    // maps/TS-source as NON_EXECUTION_ASSET. Junctioned node_modules inside the
    // package resolve to their real paths; non-closure deps reached only through
    // them are pulled in conservatively (what the child could load is covered).
    for (const file of walkNoLinks(pkgDir)) addFile(file);
    const pkgJson = join(pkgDir, 'package.json');
    if (existsSync(pkgJson)) addFile(pkgJson);
  };
  for (const [pkgDir, name] of packageDirs) addPackageCoverage(pkgDir, name);
  for (const file of homeTemplateFiles) addFile(file);
  addFile(manifest.profilePatchTemplate);
  // LIVE-SMOKE-FIX-08C: the headless shell guard is EXECUTION-CRITICAL config — the
  // pwsh terminal launches with `-File <guard>`; a staged tree missing it fails every
  // pwsh tool at PTY startup. Explicit CONFIG_CRITICAL (a root-level .ps1 would
  // otherwise classify as a NON_EXECUTION_ASSET).
  if (manifest.shellGuardScript !== undefined && existsSync(manifest.shellGuardScript)) {
    addFile(manifest.shellGuardScript, 'CONFIG_CRITICAL');
  }
  if (existsSync(bundlePatch)) addFile(bundlePatch);

  /* ---- 3a. native binding packages in the .pnpm store ----
   * Native addons are dlopen'ed BY CONSTRUCTED NAME (platform-suffixed optional
   * dependencies resolved through dynamic loader machinery) — invisible to
   * static tracing by design. Coverage: every .pnpm store package whose NAME is
   * declared by a closure package (dependencies/optionalDependencies) and that
   * carries a .node binding joins the closure with its whole tree. Build-time
   * binding packages (bundlers, linters) are not declared by closure packages
   * and stay out. */
  const declaredDeps = new Set();
  const readDeps = (pkgJsonPath) => {
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      for (const section of [pkgJson.dependencies, pkgJson.optionalDependencies, pkgJson.peerDependencies]) {
        for (const depName of Object.keys(section ?? {})) declaredDeps.add(depName);
      }
    } catch { /* unparseable identity still hashes via addPackageCoverage */ }
  };
  for (const pkgDir of packageDirs.keys()) readDeps(join(pkgDir, 'package.json'));
  const pnpmStore = join(runtimeRoot, 'node_modules', '.pnpm');
  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      const at = entry.lastIndexOf('@');
      if (at <= 0) continue;
      const storeName = entry.slice(0, at).replaceAll('+', '/');
      if (!declaredDeps.has(storeName)) continue;
      const storeNm = join(pnpmStore, entry, 'node_modules');
      if (!existsSync(storeNm)) continue;
      const candidates = [];
      for (const child of readdirSync(storeNm)) {
        const childDir = join(storeNm, child);
        if (!existsSync(childDir) || !statSync(childDir).isDirectory()) continue;
        if (child.startsWith('@')) {
          for (const inner of readdirSync(childDir)) {
            const innerDir = join(childDir, inner);
            if (statSync(innerDir).isDirectory()) candidates.push(realpathSync(innerDir));
          }
        } else {
          candidates.push(realpathSync(childDir));
        }
      }
      for (const pkgDir of candidates) {
        let hasNative = false;
        for (const file of walkNoLinks(pkgDir)) {
          if (NATIVE_EXT.test(file) && file.endsWith('.node')) hasNative = true;
        }
        if (hasNative) {
          for (const file of walkNoLinks(pkgDir)) addFile(file);
          addFile(join(pkgDir, 'package.json'));
        }
      }
    }
  }

  /* ---- 3b. junction links of the resolvable universe ----
   * pnpm materializes node_modules entries as JUNCTIONS into real package dirs.
   * The closure file table holds the REAL files; the staged tree must ALSO
   * recreate the link entries or the child's resolution fails. Only links whose
   * target subtree carries closure files are recreated (a staged link is a
   * self-contained pointer into the stage, never to the source tree). */
  const toRelative = (abs) => abs.slice(managedRootReal.length + 1).split(sep).join('/');
  const closureHasPrefix = (absReal) => {
    const prefix = toRelative(absReal);
    for (const relative of files.keys()) {
      if (relative === prefix || relative.startsWith(`${prefix}/`)) return true;
    }
    return false;
  };
  const links = [];
  const linkSeen = new Set();
  const enumerateLinks = (dirReal, dirRel) => {
    let entries;
    try {
      entries = readdirSync(dirReal);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dirReal, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      const linkRelPath = dirRel === '' ? name : `${dirRel}/${name}`;
      if (st.isSymbolicLink()) {
        if (linkSeen.has(linkRelPath)) continue;
        linkSeen.add(linkRelPath);
        let targetReal;
        try {
          targetReal = realpathSync(full);
        } catch {
          continue; // dangling link: nothing to recreate
        }
        if (st.isDirectory() || statSync(full).isDirectory()) {
          if (closureHasPrefix(targetReal)) {
            links.push({ link: linkRelPath, target: toRelative(targetReal) });
          }
          enumerateLinks(targetReal, toRelative(targetReal));
        }
      } else if (st.isDirectory()) {
        enumerateLinks(full, linkRelPath);
      }
    }
  };
  // Both node_modules roots are enumerated: the CLI's own universe AND the
  // runtime-level store (pnpm hoists fallbacks to node_modules/.pnpm/node_modules,
  // which dynamically-loading code can reach and static tracing cannot see).
  const hoistedReal = join(runtimeRoot, 'node_modules', '.pnpm', 'node_modules');
  if (existsSync(hoistedReal)) {
    for (const file of walkNoLinks(hoistedReal)) addFile(file);
  }
  for (const name2 of existsSync(join(runtimeRoot, 'node_modules')) ? readdirSync(join(runtimeRoot, 'node_modules')) : []) {
    const top = join(runtimeRoot, 'node_modules', name2);
    let st;
    try {
      st = lstatSync(top);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink() && st.isFile()) addFile(top);
  }
  for (const root of [cliNodeModules, join(runtimeRoot, 'node_modules')]) {
    if (existsSync(root)) {
      const rootReal = realpathSync(root);
      enumerateLinks(rootReal, toRelative(rootReal));
    }
  }

  const classes = { EXECUTABLE_CRITICAL: 0, CONFIG_CRITICAL: 0, NATIVE_CRITICAL: 0 };
  for (const entry of files.values()) classes[entry.class] += 1;
  // Generation identity: sha256 over the closure file table alone. The manifest
  // records sha256(closure bytes) as closureGeneration — the resolver re-derives
  // BOTH on every resolve, so editing either artifact alone fails loud.
  const generation = createHash('sha256')
    .update(JSON.stringify({ files: Object.fromEntries(files) }))
    .digest('hex');

  return {
    version: CLOSURE_VERSION,
    generation,
    derivation: {
      method: 'composition-declared packages + static import trace over build output; per-package conservative union (dist JS + configs + native scan)',
      cliEntry: manifest.cliEntry,
      compositionSeedPackages: [...seedPackages].sort(),
      resolvedClosurePackages: packageDirs.size,
      junctionLinksRecreated: links.length,
      nonExecutionAssetsExcluded: 'docs/licenses/maps/ts-source/tests (never hashed, never verified)',
    },
    counts: {
      EXECUTABLE_CRITICAL: classes.EXECUTABLE_CRITICAL,
      CONFIG_CRITICAL: classes.CONFIG_CRITICAL,
      NATIVE_CRITICAL: classes.NATIVE_CRITICAL,
      totalCritical: classes.EXECUTABLE_CRITICAL + classes.CONFIG_CRITICAL + classes.NATIVE_CRITICAL,
      samplingUsed: false,
    },
    files: Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    links: [...links].sort((a, b) => (a.link < b.link ? -1 : 1)),
  };
};
