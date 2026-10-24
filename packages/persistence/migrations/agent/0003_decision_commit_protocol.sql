-- POST-CODEX 9dc9943 re-audit — the final Decision/Execution commit protocol fields.
--
-- outcome_decision_id: STRONGER COMMIT IDENTITY — the exact Decision row that made this
--   execution outcome-committed. The marker timestamp alone must never become ambiguous
--   truth: the runtime can now prove WHICH durable Decision owns the committed outcome.
--
-- decision_authority_expires_at: the DURABLE DECISION-AUTHORITY EXPIRY — an absolute
--   ISO-8601 UTC instant written when the supervisor execution starts (started_at + the
--   turn's own whole-turn timeout, from the canonical clock). The Decision-commit
--   predicate requires it to be still in the future, so a deadline that expired while
--   terminal settlement storage was temporarily unavailable permanently revokes the
--   late sink's authority even though the row may temporarily remain RUNNING.
--
-- Both nullable: every non-supervisor execution (and every legacy row) legally carries
-- NULL — generic AgentExecution lifecycle semantics are untouched.
ALTER TABLE agent_executions ADD COLUMN outcome_decision_id TEXT NULL;
ALTER TABLE agent_executions ADD COLUMN decision_authority_expires_at TEXT NULL;
