/**
 * STAGE 4 — the CompanyOS-MANAGED EMBEDDED DSH RUNTIME seam.
 *
 * One resolution path for the default agentic kernel: a CompanyOS-owned immutable
 * MANIFEST describing the materialized official pinned runtime (Stage 3
 * reproducibility gate; built by scripts/materialize-embedded-dsh.mjs — the final
 * packaged-resource form ships the same manifest contract).
 *
 * Laws frozen here (Boss Stage 4 order):
 *  - The DEFAULT is the CompanyOS-managed runtime. The user's PATH `dsh`,
 *    `~/.dsh`, a desktop DSH installation, or a user-installed CLI are NEVER
 *    consulted implicitly. An external runtime is an EXPLICIT operator opt-in
 *    (the historical named envs under `COMPANYOS_DSH_EXTERNAL_RUNTIME=1`).
 *  - A missing/incomplete embedded runtime is a typed FAIL-LOUD load — never a
 *    silent fallback to some other dsh on the machine.
 *  - Exact pin: the manifest carries the upstream repo/SHA/tag and the resolver
 *    verifies the entry checksum; `latest`/branch names are not identities.
 *  - Structural worldview exclusion: the rendered profile composes ONLY the
 *    minimal rows (Stage 3 DEFAULT_KERNEL_PROFILE_V1) — dsh goal/plan/workflow/
 *    agent-team/api/web/desktop/settings/telemetry/account-OAuth packages are not
 *    in the tree at all.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type ClientRequest, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { routeWireCompatYamlLine } from '../models/route-wire-compat.js';
import type { Socket } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type { ExecutorExecutionRequest } from '@companyos/engine';
import { domainError, type DomainError, type InvocationResult, err, ok, type Result } from '@companyos/core';

/** The immutable runtime manifest written by the materialization step. */
export interface EmbeddedDshRuntimeManifest {
  readonly kernelId: string;
  readonly upstreamRepo: string;
  readonly upstreamSha: string;
  readonly upstreamTag: string;
  readonly runtimeRoot: string;
  readonly cliEntry: string;
  readonly nodeRange: string;
  readonly packageManager: string;
  readonly profileName: string;
  readonly dshHomeTemplateDir: string;
  readonly profilePatchTemplate: string;
  /** LIVE-SMOKE-FIX-08B: staged headless shell guard script (loaded by the persistent pwsh terminal at startup). */
  readonly shellGuardScript?: string;
  readonly transport: string;
  readonly protocolVersion: string;
  readonly license: string;
  readonly checksums: Readonly<Record<string, string>>;
  /** STAGE 5B: sha256 of closure-manifest.json bytes — recorded by materialize AFTER the closure is written. */
  readonly closureGeneration?: string;
  readonly createdAt: string;
  /**
   * H15 (packaged distribution, layoutVersion 2): the upstream CLI version the
   * first-start health check reads back (`--version`); a mismatch refuses the kernel.
   */
  readonly kernelVersion?: string;
  /** H15: 2 = relocatable packaged resource (paths are managed-root-relative). */
  readonly layoutVersion?: number;
  /**
   * H15: the pinned Node runtime shipped WITH the kernel (Distribution spec §3).
   * `path` is managed-root-relative and is itself a NATIVE_CRITICAL closure file, so
   * the staged copy the child runs is covered by the same 100% integrity gate.
   */
  readonly nodeRuntime?: { readonly path: string; readonly version: string; readonly sha256: string };
  /** H15: SBOM + licence bundle locations (managed-root-relative). */
  readonly sbom?: string;
  readonly licenses?: string;
}

/** One classified closure file entry (STAGE 5B execution closure). */
export interface RuntimeClosureEntry {
  readonly class: 'EXECUTABLE_CRITICAL' | 'CONFIG_CRITICAL' | 'NATIVE_CRITICAL';
  readonly sha256: string;
}

/** The execution-closure manifest written by the materialization step (100% critical coverage, NO sampling). */
export interface RuntimeExecutionClosure {
  readonly version: number;
  readonly generation: string;
  readonly derivation: Readonly<Record<string, unknown>>;
  readonly counts: {
    readonly EXECUTABLE_CRITICAL: number;
    readonly CONFIG_CRITICAL: number;
    readonly NATIVE_CRITICAL: number;
    readonly totalCritical: number;
    readonly samplingUsed: boolean;
  };
  readonly files: Readonly<Record<string, RuntimeClosureEntry>>;
  /** Junction entries of the resolvable universe: staged trees recreate these (link -> staged target). */
  readonly links?: ReadonlyArray<{ readonly link: string; readonly target: string }>;
}

/** The per-invocation model route (CompanyOS-selected; BYO/API-only). */
export interface EmbeddedDshModelRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly baseURL: string;
  /** The env var name the kernel resolves the credential from (value NEVER persisted). */
  readonly apiKeyEnv: string;
  readonly apiKeyValue: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** H15c: the REAL upstream behind the broker (wire compat is judged from it, never the loopback URL). */
  readonly upstreamBaseURL?: string;
}

/** One verified staged attempt: immutable-in-practice execution copy with pre/post-spawn gates. */
export interface EmbeddedDshAttemptStage {
  /** Staged managed-root clone: the ONLY tree the child executes from. */
  readonly stageRoot: string;
  /** The staged CLI entry (node script) the managed child runs. */
  readonly cliEntryPath: string;
  /** H15: the STAGED pinned Node runtime (null when the manifest ships none — dev materialization). */
  readonly nodeExecutablePath: string | null;
  /** Render one disposable DSH_HOME from the STAGED (verified) templates. */
  readonly newDshHome: (input: {
    readonly attemptId: string;
    readonly workspaceRoot: string;
    readonly route: EmbeddedDshModelRoute;
    /** STAGE 4: the Goal's canonical access policy, enforced by the KERNEL sandbox. */
    readonly sandboxMode?: DshSandboxMode;
  }) => Result<{ readonly dshHome: string; readonly dispose: () => void }, DomainError>;
  /** 100% closure hash pass over the STAGED bytes (pre-spawn gate; re-runnable). */
  readonly verifyStaged: () => Result<'STAGE_VERIFIED', DomainError>;
  readonly dispose: () => void;
}

/**
 * STAGE 4 — the DSH kernel's fs-sandbox modes. The Goal's canonical access policy maps
 * onto these, so READ_ONLY is enforced by the KERNEL (below the renderer), not by any
 * UI state. Values are the kernel's own vocabulary (fs-sandbox).
 */
export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface EmbeddedDshRuntime {
  readonly manifest: EmbeddedDshRuntimeManifest;
  /** STAGE 5B execution closure (loaded at resolve; 100% critical coverage). */
  readonly closure: RuntimeExecutionClosure;
  /** Stage a fresh per-attempt execution copy: verify 100% of the closure, then hand out staged entry paths. */
  readonly prepareAttemptStage: (input: { readonly attemptId: string }) => Result<EmbeddedDshAttemptStage, DomainError>;
}

const fail = (reason: string, message: string): Result<never, DomainError> =>
  err(domainError('PERSISTENCE_FAILED', message, { reason }));

