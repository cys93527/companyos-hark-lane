-- LIVE-SMOKE-FIX-04B: attempt-scoped durable failure truth.
--
-- ExecutionAttempt is the first-class durable attempt truth, so a terminal FAILED
-- attempt's typed failure belongs ON THE ATTEMPT ROW — one canonical, append-only
-- history per (task, attempt_number): attempt 1's MODEL_CAPABILITY_MISMATCH can never
-- be overwritten by attempt 2's TRANSPORT_FAILED, and a fresh read of the row answers
-- state + failureCode + failurePhase + safeSummary + retryable from the DB alone.
--
-- Nullable by design: legacy rows (and every non-FAILED terminal) legally carry NULL —
-- the read layer reports legacy absence explicitly (LEGACY_FAILURE_DETAIL_UNAVAILABLE),
-- never a fabricated code. Provider contact stays derivable from the EXISTING
-- provider_dispatches.attempt_id relation (no second boolean truth).
ALTER TABLE execution_attempts ADD COLUMN failure_code TEXT;
ALTER TABLE execution_attempts ADD COLUMN failure_phase TEXT;
ALTER TABLE execution_attempts ADD COLUMN failure_summary TEXT;
ALTER TABLE execution_attempts ADD COLUMN failure_retryable INTEGER;
