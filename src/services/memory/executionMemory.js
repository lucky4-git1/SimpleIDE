function getDirectDbManager() {
  if (typeof window !== 'undefined') return null
  return globalThis.__nodeDbManager || null
}

function normalizeSlashes(path) {
  return String(path || '').replace(/\\/g, '/').toLowerCase()
}

export class ExecutionMemory {
  constructor(storageKey = 'prime_ai_execution') {
    this.storageKey = storageKey
    this.workspaceRoot = null
    this.workspaceDbId = null
    this.history = []
  }

  getApi() {
    return globalThis.window?.api
  }

  load(workspaceRoot) {
    this.workspaceRoot = normalizeSlashes(workspaceRoot)
    if (!this.workspaceRoot) return

    const api = this.getApi()
    const dbManager = getDirectDbManager()

    try {
      if (api?.db) {
        api.db.initWorkspace({ rootPath: this.workspaceRoot }).then(res => {
          if (res?.success && res?.workspace) {
            this.workspaceDbId = res.workspace.id
            this._migrateLegacyStorage()
            this._syncFromDb()
          }
        }).catch(() => this._loadFallback())
      } else if (dbManager) {
        const db = dbManager.initialize()
        if (db) {
          const ws = dbManager.getOrCreateWorkspace(this.workspaceRoot)
          this.workspaceDbId = ws.id
          this._migrateLegacyStorage()
          this._syncFromDbSync()
        } else {
          this._loadFallback()
        }
      } else {
        this._loadFallback()
      }
    } catch {
      this._loadFallback()
    }
  }

  _migrateLegacyStorage() {
    if (!this.workspaceRoot) return
    const key = `${this.storageKey}_${this.workspaceRoot}`
    const migratedKey = `prime_ai_sqlite_migrated_execution_${this.workspaceRoot}`

    try {
      if (typeof localStorage === 'undefined') return
      if (localStorage.getItem(migratedKey)) return

      const legacyData = localStorage.getItem(key)
      if (!legacyData) {
        localStorage.setItem(migratedKey, 'true')
        return
      }

      const legacyHistory = JSON.parse(legacyData)
      const api = this.getApi()
      const dbManager = getDirectDbManager()

      if (Array.isArray(legacyHistory)) {
        for (const item of legacyHistory) {
          if (item.runId && item.state) {
            const payload = { id: item.runId, workspaceId: this.workspaceDbId, userPrompt: item.userPrompt || '', state: item.state }
            if (api?.db && this.workspaceDbId) {
              api.db.createAgentRun(payload)
            } else if (dbManager?.db && this.workspaceDbId) {
              dbManager.createAgentRun(payload)
            }
          }
        }
      }

      localStorage.setItem(migratedKey, 'true')
    } catch (err) {
      console.warn('Failed legacy execution memory migration', err)
    }
  }

  _syncFromDbSync() {
    const dbManager = getDirectDbManager()
    if (!this.workspaceDbId || !dbManager?.db) return
    try {
      const runs = dbManager.listAgentRuns(this.workspaceDbId)
      this.history = runs.map(r => ({
        id: r.id,
        userPrompt: r.user_prompt,
        state: r.state,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        error: r.error
      }))
    } catch (e) {
      console.warn('Sync execution memory from DB sync failed:', e)
      this._loadFallback()
    }
  }

  async _syncFromDb() {
    const api = this.getApi()
    if (!api?.db || !this.workspaceDbId) return
    try {
      const res = await api.db.listAgentRuns({ workspaceId: this.workspaceDbId })
      if (res?.success && Array.isArray(res.runs)) {
        this.history = res.runs.map(r => ({
          id: r.id,
          userPrompt: r.user_prompt,
          state: r.state,
          startedAt: r.started_at,
          completedAt: r.completed_at,
          error: r.error
        }))
      }
    } catch (e) {
      console.warn('Sync execution memory from DB failed:', e)
    }
  }

  _loadFallback() {
    try {
      if (typeof localStorage !== 'undefined') {
        const data = localStorage.getItem(`${this.storageKey}_${this.workspaceRoot}`)
        if (data) this.history = JSON.parse(data)
      }
    } catch {
      this.history = []
    }
  }

  save() {
    if (!this.workspaceRoot) return
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${this.storageKey}_${this.workspaceRoot}`, JSON.stringify(this.history))
      }
    } catch (e) {
      console.warn('Failed to save execution memory fallback', e)
    }
  }
}
