/**
 * Handoff persistence port (Sprint 11 §十六).
 *
 * It lives in Core so the engine produces handoffs and the persistence layer stores them, while
 * Core owns the shape both sides agree on. History is append-only per version: a rejected version
 * is never overwritten.
 */
import type { HandoffPacket } from '../domain/handoff.js';

export interface HandoffStorePort {
  /** Insert the packet. A duplicate (handoffId, version) must fail, never overwrite. */
  create(packet: HandoffPacket): Promise<void>;
  /** Replace the packet row of the SAME version (status transitions only). */
  update(packet: HandoffPacket): Promise<void>;
  get(handoffId: string, version: number | null): Promise<HandoffPacket | null>;
  /** Every version of one handoff, newest first. */
  listVersions(handoffId: string): Promise<readonly HandoffPacket[]>;
  /** Handoffs addressed to one role (newest first). */
  listForTargetRole(toRoleId: string, limit: number): Promise<readonly HandoffPacket[]>;
  /**
   * T20-06: the LATEST version of every handoff packet inside one exact work scope
   * (company + run + task), deterministically ordered (handoffId descending — never a
   * timestamp). Status filtering is the reader's authority (the ACCEPTED-only projection
   * lives in the domain, `handoffContextViewIfAccepted`).
   */
  listForScope(scope: {
    readonly companyId: string;
    readonly workflowRunId: string;
    readonly taskId: string;
  }): Promise<readonly HandoffPacket[]>;
  listRecent(limit: number): Promise<readonly HandoffPacket[]>;
}
