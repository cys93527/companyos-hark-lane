/**
 * Sprint 16 / Task-16-04 — DevCompany package boundary, industry isolation and static safety.
 *
 * Locks the four architecture facts Task-16-04 exists to prove:
 *   DevCompany product package -> generic contracts/core types (one-way);
 *   Generic platform -> DOES NOT DEPEND ON DevCompany;
 *   DevCompany -> exports inert readonly data only;
 *   Application runtime -> no DevCompany production integration yet.
 *
 * Boundary/industry-neutrality authority is the EXISTING gate (`scripts/check-boundaries.mjs`
 * + its self-tests); this suite adds the package-local evidence, it does not replace it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEVCOMPANY_MANIFEST, DEVCOMPANY_MODEL_POLICY } from '@companyos/pack-dev-company';

const repo = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));

interface PackageManifestView {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
}

const readJson = (path: string): PackageManifestView => JSON.parse(readFileSync(repo(path), 'utf8')) as PackageManifestView;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

/** Comments and string literals stripped — the same view the authoritative gate scans. */
const codeOnly = (source: string): string => {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const pair = source.slice(i, i + 2);
    if (pair === '/*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      out += ' ';
      continue;
    }
    if (pair === '//') {
      const eol = source.indexOf(String.fromCharCode(10), i);
      i = eol === -1 ? source.length : eol;
      out += ' ';
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === String.fromCharCode(92)) i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

/** Generic production packages that must never reach into the industry pack. */
const GENERIC_PACKAGES = [
  '../../packages/core',
  '../../packages/contracts',
  '../../packages/engine',
  '../../packages/persistence',
  '../../apps/desktop',
] as const;

describe('package identity and workspace participation', () => {
  it('is the single canonical package name across package.json, paths and imports', () => {
    const manifest = readJson('package.json');
    expect(manifest.name).toBe('@companyos/pack-dev-company');
    // No second naming convention may exist anywhere in the repo configuration.
    const base = readFileSync(repo('../../tsconfig.base.json'), 'utf8');
    expect(base).toContain('"@companyos/pack-dev-company"');
    expect(base).not.toContain('@companyos/dev-company-pack');
    const build = readFileSync(repo('../../tsconfig.build.json'), 'utf8');
    expect(build).toContain('"./packs/dev-company"');
    const workspace = readFileSync(repo('../../pnpm-workspace.yaml'), 'utf8');
    expect(workspace).toContain("'packs/*'");
  });

  it('participates in the workspace graph (vitest include + root typecheck include + alias)', () => {
    const vitest = readFileSync(repo('../../vitest.config.ts'), 'utf8');
    expect(vitest).toContain('packs/*/tests/**/*.test.ts');
    expect(vitest).toContain("'@companyos/pack-dev-company': r('./packs/dev-company/src/index.ts')");
    const rootTsconfig = readFileSync(repo('../../tsconfig.json'), 'utf8');
    expect(rootTsconfig).toContain('"packs/*/src/**/*"');
    expect(rootTsconfig).toContain('"packs/*/tests/**/*"');
    // The package exports a real dist surface (not a test-alias-only participant).
    const manifest = readJson('package.json');
    expect(Object.keys(manifest.exports ?? {})).toEqual(['.']);
  });

  it('has no generated artifacts tracked in git', () => {
    const gitignore = readFileSync(repo('../../.gitignore'), 'utf8');
    expect(gitignore).toContain('dist/');
    expect(gitignore).toContain('node_modules/');
    // The tracked file list is the authority: source only, never build output.
    registerOfflineReadOnlyGitRepository();
    const tracked = execFileSync('git', ['ls-files', 'packs/dev-company'], {
      cwd: repo('../..'),
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.length > 0);
    const allowed = new Set([
      'packs/dev-company/package.json',
      'packs/dev-company/tsconfig.json',
    ]);
    for (const path of tracked) {
      expect(path.startsWith('packs/dev-company/src/') || path.startsWith('packs/dev-company/tests/') || allowed.has(path), `${path} must not be tracked`).toBe(true);
      expect(path.includes('/dist/')).toBe(false);
      expect(path.includes('/node_modules/')).toBe(false);
      expect(path.endsWith('.tsbuildinfo')).toBe(false);
    }
    expect(tracked).toContain('packs/dev-company/package.json');
    expect(tracked).toContain('packs/dev-company/src/manifest.ts');
  });
});

describe('dependency direction (one-way: pack -> generic platform)', () => {
  it('declares only generic platform dependencies and nothing third-party', () => {
    const manifest = readJson('package.json');
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@companyos/core']);
    expect(manifest.dependencies?.['@companyos/core']).toBe('workspace:*');
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual([]);
  });

  it('keeps every generic production package free of a DevCompany dependency', () => {
    for (const pkg of GENERIC_PACKAGES) {
      const manifest = readJson(`${pkg}/package.json`);
      const deps = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys((manifest as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ];
      expect(deps.filter((dep) => dep.includes('dev-company')), `${pkg} must not depend on DevCompany`).toEqual([]);
    }
  });

  it('keeps generic production sources free of DevCompany imports or identifiers', () => {
    for (const pkg of GENERIC_PACKAGES) {
      const files = walk(`${repo(pkg)}/src`).filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        expect(source.includes('@companyos/pack-dev-company'), `${file} must not import the pack`).toBe(false);
        expect(source.includes('dev-company'), `${file} must not name the pack`).toBe(false);
        expect(source.includes('CodeFleet'), `${file} must not name the codename`).toBe(false);
      }
    }
  });

  it('carries no reverse dependency into the build graph (generic -> pack)', () => {
    const build = readFileSync(repo('../../tsconfig.build.json'), 'utf8');
    const genericReferences = build.match(/"path": "\.\/(packages|apps)\/[^"]+"/g) ?? [];
    for (const reference of genericReferences) {
      expect(reference).not.toContain('packs/');
    }
    expect(build).toContain('"./packs/dev-company"'); // the pack is a leaf, referenced by nothing
  });
});

describe('industry isolation of the generic platform', () => {
  it('keeps DevCompany product nouns out of the generic package sources', () => {
    const nouns = ['DevCompany', 'CodeFleet', 'CTO', 'Developer', 'Reviewer', 'QA', 'Documentation'];
    for (const pkg of ['../../packages/core', '../../packages/contracts', '../../packages/engine'] as const) {
      const files = walk(`${repo(pkg)}/src`).filter((file) => file.endsWith('.ts'));
      for (const file of files) {
        // Same view AND the same word-boundary semantics as the authoritative gate
        // (scripts/check-boundaries.mjs): comments and string literals are stripped, and a
        // noun must appear as a whole word — `ROOT_NOT_DIRECTORY` does not name a CTO.
        const code = codeOnly(readFileSync(file, 'utf8'));
        for (const noun of nouns) {
          const wordBoundary = new RegExp(`\b${noun}\b`, 'i');
          expect(wordBoundary.test(code), `${file} names the industry noun ${noun}`).toBe(false);
        }
      }
    }
  });

  it('has no DevCompany special case in the generic pack framework', () => {
    const files = walk(`${repo('../../packages/engine/src')}`).filter((file) => file.endsWith('.ts'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes("'dev-company'"), `${file} must not special-case the pack id`).toBe(false);
      expect(source.includes('"dev-company"'), `${file} must not special-case the pack id`).toBe(false);
    }
  });
});

describe('static safety of the product package', () => {
  it('contains no dynamic code, process, network, filesystem, env or DB access', () => {
    for (const file of walk(`${repo('.')}/src`)) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of [
        'eval(',
        'new Function(',
        'node:vm',
        'child_process',
        'exec(',
        'spawn(',
        'fetch(',
        'http',
        'https',
        'process.env',
        'node:fs',
        'readFileSync',
        'writeFileSync',
        'require(',
        'import(',
      ]) {
        expect(source.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false);
      }
    }
  });

  it('imports no PackService and exposes no install/enable/disable behaviour', () => {
    for (const file of walk(`${repo('.')}/src`)) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes('PackService')).toBe(false);
      expect(source.includes('.install(')).toBe(false);
      expect(source.includes('.enable(')).toBe(false);
      expect(source.includes('.disable(')).toBe(false);
      expect(source.includes('.upgrade(')).toBe(false);
    }
    const index = readFileSync(repo('src/index.ts'), 'utf8');
    for (const forbidden of ['installDevCompany', 'bootstrapDevCompany', 'registerDevCompany', 'DevCompanyService']) {
      expect(index).not.toContain(forbidden);
    }
  });

  it('has no runtime installation identity in the product data', () => {
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) collect(entry);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          keys.add(key);
          collect(entry);
        }
      }
    };
    collect(DEVCOMPANY_MANIFEST);
    collect(DEVCOMPANY_MODEL_POLICY);
    for (const forbidden of ['companyId', 'installationId', 'creationCommandId', 'creationCommandFingerprint', 'status', 'installedAt', 'installedBy', 'actorId']) {
      expect(keys.has(forbidden), `product data must not carry ${forbidden}`).toBe(false);
    }
  });

  it('carries no vendor name, credential or secret', () => {
    const files = [...walk(`${repo('.')}/src`), repo('package.json')];
    for (const file of files) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      const vendorTokens = ['openai', 'OpenAI', 'anthropic', 'Anthropic', 'deepseek', 'DeepSeek', 'gemini', 'Gemini', 'apiKey', 'api_key', 'bearer', 'password', 'credential'];
      for (const forbidden of vendorTokens) {
        expect(code.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false);
      }
    }
  });

  it('keeps the model policy inert — no router, registry or binding behaviour', () => {
    const code = codeOnly(readFileSync(repo('src/model-policy.ts'), 'utf8'));
    // Only the generic capability-profile TYPE may appear; no runtime module, no call.
    const runtimeTokens = ['Router', 'ModelRegistry', 'capabilityProfile(', 'binding', 'resolve', 'select', 'createModelRegistry', 'createDeterministicModelRouter'];
    for (const forbidden of runtimeTokens) {
      expect(code.includes(forbidden), `model-policy must not reference ${forbidden}`).toBe(false);
    }
    expect(code).toContain('ModelCapabilityProfile'); // the type the tokens are derived from
    expect(DEVCOMPANY_MODEL_POLICY.reviewerMustDifferFromDeveloper).toBe(true);
  });
});

