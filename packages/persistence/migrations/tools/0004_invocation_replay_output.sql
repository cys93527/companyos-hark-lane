-- 0004_invocation_replay_output.sql — Sprint 13B corrective (ADR-0018).
--
-- Durable Tool Invocation Replay Output: `replay_output_json` stores a verified-lossless
-- JSON snapshot of a SUCCESSFUL tool output, written in the SAME terminal update as the
-- COMPLETED status and output_digest (no separate commit window). On an idempotent
-- replay the registry restores this snapshot after verifying it against output_digest.
--
-- Nullable BY DESIGN: FAILED rows and pre-migration historical rows have no snapshot —
-- replaying those fails closed (TOOL_REPLAY_OUTPUT_UNAVAILABLE) instead of pretending
-- `output: null` is a valid successful result.
--
-- No new table, no new chain: additive column on the existing `tools` chain table.

ALTER TABLE tool_invocations ADD COLUMN replay_output_json TEXT NULL;
