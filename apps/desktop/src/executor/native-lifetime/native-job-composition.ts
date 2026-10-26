/**
 * Hark lane — H15b: PRODUCTION composition of the Job-backed native executor
 * (`native.job`). The ONE place the H3–H7 native-lifetime stack is assembled for
 * the shipped app; core-services reaches it only through a dynamic import, and
 * only when the deployment declared native job operations.
 *
 * Fail-closed by construction:
 *   - win32/x64 only. Any other host -> NATIVE_JOB_UNSUPPORTED_PLATFORM. There is
 *     NO fallback to an unbounded child_process spawn: an operation declared as a
 *     Job operation either runs inside a kill-on-close Job Object or not at all.
 *   - The binding is koffi EXACTLY 3.3.3, shipped as an install resource with a
 *     sha256 manifest written at build time from the sha512-integrity-checked npm
 *     install. Every listed file is re-hashed, the directory may hold nothing
 *     unlisted, and only then is the module required. Any mismatch ->
 *     NATIVE_JOB_BINDING_REFUSED (zero native calls).
 *   - Operations are trusted deployment data: absolute executable + inputs, each
 *     sha256-pinned; the adapter pins them (deny write/delete) and re-hashes
 *     through the handle before any Job or process exists (launchPinning REQUIRED).
 *   - Assignment is ATOMIC_REQUIRED (the root is created inside the Job), output
 *     is captured through HANDLE_LIST pipes, bounded.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import { createNativeJobExecutorProvider, NATIVE_JOB_PROVIDER_KEY, type NativeJobOperation, type NativeJobProvider } from './job-executor-contract.js';
import { createJobLifetimeAdapter } from './job-lifetime.js';
import { createKoffiFilePinPort, createKoffiJobPort, KOFFI_PINNED_VERSION, type KoffiLike } from './koffi-job-port.js';

export { NATIVE_JOB_PROVIDER_KEY, KOFFI_PINNED_VERSION };
export type { KoffiLike };
export type { NativeJobOperation };

/** The install-resource directory name of the pinned binding (`<resources>/native/<dir>`). */
export const NATIVE_JOB_BINDING_DIR = `koffi-${KOFFI_PINNED_VERSION}`;
export const NATIVE_JOB_BINDING_MANIFEST = 'binding-manifest.json';
/** Per-stream capture bound (bytes kept; the rest is drained and counted). */
export const NATIVE_JOB_OUTPUT_CAP_BYTES = 1 << 20;
export const NATIVE_JOB_MAX_TIMEOUT_MS = 600_000;

export interface NativeJobBindingManifest {
  readonly package: 'koffi';
  readonly version: string;
  /** Relative POSIX path -> sha256 hex, covering EVERY file in the binding directory. */
  readonly files: Readonly<Record<string, string>>;
}

export type NativeJobCompositionResult =
  | { readonly ok: true; readonly provider: NativeJobProvider }
  | { readonly ok: false; readonly reasonCode: string; readonly detail: string };

export interface NativeJobCompositionInput {
  readonly bindingDir: string;
  readonly operations: Readonly<Record<string, NativeJobOperation>>;
  readonly host?: { readonly platform: string; readonly arch: string };
  /** Test seam: the module loader (defaults to createRequire on the binding dir). */
  readonly load?: (bindingDir: string) => KoffiLike;
  readonly nowIso?: () => string;
}

const refused = (reasonCode: string, detail: string): NativeJobCompositionResult => ({ ok: false, reasonCode, detail });

const listFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
};

/** Verify the shipped binding against its manifest. Returns null when it is exactly the pinned build. */
export const verifyNativeJobBinding = (bindingDir: string): string | null => {
  const manifestPath = join(bindingDir, NATIVE_JOB_BINDING_MANIFEST);
  if (!existsSync(manifestPath)) return 'binding manifest missing';
  let manifest: NativeJobBindingManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as NativeJobBindingManifest;
  } catch {
    return 'binding manifest unreadable';
  }
  if (manifest.package !== 'koffi' || manifest.version !== KOFFI_PINNED_VERSION) return `binding is not koffi ${KOFFI_PINNED_VERSION}`;
  const listed = Object.keys(manifest.files ?? {}).sort();
  if (listed.length === 0) return 'binding manifest lists no files';
  const present = listFiles(bindingDir).filter((f) => f !== NATIVE_JOB_BINDING_MANIFEST);
  const unlisted = present.filter((f) => !(f in manifest.files));
  if (unlisted.length > 0) return `unlisted binding file(s): ${unlisted.slice(0, 5).join(', ')}`;
  for (const rel of listed) {
    if (rel.includes('..') || isAbsolute(rel)) return `illegal manifest path ${rel}`;
    const p = join(bindingDir, ...rel.split('/'));
    if (!existsSync(p)) return `binding file missing: ${rel}`;
    const digest = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (digest !== manifest.files[rel]) return `binding file sha256 mismatch: ${rel}`;
  }
  return null;
};

