-- Sprint 19 / Task-19-02: the durable Session kernel schema.
--
-- Two tables, one migration, append-only entries, no session state machine (Boss ruling
-- T19-02 §5). Rollback/non-destructive behavior: this migration only CREATEs new tables and
-- indexes; it touches no existing table, so re-running it is a no-op (IF NOT EXISTS) and
-- dropping the `session` chain leaves every earlier schema untouched.
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT NOT NULL PRIMARY KEY,
  company_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role_key TEXT NOT NULL,
  parent_session_id TEXT,
  created_at TEXT NOT NULL,
  -- §6: one session per immutable scope. Database-level, not just application-level.
  UNIQUE(company_id, run_id, task_id, role_key)
);
CREATE INDEX IF NOT EXISTS idx_sessions_run
  ON sessions(company_id, run_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent
  ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS session_entries (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  entry_kind TEXT NOT NULL,
  text TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  execution_id TEXT,
  input_token_estimate INTEGER NOT NULL,
  output_token_count INTEGER,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- §6: per-session monotonic ordering is UNIQUE at the database level, and the permanent
  -- command identity is UNIQUE so a replay can never append a second copy (§17).
  PRIMARY KEY(session_id, sequence),
  UNIQUE(session_id, command_id)
);
CREATE INDEX IF NOT EXISTS idx_session_entries_kind
  ON session_entries(session_id, entry_kind, sequence);
