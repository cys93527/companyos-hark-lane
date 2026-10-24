/**
 * Durable handoff store (Sprint 11 §十六).
 *
 * Two integrity guarantees live HERE, not only in the pure state machine:
 *  1. `(handoff_id, version)` is the primary key - a version is never overwritten by `create`;
 *  2. `updateStatus` only updates rows that are still DRAFT/READY, so a terminal version
 *     (ACCEPTED/REJECTED/SUPERSEDED/CANCELLED) can never be rewritten from storage.
 */
import { DomainError, type HandoffPacket, type HandoffRef, type HandoffRefKind, type HandoffStorePort } from '@companyos/core';

import type { Database } from '../db.js';

interface HandoffRow {
  readonly handoff_id: string;
  readonly version: number | bigint;
  readonly company_id: string;
  readonly workflow_id: string;
  readonly workflow_version_id: string;
  readonly workflow_run_id: string;
  readonly stage_id: string;
  readonly task_id: string;
  readonly from_agent_id: string;
  readonly from_role_id: string;
  readonly to_role_id: string;
  readonly to_agent_id: string | null;
  readonly objective: string;
  readonly status: string;
  readonly summary: string;
  readonly completed_work_json: string;
  readonly remaining_work_json: string;
  readonly constraints_json: string;
  readonly acceptance_criteria_json: string;
  readonly known_risks_json: string;
  readonly open_questions_json: string;
  readonly recommended_next_action: string;
  readonly model_key: string | null;
  readonly provider_id: string | null;
  readonly execution_ref: string | null;
  readonly supersedes: string | null;
  readonly accepted_by: string | null;
  readonly accepted_at: string | null;
  readonly rejected_by: string | null;
  readonly rejected_at: string | null;
  readonly rejection_reasons_json: string;
  readonly rejection_comment: string | null;
  readonly trace_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RefRow {
  readonly kind: string;
  readonly ref_id: string;
}

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/** A storage-level guard: only non-terminal versions may change status. */
export const HANDOFF_UPDATABLE_STATES = ['DRAFT', 'READY'] as const;

/** The exact status value this store is allowed to write for `(handoffId, version)`. */
export interface HandoffStatusUpdate {
  readonly handoffId: string;
  readonly version: number;
  readonly packet: HandoffPacket;
}

const toPacket = (row: HandoffRow, refs: readonly RefRow[]): HandoffPacket => {
  const of = (kind: HandoffRefKind): HandoffRef[] =>
    refs.filter((ref) => ref.kind === kind).map((ref) => ({ kind, refId: ref.ref_id }));
  const modelKey = row.model_key;
  const providerId = row.provider_id;
  return {
    handoffId: row.handoff_id,
    handoffVersion: Number(row.version),
    companyId: row.company_id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    workflowRunId: row.workflow_run_id,
    stageId: row.stage_id,
    taskId: row.task_id,
    fromAgentId: row.from_agent_id,
    fromRoleId: row.from_role_id,
    toRoleId: row.to_role_id,
    toAgentId: row.to_agent_id,
    objective: row.objective,
    status: row.status as HandoffPacket['status'],
    summary: row.summary,
    completedWork: parseJson<readonly string[]>(row.completed_work_json, []),
    remainingWork: parseJson<readonly string[]>(row.remaining_work_json, []),
    constraints: parseJson<readonly string[]>(row.constraints_json, []),
    acceptanceCriteria: parseJson<readonly string[]>(row.acceptance_criteria_json, []),
    artifactRefs: of('artifact'),
    decisionRefs: of('decision'),
    validationRefs: of('validation'),
    knownRisks: parseJson<readonly string[]>(row.known_risks_json, []),
    openQuestions: parseJson<readonly string[]>(row.open_questions_json, []),
    recommendedNextAction: row.recommended_next_action,
    modelBinding: modelKey === null || providerId === null ? null : { modelKey, providerId },
    executionRef: row.execution_ref,
    supersedes: row.supersedes,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    rejectionReasons: parseJson<HandoffPacket['rejectionReasons']>(row.rejection_reasons_json, []),
    rejectionComment: row.rejection_comment,
    traceId: row.trace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/** The durable handoff store: create / updateStatus / get / listVersions / listForTargetRole / listRecent. */
export function createSqliteHandoffStore(db: Database): HandoffStorePort {
  const insertRefs = (packet: HandoffPacket): void => {
    // Plain INSERT: an invalid ref must FAIL the transaction (a behaviour test proved that
    // `INSERT OR IGNORE` silently swallowed a CHECK violation and left the handoff incomplete).
    const statement = db.prepare(
      'INSERT INTO handoff_refs (handoff_id, version, kind, ref_id) VALUES (?, ?, ?, ?)',
    );
    const all: readonly HandoffRef[] = [
      ...packet.artifactRefs,
      ...packet.decisionRefs,
      ...packet.validationRefs,
      ...(packet.executionRef === null ? [] : [{ kind: 'execution' as const, refId: packet.executionRef }]),
    ];
    // Dedupe: a repeated ref used to fail after the row was already inserted (partial history).
    const seen = new Set<string>();
    for (const ref of all) {
      const key = `${ref.kind}:${ref.refId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      statement.run(packet.handoffId, packet.handoffVersion, ref.kind, ref.refId);
    }
  };

  const loadRefs = (handoffId: string, version: number): readonly RefRow[] =>
    db.prepare('SELECT kind, ref_id FROM handoff_refs WHERE handoff_id = ? AND version = ? ORDER BY kind, ref_id').all(
      handoffId,
      version,
    ) as readonly RefRow[];

  return {
    async create(packet: HandoffPacket): Promise<void> {
      try {
        // ATOMIC (review MEDIUM): the row and its refs commit together, so a ref failure can never
        // leave a half-written handoff behind. Reuses the existing synchronous transaction helper.
        db.inTransaction(() => {
        db.prepare(
          `INSERT INTO handoffs (
             handoff_id, version, company_id, workflow_id, workflow_version_id, workflow_run_id, stage_id,
             task_id, from_agent_id, from_role_id, to_role_id, to_agent_id, objective, status, summary,
             completed_work_json, remaining_work_json, constraints_json, acceptance_criteria_json,
             known_risks_json, open_questions_json, recommended_next_action, model_key, provider_id,
             execution_ref, supersedes, accepted_by, accepted_at, rejected_by, rejected_at,
             rejection_reasons_json, rejection_comment, trace_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          packet.handoffId,
          packet.handoffVersion,
          packet.companyId,
          packet.workflowId,
          packet.workflowVersionId,
          packet.workflowRunId,
          packet.stageId,
          packet.taskId,
          packet.fromAgentId,
          packet.fromRoleId,
          packet.toRoleId,
          packet.toAgentId,
          packet.objective,
          packet.status,
          packet.summary,
          JSON.stringify(packet.completedWork),
          JSON.stringify(packet.remainingWork),
          JSON.stringify(packet.constraints),
          JSON.stringify(packet.acceptanceCriteria),
          JSON.stringify(packet.knownRisks),
          JSON.stringify(packet.openQuestions),
          packet.recommendedNextAction,
          packet.modelBinding?.modelKey ?? null,
          packet.modelBinding?.providerId ?? null,
          packet.executionRef,
          packet.supersedes,
          packet.acceptedBy,
          packet.acceptedAt,
          packet.rejectedBy,
          packet.rejectedAt,
          JSON.stringify(packet.rejectionReasons),
          packet.rejectionComment,
          packet.traceId,
          packet.createdAt,
          packet.updatedAt,
        );
        insertRefs(packet);
        });
      } catch (error) {
        // 07cc53b re-audit (N07-R1) — a TYPED persistence failure (e.g. a failed transaction
        // unwind whose connection state is unknown) is never re-classified as a domain
        // conflict: only a RAW driver constraint error means "this version already exists".
        if (!(error instanceof DomainError) && error instanceof Error && /UNIQUE|PRIMARY KEY|constraint/i.test(error.message)) {
          throw new DomainError(
            'ALREADY_EXISTS',
            `Handoff "${packet.handoffId}" v${String(packet.handoffVersion)} already exists; versions are immutable.`,
            { details: { handoffId: packet.handoffId, version: packet.handoffVersion, reason: 'HANDOFF_VERSION_EXISTS' } },
          );
        }
        throw error;
      }
    },

    async update(packet: HandoffPacket): Promise<void> {
      // Storage-level history protection (review MEDIUM fix).
      //
      // Content columns are NEVER written here, and the decision FACTS (accepted_by/accepted_at/
      // rejected_by/rejected_at/rejection_*) may only be recorded on a NON-terminal row. A terminal
      // row may only be superseded - status + updated_at, nothing else - so `ACCEPTED → SUPERSEDED`
      // can never rewrite who accepted it, and a DRAFT/READY row can never be forced into a state
      // the frozen machine would not allow.
      const NON_TERMINAL_TARGETS = ['READY', 'ACCEPTED', 'REJECTED', 'CANCELLED'] as const;
      const canBecomeNonTerminal = (NON_TERMINAL_TARGETS as readonly string[]).includes(packet.status);
      if (canBecomeNonTerminal) {
        const result = db
          .prepare(
            `UPDATE handoffs SET
               status = ?, accepted_by = ?, accepted_at = ?, rejected_by = ?, rejected_at = ?,
               rejection_reasons_json = ?, rejection_comment = ?, updated_at = ?
             WHERE handoff_id = ? AND version = ? AND status IN ('DRAFT', 'READY')`,
          )
          .run(
            packet.status,
            packet.acceptedBy,
            packet.acceptedAt,
            packet.rejectedBy,
            packet.rejectedAt,
            JSON.stringify(packet.rejectionReasons),
            packet.rejectionComment,
            packet.updatedAt,
            packet.handoffId,
            packet.handoffVersion,
          );
        if (Number(result.changes) === 1) return;
      }
      if (packet.status === 'SUPERSEDED') {
        // The ONLY legal terminal→terminal move: status only, decision facts untouched.
        const result = db
          .prepare(
            `UPDATE handoffs SET status = 'SUPERSEDED', updated_at = ?
             WHERE handoff_id = ? AND version = ? AND status IN ('READY', 'ACCEPTED', 'REJECTED')`,
          )
          .run(packet.updatedAt, packet.handoffId, packet.handoffVersion);
        if (Number(result.changes) === 1) return;
      }
      throw new DomainError(
        'CONFLICT',
        `Handoff "${packet.handoffId}" v${String(packet.handoffVersion)} is terminal or missing; history is immutable.`,
        {
          details: {
            handoffId: packet.handoffId,
            version: packet.handoffVersion,
            reason: 'TERMINAL_HANDOFF_IMMUTABLE',
            attempted: packet.status,
          },
        },
      );
    },

    async get(handoffId: string, version: number | null): Promise<HandoffPacket | null> {
      const row = (
        version === null
          ? db.prepare('SELECT * FROM handoffs WHERE handoff_id = ? ORDER BY version DESC LIMIT 1').get(handoffId)
          : db.prepare('SELECT * FROM handoffs WHERE handoff_id = ? AND version = ?').get(handoffId, version)
      ) as HandoffRow | undefined;
      if (row === undefined) return null;
      return toPacket(row, loadRefs(handoffId, Number(row.version)));
    },

    async listVersions(handoffId: string): Promise<readonly HandoffPacket[]> {
      const rows = db
        .prepare('SELECT * FROM handoffs WHERE handoff_id = ? ORDER BY version DESC')
        .all(handoffId) as readonly HandoffRow[];
      return rows.map((row) => toPacket(row, loadRefs(handoffId, Number(row.version))));
    },

    async listForTargetRole(toRoleId: string, limit: number): Promise<readonly HandoffPacket[]> {
      const rows = db
        .prepare(
          `SELECT h.* FROM handoffs h
           WHERE h.to_role_id = ?
             AND h.version = (SELECT MAX(version) FROM handoffs WHERE handoff_id = h.handoff_id)
           ORDER BY h.created_at DESC, h.handoff_id DESC LIMIT ?`,
        )
        .all(toRoleId, limit) as readonly HandoffRow[];
      return rows.map((row) => toPacket(row, loadRefs(row.handoff_id, Number(row.version))));
    },

    async listForScope(scope: {
      readonly companyId: string;
      readonly workflowRunId: string;
      readonly taskId: string;
    }): Promise<readonly HandoffPacket[]> {
      // Latest version per handoffId inside the exact scope; ordering is the packet's OWN
      // identity (never a timestamp) so the projection is a deterministic function of
      // durable state.
      const rows = db
        .prepare(
          `SELECT h.* FROM handoffs h
           WHERE h.company_id = ? AND h.workflow_run_id = ? AND h.task_id = ?
             AND h.version = (SELECT MAX(version) FROM handoffs WHERE handoff_id = h.handoff_id)
           ORDER BY h.handoff_id DESC`,
        )
        .all(scope.companyId, scope.workflowRunId, scope.taskId) as readonly HandoffRow[];
      return rows.map((row) => toPacket(row, loadRefs(row.handoff_id, Number(row.version))));
    },

    async listRecent(limit: number): Promise<readonly HandoffPacket[]> {
      const rows = db
        .prepare('SELECT * FROM handoffs ORDER BY created_at DESC, handoff_id DESC, version DESC LIMIT ?')
        .all(limit) as readonly HandoffRow[];
      return rows.map((row) => toPacket(row, loadRefs(row.handoff_id, Number(row.version))));
    },
  };
}
