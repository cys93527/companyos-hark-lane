/**
 * Artifact content storage port (Sprint 13A — ADR-0015 D3/D11).
 *
 * The CAS boundary: opaque bytes in, content-addressed identity out. It owns NOTHING
 * but the bytes — no artifactId, no run, no commandId, no lifecycle policy. The
 * contentRef format is the Accepted `sha256:<64 lowercase hex>`; Core keeps treating
 * contentRef as opaque and never resolves it.
 *
 * This port lives in Core (types only, no Node fs/path) so the future ArtifactService
 * depends on the abstraction — never on a filesystem concrete class. `Uint8Array` is
 * the byte carrier (binary-transparent; no UTF-8/JSON assumption).
 */

/** Identity triple returned by a successful `put`. */
export interface StoredContent {
  /** Canonical managed ref: `sha256:<64 lowercase hex>`. */
  readonly contentRef: string;
  /** Lowercase hex SHA-256 of the actual stored bytes. */
  readonly contentHash: string;
  readonly sizeBytes: number;
}

/**
 * Integrity verdict for `verify` (used by diagnostics and future startup
 * reconciliation): `valid` = present and hash-verified; `missing` = addressable but
 * absent; `hash-mismatch` = present but the bytes violate their own address.
 */
export type ContentIntegrity =
  | { readonly status: 'valid'; readonly sizeBytes: number }
  | { readonly status: 'missing' }
  | { readonly status: 'hash-mismatch' };

export interface ArtifactContentStore {
  /**
   * Store opaque bytes immutably. The SHA-256 is computed from the ACTUAL bytes —
   * never taken from a caller. An optional `expectedHash` is an additional verification
   * only (mismatch → refusal); it is never the source of truth.
   * Race-safe no-clobber publication: an already-published object is reused after
   * verification, never overwritten; a corrupt object at the target address fails
   * closed (ADR-0015 decision 13).
   */
  put(content: Uint8Array, expectedHash?: string): Promise<StoredContent>;
  /** Read the bytes back, re-verifying the digest on every read (fail closed). */
  get(contentRef: string): Promise<Uint8Array>;
  /** Integrity verification without returning the bytes. */
  verify(contentRef: string): Promise<ContentIntegrity>;
}

/** Read-only CAS diagnostics (Task-13-10): enumerate, never mutate (ADR-0015 detect-only). */
export interface ManagedCasEntry {
  readonly digest: string;
  readonly contentRef: string;
  readonly sizeBytes: number;
}
export interface StagingEntry {
  readonly fileName: string;
  readonly sizeBytes: number;
}
export interface UnknownEntry {
  readonly relativePath: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}
export interface CasDiagnosticsSnapshot {
  readonly managedFinals: readonly ManagedCasEntry[];
  readonly stagingEntries: readonly StagingEntry[];
  readonly unknownEntries: readonly UnknownEntry[];
  readonly reparseViolations: readonly string[];
}
export interface ArtifactContentDiagnosticsPort {
  snapshot(): CasDiagnosticsSnapshot;
}
