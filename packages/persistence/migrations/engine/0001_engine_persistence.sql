-- 0001_engine_persistence.sql — Sprint 3: durable engine state.
--
-- WHY A SEPARATE CHAIN: `0001_init.sql` (core schema) is checksum-frozen and already
-- applied; adding tables to a new file in *that* directory would change what the
-- Sprint 0/1/2 defaults load. This chain lives in `migrations/engine/` and shares the
-- same `schema_migrations` ledger (names are distinct), so both chains keep their
-- checksum protection and ordering guarantees (requirement 14).
--
-- Scope: exactly what the Workflow Engine needs to survive a restart
-- (WorkflowRun / Task / Approval / Event log / command ledger).

-- ---------------------------------------------------------------- runs --------
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  workflow_id     TEXT NOT NULL,
  template_id     TEXT NOT NULL,
  version_id      TEXT NOT NULL,
  snapshot_id     TEXT NOT NULL,
  -- L1 execution state (17 states, ADR-0003); CHECK keeps the DB honest.
  state           TEXT NOT NULL CHECK (state IN (
                    'IDLE','INITIALIZING','DESIGNING_WORKFLOW','WORKFLOW_REVIEW',
                    'WORKFLOW_PUBLISHED','PLANNING','ROUTING','WAITING_APPROVAL',
                    'EXECUTING','REVIEWING','VALIDATING','REWORK','FINALIZING',
                    'COMPLETED','FAILED','PAUSED','RECOVERING')),
  revision        INTEGER NOT NULL,
  rework_count    INTEGER NOT NULL,
  max_rework      INTEGER NOT NULL,
  failure_reason  TEXT NULL,
  resume_point    TEXT NULL CHECK (resume_point IS NULL OR resume_point IN (
                    'PLANNING','ROUTING','WAITING_APPROVAL','EXECUTING',
                    'REVIEWING','VALIDATING','REWORK','FINALIZING')),
  history_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_by      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_state ON runs (state);
CREATE INDEX IF NOT EXISTS idx_runs_resumable ON runs (state, resume_point)
  WHERE state IN ('PAUSED','RECOVERING');

-- --------------------------------------------------------------- tasks --------
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  stage_id      TEXT NOT NULL,
  role_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN (
                  'PENDING','READY','RUNNING','BLOCKED','DONE','FAILED','CANCELLED','SKIPPED')),
  attempts      INTEGER NOT NULL,
  max_attempts  INTEGER NOT NULL,
  inputs_json   TEXT NOT NULL,
  outputs_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_stage_state ON tasks (stage_id, state);

-- ----------------------------------------------------------- approvals --------
CREATE TABLE IF NOT EXISTS approvals (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  task_id        TEXT NULL,
  risk_level     TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status         TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  reason         TEXT NOT NULL,
  requested_by   TEXT NOT NULL,
  requested_at   TEXT NOT NULL,
  decided_by     TEXT NULL,
  decided_at     TEXT NULL,
  decision_note  TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_run_status ON approvals (run_id, status);

-- -------------------------------------------------------------- events --------
-- `0001_init.sql` already created `events` without a stable ordering column; this
-- chain adds it (append-only: no row is ever rewritten, positions only grow).
ALTER TABLE events ADD COLUMN global_position INTEGER;

UPDATE events SET global_position = rowid WHERE global_position IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_position ON events (global_position);
CREATE INDEX IF NOT EXISTS idx_events_aggregate_position
  ON events (aggregate_type, aggregate_id, global_position);
CREATE INDEX IF NOT EXISTS idx_events_type_position ON events (type, global_position);
-- Whole-execution audit: run-level AND task-level events of one run, in order.
CREATE INDEX IF NOT EXISTS idx_events_run_position ON events (run_id, global_position);

-- ------------------------------------------------------- command ledger -------
-- Durable idempotency: `command_id` is the key, `fingerprint` detects key reuse with
-- different content, `outcome_json` lets a replay return the original outcome.
CREATE TABLE IF NOT EXISTS command_ledger (
  command_id    TEXT PRIMARY KEY,
  fingerprint   TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  outcome_json  TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_recorded ON command_ledger (recorded_at, command_id);
