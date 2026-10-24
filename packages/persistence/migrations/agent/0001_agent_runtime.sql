-- 0001_agent_runtime.sql — Sprint 8: Agent Execution Runtime.
--
-- Seventh checksum-protected chain (ADR-0006/0012). ONE table per concern:
--   agent_executions           — one attempt by one agent on one task with one explicit model
--   agent_execution_artifacts  — references produced by that execution
--
-- Nothing here selects a model: `model_key` is recorded, never derived. No secret value may
-- be stored (credentials live behind SecretRef only), and no routing column exists.

CREATE TABLE IF NOT EXISTS agent_executions (
  execution_id      TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  role_id           TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  -- The model binding, recorded exactly as the caller supplied it.
  model_key         TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  provider_model_id TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('CREATED','READY','RUNNING','WAITING_EXTERNAL','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  started_at        TEXT NULL,
  finished_at       TEXT NULL,
  trace_id          TEXT NOT NULL,
  attempt           INTEGER NOT NULL CHECK (attempt >= 1),
  input_usage       TEXT NOT NULL,
  output_usage      TEXT NOT NULL,
  latency_ms        INTEGER NULL,
  result_ref        TEXT NULL,
  error_code        TEXT NULL,
  error_kind        TEXT NULL,
  error_message     TEXT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_executions_task ON agent_executions (task_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_executions_run ON agent_executions (run_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_executions_role ON agent_executions (role_id, updated_at DESC);
-- Recovery is a query, not a guess: find executions that were in flight.
CREATE INDEX IF NOT EXISTS idx_agent_executions_open ON agent_executions (status)
  WHERE status IN ('RUNNING','WAITING_EXTERNAL');

CREATE TABLE IF NOT EXISTS agent_execution_artifacts (
  id            TEXT PRIMARY KEY,
  execution_id  TEXT NOT NULL,
  artifact_ref  TEXT NOT NULL,
  label         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (execution_id, artifact_ref)
);

CREATE INDEX IF NOT EXISTS idx_execution_artifacts_execution ON agent_execution_artifacts (execution_id);
