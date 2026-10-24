/**
 * Secret boundary (Sprint 6): an in-memory / environment resolver plus a redaction
 * registry.
 *
 * Rules enforced here:
 *   - values are held in memory only, for the lifetime of the process;
 *   - `keys()` and `available()` list NAMES, never values;
 *   - every value registered here is handed to the provider registry so it can be masked
 *     in logs, events and error details (`redactSecrets`).
 */
import {
  DomainError,
  domainError,
  err,
  ok,
  type Result,
  type SecretRef,
  type SecretRefResolverPort,
  type SecretResolver,
} from '@companyos/core';

export interface EnvSecretResolverInput {
  /** Where the values come from: normally `process.env`, injected for testability. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Optional prefix filter, e.g. only keys starting with `COMPANYOS_`. */
  readonly prefix?: string;
  /**
   * Authorization policy (Sprint 7, closing the Sprint 6 debt): when wired, the
   * authority-checked `read` / `write` / `remove` methods enforce `secret.read` and
   * `secret.write`. The raw `SecretResolver` methods stay for contract compatibility.
   */
  readonly authorize?: (input: {
    readonly actorId: string;
    readonly authority: string;
    readonly scopeId?: string;
  }) => Promise<Result<true, DomainError>>;
}

export interface SecretVault extends SecretResolver, SecretRefResolverPort {
  /** Values that must never leave the process (used for redaction, never persisted). */
  values(): readonly string[];
  /** Register a value that arrived from elsewhere so it is redacted too. */
  remember(value: string): void;
  /** Authority-checked read (`secret.read`). Never returns the value in an error. */
  read(key: string, actorId: string): Promise<Result<string | null, DomainError>>;
  /** Authority-checked write (`secret.write`). */
  write(key: string, value: string, actorId: string): Promise<Result<true, DomainError>>;
  /** Authority-checked delete (`secret.write`). */
  remove(key: string, actorId: string): Promise<Result<boolean, DomainError>>;
  /**
   * The ONLY surface an adapter may receive (Sprint 7.1 MEDIUM-2).
   *
   * The raw `SecretResolver` methods exist for the composition root (which must resolve a
   * credential before handing an adapter a client); adapters get this view, which has no
   * way to read or write without passing the authority check.
   */
  forActor(actorId: string): SecretAccessView;
}

/** Authority-bound view: every method checks `secret.read` / `secret.write` itself. */
export interface SecretAccessView {
  readonly actorId: string;
  read(key: string): Promise<Result<string | null, DomainError>>;
  write(key: string, value: string): Promise<Result<true, DomainError>>;
  remove(key: string): Promise<Result<boolean, DomainError>>;
  resolve(ref: SecretRef): Promise<Result<string | null, DomainError>>;
  /** Names only - never values. */
  names(): Promise<Result<readonly string[], DomainError>>;
}

export function createEnvSecretVault(input: EnvSecretResolverInput): SecretVault {
  const prefix = input.prefix ?? '';
  const store = new Map<string, string>();
  let warned = false;

  const permit = async (actorId: string, authority: string): Promise<Result<true, DomainError>> => {
    if (input.authorize === undefined) {
      if (!warned) {
        warned = true;
        // A silent allow-all would be indistinguishable from a working policy.
        process.emitWarning?.('secret vault has no authorization policy: secret permissions are not enforced');
      }
      return ok(true);
    }
    try {
      return await input.authorize({ actorId, authority });
    } catch (error) {
      return err(
        error instanceof DomainError
          ? error
          : domainError('PERMISSION_DENIED', error instanceof Error ? error.message : String(error), {}),
      );
    }
  };

  for (const [key, value] of Object.entries(input.env)) {
    if (value === undefined || value.length === 0) continue;
    if (prefix.length > 0 && !key.startsWith(prefix)) continue;
    store.set(key, value);
  }

  const vault: SecretVault = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
    async keys(): Promise<readonly string[]> {
      return [...store.keys()].sort();
    },
    async resolve(ref: SecretRef): Promise<string | null> {
      if (ref.source !== 'env' || ref.envName === undefined) return null;
      return store.get(ref.envName) ?? null;
    },
    async available(): Promise<readonly string[]> {
      return [...store.keys()].sort();
    },
    values(): readonly string[] {
      return [...store.values()];
    },
    remember(value: string): void {
      if (value.length > 0) store.set(`runtime:${String(store.size)}`, value);
    },
    async read(key: string, actorId: string): Promise<Result<string | null, DomainError>> {
      const permitted = await permit(actorId, 'secret.read');
      if (!permitted.ok) return permitted;
      return ok(store.get(key) ?? null);
    },
    async write(key: string, value: string, actorId: string): Promise<Result<true, DomainError>> {
      const permitted = await permit(actorId, 'secret.write');
      if (!permitted.ok) return permitted;
      if (value.length === 0) {
        return err(domainError('VALIDATION_FAILED', 'Refusing to store an empty secret value.', { key }));
      }
      store.set(key, value);
      return ok(true);
    },
    async remove(key: string, actorId: string): Promise<Result<boolean, DomainError>> {
      const permitted = await permit(actorId, 'secret.write');
      if (!permitted.ok) return permitted;
      return ok(store.delete(key));
    },
    forActor(actorId: string): SecretAccessView {
      return {
        actorId,
        read: (key: string) => vault.read(key, actorId),
        write: (key: string, value: string) => vault.write(key, value, actorId),
        remove: (key: string) => vault.remove(key, actorId),
        resolve: async (ref: SecretRef) => {
          const permitted = await permit(actorId, 'secret.read');
          if (!permitted.ok) return permitted;
          return ok(await vault.resolve(ref));
        },
        names: async () => {
          const permitted = await permit(actorId, 'secret.read');
          if (!permitted.ok) return permitted;
          return ok(await vault.keys());
        },
      };
    },
  };

  return vault;
}

/** Fail-closed guard for callers that need a value to proceed (e.g. adapter setup). */
export async function requireSecret(
  vault: SecretRefResolverPort,
  ref: SecretRef,
): Promise<Result<string, DomainError>> {
  const value = await vault.resolve(ref);
  if (value === null) {
    // A real DomainError, never a look-alike object (Sprint 6 review MEDIUM-2): the rest
    // of the system branches on `instanceof DomainError`.
    return err(
      domainError('PERMISSION_DENIED', `Secret "${ref.purpose}" for provider "${ref.providerId}" is not configured.`, {
        providerId: ref.providerId,
        purpose: ref.purpose,
        source: ref.source,
      }),
    );
  }
  return ok(value);
}
