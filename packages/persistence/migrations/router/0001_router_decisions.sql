-- Sprint 10B: Router decision persistence.
--
-- Metadata + JSON detail only. Secrets, credentials, prompt text and context bodies are NEVER
-- stored here (see AGENTS.md §3 secrets rule and ADR-0014 §28).
CREATE TABLE IF NOT EXISTS router_decisions (
  decision_id               TEXT PRIMARY KEY,
  request_id                TEXT NOT NULL,
  task_id                   TEXT NOT NULL,
  role_id                   TEXT NOT NULL,
  selection_mode            TEXT NOT NULL CHECK (selection_mode IN ('MANUAL', 'AUTO', 'HYBRID')),
  selected_model_key        TEXT NULL,
  decision                  TEXT NOT NULL,
  reason_codes_json         TEXT NOT NULL,
  candidate_evaluations_json TEXT NOT NULL,
  rejected_candidates_json  TEXT NOT NULL,
  policy_snapshot_version   TEXT NOT NULL,
  model_registry_revision   TEXT NOT NULL,
  benchmark_version         TEXT NULL,
  performance_snapshot      TEXT NULL,
  router_version            TEXT NOT NULL,
  trace_id                  TEXT NOT NULL,
  created_at                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_router_decisions_created
  ON router_decisions (created_at DESC, decision_id DESC);

CREATE INDEX IF NOT EXISTS idx_router_decisions_request
  ON router_decisions (request_id);
