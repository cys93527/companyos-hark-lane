CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT NOT NULL, version INTEGER NOT NULL, company_id TEXT NOT NULL,
  scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, kind TEXT NOT NULL, subject_key TEXT,
  title TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, importance TEXT NOT NULL,
  source_type TEXT NOT NULL, source_refs_json TEXT NOT NULL, trust TEXT NOT NULL,
  supersedes TEXT, stale_reason TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, expires_at TEXT, trace_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
  PRIMARY KEY(memory_id, version)
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(company_id, scope_type, scope_id, status, subject_key);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT NOT NULL, version INTEGER NOT NULL, company_id TEXT NOT NULL,
  scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, subject_key TEXT, title TEXT NOT NULL,
  question TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT NOT NULL,
  alternatives_json TEXT NOT NULL, constraints_json TEXT NOT NULL, consequences_json TEXT NOT NULL,
  status TEXT NOT NULL, supersedes TEXT, related_memory_refs_json TEXT NOT NULL,
  related_handoff_refs_json TEXT NOT NULL, related_artifact_refs_json TEXT NOT NULL,
  decided_by TEXT NOT NULL, decided_at TEXT NOT NULL, trace_id TEXT NOT NULL,
  source_type TEXT NOT NULL, source_refs_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
  PRIMARY KEY(decision_id, version)
);
CREATE INDEX IF NOT EXISTS idx_decisions_scope ON decisions(company_id, scope_type, scope_id, status, subject_key);
