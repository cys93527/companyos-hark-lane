import { registerOfflineInline } from './support/offline-fixtures.js';
/**
 * RUNTIME-STORAGE-FIX-01 — embedded DSH stage storage lifecycle tests.
 *
 * Forensics: `.dsh-stages` had grown to ~56 GB = 157 directories × 360 MB, ALL of the
 * SAME closure generation. Root cause: the stage cache was a per-PROCESS map (every
 * vitest worker / node process staged its own full runtime copy) and the ONLY cleanup
 * was a process.on('exit') sweep that killed workers and crashed hosts never run —
 * with no startup reclamation.
 *
 * The corrected contract, pinned here mechanically (all deterministic, all local,
 * zero network, zero live credentials):
 *
 *   shared canonical stage   one deterministic `stage-<generation12>` per generation,
 *                            reused across PROCESSES, published atomically;
 *   per-attempt home         small, pid-marked, disposed in the provider finally;
 *   startup scavenger        reclaims old-format stages, dead-pid partials and dead
 *                            homes with SHAPE + PID proof (never age alone), keeps
 *                            live-pid entries and UNKNOWN shapes untouched;
 *   bounded 20-run growth    N attempts (in-process AND cross-process) = ONE stage;
 *   Windows locks            bounded retry, then a typed RUNTIME_STORAGE_CLEANUP_FAILED
 *                            diagnostic and the tree is left for the next scavenger;
 *   canonical truth          nothing outside .dsh-stages/.dsh-homes is ever touched.
 */
import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';

// Deterministic transient-lock injection: rmSync throws EBUSY (the transient class)
// while the switch is on — proving the BOUNDED retry, the typed diagnostic and the
// next-pass reclamation without racing real filesystem locks.
const lockSwitch = vi.hoisted(() => ({locked: false}));
// GATE-A: deterministic rename-refusal injection (the Windows publication-contention
// class, EPERM) — consumed one fault per renameSync call while faults > 0.
const renameSwitch = vi.hoisted(() => ({faults: 0}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<FsModule>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (lockSwitch.locked) {
        const error = new Error('resource busy or locked') as Error & {code: string};
        error.code = 'EBUSY';
        throw error;
      }
      return actual.rmSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameSwitch.faults > 0) {
        renameSwitch.faults -= 1;
        const error = new Error('EPERM: operation not permitted, rename') as Error & {code: string};
        error.code = 'EPERM';
        throw error;
      }
      return actual.renameSync(...args);
    },
  };
});

import {createHash} from 'node:crypto';

import {
  reclaimInertStageStorage,
  resolveEmbeddedDshRuntime,
  runtimeStorageDiagnostics,
} from '../apps/desktop/src/executor/embedded-dsh-runtime.js';

import type * as nodeFs from 'node:fs';
type FsModule = typeof nodeFs;

const sha256Of = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
// Anchor to this test module, never the caller's cwd or a previous workspace.
const runtimeModuleUrl = new URL('../apps/desktop/dist/executor/embedded-dsh-runtime.js', import.meta.url);

