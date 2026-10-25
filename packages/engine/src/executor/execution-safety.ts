/**
 * Sprint25 — the SAFETY BOUNDARY of the provider execution seam.
 *
 * Three concerns live here, all of them PRECONDITIONS of execution (never owners of
 * execution truth):
 *
 *   1. the SECRET REFERENCE boundary — a `SecretRef` is a pointer that may be
 *      persisted, logged and carried in evidence; a resolved value is process
 *      memory for exactly one caller and never reaches a durable object, an
 *      artifact, an event, an error detail or a log line;
 *   2. the TYPED CONFIGURATION authority — effective values with their source,
 *      an explicit precedence, a deterministic fingerprint, and drift detection
 *      so a frozen ExecutionAttempt never silently runs under different config;
 *   3. the WORKSPACE / CWD authority — the trusted root is an
 *      application-supplied value, and every spawn cwd is proven to be that
 *      root (or inside it, by component boundary, with no reparse escape)
 *      immediately before the process is created.
 *
 * Nothing here spawns a process, holds a timer, or opens a transaction: it is a
 * pure decision layer whose output is a typed verdict consumed by the dispatch
 * orchestration. Vendor protocol and vendor names stay out of the engine — this
 * module is industry-neutral by construction.
 *
 * Honesty rules (docs/sprint25): TOCTOU is a real, documented residual window
 * between "validated" and "spawned" — it is stated, not denied. And nothing here
 * is a sandbox: the workspace check is an AUTHORIZATION boundary (which directory
 * may I touch), never an isolation guarantee.
 */
import {
  assertNoSecrets,
  DomainError,
  domainError,
  err,
  ok,
  redactSecrets,
  type Result,
  type SecretRef,
  type SecretRefResolverPort,
  type SecretSource,
  sha256Hex,
} from '@companyos/core';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

import { assertPathWithinCanonicalRoot, assertNoReparseEscape } from '../repository/path-policy.js';

/* ============================================================== secrets === */

/*
 * A pointer, never a value. The durable/loggable form of a credential need is the
 * frozen `SecretRef` (core/ports/secrets.ts). This guard makes smuggling a VALUE
 * through a ref-shaped object a typed failure instead of a leak: a secret value
 * that real load location or purpose field is not a pointer, and a pointer never
 * carries newlines.
 */
export const assertSecretRefIsPointer = (ref: SecretRef): Result<true, DomainError> => {
  const textFields: readonly (readonly [string, string | undefined])[] = [
    ['id', ref.id],
    ['providerId', ref.providerId],
    ['purpose', ref.purpose],
    ['envName', ref.envName],
  ];
  for (const [name, value] of textFields) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      return err(
        domainError('VALIDATION_FAILED', `The secret reference field "${name}" must be a non-empty name.`, {
          reason: 'SECRET_REF_FIELD_INVALID',
          field: name,
        }),
      );
    }
    if (value.length > 256 || /[\r\n]/.test(value)) {
      return err(
        domainError('VALIDATION_FAILED', `The secret reference field "${name}" must be a name, not material.`, {
          reason: 'SECRET_REF_NOT_A_POINTER',
          field: name,
          length: value.length,
        }),
      );
    }
  }
  if (ref.source !== 'env' && ref.envName !== undefined) {
    return err(
      domainError('VALIDATION_FAILED', 'Only an env-sourced secret reference may name an environment variable.', {
        reason: 'SECRET_REF_SOURCE_ENV_MISMATCH',
        source: ref.source,
      }),
    );
  }
  return ok(true);
};

/**
 * The two typed, fail-closed secret outcomes (Sprint25 §10-§12).
 *
 * `not-found` and `source-unavailable` are deliberately distinct: the operator's
 * remedy differs (configure the value vs repair the source), and an unreachable
 * source must never be read as "no secret needed" — an empty answer from a dead
 * keychain is indistinguishable from a successful empty configuration.
 */
export type ExecutionSecretOutcome =
  | 'resolved'
  | 'not-found'
  | 'source-unavailable'
  | 'ref-invalid';

/** What a caller may say about a secret resolution: names, never values. */
export interface ExecutionSecretReport {
  readonly purpose: string;
  readonly source: SecretSource;
  readonly outcome: ExecutionSecretOutcome;
}

