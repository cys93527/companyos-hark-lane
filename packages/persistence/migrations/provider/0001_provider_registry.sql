-- 0001_provider_registry.sql — Sprint 6: providers, roles, assignments, secret refs.
--
-- Fourth checksum-protected chain (ADR-0006/0009). Kept separate so the frozen core,
-- engine and lifecycle chains keep their exact contents and versions.
--
-- SECRETS: this file deliberately has NO column able to hold a key value. Only a
-- `secret_refs` row (which secret is needed, from which source) is persisted; the value
-- lives in the OS keychain / environment and is resolved at call time in memory.

-- ---------------------------------------------------------------- roles -------
CREATE TABLE IF NOT EXISTS roles (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL,
  key                   TEXT NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL,
  required_capabilities TEXT NOT NULL,
  -- JSON array of authority strings; validated against the closed AUTHORITIES set.
  authority_json        TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (company_id, key)
);

CREATE TABLE IF NOT EXISTS role_assignments (
  actor_id    TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  PRIMARY KEY (actor_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_assignments_actor ON role_assignments (actor_id);

-- ------------------------------------------------------------ providers -------
CREATE TABLE IF NOT EXISTS providers (
  provider_id   TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  -- Last health report as JSON (status/checkedAt/latencyMs/detail); never model output.
  last_health   TEXT NULL,
  registered_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Model catalogue snapshot per provider: lets the UI show models without a live call.
CREATE TABLE IF NOT EXISTS provider_models (
  provider_id     TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  context_window  INTEGER NOT NULL,
  max_output      INTEGER NULL,
  capabilities    TEXT NOT NULL,
  pricing         TEXT NULL,
  metadata        TEXT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);

-- ---------------------------------------------------------- secret refs -------
-- A pointer, never a value: `source` names where the secret comes from (env/keychain).
CREATE TABLE IF NOT EXISTS secret_refs (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('env', 'os_keychain', 'external_vault')),
  env_name    TEXT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (provider_id, purpose)
);
