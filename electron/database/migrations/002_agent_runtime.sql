-- 002_agent_runtime.sql

CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT,
    user_prompt TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    FOREIGN KEY (workspace_id)
        REFERENCES workspaces(id)
        ON DELETE CASCADE,
    FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT,
    sequence INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id)
        REFERENCES agent_runs(id)
        ON DELETE CASCADE,
    UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS tool_executions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT,
    result_json TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    FOREIGN KEY (run_id)
        REFERENCES agent_runs(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (workspace_id)
        REFERENCES workspaces(id)
        ON DELETE CASCADE,
    FOREIGN KEY (run_id)
        REFERENCES agent_runs(id)
        ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS plan_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (run_id)
        REFERENCES agent_runs(id)
        ON DELETE CASCADE,
    UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS file_changes (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    before_hash TEXT,
    after_hash TEXT,
    before_content TEXT,
    after_content TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id)
        REFERENCES agent_runs(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS verification_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    stdout TEXT,
    stderr TEXT,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id)
        REFERENCES agent_runs(id)
        ON DELETE CASCADE
);
