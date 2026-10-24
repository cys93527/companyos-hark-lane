-- 0002_validation_target_ref.sql — Sprint 13A reconciliation (ADR-0017).
--
-- Adds the durable target binding to `validations`: `target_ref` is the EXACT artifact
-- under validation ("artifact:art_<ulid>", structure-validated in Core, existence
-- checked by the future ValidationService). It is deliberately SEPARATE from
-- `evidence_refs_json` (target ≠ evidence) and deliberately NULLABLE so legacy Sprint 1
-- records (created before Sprint 13) stay reconstructible — but an untargeted
-- validation can never serve as targeted quality-gate evidence (ADR-0017).
--
-- No cross-chain FK (ADR-0015 D9): existence is validated at the service layer.
-- The batch uniqueness stays (creation_command_id, validator_id) — one command targets
-- exactly one artifact (ADR-0017 cardinality), so adding target_ref to the key would
-- wrongly allow same-command/different-target rows.

ALTER TABLE validations ADD COLUMN target_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_validations_target
  ON validations (target_ref, created_at DESC, validation_id);
