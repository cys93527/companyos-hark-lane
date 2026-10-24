/**
 * Port: secret resolution. Secrets live in the OS keychain (Electron
 * `safeStorage` / DPAPI / Keychain), never in SQLite plaintext and never in logs
 * (docs/SECURITY_MODEL.md).
 */
export interface SecretResolver {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Names of the known keys — values are NEVER listed. */
  keys(): Promise<readonly string[]>;
}

export const SECRET_SOURCES = ['env', 'os_keychain', 'external_vault'] as const;
export type SecretSource = (typeof SECRET_SOURCES)[number];

/**
 * A POINTER to a secret, never the value (Sprint 6).
 *
 * This is the only shape that may be persisted or logged: it says *which* credential a
 * provider needs and *where* it comes from. The value is resolved in memory at call time
 * (`SecretResolver.get`) and must never reach Git, logs, events, the handoff or SQLite.
 */
export interface SecretRef {
  readonly id: string;
  readonly providerId: string;
  readonly purpose: string;
  readonly source: SecretSource;
  /** Environment variable name, when `source === 'env'`. */
  readonly envName?: string;
}

/** Resolve a `SecretRef` to its value (or `null` when it is not configured). */
export interface SecretRefResolverPort {
  resolve(ref: SecretRef): Promise<string | null>;
  /** Which refs can currently be resolved — names only, never values. */
  available(): Promise<readonly string[]>;
}
