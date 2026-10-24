/**
 * Startup Artifact/CAS integrity reconciliation & diagnostics
 * (Sprint 13B — Task-13-10; ADR-0015 decision 11, REVISED by Boss ruling 2026-09-26).
 *
 * REVISED SEMANTICS — DETECT / REPORT ONLY:
 *   reconciliation is a READ-ONLY scan→validate→classify→report pass.
 *   It performs ZERO filesystem mutation: no orphan deletion, no staging deletion,
 *   no repair. Automatic cleanup is OUT OF SCOPE for Sprint 13 and requires an
 *   independent architecture decision (CAS_ORPHAN_CLEANUP_POLICY_GAP, 2026-09-26).
 *
 * Must run at QUIESCENT startup — before ArtifactService writes are exposed — so a
 * just-published-but-uncommitted CAS object is never misclassified as an orphan
 * (Task-13-10 §2). T11 wires the startup invocation/order; T10 only provides this
 * capability.
 *
 * Classifications (ADR-0015 §Failure-Model, revised):
 *   HEALTHY           — metadata + valid CAS
 *   ORPHAN_CAS        — managed CAS final with no durable metadata → REPORT ONLY
 *   STAGING_RESIDUE   — recognized staging file → REPORT ONLY
 *   UNKNOWN_ENTRY     — unrecognized root/staging entry → REPORT ONLY
 *   FATAL (fail closed, reconciler returns failure, zero mutation):
 *     VALIDATION_GATE-equivalent durable integrity violations:
 *     - Artifact.contentRef malformed / != contentHash digest
 *     - Artifact.contentHash malformed
 *     - referenced CAS missing (metadata → missing content)
 *     - referenced CAS hash mismatch (metadata → corrupt content)
 *     - referenced artifact size mismatch
 *     - symlink/junction/reparse inside the managed namespace
 *     - ArtifactStore enumeration failure
 */
import {
  domainError,
  type ArtifactContentDiagnosticsPort,
  type ArtifactStorePort,
  type DomainError,
} from '@companyos/core';

export interface ReconcilerDeps {
  readonly artifactStore: ArtifactStorePort;
  readonly contentDiagnostics: ArtifactContentDiagnosticsPort;
  readonly contentVerifier: {
    /** Existing verify() — returns 'valid' | 'missing' | 'hash-mismatch'. */
    verify(contentRef: string): Promise<
      | { readonly status: 'valid'; readonly sizeBytes: number }
      | { readonly status: 'missing' }
      | { readonly status: 'hash-mismatch' }
    >;
  };
}

export interface OrphanObservation {
  readonly contentRef: string;
}
export interface StagingObservation {
  readonly fileName: string;
}
export interface UnknownObservation {
  readonly relativePath: string;
}
export interface FatalObservation {
  readonly artifactId: string;
  readonly contentRef: string;
  readonly integrityStatus: string;
}

export interface ReconciliationReport {
  readonly artifactsChecked: number;
  readonly uniqueReferencedContent: number;
  readonly managedCasObjectsSeen: number;
  readonly orphanCasObserved: number;
  readonly stagingResidueObserved: number;
  readonly unknownEntriesObserved: number;
  readonly sizeChecksPerformed: number;
  readonly orphans: readonly OrphanObservation[];
  readonly staging: readonly StagingObservation[];
  readonly unknown: readonly UnknownObservation[];
  /** Fatal integrity findings (also surfaced via the returned failure result). */
  readonly fatal: readonly FatalObservation[];
}

export interface ArtifactCasReconciler {
  /**
   * READ-ONLY scan → validate → classify → report. Zero filesystem/DB mutation.
   * Deterministic: the same durable+filesystem state yields an equivalent report.
   */
  reconcile(): Promise<ReconcileOutcome>;
}

export type ReconcileOutcome =
  | { readonly ok: true; readonly status: 'ok'; readonly report: ReconciliationReport }
  | {
      readonly ok: false;
      readonly fatal: boolean;
      /** True when a fatal integrity failure prevents healthy startup (Task-13-10 §6). */
      readonly report: ReconciliationReport;
      readonly error: DomainError;
    };

