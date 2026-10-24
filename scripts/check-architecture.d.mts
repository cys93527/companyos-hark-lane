/**
 * Type declaration for scripts/check-architecture.mjs (Sprint 22).
 *
 * The guard is a plain ESM script; this declaration gives the vitest architecture
 * probes a typed seam (tsc checks tests/**, and a JS module import is otherwise
 * implicitly any).
 */
export interface ArchitectureViolation {
  /** The law id, e.g. "ARCH-021". */
  readonly law: string;
  /** Where the violation is (path or path:line). */
  readonly where: string;
  /** What was found. */
  readonly what: string;
  /** Why it violates the architecture. */
  readonly why: string;
  /** Allowed boundary / remediation. */
  readonly fix: string;
}

export interface ArchitectureGuardResult {
  readonly violations: readonly ArchitectureViolation[];
  readonly notes: readonly string[];
  readonly scanned: { readonly sources: number; readonly migrations: number };
}

/** Run the architecture guard over a repository (or fixture) root. */
export declare function checkArchitecture(root: string): ArchitectureGuardResult;
