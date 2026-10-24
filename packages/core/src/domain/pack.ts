/**
 * PackInstallation — what an Industry Pack looks like *inside* a Company
 * (规划书 §十五 Industry Pack; §四 Core 概念 2 "Industry Pack").
 *
 * Core validates the manifest shape (via the capability registry) and constructs the
 * installation domain object. Core never interprets a pack's vocabulary: capability
 * ids are opaque namespaced strings (`<packId>:<name>`).
 *
 * Sprint 15 (Task-15-02, ADR-0024/0025/0027): canonical naming is enforced here —
 * `packVersion` / `coreApi` (no `version` / `apiVersion` dual naming). This module is
 * domain construction + validation ONLY: no persistence (T15-03), no lifecycle
 * service (T15-04), no run pinning (T15-05).
 */
import { canonicalJson, isSha256Ref, parseSha256Ref, sha256Ref } from '../kernel/hash.js';
import { domainError, type DomainError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { IdFactory } from '../ports/id-factory.js';
import { makeId, type CompanyId, type PackInstallationId } from '../kernel/identifiers.js';
import {
  PACK_CONTENT_KINDS,
  parsePackQualifiedKey,
  validatePackManifest,
  type PackContentKind,
  type PackManifest,
} from '../registry/pack-manifest.js';

export const PACK_STATUSES = ['installed', 'disabled'] as const;
export type PackInstallationStatus = (typeof PACK_STATUSES)[number];

export interface PackInstallation {
  readonly id: PackInstallationId;
  readonly companyId: CompanyId;
  readonly packId: string;
  readonly name: string;
  readonly packVersion: string;
  readonly coreApi: string;
  readonly capabilities: readonly string[];
  readonly status: PackInstallationStatus;
  readonly installedAt: string;
  readonly installedBy: string;
  readonly updatedAt: string;
}

export interface CreatePackInstallationInput {
  readonly companyId: CompanyId;
  /** Untrusted input — validated (canonical manifest semantics) before construction. */
  readonly manifest: unknown;
  readonly installedBy: string;
  readonly now: string;
  readonly ids: IdFactory;
}

/**
 * Construct an installation domain object from an untrusted canonical manifest.
 * Pure validation + construction: it does NOT touch storage, authorize, or enable
 * anything (the application lifecycle belongs to T15-04).
 */
export function createPackInstallation(input: CreatePackInstallationInput): Result<PackInstallation, DomainError> {
  const validated = validatePackManifest(input.manifest);
  if (!validated.ok) return err(validated.error);

  const manifest: PackManifest = validated.value;
  return ok({
    id: makeId<'PackInstallationId'>('packInstallation', input.ids),
    companyId: input.companyId,
    packId: manifest.packId,
    name: manifest.name,
    packVersion: manifest.packVersion,
    coreApi: manifest.coreApi,
    capabilities: manifest.capabilities.map((capability) => capability.id),
    status: 'installed',
    installedAt: input.now,
    installedBy: input.installedBy,
    updatedAt: input.now,
  });
}

export const isPackInstallationStatus = (value: unknown): value is PackInstallationStatus =>
  value === 'installed' || value === 'disabled';

export const isPackEnabled = (installation: PackInstallation): boolean =>
  installation.status === 'installed';

export function setPackStatus(
  installation: PackInstallation,
  status: PackInstallationStatus,
  now: string,
): Result<PackInstallation, DomainError> {
  if (installation.status === status) {
    return err(
      domainError('CONFLICT', `Pack ${installation.packId} is already "${status}".`, {
        installationId: installation.id,
        status,
      }),
    );
  }
  return ok({ ...installation, status, updatedAt: now });
}

/** True when at least one ENABLED installation provides the capability id. */
export const providesCapability = (
  installations: readonly PackInstallation[],
  capabilityId: string,
): boolean =>
  installations.some(
    (installation) =>
      isPackEnabled(installation) && installation.capabilities.includes(capabilityId),
  );

/** The enabled installation that owns a capability, or `null`. */
export const capabilityOwner = (
  installations: readonly PackInstallation[],
  capabilityId: string,
): PackInstallation | null =>
  installations.find(
    (installation) =>
      isPackEnabled(installation) && installation.capabilities.includes(capabilityId),
  ) ?? null;

/** Capabilities required by a workflow but not provided by any enabled pack. */
export const missingCapabilities = (
  installations: readonly PackInstallation[],
  required: readonly string[],
): readonly string[] => required.filter((capability) => !providesCapability(installations, capability));

/* ------------------------------------------------- PackVersion identity --- */

/**
 * An immutable pack version: the validated canonical manifest PLUS its canonical
 * fingerprint. The fingerprint is computed over the CANONICAL SEMANTIC manifest
 * (never the raw payload), so the same `(packId, packVersion)` arriving through any
 * transport yields the same digest, and different content yields a different one
 * (ADR-0024 D4 / Task-15-02 §32-34). Runtime fields (installationId, companyId,
 * status, createdAt, actorId) are never part of it — it describes nothing but the
 * version content.
 */
export interface PackVersion {
  readonly packId: string;
  readonly packVersion: string;
  readonly manifest: PackManifest;
  readonly manifestFingerprint: string;
}

/**
 * Canonical fingerprint pipeline (Task-15-02 §33):
 *   validated canonical manifest → deterministic canonical serialization
 *   (object keys recursively sorted; ARRAY ORDER PRESERVED — arrays are ordered
 *   template data; dependencies and capabilities sorted — they are unordered sets)
 *   → SHA-256 → the repository's QUALIFIED reference format (kernel/hash.ts —
 *   `sha256:<64 lowercase hex>`, the same representation artifact contentRefs use;
 *   TASK-15-02 corrective: NEVER a bare hex).
 */
export const packManifestFingerprint = (manifest: PackManifest): string =>
  sha256Ref(canonicalJsonOf(manifest));

/** True when the value is a canonical pack manifest fingerprint (qualified SHA-256 ref). */
export const isPackManifestFingerprint = isSha256Ref;

/** The bare hex of a pack manifest fingerprint, or `null` when not canonical. */
export const parsePackManifestFingerprint = parseSha256Ref;

/** Deterministic canonical serialization of a PackManifest (semantic content only). */
const canonicalJsonOf = (manifest: PackManifest): string =>
  canonicalJson({
    manifestVersion: manifest.manifestVersion,
    packId: manifest.packId,
    packVersion: manifest.packVersion,
    name: manifest.name,
    coreApi: manifest.coreApi,
    capabilities: [...manifest.capabilities]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((capability) => ({
        id: capability.id,
        description: capability.description,
        ...(capability.approval === undefined ? {} : { approval: capability.approval }),
      })),
    dependsOn: [...manifest.dependsOn]
      .sort((a, b) => (a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : 0))
      .map((dependency) => ({ packId: dependency.packId, packVersion: dependency.packVersion })),
    declarations: {
      roles: [...manifest.declarations.roles].sort((a, b) => (a.key < b.key ? -1 : 1)),
      workflowTemplates: [...manifest.declarations.workflowTemplates].sort((a, b) => (a.key < b.key ? -1 : 1)),
      prompts: [...manifest.declarations.prompts].sort((a, b) => (a.key < b.key ? -1 : 1)),
      tools: [...manifest.declarations.tools].sort((a, b) => (a.key < b.key ? -1 : 1)),
      validators: [...manifest.declarations.validators].sort((a, b) => (a.key < b.key ? -1 : 1)),
      artifacts: [...manifest.declarations.artifacts].sort((a, b) => (a.key < b.key ? -1 : 1)),
      riskRules: [...manifest.declarations.riskRules].sort((a, b) => (a.key < b.key ? -1 : 1)),
      capabilityRules: [...manifest.declarations.capabilityRules].sort((a, b) => (a.key < b.key ? -1 : 1)),
      templates: [...manifest.declarations.templates].sort((a, b) => (a.key < b.key ? -1 : 1)),
    },
  });

/** Validate + freeze a pack version (immutable; a change of content = a NEW version). */
export function createPackVersion(manifestInput: unknown): Result<PackVersion, DomainError> {
  const validated = validatePackManifest(manifestInput);
  if (!validated.ok) return err(validated.error);
  const manifest = validated.value;
  return ok({
    packId: manifest.packId,
    packVersion: manifest.packVersion,
    manifest,
    manifestFingerprint: packManifestFingerprint(manifest),
  });
}

/** Same identity + different canonical content → a conflict, never a silent replace. */
export const isPackVersionConflict = (
  existing: PackVersion,
  candidate: PackVersion,
): boolean =>
  existing.packId === candidate.packId &&
  existing.packVersion === candidate.packVersion &&
  existing.manifestFingerprint !== candidate.manifestFingerprint;

/* ------------------------------------------------- PackContentRef --- */

export { PACK_CONTENT_KINDS };
export type { PackContentKind };

/**
 * Provenance-only mapping: `PackVersion -> materialized object` (ADR-0027 D7).
 * `materializedEntityRef` is NULLABLE (TASK-15-02 Boss ruling §13-15): a declaration
 * that already landed in an existing subsystem records the durable entity ref; a
 * pack-native declaration with no separate external entity (e.g. a Generic Template,
 * which currently lives only inside the durable manifest snapshot) records `null` —
 * its provenance is still uniquely located by (packId, packVersion, contentKind,
 * logicalKey). Forging entity ids for pack-native content is forbidden.
 *
 * It is NEVER runtime content: WorkflowVersion, Tool provenance and Artifact identity
 * stay authoritative (ADR-0027 D12).
 */
export interface PackContentRef {
  readonly packId: string;
  readonly packVersion: string;
  readonly contentKind: PackContentKind;
  readonly logicalKey: string;
  readonly materializedEntityRef: string | null;
}

export function createPackContentRef(input: {
  readonly packId: string;
  readonly packVersion: string;
  readonly contentKind: string;
  readonly logicalKey: string;
  readonly materializedEntityRef?: string | null;
}): Result<PackContentRef, DomainError> {
  if (!(PACK_CONTENT_KINDS as readonly string[]).includes(input.contentKind)) {
    return err(
      domainError('INVALID_ARGUMENT', `Unknown pack content kind "${input.contentKind}" (closed union of the nine categories).`, {
        contentKind: input.contentKind,
        known: PACK_CONTENT_KINDS,
      }),
    );
  }
  const parsed = parsePackQualifiedKey(input.logicalKey);
  if (parsed === null || parsed.packId !== input.packId) {
    return err(
      domainError('INVALID_ARGUMENT', `Pack content key "${input.logicalKey}" must be pack-qualified under "${input.packId}".`, {
        logicalKey: input.logicalKey,
        packId: input.packId,
      }),
    );
  }
  return ok({
    packId: input.packId,
    packVersion: input.packVersion,
    contentKind: input.contentKind as PackContentKind,
    logicalKey: input.logicalKey,
    materializedEntityRef: input.materializedEntityRef ?? null,
  });
}