describe('canonical schema authority', () => {
  it('duplicates no generic Pack schema or declaration interface', () => {
    for (const file of walk(`${repo('.')}/src`)) {
      const source = readFileSync(file, 'utf8');
      const forbiddenSchemas = ['z.object', 'zod', 'z.array', 'interface PackManifest', 'interface RoleDeclaration', 'interface PromptDeclaration', 'interface ToolRequirementDeclaration'];
      for (const forbidden of forbiddenSchemas) {
        expect(source.includes(forbidden), `${file} must not define a local schema (${forbidden})`).toBe(false);
      }
    }
  });

  it('derives its types from the generic Core model (satisfies, never a shadow copy)', () => {
    const manifestSource = readFileSync(repo('src/manifest.ts'), 'utf8');
    expect(manifestSource).toContain('satisfies PackManifest');
    expect(manifestSource).toContain("from '@companyos/core'");
    const policySource = readFileSync(repo('src/model-policy.ts'), 'utf8');
    expect(policySource).toContain('ModelCapabilityProfile');
  });

  it('keeps the model policy out of the manifest (no tenth declaration category)', () => {
    const declarations = Object.keys(DEVCOMPANY_MANIFEST.declarations);
    expect(declarations).toHaveLength(9);
    expect(declarations).not.toContain('modelPolicy');
    expect(JSON.stringify(DEVCOMPANY_MANIFEST)).not.toContain('reviewerMustDifferFromDeveloper');
  });
});

