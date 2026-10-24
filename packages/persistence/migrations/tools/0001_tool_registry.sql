-- 0001_tool_registry.sql — Sprint 9: Tool Registry.
--
-- Eighth checksum-protected chain (ADR-0006/0013). Three tables: the curated tool contract,
-- one row per bounded invocation, and the artifact references an invocation produced.
--
-- Nothing here chooses a tool: `tool_id` is recorded, never derived. No router column, no
-- plan/step column, and no column that could hold a credential or a raw secret.

CREATE TABLE IF NOT EXISTS tool_records (
  id                   TEXT PRIMARY KEY,
  tool_id              TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL,
  version              TEXT NOT NULL,
  capabilities         TEXT NOT NULL,
  input_schema         TEXT NOT NULL,
  output_schema        TEXT NOT NULL,
  enabled              INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  risk_level           TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  required_authorities TEXT NOT NULL,
  timeout_ms           INTEGER NOT NULL CHECK (timeout_ms > 0),
  idempotency_mode     TEXT NOT NULL CHECK (idempotency_mode IN ('NONE','COMMAND_ID','IDEMPOTENT_KEY')),
  audit_policy         TEXT NOT NULL CHECK (audit_policy IN ('STANDARD','STRICT')),
  provider_kind        TEXT NOT NULL,
  adapter_ref          TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (tool_id)
);

CREATE INDEX IF NOT EXISTS idx_tool_records_enabled ON tool_records (enabled, risk_level);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id              TEXT PRIMARY KEY,
  tool_id         TEXT NOT NULL,
  execution_id    TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  trace_id        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('REQUESTED','WAITING_APPROVAL','STARTED','COMPLETED','FAILED','CANCELLED')),
  risk_level      TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  idempotency_mode TEXT NOT NULL CHECK (idempotency_mode IN ('NONE','COMMAND_ID','IDEMPOTENT_KEY')),
  idempotency_key TEXT NULL,
  input_digest    TEXT NOT NULL,
  input_payload   TEXT NOT NULL,
  input_keys      TEXT NOT NULL,
  started_at      TEXT NULL,
  finished_at     TEXT NULL,
  latency_ms      INTEGER NULL,
  output_digest   TEXT NULL,
  approved_by     TEXT NULL,
  approved_at     TEXT NULL,
  error_code      TEXT NULL,
  error_kind      TEXT NULL,
  error_message   TEXT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_execution ON tool_invocations (execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_tool ON tool_invocations (tool_id, created_at DESC);
-- Replay protection at the DATABASE level: one row per idempotency key (§七).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_invocations_idempotency
  ON tool_invocations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS tool_invocation_artifacts (
  id            TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  artifact_ref  TEXT NOT NULL,
  label         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (invocation_id, artifact_ref)
);

CREATE INDEX IF NOT EXISTS idx_tool_invocation_artifacts_invocation
  ON tool_invocation_artifacts (invocation_id);
