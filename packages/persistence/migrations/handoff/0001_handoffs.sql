-- Sprint 11: structured handoff persistence.
--
-- History is immutable at the STORAGE level: (handoff_id, version) is the primary key, and the
-- terminal states (ACCEPTED / REJECTED / SUPERSEDED / CANCELLED) may no longer be rewritten.
-- New work after a rejection becomes a NEW version, never an edit of the old one.
CREATE TABLE IF NOT EXISTS handoffs (
  handoff_id             TEXT NOT NULL,
  version                INTEGER NOT NULL,
  company_id             TEXT NOT NULL,
  workflow_id            TEXT NOT NULL,
  workflow_version_id    TEXT NOT NULL,
  workflow_run_id        TEXT NOT NULL,
  stage_id               TEXT NOT NULL,
  task_id                TEXT NOT NULL,
  from_agent_id          TEXT NOT NULL,
  from_role_id           TEXT NOT NULL,
  to_role_id             TEXT NOT NULL,
  to_agent_id            TEXT NULL,
  objective              TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('DRAFT', 'READY', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'CANCELLED')),
  summary                TEXT NOT NULL,
  completed_work_json    TEXT NOT NULL,
  remaining_work_json    TEXT NOT NULL,
  constraints_json       TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  known_risks_json       TEXT NOT NULL,
  open_questions_json    TEXT NOT NULL,
  recommended_next_action TEXT NOT NULL,
  model_key              TEXT NULL,
  provider_id            TEXT NULL,
  execution_ref          TEXT NULL,
  supersedes             TEXT NULL,
  accepted_by            TEXT NULL,
  accepted_at            TEXT NULL,
  rejected_by            TEXT NULL,
  rejected_at            TEXT NULL,
  rejection_reasons_json TEXT NOT NULL,
  rejection_comment      TEXT NULL,
  trace_id               TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (handoff_id, version)
);

-- Reference rows (artifact / decision / validation / execution) are part of the versioned packet.
CREATE TABLE IF NOT EXISTS handoff_refs (
  handoff_id  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('artifact', 'decision', 'validation', 'execution')),
  ref_id      TEXT NOT NULL,
  PRIMARY KEY (handoff_id, version, kind, ref_id),
  FOREIGN KEY (handoff_id, version) REFERENCES handoffs (handoff_id, version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_handoffs_target
  ON handoffs (to_role_id, version);

CREATE INDEX IF NOT EXISTS idx_handoffs_created
  ON handoffs (created_at DESC, handoff_id DESC, version DESC);