const secretFailure = (
  ref: SecretRef,
  outcome: ExecutionSecretOutcome,
): DomainError => {
  const details = {
    reason: outcome === 'not-found' ? 'SECRET_NOT_FOUND_REASON' : 'SECRET_SOURCE_UNAVAILABLE_REASON',
    purpose: ref.purpose,
    source: ref.source,
    providerId: ref.providerId,
  };
  if (outcome === 'not-found') {
    return domainError('SECRET_NOT_FOUND', `The secret reference "${ref.purpose}" is not configured in ${ref.source}.`, details);
  }
  return domainError('SECRET_SOURCE_UNAVAILABLE', `The secret source "${ref.source}" could not be reached for "${ref.purpose}".`, details);
};

/**
 * Resolve a secret reference to its value, IN MEMORY, for exactly one caller.
 *
 * This is the only production surface that may hold a resolved value, and its
 * result is never persisted, logged, projected or returned in an error: callers
 * that need to *report* the resolution use `reportSecretResolution`, which
 * answers with names and outcomes only.
 */
export const resolveExecutionSecret = async (
  resolver: SecretRefResolverPort,
  ref: SecretRef,
): Promise<Result<string, DomainError>> => {
  const pointer = assertSecretRefIsPointer(ref);
  if (!pointer.ok) return pointer;
  let value: string | null;
  try {
    value = await resolver.resolve(ref);
  } catch (error) {
    return err(
      error instanceof DomainError
        ? error
        : secretFailure(ref, 'source-unavailable'),
    );
  }
  if (value === null) return err(secretFailure(ref, 'not-found'));
  return ok(value);
};

/** The resolution report for a verdict/observation: purpose + source + outcome. */
export const reportSecretResolution = async (
  resolver: SecretRefResolverPort,
  ref: SecretRef,
): Promise<ExecutionSecretReport> => {
  const pointer = assertSecretRefIsPointer(ref);
  if (!pointer.ok) {
    return { purpose: ref.purpose, source: ref.source, outcome: 'ref-invalid' };
  }
  try {
    const value = await resolver.resolve(ref);
    return { purpose: ref.purpose, source: ref.source, outcome: value === null ? 'not-found' : 'resolved' };
  } catch {
    return { purpose: ref.purpose, source: ref.source, outcome: 'source-unavailable' };
  }
};

/** Guard: no known secret material may travel inside this payload. Never echoes the value. */
export const assertNoSecretMaterial = (
  payload: unknown,
  knownSecrets: readonly string[],
  context: string,
): Result<true, DomainError> => assertNoSecrets(payload, knownSecrets, context);

/* =========================================================== environment === */

/**
 * Child-process environment policy (ADR-0028 D12 pattern, extended to the
 * executor seam).
 *
 * The parent environment is NEVER inherited wholesale: only allowlisted host
 * variables cross the boundary, plus the trusted composition's declared
 * additions. A declared addition is validated as a name/value pair and refused
 * when it is secret-shaped — a profile that tries to publish a credential fails
 * closed instead of leaking it.
 */
export interface ExecutorEnvironmentPolicy {
  readonly platform: NodeJS.Platform;
  readonly hostEnvAllowlist: readonly string[];
  /** Host environment prefixes that may pass (POSIX locale families). */
  readonly hostEnvPrefixes?: readonly string[];
  /** Trusted, composition-declared additions. Never secrets — validated here. */
  readonly declaredAdditions: Readonly<Record<string, string>>;
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
}

const WINDOWS_EXECUTOR_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
];
const POSIX_EXECUTOR_ENV_ALLOWLIST: readonly string[] = ['PATH', 'TMPDIR', 'LANG'];
const POSIX_EXECUTOR_ENV_PREFIXES: readonly string[] = ['LC_'];

const SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'SSH_AUTH_SOCK',
]);
/** Shapes, not names: any API key, access key, private key or auth material is refused. */
const SECRET_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|KEY|AUTH)/i;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isSecretEnvName = (key: string): boolean => SECRET_ENV_NAMES.has(key) || SECRET_ENV_PATTERN.test(key);

/**
 * Build the child environment: allowlisted host keys + validated declared
 * additions. Never the whole parent environment, never a SecretVault value — this
 * module holds no vault reference at all.
 *
 * Deliberately the SAME policy the repository process runner already enforces
 * (ADR-0028 D12): one environment law for every child process this system
 * creates, not a second one for providers.
 */
