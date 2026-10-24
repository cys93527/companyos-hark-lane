/**
 * Durable stores for Model Selection Policy + Benchmark metadata (Sprint 7.5).
 */
import type {
  BenchmarkCategory,
  BenchmarkResult,
  EntityStore,
  ModelSelectionPolicy,
  Page,
  PageRequest,
} from '@companyos/core';

import type { Database } from '../db.js';

const json = (value: unknown): string => JSON.stringify(value ?? null);
const parseList = (value: string): readonly string[] => JSON.parse(value) as readonly string[];

interface PolicyRow {
  readonly id: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly mode: string;
  readonly manual_model_key: string | null;
  readonly allowed_models: string;
  readonly preferred_models: string;
  readonly blocked_models: string;
  readonly allowed_providers: string;
  readonly required_capabilities: string;
  readonly max_cost: number | null;
  readonly max_latency: number | null;
  readonly allow_fallback: string;
  readonly require_approval_override: number | bigint;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function createSqlitePolicyStore(db: Database): EntityStore<ModelSelectionPolicy> {
  const upsert = db.prepare(
    `INSERT INTO model_selection_policies (id, scope_type, scope_id, mode, manual_model_key, allowed_models,
       preferred_models, blocked_models, allowed_providers, required_capabilities, max_cost, max_latency,
       allow_fallback, require_approval_override, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mode = excluded.mode,
       manual_model_key = excluded.manual_model_key,
       allowed_models = excluded.allowed_models,
       preferred_models = excluded.preferred_models,
       blocked_models = excluded.blocked_models,
       allowed_providers = excluded.allowed_providers,
       required_capabilities = excluded.required_capabilities,
       max_cost = excluded.max_cost,
       max_latency = excluded.max_latency,
       allow_fallback = excluded.allow_fallback,
       require_approval_override = excluded.require_approval_override,
       updated_at = excluded.updated_at`,
  );

  const fromRow = (row: PolicyRow): ModelSelectionPolicy => ({
    id: row.id,
    scopeType: row.scope_type as ModelSelectionPolicy['scopeType'],
    scopeId: row.scope_id,
    mode: row.mode as ModelSelectionPolicy['mode'],
    manualModelKey: row.manual_model_key,
    allowedModels: parseList(row.allowed_models),
    preferredModels: parseList(row.preferred_models),
    blockedModels: parseList(row.blocked_models),
    allowedProviders: parseList(row.allowed_providers),
    requiredCapabilities: parseList(row.required_capabilities),
    maxCost: row.max_cost === null ? null : Number(row.max_cost),
    maxLatency: row.max_latency === null ? null : Number(row.max_latency),
    allowFallback: row.allow_fallback as ModelSelectionPolicy['allowFallback'],
    requireApprovalForOverride: Number(row.require_approval_override) === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    async get(id: string): Promise<ModelSelectionPolicy | null> {
      const row = db.prepare('SELECT * FROM model_selection_policies WHERE id = ?').get(id) as
        | PolicyRow
        | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: ModelSelectionPolicy): Promise<void> {
      upsert.run(
        entity.id,
        entity.scopeType,
        entity.scopeId,
        entity.mode,
        entity.manualModelKey,
        json(entity.allowedModels),
        json(entity.preferredModels),
        json(entity.blockedModels),
        json(entity.allowedProviders),
        json(entity.requiredCapabilities),
        entity.maxCost,
        entity.maxLatency,
        entity.allowFallback,
        entity.requireApprovalForOverride ? 1 : 0,
        entity.createdBy,
        entity.createdAt,
        entity.updatedAt,
      );
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM model_selection_policies WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<ModelSelectionPolicy>> {
      const limit = Math.min(Math.max(page.limit ?? 100, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM model_selection_policies ORDER BY scope_type ASC, scope_id ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as PolicyRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM model_selection_policies').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}

interface ResultRow {
  readonly id: string;
  readonly model_key: string;
  readonly suite_id: string;
  readonly case_id: string;
  readonly category: string;
  readonly score: number | null;
  readonly measured_value: number | null;
  readonly notes: string;
  readonly source: string;
  readonly recorded_at: string;
  readonly recorded_by: string;
}

export function createSqliteBenchmarkResultStore(db: Database): EntityStore<BenchmarkResult> {
  const upsert = db.prepare(
    `INSERT INTO benchmark_results (id, model_key, suite_id, case_id, category, score, measured_value, notes,
       source, recorded_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       score = excluded.score,
       measured_value = excluded.measured_value,
       notes = excluded.notes,
       source = excluded.source,
       recorded_at = excluded.recorded_at,
       recorded_by = excluded.recorded_by`,
  );

  const fromRow = (row: ResultRow): BenchmarkResult => ({
    id: row.id,
    modelKey: row.model_key,
    suiteId: row.suite_id,
    caseId: row.case_id,
    category: row.category as BenchmarkCategory,
    score: row.score === null ? null : Number(row.score),
    measuredValue: row.measured_value === null ? null : Number(row.measured_value),
    notes: row.notes,
    source: row.source as BenchmarkResult['source'],
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
  });

  return {
    async get(id: string): Promise<BenchmarkResult | null> {
      const row = db.prepare('SELECT * FROM benchmark_results WHERE id = ?').get(id) as ResultRow | undefined;
      return row === undefined ? null : fromRow(row);
    },
    async put(entity: BenchmarkResult): Promise<void> {
      upsert.run(
        entity.id,
        entity.modelKey,
        entity.suiteId,
        entity.caseId,
        entity.category,
        entity.score,
        entity.measuredValue,
        entity.notes,
        entity.source,
        entity.recordedAt,
        entity.recordedBy,
      );
    },
    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM benchmark_results WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },
    async list(page: PageRequest = {}): Promise<Page<BenchmarkResult>> {
      const limit = Math.min(Math.max(page.limit ?? 500, 0), 500);
      const offset = Math.max(page.offset ?? 0, 0);
      const rows = db
        .prepare('SELECT * FROM benchmark_results ORDER BY model_key ASC, category ASC LIMIT ? OFFSET ?')
        .all(limit, offset) as ResultRow[];
      const total = db.prepare('SELECT COUNT(*) AS total FROM benchmark_results').get() as {
        total: number | bigint;
      };
      return { items: rows.map(fromRow), total: Number(total.total), offset, limit };
    },
  };
}