/*
 * STAGE 5B runtime integrity — the EXECUTION CLOSURE gate (Boss §2/§4/§6/§7/§8).
 *
 * The prior design (full-tree manifest + deterministic sampling above 10k
 * files + a per-managedRoot verdict cache) was INSUFFICIENT and is removed:
 * sampling lets unverified-but-executable code launch, and a path-keyed cache
 * means verify-once/trust-forever on a WRITABLE directory.
 *
 * The gate now is:
 *  1. MATERIALIZE writes closure-manifest.json — every EXECUTABLE_CRITICAL /
 *     CONFIG_CRITICAL / NATIVE_CRITICAL file of the derived execution closure
 *     carries a sha256 (100% cryptographic coverage, samplingUsed=false), and
 *     manifest.json records sha256(closure-manifest bytes) as closureGeneration.
 *  2. RESOLVE (every call) mutually binds the two artifacts: hash(manifest.json)
 *     === closure.manifestSha256 and hash(closure-manifest.json) ===
 *     manifest.closureGeneration — editing either alone fails loud.
 *  3. ATTEMPT stages a fresh copy: every closure file is copied to a random
 *     per-attempt stage and hashed 100% against the closure; the child executes
 *     ONLY from the staged entry. A source-tree tamper after staging cannot
 *     reach the child (it never reads the source tree); a staged tamper before
 *     spawn is caught by the pre-spawn verifyStaged() gate; a tamper in flight
 *     is caught by the post-spawn verifyStaged() pass (fail-loud outcome).
 *
 * Residual (recorded, not claimed away): an attacker who rewrites BOTH the
 * runtime tree AND both manifest artifacts between the materialize gate and
 * resolve holds the same privilege as one who replaces CompanyOS itself — the
 * platform trust boundary. Same-user malware racing the sub-millisecond
 * verify→spawn window is likewise the platform boundary; the staged-verify +
 * dual-gate design closes the model-driven and workspace-borne vectors that
 * Stage 5B owns.
 */

