-- 0003_tool_invocation_attempts.sql — Sprint 9.1.2 §一/§三.
--
-- Adds the attempt chain (parent / root / monotonic attempt number) and the indexes that make
-- chain queries and pagination explicit. Columns are added (no table rebuild), so 0001/0002
-- keep their checksums. Existing rows are backfilled as "first attempt of their own chain".

ALTER TABLE tool_invocations ADD COLUMN parent_invocation_id TEXT NULL;
ALTER TABLE tool_invocations ADD COLUMN root_invocation_id TEXT NULL;
ALTER TABLE tool_invocations ADD COLUMN attempt_number INTEGER NULL;

UPDATE tool_invocations SET root_invocation_id = id WHERE root_invocation_id IS NULL;
UPDATE tool_invocations SET attempt_number = 1 WHERE attempt_number IS NULL;

-- Whole-chain queries (attempt history) are indexed.
CREATE INDEX IF NOT EXISTS idx_tool_invocations_chain
  ON tool_invocations (root_invocation_id, attempt_number);

-- Explicit, stable ordering for pagination: created_at alone is NOT unique under a fixed
-- clock, so `id` is the declared tie-break. Never rely on implicit rowid (Sprint 9.1.2 §三).
CREATE INDEX IF NOT EXISTS idx_tool_invocations_stable_order
  ON tool_invocations (created_at DESC, id DESC);
