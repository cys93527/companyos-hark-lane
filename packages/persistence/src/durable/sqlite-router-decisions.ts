/**
 * Durable store for Router decisions (Sprint 10B §二十四).
 *
 * It stores the decision, its reason codes and the (bounded) candidate evaluations so that
 * "why did it choose this model back then" stays answerable after a restart. Secrets, credentials
 * and prompt text are never written here.
 */
import type { RouterDecisionRecord, RouterDecisionStorePort } from '@companyos/core';

import type { Database } from '../db.js';

export interface RouterDecisionRow {
  readonly decision_id: string;
  readonly request_id: string;
  readonly task_id: string;
  readonly role_id: string;
  readonly selection_mode: string;
  readonly selected_model_key: string | null;
  readonly decision: string;
  readonly reason_codes_json: string;
  readonly candidate_evaluations_json: string;
  readonly rejected_candidates_json: string;
  readonly policy_snapshot_version: string;
  readonly model_registry_revision: string;
  readonly benchmark_version: string | null;
  readonly performance_snapshot: string | null;
  readonly router_version: string;
  readonly trace_id: string;
  readonly created_at: string;
}

/** Read-only view for audits and tests (the composition root may expose it via IPC later). */
export interface RouterDecisionReadPort {
  get(decisionId: string): Promise<RouterDecisionRecord | null>;
  latestForRequest(requestId: string): Promise<RouterDecisionRecord | null>;
  listRecent(limit: number): Promise<readonly RouterDecisionRecord[]>;
}

/** The durable decision store the composition root hands to the router. */
export type RouterDecisionStore = RouterDecisionStorePort & RouterDecisionReadPort;

const toRecord = (row: RouterDecisionRow): RouterDecisionRecord => ({
  decisionId: row.decision_id,
  requestId: row.request_id,
  taskId: row.task_id,
  roleId: row.role_id,
  selectionMode: row.selection_mode as RouterDecisionRecord['selectionMode'],
  selectedModelKey: row.selected_model_key,
  decision: row.decision as RouterDecisionRecord['decision'],
  reasonCodesJson: row.reason_codes_json,
  candidateEvaluationsJson: row.candidate_evaluations_json,
  rejectedCandidatesJson: row.rejected_candidates_json,
  policySnapshotVersion: row.policy_snapshot_version,
  modelRegistryRevision: row.model_registry_revision,
  benchmarkVersion: row.benchmark_version,
  performanceSnapshot: row.performance_snapshot,
  routerVersion: row.router_version,
  traceId: row.trace_id,
  createdAt: row.created_at,
});

/** SQLite-backed router decision store + read port (idempotent by decision_id). */
export const createSqliteRouterDecisionStore = (
  db: Database,
): RouterDecisionStore => ({
  async save(record: RouterDecisionRecord): Promise<void> {
    // 10B.1 §十一: a plain INSERT - NO `ON CONFLICT DO NOTHING`, so a decision_id collision
    // surfaces as an error instead of being silently swallowed.
    db.prepare(
      `INSERT INTO router_decisions (
         decision_id, request_id, task_id, role_id, selection_mode, selected_model_key, decision,
         reason_codes_json, candidate_evaluations_json, rejected_candidates_json,
         policy_snapshot_version, model_registry_revision, benchmark_version, performance_snapshot,
         router_version, trace_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.decisionId,
      record.requestId,
      record.taskId,
      record.roleId,
      record.selectionMode,
      record.selectedModelKey,
      record.decision,
      record.reasonCodesJson,
      record.candidateEvaluationsJson,
      record.rejectedCandidatesJson,
      record.policySnapshotVersion,
      record.modelRegistryRevision,
      record.benchmarkVersion,
      record.performanceSnapshot,
      record.routerVersion,
      record.traceId,
      record.createdAt,
    );
  },

  async get(decisionId: string): Promise<RouterDecisionRecord | null> {
    const row = db.prepare('SELECT * FROM router_decisions WHERE decision_id = ?').get(decisionId) as
      | RouterDecisionRow
      | undefined;
    return row === undefined ? null : toRecord(row);
  },

  async latestForRequest(requestId: string): Promise<RouterDecisionRecord | null> {
    const row = db
      .prepare('SELECT * FROM router_decisions WHERE request_id = ? ORDER BY created_at DESC, decision_id DESC LIMIT 1')
      .get(requestId) as RouterDecisionRow | undefined;
    return row === undefined ? null : toRecord(row);
  },

  async listRecent(limit: number): Promise<readonly RouterDecisionRecord[]> {
    const rows = db
      .prepare('SELECT * FROM router_decisions ORDER BY created_at DESC, decision_id DESC LIMIT ?')
      .all(limit) as readonly RouterDecisionRow[];
    return rows.map(toRecord);
  },
});
