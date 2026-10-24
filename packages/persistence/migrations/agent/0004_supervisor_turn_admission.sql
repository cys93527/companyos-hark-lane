-- POST-CODEX 25b98d1 re-audit — the atomic supervisor logical-turn ADMISSION CLAIM.
--
-- logical_turn_id: the canonical logical supervisor turn identity (the frozen
--   supervisor-decision command identity: run + autonomy identity + turn index). The
--   PARTIAL UNIQUE INDEX is the durable single-flight arbiter: at most ONE execution may
--   hold an ACTIVE (non-terminal) claim for one logical turn — a concurrent contender's
--   insert hits the constraint instead of a read-then-write race. A settled (terminal)
--   row leaves the index, so a later legitimate attempt of the same logical turn may
--   claim normally after canonical settlement — the Run is never permanently locked.
--
-- Nullable: every non-supervisor execution carries NULL and is outside the index.
ALTER TABLE agent_executions ADD COLUMN logical_turn_id TEXT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_executions_active_logical_turn
  ON agent_executions(logical_turn_id)
  WHERE logical_turn_id IS NOT NULL
    AND status IN ('CREATED','READY','RUNNING','WAITING_EXTERNAL');
