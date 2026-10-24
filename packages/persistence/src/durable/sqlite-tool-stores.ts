/**
 * Durable stores for the Tool Registry (Sprint 9 §十一).
 *
 * A restart must preserve tool contracts (including enabled/risk/authorities), the full
 * invocation history, its results and its errors.
 */
import type {
  EntityId,
  EntityStore,
  Page,
  PageRequest,
  ToolInvocation,
  ToolInvocationStatus,
  ToolRecord,
  ToolRiskLevel,
} from '@companyos/core';

import type { Database } from '../db.js';

const json = (value: unknown): string => JSON.stringify(value ?? null);

interface ToolRow {
  readonly id: string;
  readonly tool_id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly capabilities: string;
  readonly input_schema: string;
  readonly output_schema: string;
  readonly enabled: number | bigint;
  readonly risk_level: string;
  readonly required_authorities: string;
  readonly timeout_ms: number | bigint;
  readonly idempotency_mode: string;
  readonly audit_policy: string;
  readonly provider_kind: string;
  readonly adapter_ref: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function createSqliteToolRecordStore(db: Database): EntityStore<ToolRecord> {
  const upsert = db.prepare(
    `INSERT INTO tool_records (id, tool_id, name, description, version, capabilities, input_schema,
       output_schema, enabled, risk_level, required_authorities, timeout_ms, idempotency_mode,
       audit_policy, provider_kind, adapter_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       version = excluded.version,
       capabilities = excluded.capabilities,
       input_schema = excluded.input_schema,
       output_schema = excluded.output_schema,
       enabled = excluded.enabled,
       risk_level = excluded.risk_level,
       required_authorities = excluded.required_authorities,
       timeout_ms = excluded.timeout_ms,
       idempotency_mode = excluded.idempotency_mode,
       audit_policy = excluded.audit_policy,
       provider_kind = excluded.provider_kind,
       adapter_ref = excluded.adapter_ref,
       updated_at = excluded.updated_at`,
  );

  const fromRow = (row: ToolRow): ToolRecord => ({
    id: row.id,
    toolId: row.tool_id,
    name: row.name,
    description: row.description,
    version: row.version,
    capabilities: JSON.parse(row.capabilities) as readonly string[],
    inputSchema: JSON.parse(row.input_schema) as Readonly<Record<string, unknown>>,
    outputSchema: JSON.parse(row.output_schema) as Readonly<Record<string, unknown>>,
    enabled: Number(row.enabled) === 1,
    riskLevel: row.risk_level as ToolRiskLevel,
    requiredAuthorities: JSON.parse(row.required_authorities) as ToolRecord['requiredAuthorities'],
    timeoutMs: Number(row.timeout_ms),
    idempotencyMode: row.idempotency_mode as ToolRecord['idempotencyMode'],
    auditPolicy: row.audit_policy as ToolRecord['auditPolicy'],
    providerKind: row.provider_kind,
    adapterRef: row.adapter_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    async get(id: string): Promise<ToolRecord | null> {
      const row = db.prepare('SELECT * FROM tool_records WHERE id = ?').get(id) as ToolRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: ToolRecord): Promise<void> {
      upsert.run(
        entity.id,
        entity.toolId,
        entity.name,
        entity.description,
        entity.version,
        json(entity.capabilities),
        json(entity.inputSchema),
        json(entity.outputSchema),
        entity.enabled ? 1 : 0,
        entity.riskLevel,
        json(entity.requiredAuthorities),
        entity.timeoutMs,
        entity.idempotencyMode,
        entity.auditPolicy,
        entity.providerKind,
        entity.adapterRef,
        entity.createdAt,
        entity.updatedAt,
      );
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM tool_records WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<ToolRecord>> {
      const limit = Math.min(Math.max(page.limit ?? 200, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM tool_records ORDER BY tool_id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as ToolRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM tool_records').get() as { total: number | bigint };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}

interface InvocationRow {
  readonly id: string;
  readonly tool_id: string;
  readonly execution_id: string;
  readonly agent_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly actor_id: string;
  readonly trace_id: string;
  readonly status: string;
  readonly risk_level: string;
  readonly idempotency_mode: string;
  readonly idempotency_key: string | null;
  readonly input_digest: string;
  readonly input_payload: string;
  readonly input_keys: string;
  readonly parent_invocation_id: string | null;
  readonly root_invocation_id: string | null;
  readonly attempt_number: number | bigint | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly latency_ms: number | bigint | null;
  readonly output_digest: string | null;
  readonly replay_output_json: string | null;
  readonly tool_version: string | null;
  readonly approved_by: string | null;
  readonly approved_at: string | null;
  readonly error_code: string | null;
  readonly error_kind: string | null;
  readonly error_message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const toInvocation = (row: InvocationRow): ToolInvocation => ({
  id: row.id,
  toolId: row.tool_id,
  toolVersion: row.tool_version,
  executionId: row.execution_id,
  agentId: row.agent_id,
  taskId: row.task_id,
  runId: row.run_id,
  actorId: row.actor_id,
  traceId: row.trace_id,
  status: row.status as ToolInvocationStatus,
  riskLevel: row.risk_level as ToolRiskLevel,
  idempotencyMode: row.idempotency_mode as ToolInvocation['idempotencyMode'],
  idempotencyKey: row.idempotency_key,
  parentInvocationId: row.parent_invocation_id,
  // A pre-0003 row is its own first attempt.
  rootInvocationId: row.root_invocation_id ?? row.id,
  attemptNumber: row.attempt_number === null ? 1 : Number(row.attempt_number),
  inputDigest: row.input_digest,
  input: JSON.parse(row.input_payload) as Readonly<Record<string, unknown>>,
  inputKeys: JSON.parse(row.input_keys) as readonly string[],
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
  outputDigest: row.output_digest,
  // ADR-0018: null for FAILED rows and pre-0004 history (replay then fails closed).
  replayOutput: row.replay_output_json === null ? null : (JSON.parse(row.replay_output_json) as unknown),
  artifactRefs: [],
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  errorCode: row.error_code,
  errorKind: row.error_kind as ToolInvocation['errorKind'],
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createSqliteToolInvocationStore(db: Database): EntityStore<ToolInvocation> {
  const upsert = db.prepare(
    `INSERT INTO tool_invocations (id, tool_id, execution_id, agent_id, task_id, run_id, actor_id,
       trace_id, status, risk_level, idempotency_mode, idempotency_key, input_digest, input_payload,
       input_keys, parent_invocation_id, root_invocation_id, attempt_number, started_at, finished_at,
       latency_ms, output_digest, replay_output_json, tool_version, approved_by, approved_at, error_code, error_kind, error_message,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at,
       latency_ms = excluded.latency_ms,
       output_digest = excluded.output_digest,
       replay_output_json = excluded.replay_output_json,
       tool_version = excluded.tool_version,
       approved_by = excluded.approved_by,
       approved_at = excluded.approved_at,
       error_code = excluded.error_code,
       error_kind = excluded.error_kind,
       error_message = excluded.error_message,
       updated_at = excluded.updated_at`,
  );

  const artifactsFor = (invocationId: string): readonly string[] =>
    (
      db
        .prepare('SELECT artifact_ref FROM tool_invocation_artifacts WHERE invocation_id = ? ORDER BY artifact_ref ASC')
        .all(invocationId) as { artifact_ref: string }[]
    ).map((row) => row.artifact_ref);

  return {
    async get(id: string): Promise<ToolInvocation | null> {
      const row = db.prepare('SELECT * FROM tool_invocations WHERE id = ?').get(id) as InvocationRow | undefined;
      return row === undefined ? null : { ...toInvocation(row), artifactRefs: artifactsFor(id) };
    },
    async put(entity: ToolInvocation): Promise<void> {
      upsert.run(
        entity.id,
        entity.toolId,
        entity.executionId,
        entity.agentId,
        entity.taskId,
        entity.runId,
        entity.actorId,
        entity.traceId,
        entity.status,
        entity.riskLevel,
        entity.idempotencyMode,
        entity.idempotencyKey,
        entity.inputDigest,
        json(entity.input),
        json(entity.inputKeys),
        entity.parentInvocationId,
        entity.rootInvocationId,
        entity.attemptNumber,
        entity.startedAt,
        entity.finishedAt,
        entity.latencyMs,
        entity.outputDigest,
        entity.replayOutput === null || entity.replayOutput === undefined
          ? null
          : JSON.stringify(entity.replayOutput),
        entity.toolVersion,
        entity.approvedBy,
        entity.approvedAt,
        entity.errorCode,
        entity.errorKind,
        entity.errorMessage,
        entity.createdAt,
        entity.updatedAt,
      );
    },
    async delete(id: string): Promise<boolean> {
      db.prepare('DELETE FROM tool_invocation_artifacts WHERE invocation_id = ?').run(id);
      const result = db.prepare('DELETE FROM tool_invocations WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<ToolInvocation>> {
      const limit = Math.min(Math.max(page.limit ?? 200, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const direction = page.descending === true ? 'DESC' : 'ASC';
      // Explicit stable order (Sprint 9.1.2 §三): created_at is not unique under a fixed clock,
      // so `id` is the declared tie-break and paging can never duplicate or drop a row.
      const rows = db
        .prepare(`SELECT * FROM tool_invocations ORDER BY created_at ${direction}, id ${direction} LIMIT ? OFFSET ?`)
        .all(limit, offset) as InvocationRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM tool_invocations').get() as {
        total: number | bigint;
      };
      return {
        items: rows.map((row) => ({ ...toInvocation(row), artifactRefs: artifactsFor(row.id) })),
        total: Number(total.total),
        offset,
        limit,
      };
    },
  };
}

export interface ToolInvocationIndexStore {
  /** Exact lookup through the unique index — never an in-memory scan (Sprint 9.1 §二). */
  findByIdempotencyKey(key: string): Promise<ToolInvocation | null>;
}

export function createSqliteToolInvocationIndexStore(db: Database): ToolInvocationIndexStore {
  const query = db.prepare('SELECT * FROM tool_invocations WHERE idempotency_key = ? LIMIT 1');
  return {
    async findByIdempotencyKey(key: string): Promise<ToolInvocation | null> {
      const row = query.get(key) as InvocationRow | undefined;
      if (row === undefined) return null;
      const artifacts = (
        db
          .prepare('SELECT artifact_ref FROM tool_invocation_artifacts WHERE invocation_id = ? ORDER BY artifact_ref ASC')
          .all(row.id) as { artifact_ref: string }[]
      ).map((artifact) => artifact.artifact_ref);
      return { ...toInvocation(row), artifactRefs: artifacts };
    },
  };
}

export interface ToolInvocationClaimStore {
  claim(invocationId: string, now: string): Promise<boolean>;
}

/**
 * Atomic approval claim (Sprint 9 closeout HIGH-1).
 *
 * A conditional UPDATE is the compare-and-set: only the caller whose statement changes a row
 * wins. The claim moves a decided-but-unstarted invocation to STARTED exactly once, so two
 * concurrent approvals cannot both execute the tool.
 */
export function createSqliteToolInvocationClaimStore(db: Database): ToolInvocationClaimStore {
  const claim = db.prepare(
    `UPDATE tool_invocations
        SET status = 'STARTED', started_at = ?, updated_at = ?
      WHERE id = ?
        AND status = 'WAITING_APPROVAL'
        AND approved_by IS NOT NULL
        AND started_at IS NULL`,
  );
  return {
    async claim(invocationId: string, now: string): Promise<boolean> {
      const result = claim.run(now, now, invocationId);
      return Number(result.changes) === 1;
    },
  };
}

export interface ToolInvocationArtifactRecord extends EntityId {
  readonly id: string;
  readonly invocationId: string;
  readonly artifactRef: string;
  readonly label: string;
  readonly createdAt: string;
}

export function createSqliteToolInvocationArtifactStore(
  db: Database,
): EntityStore<ToolInvocationArtifactRecord> {
  const upsert = db.prepare(
    `INSERT INTO tool_invocation_artifacts (id, invocation_id, artifact_ref, label, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label
     ON CONFLICT(invocation_id, artifact_ref) DO NOTHING`,
  );
  const fromRow = (row: {
    readonly id: string;
    readonly invocation_id: string;
    readonly artifact_ref: string;
    readonly label: string;
    readonly created_at: string;
  }): ToolInvocationArtifactRecord => ({
    id: row.id,
    invocationId: row.invocation_id,
    artifactRef: row.artifact_ref,
    label: row.label,
    createdAt: row.created_at,
  });

  return {
    async get(id: string): Promise<ToolInvocationArtifactRecord | null> {
      const row = db.prepare('SELECT * FROM tool_invocation_artifacts WHERE id = ?').get(id) as
        | { id: string; invocation_id: string; artifact_ref: string; label: string; created_at: string }
        | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: ToolInvocationArtifactRecord): Promise<void> {
      upsert.run(entity.id, entity.invocationId, entity.artifactRef, entity.label, entity.createdAt);
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM tool_invocation_artifacts WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<ToolInvocationArtifactRecord>> {
      const limit = Math.min(Math.max(page.limit ?? 200, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM tool_invocation_artifacts ORDER BY invocation_id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as {
        id: string;
        invocation_id: string;
        artifact_ref: string;
        label: string;
        created_at: string;
      }[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM tool_invocation_artifacts').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}
