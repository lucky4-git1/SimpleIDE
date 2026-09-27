function getDirectDbManager() {
  if (typeof window !== 'undefined') return null
  return globalThis.__nodeDbManager || null
}

function normalizeSlashes(path) {
  return String(path || '').replace(/\\/g, '/').toLowerCase()
}

export class ProjectMemory {
  constructor(storageKey = 'prime_ai_project') {
    this.storageKey = storageKey
    this.workspaceRoot = null
    this.workspaceDbId = null
    this.records = []
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
    const migratedKey = `prime_ai_sqlite_migrated_project_${this.workspaceRoot}`

    try {
      if (typeof localStorage === 'undefined') return
      if (localStorage.getItem(migratedKey)) return

      const legacyData = localStorage.getItem(key)
      if (!legacyData) {
        localStorage.setItem(migratedKey, 'true')
        return
      }

      const legacyRecords = JSON.parse(legacyData)
      const api = this.getApi()
      const dbManager = getDirectDbManager()

      if (Array.isArray(legacyRecords)) {
        for (const rec of legacyRecords) {
          const payload = {
            workspaceId: this.workspaceDbId,
            category: rec.category,
            memoryKey: rec.key,
            value: rec.value,
            confidence: rec.confidence ?? 0.5,
            source: rec.source || 'AGENT_INFERRED'
          }
          if (api?.db && this.workspaceDbId) {
            api.db.saveProjectMemory(payload)
          } else if (dbManager?.db && this.workspaceDbId) {
            dbManager.saveProjectMemory(payload)
          }
        }
      }

      localStorage.setItem(migratedKey, 'true')
    } catch (err) {
      console.warn('Failed legacy project memory migration', err)
    }
  }

  _syncFromDbSync() {
    const dbManager = getDirectDbManager()
    if (!this.workspaceDbId || !dbManager?.db) return
    try {
      const dbMems = dbManager.searchProjectMemory(this.workspaceDbId, null, 0.0)
      this.records = dbMems.map(m => ({
        id: m.id,
        workspaceId: this.workspaceRoot,
        category: m.category,
        key: m.memory_key,
        value: m.value,
        confidence: m.confidence,
        source: m.source,
        createdAt: m.created_at,
        updatedAt: m.updated_at
      }))
    } catch (e) {
      console.warn('Sync project memory from DB sync failed:', e)
      this._loadFallback()
    }
  }

  async _syncFromDb() {
    const api = this.getApi()
    if (!api?.db || !this.workspaceDbId) return
    try {
      const res = await api.db.searchProjectMemory({ workspaceId: this.workspaceDbId, category: null, minConfidence: 0.0 })
      if (res?.success && Array.isArray(res.memories)) {
        this.records = res.memories.map(m => ({
          id: m.id,
          workspaceId: this.workspaceRoot,
          category: m.category,
          key: m.memory_key,
          value: m.value,
          confidence: m.confidence,
          source: m.source,
          createdAt: m.created_at,
          updatedAt: m.updated_at
        }))
      }
    } catch (e) {
      console.warn('Sync project memory from DB failed:', e)
    }
  }

  _loadFallback() {
    try {
      if (typeof localStorage !== 'undefined') {
        const data = localStorage.getItem(`${this.storageKey}_${this.workspaceRoot}`)
        if (data) this.records = JSON.parse(data)
      }
    } catch {
      this.records = []
    }
  }

  save() {
    if (!this.workspaceRoot) return
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${this.storageKey}_${this.workspaceRoot}`, JSON.stringify(this.records))
      }
    } catch (e) {
      console.warn('Failed to save project memory fallback', e)
    }
  }

  addRecord({ category, key, value, source = 'AGENT_INFERRED', confidence = 0.5 }) {
    const conf = Math.max(0.0, Math.min(1.0, parseFloat(confidence) || 0.5))
    const existingIndex = this.records.findIndex(r => r.category === category && r.key === key)

    if (existingIndex !== -1) {
      const existing = this.records[existingIndex]
      if (conf >= existing.confidence) {
        this.records[existingIndex] = {
          ...existing,
          value,
          source,
          confidence: conf,
          updatedAt: Date.now()
        }
      }
    } else {
      this.records.push({
        workspaceId: this.workspaceRoot,
        category,
        key,
        value,
        source,
        confidence: conf,
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    }

    const api = this.getApi()
    const dbManager = getDirectDbManager()

    if (api?.db && this.workspaceDbId) {
      api.db.saveProjectMemory({
        workspaceId: this.workspaceDbId,
        category,
        memoryKey: key,
        value,
        confidence: conf,
        source
      })
    } else if (dbManager?.db && this.workspaceDbId) {
      dbManager.saveProjectMemory({
        workspaceId: this.workspaceDbId,
        category,
        memoryKey: key,
        value,
        confidence: conf,
        source
      })
    }

    this.save()
  }

  getRecords(category = null, minConfidence = 0.5) {
    return this.records.filter(r =>
      (!category || r.category === category) &&
      r.confidence >= minConfidence
    ).sort((a, b) => b.confidence - a.confidence)
  }
}
