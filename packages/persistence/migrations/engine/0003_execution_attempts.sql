-- Sprint 21 (final): the GENERIC execution-attempt owner — durable active/orphan
-- execution-claim arbitration for every Pack task execution.
--
-- One canonical row per (task_id, attempt_number), forever: the PRIMARY KEY (the
-- deterministic exa_ id) and the UNIQUE(task_id, attempt_number) index are the final
-- arbiters — a second supervisor inserting the same attempt loses at the DB, never in
-- memory. No model fields: model/LLM provenance stays in agent_executions (its owner).
CREATE TABLE IF NOT EXISTS execution_attempts (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL,
  run_id              TEXT NOT NULL REFERENCES runs(id),
  task_id             TEXT NOT NULL,
  attempt_number      INTEGER NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('ACTIVE','INTERRUPTED','COMPLETED','FAILED')),
  role_id             TEXT NOT NULL,
  task_kind           TEXT NOT NULL,
  seed_fingerprint    TEXT NOT NULL,
  runtime_instance_id TEXT,
  created_at          TEXT NOT NULL,
  settled_at          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_attempts_task_attempt
  ON execution_attempts (task_id, attempt_number);

CREATE INDEX IF NOT EXISTS idx_execution_attempts_active
  ON execution_attempts (state) WHERE state = 'ACTIVE';