const defaultLoad = (bindingDir: string): KoffiLike =>
  createRequire(join(bindingDir, 'node_modules', 'koffi', 'package.json'))('koffi') as KoffiLike;

/**
 * H17a: the same verify-then-require path for another main-process consumer of the
 * shipped binding (the provider-setup DPAPI decrypt). Nothing is required unless the
 * directory is exactly the pinned, manifest-listed build.
 */
export const loadVerifiedKoffiBinding = (
  bindingDir: string,
  load: (bindingDir: string) => KoffiLike = defaultLoad,
): { readonly ok: true; readonly koffi: KoffiLike } | { readonly ok: false; readonly detail: string } => {
  const problem = verifyNativeJobBinding(bindingDir);
  if (problem !== null) return { ok: false, detail: problem };
  try {
    return { ok: true, koffi: load(bindingDir) };
  } catch (e) {
    return { ok: false, detail: `binding failed to load: ${e instanceof Error ? e.message : String(e)}` };
  }
};

export const composeNativeJobProvider = (input: NativeJobCompositionInput): NativeJobCompositionResult => {
  const host = input.host ?? process;
  if (host.platform !== 'win32' || host.arch !== 'x64') {
    return refused('NATIVE_JOB_UNSUPPORTED_PLATFORM', `native.job requires win32/x64 (host ${host.platform}/${host.arch}); no unbounded fallback exists`);
  }
  if (Object.keys(input.operations).length === 0) return refused('NATIVE_JOB_NO_OPERATIONS', 'no native job operations declared');
  // Operations are Windows launch data: judged with win32 path grammar on every host.
  for (const [kind, op] of Object.entries(input.operations)) {
    if (!win32.isAbsolute(op.executable.path) || !/^[0-9a-f]{64}$/u.test(op.executable.sha256)) return refused('NATIVE_JOB_OPERATION_INVALID', `${kind}: executable must be absolute and sha256-pinned`);
    for (const i of op.inputs) if (!win32.isAbsolute(i.path) || !/^[0-9a-f]{64}$/u.test(i.sha256)) return refused('NATIVE_JOB_OPERATION_INVALID', `${kind}: every input must be absolute and sha256-pinned`);
    if (!(op.timeoutMs > 0 && op.timeoutMs <= NATIVE_JOB_MAX_TIMEOUT_MS)) return refused('NATIVE_JOB_OPERATION_INVALID', `${kind}: timeout out of range`);
  }
  const problem = verifyNativeJobBinding(input.bindingDir);
  if (problem !== null) return refused('NATIVE_JOB_BINDING_REFUSED', problem);
  let koffi: KoffiLike;
  try {
    koffi = (input.load ?? defaultLoad)(input.bindingDir);
  } catch (e) {
    return refused('NATIVE_JOB_BINDING_REFUSED', `binding failed to load: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const adapter = createJobLifetimeAdapter({
      port: createKoffiJobPort(koffi, host),
      pinPort: createKoffiFilePinPort(koffi, host),
      clock: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      host,
      assignment: 'ATOMIC_REQUIRED',
      launchPinning: 'REQUIRED',
      captureOutput: { maxBytes: NATIVE_JOB_OUTPUT_CAP_BYTES },
    });
    const provider = createNativeJobExecutorProvider({
      operations: input.operations,
      adapter,
      policy: { platform: 'win32', requireExeSuffix: true, maxTimeoutMs: NATIVE_JOB_MAX_TIMEOUT_MS },
      nowIso: input.nowIso ?? (() => new Date().toISOString()),
    });
    return { ok: true, provider };
  } catch (e) {
    return refused('NATIVE_JOB_BINDING_REFUSED', e instanceof Error ? e.message : String(e));
  }
};
