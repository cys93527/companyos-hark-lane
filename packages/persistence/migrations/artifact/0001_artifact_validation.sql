-- 0001_artifact_validation.sql — Sprint 13 (ADR-0015 / ADR-0016): durable evidence layer.
--
-- Scope: the two Sprint 13 tables owned by the opt-in `artifact` chain:
--   artifacts    — immutable run outputs (Sprint 1 domain contract, 1:1 persistence)
--   validations  — validator evidence records (Sprint 1 domain contract, 1:1 persistence)
--
-- Immutability (ADR-0015 D1): INSERT-only tables. There is no UPDATE/DELETE path in the
-- adapters, no version/revision columns, no supersession — a "correction" is a new row.
--
-- Permanent creation idempotency (Option B): `creation_command_id` +
-- `creation_command_fingerprint` are persistence metadata (NOT domain fields) that let
-- the application services recover the original result identity even after the bounded
-- command ledger trimmed the command. The CHECK enforces the pair is all-NULL or
-- all-present; the partial unique indexes enforce the cardinality frozen in the ADRs:
--   artifacts:    one commandId → exactly one artifact
--   validations:  one commandId → one row per validator (a batch is N rows)
--
-- No cross-chain foreign keys (ADR-0015 D9): run_id / task_id reference other chains'
-- resources; existence is validated at the service layer, following every existing
-- opt-in chain (handoff, memory, agent, tools).

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id                  TEXT PRIMARY KEY,
  run_id                       TEXT NOT NULL,
  task_id                      TEXT,
  kind                         TEXT NOT NULL,
  content_ref                  TEXT NOT NULL,
  content_hash                 TEXT NOT NULL CHECK (length(content_hash) = 64),
  size_bytes                   INTEGER NOT NULL CHECK (size_bytes >= 0),
  produced_by                  TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  creation_command_id          TEXT,
  creation_command_fingerprint TEXT,
  CHECK (
    (creation_command_id IS NULL AND creation_command_fingerprint IS NULL)
    OR (creation_command_id IS NOT NULL AND creation_command_fingerprint IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts (content_hash);
-- One CreateArtifact commandId → exactly one Artifact identity (ADR-0015 decision 15).
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_creation_command
  ON artifacts (creation_command_id) WHERE creation_command_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS validations (
  validation_id                TEXT PRIMARY KEY,
  run_id                       TEXT NOT NULL,
  stage_id                     TEXT,
  task_id                      TEXT,
  validator_id                 TEXT NOT NULL,
  validator_version            TEXT NOT NULL,
  status                       TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'error', 'skipped')),
  command                      TEXT,
  exit_code                    INTEGER,
  blocking                     INTEGER NOT NULL DEFAULT 1 CHECK (blocking IN (0, 1)),
  evidence_refs_json           TEXT NOT NULL,
  started_at                   TEXT NOT NULL,
  finished_at                  TEXT,
  created_at                   TEXT NOT NULL,
  creation_command_id          TEXT,
  creation_command_fingerprint TEXT,
  CHECK (
    (creation_command_id IS NULL AND creation_command_fingerprint IS NULL)
    OR (creation_command_id IS NOT NULL AND creation_command_fingerprint IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_validations_run ON validations (run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validations_validator ON validations (run_id, validator_id);
-- One RunValidation commandId → one row per validator (a batch is N rows); intentional
-- re-validation uses a NEW commandId, so it is never blocked (ADR-0016 decision 13).
CREATE UNIQUE INDEX IF NOT EXISTS idx_validations_creation_command
  ON validations (creation_command_id, validator_id) WHERE creation_command_id IS NOT NULL;
