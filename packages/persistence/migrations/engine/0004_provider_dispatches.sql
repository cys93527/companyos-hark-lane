-- Sprint24 — the durable PROVIDER DISPATCH binding (engine chain).
--
-- SUBORDINATE to ExecutionAttempt (§20): it records implementation/provenance
-- facts (providerKey, deterministic dispatchKey, provider session identity,
-- provider invocation identity when real, state) for ONE canonical attempt. It
-- NEVER decides attempt numbers, Task success, retry counts, Task or Run
-- lifecycle — those stay with the frozen owners.
--
-- UNIQUE(dispatch_key) is CompanyOS-side deterministic identity: the same
-- attempt dispatched to the same provider replays the SAME row forever; a
-- different attempt never shares it. This is NOT a provider exactly-once
-- claim (Sprint21 §26 stands).
CREATE TABLE IF NOT EXISTS provider_dispatches (
  dispatch_id     TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  attempt_id      TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL CHECK (attempt_number >= 1),
  provider_key    TEXT NOT NULL,
  dispatch_key    TEXT NOT NULL,
  -- Provider-owned DURABLE SESSION identity (a conversation that may carry many
  -- turns) — bound only from real provider evidence, never manufactured.
  provider_session_id  TEXT,
  -- Provider-owned identity of ONE concrete external invocation — recorded ONLY
  -- when the provider actually exposes one; never derived from session/pid/counter.
  provider_invocation_id TEXT,
  -- DISPATCHED: claim durable, provider definitely NOT yet invoked (window A)
  -- PUBLISHED: the provider EVIDENCED a durable session identity (conversation
  --   truth — NOT proof of one exact invocation)
  -- SETTLED: the provider result was delivered to the canonical engine settlement
  -- UNCERTAIN: the external invocation outcome could not be proven (crash honesty)
  state           TEXT NOT NULL CHECK (state IN ('DISPATCHED','PUBLISHED','SETTLED','UNCERTAIN')),
  result_summary  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (dispatch_key)
);

CREATE INDEX IF NOT EXISTS idx_provider_dispatches_attempt
  ON provider_dispatches (attempt_id);
CREATE INDEX IF NOT EXISTS idx_provider_dispatches_run
  ON provider_dispatches (run_id);