export const buildExecutorEnvironment = (
  policy: ExecutorEnvironmentPolicy,
): Result<Readonly<Record<string, string>>, DomainError> => {
  for (const [key, value] of Object.entries(policy.declaredAdditions ?? {})) {
    if (!ENV_KEY_PATTERN.test(key)) {
      return err(
        domainError('VALIDATION_FAILED', 'The provider configuration declares an invalid environment name.', {
          reason: 'EXECUTOR_ENV_NAME_INVALID',
          envKey: key,
        }),
      );
    }
    if (isSecretEnvName(key)) {
      return err(
        domainError('VALIDATION_FAILED', 'The provider configuration must not publish a secret-shaped variable.', {
          reason: 'EXECUTOR_ENV_SECRET_REFUSED',
          envKey: key,
        }),
      );
    }
    if (typeof value !== 'string' || value.includes('\u0000')) {
      return err(
        domainError('VALIDATION_FAILED', 'The provider configuration declares an invalid environment value.', {
          reason: 'EXECUTOR_ENV_VALUE_INVALID',
          envKey: key,
        }),
      );
    }
  }

  const filtered: Record<string, string> = {};
  const allowlist = policy.platform === 'win32' ? WINDOWS_EXECUTOR_ENV_ALLOWLIST : POSIX_EXECUTOR_ENV_ALLOWLIST;
  for (const key of allowlist) {
    const value = policy.hostEnv[key];
    if (typeof value === 'string') filtered[key] = value;
  }
  if (policy.platform !== 'win32') {
    for (const key of Object.keys(policy.hostEnv)) {
      const value = policy.hostEnv[key];
      if (typeof value !== 'string') continue;
      if ((policy.hostEnvPrefixes ?? POSIX_EXECUTOR_ENV_PREFIXES).some((prefix) => key.startsWith(prefix))) {
        filtered[key] = value;
      }
    }
  }
  // A declared addition may REFINE an allowlisted variable; it can never resurrect
  // a dropped one, and it has already cleared the secret-shape check above.
  for (const [key, value] of Object.entries(policy.declaredAdditions ?? {})) {
    filtered[key] = value;
  }
  return ok(filtered);
};

/** The allowlist this policy would apply — surfaced for tests and documentation. */
export const executorEnvAllowlistFor = (platform: NodeJS.Platform): readonly string[] =>
  platform === 'win32' ? WINDOWS_EXECUTOR_ENV_ALLOWLIST : POSIX_EXECUTOR_ENV_ALLOWLIST;

/** Would this declared environment name be refused as secret-shaped? */
export const isSecretShapedEnvName = isSecretEnvName;

/* ========================================================= configuration === */

/** Where an effective configuration value came from. Precedence: composition > environment > default. */
export type ExecutorConfigSource = 'composition' | 'environment' | 'default';

export interface ExecutorConfigFieldSpec<T> {
  readonly name: string;
  readonly kind: 'string' | 'absolute-path' | 'integer' | 'boolean';
  readonly required?: boolean;
  readonly defaultValue?: T;
  /** Integer bounds (inclusive) for `kind: 'integer'`. */
  readonly min?: number;
  readonly max?: number;
}

export type ExecutorConfigSchema = Readonly<Record<string, ExecutorConfigFieldSpec<unknown>>>;

/** One effective value with its provenance. Values here are never secret-shaped. */
export interface ExecutorConfigField {
  readonly name: string;
  readonly value: string | number | boolean;
  readonly source: ExecutorConfigSource;
}

export interface TypedExecutorConfig {
  readonly providerKey: string;
  readonly fields: readonly ExecutorConfigField[];
  /** Deterministic fingerprint over effective VALUES and their SOURCES. */
  readonly fingerprint: string;
}

export interface ExecutorConfigInput {
  readonly providerKey: string;
  readonly schema: ExecutorConfigSchema;
  /** Trusted composition overrides — highest precedence. */
  readonly composition?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Named environment values — middle precedence. Keys are env var NAMES. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Declared defaults — lowest precedence. */
  readonly defaults?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** The environment variable name for each field (when the field may come from the environment). */
  readonly envNames?: Readonly<Record<string, string>>;
  /**
   * The platform the configured paths are FOR (H14). Defaults to the host. A provider
   * that only runs on Windows (DSH) validates its `absolute-path` fields with the
   * Windows grammar wherever the configuration is checked.
   */
  readonly platform?: NodeJS.Platform;
}

