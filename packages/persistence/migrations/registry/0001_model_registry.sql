-- 0001_model_registry.sql — Sprint 7: CompanyOS-owned model registry.
--
-- Fifth checksum-protected chain (ADR-0006/0010): provider (Sprint 6) keeps the raw
-- catalogue + secrets + roles; this chain owns the CURATED layer the user sees: a stable
-- model key, an owner-facing description, an enable flag, and logical aliases.
--
-- No routing table, no score column, no fallback order: a registry is a catalogue, not a
-- router (ADR-0010). Ordering only exists for display.

CREATE TABLE IF NOT EXISTS model_records (
  id               TEXT PRIMARY KEY,
  -- Stable, provider-independent key (lower-case; see MODEL_KEY_PATTERN).
  model_key        TEXT NOT NULL,
  provider_id      TEXT NOT NULL,
  -- The adapter's own model id; kept so a provider can be rebound without re-registering.
  provider_model_id TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  description      TEXT NOT NULL,
  capabilities     TEXT NOT NULL,
  context_window   INTEGER NOT NULL CHECK (context_window > 0),
  max_output       INTEGER NULL,
  pricing          TEXT NULL,
  enabled          INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  availability     TEXT NOT NULL CHECK (availability IN ('available','degraded','unavailable','disabled')),
  metadata         TEXT NULL,
  registered_at    TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  registered_by    TEXT NOT NULL,
  UNIQUE (model_key),
  UNIQUE (provider_id, provider_model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_records_provider ON model_records (provider_id, model_key);
CREATE INDEX IF NOT EXISTS idx_model_records_availability ON model_records (availability);

-- One alias resolves to exactly ONE model key, inside one scope ('*' = every workspace).
CREATE TABLE IF NOT EXISTS logical_aliases (
  id         TEXT PRIMARY KEY,
  alias      TEXT NOT NULL,
  model_key  TEXT NOT NULL,
  scope      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (scope, alias)
);

CREATE INDEX IF NOT EXISTS idx_aliases_model ON logical_aliases (model_key);
