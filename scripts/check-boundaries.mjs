#!/usr/bin/env node
/**
 * CompanyOS architecture boundary gate (Sprint 0, T0.13).
 *
 * Enforces the two laws that keep the Core industry-agnostic:
 *
 *   LAW 1 — Vocabulary:  packages/core/src and packages/contracts/src must not
 *            name any Industry-Pack concept (Coding, Git, Repository, Developer,
 *            CTO, Article, Video, Ecommerce) as an identifier.
 *   LAW 2 — Direction:   dependencies only ever point inward.
 *            core/contracts/observability <- persistence <- apps
 *            packs -> core (+contracts) and NEVER the reverse.
 *
 * Comments and string literals are stripped before the vocabulary scan, so a doc
 * comment *about* the rule (such as this one) does not trip it.
 *
 * Exit code 0 = clean. Exit code 1 = at least one violation (CI fails).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Root of the tree under test. Defaults to this repo; `--root <dir>` lets the
 * self-tests in scripts/tests/ run the gate over throw-away fixture trees.
 */
function resolveRoot(argv) {
  const index = argv.findIndex((arg) => arg === '--root' || arg.startsWith('--root='));
  if (index === -1) return fileURLToPath(new URL('..', import.meta.url));
  const arg = argv[index];
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error('--root requires a directory argument');
  }
  return resolve(value);
}

const ROOT = resolveRoot(process.argv.slice(2));

/** Words owned by Industry Packs — forbidden as identifiers in Core/Contracts. */
const FORBIDDEN_VOCABULARY = [
  { word: 'coding', owner: 'pack-coding', replacement: 'work / task / assignment' },
  { word: 'git', owner: 'pack-coding', replacement: 'versioned artifact store' },
  { word: 'repository', owner: 'pack-coding', replacement: 'EntityStore' },
  { word: 'developer', owner: 'pack-devcompany', replacement: 'WorkRole / contributor' },
  { word: 'cto', owner: 'pack-devcompany', replacement: 'RoleArchetype' },
  { word: 'article', owner: 'pack-content', replacement: 'WorkProduct' },
  { word: 'video', owner: 'pack-content', replacement: 'MediaAsset' },
  { word: 'ecommerce', owner: 'pack-commerce', replacement: 'DomainPack capability' },
];

/** Packages whose source is subject to LAW 1. */
const SCANNED_SOURCES = ['packages/core/src', 'packages/contracts/src'];

/** Allowed internal dependency edges (LAW 2). Everything else is a violation. */
const ALLOWED_INTERNAL_DEPS = {
  '@companyos/core': [],
  '@companyos/contracts': [],
  '@companyos/observability': [],
  '@companyos/persistence': ['@companyos/core', '@companyos/contracts'],
  // The engine is an outer-ring interpreter: Core contracts and ports ONLY.
  '@companyos/engine': ['@companyos/core'],
  '@companyos/desktop': [
    '@companyos/core',
    '@companyos/contracts',
    '@companyos/persistence',
    '@companyos/observability',
    // Desktop composes the workflow lifecycle service; it never reaches SQLite directly.
    '@companyos/engine',
  ],
  '@companyos/renderer': ['@companyos/contracts'],
};
/** Packages that may never be imported from the inner ring. */
const INNER_RING = ['@companyos/core', '@companyos/contracts', '@companyos/observability'];

const violations = [];
const notes = [];

const rel = (p) => relative(ROOT, p).split(sep).join('/');

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Remove comments and string/template literals, preserving line numbers. */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += blank(source[i]);
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          out += blank(source[i]) + blank(source[i + 1] ?? ' ');
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        out += blank(source[i]);
        i += 1;
      }
      out += ' ';
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------- LAW 1
console.log('▌ LAW 1 — Industry vocabulary must not exist in Core/Contracts');
for (const dir of SCANNED_SOURCES) {
  const files = walk(join(ROOT, dir)).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const lines = stripCommentsAndStrings(raw).split('\n');
    lines.forEach((line, idx) => {
      for (const { word, owner, replacement } of FORBIDDEN_VOCABULARY) {
        const re = new RegExp(`\\b${word}\\b`, 'i');
        if (re.test(line)) {
          violations.push(
            `LAW1  ${rel(file)}:${idx + 1}  forbidden word "${word}" (owned by ${owner}) — use ${replacement}`,
          );
        }
      }
    });
  }
  console.log(`   scanned ${files.length} source file(s) under ${dir}/`);
}

