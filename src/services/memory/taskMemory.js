function getDirectDbManager() {
  if (typeof window !== 'undefined') return null
  return globalThis.__nodeDbManager || null
}

function normalizeSlashes(path) {
  return String(path || '').replace(/\\/g, '/').toLowerCase()
}

export class TaskMemory {
  constructor(storageKey = 'prime_ai_tasks') {
    this.storageKey = storageKey
    this.workspaceRoot = null
    this.workspaceDbId = null
    this.tasks = []
  }

  getApi() {
    return globalThis.window?.api
  }

  load(workspaceRoot) {
    this.workspaceRoot = normalizeSlashes(workspaceRoot)
    if (!this.workspaceRoot) return

    const api = this.getApi()

    try {
      if (api?.db) {
        api.db.initWorkspace({ rootPath: this.workspaceRoot }).then(res => {
          if (res?.success && res?.workspace) {
            this.workspaceDbId = res.workspace.id
            this._migrateLegacyStorage()
            this._syncFromDb()
          }
        }).catch(() => this._loadFallback())
      } else {
        const dbManager = getDirectDbManager()
        if (dbManager) {
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
      }
    } catch {
      this._loadFallback()
    }
  }

  _migrateLegacyStorage() {
    if (!this.workspaceRoot) return
    const key = `${this.storageKey}_${this.workspaceRoot}`
    const migratedKey = `prime_ai_sqlite_migrated_tasks_${this.workspaceRoot}`

    try {
      if (typeof localStorage === 'undefined') return
      if (localStorage.getItem(migratedKey)) return

      const legacyData = localStorage.getItem(key)
      if (!legacyData) {
        localStorage.setItem(migratedKey, 'true')
        return
      }

      const legacyTasks = JSON.parse(legacyData)
      const api = this.getApi()

      if (Array.isArray(legacyTasks)) {
        for (const task of legacyTasks) {
          const taskObj = {
            id: task.id,
            workspaceId: this.workspaceDbId,
            title: task.title || task.name || 'Untitled Task',
            description: task.description || null,
            status: task.status || 'pending',
            priority: task.priority || 0
          }
          if (api?.db && this.workspaceDbId) {
            api.db.saveTask(taskObj)
          } else {
            const dbManager = getDirectDbManager()
            if (dbManager?.db && this.workspaceDbId) {
              dbManager.saveTask(taskObj)
            }
          }
        }
      }

      localStorage.setItem(migratedKey, 'true')
    } catch (err) {
      console.warn('Failed legacy task migration', err)
    }
  }

  _syncFromDbSync() {
    const dbManager = getDirectDbManager()
    if (!this.workspaceDbId || !dbManager?.db) return
    try {
      const dbTasks = dbManager.getTasks(this.workspaceDbId)
      this.tasks = dbTasks.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        completedAt: t.completed_at
      }))
    } catch (e) {
      console.warn('Sync tasks from DB sync failed:', e)
      this._loadFallback()
    }
  }

  async _syncFromDb() {
    const api = this.getApi()
    if (!api?.db || !this.workspaceDbId) return
    try {
      const res = await api.db.listTasks({ workspaceId: this.workspaceDbId })
      if (res?.success && Array.isArray(res.tasks)) {
        this.tasks = res.tasks.map(t => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
          completedAt: t.completed_at
        }))
      }
    } catch (e) {
      console.warn('Sync tasks from DB failed:', e)
    }
  }

  _loadFallback() {
    try {
      if (typeof localStorage !== 'undefined') {
        const data = localStorage.getItem(`${this.storageKey}_${this.workspaceRoot}`)
        if (data) this.tasks = JSON.parse(data)
      }
    } catch {
      this.tasks = []
    }
  }

  saveTask(taskData) {
    const taskObj = {
      id: taskData.id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      workspaceId: this.workspaceDbId,
      runId: taskData.runId || null,
      title: taskData.title,
      description: taskData.description || null,
      status: taskData.status || 'pending',
      priority: taskData.priority || 0
    }

    const existingIdx = this.tasks.findIndex(t => t.id === taskObj.id)
    if (existingIdx !== -1) {
      this.tasks[existingIdx] = { ...this.tasks[existingIdx], ...taskObj, updatedAt: Date.now() }
    } else {
      this.tasks.push({ ...taskObj, createdAt: Date.now(), updatedAt: Date.now() })
    }

    const api = this.getApi()
    if (api?.db && this.workspaceDbId) {
      api.db.saveTask(taskObj)
    } else {
      const dbManager = getDirectDbManager()
      if (dbManager?.db && this.workspaceDbId) {
        dbManager.saveTask(taskObj)
      }
    }

    this.save()
    return taskObj
  }

  save() {
    if (!this.workspaceRoot) return
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${this.storageKey}_${this.workspaceRoot}`, JSON.stringify(this.tasks))
      }
    } catch (e) {
      console.warn('Failed to save tasks fallback', e)
    }
  }
}
