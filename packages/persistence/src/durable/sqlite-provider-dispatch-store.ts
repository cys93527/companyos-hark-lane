/**
 * Sprint24 — the durable PROVIDER DISPATCH store: the implementation/provenance
 * binding SUBORDINATE to ExecutionAttempt. `claim` is a plain INSERT arbitrated
 * by the deterministic dispatch_id PRIMARY KEY and the UNIQUE(dispatch_key)
 * index — same attempt + provider replays the SAME row forever, a different
 * attempt never shares it. This is CompanyOS-side identity, NEVER a provider
 * exactly-once claim (Sprint21 §26).
 */
import { domainError, type DomainError, err, ok, type Result } from '@companyos/core';

import type { Database } from '../db.js';

export type ProviderDispatchState = 'DISPATCHED' | 'PUBLISHED' | 'SETTLED' | 'UNCERTAIN';

export interface ProviderDispatch {
  readonly id: string;
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly providerKey: string;
  readonly dispatchKey: string;
  /**
   * Provider-owned DURABLE SESSION identity (a conversation that may carry MANY turns —
   * never one exact invocation). Bound only from real provider evidence.
   */
  readonly providerSessionId: string | null;
  /**
   * Provider-owned identity of ONE concrete external invocation — recorded ONLY when the
   * provider actually exposes one. Never derived from session/dispatchKey/pid/counter.
   */
  readonly providerInvocationId: string | null;
  readonly state: ProviderDispatchState;
  readonly resultSummary: string | null;
  /**
   * STAGE 8B — the Smart Router V1 RoutingDecision evidence for THIS attempt,
   * as a JSON string (deterministic decision evidence: policyVersion, eligible
   * and rejected candidates with reasons, scoreBreakdown, selectedProfileId,
   * decisionPolicy). Null = the legacy DETERMINISTIC_V1 selection path (never
   * "matched"). Recorded once at claim time; an attempt never re-routes.
   */
  readonly routingDecisionJson: string | null;
  /**
   * Sprint25 — the deterministic fingerprint of the effective provider configuration
   * (values AND their sources) this dispatch was claimed under. Null for pre-Sprint25
   * history. A resumed attempt compares against it instead of re-reading live config.
   */
  readonly configFingerprint: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DispatchRow {
  readonly dispatch_id: string;
  readonly company_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly attempt_number: number | bigint;
  readonly provider_key: string;
  readonly dispatch_key: string;
  readonly provider_session_id: string | null;
  readonly provider_invocation_id: string | null;
  readonly state: string;
  readonly result_summary: string | null;
  readonly config_fingerprint: string | null;
  readonly routing_decision_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProviderDispatchStore {
  /** Idempotent guarded claim: same dispatch key ⇒ REPLAY (existing row); never a second row. */
  claim(dispatch: ProviderDispatch): Promise<Result<{ readonly dispatchId: string; readonly replayed: boolean }, DomainError>>;
  get(dispatchId: string): Promise<ProviderDispatch | null>;
  byAttempt(attemptId: string): Promise<readonly ProviderDispatch[]>;
  /**
   * PUBLISHED = the provider EVIDENCED a durable session identity (conversation truth,
   * not one-invocation truth). The real provider-issued id only — never manufactured.
   */
  publish(dispatchId: string, providerSessionId: string, now: string): Promise<Result<true, DomainError>>;
  /** Record a provider-exposed invocation identity (only when the provider exposes one). */
  recordInvocation(dispatchId: string, providerInvocationId: string, now: string): Promise<Result<true, DomainError>>;
  /** The provider result was delivered to the canonical engine settlement. */
  settle(dispatchId: string, resultSummary: string, now: string): Promise<Result<true, DomainError>>;
  /** Honest uncertainty: the external outcome could not be proven. */
  markUncertain(dispatchId: string, reason: string, now: string): Promise<Result<true, DomainError>>;
  /**
   * Sprint25 — record the configuration fingerprint this binding ran under. Used
   * when a binding from before the fingerprint field existed resumes, so the NEXT
   * resume can compare instead of inheriting an unknown provenance forever.
   */
  recordConfigFingerprint(dispatchId: string, fingerprint: string, now: string): Promise<Result<true, DomainError>>;
}

const dispatchConflict = (dispatchKey: string): DomainError =>
  domainError('CONFLICT', `The provider dispatch key "${dispatchKey}" is bound to a different dispatch.`, {
    reason: 'PROVIDER_DISPATCH_KEY_CONFLICT',
    dispatchKey,
  });

export const createSqliteProviderDispatchStore = (db: Database): ProviderDispatchStore => {
  const toDomain = (row: DispatchRow): ProviderDispatch => ({
    id: row.dispatch_id,
    companyId: row.company_id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    attemptNumber: Number(row.attempt_number),
    providerKey: row.provider_key,
    dispatchKey: row.dispatch_key,
    providerSessionId: row.provider_session_id,
    providerInvocationId: row.provider_invocation_id,
    state: row.state as ProviderDispatchState,
    resultSummary: row.result_summary,
    configFingerprint: row.config_fingerprint ?? null,
    routingDecisionJson: row.routing_decision_json ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const readByKey = (dispatchKey: string): ProviderDispatch | null => {
    const row = db
      .prepare('SELECT * FROM provider_dispatches WHERE dispatch_key = ?')
      .get(dispatchKey) as DispatchRow | undefined;
    return row === undefined ? null : toDomain(row);
  };

  return {
    async claim(dispatch) {
      const existing = readByKey(dispatch.dispatchKey);
      if (existing !== null) {
        if (existing.id !== dispatch.id) return err(dispatchConflict(dispatch.dispatchKey));
        return ok({ dispatchId: existing.id, replayed: true });
      }
      try {
        db.prepare(
          `INSERT INTO provider_dispatches (dispatch_id, company_id, run_id, task_id, attempt_id,
             attempt_number, provider_key, dispatch_key, provider_session_id,
             provider_invocation_id, state, result_summary, config_fingerprint, routing_decision_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'DISPATCHED', NULL, ?, ?, ?, ?)`,
        ).run(
          dispatch.id,
          dispatch.companyId,
          dispatch.runId,
          dispatch.taskId,
          dispatch.attemptId,
          dispatch.attemptNumber,
          dispatch.providerKey,
          dispatch.dispatchKey,
          dispatch.configFingerprint,
          dispatch.routingDecisionJson,
          dispatch.createdAt,
          dispatch.updatedAt,
        );
        return ok({ dispatchId: dispatch.id, replayed: false });
      } catch (error) {
        const existingAfter = readByKey(dispatch.dispatchKey);
        if (existingAfter !== null) {
          if (existingAfter.id !== dispatch.id) return err(dispatchConflict(dispatch.dispatchKey));
          return ok({ dispatchId: existingAfter.id, replayed: true });
        }
        return err(
          domainError('PERSISTENCE_FAILED', `The provider dispatch could not be claimed: ${String(error)}`, {
            reason: 'PROVIDER_DISPATCH_CLAIM_FAILED',
          }),
        );
      }
    },
    async get(dispatchId) {
      const row = db
        .prepare('SELECT * FROM provider_dispatches WHERE dispatch_id = ?')
        .get(dispatchId) as DispatchRow | undefined;
      return row === undefined ? null : toDomain(row);
    },
    async byAttempt(attemptId) {
      const rows = db
        .prepare('SELECT * FROM provider_dispatches WHERE attempt_id = ? ORDER BY dispatch_key')
        .all(attemptId) as DispatchRow[];
      return rows.map(toDomain);
    },
    async publish(dispatchId, providerSessionId, now) {
      const result = db
        .prepare(
          `UPDATE provider_dispatches
             SET provider_session_id = ?, state = 'PUBLISHED', updated_at = ?
             WHERE dispatch_id = ?`,
        )
        .run(providerSessionId, now, dispatchId);
      if (result.changes === 0) {
        return err(
          domainError('NOT_FOUND', `Provider dispatch "${dispatchId}" does not exist.`, {
            reason: 'PROVIDER_DISPATCH_MISSING',
            dispatchId,
          }),
        );
      }
      return ok(true);
    },
    async recordInvocation(dispatchId, providerInvocationId, now) {
      const result = db
        .prepare(
          `UPDATE provider_dispatches SET provider_invocation_id = ?, updated_at = ?
             WHERE dispatch_id = ?`,
        )
        .run(providerInvocationId, now, dispatchId);
      if (result.changes === 0) {
        return err(
          domainError('NOT_FOUND', `Provider dispatch "${dispatchId}" does not exist.`, {
            reason: 'PROVIDER_DISPATCH_MISSING',
            dispatchId,
          }),
        );
      }
      return ok(true);
    },
    async settle(dispatchId, resultSummary, now) {
      const result = db
        .prepare(
          `UPDATE provider_dispatches SET state = 'SETTLED', result_summary = ?, updated_at = ?
             WHERE dispatch_id = ?`,
        )
        .run(resultSummary, now, dispatchId);
      if (result.changes === 0) {
        return err(
          domainError('NOT_FOUND', `Provider dispatch "${dispatchId}" does not exist.`, {
            reason: 'PROVIDER_DISPATCH_MISSING',
            dispatchId,
          }),
        );
      }
      return ok(true);
    },
    async markUncertain(dispatchId, reason, now) {
      const result = db
        .prepare(
          `UPDATE provider_dispatches SET state = 'UNCERTAIN', result_summary = ?, updated_at = ?
             WHERE dispatch_id = ?`,
        )
        .run(reason, now, dispatchId);
      if (result.changes === 0) {
        return err(
          domainError('NOT_FOUND', `Provider dispatch "${dispatchId}" does not exist.`, {
            reason: 'PROVIDER_DISPATCH_MISSING',
            dispatchId,
          }),
        );
      }
      return ok(true);
    },
    async recordConfigFingerprint(dispatchId, fingerprint, now) {
      const result = db
        .prepare(
          `UPDATE provider_dispatches SET config_fingerprint = ?, updated_at = ?
             WHERE dispatch_id = ? AND config_fingerprint IS NULL`,
        )
        .run(fingerprint, now, dispatchId);
      if (result.changes === 0) {
        // Either the binding is gone or a fingerprint is already recorded: both are
        // "nothing to do", never a reason to overwrite an existing provenance.
        const row = db
          .prepare('SELECT config_fingerprint FROM provider_dispatches WHERE dispatch_id = ?')
          .get(dispatchId) as { config_fingerprint: string | null } | undefined;
        if (row === undefined) {
          return err(
            domainError('NOT_FOUND', `Provider dispatch "${dispatchId}" does not exist.`, {
              reason: 'PROVIDER_DISPATCH_MISSING',
              dispatchId,
            }),
          );
        }
      }
      return ok(true);
    },
  };
};
