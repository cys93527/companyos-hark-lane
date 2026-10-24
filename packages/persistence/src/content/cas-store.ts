/**
 * Filesystem content-addressed store (Sprint 13 — ADR-0015 D3/D13, Task-13-03).
 *
 * Physical layout: `<casRoot>/<first-2-hex>/<64-hex>`. The physical path is ALWAYS
 * derived from a trusted injected root + a strictly validated digest — a caller can
 * never name the final location (path-injection boundary, Risk R-01).
 *
 * Write protocol (two-phase, ADR-0015 decision 13, publication corrected per review):
 *   staging  — `<casRoot>/staging/<uuid>.staging`: write ALL bytes → fsync (durability
 *              gate; a real I/O failure fails the publication, never swallowed) →
 *              close → re-read → SHA-256 verify (integrity gate). The staging object is
 *              COMPLETE and verified before any final namespace entry can exist;
 *   publish  — `linkSync(staging, final)`: HARD-LINK PUBLICATION. No bytes are copied —
 *              the final directory entry references the already-complete staging file,
 *              so the final namespace can never expose a partially written object.
 *              No-clobber: linkSync throws EEXIST when the target exists (Windows/Node
 *              v24 recon 2026-09-18) — an existing object is REUSED after verification,
 *              a corrupt one fails closed. NO copy fallback: on a filesystem without
 *              hard-link support publication FAILS CLOSED (CAS_LINK_UNSUPPORTED) — a
 *              silent copy fallback would degrade the guarantee per environment.
 *   EEXIST → read the existing final, hash it: match = REUSE (unlink own staging,
 *   return same ref); mismatch = FAIL CLOSED (a published address whose bytes violate
 *   their own name is never overwritten). Crash AFTER link but BEFORE staging unlink is
 *   a safe mode (final = valid object; staging = extra hard link) — leftovers are
 *   detected/handled by Task-13-10 reconciliation.
 *
 * Every read re-computes the SHA-256 (fail closed on mismatch). Staging leftovers are
 * ignored by lookups; their cleanup belongs to Task-13-10 reconciliation.
 *
 * Guarantees wording (deliberately precise): hard-link publication provides
 * NO-CLOBBER PUBLICATION OF AN ALREADY-COMPLETE STAGING OBJECT — i.e. the
 * process/crash-safe invariant "no partially written object is exposed through the
 * final CAS namespace". Full power-loss durability of the underlying volume is a
 * filesystem concern beyond this module's claim.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  DomainError,
  type ArtifactContentStore,
  type ContentIntegrity,
  type StoredContent,
} from '@companyos/core';

/** Canonical managed ref — lowercase hex only; anything else is refused outright. */
const MANAGED_REF_PATTERN = /^sha256:([0-9a-f]{64})$/;

export interface CasStoreOptions {
  /** Trusted injected root (composition root's decision — never caller input). */
  readonly casRoot: string;
}

const sha256Hex = (content: Uint8Array): string => createHash('sha256').update(content).digest('hex');

const finalPathFor = (casRoot: string, hex: string): string => join(casRoot, hex.slice(0, 2), hex);

const parseManagedRef = (contentRef: string): string => {
  const match = MANAGED_REF_PATTERN.exec(contentRef);
  if (match === null || match[1] === undefined) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'contentRef must be a canonical managed ref ("sha256:<64 lowercase hex>").',
      { details: { reason: 'ARTIFACT_CONTENT_REF_INVALID', contentRef } },
    );
  }
  return match[1];
};

/** Reparse-point guard (symlink/junction): fail closed, never follow (Risk R-15). */
const rejectReparsePoint = (path: string): void => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `CAS object "${path}" is a symlink/junction/reparse point — refused.`,
      { details: { reason: 'CAS_REPARSE_POINT_REJECTED', path } },
    );
  }
};

const stagingDirFor = (casRoot: string): string => join(casRoot, 'staging');

/** Write + fsync + close a staging object, then re-read it from disk and verify. */
const writeStaging = (casRoot: string, content: Uint8Array, hex: string): string => {
  const stagingDir = stagingDirFor(casRoot);
  mkdirSync(stagingDir, { recursive: true });
  const stagingPath = join(stagingDir, `${randomUUID()}.staging`);
  const fd = openSync(stagingPath, 'w');
  try {
    writeSync(fd, content);
    flushStagingOrFail(fd, stagingPath);
  } finally {
    closeSync(fd);
  }
  const stored = readFileSync(stagingPath);
  if (sha256Hex(stored) !== hex) {
    rmSync(stagingPath, { force: true });
    throw new DomainError('PERSISTENCE_FAILED', 'Staging object failed post-write verification.', {
      details: { reason: 'CAS_STAGING_VERIFY_FAILED' },
    });
  }
  return stagingPath;
};

/**
 * Durability gate (publication protocol step 3): flush the staging bytes BEFORE
 * publication. A real I/O failure FAILS THE PUBLICATION — a flush failure is never
 * swallowed and the object is never published unflushed. (Integrity is a separate
 * gate: the post-write re-read + SHA-256 below. The two are NOT interchangeable.)
 */