const validateFieldValue = (
  spec: ExecutorConfigFieldSpec<unknown>,
  value: string | number | boolean,
  platform: NodeJS.Platform,
): Result<string | number | boolean, DomainError> => {
  switch (spec.kind) {
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') {
        return err(domainError('VALIDATION_FAILED', `The configuration field "${spec.name}" must be a non-empty string.`, { reason: 'EXECUTOR_CONFIG_INVALID', field: spec.name }));
      }
      return ok(value);
    case 'absolute-path':
      if (typeof value !== 'string' || !isAbsolutePath(value, platform)) {
        return err(domainError('VALIDATION_FAILED', `The configuration field "${spec.name}" must be an absolute path.`, { reason: 'EXECUTOR_CONFIG_PATH_NOT_ABSOLUTE', field: spec.name }));
      }
      return ok(value);
    case 'boolean':
      if (typeof value !== 'boolean') {
        return err(domainError('VALIDATION_FAILED', `The configuration field "${spec.name}" must be a boolean.`, { reason: 'EXECUTOR_CONFIG_INVALID', field: spec.name }));
      }
      return ok(value);
    case 'integer': {
      const asNumber = typeof value === 'string' ? Number(value) : value;
      if (typeof asNumber !== 'number' || !Number.isInteger(asNumber)) {
        return err(domainError('VALIDATION_FAILED', `The configuration field "${spec.name}" must be an integer.`, { reason: 'EXECUTOR_CONFIG_INVALID', field: spec.name }));
      }
      if (spec.min !== undefined && asNumber < spec.min) {
        return err(domainError('VALIDATION_FAILED', `The configuration field "${spec.name}" must be at least ${spec.min}.`, { reason: 'EXECUTOR_CONFIG_RANGE', field: spec.name, min: spec.min }));
      }
      if (spec.max !== undefined && asNumber > spec.max) {
        return err(domainError('VALIDATION_FAILED', `The configuration field "${spec.name}" must be at most ${spec.max}.`, { reason: 'EXECUTOR_CONFIG_RANGE', field: spec.name, max: spec.max }));
      }
      return ok(asNumber);
    }
  }
};

/**
 * H14 — the path grammar of the platform the value is FOR, never silently the host's.
 * Every seam here already takes a `platform` (default: the host); before H14 the
 * absolute-path test and `resolve()` ignored it and used the host's grammar, so a
 * `win32` decision evaluated on a POSIX host refused `C:\work` as "not absolute"
 * (and a POSIX decision on Windows would accept `\\server` forms it must not).
 */
const pathApiFor = (platform: NodeJS.Platform): typeof win32 => (platform === 'win32' ? win32 : posix);
const isAbsolutePath = (value: string, platform: NodeJS.Platform = process.platform): boolean =>
  pathApiFor(platform).isAbsolute(value);

/**
 * Resolve a typed, validated provider configuration with EXPLICIT precedence:
 * composition override → named environment variable → declared default. A missing
 * required field is a typed VALIDATION_FAILED load, never a silent fallback.
 *
 * Configuration is composition data (like the existing `providerKinds` /
 * `executorKinds` handler buckets): never provider-controlled, never
 * model-controlled, and always traceable to the source that produced it.
 */
export const resolveExecutorConfig = (input: ExecutorConfigInput): Result<TypedExecutorConfig, DomainError> => {
  const fields: ExecutorConfigField[] = [];
  for (const key of Object.keys(input.schema).sort()) {
    const spec = input.schema[key]!;
    const envName = input.envNames?.[key];
    const compositionValue = input.composition?.[key];
    const environmentValue = envName === undefined ? undefined : input.environment?.[envName];

    let value: string | number | boolean | undefined;
    let source: ExecutorConfigSource;
    if (compositionValue !== undefined && compositionValue !== '') {
      value = compositionValue;
      source = 'composition';
    } else if (environmentValue !== undefined && environmentValue !== '') {
      value = environmentValue;
      source = 'environment';
    } else {
      // The schema's own declared default is the lowest-precedence source; an
      // externally supplied default map (when present) refines it.
      const declaredDefault = (input.defaults?.[key] ?? spec.defaultValue) as
        | string
        | number
        | boolean
        | undefined;
      value = declaredDefault;
      source = 'default';
    }

    if (value === undefined) {
      if (spec.required === true) {
        return err(
          domainError('VALIDATION_FAILED', `The required provider configuration field "${spec.name}" is not set.`, {
            reason: 'EXECUTOR_CONFIG_REQUIRED_MISSING',
            field: spec.name,
            envName: envName ?? null,
          }),
        );
      }
      continue;
    }
    const validated = validateFieldValue(spec, value, input.platform ?? process.platform);
    if (!validated.ok) return validated;
    fields.push({ name: spec.name, value: validated.value, source });
  }

  const fingerprint = executorConfigFingerprint(fields);
  return ok({ providerKey: input.providerKey, fields, fingerprint });
};