const scraps: string[] = [];
const tempRoot = (): string => {
  const dir = join(tmpdir(), `s-storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, {recursive: true});
  scraps.push(dir);
  return dir;
};
afterEach(() => {
  while (scraps.length > 0) {
    try { rmSync(scraps.pop() as string, {recursive: true, force: true}); } catch { /* best-effort */ }
  }
});

/**
 * A TINY but contract-complete managed root: real manifest, real closure manifest with
 * real checksums, real profile scaffold — a few KB instead of 360 MB, so the lifecycle
 * is exercised deterministically without copying the full runtime.
 */
const makeTinyManagedRoot = (): {root: string; generation: string} => {
  const root = tempRoot();
  mkdirSync(join(root, 'runtime'), {recursive: true});
  mkdirSync(join(root, 'home-template', 'profiles', 'k'), {recursive: true});
  const cli = 'console.log("tiny-kernel");\n';
  const pkg = '{"name":"k","version":"1.0.0"}\n';
  const patch = 'provider: {{ROUTE_PROVIDER}}\nmodel: {{ROUTE_MODEL}}\nbase: {{ROUTE_BASE_URL}}\nenv: {{ROUTE_API_KEY_ENV}}\ncw: {{ROUTE_CONTEXT_WINDOW}}\nmt: {{ROUTE_MAX_TOKENS}}\nws: {{WORKSPACE_ROOT}}\n';
  writeFileSync(join(root, 'runtime', 'cli.js'), cli);
  writeFileSync(join(root, 'home-template', 'profiles', 'k', 'package.json'), pkg);
  writeFileSync(join(root, 'home-template', 'patch.yml'), patch);
  const generation = sha256Of('tiny-generation-v1');
  const closure = {
    version: 1,
    generation,
    files: {
      'runtime/cli.js': {sha256: sha256Of(cli), class: 'critical'},
      'home-template/profiles/k/package.json': {sha256: sha256Of(pkg), class: 'critical'},
      'home-template/patch.yml': {sha256: sha256Of(patch), class: 'critical'},
    },
    counts: {totalCritical: 3, samplingUsed: false},
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
    checksums: {'cli.js': sha256Of(cli)},
    closureGeneration: sha256Of(closureBytes),
  };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  return {root, generation};
};

const stageDirOf = (root: string): string => join(root, '.dsh-stages');
const homeDirOf = (root: string): string => join(root, '.dsh-homes');
const listDir = (root: string, dir: string): readonly string[] => {
  try { return readdirSync(join(root, dir)); } catch { return []; }
};
const treeSize = (path: string): number => {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, entry) => sum + treeSize(join(path, entry)), 0);
};
/** A live pid holder: a child that outlives the assertion, killed in finally. */
const holdLivePid = (): {pid: number; stop: () => void} => {
  registerOfflineInline('setInterval(() => {}, 60000);');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000);'], {stdio: 'ignore'});
  return {pid: child.pid as number, stop: () => { child.kill(); }};
};
const route = {
  providerId: 'p', modelId: 'm', baseURL: 'http://127.0.0.1:9', apiKeyEnv: 'E',
  apiKeyValue: '', contextWindow: 1000, maxTokens: 100,
} as const;

/** Recursive content fingerprint of the MANAGED ROOT's source tree (immutability proof). */
const sourceTreeFingerprint = (root: string): string => {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === '.dsh-stages' || entry === '.dsh-homes') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else entries.push(`${relative(root, full)}:${sha256Of(readFileSync(full))}`);
    }
  };
  walk(root);
  return sha256Of(entries.join('\n'));
};

describe('RUNTIME-STORAGE-FIX-01 — shared canonical stage', () => {
  it('N attempts in ONE process share a single deterministic stage (20-run bounded growth)', () => {
    const {root, generation} = makeTinyManagedRoot();
    const resolved = resolveEmbeddedDshRuntime({managedRoot: root});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);
    const before = listDir(root, '.dsh-stages').length;
    for (let index = 0; index < 20; index += 1) {
      const stage = resolved.value.prepareAttemptStage({attemptId: `att_${String(index)}`});
      expect(stage.ok).toBe(true);
      if (!stage.ok) throw new Error(stage.error.message);
    }
    const after = listDir(root, '.dsh-stages');
    expect(before).toBe(0);
    expect(after).toEqual([`stage-${generation.slice(0, 12)}`]);
    expect(treeSize(join(stageDirOf(root), after[0]!))).toBeLessThan(32 * 1024); // KBs, not runtime×N
  });

  it('N SEPARATE PROCESSES reuse the same canonical stage (the per-process leak is closed)', async () => {
    const {root, generation} = makeTinyManagedRoot();
    const childScript = `
      import { resolveEmbeddedDshRuntime } from ${JSON.stringify(runtimeModuleUrl.href)};
      const resolved = resolveEmbeddedDshRuntime({ managedRoot: ${JSON.stringify(root)} });
      if (!resolved.ok) { console.error('resolve failed'); process.exit(3); }
      const stage = resolved.value.prepareAttemptStage({ attemptId: 'child' });
      if (!stage.ok) { console.error('stage failed'); process.exit(4); }
      console.log(import.meta.resolve(${JSON.stringify(runtimeModuleUrl.href)}));
      process.exit(0); // normal exit — the canonical stage must survive it
    `;
    registerOfflineInline(childScript);
    for (let index = 0; index < 3; index += 1) {
      const loadedUrl = execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
        stdio: 'pipe', cwd: tempRoot(), encoding: 'utf8',
      }).trim();
      expect(realpathSync(fileURLToPath(loadedUrl))).toBe(realpathSync(fileURLToPath(runtimeModuleUrl)));
    }
    expect(listDir(root, '.dsh-stages')).toEqual([`stage-${generation.slice(0, 12)}`]);
  });

  it('imports the current dist through a workspace alias containing spaces and non-ASCII characters', () => {
    const {root, generation} = makeTinyManagedRoot();
    const alias = join(tempRoot(), '验收 workspace');
    symlinkSync(fileURLToPath(new URL('../', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasTestUrl = pathToFileURL(join(alias, 'tests', 'embedded-storage-lifecycle.test.ts'));
    const aliasRuntimeUrl = new URL('../apps/desktop/dist/executor/embedded-dsh-runtime.js', aliasTestUrl);
    const childScript = `
      import { resolveEmbeddedDshRuntime } from ${JSON.stringify(aliasRuntimeUrl.href)};
      const resolved = resolveEmbeddedDshRuntime({ managedRoot: ${JSON.stringify(root)} });
      if (!resolved.ok) process.exit(3);
      const stage = resolved.value.prepareAttemptStage({ attemptId: 'portable-child' });
      if (!stage.ok) process.exit(4);
      console.log(import.meta.resolve(${JSON.stringify(aliasRuntimeUrl.href)}));
    `;
    registerOfflineInline(childScript);
    const loadedUrl = execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: tempRoot(), stdio: 'pipe', encoding: 'utf8',
    }).trim();
    expect(aliasRuntimeUrl.href).toContain('%20');
    expect(aliasRuntimeUrl.href).toContain('%E9');
    expect(realpathSync(fileURLToPath(loadedUrl))).toBe(realpathSync(fileURLToPath(runtimeModuleUrl)));
    expect(listDir(root, '.dsh-stages')).toEqual([`stage-${generation.slice(0, 12)}`]);
  });

  it('a missing dist at the selected workspace fails instead of falling back to another checkout', () => {
    const missingTestUrl = pathToFileURL(join(tempRoot(), 'tests', 'embedded-storage-lifecycle.test.ts'));
    const missingRuntimeUrl = new URL('../apps/desktop/dist/executor/embedded-dsh-runtime.js', missingTestUrl);
    const missingImport = `import ${JSON.stringify(missingRuntimeUrl.href)};`;
    registerOfflineInline(missingImport);
    expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', missingImport], {cwd: tempRoot(), stdio: 'pipe'})).toThrow('ERR_MODULE_NOT_FOUND');
  });

  it('a tampered canonical stage fails loud, self-heals on the next attempt', () => {
    const {root} = makeTinyManagedRoot();
    const resolved = resolveEmbeddedDshRuntime({managedRoot: root});
    if (!resolved.ok) throw new Error(resolved.error.message);
    const first = resolved.value.prepareAttemptStage({attemptId: 'a1'});
    if (!first.ok) throw new Error(first.error.message);
    const canonical = first.value.stageRoot;
    writeFileSync(join(canonical, 'runtime', 'cli.js'), 'tampered');
    const refused = resolved.value.prepareAttemptStage({attemptId: 'a2'});
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected refusal');
    expect(String(refused.error.details['reason'] ?? '')).toContain('EXECUTOR_EMBEDDED_RUNTIME_TAMPERED');
    const healed = resolved.value.prepareAttemptStage({attemptId: 'a3'});
    expect(healed.ok, String(healed.ok ? '' : healed.error.message)).toBe(true);
    if (!healed.ok) throw new Error(healed.error.message);
  });
});

describe('RUNTIME-STORAGE-FIX-01 — startup scavenger (shape + pid proof)', () => {
  it('reclaims old-format stages, dead-pid partials and dead homes; keeps live, canonical and UNKNOWN entries', () => {
    const {root, generation} = makeTinyManagedRoot();
    const live = holdLivePid();
    try {
      mkdirSync(join(stageDirOf(root), `stage-${generation.slice(0, 12)}-1790000000000-deadbeef`), {recursive: true}); // old per-process format
      mkdirSync(join(stageDirOf(root), `.tmp-stage-${generation.slice(0, 12)}-p999999-cafe`), {recursive: true}); // dead pid partial
      const liveTmp = join(stageDirOf(root), `.tmp-stage-${generation.slice(0, 12)}-p${String(live.pid)}-beef`);
      mkdirSync(liveTmp, {recursive: true}); // in-flight publish of a LIVE process
      mkdirSync(join(stageDirOf(root), 'mystery-dir'), {recursive: true}); // UNKNOWN_MUST_NOT_DELETE
      mkdirSync(join(homeDirOf(root), 'attempt-legacy-1790000000000'), {recursive: true}); // legacy (pre-fix) home
      mkdirSync(join(homeDirOf(root), 'attempt-x-p999999-1'), {recursive: true}); // dead pid home
      const liveHome = join(homeDirOf(root), `attempt-x-p${String(live.pid)}-1`);
      mkdirSync(liveHome, {recursive: true}); // live pid home
      const manifestBefore = readFileSync(join(root, 'manifest.json'), 'utf8');

      const resolved = resolveEmbeddedDshRuntime({managedRoot: root}); // resolve runs the scavenger
      expect(resolved.ok).toBe(true);

      const stages = listDir(root, '.dsh-stages');
      const homes = listDir(root, '.dsh-homes');
      expect(stages).toEqual([`.tmp-stage-${generation.slice(0, 12)}-p${String(live.pid)}-beef`, 'mystery-dir']);
      expect(homes).toEqual([`attempt-x-p${String(live.pid)}-1`]);
      // Canonical truth in the managed root is untouched.
      expect(readFileSync(join(root, 'manifest.json'), 'utf8')).toBe(manifestBefore);
      // A canonical stage created now coexists with the kept entries.
      if (!resolved.ok) throw new Error(resolved.error.message);
      const stage = resolved.value.prepareAttemptStage({attemptId: 'a1'});
      expect(stage.ok).toBe(true);
    } finally {
      live.stop();
    }
  });

  it('the crash-residue scenario: a stage + home from a crashed process are reclaimed on the next resolve', () => {
    const {root, generation} = makeTinyManagedRoot();
    // Simulate the crash residue exactly as the old code left it (old-format stage, legacy home).
    mkdirSync(join(stageDirOf(root), `stage-${generation.slice(0, 12)}-1790000000001-abcdef123456`), {recursive: true});
    mkdirSync(join(homeDirOf(root), 'attempt-exa_crashed-1790000000001'), {recursive: true});
    const resolved = resolveEmbeddedDshRuntime({managedRoot: root});
    expect(resolved.ok).toBe(true);
    expect(listDir(root, '.dsh-stages')).toEqual([]);
    expect(listDir(root, '.dsh-homes')).toEqual([]);
  });

  it('a transient Windows lock produces a typed diagnostic after BOUNDED retries, then the next pass reclaims', () => {
    const {root, generation} = makeTinyManagedRoot();
    const lockedHome = join(homeDirOf(root), 'attempt-locked-p999999-1');
    mkdirSync(join(lockedHome, 'profiles'), {recursive: true});
    writeFileSync(join(lockedHome, 'profiles', 'package.json'), '{}');
    lockSwitch.locked = true; // every removal attempt hits EBUSY (the transient class)
    try {
      const diagnosticsBefore = runtimeStorageDiagnostics().length;
      const outcome = reclaimInertStageStorage({managedRoot: root, currentGeneration: generation});
      expect(outcome.reclaimed).toEqual([]);
      expect(outcome.failed.length).toBe(1);
      expect(outcome.failed[0]!.code).toBe('EBUSY');
      const diagnostics = runtimeStorageDiagnostics();
      expect(diagnostics.length).toBeGreaterThan(diagnosticsBefore);
      expect(diagnostics.at(-1)!.code).toBe('RUNTIME_STORAGE_CLEANUP_FAILED');
      expect(diagnostics.at(-1)!.kind).toBe('home-orphan');
      expect(listDir(root, '.dsh-homes')).toEqual(['attempt-locked-p999999-1']);
    } finally {
      lockSwitch.locked = false;
    }
    const after = reclaimInertStageStorage({managedRoot: root, currentGeneration: generation});
    expect(after.reclaimed).toContain(lockedHome);
    expect(listDir(root, '.dsh-homes')).toEqual([]);
  });

  it('per-attempt homes are created with the pid marker and disposed by the provider finally path', () => {
    const {root} = makeTinyManagedRoot();
    const resolved = resolveEmbeddedDshRuntime({managedRoot: root});
    if (!resolved.ok) throw new Error(resolved.error.message);
    const stage = resolved.value.prepareAttemptStage({attemptId: 'att_probe'});
    if (!stage.ok) throw new Error(stage.error.message);
    const home = stage.value.newDshHome({attemptId: 'att_probe', workspaceRoot: tempRoot(), route});
    expect(home.ok).toBe(true);
    if (!home.ok) throw new Error(home.error.message);
    expect(home.value.dshHome).toContain(`-p${String(process.pid)}-`);
    expect(listDir(root, '.dsh-homes')).toHaveLength(1);
    home.value.dispose();
    expect(listDir(root, '.dsh-homes')).toEqual([]);
    // The shared stage survives the attempt dispose (bounded cache, not per-task growth).
    expect(listDir(root, '.dsh-stages').length).toBe(1);
    stage.value.dispose();
    expect(listDir(root, '.dsh-stages').length).toBe(1);
  });
});

describe('GATE-A — publish/storage failure is never integrity/tamper evidence', () => {
  it('a rename refusal with NO canonical destination is a typed STORAGE failure (never tamper), and the next attempt recovers', () => {
    const {root} = makeTinyManagedRoot();
    const resolved = resolveEmbeddedDshRuntime({managedRoot: root});
    if (!resolved.ok) throw new Error(resolved.error.message);
    const before = sourceTreeFingerprint(root);
    // ALL rename attempts in the bounded publish window are refused (transient class).
    renameSwitch.faults = 999;
    try {
      const stage = resolved.value.prepareAttemptStage({attemptId: 'gate-a-1'});
      expect(stage.ok).toBe(false);
      if (stage.ok) throw new Error('expected the publish to be refused');
      const reason = String(stage.error.details['reason'] ?? '');
      expect(reason).toContain('EXECUTOR_EMBEDDED_RUNTIME_STAGE_FAILED');
      expect(reason).not.toContain('TAMPERED');
    } finally {
      renameSwitch.faults = 0;
    }
    // Nothing was published and no partial survived; the SOURCE copy is byte-identical.
    expect(listDir(root, '.dsh-stages').filter((entry) => entry.startsWith('stage-'))).toEqual([]);
    expect(listDir(root, '.dsh-stages').filter((entry) => entry.startsWith('.tmp-stage-'))).toEqual([]);
    expect(sourceTreeFingerprint(root)).toBe(before);
    // The refusal was STORAGE (transient), not corruption: the next attempt publishes.
    const retried = resolved.value.prepareAttemptStage({attemptId: 'gate-a-2'});
    expect(retried.ok, String(retried.ok ? '' : retried.error.message)).toBe(true);
    expect(sourceTreeFingerprint(root)).toBe(before);
  });

  it('an ALREADY-PUBLISHED canonical stage is reused only through the full cryptographic verification; a different tree stays an integrity verdict', () => {
    const {root} = makeTinyManagedRoot();
    const first = resolveEmbeddedDshRuntime({managedRoot: root});
    if (!first.ok) throw new Error(first.error.message);
    const published = first.value.prepareAttemptStage({attemptId: 'gate-a-3'});
    if (!published.ok) throw new Error(published.error.message);
    const canonical = published.value.stageRoot;
    // A SECOND runtime over the same root (a fresh publisher: no in-process cache) must
    // reuse the existing stage — and the reuse is gated by the 100% closure re-hash.
    const second = resolveEmbeddedDshRuntime({managedRoot: root});
    if (!second.ok) throw new Error(second.error.message);
    const reused = second.value.prepareAttemptStage({attemptId: 'gate-a-4'});
    expect(reused.ok, String(reused.ok ? '' : reused.error.message)).toBe(true);
    if (!reused.ok) throw new Error(reused.error.message);
    expect(reused.value.stageRoot).toBe(canonical);
    // Destination exists but DIFFERS: the unverifiable stage is never accepted.
    writeFileSync(join(canonical, 'runtime', 'cli.js'), 'tampered-after-publish');
    const third = resolveEmbeddedDshRuntime({managedRoot: root});
    if (!third.ok) throw new Error(third.error.message);
    const refused = third.value.prepareAttemptStage({attemptId: 'gate-a-5'});
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected the tampered stage to be refused');
    expect(String(refused.error.details['reason'] ?? '')).toContain('EXECUTOR_EMBEDDED_RUNTIME_TAMPERED');
    const healed = third.value.prepareAttemptStage({attemptId: 'gate-a-6'});
    expect(healed.ok, String(healed.ok ? '' : healed.error.message)).toBe(true);
  });

  it('a racer that won the publish is honored: the canonical tree is reused, never rebuilt (bounded contention retries)', () => {
    const {root} = makeTinyManagedRoot();
    const first = resolveEmbeddedDshRuntime({managedRoot: root});
    if (!first.ok) throw new Error(first.error.message);
    const published = first.value.prepareAttemptStage({attemptId: 'gate-a-7'});
    if (!published.ok) throw new Error(published.error.message);
    // The destination exists (a concurrent publisher won) while rename is REFUSED:
    // the reuse path must be chosen and verified — never a tamper verdict.
    renameSwitch.faults = 999;
    try {
      const second = resolveEmbeddedDshRuntime({managedRoot: root});
      if (!second.ok) throw new Error(second.error.message);
      const reused = second.value.prepareAttemptStage({attemptId: 'gate-a-8'});
      expect(reused.ok, String(reused.ok ? '' : reused.error.message)).toBe(true);
      if (!reused.ok) throw new Error(reused.error.message);
      expect(reused.value.stageRoot).toBe(published.value.stageRoot);
    } finally {
      renameSwitch.faults = 0;
    }
  });
});