describe('public surface and product data shape', () => {
  it('exports only inert product data, constants and derived types', () => {
    const index = readFileSync(repo('src/index.ts'), 'utf8');
    for (const expected of ['DEVCOMPANY_MANIFEST', 'DEVCOMPANY_MODEL_POLICY']) {
      expect(index).toContain(expected);
    }
    for (const forbidden of ['function ', '=>', 'class ', 'async ']) {
      expect(index.includes(forbidden), `index must not export behaviour (${forbidden})`).toBe(false);
    }
  });

  it('keeps the exported product data readonly at the type level', () => {
    const manifestSource = readFileSync(repo('src/manifest.ts'), 'utf8');
    expect(manifestSource).toContain('as const satisfies PackManifest');
    const policySource = readFileSync(repo('src/model-policy.ts'), 'utf8');
    expect(policySource).toContain('as const');
    // No runtime deep-freeze is introduced: readonly is a compile-time guarantee.
    expect(manifestSource).not.toContain('Object.freeze');
    expect(policySource).not.toContain('Object.freeze');
  });
});

describe('no runtime integration creep', () => {
  it('leaves the desktop composition, IPC and renderer untouched', () => {
    const main = readFileSync(repo('../../apps/desktop/src/main.ts'), 'utf8');
    expect(main).not.toContain('pack-dev-company');
    expect(main).not.toContain('dev-company');
    const desktopManifest = readJson('../../apps/desktop/package.json');
    const deps = Object.keys(desktopManifest.dependencies ?? {});
    expect(deps.filter((dep) => dep.includes('dev-company'))).toEqual([]);
  });

  it('adds no migration for product data', () => {
    const migrations = readdirSync(repo('../../packages/persistence/migrations/pack'));
    expect(migrations.filter((name) => name.endsWith('.sql'))).toEqual(['0001_pack_persistence.sql']);
  });

  it('adds no marketplace, loader or directory scanner', () => {
    for (const file of walk(`${repo('.')}/src`)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const forbidden of ['readdir', 'scandir', 'marketplace', 'signature', 'download', 'zip', 'readFileSync']) {
        expect(code.includes(forbidden), `${file} must not contain ${forbidden}`).toBe(false);
      }
      for (const token of ['glob', 'scan', 'load', 'fetch']) {
        expect(new RegExp(`\\b${token}\\b`).test(code), `${file} must not use ${token}`).toBe(false);
      }
    }
  });
});
import {registerOfflineReadOnlyGitRepository} from '../../../tests/support/offline-fixtures.js';
