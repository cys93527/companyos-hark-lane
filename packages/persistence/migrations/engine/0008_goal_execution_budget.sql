-- ADR-A/B: additive subordinate admission snapshot on the existing canonical Run.
-- NULL on legacy data means NOT_CONFIGURED, never unlimited permission.
-- Run/Task lifecycle columns and their state machines are unchanged.
ALTER TABLE runs ADD COLUMN execution_goal_run_id TEXT NULL REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN execution_budget_json TEXT NULL;
