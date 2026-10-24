/**
 * Durable Industry Pack stores (Sprint 15 — Task-15-03; ADR-0024/0025/0027).
 *
 * Three stores over the opt-in `pack` chain:
 *   PackVersionStore      — INSERT-only; replay on identical fingerprint, CONFLICT on
 *                          divergent content for the same (packId, packVersion);
 *                          fail-closed reads (corrupt snapshot / wrong-format or
 *                          recomputation-mismatched fingerprint → PERSISTENCE_FAILED).
 *   PackInstallationStore — the ONE mutable row (installed ↔ disabled); the
 *                          one-enabled-version invariant is a partial unique INDEX in
 *                          the schema (race-safe), mirrored as CONFLICT here.
 *   PackContentRefStore   — INSERT-only provenance; no update/delete (no GC).
 *
 * Conventions deliberately mirror the artifact/validation chain (Sprint 13):
 * no DELETE statements, creation-command metadata as durable identity, SQLite
 * constraint violations mapped onto the domain error taxonomy (never raw SQL text
 * leaking to domain callers). Stores do not authorize (T15-04 lands the pack.manage
 * execution point).
 */
import {
  DomainError,
  isPackInstallationStatus,
  isPackManifestFingerprint,
  packManifestFingerprint,
  validatePackManifest,
  type PackContentRef,
  type PackInstallation,
  type PackVersion,
} from '@companyos/core';

import type { Database } from '../db.js';

export interface PackStoresOptions {
  /** Timestamp source (deterministic in tests; the system clock in production). */
  readonly nowIso: () => string;
}

/* --------------------------------------------------------------- helpers --- */

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE|PRIMARY KEY/i.test(error.message);

const isCheckViolation = (error: unknown): boolean =>
  error instanceof Error && /CHECK/i.test(error.message);

/** Storage-level integrity guard: a recovered version must satisfy its own invariants. */
const toPackVersion = (
  packId: string,
  packVersion: string,
  manifestJson: string,
  fingerprint: string,
): PackVersion => {
  if (!isPackManifestFingerprint(fingerprint)) {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Stored pack version "${packId}@${packVersion}" fingerprint is not a canonical sha256:<64hex> ref.`,
      { details: { reason: 'PACK_VERSION_FINGERPRINT_FORMAT', packId, packVersion } },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Stored pack version "${packId}@${packVersion}" manifest snapshot is not valid JSON.`,
      { details: { reason: 'PACK_VERSION_MANIFEST_CORRUPT', packId, packVersion } },
    );
  }
  const validated = validatePackManifest(parsed);
  if (!validated.ok) {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Stored pack version "${packId}@${packVersion}" manifest snapshot fails canonical validation.`,
      { details: { reason: 'PACK_VERSION_MANIFEST_INVALID', packId, packVersion, problems: validated.error.details['problems'] } },
    );
  }
  const recomputed = packManifestFingerprint(validated.value);
  if (recomputed !== fingerprint) {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Stored pack version "${packId}@${packVersion}" fingerprint does not match its manifest content.`,
      { details: { reason: 'PACK_VERSION_FINGERPRINT_MISMATCH', packId, packVersion } },
    );
  }
  return { packId, packVersion, manifest: validated.value, manifestFingerprint: fingerprint };
};

/* -------------------------------------------------------- PackVersionStore --- */

interface PackVersionRow {
  readonly pack_id: string;
  readonly pack_version: string;
  readonly canonical_manifest_json: string;
  readonly manifest_fingerprint: string;
}

