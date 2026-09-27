CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('BUILTIN','GLOBAL_USER','WORKSPACE')),
  workspace_id TEXT, version INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CHECK((scope = 'WORKSPACE' AND workspace_id IS NOT NULL) OR (scope != 'WORKSPACE' AND workspace_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_skills_scope_workspace ON skills(scope, workspace_id, enabled);
CREATE TABLE IF NOT EXISTS skill_usage (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, agent_run_id TEXT, workspace_id TEXT, version INTEGER NOT NULL,
  content_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, selection_source TEXT NOT NULL,
  success INTEGER, verification_attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage(skill_id, created_at);
