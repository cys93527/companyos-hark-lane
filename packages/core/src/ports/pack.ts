/**
 * Pack persistence ports (Sprint 15 — Task-15-03; ADR-0024/0025/0027).
 *
 * Three stores for the THREE durable truths of the Industry Pack layer:
 *   PackVersionStore      — immutable `(packId, packVersion)` canonical manifests
 *   PackInstallationStore — company-scoped lifecycle bindings (the only mutable row)
 *   PackContentRefStore   — provenance mapping PackVersion→materialized entity
 *
 * Rules frozen by the ADRs (enforced in the SQLite adapters):
 *   - Stores persist durable facts; they do NOT authorize (pack.manage execution point
 *     arrives in T15-04) and do NOT materialize subsystem content (T15-04).
 *   - No delete/GC/hard-uninstall surface exists in these ports (ADR-0025).
 *   - Company scope is a required parameter wherever installations are addressed: no
 *     convenience API may read across tenants.
 *   - PackVersion read integrity is fail-closed (corrupt manifest / fingerprint
 *     mismatch = an error, never a partial object).
 */
import type { DomainError } from '../kernel/errors.js';
import type { Result } from '../kernel/result.js';
import type { PackContentRef, PackInstallation, PackVersion } from '../domain/pack.js';

export interface PackVersionStore {
  /**
   * INSERT-ONCE. Same `(packId, packVersion)`:
   *   same manifestFingerprint   → replay the stored version (idempotent, zero writes)
   *   different manifestFingerprint → CONFLICT (never an overwrite).
   */
  put(version: PackVersion): Promise<Result<PackVersion, DomainError>>;
  /** Fail-closed read: invalid snapshot / wrong-format fingerprint / recomputation mismatch → error; absent → ok(null). */
  get(packId: string, packVersion: string): Promise<Result<PackVersion | null, DomainError>>;
}

export interface PackInstallationStore {
  /**
   * Insert one installation. Fails closed when the referenced PackVersion row is
   * absent (existence is validated inside the caller's transaction — no cross-chain
   * FK), and CONFLICTs on any durable uniqueness violation:
   *   (creation_command_id) · (company_id, pack_id, pack_version) · one-enabled-per-pack.
   */
  create(input: {
    readonly installation: PackInstallation;
    readonly creationCommandId: string;
    readonly creationCommandFingerprint: string;
  }): Promise<Result<PackInstallation, DomainError>>;
  get(installationId: string): Promise<Result<PackInstallation | null, DomainError>>;
  findByCompanyPackVersion(
    companyId: string,
    packId: string,
    packVersion: string,
  ): Promise<Result<PackInstallation | null, DomainError>>;
  /** Permanent-identity lookup (Sprint 13 Option B): the command that produced the installation. */
  findByCreationCommand(creationCommandId: string): Promise<Result<PackInstallation | null, DomainError>>;
  listByCompany(companyId: string): Promise<Result<readonly PackInstallation[], DomainError>>;
  /** The one enabled version of a pack in a company, or null. */
  findEnabled(companyId: string, packId: string): Promise<Result<PackInstallation | null, DomainError>>;
  /** installed ↔ disabled only; the one-enabled-version invariant stays enforced. */
  setStatus(installationId: string, status: PackInstallation['status'], now: string): Promise<Result<PackInstallation, DomainError>>;
}

/**
 * Live-availability policy for PACK-MATERIALIZED content (T15-04 corrective —
 * PACK_LIVE_CAPABILITY_DISABLE_GAP; ADR-0025 Decision 4 "no LIVE capability residue").
 *
 * A materialized entity (a Role the authorization service created, a WorkflowTemplate
 * the lifecycle service drafted) keeps its durable row after disable — provenance and
 * history are never deleted. But a disabled pack must expose nothing to NEW work, and
 * only the pack layer can answer that question, because the subsystem services hold no
 * pack state of their own.
 *
 * Semantics (company-scoped, any-live-owner):
 *   - no PackContentRef references the entity        → not pack content  → AVAILABLE
 *   - at least one owning installation is `installed` → a live pack owns it → AVAILABLE
 *   - every owning installation is `disabled`         → no live owner    → UNAVAILABLE
 *
 * The last rule supports safe reuse: a Role materialized by v1 and reused by v2 of the
 * same pack stays available while v2 is installed, even though v1 is disabled.
 */
export interface PackAvailabilityPolicy {
  isMaterializedContentAvailable(input: {
    readonly companyId: string;
    readonly contentKind: PackContentRef['contentKind'];
    readonly entityId: string;
  }): Promise<Result<boolean, DomainError>>;
}

/**
 * Run provenance policy (T15-05; ADR-0027 Decision 1/2).
 *
 *  is TRUSTED DERIVED DATA: the authoritative run creator never
 * accepts it from a caller. The policy derives it from durable provenance at NEW RUN
 * CREATION ONLY — the live pack owners of the selected materialized WorkflowTemplate plus
 * their transitive REQUIRED exact-version dependency closure — and returns an empty map
 * for a packless (legacy) workflow. Fail-closed: an incomplete resolution is an error, so
 * no Run and no snapshot is written. After creation the run never asks again.
 */
export interface PackRunProvenancePolicy {
  resolveForWorkflow(input: {
    /** The Run company scope — provenance never crosses tenants. */
    readonly companyId: string;
    /** The template the new Run executes. */
    readonly templateId: string;
  }): Promise<Result<Readonly<Record<string, string>>, DomainError>>;
}

export interface PackContentRefStore {
  /** INSERT-ONCE provenance; a duplicate (installation, contentKind, logicalKey) is a CONFLICT. */
  insert(
    installationId: string,
    ref: PackContentRef,
  ): Promise<Result<PackContentRef, DomainError>>;
  listByInstallation(installationId: string): Promise<Result<readonly PackContentRef[], DomainError>>;
  findByKey(
    installationId: string,
    contentKind: PackContentRef['contentKind'],
    logicalKey: string,
  ): Promise<Result<PackContentRef | null, DomainError>>;
}
