-- POST-CODEX 6ec4d81 re-audit — PERMANENT logical-turn ownership.
--
-- ONE LOGICAL TURN = ONE DURABLE OWNER FOR ITS ENTIRE HISTORY (not merely one ACTIVE
-- owner at a time). The ACTIVE-partial index allowed a delayed contender to insert a
-- SECOND owner after the first settled; global uniqueness over non-NULL identities makes
-- that impossible: once logical turn T has an owner execution X, no other AgentExecution
-- can ever acquire T — regardless of X's status (RUNNING/COMPLETED/FAILED/CANCELLED/
-- TIMEOUT/INTERRUPTED) or the Decision state.
--
-- Duplicate detection: if a 6ec4d81-era database already contains duplicate non-NULL
-- identities (the historical bug), CREATE UNIQUE INDEX fails inside the migration
-- transaction — the migration FAILS HONESTLY (typed error, full rollback) instead of
-- silently deleting or rewriting historical rows. A genuinely new reasoning attempt
-- must use a NEW logicalTurnId; the frozen identity grammar already encodes the turn.
DROP INDEX IF EXISTS idx_agent_executions_active_logical_turn;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_executions_logical_turn
  ON agent_executions(logical_turn_id)
  WHERE logical_turn_id IS NOT NULL;
