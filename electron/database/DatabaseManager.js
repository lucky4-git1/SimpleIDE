import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function normalizePath(p) {
  if (!p) return ''
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// Redact potential API keys or authorization tokens from persisted JSON payloads
function sanitizeSecrets(obj) {
  if (!obj) return obj
  if (typeof obj === 'string') {
    return obj.replace(/(?:api[_-]?key|sk-[a-zA-Z0-9]{20,}|bearer\s+[a-zA-Z0-9._-]+|secret|password|token)["']?\s*[:=]\s*["']?([^"'\s,&]+)/gi, (match) => {
      const parts = match.split(/[:=]/)
      return `${parts[0]}: [REDACTED]`
    })
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeSecrets)
  }
  if (typeof obj === 'object') {
    const clean = {}
    for (const [k, v] of Object.entries(obj)) {
      if (/api[_-]?key|secret|password|token|auth/i.test(k) && typeof v === 'string' && v.length > 5) {
        clean[k] = '[REDACTED]'
      } else {
        clean[k] = sanitizeSecrets(v)
      }
    }
    return clean
  }
  return obj
}

export class DatabaseManager {
  constructor(dbPath = null) {
    this.dbPath = dbPath
    this.db = null
  }

  getDatabasePath() {
    return this.dbPath
  }