/**
 * Deterministic derivation over effective values AND their sources: a different
 * source for the same value is a different fingerprint, because "this came from
 * the environment" and "this was composed" are different provenance facts for a
 * frozen attempt.
 */
export const executorConfigFingerprint = (fields: readonly ExecutorConfigField[]): string => {
  const canonical = fields
    .map((field) => `${field.name}=${String(field.value)}@${field.source}`)
    .sort()
    .join('\n');
  return `scfg_${sha256Hex(canonical).slice(0, 26)}`;
};

export const configFieldOf = (config: TypedExecutorConfig, name: string): ExecutorConfigField | null =>
  config.fields.find((field) => field.name === name) ?? null;

/**
 * Config-drift verdict for a FROZEN attempt: the fingerprint a dispatch was
 * claimed under versus the fingerprint it would be claimed under now.
 *
 * `no-history` is deliberately its own verdict: an attempt frozen before the
 * fingerprint field existed has UNKNOWN provenance. It is not "matched" and it is
 * not "drifted" — the caller records the current fingerprint on the binding so the
 * next resume can compare, and no silent substitution happens in the meantime.
 */
export type ConfigDriftVerdict =
  | { readonly kind: 'no-history' }
  | { readonly kind: 'match' }
  | { readonly kind: 'drift'; readonly previous: string; readonly current: string };

export const configDriftOf = (previous: string | null, current: string): ConfigDriftVerdict => {
  if (previous === null) return { kind: 'no-history' };
  if (previous === current) return { kind: 'match' };
  return { kind: 'drift', previous, current };
};

/**
 * Fail closed on drift: a frozen attempt never silently picks up a changed
 * configuration. The remedy is an explicit new attempt, not a substitution.
 */
export const assertConfigUnchanged = (
  previous: string | null,
  current: string,
): Result<true, DomainError> => {
  const verdict = configDriftOf(previous, current);
  if (verdict.kind === 'match' || verdict.kind === 'no-history') return ok(true);
  return err(
    domainError('CONFLICT', 'The provider configuration changed after this attempt was frozen.', {
      reason: 'EXECUTOR_CONFIG_DRIFT',
      previous: verdict.previous,
      current: verdict.current,
    }),
  );
};

/* ============================================================== workspace === */

export interface WorkspaceFsSeams {
  readonly realpath?: (p: string) => string;
  readonly stat?: (p: string) => { isDirectory(): boolean };
  readonly lstat?: (p: string) => { isSymbolicLink(): boolean };
  readonly platform?: NodeJS.Platform;
}

const defaultRealpath = (p: string): string => realpathSync(p);
const defaultStat = (p: string): { isDirectory(): boolean } => statSync(p);
const defaultLstat = (p: string): { isSymbolicLink(): boolean } => lstatSync(p);

/**
 * Canonicalize an APPLICATION-SUPPLIED workspace root.
 *
 * The root is trusted composition input (the same rule `openWorkspace` already
 * enforces): never a model, provider, task-payload or provider-stdout value. It
 * must be absolute, must exist, and must be a directory. The returned canonical
 * root is internal — consumers outside the seam only ever see the root itself.
 */
export const resolveTrustedWorkspaceRoot = (
  input: { readonly root: string } & WorkspaceFsSeams,
): Result<{ readonly canonicalRoot: string }, DomainError> => {
  const realpath = input.realpath ?? defaultRealpath;
  const stat = input.stat ?? defaultStat;
  const platform = input.platform ?? process.platform;
  const root = input.root;
  if (typeof root !== 'string' || root.trim() === '') {
    return err(domainError('INVALID_ARGUMENT', 'The workspace root must be a non-empty absolute path.', { reason: 'EXECUTION_WORKSPACE_ROOT_EMPTY' }));
  }
  if (!isAbsolutePath(root, platform)) {
    return err(domainError('INVALID_ARGUMENT', 'The workspace root must be an absolute path.', { reason: 'EXECUTION_WORKSPACE_ROOT_NOT_ABSOLUTE', suppliedLength: root.length }));
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpath(root);
  } catch {
    return err(domainError('INVALID_ARGUMENT', 'The workspace root does not exist (or is unreadable).', { reason: 'EXECUTION_WORKSPACE_ROOT_MISSING' }));
  }
  try {
    if (!stat(canonicalRoot).isDirectory()) {
      return err(domainError('INVALID_ARGUMENT', 'The workspace root is not a directory.', { reason: 'EXECUTION_WORKSPACE_ROOT_NOT_DIRECTORY' }));
    }
  } catch {
    return err(domainError('INVALID_ARGUMENT', 'The workspace root does not exist (or is unreadable).', { reason: 'EXECUTION_WORKSPACE_ROOT_MISSING' }));
  }
  return ok({ canonicalRoot });
};