/** Load + shape-check the execution closure manifest from a managed root. */
const loadExecutionClosure = (
  managedRoot: string,
  m: EmbeddedDshRuntimeManifest,
): Result<RuntimeExecutionClosure, DomainError> => {
  if (m.closureGeneration === undefined) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_CLOSURE_MISSING',
      'The embedded DSH manifest predates the Stage 5B execution closure (no closureGeneration); re-materialize the runtime.',
    );
  }
  const closurePath = join(managedRoot, 'closure-manifest.json');
  if (!existsSync(closurePath)) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_CLOSURE_MISSING',
      `No execution closure manifest at "${closurePath}"; re-materialize: node scripts/materialize-embedded-dsh.mjs.`,
    );
  }
  const closureBytes = readFileSync(closurePath);
  if (sha256OfBytes(closureBytes) !== m.closureGeneration) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_CLOSURE_DRIFT',
      'closure-manifest.json bytes do not match the manifest closureGeneration — the closure was edited out-of-band.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(closureBytes.toString('utf8'));
  } catch (error) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_CLOSURE_MALFORMED',
      `The execution closure manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const closure = parsed as Partial<RuntimeExecutionClosure>;
  if (
    closure.generation === undefined ||
    closure.files === undefined ||
    closure.counts === undefined
  ) {
    return fail('EXECUTOR_EMBEDDED_RUNTIME_CLOSURE_MALFORMED', 'The execution closure manifest is missing required fields.');
  }
  if (closure.counts.samplingUsed === true) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_CLOSURE_MALFORMED',
      'The execution closure claims sampling was used — sampling is not a valid critical-runtime integrity policy (Stage 5B).',
    );
  }
  if (closure.counts.totalCritical !== Object.keys(closure.files).length) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_CLOSURE_MALFORMED',
      'The execution closure counts disagree with its file table.',
    );
  }
  if (closure.counts.totalCritical <= 0) {
    return fail('EXECUTOR_EMBEDDED_RUNTIME_CLOSURE_MALFORMED', 'The execution closure is empty.');
  }
  return ok(closure as RuntimeExecutionClosure);
};

/** 100% closure hash pass over a tree root (managed root or staged copy). */
const verifyClosureAgainst = (
  closure: RuntimeExecutionClosure,
  treeRoot: string,
  label: 'runtime' | 'stage',
): Result<'STAGE_VERIFIED', DomainError> => {
  for (const [relative, entry] of Object.entries(closure.files)) {
    let actual: string | null = null;
    try {
      actual = sha256OfFile(join(treeRoot, ...relative.split('/')));
    } catch {
      actual = null;
    }
    if (actual !== entry.sha256) {
      return fail(
        'EXECUTOR_EMBEDDED_RUNTIME_TAMPERED',
        `A ${label} execution-closure file failed integrity verification ("${relative}", class ${entry.class}).`,
      );
    }
  }
  return ok('STAGE_VERIFIED');
};


const sha256OfFile = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const sha256OfBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/*
 * Stage cache (Boss §6-legal cache): keyed by managedRoot + CLOSURE GENERATION (the
 * provable integrity version). RUNTIME-STORAGE-FIX-01: the cache is now CROSS-PROCESS —
 * the staged copy lives at a DETERMINISTIC path (`stage-<generation12>`) shared by every
 * process on the machine, published atomically (temp copy + rename) so concurrent
 * processes never observe a partial tree, and gated per attempt by the same 100%
 * verifyStaged pass. Every attempt still re-hashes the full closure before spawn, so a
 * tampered shared stage fails loud at the next attempt — never verify-once/trust-forever.
 * Non-current or crash-orphaned stage directories are reclaimed by the startup
 * scavenger (reclaimInertStageStorage), not by time heuristics.
 */
const sharedStages = new Map<string, string>();

/** Bounded retry window for transient Windows filesystem locks during reclamation. */
const CLEANUP_RETRY_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 150;

/** Resource-lifecycle diagnostics ONLY (never business/attempt truth). Bounded ring. */
export interface RuntimeStorageDiagnostic {
  readonly path: string;
  readonly kind: 'stage-orphan' | 'home-orphan' | 'tmp-partial';
  readonly code: string;
  readonly at: string;
}
const storageDiagnostics: RuntimeStorageDiagnostic[] = [];
export const runtimeStorageDiagnostics = (): readonly RuntimeStorageDiagnostic[] => [...storageDiagnostics];
const recordDiagnostic = (path: string, kind: RuntimeStorageDiagnostic['kind'], code: string): void => {
  if (storageDiagnostics.length >= 64) storageDiagnostics.shift();
  storageDiagnostics.push({path, kind, code, at: new Date().toISOString()});
};

const isTransientLock = (error: unknown): boolean => {
  const code = (error as {readonly code?: unknown} | null)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
};

/** One removal with a BOUNDED retry for transient Windows locks; never throws. */
const removeTreeBounded = (path: string): {ok: boolean; code: string | null} => {
  for (let attempt = 0; attempt < CLEANUP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      rmSync(path, {recursive: true, force: true});
      return {ok: true, code: null};
    } catch (error) {
      const code = String((error as {readonly code?: unknown} | null)?.code ?? 'RM_FAILED');
      if (!isTransientLock(error)) return {ok: false, code};
      if (attempt + 1 < CLEANUP_RETRY_ATTEMPTS) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CLEANUP_RETRY_DELAY_MS);
      } else {
        return {ok: false, code};
      }
    }
  }
  return {ok: false, code: 'RM_FAILED'};
};

/**
 * GATE-A — bounded SYNC backoff for the Windows rename-contention window (indexer/AV
 * briefly holding the destination). Sync because stage publishing is synchronous by
 * contract; the total bound is ~300ms across three publish retries.
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Process liveness probe (Windows: EPERM means alive-but-other-owner — conservative). */
const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as {readonly code?: unknown} | null)?.code === 'EPERM';
  }
};

/** The `-p<pid>-` active-owner marker embedded in temp/home directory names. */
const pidOfMarker = (name: string): number | null => {
  const match = /-p(\d+)-/.exec(name);
  return match === null ? null : Number(match[1]);
};

/**
 * STARTUP SCAVENGER (RUNTIME-STORAGE-FIX-01 §11/§12): reclaim provably inert stage/home
 * directories under the managed root. Ownership is proven by SHAPE + pid, never by age:
 *   - the CURRENT generation's canonical stage is the shared cache — always kept;
 *   - a `.tmp-stage-…-p<pid>-…` partial whose pid is ALIVE is an in-flight publish — kept;
 *   - an `attempt-…-p<pid>-…` home whose pid is ALIVE belongs to a running attempt — kept;
 *   - every other RECOGNIZED shape (old-format `stage-*`, dead-pid tmps, dead/legacy
 *     homes) is rebuildable scratch (content re-staged on demand, gated by verifyStaged);
 *   - UNRECOGNIZED entries are UNKNOWN_MUST_NOT_DELETE — kept untouched.
 * Removal failures (Windows locks) are recorded as typed diagnostics and left for the
 * next run; nothing here can touch canonical DB/CAS/workspace truth.
 */
export const reclaimInertStageStorage = (input: {
  readonly managedRoot: string;
  readonly currentGeneration: string;
}): {reclaimed: readonly string[]; skippedLive: readonly string[]; failed: readonly {path: string; code: string}[]} => {
  const canonical = `stage-${input.currentGeneration.slice(0, 12)}`;
  const reclaimed: string[] = [];
  const skippedLive: string[] = [];
  const failed: {path: string; code: string}[] = [];
  for (const [dir, kind] of [
    [join(input.managedRoot, '.dsh-stages'), 'stage-orphan'],
    [join(input.managedRoot, '.dsh-homes'), 'home-orphan'],
  ] as const) {
    let entries: readonly string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // absent directory: nothing to reclaim
    }
    for (const entry of entries) {
      if (dir.endsWith('.dsh-stages') && entry === canonical) continue;
      let action: 'keep-unknown' | 'keep-live' | 'delete';
      if (entry.startsWith('.tmp-stage-')) {
        const pid = pidOfMarker(entry);
        action = pid !== null && isProcessAlive(pid) ? 'keep-live' : 'delete';
      } else if (entry.startsWith('stage-')) {
        action = 'delete'; // old per-process format or foreign generation: rebuildable
      } else if (entry.startsWith('attempt-')) {
        const pid = pidOfMarker(entry);
        action = pid === null || !isProcessAlive(pid) ? 'delete' : 'keep-live';
      } else {
        action = 'keep-unknown';
      }
      const path = join(dir, entry);
      if (action === 'keep-unknown') continue;
      if (action === 'keep-live') {
        skippedLive.push(path);
        continue;
      }
      const removal = removeTreeBounded(path);
      if (removal.ok) reclaimed.push(path);
      else {
        failed.push({path, code: removal.code ?? 'RM_FAILED'});
        recordDiagnostic(path, kind === 'stage-orphan' && entry.startsWith('.tmp-stage-') ? 'tmp-partial' : kind, 'RUNTIME_STORAGE_CLEANUP_FAILED');
      }
    }
  }
  return {reclaimed, skippedLive, failed};
};

let exitSweepArmed = false;
const armExitSweep = (): void => {
  if (exitSweepArmed) return;
  exitSweepArmed = true;
  // The shared canonical stage deliberately SURVIVES process exit (it is the
  // cross-process cache; the startup scavenger owns reclamation of inert copies).
  // The sweep only drops this process's unpublished temp partial, if any remains.
  process.on('exit', () => {
    for (const stagePath of sharedStages.values()) {
      if (basename(stagePath).startsWith('.tmp-stage-')) {
        try { rmSync(stagePath, {recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      }
    }
  });
};

/**
 * Resolve the managed embedded runtime from a manifest directory.
 *
 * The default managed root is the gitignored development materialization; the
 * packaged build points the composition at its resources directory with the SAME
 * manifest contract. Verification: manifest shape, runtime presence, the
 * CLI-entry checksum (exact-pin proof), and the Stage 5B execution-closure
 * mutual binding — the closure itself is verified 100% per attempt at stage
 * time, never cached by path.
 */
export const resolveEmbeddedDshRuntime = (input: {
  readonly managedRoot: string;
  /**
   * H15: where the WRITABLE per-generation stages and disposable DSH homes live.
   * The packaged kernel is an immutable install resource (replaced whole on every
   * install), so production passes a userData path; absent = the managed root
   * (the dev materialization layout).
   */
  readonly stateRoot?: string;
}): Result<EmbeddedDshRuntime, DomainError> => {
  const stateRoot = input.stateRoot ?? input.managedRoot;
  const manifestPath = join(input.managedRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_MISSING',
      `No embedded DSH kernel manifest at "${manifestPath}". Materialize it: node scripts/materialize-embedded-dsh.mjs. The provider never falls back to a user-installed dsh.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_MANIFEST_MALFORMED',
      `The embedded DSH manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parsed as Partial<EmbeddedDshRuntimeManifest>;
  const required: readonly (keyof EmbeddedDshRuntimeManifest)[] = [
    'kernelId', 'upstreamRepo', 'upstreamSha', 'upstreamTag', 'runtimeRoot', 'cliEntry',
    'profileName', 'dshHomeTemplateDir', 'profilePatchTemplate', 'transport', 'protocolVersion', 'checksums',
  ];
  for (const field of required) {
    if (manifest[field] === undefined || manifest[field] === null) {
      return fail(
        'EXECUTOR_EMBEDDED_RUNTIME_MANIFEST_INCOMPLETE',
        `The embedded DSH manifest is missing "${String(field)}".`,
      );
    }
  }
  /*
   * H15: a packaged (layoutVersion 2) manifest is RELOCATABLE — its paths are
   * managed-root-relative, so the installed resource works wherever the user
   * installed CompanyOS. Absolute paths (dev materialization) pass through.
   */
  const underRoot = (p: string): string => (isAbsolute(p) ? p : join(input.managedRoot, ...p.split('/')));
  const raw = manifest as EmbeddedDshRuntimeManifest;
  const m: EmbeddedDshRuntimeManifest = {
    ...raw,
    runtimeRoot: underRoot(raw.runtimeRoot),
    dshHomeTemplateDir: underRoot(raw.dshHomeTemplateDir),
    profilePatchTemplate: underRoot(raw.profilePatchTemplate),
    ...(raw.shellGuardScript === undefined ? {} : { shellGuardScript: underRoot(raw.shellGuardScript) }),
  };
  if (m.nodeRuntime !== undefined) {
    const nodeRel = m.nodeRuntime.path;
    if (isAbsolute(nodeRel) || nodeRel.includes('..')) {
      return fail('EXECUTOR_EMBEDDED_RUNTIME_MANIFEST_INCOMPLETE', 'The embedded DSH manifest nodeRuntime.path must be managed-root-relative.');
    }
  }
  // Exact-pin identity rules: a branch/tag-only manifest is not an identity.
  if (!/^[0-9a-f]{40}$/u.test(m.upstreamSha)) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_PIN_INVALID',
      `The embedded DSH manifest upstreamSha "${m.upstreamSha}" is not an exact commit identity.`,
    );
  }
  const cliEntryPath = join(m.runtimeRoot, ...m.cliEntry.split('/'));
  if (!existsSync(cliEntryPath)) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_MISSING',
      `The embedded DSH runtime entry "${m.cliEntry}" does not exist under "${m.runtimeRoot}".`,
    );
  }
  const expected = m.checksums[m.cliEntry];
  if (expected !== undefined && sha256OfFile(cliEntryPath) !== expected) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_CHECKSUM_MISMATCH',
      `The embedded DSH runtime entry checksum drifted from the manifest (exact pin violated).`,
    );
  }
  if (!existsSync(m.profilePatchTemplate) || !existsSync(join(m.dshHomeTemplateDir, 'profiles', m.profileName, 'package.json'))) {
    return fail(
      'EXECUTOR_EMBEDDED_RUNTIME_PROFILE_MISSING',
      'The embedded DSH profile scaffold (dsh-home template or patch template) is missing.',
    );
  }
  const closure = loadExecutionClosure(input.managedRoot, m);
  if (!closure.ok) return closure;
  // H15: the shipped Node runtime is only trusted as a closure member — the staged
  // copy the child executes is then re-hashed by every verifyStaged gate.
  if (m.nodeRuntime !== undefined) {
    const nodeEntry = closure.value.files[m.nodeRuntime.path];
    if (nodeEntry === undefined || nodeEntry.sha256 !== m.nodeRuntime.sha256) {
      return fail(
        'EXECUTOR_EMBEDDED_RUNTIME_NODE_UNVERIFIED',
        `The shipped Node runtime "${m.nodeRuntime.path}" is not a verified execution-closure member with the manifest sha256.`,
      );
    }
  }

  const BS = String.fromCharCode(92); // one literal backslash — escape-proof doubling below
  /*
   * Render the per-invocation patch: workspace root + CompanyOS model route (template
   * param = staged copy). LIVE-SMOKE-FIX-08B: {{DSH_SHELL_GUARD}} renders the STAGED
   * headless shell guard path (forward slashes: YAML single-quoted and PS -File both
   * accept them on Windows); a staged manifest that predates the guard renders the
   * placeholder EMPTY, and the kernel's shellArgs validation then fails loudly
   * instead of silently launching a literal "{{DSH_SHELL_GUARD}}" file.
   */
  const renderPatch = (templatePath: string, workspaceRoot: string, route: EmbeddedDshModelRoute, stagedGuardScript: string, sandboxMode: DshSandboxMode): string =>
    readFileSync(templatePath, 'utf8')
      .replaceAll('{{WORKSPACE_ROOT}}', workspaceRoot.split(BS).join(BS.repeat(2)))
      .replaceAll('    mode: workspace-write', `    mode: ${sandboxMode}`)
      .replaceAll('{{DSH_SHELL_GUARD}}', stagedGuardScript)
      .replaceAll('{{ROUTE_PROVIDER}}', route.providerId)
      .replaceAll('{{ROUTE_MODEL}}', route.modelId)
      .replaceAll('{{ROUTE_COMPAT}}', routeWireCompatYamlLine(route.upstreamBaseURL ?? route.baseURL))
      .replaceAll('{{ROUTE_BASE_URL}}', route.baseURL)
      .replaceAll('{{ROUTE_API_KEY_ENV}}', route.apiKeyEnv)
      .replaceAll('{{ROUTE_CONTEXT_WINDOW}}', String(route.contextWindow))
      .replaceAll('{{ROUTE_MAX_TOKENS}}', String(route.maxTokens));

  const runtime: EmbeddedDshRuntime = {
    manifest: m,
    closure: closure.value,
    prepareAttemptStage: ({ attemptId }) => {
      void attemptId;
      /*
       * Stage sharing (Boss §6-legal cache): the key is the CLOSURE GENERATION —
       * the provable integrity version — never the managedRoot path. A
       * re-materialized runtime (new generation) always gets a fresh copy. Every
       * attempt re-verifies 100% of the closure files against the stage before
       * it can spawn (verifyStaged is the gate, called immediately here and by
       * the provider pre/post-spawn), so a stage tampered between attempts fails
       * loud at the next attempt — never verify-once/trust-forever.
       */
      const cacheKey = `${input.managedRoot}::${closure.value.generation}`;
      const canonicalStage = join(stateRoot, '.dsh-stages', `stage-${closure.value.generation.slice(0, 12)}`);
      let stageRoot = sharedStages.get(cacheKey);
      if (stageRoot === undefined) {
        if (existsSync(canonicalStage)) {
          /*
           * CROSS-PROCESS SHARED CACHE (RUNTIME-STORAGE-FIX-01): a previous process
           * already published this generation's stage. Reuse it — verifyStaged below
           * still re-hashes 100% of the closure against it, so reuse is gated by the
           * same integrity proof a fresh copy would need.
           */
          stageRoot = canonicalStage;
        } else {
          /*
           * Atomic publish: copy into a pid-marked temp partial, then rename. A
           * concurrent racer that wins the rename leaves the canonical tree for us
           * (and our temp is dropped). No process can ever spawn from a partial tree.
           */
          const tmpStage = join(stateRoot, '.dsh-stages', `.tmp-stage-${closure.value.generation.slice(0, 12)}-p${String(process.pid)}-${randomBytes(6).toString('hex')}`);
          stageRoot = tmpStage;
          try {
            // Copy EVERY closure file (junction-resolved content) into the stage.
            for (const relative of Object.keys(closure.value.files)) {
              const source = join(input.managedRoot, ...relative.split('/'));
              const target = join(stageRoot, ...relative.split('/'));
              mkdirSync(join(target, '..'), { recursive: true });
              cpSync(source, target);
            }
            /*
             * Recreate the resolvable universe's junction entries as SELF-CONTAINED
             * pointers into the stage (never to the source tree). Windows junctions
             * store ABSOLUTE targets, so they are created pointing at the FINAL
             * canonical path — dangling until the rename below lands, and correct
             * the instant it does. Nothing verifies the temp tree, so the transient
             * dangle is invisible; after the rename every junction resolves inside
             * the canonical stage exactly as verifyStaged demands.
             */
            for (const link of closure.value.links ?? []) {
              const linkAbs = join(stageRoot, ...link.link.split('/'));
              const targetAbs = join(canonicalStage, ...link.target.split('/'));
              mkdirSync(join(linkAbs, '..'), { recursive: true });
              symlinkSync(targetAbs, linkAbs, 'junction');
            }
            try {
              renameSync(stageRoot, canonicalStage);
              stageRoot = canonicalStage;
            } catch (renameError) {
              /*
               * GATE-A — PUBLISH/STORAGE FAILURE ≠ INTEGRITY/TAMPER FAILURE. A rename
               * can fail TRANSIENTLY on Windows (indexer/AV contention) even when every
               * byte is correct, and the destination may or may not have been published
               * by a concurrent racer. The strategy is BOUNDED and decides from the
               * DESTINATION's durable state — never by assuming a canonical tree exists:
               *   - the canonical stage EXISTS: a concurrent publisher (or a previous
               *     process) landed it. Reuse is gated by the SAME cryptographic proof a
               *     fresh copy needs (the full closure re-hash below against this exact
               *     generation's expected content) — an unverifiable stage is never
               *     accepted, and a stage that exists but DIFFERS stays a genuine
               *     integrity verdict;
               *   - it does NOT exist: NOTHING was published, so no unverified byte was
               *     ever exposed. This is a typed STORAGE/PUBLISH failure — never
               *     tamper evidence, and never a missing stage dressed as one.
               */
              for (let retry = 0; retry < 3 && !existsSync(canonicalStage); retry += 1) {
                sleepSync(50 * (retry + 1));
                try {
                  renameSync(stageRoot, canonicalStage);
                } catch {
                  continue;
                }
                break;
              }
              try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
              if (!existsSync(canonicalStage)) {
                return fail(
                  'EXECUTOR_EMBEDDED_RUNTIME_STAGE_FAILED',
                  `Publishing the verified execution closure failed (the canonical stage was not created): ${
                    renameError instanceof Error ? renameError.message : String(renameError)
                  }`,
                );
              }
              stageRoot = canonicalStage;
            }
          } catch (error) {
            try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
            return fail(
              'EXECUTOR_EMBEDDED_RUNTIME_STAGE_FAILED',
              `Staging the verified execution closure failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        sharedStages.set(cacheKey, stageRoot);
        armExitSweep();
      }
      const stagePath = stageRoot;
      const verifyStaged = (): Result<'STAGE_VERIFIED', DomainError> => {
        // Every staged junction MUST point back inside the stage — a link to the
        // source tree would let unverified bytes reach the child.
        for (const link of closure.value.links ?? []) {
          let actual: string;
          try {
            actual = readlinkSync(join(stagePath, ...link.link.split('/')));
          } catch {
            return fail('EXECUTOR_EMBEDDED_RUNTIME_TAMPERED', `A staged junction entry is missing ("${link.link}").`);
          }
          const expected = join(stagePath, ...link.target.split('/'));
          if (resolve(actual).toLowerCase() !== resolve(expected).toLowerCase()) {
            return fail(
              'EXECUTOR_EMBEDDED_RUNTIME_TAMPERED',
              `A staged junction entry points outside the verified stage ("${link.link}").`,
            );
          }
        }
        return verifyClosureAgainst(closure.value, stagePath, 'stage');
      };
      // The staging copy is verified BEFORE the caller can spawn from it. A canonical
      // stage that fails verification is a tampered/corrupt cache: drop it so the next
      // attempt re-stages fresh (self-heal, bounded by the per-attempt verify gate).
      const initial = verifyStaged();
      if (!initial.ok) {
        sharedStages.delete(cacheKey);
        try { rmSync(stagePath, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
        return initial;
      }
      const stageTemplatesDir = join(stagePath, ...relative(input.managedRoot, m.dshHomeTemplateDir).split('\\'));
      const stagePatchTemplate = join(stagePath, ...relative(input.managedRoot, m.profilePatchTemplate).split('\\'));
      // LIVE-SMOKE-FIX-08B: the staged headless shell guard (forward slashes for YAML/PS).
      const stagedGuardScript = m.shellGuardScript === undefined
        ? ''
        : join(stagePath, ...relative(input.managedRoot, m.shellGuardScript).split('\\')).replaceAll('\\', '/');
      return ok({
        stageRoot: stagePath,
        cliEntryPath: join(stagePath, ...relative(input.managedRoot, m.runtimeRoot).split('\\').join('/').split('/').filter((x) => x !== ''), ...m.cliEntry.split('/')),
        nodeExecutablePath: m.nodeRuntime === undefined ? null : join(stagePath, ...m.nodeRuntime.path.split('/')),
        newDshHome: ({ attemptId: homeAttempt, workspaceRoot, route, sandboxMode = 'workspace-write' }) => {
          const safeHome = homeAttempt.replace(/[^a-zA-Z0-9_-]/g, '');
          // The pid marker is the ACTIVE-OWNER proof the startup scavenger reads
          // (RUNTIME-STORAGE-FIX-01 §13): a live pid keeps its home, anything else is
          // reclaimed — never by age alone.
          const dshHome = join(stateRoot, '.dsh-homes', `attempt-${safeHome}-p${String(process.pid)}-${Date.now()}`);
          try {
            mkdirSync(dshHome, { recursive: true });
            cpSync(join(stageTemplatesDir, 'profiles'), join(dshHome, 'profiles'), { recursive: true });
            writeFileSync(
              join(dshHome, 'profiles', m.profileName, 'cordis.patch.yml'),
              renderPatch(stagePatchTemplate, workspaceRoot, route, stagedGuardScript, sandboxMode),
              'utf8',
            );
          } catch (error) {
            return fail(
              'EXECUTOR_EMBEDDED_RUNTIME_HOME_RENDER_FAILED',
              `Rendering the disposable DSH_HOME failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return ok({
            dshHome,
            dispose: () => {
              try {
                rmSync(dshHome, { recursive: true, force: true });
              } catch (error) {
                // §14: a locked home must never flip a settled business outcome —
                // record the typed diagnostic and leave it to the startup scavenger.
                recordDiagnostic(dshHome, 'home-orphan', 'RUNTIME_STORAGE_CLEANUP_FAILED');
                void error;
              }
            },
          });
        },
        verifyStaged,
        // The stage is the CROSS-PROCESS shared cache for this closure generation;
        // attempt dispose is intentionally a no-op — the startup scavenger reclaims
        // inert copies (old generations, dead-pid partials) with shape+pid proof.
        dispose: () => { /* shared per generation; see reclaimInertStageStorage */ },
      });
    },
  };
  /*
   * STARTUP RECLAMATION (RUNTIME-STORAGE-FIX-01 §11/§12): every resolve (process
   * startup, composition boot) reclaims provably inert stage/home directories —
   * old per-process copies, crash orphans, dead-pid partials — with shape + pid
   * ownership proof. The current generation's canonical stage and every live-pid
   * entry are untouched; unknown shapes are never deleted; canonical truth never
   * lives here, so reclamation can never corrupt run/attempt evidence.
   */
  reclaimInertStageStorage({managedRoot: stateRoot, currentGeneration: closure.value.generation});
  return ok(runtime);
};

/**
 * The explicit EXTERNAL runtime opt-in (operator/debug only). Returns true only
 * when the operator explicitly set the sentinel; the caller then (and only then)
 * resolves the historical named envs. Never a silent default.
 */
export const externalDshRuntimeOptedIn = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean => environment['COMPANYOS_DSH_EXTERNAL_RUNTIME'] === '1';

/**
 * The per-invocation LOOPBACK MODEL BROKER (Stage 4 secret law; Stage 5 hard gate).
 *
 * The kernel child must never receive the model credential (Sprint24 §35: no
 * secret enters the argv or environment we pass; S25 refuses secret-shaped
 * declared additions by design). Instead the kernel's model route points here:
 * a loopback HTTP broker, alive for exactly one invocation, that injects the
 * real Authorization header from the CompanyOS-held value and streams the model
 * traffic (SSE included) to the ONE pinned upstream endpoint.
 *
 * STAGE 5 HARDENING (threat model §4 broker attacks — mechanical, never prompt):
 *  - LOOPBACK ONLY: binds 127.0.0.1; requests arriving on any other interface
 *    cannot reach it.
 *  - CALLER AUTHENTICATION: every request must carry the per-attempt capability
 *    nonce (query parameter, minted per invocation). The nonce lives only in the
 *    CompanyOS process + the per-attempt rendered profile URL (which dies with
 *    the attempt), never in env/logs/artifacts, and dies with the broker. A
 *    same-machine foreign process that finds the port CANNOT use the broker.
 *  - PINNED DESTINATION: the upstream scheme/host/port/path come ONLY from the
 *    CompanyOS-selected route; the broker never reads a destination from the
 *    request (no proxy semantics, no redirects followed, no file:// or
 *    agent-named hosts).
 *  - METHOD + PATH + HEADER allowlist: POST on the pinned chat-completions path
 *    only; hop-by-hop and auth headers are dropped (the broker alone sets
 *    Authorization); the response never echoes Authorization or cookies.
 *  - BOUNDED: request bodies over the cap are refused; concurrent upstream
 *    requests are capped; slow upstreams are deadline-killed; close destroys
 *    in-flight sockets.
 */
export interface ModelBrokerHandle {
  readonly url: string;
  /** The per-attempt capability nonce (rendered into the private profile URL only). */
  readonly routeSecret: string;
  readonly close: () => void;
}

export interface ModelBrokerExchangeObservation {
  readonly sequence: number;
  /** How the exchange ended (upstream-end is the only path that can carry usage). */
  readonly endedBy: string;
  readonly upstreamStatus: number | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  /** observed | absent | conflicting | invalid | undecodable | oversize | http-error | not-reached */
  readonly usageDisposition: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  /** Structure only (never content) of the response body the usage was read from. */
  readonly responseShape: ModelResponseShape | null;
  readonly durationMs: number;
}

/** Structural evidence of a model response body — counts and kinds, never model text. */
export interface ModelResponseShape {
  readonly framing: 'sse' | 'json';
  readonly contentType: string;
  /** Upstream Content-Encoding the body was decoded from ('identity' when none). */
  readonly contentEncoding: string;
  readonly dataEvents: number;
  readonly commentLines: number;
  readonly doneMarker: boolean;
  readonly usageEvents: number;
  readonly nullUsageEvents: number;
  readonly unparsedEvents: number;
}

/** Content codings the broker can decode for usage observation (node:zlib, every runtime we ship). */
const BROKER_DECODABLE_CODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'identity']);
const BROKER_DECODED_MAX_BYTES = 4 * 1024 * 1024;

/**
 * H15c-fix9 — the Accept-Encoding the broker forwards upstream: the kernel's own offer
 * restricted to codings the broker can DECODE for usage metering (an undecodable body
 * would make every settlement UNKNOWN); nothing acceptable left => identity.
 */
export const brokerAcceptEncoding = (offered: string | undefined): string => {
  if (offered === undefined) return 'identity';
  const kept = offered.split(',').map((part) => part.trim()).filter((part) => {
    const [coding, ...params] = part.split(';').map((x) => x.trim().toLowerCase());
    if (coding === undefined || !BROKER_DECODABLE_CODINGS.has(coding)) return false;
    return !params.some((param) => /^q=0(?:\.0*)?$/u.test(param));
  });
  return kept.length === 0 ? 'identity' : kept.join(', ');
};

/**
 * H15c-fix9 — decode an upstream body for usage observation per its Content-Encoding.
 * hark-live-goal 40296992054: DeepSeek answered the kernel (whose HTTP client offers
 * gzip/br and decodes transparently) with a compressed event stream; the broker read the
 * raw compressed bytes as UTF-8, found no `data:` line (dataEvents 0, commentLines 0,
 * 751 bytes) and settled UNKNOWN. Unknown or corrupt coding => null (undecodable, UNKNOWN).
 */
export const decodeResponseBody = (body: Buffer, contentEncoding: string): Buffer | null => {
  const codings = contentEncoding.split(',').map((c) => c.trim().toLowerCase()).filter((c) => c !== '' && c !== 'identity');
  let out = body;
  try {
    for (const coding of codings.reverse()) {
      const opts = { maxOutputLength: BROKER_DECODED_MAX_BYTES };
      if (coding === 'gzip' || coding === 'x-gzip') out = gunzipSync(out, opts);
      else if (coding === 'deflate') out = inflateSync(out, opts);
      else if (coding === 'br') out = brotliDecompressSync(out, opts);
      else return null;
    }
  } catch {
    return null;
  }
  return out;
};

/**
 * H15c — read token usage from an upstream Chat Completions response body.
 *
 * Streaming (SSE): every `data:` event is a candidate wherever it sits; SSE comment lines
 * (`: keep-alive`, which DeepSeek sends while a streaming request waits to be scheduled —
 * api-docs.deepseek.com/quick_start/rate_limit) and blank lines are framing, never usage
 * evidence, and `data: [DONE]` ends the stream. Chunks with `usage: null` (DeepSeek with
 * stream_options.include_usage) carry no usage. Exactly one consistent usage value is
 * `observed`; differing values are `conflicting` (never "whichever arrived last"); a
 * usage object that is not two non-negative safe integers is `invalid`; none is `absent`.
 * Non-streaming JSON may be preceded by blank keep-alive lines.
 * hark-live-goal 40266877047 / 40291557860: the first kernel call settled UNKNOWN — the
 * previous reader only treated a body as SSE when it STARTED with `data:`, so a stream
 * opening with `: keep-alive` was parsed as one JSON document and its usage was lost.
 */
export const observeResponseUsage = (
  text: string,
  contentType: string,
  contentEncoding = 'identity',
): { readonly disposition: 'observed' | 'absent' | 'conflicting' | 'invalid'; readonly usage: { inputTokens: number; outputTokens: number; totalCost: null } | null; readonly shape: ModelResponseShape } => {
  const lines = text.split(/\r?\n/u);
  const sse = contentType.toLowerCase().includes('text/event-stream') || lines.some((line) => line.startsWith('data:'));
  let dataEvents = 0; let commentLines = 0; let doneMarker = false; let usageEvents = 0; let nullUsageEvents = 0; let unparsedEvents = 0;
  let usage: { inputTokens: number; outputTokens: number; totalCost: null } | null = null;
  let conflicting = false; let invalid = false;
  const consider = (payload: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { unparsedEvents += 1; return; }
    if (parsed === null || typeof parsed !== 'object' || !('usage' in parsed)) return;
    const u = (parsed as { usage: unknown }).usage;
    if (u === null || u === undefined) { nullUsageEvents += 1; return; }
    usageEvents += 1;
    const p = (u as { prompt_tokens?: unknown }).prompt_tokens;
    const c = (u as { completion_tokens?: unknown }).completion_tokens;
    if (typeof p !== 'number' || !Number.isSafeInteger(p) || p < 0 || typeof c !== 'number' || !Number.isSafeInteger(c) || c < 0) { invalid = true; return; }
    if (usage !== null && (usage.inputTokens !== p || usage.outputTokens !== c)) conflicting = true;
    usage = { inputTokens: p, outputTokens: c, totalCost: null };
  };
  if (sse) {
    for (const line of lines) {
      if (line.startsWith(':')) { commentLines += 1; continue; }
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { doneMarker = true; continue; }
      dataEvents += 1;
      consider(payload);
    }
  } else if (text.trim().length > 0) {
    dataEvents = 1;
    consider(text.trim());
  }
  const shape: ModelResponseShape = { framing: sse ? 'sse' : 'json', contentType: contentType.slice(0, 80), contentEncoding: contentEncoding.slice(0, 40), dataEvents, commentLines, doneMarker, usageEvents, nullUsageEvents, unparsedEvents };
  const disposition = invalid ? 'invalid' : conflicting ? 'conflicting' : usage === null ? 'absent' : 'observed';
  return { disposition, usage: disposition === 'observed' ? usage : null, shape };
};

const BROKER_MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MiB per model request
const BROKER_MAX_CONCURRENCY = 4; // one kernel drives at most a handful of streams
const BROKER_UPSTREAM_TIMEOUT_MS = 600_000; // generous: reasoning models stream long

export const startModelBroker = (input: {
  readonly admission?: NonNullable<ExecutorExecutionRequest['modelCallAdmission']>;
  readonly upstreamBaseURL: string;
  readonly bearer: string;
  /** Trusted-caller override of the upstream deadline (tests only; default 600s). */
  readonly upstreamTimeoutMs?: number;
  /**
   * H15c: one OBSERVATION per settled exchange (evidence only — never a secret, never
   * request/response content). Lets an UNKNOWN budget reservation be explained from
   * durable evidence (hark-live-goal 40266877047 left one unexplained).
   */
  readonly observe?: (observation: ModelBrokerExchangeObservation) => void;
}): Promise<Result<ModelBrokerHandle, DomainError>> =>
  new Promise((resolve) => {
    let upstream: URL;
    try {
      upstream = new URL(input.upstreamBaseURL);
    } catch {
      resolve(
        err(
          domainError('VALIDATION_FAILED', 'The model route baseURL is not a URL.', {
            reason: 'EXECUTOR_EMBEDDED_BROKER_UPSTREAM_INVALID',
            baseURL: input.upstreamBaseURL,
          }),
        ),
      );
      return;
    }
    // TRANSPORT ALLOWLIST (live-smoke fix 01): the broker speaks http and https only.
    // Any other scheme is a typed refusal before anything listens — never a forwarded
    // request against a transport Node cannot open, and never a host crash.
    if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
      resolve(
        err(
          domainError('VALIDATION_FAILED', 'The model route baseURL must be an http(s) URL; the broker refuses every other scheme.', {
            reason: 'EXECUTOR_EMBEDDED_BROKER_UPSTREAM_SCHEME_UNSUPPORTED',
            scheme: upstream.protocol,
          }),
        ),
      );
      return;
    }
    // PINNED DESTINATION: scheme/host/port/path prefix from the CompanyOS route only.
    const upstreamPathPrefix = upstream.pathname.replace(/\/$/u, '');
    // The transport is chosen from the PARSED scheme — an https: upstream gets the real
    // node:https client (full TLS verification, no downgrade), http: stays node:http.
    const upstreamRequest = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
    const routeSecret = randomBytes(24).toString('base64url');
    let inFlight = 0;
    let exchangeSequence = 0;
    const sockets = new Set<Socket>();

    const refuse = (res: ServerResponse, status: number, reason: string): void => {
      // The error body is a fixed opaque string — never the route secret, never
      // the upstream URL, never request contents.
      res.writeHead(status, { 'content-type': 'text/plain', 'content-length': String(reason.length) });
      res.end(reason);
    };

    const server = createServer((req, res) => {
      // CALLER AUTHENTICATION: the capability nonce rides the PATH (the upstream
      // SDKs concatenate baseURL + '/chat/completions', which would corrupt a
      // query parameter — a path segment survives every naive concatenation).
      // Accepted shapes: /c/<nonce>/v1/chat/completions and /c/<nonce>/chat/completions.
      const capabilityMatch = /^\/c\/([A-Za-z0-9_-]+)(?:\/v1)?\/chat\/completions$/u.exec(req.url ?? '');
      if (capabilityMatch === null || capabilityMatch[1] !== routeSecret) {
        refuse(res, 401, 'unauthorized');
        return;
      }
      // METHOD allowlist: POST only (the path shape was just proven).
      if (req.method !== 'POST') {
        refuse(res, 404, 'not found');
        return;
      }
      // CONCURRENCY cap: a hostile kernel cannot fan out unbounded streams.
      if (inFlight >= BROKER_MAX_CONCURRENCY) {
        refuse(res, 503, 'overloaded');
        return;
      }
      // Reserve synchronously, including body receipt. This is a local transport
      // slot, NOT evidence that a remote charge has been cancelled or refunded.
      inFlight += 1;
      exchangeSequence += 1;
      const sequence = exchangeSequence;
      const exchangeStarted = Date.now();
      let upstreamStatus: number | null = null;
      let responseBytes = 0;
      let usageDisposition = 'not-reached';
      let responseShape: ModelResponseShape | null = null;
      let settled = false;
      let proxied: ClientRequest | null = null;
      let admission: Awaited<ReturnType<NonNullable<typeof input.admission>>> | undefined;
      let abortListener: (() => void) | undefined;
      const respond = (status: number, reason: string): void => {
        if (res.writableEnded || res.destroyed) return;
        if (!res.headersSent) refuse(res, status, reason);
        else res.end();
      };
      const settle = (usage: InvocationResult['usage'] | null = null, endedBy = 'unspecified'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        inFlight -= 1;
        try {
          input.observe?.({
            sequence, endedBy, upstreamStatus, requestBytes: size, responseBytes, usageDisposition, responseShape,
            usage: usage === null ? null : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
            durationMs: Date.now() - exchangeStarted,
          });
        } catch { /* observation is evidence only; it never changes the exchange */ }
        if (admission !== undefined) {
          if (abortListener !== undefined) admission.signal.removeEventListener('abort', abortListener);
          void admission.settle(usage).catch(() => { proxied?.destroy(); respond(502, 'budget settlement unavailable'); }).finally(() => admission?.release());
        }
      };
      const deadline = setTimeout(() => {
        proxied?.destroy();
        respond(504, 'upstream timeout');
        settle(null, 'timeout');
      }, input.upstreamTimeoutMs ?? BROKER_UPSTREAM_TIMEOUT_MS);
      req.on('aborted', () => { proxied?.destroy(); settle(null, 'request-aborted'); });
      req.on('error', () => { proxied?.destroy(); respond(502, 'request failed'); settle(null, 'request-error'); });
      res.on('close', () => { proxied?.destroy(); settle(null, 'client-close'); });
      // BODY SIZE cap: read (and forward) at most BROKER_MAX_BODY_BYTES.
      const chunks: Buffer[] = [];
      let size = 0;
      let refused = false;
      req.on('data', (chunk: Buffer) => {
        if (refused) return;
        size += chunk.byteLength;
        if (size > BROKER_MAX_BODY_BYTES) {
          refused = true;
          refuse(res, 413, 'payload too large');
          settle(null, 'payload-too-large');
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { void (async () => {
        if (refused || settled || res.writableEnded) return;
        if (input.admission !== undefined) {
          try { admission = await input.admission(Buffer.concat(chunks)); }
          catch (error) {
            /*
             * H15d-fix3: a body past the proven input bound is a CONTEXT LIMIT, not a budget
             * verdict. It is answered in the OpenAI-compatible context-length shape so the
             * kernel's compaction recognises it, compacts, and retries — the refused request
             * never reached the network and reserved nothing. Every other refusal stays the
             * opaque 403 (hark-live-goal 40320541076 surfaced this as 'AUTH: 403' and lost
             * three attempts).
             */
            const details = (error as { details?: Record<string, unknown> } | null)?.details;
            if (details?.['reason'] === 'GOAL_KERNEL_REQUEST_INPUT_UNBOUNDED' && !res.headersSent && !res.writableEnded) {
              const body = JSON.stringify({ error: {
                message: `This request exceeds the maximum context length CompanyOS admits for this run (${String(details['inputUpperBound'])} request bytes; got ${String(details['requestBytes'])}). Compact the conversation and retry.`,
                type: 'invalid_request_error',
                code: 'context_length_exceeded',
              } });
              res.writeHead(400, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
              res.end(body);
              settle(null, 'admission-context-exceeded');
              return;
            }
            respond(403, 'budget admission refused'); settle(null, 'admission-refused'); return;
          }
          if (settled || admission.signal.aborted) {
            await admission.settle(null); admission.release();
            respond(403, 'execution stopped'); settle(null, 'stopped'); return;
          }
          abortListener = () => { proxied?.destroy(); respond(403, 'execution stopped'); settle(null, 'stopped'); };
          admission.signal.addEventListener('abort', abortListener, { once: true });
          if (admission.signal.aborted) { abortListener(); return; }
        }
        // HEADER allowlist: drop hop-by-hop + auth; the broker alone authorizes.
        const drop = new Set([
          'authorization', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
          'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
        ]);
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string' && !drop.has(name.toLowerCase())) headers[name] = value;
        }
        headers['content-length'] = String(size);
        // H15c-fix9: only codings the broker can decode for metering travel upstream.
        headers['accept-encoding'] = brokerAcceptEncoding(headers['accept-encoding']);
        /*
         * CREDENTIAL SCHEME GUARD (PROD-01B): the broker is the LAST line before the
         * network. A credential that is itself a reference scheme (vault://, secret://,
         * …) means an upstream resolution bug somewhere in CompanyOS — refuse the
         * exchange (fail closed) rather than ever sending a pointer as Authorization.
         */
        if (input.bearer !== '') {
          if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(input.bearer)) {
            refuse(res, 500, 'credential pointer refused');
            settle(null, 'credential-refused');
            return;
          }
          headers['authorization'] = `Bearer ${input.bearer}`;
        }
        // EXCHANGE LIFECYCLE (live-smoke fix 01): every failure below ends THIS broker
        // exchange with a sanitized response and releases the upstream request. Nothing
        // may escape this handler — a transport failure is the kernel's problem, never
        // an uncaught exception on the CompanyOS host process.
        try {
          proxied = upstreamRequest(
            {
              protocol: upstream.protocol,
              hostname: upstream.hostname,
              port: upstream.port,
              method: 'POST',
              path: `${upstreamPathPrefix}/chat/completions`,
              headers,
            },
            (upstreamResponse) => {
              if (settled || res.destroyed || res.writableEnded) {
                upstreamResponse.destroy();
                return;
              }
              // RESPONSE scrub: never echo Authorization or cookies downstream.
              const outHeaders: Record<string, string | number> = {};
              for (const [name, value] of Object.entries(upstreamResponse.headers)) {
                const lower = name.toLowerCase();
                if (lower === 'authorization' || lower === 'set-cookie') continue;
                outHeaders[name] = value as string | number;
              }
              upstreamStatus = upstreamResponse.statusCode ?? null;
              res.writeHead(upstreamResponse.statusCode ?? 502, outHeaders);
              // MID-STREAM upstream failure: end this exchange (a truncated stream the
              // kernel sees as a clear failure) — pipe() forwards no errors by itself.
              upstreamResponse.on('error', () => {
                upstreamResponse.destroy();
                respond(502, 'upstream stream failed');
              });
              // Bounded response observation; oversized/malformed/missing usage remains UNKNOWN.
              const usageChunks: Buffer[] = [];
              let observedBytes = 0;
              upstreamResponse.on('data', (chunk: Buffer) => {
                observedBytes += chunk.length;
                responseBytes = observedBytes;
                if (observedBytes <= 1_048_576) usageChunks.push(chunk);
              });
              upstreamResponse.on('end', () => {
                const status = upstreamResponse.statusCode ?? 500;
                const contentEncoding = String(upstreamResponse.headers['content-encoding'] ?? 'identity');
                const decoded = observedBytes > 1_048_576 || status >= 400 ? null : decodeResponseBody(Buffer.concat(usageChunks), contentEncoding);
                const observed = decoded === null
                  ? null
                  : observeResponseUsage(decoded.toString('utf8'), String(upstreamResponse.headers['content-type'] ?? ''), contentEncoding);
                usageDisposition = observedBytes > 1_048_576 ? 'oversize' : status >= 400 ? 'http-error' : decoded === null ? 'undecodable' : (observed?.disposition ?? 'absent');
                responseShape = observed?.shape ?? null;
                const usage = observed !== null && observed.disposition === 'observed' ? observed.usage : null;
                settle(usage, 'upstream-end');
              });
              upstreamResponse.pipe(res);
            },
          );
          proxied.on('error', () => {
            settle(null, 'upstream-error');
            respond(502, 'upstream unavailable');
          });
          // The kernel side ending (completion, cancel or abort) releases the upstream
          // request too — destroying a settled request is a no-op, so no orphans remain.
          proxied.on('close', () => settle(null, 'upstream-close'));
          proxied.end(Buffer.concat(chunks));
        } catch {
          // SYNCHRONOUS transport failure containment (the live-smoke P1): a request()
          // that throws (or any bug in this block) settles, destroys and answers 502
          // instead of unwinding into the host process.
          settle(null, 'transport-throw');
          proxied?.destroy();
          respond(502, 'upstream unavailable');
        }
      })().catch(() => { respond(502, 'broker admission unavailable'); settle(null, 'broker-error'); }); });
    });
    server.on('error', (error) => {
      resolve(
        err(
          domainError('PERSISTENCE_FAILED', 'The loopback model broker could not listen.', {
            reason: 'EXECUTOR_EMBEDDED_BROKER_LISTEN_FAILED',
            cause: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    });
    // Track each connection ONCE: a keep-alive socket carries many exchanges, and a
    // per-request 'close' listener leaked one listener per exchange (H15d run 2:
    // MaxListenersExceededWarning after 11 kernel calls on one socket).
    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        resolve(
          err(
            domainError('PERSISTENCE_FAILED', 'The loopback model broker bound no port.', {
              reason: 'EXECUTOR_EMBEDDED_BROKER_LISTEN_FAILED',
            }),
          ),
        );
        return;
      }
      resolve(
        ok({
          // The kernel-visible URL carries the capability nonce as a query param —
          // pi-ai forwards the endpoint query, so the child authenticates without
          // any secret-shaped env var (the S25 law stays intact) and the nonce is
          // never a header the child could drop.
          url: `http://127.0.0.1:${String(address.port)}/c/${routeSecret}/v1`,
          routeSecret,
          close: () => {
            for (const socket of sockets) socket.destroy();
            server.close();
          },
        }),
      );
    });
  });