export function createSqlitePackVersionStore(db: Database, options: PackStoresOptions) {
  return {
    async put(version: PackVersion) {
      try {
        db.prepare(
          `INSERT INTO pack_versions (pack_id, pack_version, canonical_manifest_json, manifest_fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(version.packId, version.packVersion, JSON.stringify(version.manifest), version.manifestFingerprint, options.nowIso());
        return { ok: true as const, value: version };
      } catch (error) {
        if (isUniqueViolation(error)) {
          // INSERT-ONCE: the same identity is either an idempotent replay or a divergence.
          const existing = db
            .prepare('SELECT * FROM pack_versions WHERE pack_id = ? AND pack_version = ?')
            .get(version.packId, version.packVersion) as PackVersionRow | undefined;
          if (existing === undefined) {
            return {
              ok: false as const,
              error: new DomainError('CONFLICT', 'Pack version disappeared during a concurrent create.', {
                details: { packId: version.packId, packVersion: version.packVersion },
              }),
            };
          }
          if (existing.manifest_fingerprint === version.manifestFingerprint) {
            try {
              return { ok: true as const, value: toPackVersion(existing.pack_id, existing.pack_version, existing.canonical_manifest_json, existing.manifest_fingerprint) };
            } catch (integrity) {
              return { ok: false as const, error: integrity instanceof DomainError ? integrity : new DomainError('PERSISTENCE_FAILED', 'Pack version replay failed integrity.', { details: {} }) };
            }
          }
          return {
            ok: false as const,
            error: new DomainError(
              'CONFLICT',
              `Pack ${version.packId}@${version.packVersion} already exists with different manifest content; the identity is immutable.`,
              { details: { reason: 'PACK_VERSION_CONFLICT', packId: version.packId, packVersion: version.packVersion, storedFingerprint: existing.manifest_fingerprint } },
            ),
          };
        }
        if (isCheckViolation(error)) {
          return {
            ok: false as const,
            error: new DomainError('INVALID_ARGUMENT', 'Pack version fingerprint must be a canonical sha256:<64hex> ref.', {
              details: { packId: version.packId, packVersion: version.packVersion },
            }),
          };
        }
        throw error;
      }
    },

    async get(packId: string, packVersion: string) {
      const row = db
        .prepare('SELECT * FROM pack_versions WHERE pack_id = ? AND pack_version = ?')
        .get(packId, packVersion) as PackVersionRow | undefined;
      if (row === undefined) return { ok: true as const, value: null };
      try {
        return { ok: true as const, value: toPackVersion(row.pack_id, row.pack_version, row.canonical_manifest_json, row.manifest_fingerprint) };
      } catch (error) {
        return { ok: false as const, error: error instanceof DomainError ? error : new DomainError('PERSISTENCE_FAILED', 'Pack version read failed.', { details: {} }) };
      }
    },
  };
}

/* -------------------------------------------------- PackInstallationStore --- */

interface PackInstallationRow {
  readonly installation_id: string;
  readonly company_id: string;
  readonly pack_id: string;
  readonly pack_version: string;
  readonly pack_name: string;
  readonly core_api: string;
  readonly status: string;
  readonly capabilities_json: string;
  readonly installed_by: string;
  readonly installed_at: string;
  readonly updated_at: string;
  readonly creation_command_id: string;
  readonly creation_command_fingerprint: string;
}

const toPackInstallation = (row: PackInstallationRow): PackInstallation => {
  if (!isPackInstallationStatus(row.status)) {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Installation row "${row.installation_id}" has an unknown status "${row.status}" (closed set violated).`,
      { details: { reason: 'PACK_INSTALLATION_STATUS_CORRUPT', installationId: row.installation_id, status: row.status } },
    );
  }
  let capabilities: readonly string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.capabilities_json);
    if (Array.isArray(parsed)) capabilities = parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    throw new DomainError(
      'PERSISTENCE_FAILED',
      `Installation row "${row.installation_id}" capabilities snapshot is not valid JSON.`,
      { details: { reason: 'PACK_INSTALLATION_CAPABILITIES_CORRUPT', installationId: row.installation_id } },
    );
  }
  return {
    id: row.installation_id as PackInstallation['id'],
    companyId: row.company_id as PackInstallation['companyId'],
    packId: row.pack_id,
    packVersion: row.pack_version,
    name: row.pack_name,
    coreApi: row.core_api,
    capabilities,
    status: row.status,
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
};

const conflictError = (message: string, details: Record<string, unknown>): DomainError =>
  new DomainError('CONFLICT', message, { details });

const notFoundError = (message: string, details: Record<string, unknown>): DomainError =>
  new DomainError('NOT_FOUND', message, { details });

const invalidError = (message: string, details: Record<string, unknown>): DomainError =>
  new DomainError('INVALID_ARGUMENT', message, { details });

export function createSqlitePackInstallationStore(db: Database) {
  const readRow = (installationId: string): PackInstallationRow | undefined =>
    db.prepare('SELECT * FROM pack_installations WHERE installation_id = ?').get(installationId) as PackInstallationRow | undefined;

  const withRow = (installationId: string) => {
    const row = readRow(installationId);
    if (row === undefined) return { ok: false as const, error: notFoundError(`Pack installation "${installationId}" does not exist.`, { installationId }) };
    try {
      return { ok: true as const, value: toPackInstallation(row) };
    } catch (error) {
      return { ok: false as const, error: error instanceof DomainError ? error : new DomainError('PERSISTENCE_FAILED', 'Pack installation read failed.', { details: { installationId } }) };
    }
  };

  return {
    async create(input: {
      readonly installation: PackInstallation;
      readonly creationCommandId: string;
      readonly creationCommandFingerprint: string;
    }) {
      const { installation } = input;
      if (input.creationCommandId.trim() === '' || input.creationCommandFingerprint.trim() === '') {
        return { ok: false as const, error: invalidError('An installation needs a creation command id and fingerprint.', { reason: 'PACK_CREATION_IDENTITY_REQUIRED' }) };
      }
      // PackVersion existence — validated inside the caller's transaction (no cross-chain FK).
      const versionRow = db
        .prepare('SELECT pack_id FROM pack_versions WHERE pack_id = ? AND pack_version = ?')
        .get(installation.packId, installation.packVersion) as { pack_id: string } | undefined;
      if (versionRow === undefined) {
        return {
          ok: false as const,
          error: notFoundError(`Pack version ${installation.packId}@${installation.packVersion} must be persisted before it can be installed.`, {
            reason: 'PACK_VERSION_MISSING',
            packId: installation.packId,
            packVersion: installation.packVersion,
          }),
        };
      }
      try {
        db.prepare(
          `INSERT INTO pack_installations (
             installation_id, company_id, pack_id, pack_version, pack_name, core_api, status,
             capabilities_json, installed_by, installed_at, updated_at,
             creation_command_id, creation_command_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          installation.id,
          installation.companyId,
          installation.packId,
          installation.packVersion,
          installation.name,
          installation.coreApi,
          installation.status,
          JSON.stringify(installation.capabilities),
          installation.installedBy,
          installation.installedAt,
          installation.updatedAt,
          input.creationCommandId,
          input.creationCommandFingerprint,
        );
        return { ok: true as const, value: installation };
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Which invariant fired? Read the durable state and decide (never an overwrite).
          const existing = db
            .prepare('SELECT * FROM pack_installations WHERE creation_command_id = ?')
            .get(input.creationCommandId) as PackInstallationRow | undefined;
          if (existing !== undefined) {
            if (existing.creation_command_fingerprint !== input.creationCommandFingerprint) {
              return {
                ok: false as const,
                error: conflictError(`Installation command "${input.creationCommandId}" was already used with a different fingerprint.`, {
                  reason: 'PACK_CREATION_COMMAND_CONFLICT',
                  creationCommandId: input.creationCommandId,
                }),
              };
            }
            return { ok: true as const, value: toPackInstallation(existing) };
          }
          const sameTuple = db
            .prepare('SELECT installation_id FROM pack_installations WHERE company_id = ? AND pack_id = ? AND pack_version = ?')
            .get(installation.companyId, installation.packId, installation.packVersion) as { installation_id: string } | undefined;
          if (sameTuple !== undefined) {
            return {
              ok: false as const,
              error: conflictError(`Pack ${installation.packId}@${installation.packVersion} is already installed for this company.`, {
                reason: 'PACK_INSTALLATION_IDENTITY_CONFLICT',
                companyId: installation.companyId,
                packId: installation.packId,
                packVersion: installation.packVersion,
              }),
            };
          }
          return {
            ok: false as const,
            error: conflictError(
              `Another version of pack "${installation.packId}" is enabled for this company; disable it first (one-active-version invariant).`,
              { reason: 'PACK_ONE_ENABLED_VERSION', companyId: installation.companyId, packId: installation.packId, attemptedVersion: installation.packVersion },
            ),
          };
        }
        if (isCheckViolation(error)) {
          return { ok: false as const, error: invalidError(`Pack installation status "${String(installation.status)}" is outside the closed set.`, { reason: 'PACK_INSTALLATION_STATUS_UNKNOWN' }) };
        }
        throw error;
      }
    },

    async get(installationId: string) {
      return withRow(installationId);
    },

    async findByCompanyPackVersion(companyId: string, packId: string, packVersion: string) {
      const row = db
        .prepare('SELECT * FROM pack_installations WHERE company_id = ? AND pack_id = ? AND pack_version = ?')
        .get(companyId, packId, packVersion) as PackInstallationRow | undefined;
      if (row === undefined) return { ok: true as const, value: null };
      try {
        return { ok: true as const, value: toPackInstallation(row) };
      } catch (error) {
        return { ok: false as const, error: error instanceof DomainError ? error : new DomainError('PERSISTENCE_FAILED', 'Pack installation read failed.', { details: { installationId: row.installation_id } }) };
      }
    },

    async findByCreationCommand(creationCommandId: string) {
      const row = db
        .prepare('SELECT * FROM pack_installations WHERE creation_command_id = ?')
        .get(creationCommandId) as PackInstallationRow | undefined;
      if (row === undefined) return { ok: true as const, value: null };
      try {
        return { ok: true as const, value: toPackInstallation(row) };
      } catch (error) {
        return { ok: false as const, error: error instanceof DomainError ? error : new DomainError('PERSISTENCE_FAILED', 'Pack installation read failed.', { details: { creationCommandId } }) };
      }
    },

    async listByCompany(companyId: string) {
      const rows = db
        .prepare('SELECT * FROM pack_installations WHERE company_id = ? ORDER BY pack_id ASC, pack_version ASC')
        .all(companyId) as readonly PackInstallationRow[];
      try {
        return { ok: true as const, value: rows.map(toPackInstallation) };
      } catch (error) {
        return { ok: false as const, error: error instanceof DomainError ? error : new DomainError('PERSISTENCE_FAILED', 'Pack installation list failed.', { details: { companyId } }) };
      }
    },

    async findEnabled(companyId: string, packId: string) {
      const row = db
        .prepare("SELECT * FROM pack_installations WHERE company_id = ? AND pack_id = ? AND status = 'installed'")
        .get(companyId, packId) as PackInstallationRow | undefined;
      if (row === undefined) return { ok: true as const, value: null };
      try {
        return { ok: true as const, value: toPackInstallation(row) };
      } catch (error) {
        return { ok: false as const, error: error instanceof DomainError ? error : new DomainError('PERSISTENCE_FAILED', 'Pack installation read failed.', { details: { companyId, packId } }) };
      }
    },

    async setStatus(installationId: string, status: PackInstallation['status'], now: string) {
      if (!isPackInstallationStatus(status)) {
        return { ok: false as const, error: invalidError(`Pack installation status "${String(status)}" is outside the closed set.`, { reason: 'PACK_INSTALLATION_STATUS_UNKNOWN', installationId }) };
      }
      const current = readRow(installationId);
      if (current === undefined) {
        return { ok: false as const, error: notFoundError(`Pack installation "${installationId}" does not exist.`, { installationId }) };
      }
      if (current.status === status) {
        return {
          ok: false as const,
          error: conflictError(`Pack installation "${installationId}" is already "${status}".`, { installationId, status }),
        };
      }
      try {
        db.prepare('UPDATE pack_installations SET status = ?, updated_at = ? WHERE installation_id = ?').run(status, now, installationId);
        return withRow(installationId);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return {
            ok: false as const,
            error: conflictError(
              `Another version of pack "${current.pack_id}" is enabled for this company; disable it first (one-active-version invariant).`,
              { reason: 'PACK_ONE_ENABLED_VERSION', companyId: current.company_id, packId: current.pack_id },
            ),
          };
        }
        throw error;
      }
    },
  };
}

/* ----------------------------------------------------- PackContentRefStore --- */

interface PackContentRefRow {
  readonly installation_id: string;
  readonly pack_id: string;
  readonly pack_version: string;
  readonly content_kind: string;
  readonly logical_key: string;
  readonly materialized_entity_ref: string | null;
  readonly created_at: string;
}

const CONTENT_REF_SELECT = `
  SELECT r.installation_id, i.pack_id, i.pack_version, r.content_kind, r.logical_key,
         r.materialized_entity_ref, r.created_at
  FROM pack_content_refs r
  JOIN pack_installations i ON i.installation_id = r.installation_id
`;

const toPackContentRef = (row: PackContentRefRow): PackContentRef => ({
  packId: row.pack_id,
  packVersion: row.pack_version,
  contentKind: row.content_kind as PackContentRef['contentKind'],
  logicalKey: row.logical_key,
  materializedEntityRef: row.materialized_entity_ref,
});

export function createSqlitePackContentRefStore(db: Database, options: PackStoresOptions) {
  return {
    async insert(installationId: string, ref: PackContentRef) {
      try {
        db.prepare(
          `INSERT INTO pack_content_refs (installation_id, content_kind, logical_key, materialized_entity_ref, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(installationId, ref.contentKind, ref.logicalKey, ref.materializedEntityRef, options.nowIso());
        return { ok: true as const, value: ref };
      } catch (error) {
        if (isUniqueViolation(error)) {
          return {
            ok: false as const,
            error: conflictError(`Content ref "${ref.contentKind}:${ref.logicalKey}" already exists for this installation; provenance rows are immutable.`, {
              reason: 'PACK_CONTENT_REF_DUPLICATE',
              installationId,
              contentKind: ref.contentKind,
              logicalKey: ref.logicalKey,
            }),
          };
        }
        if (isCheckViolation(error)) {
          return {
            ok: false as const,
            error: invalidError(`Unknown pack content kind "${String(ref.contentKind)}" (closed nine-kind union).`, { reason: 'PACK_CONTENT_KIND_UNKNOWN' }),
          };
        }
        throw error;
      }
    },

    async listByInstallation(installationId: string) {
      const rows = db
        .prepare(`${CONTENT_REF_SELECT} WHERE r.installation_id = ? ORDER BY r.content_kind ASC, r.logical_key ASC`)
        .all(installationId) as readonly PackContentRefRow[];
      return { ok: true as const, value: rows.map(toPackContentRef) };
    },

    async findByKey(installationId: string, contentKind: PackContentRef['contentKind'], logicalKey: string) {
      const row = db
        .prepare(`${CONTENT_REF_SELECT} WHERE r.installation_id = ? AND r.content_kind = ? AND r.logical_key = ?`)
        .get(installationId, contentKind, logicalKey) as PackContentRefRow | undefined;
      if (row === undefined) return { ok: true as const, value: null };
      return { ok: true as const, value: toPackContentRef(row) };
    },
  };
}
