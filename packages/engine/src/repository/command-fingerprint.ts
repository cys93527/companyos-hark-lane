/**
 * Repository command descriptor fingerprint (Sprint 17 — Task-17-06).
 *
 * A QA command's value as evidence is not only "which repository state it ran against" but
 * also "which TRUSTED command it actually ran". `commandKey` alone is not an identity: the
 * same workspace root can be closed and re-opened with a command profile whose `tests` slot
 * points at a different executable, and an old success would then be mistaken for evidence
 * about the new command.
 *
 * The fingerprint is a deterministic digest over the trusted descriptor's canonical form
 * (commandKey, executable as configured, baseArgv order, cwd policy, safeEnvAdditions). Only
 * the DIGEST is durable: the executable path, the environment and the workspace root never
 * appear in evidence output.
 */
import { createHash } from 'node:crypto';

import type { RepositoryCommandDescriptor } from './workspace.js';

/** Frozen purpose string: changing it would silently invalidate every recorded evidence. */
export const REPOSITORY_COMMAND_DESCRIPTOR_FINGERPRINT_PURPOSE = 'companyos/repository-command-descriptor/1';

/** Canonical, order-independent rendering of the trusted additions. */
const canonicalEnv = (additions: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(additions).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));

/**
 * `sha256:<64 lowercase hex>` over the descriptor's canonical form. Deterministic: the same
 * trusted descriptor always yields the same fingerprint, and any change to it changes the
 * digest.
 */
export const repositoryCommandDescriptorFingerprint = (
  descriptor: RepositoryCommandDescriptor,
): string => {
  const canonical = JSON.stringify({
    purpose: REPOSITORY_COMMAND_DESCRIPTOR_FINGERPRINT_PURPOSE,
    commandKey: descriptor.commandKey,
    executable: descriptor.executable,
    baseArgv: [...descriptor.baseArgv],
    cwd: descriptor.cwd,
    safeEnvAdditions: canonicalEnv(descriptor.safeEnvAdditions ?? {}),
  });
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
};