/**
 * Prove that a spawn cwd is allowed: present, absolute, existing directory,
 * canonicalized, contained in the trusted root by PATH COMPONENT BOUNDARY (never
 * a raw string prefix — `C:\work\foo` must not accept `C:\work\foobar`), and free
 * of reparse escapes on the way out of the root.
 *
 * `resolve()` is applied first, so `C:\work\root\..\other` normalizes BEFORE the
 * containment comparison — a traversal written in absolute form is not a way past
 * a prefix check.
 */
export const assertExecutionCwdAllowed = (
  input: { readonly cwd: string; readonly canonicalRoot: string } & WorkspaceFsSeams,
): Result<{ readonly canonicalCwd: string }, DomainError> => {
  const realpath = input.realpath ?? defaultRealpath;
  const stat = input.stat ?? defaultStat;
  const lstat = input.lstat ?? defaultLstat;
  const platform = input.platform ?? process.platform;
  const cwd = input.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return err(domainError('INVALID_ARGUMENT', 'No execution cwd was supplied; refusing to spawn in an arbitrary directory.', { reason: 'EXECUTION_CWD_MISSING' }));
  }
  if (!isAbsolutePath(cwd, platform)) {
    return err(domainError('INVALID_ARGUMENT', 'The execution cwd must be an absolute path.', { reason: 'EXECUTION_CWD_NOT_ABSOLUTE' }));
  }

  const normalized = pathApiFor(platform).resolve(cwd);
  const containment = assertPathWithinCanonicalRoot({
    candidate: normalized,
    canonicalRoot: input.canonicalRoot,
    platform,
  });
  if (!containment.ok) return containment;

  let canonicalCwd: string;
  try {
    canonicalCwd = realpath(normalized);
  } catch {
    return err(domainError('INVALID_ARGUMENT', 'The execution cwd does not exist.', { reason: 'EXECUTION_CWD_MISSING_ON_DISK' }));
  }
  const containedCanonical = assertPathWithinCanonicalRoot({
    candidate: canonicalCwd,
    canonicalRoot: input.canonicalRoot,
    platform,
  });
  if (!containedCanonical.ok) return containedCanonical;

  try {
    if (!stat(canonicalCwd).isDirectory()) {
      return err(domainError('INVALID_ARGUMENT', 'The execution cwd is not a directory.', { reason: 'EXECUTION_CWD_NOT_DIRECTORY' }));
    }
  } catch {
    return err(domainError('INVALID_ARGUMENT', 'The execution cwd does not exist.', { reason: 'EXECUTION_CWD_MISSING_ON_DISK' }));
  }

  const reparse = assertNoReparseEscape({
    canonicalRoot: input.canonicalRoot,
    targetPath: canonicalCwd,
    lstat,
    platform,
  });
  if (!reparse.ok) return reparse;

  return ok({ canonicalCwd });
};

/**
 * The WRITE BOUNDARY of a workspace-executed task: everything an execution writes
 * must land inside the trusted root. A path outside it — by traversal, by device
 * path, by UNC, or by a reparse escape — is refused, never relocated silently.
 */
export const assertWritePathWithinRoot = (
  input: { readonly targetPath: string; readonly canonicalRoot: string } & WorkspaceFsSeams,
): Result<{ readonly canonicalTarget: string }, DomainError> => {
  const realpath = input.realpath ?? defaultRealpath;
  const lstat = input.lstat ?? defaultLstat;
  const platform = input.platform ?? process.platform;
  const normalized = pathApiFor(platform).resolve(input.targetPath);
  const containment = assertPathWithinCanonicalRoot({
    candidate: normalized,
    canonicalRoot: input.canonicalRoot,
    platform,
  });
  if (!containment.ok) return containment;
  const reparse = assertNoReparseEscape({
    canonicalRoot: input.canonicalRoot,
    targetPath: normalized,
    lstat,
    platform,
  });
  if (!reparse.ok) return reparse;
  let canonicalTarget: string;
  try {
    canonicalTarget = realpath(normalized);
  } catch {
    // A not-yet-existing target is legitimate for a write; containment of the
    // normalized path already proved it inside the root, and its nearest existing
    // ancestor was reparse-checked.
    canonicalTarget = normalized;
  }
  return ok({ canonicalTarget });
};

