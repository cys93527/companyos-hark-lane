-- 0005_invocation_version_provenance.sql — Sprint 13B corrective (ADR-0019).
--
-- Durable Tool Invocation Version Provenance: `tool_version` records the
-- ToolRecord.version an invocation was CREATED against — captured at invocation
-- creation (so WAITING_APPROVAL / FAILED / COMPLETED all know their target version),
-- never re-read from the registry on replay.
--
-- Nullable BY DESIGN (ADR-0019 §Legacy): pre-0005 historical rows have no trustworthy
-- version provenance — the current ToolRecord.version does NOT prove what actually
-- executed back then, so history stays NULL (UNKNOWN beats fabricated provenance) and
-- is NEVER backfilled.
--
-- No new table, no new chain: additive column on the existing `tools` chain table.

ALTER TABLE tool_invocations ADD COLUMN tool_version TEXT NULL;
