-- H12b: the typed terminal reason of a Run is enforced by the storage itself.
-- The frozen L1 machine (17 states, 规划书 §三十三, STATE_MACHINE.md SM-L1-07) records a
-- cancelled Run as state FAILED + failure_reason 'cancelled' (timeout: 'timed_out').
-- `state` already has a CHECK constraint (0001); `failure_reason` had none, so any string
-- could be written and later cast through. Additive: no table rebuild, no data change,
-- the Run/Task state enums are unchanged. Legacy rows are not rewritten; the typed decode
-- in sqlite-run-store refuses an invalid stored value on read (fail closed).
CREATE TRIGGER runs_failure_reason_typed_insert
BEFORE INSERT ON runs
WHEN NEW.failure_reason IS NOT NULL AND NEW.failure_reason NOT IN (
  'cancelled','timed_out','route_failed','execution_failed','approval_denied','delivery_failed','recovery_failed')
BEGIN
  SELECT RAISE(ABORT, 'RUN_FAILURE_REASON_INVALID');
END;

CREATE TRIGGER runs_failure_reason_typed_update
BEFORE UPDATE OF failure_reason ON runs
WHEN NEW.failure_reason IS NOT NULL AND NEW.failure_reason NOT IN (
  'cancelled','timed_out','route_failed','execution_failed','approval_denied','delivery_failed','recovery_failed')
BEGIN
  SELECT RAISE(ABORT, 'RUN_FAILURE_REASON_INVALID');
END;
