/**
 * DRA-04 — embedded DSH runtime ROOT RESOLUTION (launch-cwd independence).
 *
 * Defect (DRA-01 evidence): the desktop production composition derived the embedded
 * kernel's managed root from `process.cwd()`, so launching the real desktop from
 * `apps/desktop` looked for `<cwd>/.companyos-embedded/dsh-runtime` and found
 * nothing — the embedded provider silently failed to register.
 *
 * The fix: ONE stable, absolute resource location, anchored on the composition
 * module itself (`productionEmbeddedDshRuntimeRoot()`), delivered through the SAME
 * `productionCompositionOptions()` seam both desktop composition sites consume.
 * Composition no longer infers any root from the working directory, and an absent
 * root stays EXPLICITLY unavailable (fail-closed) instead of being guessed.
 *
 * Pinned here mechanically (deterministic, local, zero network, zero real launch):
 *   - same config → same absolute runtime under different working directories
 *     (including the defect scenario: cwd = apps/desktop);
 *   - spaces / non-ASCII managed-root paths resolve;
 *   - missing manifest and checksum drift fail closed with the typed reasons;
 *   - the provider registers from an alien cwd when (and only when) the root is
 *     supplied — a `<cwd>/.companyos-embedded` tree is never consulted;
 *   - the immutable runtime resource root and the writable attempt data stay
 *     separated: composition creates no stage/home artifacts;
 *   - source guard: no cwd-derived root remains anywhere in the chain.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { nullLogger } from '@companyos/observability';
import { openDurableDatabase } from '@companyos/persistence';

import { openArtifactFoundation } from '../apps/desktop/src/artifact-stack.js';
import { composeCoreServices, lastCoreCompositionError } from '../apps/desktop/src/core-services.js';
import {
  externalDshRuntimeOptedIn,
  resolveEmbeddedDshRuntime,
} from '../apps/desktop/src/executor/embedded-dsh-runtime.js';
import {
  DEFAULT_EXECUTOR_PROVIDER_KEY,
  productionCompositionOptions,
  productionEmbeddedDshRuntimeRoot,
} from '../apps/desktop/src/production-composition.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const CHAINS = [
  'core', 'engine', 'lifecycle', 'provider', 'registry', 'selection', 'agent',
  'tools', 'artifact', 'pack', 'memory', 'session', 'handoff',
] as const;
/** The same live-deployment env surface the sibling production tests scrub. */
const LIVE_ENV_KEYS = [
  'COS_MODEL_BASE_URL', 'COS_MODEL_ID', 'COS_MODEL_PROVIDER_ID', 'COS_MODEL_TIMEOUT_MS',
  'COMPANYOS_MODEL_API_KEY', 'COS_MODEL_ROUTING_MODE', 'COS_MODEL_ROUTING_POLICY',
  'COS_MODEL_QUALITY_TIER', 'COS_MODEL_COST_TIER', 'COS_MODEL_LATENCY_TIER',
  'COS_MODEL_RELIABILITY_CLASS', 'COMPANYOS_DSH_EXTERNAL_RUNTIME',
] as const;

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of LIVE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The explicit model route every composition test declares (no network is ever used). */
const MODEL_ENV = {
  COS_MODEL_BASE_URL: 'http://127.0.0.1:9',
  COS_MODEL_ID: 'tiny-model',
  COS_MODEL_AUTHENTICATION: 'NONE',
} as const;

