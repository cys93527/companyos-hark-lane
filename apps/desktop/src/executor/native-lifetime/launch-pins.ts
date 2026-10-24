/**
 * Hark lane — Phase 3B-3E: launch identity pinning.
 *
 * Converts a trusted outer caller's launch description into an immutable
 * `VerifiedLaunch`. The lifetime adapter accepts ONLY objects minted here
 * (module-private WeakSet brand), never a Boolean "approved" flag, so a caller
 * cannot fabricate a verified launch by object literal.
 *
 * What verification proves: the executable/input bytes hash to the pins at
 * verification time, paths are absolute, alias-free (no symlink/junction in any
 * component, realpath equal), single-link files, cwd contained in the workspace
 * root, argv is literal data, environment is a closed allowlist.
 *
 * What it does NOT prove: that the caller was authorized to run anything, that
 * bytes cannot change between verification and CreateProcess (TOCTOU remains
 * until a native handle-pinned launch is reviewed), isolation, or budget.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path';

export interface LaunchIdentity {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
}

export interface LaunchRequest {
  readonly identity: LaunchIdentity;
  readonly executable: { readonly path: string; readonly sha256: string };
  /** Every script/input file the argv refers to must be pinned separately. */
  readonly inputs: readonly { readonly path: string; readonly sha256: string }[];
  readonly argv: readonly string[];
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface VerifiedLaunch {
  readonly identity: LaunchIdentity;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly inputs: readonly { readonly path: string; readonly sha256: string }[];
  readonly argv: readonly string[];
  readonly commandLine: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly environmentBlock: Uint8Array;
  readonly environmentNames: readonly string[];
  readonly timeoutMs: number;
}

export class LaunchRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`NATIVE_LAUNCH_REFUSED: ${reason}`);
    this.name = 'LaunchRefused';
    this.reason = reason;
  }
}

export interface LaunchPolicy {
  /** Host path semantics. 'win32' compares case-insensitively. */
  readonly platform: NodeJS.Platform;
  /** Windows launches require a PE `.exe` target; never a script/shell. */
  readonly requireExeSuffix: boolean;
  readonly maxTimeoutMs: number;
}

export const DEFAULT_LAUNCH_POLICY: LaunchPolicy = Object.freeze({
  platform: process.platform,
  requireExeSuffix: true,
  maxTimeoutMs: 600_000,
});

/** Closed allowlist. NODE_OPTIONS / PATH / proxy / credential variables are
 * refused outright: they are code-injection or egress vectors. */
export const ENVIRONMENT_ALLOWLIST: ReadonlySet<string> = new Set([
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOME',
  'COMPANYOS_TEST_MODE',
]);
const REQUIRED_ENVIRONMENT = ['SYSTEMROOT', 'TEMP', 'TMP'] as const;
const PROFILE_DIRECTORIES = new Set(['TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME']);
const MAX_ENVIRONMENT_CHARS = 32_767;
const MAX_COMMAND_LINE_CHARS = 32_767;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const minted = new WeakSet<object>();

export function isVerifiedLaunch(value: unknown): value is VerifiedLaunch {
  return typeof value === 'object' && value !== null && minted.has(value);
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function aliasFree(path: string, kind: 'file' | 'directory', policy: LaunchPolicy): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw new LaunchRefused('path-not-absolute');
  }
  const full = resolve(path);
  const trimmed = path.length > parse(path).root.length ? path.replace(/[\\/]+$/u, '') : path;
  if (!samePath(full, trimmed, policy.platform)) {
    // `..` segments, `.` or redundant separators: refuse instead of normalising silently.
    throw new LaunchRefused('path-not-canonical');
  }
  for (let p = full; ; p = dirname(p)) {
    let link: boolean;
    try {
      link = lstatSync(p).isSymbolicLink();
    } catch {
      throw new LaunchRefused('path-missing');
    }
    if (link || !samePath(realpathSync.native(p), p, policy.platform)) throw new LaunchRefused('path-alias');
    if (p === parse(p).root) break;
  }
  const stat = statSync(full);
  if (kind === 'directory' && !stat.isDirectory()) throw new LaunchRefused('path-not-directory');
  if (kind === 'file' && (!stat.isFile() || stat.nlink !== 1)) throw new LaunchRefused('path-not-single-link-file');
  return full;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function pinned(path: string, sha256: string, policy: LaunchPolicy): { path: string; sha256: string } {
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) throw new LaunchRefused('pin-malformed');
  const full = aliasFree(path, 'file', policy);
  if (sha256Of(readFileSync(full)) !== sha256) throw new LaunchRefused('pin-mismatch');
  return { path: full, sha256 };
}