const flushStagingOrFail = (fd: number, stagingPath: string): void => {
  try {
    fsyncSync(fd);
  } catch (error) {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Staging flush failed; the object was NOT published ("${stagingPath}").`,
      { details: { reason: 'CAS_FSYNC_FAILED', cause: (error as Error).message } },
    );
  }
};

const removeQuietly = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    /* leftover staging is ignored by lookups; cleanup belongs to Task-13-10 */
  }
};

/** Remove the staging dir when empty (rmdir fails silently when other writers are mid-put). */
const removeStagingDirIfEmpty = (casRoot: string): void => {
  try {
    rmdirSync(stagingDirFor(casRoot));
  } catch {
    /* non-empty or already gone — other writers may still hold staging files */
  }
};

/** Verify existing published bytes; reuse on match, fail closed on mismatch. */
const verifyExistingTarget = (
  finalPath: string,
  hex: string,
  sizeBytes: number,
): StoredContent => {
  rejectReparsePoint(finalPath);
  const existing = readFileSync(finalPath);
  const existingHash = sha256Hex(existing);
  if (existingHash !== hex) {
    // A published address whose bytes violate their own name: NEVER overwrite.
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `CAS integrity violation: object at "${finalPath}" does not match its address.`,
      {
        details: {
          reason: 'CAS_CONTENT_HASH_MISMATCH',
          contentRef: `sha256:${hex}`,
          expectedHash: hex,
          actualHash: existingHash,
        },
      },
    );
  }
  return { contentRef: `sha256:${hex}`, contentHash: existingHash, sizeBytes };
};

export function createFilesystemArtifactContentStore(options: CasStoreOptions): ArtifactContentStore {
  const casRoot = options.casRoot;
  mkdirSync(casRoot, { recursive: true });

  return {
    async put(content: Uint8Array, expectedHash?: string): Promise<StoredContent> {
      const hex = sha256Hex(content);
      if (expectedHash !== undefined && expectedHash.toLowerCase() !== hex) {
        throw new DomainError(
          'INVALID_ARGUMENT',
          'Expected hash does not match the actual bytes (verification only — the digest is always computed from real bytes).',
          { details: { reason: 'CAS_HASH_EXPECTATION_MISMATCH', expectedHash, actualHash: hex } },
        );
      }
      const finalPath = finalPathFor(casRoot, hex);
      const sizeBytes = content.byteLength;

      // Fast path: already published and intact → reuse (no overwrite, no rewrite).
      if (existsSync(finalPath)) {
        return verifyExistingTarget(finalPath, hex, sizeBytes);
      }

      const stagingPath = writeStaging(casRoot, content, hex);
      try {
        const targetDir = join(casRoot, hex.slice(0, 2));
        mkdirSync(targetDir, { recursive: true });
        try {
          // Hard-link publication (review corrective): the final entry references the
          // already-complete staging object — no byte copy, so no partial final state
          // is possible. No-clobber: an existing target yields EEXIST, never overwrite.
          linkSync(stagingPath, finalPath);
          removeQuietly(stagingPath);
          removeStagingDirIfEmpty(casRoot);
          return { contentRef: `sha256:${hex}`, contentHash: hex, sizeBytes };
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : '';
          if (code !== 'EEXIST') {
            // Hard-link unsupported (EXDEV/EPERM/ENOTSUP/…) → FAIL CLOSED. There is
            // deliberately NO copy fallback: a silent fallback would degrade the CAS
            // guarantee depending on the environment (ADR-0015 D13 / review corrective).
            removeQuietly(stagingPath);
            throw new DomainError(
              'PERSISTENCE_FAILED',
              `CAS publication failed: hard-link publish unsupported or failed ("${code || (error as Error).message}"). No copy fallback exists.`,
              { details: { reason: 'CAS_LINK_UNSUPPORTED', cause: code || (error as Error).message, finalPath } },
            );
          }
          // Lost the race (or a corrupt object sits at the address) — verify, reuse or fail.
          const verdict = verifyExistingTarget(finalPath, hex, sizeBytes);
          removeQuietly(stagingPath);
          removeStagingDirIfEmpty(casRoot);
          return verdict;
        }
      } finally {
        removeQuietly(stagingPath);
        removeStagingDirIfEmpty(casRoot);
      }
    },

    async get(contentRef: string): Promise<Uint8Array> {
      const hex = parseManagedRef(contentRef);
      const finalPath = finalPathFor(casRoot, hex);
      if (!existsSync(finalPath)) {
        throw new DomainError('NOT_FOUND', `Content object "${contentRef}" does not exist.`, {
          details: { reason: 'CAS_CONTENT_MISSING', contentRef },
        });
      }
      rejectReparsePoint(finalPath);
      const bytes = readFileSync(finalPath);
      if (sha256Hex(bytes) !== hex) {
        throw new DomainError(
          'PERSISTENCE_FAILED',
          `CAS integrity violation: object at "${finalPath}" does not match its address.`,
          {
            details: {
              reason: 'CAS_CONTENT_HASH_MISMATCH',
              contentRef,
              expectedHash: hex,
              actualHash: sha256Hex(bytes),
            },
          },
        );
      }
      return new Uint8Array(bytes);
    },

    async verify(contentRef: string): Promise<ContentIntegrity> {
      const hex = parseManagedRef(contentRef);
      const finalPath = finalPathFor(casRoot, hex);
      if (!existsSync(finalPath)) return { status: 'missing' };
      rejectReparsePoint(finalPath);
      const bytes = readFileSync(finalPath);
      if (sha256Hex(bytes) !== hex) return { status: 'hash-mismatch' };
      return { status: 'valid', sizeBytes: bytes.byteLength };
    },
  };
}