const scraps: string[] = [];
const tempDir = (label: string): string => {
  const dir = join(tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  scraps.push(dir);
  return dir;
};
afterEach(() => {
  while (scraps.length > 0) {
    try { rmSync(scraps.pop() as string, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const withCwd = <T,>(dir: string, run: () => T): T => {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return run();
  } finally {
    process.chdir(previous);
  }
};

const sha256Of = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/**
 * A TINY but contract-complete managed root (the same deterministic recipe the
 * storage-lifecycle suite uses): real manifest, real closure manifest with real
 * checksums, real profile scaffold — a few KB instead of the full materialization,
 * so resolution is exercised without copying (and without launching) anything.
 */
const makeTinyManagedRoot = (root: string): { readonly root: string; readonly generation: string } => {
  mkdirSync(join(root, 'runtime'), { recursive: true });
  mkdirSync(join(root, 'home-template', 'profiles', 'k'), { recursive: true });
  const cli = 'console.log("tiny-kernel");\n';
  const pkg = '{"name":"k","version":"1.0.0"}\n';
  const patch =
    'provider: {{ROUTE_PROVIDER}}\nmodel: {{ROUTE_MODEL}}\nbase: {{ROUTE_BASE_URL}}\nenv: {{ROUTE_API_KEY_ENV}}\ncw: {{ROUTE_CONTEXT_WINDOW}}\nmt: {{ROUTE_MAX_TOKENS}}\nws: {{WORKSPACE_ROOT}}\n';
  writeFileSync(join(root, 'runtime', 'cli.js'), cli);
  writeFileSync(join(root, 'home-template', 'profiles', 'k', 'package.json'), pkg);
  writeFileSync(join(root, 'home-template', 'patch.yml'), patch);
  const generation = sha256Of('dra04-tiny-generation-v1');
  const closure = {
    version: 1,
    generation,
    files: {
      'runtime/cli.js': { sha256: sha256Of(cli), class: 'critical' },
      'home-template/profiles/k/package.json': { sha256: sha256Of(pkg), class: 'critical' },
      'home-template/patch.yml': { sha256: sha256Of(patch), class: 'critical' },
    },
    counts: { totalCritical: 3, samplingUsed: false },
  };
  const closureBytes = Buffer.from(JSON.stringify(closure), 'utf8');
  writeFileSync(join(root, 'closure-manifest.json'), closureBytes);
  const manifest = {
    kernelId: 'tiny-kernel',
    upstreamRepo: 'https://example.invalid/tiny',
    upstreamSha: 'a'.repeat(40),
    upstreamTag: 'v1',
    runtimeRoot: join(root, 'runtime'),
    cliEntry: 'cli.js',
    profileName: 'k',
    dshHomeTemplateDir: join(root, 'home-template'),
    profilePatchTemplate: join(root, 'home-template', 'patch.yml'),
    transport: 'stdio',
    protocolVersion: 1,
    checksums: { 'cli.js': sha256Of(cli) },
    closureGeneration: sha256Of(closureBytes),
  };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  return { root, generation };
};

type Core = NonNullable<Awaited<ReturnType<typeof composeCoreServices>>>;

/** Compose the REAL production wiring while the process working directory is `cwd`. */
const composeAt = async (cwd: string, options: Record<string, unknown>): Promise<Core> => {
  const dataDir = tempDir('dra04-data');
  const db = openDurableDatabase({ dataDir, appliedAt: new Date().toISOString(), chains: [...CHAINS] });
  const foundation = await openArtifactFoundation({
    casRoot: `${dataDir}-cas`,
    database: db,
    logger: nullLogger as never,
  });
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const core = await composeCoreServices(db, nullLogger as never, {
      artifactFoundation: foundation as never,
      ...options,
    } as never);
    if (core === null) {
      throw new Error(`composition failed: ${String(lastCoreCompositionError() ?? 'unknown error')}`);
    }
    return core;
  } finally {
    process.chdir(previous);
  }
};

/* ----------------------------------------------- the stable resource location --- */

describe('productionEmbeddedDshRuntimeRoot — one stable resource location', () => {
  it('is absolute, repository-anchored, and identical under every working directory', () => {
    const baseline = productionEmbeddedDshRuntimeRoot();
    expect(isAbsolute(baseline)).toBe(true);
    expect(baseline.endsWith(join('.companyos-embedded', 'dsh-runtime'))).toBe(true);
    const independent = join(fileURLToPath(new URL('..', import.meta.url)), '.companyos-embedded', 'dsh-runtime');
    expect(baseline).toBe(independent);
    // Different working directories — including the DEFECT scenario (the desktop
    // launched from apps/desktop) — resolve the SAME absolute runtime.
    const alien = tempDir('dra04-cwd');
    expect(withCwd(alien, productionEmbeddedDshRuntimeRoot)).toBe(baseline);
    expect(withCwd(join(repoRoot, 'apps', 'desktop'), productionEmbeddedDshRuntimeRoot)).toBe(baseline);
  });

  it('rides every production composition (both desktop composition sites consume the same options)', () => {
    const alien = tempDir('dra04-cwd');
    const withoutModel = withCwd(alien, () => productionCompositionOptions({}));
    expect(withoutModel.embeddedDshRuntimeRoot).toBe(productionEmbeddedDshRuntimeRoot());
    const withModel = withCwd(alien, () => productionCompositionOptions(MODEL_ENV));
    expect(withModel.embeddedDshRuntimeRoot).toBe(productionEmbeddedDshRuntimeRoot());
    expect(withModel.embeddedDshModelRoute).toBeDefined();
  });

  it('never consults a <cwd>/.companyos-embedded tree, even when one exists', () => {
    const alien = tempDir('dra04-cwd');
    makeTinyManagedRoot(join(alien, '.companyos-embedded', 'dsh-runtime'));
    const options = withCwd(alien, () => productionCompositionOptions(MODEL_ENV));
    expect(options.embeddedDshRuntimeRoot).toBe(productionEmbeddedDshRuntimeRoot());
    expect(options.embeddedDshRuntimeRoot).not.toBe(join(alien, '.companyos-embedded', 'dsh-runtime'));
  });
});

/* ----------------------------------------------------- fail-closed resolution --- */

describe('resolveEmbeddedDshRuntime — fail-closed, any absolute location', () => {
  it('a missing manifest stays EXPLICITLY unavailable (typed reason, exact path echoed)', () => {
    const parent = tempDir('dra04-缺失');
    const missingRoot = join(parent, '内核 目录 (missing)');
    const missing = resolveEmbeddedDshRuntime({ managedRoot: missingRoot });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('unreachable');
    expect(String(missing.error.details['reason'])).toBe('EXECUTOR_EMBEDDED_RUNTIME_MISSING');
    expect(missing.error.message).toContain(missingRoot);
  });

  it('checksum drift against the manifest fails closed', () => {
    const root = join(tempDir('dra04-drift'), 'managed-root');
    makeTinyManagedRoot(root);
    writeFileSync(join(root, 'runtime', 'cli.js'), 'console.log("drifted");\n');
    const drifted = resolveEmbeddedDshRuntime({ managedRoot: root });
    expect(drifted.ok).toBe(false);
    if (drifted.ok) throw new Error('unreachable');
    expect(String(drifted.error.details['reason'])).toBe('EXECUTOR_EMBEDDED_RUNTIME_CHECKSUM_MISMATCH');
  });

  it('resolves a managed root under a path with spaces and non-ASCII characters', () => {
    const root = join(tempDir('dra04-路径'), '内核 runtime (空格) 目录');
    const made = makeTinyManagedRoot(root);
    const resolved = resolveEmbeddedDshRuntime({ managedRoot: root });
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.value.manifest.kernelId).toBe('tiny-kernel');
    expect(resolved.value.closure.generation).toBe(made.generation);
  });

  it('resolves at a packaged-style resources location (the one seam a package build repoints)', () => {
    const root = join(tempDir('dra04-packaged'), 'resources', 'embedded-dsh-runtime');
    makeTinyManagedRoot(root);
    const resolved = resolveEmbeddedDshRuntime({ managedRoot: root });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.value.manifest.profileName).toBe('k');
  });

  it('the external opt-in sentinel is exactly "1" (no implicit alternative runtime)', () => {
    expect(externalDshRuntimeOptedIn({})).toBe(false);
    expect(externalDshRuntimeOptedIn({ COMPANYOS_DSH_EXTERNAL_RUNTIME: '1' })).toBe(true);
    expect(externalDshRuntimeOptedIn({ COMPANYOS_DSH_EXTERNAL_RUNTIME: 'true' })).toBe(false);
    expect(externalDshRuntimeOptedIn({ COMPANYOS_DSH_EXTERNAL_RUNTIME: 'yes' })).toBe(false);
  });
});

/* ---------------------------------------- composition: root-driven, not cwd --- */

describe('production composition — registration is root-driven, never cwd-driven', () => {
  it('registers the embedded provider from an alien working directory when the root is supplied', async () => {
    const alien = tempDir('dra04-cwd-alien');
    const tinyRoot = join(tempDir('dra04-resource'), 'managed-root');
    makeTinyManagedRoot(tinyRoot);
    const core = await composeAt(alien, {
      ...productionCompositionOptions(MODEL_ENV),
      embeddedDshRuntimeRoot: tinyRoot,
    });
    const provider = core.executorProviders?.resolve(DEFAULT_EXECUTOR_PROVIDER_KEY) ?? null;
    expect(provider).not.toBeNull();
    // Immutable runtime resources vs. writable attempt data: composition creates no
    // stage/home artifacts under the resource root…
    expect(existsSync(join(tinyRoot, '.dsh-stages'))).toBe(false);
    expect(existsSync(join(tinyRoot, '.dsh-homes'))).toBe(false);
    // …and the launch working directory is neither read from nor written to.
    expect(existsSync(join(alien, '.companyos-embedded'))).toBe(false);
  });

  it('does NOT register the embedded provider without the root option, even when <cwd>/.companyos-embedded exists', async () => {
    const alien = tempDir('dra04-cwd-planted');
    // A perfectly valid runtime planted exactly where the pre-fix code would have
    // looked — proof that the working directory no longer participates.
    makeTinyManagedRoot(join(alien, '.companyos-embedded', 'dsh-runtime'));
    const core = await composeAt(alien, {
      ...productionCompositionOptions(MODEL_ENV),
      embeddedDshRuntimeRoot: undefined,
    });
    expect(core.executorProviders?.resolve(DEFAULT_EXECUTOR_PROVIDER_KEY) ?? null).toBeNull();
  });
});

/* --------------------------------------------------------------- source guard --- */

describe('source guard — no cwd-derived embedded root anywhere in the chain', () => {
  const sourceOf = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

  it('core-services resolves the embedded root ONLY from the composition option', () => {
    const source = sourceOf(join('apps', 'desktop', 'src', 'core-services.ts'));
    expect(source).not.toContain('process.cwd()');
    expect(source).not.toContain('.companyos-embedded');
  });

  it('the production seam anchors the root on the module location, not the cwd', () => {
    const source = sourceOf(join('apps', 'desktop', 'src', 'production-composition.ts'));
    expect(source).toContain("new URL('../../../.companyos-embedded/dsh-runtime', import.meta.url)");
    expect(source).not.toContain('process.cwd()');
  });
});
