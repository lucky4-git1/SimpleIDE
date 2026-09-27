function getDirectDbManager() {
  if (typeof window !== 'undefined') return null
  return globalThis.__nodeDbManager || null
}

function normalizeSlashes(path) {
  return String(path || '').replace(/\\/g, '/').toLowerCase()
}

export class WorkspaceMemory {
  constructor(storageKey = 'prime_ai_workspace') {
    this.storageKey = storageKey
    this.workspaceRoot = null
    this.workspaceDbId = null
    this.state = {}
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
    const migratedKey = `prime_ai_sqlite_migrated_workspace_${this.workspaceRoot}`

    try {
      if (typeof localStorage === 'undefined') return
      if (localStorage.getItem(migratedKey)) return

      const legacyData = localStorage.getItem(key)
      if (!legacyData) {
        localStorage.setItem(migratedKey, 'true')
        return
      }

      const legacyObj = JSON.parse(legacyData)
      const api = this.getApi()
      const dbManager = getDirectDbManager()

      if (legacyObj && typeof legacyObj === 'object') {
        if (api?.db && this.workspaceDbId) {
          api.db.saveWorkspaceState({ workspaceId: this.workspaceDbId, state: legacyObj })
        } else if (dbManager?.db && this.workspaceDbId) {
          dbManager.saveWorkspaceState(this.workspaceDbId, legacyObj)
        }
      }

      localStorage.setItem(migratedKey, 'true')
    } catch (err) {
      console.warn('Failed legacy workspace state migration', err)
    }
  }

  _syncFromDbSync() {
    const dbManager = getDirectDbManager()
    if (!this.workspaceDbId || !dbManager?.db) return
    try {
      const stateObj = dbManager.getWorkspaceState(this.workspaceDbId)
      if (stateObj) this.state = stateObj
    } catch (e) {
      console.warn('Sync workspace state from DB sync failed:', e)
      this._loadFallback()
    }
  }

  async _syncFromDb() {
    const api = this.getApi()
    if (!api?.db || !this.workspaceDbId) return
    try {
      const res = await api.db.getWorkspaceState({ workspaceId: this.workspaceDbId })
      if (res?.success && res.state) {
        this.state = res.state
      }
    } catch (e) {
      console.warn('Sync workspace state from DB failed:', e)
    }
  }

  _loadFallback() {
    try {
      if (typeof localStorage !== 'undefined') {
        const data = localStorage.getItem(`${this.storageKey}_${this.workspaceRoot}`)
        if (data) this.state = JSON.parse(data)
      }
    } catch {
      this.state = {}
    }
  }

  save(nextState = null) {
    if (!this.workspaceRoot) return
    if (nextState) this.state = { ...this.state, ...nextState }

    const api = this.getApi()
    const dbManager = getDirectDbManager()

    if (api?.db && this.workspaceDbId) {
      api.db.saveWorkspaceState({ workspaceId: this.workspaceDbId, state: this.state })
    } else if (dbManager?.db && this.workspaceDbId) {
      dbManager.saveWorkspaceState(this.workspaceDbId, this.state)
    }

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${this.storageKey}_${this.workspaceRoot}`, JSON.stringify(this.state))
      }
    } catch (e) {
      console.warn('Failed to save workspace state fallback', e)
    }
  }

  getState() {
    return { ...this.state }
  }
}