/**
 * Quote one argument for CreateProcessW so that CommandLineToArgvW / the MSVC
 * runtime parse it back to exactly the same string.
 */
export function quoteWindowsArgument(arg: string): string {
  if (arg !== '' && !/[\s"]/u.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/** Ordinal, case-insensitive (upper-cased UTF-16 code unit) comparison, the
 * order Windows requires inside a Unicode environment block. Locale collation
 * (`localeCompare`) is NOT that order and is deliberately not used. */
export function compareEnvironmentNames(a: string, b: string): number {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

export function buildEnvironmentBlock(
  environment: Readonly<Record<string, string>>,
  workspaceRoot: string,
  policy: LaunchPolicy,
): { block: Uint8Array; names: string[] } {
  const seen = new Set<string>();
  const entries = Object.entries(environment);
  for (const [key, value] of entries) {
    const name = key.toUpperCase();
    if (key === '' || /[=\0]/u.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new LaunchRefused('environment-malformed');
    }
    if (!ENVIRONMENT_ALLOWLIST.has(name)) throw new LaunchRefused(`environment-not-allowlisted:${name}`);
    if (seen.has(name)) throw new LaunchRefused('environment-duplicate');
    seen.add(name);
    if (PROFILE_DIRECTORIES.has(name) && !contained(workspaceRoot, aliasFree(value, 'directory', policy))) {
      throw new LaunchRefused('environment-profile-outside-workspace');
    }
    if (name === 'COMPANYOS_TEST_MODE' && value !== 'OFFLINE') throw new LaunchRefused('environment-test-mode');
  }
  for (const required of REQUIRED_ENVIRONMENT) {
    if (!seen.has(required)) throw new LaunchRefused(`environment-missing:${required}`);
  }
  const sorted = [...entries].sort(([a], [b]) => compareEnvironmentNames(a, b));
  const text = `${sorted.map(([k, v]) => `${k}=${v}`).join('\0')}\0\0`;
  if (text.length > MAX_ENVIRONMENT_CHARS) throw new LaunchRefused('environment-too-large');
  return { block: Uint8Array.from(Buffer.from(text, 'utf16le')), names: sorted.map(([k]) => k) };
}

export function verifyLaunch(request: LaunchRequest, policy: LaunchPolicy = DEFAULT_LAUNCH_POLICY): VerifiedLaunch {
  const identity = request.identity;
  for (const value of [identity?.runId, identity?.taskId, identity?.attemptId]) {
    if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) throw new LaunchRefused('identity-incomplete');
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > policy.maxTimeoutMs) {
    throw new LaunchRefused('duration-refused');
  }
  const root = aliasFree(request.workspaceRoot, 'directory', policy);
  const cwd = aliasFree(request.cwd, 'directory', policy);
  if (!contained(root, cwd)) throw new LaunchRefused('cwd-outside-workspace');
  if (policy.requireExeSuffix && !request.executable.path.toLowerCase().endsWith('.exe')) {
    throw new LaunchRefused('executable-not-exe');
  }
  const exe = pinned(request.executable.path, request.executable.sha256, policy);
  const inputs = request.inputs.map(pin => Object.freeze(pinned(pin.path, pin.sha256, policy)));
  const argv = [...request.argv];
  if (argv.some(a => typeof a !== 'string' || a.includes('\0') || /[\r\n]/u.test(a))) {
    throw new LaunchRefused('argv-refused');
  }
  const commandLine = [exe.path, ...argv].map(quoteWindowsArgument).join(' ');
  if (commandLine.length > MAX_COMMAND_LINE_CHARS) throw new LaunchRefused('command-too-large');
  const env = buildEnvironmentBlock(request.environment, root, policy);
  const verified: VerifiedLaunch = Object.freeze({
    identity: Object.freeze({ runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId }),
    executablePath: exe.path,
    executableSha256: exe.sha256,
    inputs: Object.freeze(inputs),
    argv: Object.freeze(argv),
    commandLine,
    workspaceRoot: root,
    cwd,
    environmentBlock: env.block,
    environmentNames: Object.freeze(env.names),
    timeoutMs: request.timeoutMs,
  });
  minted.add(verified);
  return verified;
}
