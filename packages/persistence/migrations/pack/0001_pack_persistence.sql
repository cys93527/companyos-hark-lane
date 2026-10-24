-- 0001_pack_persistence.sql — Sprint 15 (ADR-0024/0025/0027): Industry Pack durable layer.
--
-- Scope: the three tables owned by the opt-in `pack` chain (Task-15-03):
--   pack_versions      — immutable (packId, packVersion) canonical manifests
--   pack_installations — company-scoped lifecycle bindings (installed/disabled)
--   pack_content_refs  — provenance mapping PackVersion→materialized entity per installation
--
-- Three DIFFERENT truths in three tables (Task-15-03 §2); none is a delete/GC surface.
--
-- Immutability: pack_versions and pack_content_refs are INSERT-only in the adapters
-- (same convention as the artifact/validation chain). pack_installations is the ONE
-- mutable row (ADR-0025: a mutable lifecycle binding), restricted to installed/disabled.
--
-- Permanent creation identity (Sprint 13 Option B pattern): installation rows carry
-- creation_command_id + creation_command_fingerprint so the installation identity
-- survives the bounded command ledger; the durable UNIQUE(creation_command_id) is the
-- idempotency guarantee (not an application pre-check).
--
-- No foreign keys — following every existing opt-in chain (ADR-0015 D9: run/task/
-- chain references are validated at the service/store layer, never by cross-chain FK).
-- PackVersion existence is validated inside the install transaction (fail closed).

CREATE TABLE IF NOT EXISTS pack_versions (
  pack_id                 TEXT NOT NULL,
  pack_version            TEXT NOT NULL,
  canonical_manifest_json TEXT NOT NULL,
  -- Qualified SHA-256 ref, never bare hex (TASK-15-02 corrective; length 7 + 64 hex).
  manifest_fingerprint    TEXT NOT NULL CHECK (length(manifest_fingerprint) = 71 AND manifest_fingerprint GLOB 'sha256:*'),
  created_at              TEXT NOT NULL,
  PRIMARY KEY (pack_id, pack_version)
);

CREATE TABLE IF NOT EXISTS pack_installations (
  installation_id            TEXT PRIMARY KEY,
  company_id                 TEXT NOT NULL,
  pack_id                    TEXT NOT NULL,
  pack_version               TEXT NOT NULL,
  pack_name                  TEXT NOT NULL,
  core_api                   TEXT NOT NULL,
  -- Closed set (ADR-0025 §17): pending/failed/activating/uninstalled never exist.
  status                     TEXT NOT NULL CHECK (status IN ('installed', 'disabled')),
  capabilities_json          TEXT NOT NULL,
  installed_by               TEXT NOT NULL,
  installed_at               TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  creation_command_id        TEXT NOT NULL,
  creation_command_fingerprint TEXT NOT NULL
);

-- One installation per (companyId, packId, packVersion) — no duplicate rows ever.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_installations_identity
  ON pack_installations (company_id, pack_id, pack_version);
-- One enabled version per (companyId, packId): the race-safe one-active-version
-- invariant (partial unique index; disabled historical versions may coexist).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_installations_one_enabled
  ON pack_installations (company_id, pack_id) WHERE status = 'installed';

CREATE TABLE IF NOT EXISTS pack_content_refs (
  installation_id       TEXT NOT NULL,
  -- Closed union of the nine canonical declaration categories (Task-15-02).
  content_kind          TEXT NOT NULL CHECK (content_kind IN (
    'role', 'workflowTemplate', 'prompt', 'tool', 'validator', 'artifactType', 'riskRule', 'capabilityRule', 'template'
  )),
  logical_key           TEXT NOT NULL,
  -- NULLABLE (TASK-15-02 Boss ruling): pack-native declarations (prompt / riskRule /
  -- capabilityRule / template) have no separate materialized entity; never fake a ref.
  materialized_entity_ref TEXT,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (installation_id, content_kind, logical_key)
);