export function createArtifactCasReconciler(deps: ReconcilerDeps): ArtifactCasReconciler {
  return {
    async reconcile(): Promise<
      | { ok: true; status: 'ok'; report: ReconciliationReport }
      | { ok: false; fatal: true; report: ReconciliationReport; error: DomainError }
    > {
      // ---- enumerate durable metadata (fail closed on store error — §55) ----
      let artifacts;
      try {
        artifacts = await deps.artifactStore.listAll();
      } catch (error) {
        const failure = domainError('PERSISTENCE_FAILED', 'Artifact enumeration failed during startup reconciliation.', {
          cause: String(error),
        });
        return { ok: false, fatal: true, report: emptyReport(), error: failure };
      }

      // ---- Phase A: scan + validate (READ-ONLY) ----
      const cas = deps.contentDiagnostics.snapshot();

      const referencedRefs = new Set<string>();
      const fatal: { artifactId: string; contentRef: string; integrityStatus: string }[] = [];

      for (const artifact of artifacts) {
        // metadata integrity: strict ref + strict hash + mutual consistency (§11/§50)
        const digestOfRef = artifact.contentRef.startsWith('sha256:') ? artifact.contentRef.slice('sha256:'.length) : null;
        const refStrict = digestOfRef !== null && /^[0-9a-f]{64}$/.test(digestOfRef);
        const hashStrict = /^[0-9a-f]{64}$/.test(artifact.contentHash);
        if (!refStrict || !hashStrict || digestOfRef !== artifact.contentHash) {
          fatal.push({
            artifactId: artifact.id,
            contentRef: artifact.contentRef,
            integrityStatus: 'METADATA_REF_HASH_MISMATCH',
          });
          continue;
        }
        referencedRefs.add(artifact.contentRef);

        // referenced CAS existence + hash (§12/§13)
        const verdict = await deps.contentVerifier.verify(artifact.contentRef);
        if (verdict.status === 'missing') {
          fatal.push({ artifactId: artifact.id, contentRef: artifact.contentRef, integrityStatus: 'CAS_MISSING' });
        } else if (verdict.status === 'hash-mismatch') {
          fatal.push({ artifactId: artifact.id, contentRef: artifact.contentRef, integrityStatus: 'CAS_HASH_MISMATCH' });
        }
        // valid → size check when the diagnostics adapter can stat safely (§16)
        if (verdict.status === 'valid') {
          const managed = cas.managedFinals.find((m) => m.contentRef === artifact.contentRef);
          if (managed !== undefined && managed.sizeBytes !== artifact.sizeBytes) {
            fatal.push({ artifactId: artifact.id, contentRef: artifact.contentRef, integrityStatus: 'CAS_SIZE_MISMATCH' });
          }
        }
      }

      const orphans = cas.managedFinals
        .filter((m) => !referencedRefs.has(m.contentRef))
        .map((m) => ({ contentRef: m.contentRef }));
      const report: ReconciliationReport = {
        artifactsChecked: artifacts.length,
        uniqueReferencedContent: referencedRefs.size,
        managedCasObjectsSeen: cas.managedFinals.length,
        orphanCasObserved: orphans.length,
        stagingResidueObserved: cas.stagingEntries.length,
        unknownEntriesObserved: cas.unknownEntries.length,
        sizeChecksPerformed: cas.managedFinals.length,
        orphans,
        staging: cas.stagingEntries.map((s) => ({ fileName: s.fileName })),
        unknown: cas.unknownEntries.map((u) => ({ relativePath: u.relativePath })),
        fatal,
      };

      // ---- fatal integrity → FAIL CLOSED (zero mutation, §13/§27/§28) ----
      if (fatal.length > 0) {
        const first = fatal[0]!;
        const error = domainError('PERSISTENCE_FAILED', `Artifact integrity reconciliation failed (${String(fatal.length)} fatal finding(s)).`, {
          reason: 'ARTIFACT_INTEGRITY_FATAL',
          findings: fatal,
          firstArtifactId: first.artifactId,
          firstContentRef: first.contentRef,
          firstIntegrityStatus: first.integrityStatus,
        });
        return { ok: false, fatal: true, report, error };
      }

      // reparse violations inside the managed namespace are security/integrity fatal (§13)
      if (cas.reparseViolations.length > 0) {
        return {
          ok: false,
          fatal: true,
          report,
          error: domainError('PERSISTENCE_FAILED', `CAS reparse point(s) detected inside the managed namespace (${String(cas.reparseViolations.length)}).`, {
            reason: 'CAS_REPARSE_VIOLATION',
            count: cas.reparseViolations.length,
          }),
        };
      }

      // ---- Phase B is intentionally ABSENT: detect/report only (Boss ruling) ----
      // Orphans and staging are REPORTED and LEFT ON DISK.
      return { ok: true as const, status: 'ok' as const, report };
    },
  };
}

function emptyReport(): ReconciliationReport {
  return {
    artifactsChecked: 0,
    uniqueReferencedContent: 0,
    managedCasObjectsSeen: 0,
    orphanCasObserved: 0,
    stagingResidueObserved: 0,
    unknownEntriesObserved: 0,
    sizeChecksPerformed: 0,
    orphans: [],
    staging: [],
    unknown: [],
    fatal: [],
  };
}