// ---------------------------------------------------------------- LAW 1b
console.log('▌ LAW 1b — Core/Contracts imports must stay inner-ring only');
for (const pkg of ['@companyos/core', '@companyos/contracts']) {
  const dir = pkg === '@companyos/core' ? 'packages/core/src' : 'packages/contracts/src';
  for (const file of walk(join(ROOT, dir)).filter((f) => f.endsWith('.ts'))) {
    const raw = readFileSync(file, 'utf8');
    const importRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(raw)) !== null) {
      const spec = m[1];
      const bad =
        spec.startsWith('@companyos/pack-') ||
        spec.startsWith('@companyos/desktop') ||
        spec.startsWith('@companyos/renderer') ||
        spec.startsWith('@companyos/persistence') ||
        spec.startsWith('@companyos/observability') ||
        spec === 'electron' ||
        spec === 'react' ||
        spec === 'react-dom';
      const bareThirdParty =
        !spec.startsWith('.') &&
        !spec.startsWith('node:') &&
        !spec.startsWith('@companyos/core') &&
        !spec.startsWith('@companyos/contracts') &&
        !spec.startsWith('node:');
      if (bad) {
        violations.push(`LAW1b ${rel(file)}  illegal import "${spec}" from ${pkg}`);
      } else if (bareThirdParty && !spec.startsWith('@companyos/')) {
        notes.push(
          `LAW1b ${rel(file)}  third-party runtime import "${spec}" in ${pkg} — Core is designed to be dependency-free (ADR-0005)`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------- LAW 2
console.log('▌ LAW 2 — Dependency direction (inner <- outer, never the reverse)');
const workspaceDirs = [
  ...(existsSync(join(ROOT, 'packages'))
    ? readdirSync(join(ROOT, 'packages')).map((d) => join('packages', d))
    : []),
  ...(existsSync(join(ROOT, 'apps')) ? readdirSync(join(ROOT, 'apps')).map((d) => join('apps', d)) : []),
];
for (const dir of workspaceDirs) {
  const manifestPath = join(ROOT, dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const name = manifest.name;
  const deps = Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  });
  const internal = deps.filter((d) => d.startsWith('@companyos/'));
  console.log(`   ${name}: internal deps [${internal.join(', ') || '-'}]`);

  if (name === '@companyos/core' && deps.length > 0) {
    violations.push(
      `LAW2  ${name} must have ZERO runtime dependencies; found [${deps.join(', ')}]`,
    );
  }
  if (INNER_RING.includes(name)) {
    for (const dep of internal) {
      if (INNER_RING.includes(dep) && dep !== name) {
        violations.push(`LAW2  ${name} must not import inner-ring sibling ${dep}`);
      }
      if (dep.startsWith('@companyos/pack-')) {
        violations.push(`LAW2  ${name} must not depend on Industry Pack ${dep}`);
      }
    }
  }
  const allowed = ALLOWED_INTERNAL_DEPS[name];
  if (allowed) {
    for (const dep of internal) {
      if (!allowed.includes(dep)) {
        violations.push(
          `LAW2  ${name} -> ${dep} is not an allowed edge; allowed: [${allowed.join(', ') || 'none'}]`,
        );
      }
    }
  }
  if (dir.startsWith('packages') && deps.some((d) => d.startsWith('@companyos/pack-'))) {
    violations.push(`LAW2  workspace package ${name} must not depend on an Industry Pack`);
  }
}

// ---------------------------------------------------------------- report
console.log('');
if (notes.length > 0) {
  console.log(`⚠  ${notes.length} note(s):`);
  for (const n of notes) console.log(`   ${n}`);
  console.log('');
}
if (violations.length === 0) {
  console.log('✅ Architecture boundary check PASSED — Core is industry-agnostic.');
  process.exit(0);
}
console.error(`❌ Architecture boundary check FAILED — ${violations.length} violation(s):`);
for (const v of violations) console.error(`   ${v}`);
process.exit(1);
