-- 0001_model_selection.sql — Sprint 7.5: Model Selection Policy + Benchmark metadata.
--
-- Sixth checksum-protected chain (ADR-0006/0011). Policies are RULES about choosing a
-- model; benchmark rows are DISPLAY metadata. Neither table has a routing column: there is
-- no score used for selection, no priority order, no fallback chain stored here.

CREATE TABLE IF NOT EXISTS model_selection_policies (
  id                         TEXT PRIMARY KEY,
  scope_type                 TEXT NOT NULL CHECK (scope_type IN ('COMPANY','WORKFLOW','ROLE','TASK')),
  scope_id                   TEXT NOT NULL,
  mode                       TEXT NOT NULL CHECK (mode IN ('MANUAL','AUTO','HYBRID')),
  manual_model_key           TEXT NULL,
  allowed_models             TEXT NOT NULL,
  preferred_models           TEXT NOT NULL,
  blocked_models             TEXT NOT NULL,
  allowed_providers          TEXT NOT NULL,
  required_capabilities      TEXT NOT NULL,
  max_cost                   REAL NULL,
  max_latency                REAL NULL,
  allow_fallback             TEXT NOT NULL CHECK (allow_fallback IN ('NEVER','ASK','AUTO_WITHIN_POLICY')),
  require_approval_override  INTEGER NOT NULL CHECK (require_approval_override IN (0, 1)),
  created_by                 TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  -- One policy per (scope type, scope id): a scope either has a rule or it does not.
  UNIQUE (scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_policies_scope ON model_selection_policies (scope_type, scope_id);

-- Model Performance Metadata. `score` is 0..1 or NULL (e.g. a latency sample), and it is
-- NEVER read by a selection path (ADR-0011).
CREATE TABLE IF NOT EXISTS benchmark_results (
  id             TEXT PRIMARY KEY,
  model_key      TEXT NOT NULL,
  suite_id       TEXT NOT NULL,
  case_id        TEXT NOT NULL,
  category       TEXT NOT NULL,
  score          REAL NULL CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  measured_value REAL NULL,
  notes          TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('harness','external')),
  recorded_at    TEXT NOT NULL,
  recorded_by    TEXT NOT NULL,
  UNIQUE (model_key, suite_id, case_id)
);

CREATE INDEX IF NOT EXISTS idx_benchmark_model_category ON benchmark_results (model_key, category);
