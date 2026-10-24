-- Task-20-03A corrective: canonical Task → Run ownership hardening.
--
-- tasks.run_id becomes NOT NULL with a canonical FK to runs(id) (no cascade: a durable Task
-- must never disappear through a casual parent delete). Ownership authority is run_id
-- equality; stage membership remains graph legality only.
--
-- LEGACY FAIL-CLOSED PRECONDITION (data-value independent): legacy rows carry NO
-- mechanically knowable run ownership — two Runs can pin the same WorkflowVersion/stage,
-- so stage_id, version membership, task ids, inputs, timestamps or "the only run"
-- heuristics can NEVER reconstruct it. The migration therefore aborts EXACTLY when the
-- legacy table still contains ANY row:
--
--   legacy task count = 0  → migration proceeds (nothing to lose)
--   legacy task count > 0  → RAISE(ABORT, 'TASK_RUN_OWNERSHIP_LEGACY_DATA_UNMIGRATABLE...')
--                           → the runner's transaction rolls back → old schema + rows intact
--
-- The abort depends ONLY on "does a legacy row exist" — never on any identifier VALUE. A
-- Run literally named like any sentinel string, or any adversarial id, cannot satisfy the
-- precondition; ownership is not inferred, no placeholder is assigned, nothing is deleted
-- and the database is never silently reset. (The earlier sentinel-mapping + FK-rejection
-- design was rejected as final architecture precisely because its failure depended on a
-- chosen id not existing.)
CREATE TABLE IF NOT EXISTS tasks_t2003a (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
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
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs (id)
);

-- The deterministic SQL-only migration precondition: any legacy row aborts the migration.
-- (RAISE works only inside triggers — this temporary guard is the repository-native way to
-- express "if EXISTS(SELECT 1 FROM tasks LIMIT 1) then abort" in pure SQL.)
CREATE TRIGGER t2003a_legacy_guard
BEFORE INSERT ON tasks_t2003a
WHEN EXISTS (SELECT 1 FROM tasks LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'TASK_RUN_OWNERSHIP_LEGACY_DATA_UNMIGRATABLE: legacy task rows exist and their canonical run ownership cannot be reconstructed; the database was preserved unchanged — manual reset or manual migration is required');
END;

-- On an empty legacy table this inserts zero rows (guard never fires); on a non-empty one
-- the FIRST row fires the guard and aborts. No ownership value is ever invented: the NULL
-- below is unreachable because any candidate row aborts first.
INSERT INTO tasks_t2003a (id, run_id, stage_id, role_id, kind, state, attempts, max_attempts,
                          inputs_json, outputs_json, created_at, updated_at)
SELECT id, NULL, stage_id, role_id, kind, state, attempts, max_attempts,
       inputs_json, outputs_json, created_at, updated_at
FROM tasks;

DROP TRIGGER t2003a_legacy_guard;
DROP TABLE tasks;
ALTER TABLE tasks_t2003a RENAME TO tasks;

-- Run-scoped task lookup (the production claim path). No uniqueness: whether multiple
-- legitimate tasks per stage/run may exist is deliberately NOT frozen here (T20-03B).
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks (run_id);
CREATE INDEX IF NOT EXISTS idx_tasks_stage_state ON tasks (stage_id, state);
