-- 0002_tool_invocation_recovery.sql — Sprint 9.1 §一.
--
-- The status CHECK gains INTERRUPTED: the verdict for an invocation whose process died while
-- it was in flight. 0001 is already released, so it must not be edited (ADR-0006) - the
-- column constraint is widened by the standard SQLite table-rebuild dance instead.
--
-- NOTHING here approves or re-executes anything: WAITING_APPROVAL rows stay waiting, and a
-- STARTED row is only ever moved to INTERRUPTED by the engine's explicit recovery pass.

CREATE TABLE tool_invocations_rebuilt (
  id              TEXT PRIMARY KEY,
  tool_id         TEXT NOT NULL,
  execution_id    TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  trace_id        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('REQUESTED','WAITING_APPROVAL','STARTED','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
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

INSERT INTO tool_invocations_rebuilt SELECT * FROM tool_invocations;

DROP TABLE tool_invocations;

ALTER TABLE tool_invocations_rebuilt RENAME TO tool_invocations;

CREATE INDEX IF NOT EXISTS idx_tool_invocations_execution ON tool_invocations (execution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_tool ON tool_invocations (tool_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_status ON tool_invocations (status, created_at DESC);
-- Replay protection + exact idempotency lookup both ride this unique index (§二).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_invocations_idempotency
  ON tool_invocations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
