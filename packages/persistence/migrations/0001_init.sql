-- 0001_init.sql — Sprint 0 minimal schema.
--
-- Scope (planning-document §五十六). Sprint 0 creates only what the foundation
-- needs to prove: the migration ledger, a generic entity store, a settings bag
-- and the append-only event log (the audit substrate of §四十三 / §四十四).
-- Domain tables (workflow_templates, workflow_template_versions, workflow_runs,
-- workflow_stage_definitions, workflow_role_bindings, workflow_tool_bindings,
-- workflow_validators, workflow_risk_rules, workflow_change_requests,
-- workflow_performance_metrics, tasks, roles, agents, providers, models,
-- capabilities, tools, handoffs, memories, decisions, artifacts, validations,
-- events, approvals, cost_records, settings, companies, industry_packs) are
-- added per bounded context from Sprint 1 onwards.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- Generic JSON-document entity store, namespaced by `kind`.
-- The primary key is composite: two bounded contexts may legitimately use the
-- same id string, and one must never overwrite the other.
CREATE TABLE IF NOT EXISTS entities (
  id         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  doc        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS idx_entities_kind_created ON entities (kind, created_at, id);
CREATE INDEX IF NOT EXISTS idx_entities_kind_updated ON entities (kind, updated_at, id);

-- Settings bag (non-secret configuration only; secrets live in the OS keychain).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Append-only event log: who did what, when, with which model, at what cost.
CREATE TABLE IF NOT EXISTS events (
  event_id       TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  occurred_at    TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  trace_id       TEXT NOT NULL,
  run_id         TEXT,
  org_id         TEXT,
  payload        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_trace ON events (trace_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events (aggregate_type, aggregate_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type, occurred_at);
