-- 004_indexes.sql

CREATE INDEX IF NOT EXISTS idx_conversations_workspace
ON conversations(workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
ON messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace
ON agent_runs(workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_state
ON agent_runs(state);

CREATE INDEX IF NOT EXISTS idx_agent_events_run
ON agent_events(run_id, sequence);

CREATE INDEX IF NOT EXISTS idx_tool_executions_run
ON tool_executions(run_id, started_at);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace
ON tasks(workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_plan_steps_run
ON plan_steps(run_id, sequence);

CREATE INDEX IF NOT EXISTS idx_project_memory_workspace
ON project_memory(workspace_id, category);

CREATE INDEX IF NOT EXISTS idx_file_changes_run
ON file_changes(run_id);

CREATE INDEX IF NOT EXISTS idx_verification_results_run
ON verification_results(run_id);