  initialize(customPath = null) {
    if (this.db) return this.db

    if (customPath) {
      this.dbPath = customPath
    } else if (!this.dbPath) {
      // In electron environment, resolve userData path
      try {
        const { app } = require('electron')
        this.dbPath = join(app.getPath('userData'), 'simple-ide.db')
      } catch {
        // Fallback for tests / non-electron environment
        const userDataDir = process.env.APPDATA || process.env.HOME || '.'
        this.dbPath = join(userDataDir, '.simple-ide', 'simple-ide.db')
      }
    }

    const dir = dirname(this.dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(this.dbPath)

    // Recommended SQLite PRAGMAs
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')

    this.runMigrations()
    return this.db
  }

  close() {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  transaction(fn) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.transaction(fn)()
  }

  integrityCheck() {
    if (!this.db) throw new Error('Database not initialized')
    const result = this.db.prepare('PRAGMA integrity_check').get()
    return {
      healthy: result && result.integrity_check === 'ok',
      result: result ? result.integrity_check : 'error'
    }
  }

  getStats() {
    if (!this.db) throw new Error('Database not initialized')
    const workspaceCount = this.db.prepare('SELECT COUNT(*) as count FROM workspaces').get().count
    const conversationCount = this.db.prepare('SELECT COUNT(*) as count FROM conversations').get().count
    const messageCount = this.db.prepare('SELECT COUNT(*) as count FROM messages').get().count
    const runCount = this.db.prepare('SELECT COUNT(*) as count FROM agent_runs').get().count
    const memoryCount = this.db.prepare('SELECT COUNT(*) as count FROM project_memory').get().count

    let fileSize = 0
    try {
      if (this.dbPath && fs.existsSync(this.dbPath)) {
        fileSize = fs.statSync(this.dbPath).size
      }
    } catch { /* ignore */ }

    return {
      dbPath: this.dbPath,
      healthy: this.integrityCheck().healthy,
      fileSize,
      counts: {
        workspaces: workspaceCount,
        conversations: conversationCount,
        messages: messageCount,
        agentRuns: runCount,
        projectMemories: memoryCount
      }
    }
  }

  runMigrations() {
    if (!this.db) throw new Error('Database not initialized')

    // Create migrations tracking table if missing
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
      );
    `)

    const migrationsDir = join(__dirname, 'migrations')
    if (!fs.existsSync(migrationsDir)) return

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b))

    const appliedVersions = new Set(
      this.db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
    )

    for (const file of files) {
      const match = file.match(/^(\d+)_/)
      if (!match) continue
      const version = parseInt(match[1], 10)

      if (!appliedVersions.has(version)) {
        const sql = fs.readFileSync(join(migrationsDir, file), 'utf-8')
        this.transaction(() => {
          this.db.exec(sql)
          this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
            .run(version, file, Date.now())
        })
      }
    }
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  getOrCreateWorkspace(rootPath, name = null) {
    if (!this.db) throw new Error('Database not initialized')
    const normalized = normalizePath(rootPath)
    if (!normalized) throw new Error('Invalid workspace path')

    const existing = this.db.prepare('SELECT * FROM workspaces WHERE root_path = ?').get(normalized)
    if (existing) {
      if (name && existing.name !== name) {
        this.db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
          .run(name, Date.now(), existing.id)
        existing.name = name
      }
      return existing
    }

    const id = `ws_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const now = Date.now()
    const workspaceName = name || normalized.split('/').pop() || normalized

    this.db.prepare('INSERT INTO workspaces (id, root_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, normalized, workspaceName, now, now)

    return { id, root_path: normalized, name: workspaceName, created_at: now, updated_at: now }
  }

  getWorkspaceByPath(rootPath) {
    if (!this.db) throw new Error('Database not initialized')
    const normalized = normalizePath(rootPath)
    return this.db.prepare('SELECT * FROM workspaces WHERE root_path = ?').get(normalized) || null
  }

  // ── Conversations & Messages ──────────────────────────────────────────────

  createConversation({ id, workspaceId, title }) {
    if (!this.db) throw new Error('Database not initialized')
    const chatId = id || `conv_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const now = Date.now()

    this.db.prepare('INSERT INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(chatId, workspaceId, title || 'New Chat', now, now)

    return { id: chatId, workspace_id: workspaceId, title: title || 'New Chat', created_at: now, updated_at: now }
  }

  getConversation(id) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) || null
  }

  listConversations(workspaceId) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC').all(workspaceId)
  }

  deleteConversation(id) {
    if (!this.db) throw new Error('Database not initialized')
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    return true
  }

  renameConversation(id, title) {
    if (!this.db) throw new Error('Database not initialized')
    this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id)
  }

  saveMessage({ id, conversationId, role, content, metadata = null }) {
    if (!this.db) throw new Error('Database not initialized')
    const msgId = id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const now = Date.now()
    const metaJson = metadata ? JSON.stringify(sanitizeSecrets(metadata)) : null

    this.db.prepare('INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(msgId, conversationId, role, content, metaJson, now)

    // Touch conversation updated_at
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)

    return { id: msgId, conversation_id: conversationId, role, content, metadata_json: metaJson, created_at: now }
  }

  getMessages(conversationId) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId)
  }

  replaceMessages(conversationId, messages = []) {
    if (!this.db) throw new Error('Database not initialized')
    const rows = Array.isArray(messages) ? messages : []
    const now = Date.now()

    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
      const insert = this.db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const [index, message] of rows.entries()) {
        const content = String(message?.content || '')
        if (!content) continue
        const metadata = message?.metadata ? JSON.stringify(sanitizeSecrets(message.metadata)) : null
        const id = message?.id || `msg_${now}_${index}_${Math.random().toString(36).slice(2, 8)}`
        insert.run(id, conversationId, message?.role || 'assistant', content, metadata, now + index)
      }
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
    })
  }

  // ── Agent Runs ─────────────────────────────────────────────────────────────

  createAgentRun({ id, workspaceId, conversationId = null, userPrompt, state = 'PLANNING' }) {
    if (!this.db) throw new Error('Database not initialized')
    const runId = id || `run_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const now = Date.now()

    this.db.prepare('INSERT INTO agent_runs (id, workspace_id, conversation_id, user_prompt, state, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, workspaceId, conversationId, userPrompt, state, now, now)

    return { id: runId, workspace_id: workspaceId, conversation_id: conversationId, user_prompt: userPrompt, state, started_at: now, updated_at: now }
  }

  updateAgentRunState(id, state, { error = null, completedAt = null } = {}) {
    if (!this.db) throw new Error('Database not initialized')
    const now = Date.now()
    const compTime = completedAt || (['COMPLETED', 'FAILED', 'CANCELLED'].includes(state) ? now : null)

    this.db.prepare('UPDATE agent_runs SET state = ?, error = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?')
      .run(state, error, compTime, now, id)
  }

  getAgentRun(id) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) || null
  }