/* ============================================================== preflight === */

export type ExecutionSafetyStageName =
  | 'config-valid'
  | 'secret-refs-resolvable'
  | 'workspace-trusted'
  | 'cwd-allowed'
  | 'capabilities-supported'
  | 'authorization-present';

export interface ExecutionSafetyStageResult {
  readonly stage: ExecutionSafetyStageName;
  readonly ok: boolean;
  /** Typed reason code (never a secret, never a physical root path). */
  readonly reason?: string;
}

export interface ExecutionSafetyRequest {
  readonly providerKey: string;
  /**
   * The typed, validated configuration this dispatch would run under. `null` means no
   * validated configuration was supplied — the config-valid stage fails closed.
   */
  readonly config: TypedExecutorConfig | null;
  /** Secret references this dispatch needs. V1 local provider: NONE (proven by probe). */
  readonly secretRefs?: readonly SecretRef[];
  /** The application-trusted workspace root, or null when the caller has none. */
  readonly workspaceRoot?: string | null;
  readonly cwd?: string | null;
  readonly requiredCapabilities?: readonly string[];
  readonly advertisedCapabilities?: readonly string[];
  readonly authorization?: boolean;
  /** The previous dispatch's fingerprint, when resuming a frozen attempt. */
  readonly previousConfigFingerprint?: string | null;
}

export interface ExecutionSafetyVerdict {
  readonly safe: boolean;
  /** Every stage evaluated IN CONTRACT ORDER; the first failure ends the sequence. */
  readonly stages: readonly ExecutionSafetyStageResult[];
  readonly failedStage: ExecutionSafetyStageName | null;
  readonly error: DomainError | null;
  /** Null only when the configuration itself failed — there is no provenance to name. */
  readonly configFingerprint: string | null;
  /** Names and outcomes only — never values. */
  readonly secretReports: readonly ExecutionSecretReport[];
  readonly canonicalCwd: string | null;
  readonly canonicalRoot: string | null;
}

const STAGE_ORDER: readonly ExecutionSafetyStageName[] = [
  'config-valid',
  'secret-refs-resolvable',
  'workspace-trusted',
  'cwd-allowed',
  'capabilities-supported',
  'authorization-present',
];

/**
 * The ordered safety preflight (contract §30): config valid → secret refs
 * resolvable → workspace trusted → cwd allowed → capabilities supported →
 * authorization present, BEFORE any provider side effect.
 *
 * This is a phase INSIDE the canonical ExecutionAttempt window — never a second
 * lifecycle, never a parallel truth. A failure is a typed verdict the dispatch
 * orchestration turns into an ordinary failed outcome that the ENGINE settles
 * canonically.
 */
