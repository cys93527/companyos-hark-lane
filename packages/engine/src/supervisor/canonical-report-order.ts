/**
 * STAGE 9B-FIX — canonical ordering of review reports ACROSS anchors.
 *
 * Selecting "the latest canonical review report" used to compare `createdAt` first and break
 * exact millisecond ties by `artifactId` (a ULID). Two reports from DIFFERENT anchors of the
 * same corrective generation are written in the same millisecond under a fast run, so the
 * choice between them was decided by ULID randomness — the same durable state could yield two
 * different "latest" reports, and the run lifecycle that follows them is not the same.
 *
 * The order is semantic and total:
 *   1. corrective GENERATION (the lineage round of the report's own review task) — a later
 *      round's review is the newer work, whatever the wall clock says;
 *   2. `createdAt` — genuine recency WITHIN one generation (metadata, never a generation
 *      arbitration);
 *   3. `artifactId` — a stable total order ONLY between candidates that are semantically
 *      equivalent (same generation, same millisecond).
 *
 * Ids are never used to choose between non-equivalent candidates.
 */

/** The ordering facts one candidate report carries. */
export interface CanonicalReportOrder {
  readonly artifactId: string;
  readonly createdAt: string;
  /** The corrective lineage round of the report's own review task (0 when it has none). */
  readonly lineageRound: number;
}

/**
 * Strict semantic order: `> 0` when `left` is the later report. Never consults an id to
 * choose between non-equivalent candidates.
 */
export const compareCanonicalReportOrder = (left: CanonicalReportOrder, right: CanonicalReportOrder): number =>
  left.lineageRound - right.lineageRound ||
  left.createdAt.localeCompare(right.createdAt) ||
  left.artifactId.localeCompare(right.artifactId);

/** The latest canonical report of a non-empty candidate set, or null when there is none. */
export const latestCanonicalReportOf = <T extends CanonicalReportOrder>(
  reports: readonly T[],
): T | null => {
  let latest: T | null = null;
  for (const report of reports) {
    if (latest === null || compareCanonicalReportOrder(report, latest) > 0) latest = report;
  }
  return latest;
};