  listAgentRuns(workspaceId) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM agent_runs WHERE workspace_id = ? ORDER BY started_at DESC').all(workspaceId)
  }

  getUnfinishedAgentRuns(workspaceId = null) {
    if (!this.db) throw new Error('Database not initialized')
    const activeStates = ['PLANNING', 'EXECUTING', 'EVALUATING', 'VERIFYING', 'REPAIRING']
    const placeholders = activeStates.map(() => '?').join(',')
    if (workspaceId) {
      return this.db.prepare(`SELECT * FROM agent_runs WHERE workspace_id = ? AND state IN (${placeholders}) ORDER BY updated_at DESC`)
        .all(workspaceId, ...activeStates)
    }
    return this.db.prepare(`SELECT * FROM agent_runs WHERE state IN (${placeholders}) ORDER BY updated_at DESC`)
      .all(...activeStates)
  }

  // ── Agent Events ───────────────────────────────────────────────────────────

  logAgentEvent({ id, runId, type, payload = null, sequence }) {
    if (!this.db) throw new Error('Database not initialized')
    const eventId = id || `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const now = Date.now()
    const payloadJson = payload ? JSON.stringify(sanitizeSecrets(payload)) : null

    this.db.prepare('INSERT INTO agent_events (id, run_id, type, payload_json, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(eventId, runId, type, payloadJson, sequence, now)

    return { id: eventId, run_id: runId, type, payload_json: payloadJson, sequence, created_at: now }
  }

  getAgentEvents(runId) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM agent_events WHERE run_id = ? ORDER BY sequence ASC').all(runId)
  }

  // ── Tool Executions ────────────────────────────────────────────────────────

  logToolExecution({ id, runId, toolName, arguments: args = null, status = 'running' }) {
    if (!this.db) throw new Error('Database not initialized')
    const execId = id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const now = Date.now()
    const argsJson = args ? JSON.stringify(sanitizeSecrets(args)) : null

    this.db.prepare('INSERT INTO tool_executions (id, run_id, tool_name, arguments_json, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(execId, runId, toolName, argsJson, status, now)

    return { id: execId, run_id: runId, tool_name: toolName, arguments_json: argsJson, status, started_at: now }
  }

  updateToolExecution(id, { result = null, status = 'success', error = null }) {
    if (!this.db) throw new Error('Database not initialized')
    const now = Date.now()
    const resultJson = result ? JSON.stringify(sanitizeSecrets(result)) : null

    this.db.prepare('UPDATE tool_executions SET result_json = ?, status = ?, error = ?, completed_at = ? WHERE id = ?')
      .run(resultJson, status, error, now, id)
  }

  getToolExecutions(runId) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM tool_executions WHERE run_id = ? ORDER BY started_at ASC').all(runId)
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  saveTask({ id, workspaceId, runId = null, title, description = null, status = 'pending', priority = 0 }) {
    if (!this.db) throw new Error('Database not initialized')
    const taskId = id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const now = Date.now()

    const existing = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
    if (existing) {
      const compAt = status === 'complete' ? (existing.completed_at || now) : null
      this.db.prepare('UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, updated_at = ?, completed_at = ? WHERE id = ?')
        .run(title, description, status, priority, now, compAt, taskId)
    } else {
      const compAt = status === 'complete' ? now : null
      this.db.prepare('INSERT INTO tasks (id, workspace_id, run_id, title, description, status, priority, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(taskId, workspaceId, runId, title, description, status, priority, now, now, compAt)
    }

    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  }

  getTasks(workspaceId) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY priority DESC, updated_at DESC').all(workspaceId)
  }

  // ── Plan Steps ─────────────────────────────────────────────────────────────

  savePlanSteps(runId, steps = []) {
    if (!this.db) throw new Error('Database not initialized')
    const now = Date.now()
    this.transaction(() => {
      this.db.prepare('DELETE FROM plan_steps WHERE run_id = ?').run(runId)
      const stmt = this.db.prepare('INSERT INTO plan_steps (id, run_id, sequence, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      steps.forEach((step, idx) => {
        const stepId = step.id || `step_${runId}_${idx + 1}`
        stmt.run(stepId, runId, idx + 1, step.title, step.description || null, step.status || 'pending', now, now)
      })
    })
    return this.getPlanSteps(runId)
  }

  getPlanSteps(runId) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM plan_steps WHERE run_id = ? ORDER BY sequence ASC').all(runId)
  }

  // ── File Changes ───────────────────────────────────────────────────────────

  logFileChange({ id, runId, filePath, beforeHash = null, afterHash = null, beforeContent = null, afterContent = null }) {
    if (!this.db) throw new Error('Database not initialized')
    const changeId = id || `chg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const now = Date.now()

    // Threshold check for large content: clip if > 50,000 characters to keep DB compact
    const MAX_CONTENT_LEN = 50000
    const safeBefore = beforeContent && beforeContent.length > MAX_CONTENT_LEN ? `${beforeContent.slice(0, MAX_CONTENT_LEN)}\n[TRUNCATED]` : beforeContent
    const safeAfter = afterContent && afterContent.length > MAX_CONTENT_LEN ? `${afterContent.slice(0, MAX_CONTENT_LEN)}\n[TRUNCATED]` : afterContent

    this.db.prepare('INSERT INTO file_changes (id, run_id, file_path, before_hash, after_hash, before_content, after_content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(changeId, runId, filePath, beforeHash, afterHash, safeBefore, safeAfter, now)

    return { id: changeId, run_id: runId, file_path: filePath, created_at: now }
  }

  getFileChanges(runId) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM file_changes WHERE run_id = ? ORDER BY created_at ASC').all(runId)
  }

  // ── Verification Results ───────────────────────────────────────────────────

  logVerificationResult({ id, runId, command, status, exitCode = null, stdout = null, stderr = null, durationMs = null }) {
    if (!this.db) throw new Error('Database not initialized')
    const verId = id || `ver_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    const now = Date.now()

    this.db.prepare('INSERT INTO verification_results (id, run_id, command, status, exit_code, stdout, stderr, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(verId, runId, command, status, exitCode, stdout, stderr, durationMs, now)

    return { id: verId, run_id: runId, command, status, exit_code: exitCode, duration_ms: durationMs, created_at: now }
  }

  getVerificationResults(runId) {
    if (!this.db) throw new Error('Database not initialized')
    return this.db.prepare('SELECT * FROM verification_results WHERE run_id = ? ORDER BY created_at ASC').all(runId)
  }

  // ── Skills (custom records; built-ins are shipped with the renderer) ─────

  createSkill(input) {
    if (!this.db) throw new Error('Database not initialized')
    const scope = input.scope || 'GLOBAL_USER'
    if (!['GLOBAL_USER', 'WORKSPACE'].includes(scope)) throw new Error('Only custom global or workspace skills can be created')
    if (scope === 'WORKSPACE' && !input.workspaceId && !input.workspace_id) throw new Error('Workspace skills require a workspace id')
    const now = Date.now(); const id = input.id || `skill_${now}_${Math.random().toString(36).slice(2, 8)}`
    const row = { id, name: input.name.trim(), slug: input.slug.trim(), description: input.description || '', scope, workspaceId: input.workspaceId || input.workspace_id || null, version: 1, enabled: input.enabled !== false ? 1 : 0, instructions: input.instructions, metadata: JSON.stringify(sanitizeSecrets(input.metadata || {})), createdAt: now, updatedAt: now }
    this.db.prepare('INSERT INTO skills (id,name,slug,description,scope,workspace_id,version,enabled,instructions,metadata_json,created_at,updated_at) VALUES (@id,@name,@slug,@description,@scope,@workspaceId,@version,@enabled,@instructions,@metadata,@createdAt,@updatedAt)').run(row)
    return this.getSkill(id)
  }
  getSkill(id) { if (!this.db) throw new Error('Database not initialized'); return this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) || null }
  getSkillBySlug(slug, workspaceId = null) { if (!this.db) throw new Error('Database not initialized'); return this.db.prepare("SELECT * FROM skills WHERE slug = ? AND (scope != 'WORKSPACE' OR workspace_id = ?) ORDER BY scope = 'WORKSPACE' DESC").get(slug, workspaceId) || null }
  listSkills({ workspaceId = null, includeDisabled = true } = {}) { if (!this.db) throw new Error('Database not initialized'); return this.db.prepare(`SELECT * FROM skills WHERE (scope = 'GLOBAL_USER' OR (scope = 'WORKSPACE' AND workspace_id = ?)) ${includeDisabled ? '' : 'AND enabled = 1'} ORDER BY name COLLATE NOCASE`).all(workspaceId) }
  updateSkill(id, changes) { if (!this.db) throw new Error('Database not initialized'); const old = this.getSkill(id); if (!old) throw new Error('Skill not found'); const now = Date.now(); const next = { ...old, ...changes, metadata_json: changes.metadata ? JSON.stringify(sanitizeSecrets(changes.metadata)) : old.metadata_json, version: old.version + 1, updated_at: now }; this.db.prepare('UPDATE skills SET name=?,slug=?,description=?,enabled=?,instructions=?,metadata_json=?,version=?,updated_at=? WHERE id=?').run(next.name,next.slug,next.description,next.enabled === false ? 0 : Number(next.enabled),next.instructions,next.metadata_json,next.version,next.updated_at,id); return this.getSkill(id) }
  deleteSkill(id) { if (!this.db) throw new Error('Database not initialized'); this.db.prepare('DELETE FROM skills WHERE id = ?').run(id); return true }
  recordSkillUsage({ skillId, agentRunId = null, workspaceId = null, version, contentHash, snapshot, selectionSource, success = null, verificationAttempts = 0 }) { if (!this.db) throw new Error('Database not initialized'); const id = `skilluse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; this.db.prepare('INSERT INTO skill_usage (id,skill_id,agent_run_id,workspace_id,version,content_hash,snapshot_json,selection_source,success,verification_attempts,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,skillId,agentRunId,workspaceId,version,contentHash,JSON.stringify(sanitizeSecrets(snapshot)),selectionSource,success == null ? null : (success ? 1 : 0),verificationAttempts,Date.now()); return { id } }
  getSkillUsageStats() { if (!this.db) throw new Error('Database not initialized'); const rows = this.db.prepare('SELECT skill_id, COUNT(*) uses, AVG(CASE WHEN success IS NOT NULL THEN success END) successRate, AVG(verification_attempts) averageVerificationAttempts FROM skill_usage GROUP BY skill_id').all(); return Object.fromEntries(rows.map(r => [r.skill_id, r])) }

  // ── Project Memory ─────────────────────────────────────────────────────────

  saveProjectMemory({ id, workspaceId, category, memoryKey, value, confidence = 0.5, source = 'AGENT_INFERRED' }) {
    if (!this.db) throw new Error('Database not initialized')
    const conf = Math.max(0.0, Math.min(1.0, parseFloat(confidence) || 0.5))
    const now = Date.now()
    const memId = id || `mem_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`

    const existing = this.db.prepare('SELECT * FROM project_memory WHERE workspace_id = ? AND category = ? AND memory_key = ?')
      .get(workspaceId, category, memoryKey)

    if (existing) {
      if (conf >= existing.confidence) {
        this.db.prepare('UPDATE project_memory SET value = ?, confidence = ?, source = ?, updated_at = ? WHERE id = ?')
          .run(value, conf, source, now, existing.id)
      }
      return this.db.prepare('SELECT * FROM project_memory WHERE id = ?').get(existing.id)
    }

    this.db.prepare('INSERT INTO project_memory (id, workspace_id, category, memory_key, value, confidence, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(memId, workspaceId, category, memoryKey, value, conf, source, now, now)

    return this.db.prepare('SELECT * FROM project_memory WHERE id = ?').get(memId)
  }

  searchProjectMemory(workspaceId, category = null, minConfidence = 0.5) {
    if (!this.db) throw new Error('Database not initialized')
    if (category) {
      return this.db.prepare('SELECT * FROM project_memory WHERE workspace_id = ? AND category = ? AND confidence >= ? ORDER BY confidence DESC, updated_at DESC')
        .all(workspaceId, category, minConfidence)
    }
    return this.db.prepare('SELECT * FROM project_memory WHERE workspace_id = ? AND confidence >= ? ORDER BY confidence DESC, updated_at DESC')
      .all(workspaceId, minConfidence)
  }

  deleteProjectMemory(id) {
    if (!this.db) throw new Error('Database not initialized')
    this.db.prepare('DELETE FROM project_memory WHERE id = ?').run(id)
  }

  // ── Workspace State ────────────────────────────────────────────────────────

  saveWorkspaceState(workspaceId, stateObj) {
    if (!this.db) throw new Error('Database not initialized')
    const now = Date.now()
    const stateJson = JSON.stringify(stateObj)

    this.db.prepare(`
      INSERT INTO workspace_state (workspace_id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(workspaceId, stateJson, now)
  }

  getWorkspaceState(workspaceId) {
    if (!this.db) throw new Error('Database not initialized')
    const row = this.db.prepare('SELECT * FROM workspace_state WHERE workspace_id = ?').get(workspaceId)
    if (!row || !row.state_json) return null
    try {
      return JSON.parse(row.state_json)
    } catch {
      return null
    }
  }

  // ── Retention / Maintenance Cleanup ──────────────────────────────────────

  pruneHistory({ runDays = 90, toolDays = 30, verificationDays = 14 } = {}) {
    if (!this.db) throw new Error('Database not initialized')
    const now = Date.now()
    const runCutoff = now - (runDays * 24 * 60 * 60 * 1000)
    const toolCutoff = now - (toolDays * 24 * 60 * 60 * 1000)
    const verCutoff = now - (verificationDays * 24 * 60 * 60 * 1000)

    this.transaction(() => {
      this.db.prepare('DELETE FROM verification_results WHERE created_at < ?').run(verCutoff)
      this.db.prepare('DELETE FROM tool_executions WHERE started_at < ?').run(toolCutoff)
      this.db.prepare('DELETE FROM agent_runs WHERE completed_at IS NOT NULL AND completed_at < ?').run(runCutoff)
    })
  }

  clearAllData() {
    if (!this.db) throw new Error('Database not initialized')
    this.transaction(() => {
      this.db.prepare('DELETE FROM file_changes').run()
      this.db.prepare('DELETE FROM verification_results').run()
      this.db.prepare('DELETE FROM tool_executions').run()
      this.db.prepare('DELETE FROM agent_events').run()
      this.db.prepare('DELETE FROM plan_steps').run()
      this.db.prepare('DELETE FROM tasks').run()
      this.db.prepare('DELETE FROM agent_runs').run()
      this.db.prepare('DELETE FROM messages').run()
      this.db.prepare('DELETE FROM conversations').run()
      this.db.prepare('DELETE FROM project_memory').run()
      this.db.prepare('DELETE FROM workspace_state').run()
      this.db.prepare('DELETE FROM workspaces').run()
    })
  }
}

export const databaseManager = new DatabaseManager()
if (typeof globalThis !== 'undefined') {
  globalThis.__nodeDbManager = databaseManager
}