export const assertExecutionSafety = async (
  request: ExecutionSafetyRequest,
  seams: WorkspaceFsSeams & {
    readonly secretResolver?: SecretRefResolverPort;
    readonly authorize?: (authority: string) => Promise<boolean>;
  } = {},
): Promise<ExecutionSafetyVerdict> => {
  const stages: ExecutionSafetyStageResult[] = [];
  const secretReports: ExecutionSecretReport[] = [];
  let canonicalRoot: string | null = null;
  let canonicalCwd: string | null = null;

  const fail = (stage: ExecutionSafetyStageName, error: DomainError): ExecutionSafetyVerdict => ({
    safe: false,
    stages: [...stages, { stage, ok: false, reason: String(error.details['reason'] ?? error.code) }],
    failedStage: stage,
    error,
    configFingerprint: request.config?.fingerprint ?? null,
    secretReports,
    canonicalCwd,
    canonicalRoot,
  });
  const pass = (stage: ExecutionSafetyStageName): void => {
    stages.push({ stage, ok: true });
  };

  // 1 — configuration valid. A dispatch with no validated config has no provenance.
  if (request.config === null || request.config.providerKey !== request.providerKey || request.config.fields.length === 0) {
    return fail('config-valid', domainError('VALIDATION_FAILED', 'The provider configuration is missing or empty for this dispatch.', { reason: 'EXECUTOR_CONFIG_MISSING', providerKey: request.providerKey }));
  }
  pass('config-valid');

  // 2 — secret refs resolvable (V1: the local executor declares none — proven by probe).
  for (const ref of request.secretRefs ?? []) {
    const report = await reportSecretResolution(seams.secretResolver ?? EMPTY_RESOLVER, ref);
    secretReports.push(report);
    if (report.outcome !== 'resolved') {
      const outcomeError = report.outcome === 'not-found'
        ? domainError('SECRET_NOT_FOUND', `The secret reference "${ref.purpose}" is not configured in ${ref.source}.`, { reason: 'SECRET_NOT_FOUND_REASON', purpose: ref.purpose, source: ref.source })
        : domainError('SECRET_SOURCE_UNAVAILABLE', `The secret source "${ref.source}" could not be reached for "${ref.purpose}".`, { reason: 'SECRET_SOURCE_UNAVAILABLE_REASON', purpose: ref.purpose, source: ref.source });
      return fail('secret-refs-resolvable', outcomeError);
    }
  }
  pass('secret-refs-resolvable');

  // 3 — workspace trusted.
  const root = request.workspaceRoot;
  if (typeof root !== 'string' || root.trim() === '') {
    return fail('workspace-trusted', domainError('POLICY_DENIED', 'No trusted workspace root was supplied for this execution.', { reason: 'EXECUTION_WORKSPACE_UNTRUSTED' }));
  }
  const resolvedRoot = resolveTrustedWorkspaceRoot({ root, ...seams });
  if (!resolvedRoot.ok) return fail('workspace-trusted', resolvedRoot.error);
  canonicalRoot = resolvedRoot.value.canonicalRoot;
  pass('workspace-trusted');

  // 4 — cwd allowed (component-boundary containment + reparse escape + directory).
  const cwd = request.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return fail('cwd-allowed', domainError('POLICY_DENIED', 'No execution cwd was supplied; refusing to spawn in an arbitrary directory.', { reason: 'EXECUTION_CWD_MISSING' }));
  }
  const cwdCheck = assertExecutionCwdAllowed({ cwd, canonicalRoot, ...seams });
  if (!cwdCheck.ok) return fail('cwd-allowed', cwdCheck.error);
  canonicalCwd = cwdCheck.value.canonicalCwd;
  pass('cwd-allowed');

  // 5 — capabilities supported: required ⊆ advertised. Fail loud, never silent degradation.
  const required = request.requiredCapabilities ?? [];
  const advertised = new Set(request.advertisedCapabilities ?? []);
  const missing = required.filter((capability) => !advertised.has(capability));
  if (missing.length > 0) {
    return fail('capabilities-supported', domainError('CAPABILITY_MISSING', `The provider does not advertise: ${missing.join(', ')}.`, { reason: 'EXECUTOR_CAPABILITY_MISSING', missing, providerKey: request.providerKey }));
  }
  pass('capabilities-supported');

  // 6 — authorization present. A dangerous execution needs the EXISTING approval
  // machinery — never an ad-hoc boolean, never an implicit allow.
  const authority = request.authorization ?? false;
  if (!authority) {
    return fail('authorization-present', domainError('APPROVAL_REQUIRED', 'No authorization was present for this execution.', { reason: 'EXECUTION_AUTHORIZATION_MISSING', providerKey: request.providerKey }));
  }
  pass('authorization-present');

  return {
    safe: true,
    stages,
    failedStage: null,
    error: null,
    configFingerprint: request.config === null ? null : request.config.fingerprint,
    secretReports,
    canonicalCwd,
    canonicalRoot,
  };
};

/** The empty resolver: a secret requirement with nothing to resolve it fails closed. */
const EMPTY_RESOLVER: SecretRefResolverPort = {
  async resolve(): Promise<string | null> {
    return null;
  },
  async available(): Promise<readonly string[]> {
    return [];
  },
};

/** The preflight stage sequence, in contract order (tests and docs quote this). */
export const EXECUTION_SAFETY_STAGE_ORDER: readonly ExecutionSafetyStageName[] = STAGE_ORDER;

/* ============================================================== redaction === */

/**
 * Redact every known secret value from provider diagnostics before the text goes
 * anywhere a human or a durable store can see it.
 *
 * This delegates to Core's single redaction authority (`redactSecrets`): there is
 * exactly one masking implementation in this system, so "where is text scrubbed"
 * has one answer and cannot drift between call sites.
 */
export const redactExecutionText = (
  text: string,
  knownSecrets: readonly string[],
): string => redactSecrets(text, knownSecrets);
