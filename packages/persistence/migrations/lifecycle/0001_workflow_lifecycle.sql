-- 0001_workflow_lifecycle.sql — Sprint 4: Workflow as a governed SOP asset.
--
-- Third checksum-protected chain (see ADR-0006/0007): the engine chain owns execution
-- durability, this one owns template governance. Names are distinct in the shared
-- `schema_migrations` ledger, so both chains keep their own versions and checksums.

-- ---------------------------------------------------------- templates --------
CREATE TABLE IF NOT EXISTS workflow_templates (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  name               TEXT NOT NULL,
  -- L2 lifecycle (4 states, ADR-0003). Never mixed with the 17 L1 run states.
  state              TEXT NOT NULL CHECK (state IN ('draft','published','deprecated','archived')),
  current_version_id TEXT NULL,
  -- The working draft is a real version row (`1.0.0-draft`), so "draft is editable" and
  -- "released is immutable" are the SAME rule, enforced in one place.
  draft_version_id   TEXT NULL,
  forked_from_json   TEXT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  created_by         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_state ON workflow_templates (state);

-- ----------------------------------------------------------- versions --------
CREATE TABLE IF NOT EXISTS workflow_template_versions (
  id                 TEXT PRIMARY KEY,
  template_id        TEXT NOT NULL,
  semver             TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  snapshot_hash      TEXT NOT NULL,
  graph_json         TEXT NOT NULL,
  change_proposal_id TEXT NULL,
  created_at         TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  -- Requirement 8: a row exists to be read, never rewritten. Kept as a CHECK so even a
  -- hand-written UPDATE cannot flip the flag.
  immutable          INTEGER NOT NULL DEFAULT 1 CHECK (immutable = 1),
  -- Requirement M: one version number per template, enforced by the database.
  UNIQUE (template_id, semver)
);

CREATE INDEX IF NOT EXISTS idx_versions_template ON workflow_template_versions (template_id, created_at);

-- -------------------------------------------------------------- locks --------
CREATE TABLE IF NOT EXISTS workflow_template_locks (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  version_id  TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('run','global')),
  reason      TEXT NOT NULL,
  locked_by   TEXT NOT NULL,
  locked_at   TEXT NOT NULL,
  released_at TEXT NULL,
  released_by TEXT NULL
);

-- Requirement 14: at most ONE active lock per template, enforced by a partial unique
-- index — a concurrent double publish cannot both acquire the lock, even across
-- processes (the loser gets a UNIQUE violation, not a lost update).
CREATE UNIQUE INDEX IF NOT EXISTS idx_locks_one_active
  ON workflow_template_locks (template_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_locks_template ON workflow_template_locks (template_id, locked_at);

-- ---------------------------------------------------- change proposals -------
CREATE TABLE IF NOT EXISTS workflow_change_requests (
  id                 TEXT PRIMARY KEY,
  target_template_id TEXT NOT NULL,
  base_version_id    TEXT NOT NULL,
  rationale          TEXT NOT NULL,
  ops_json           TEXT NOT NULL,
  author_id          TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open','accepted','rejected','superseded')),
  created_at         TEXT NOT NULL,
  decided_by         TEXT NULL,
  decided_at         TEXT NULL,
  decision_note      TEXT NULL
);

-- At most one OPEN proposal per (template, base version): the next revision must be
-- based on a fresh, decided proposal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_one_open
  ON workflow_change_requests (target_template_id, base_version_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_proposals_template ON workflow_change_requests (target_template_id, created_at);

-- -------------------------------------------------------- run snapshots ------
-- Requirement 10/11: a run pins an immutable snapshot of the version it executes, so a
-- later template upgrade can never change what a historical run did.
CREATE TABLE IF NOT EXISTS run_snapshots (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  org_id              TEXT NOT NULL,
  template_id         TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  template_lock_id    TEXT NOT NULL,
  pack_versions_json  TEXT NOT NULL,
  model_bindings_json TEXT NOT NULL,
  memory_view_ref     TEXT NOT NULL,
  snapshot_hash       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_run ON run_snapshots (run_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_version ON run_snapshots (workflow_version_id);
