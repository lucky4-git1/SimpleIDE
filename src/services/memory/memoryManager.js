import { ConversationMemory } from './conversationMemory.js'
import { ProjectMemory } from './projectMemory.js'
import { WorkspaceMemory } from './workspaceMemory.js'
import { TaskMemory } from './taskMemory.js'
import { ExecutionMemory } from './executionMemory.js'
import { UserPreferences } from './userPreferences.js'

function getDirectDbManager() {
  if (typeof window !== 'undefined') return null
  return globalThis.__nodeDbManager || null
}

function normalizeSlashes(path) {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

class MemoryManager {
  constructor() {
    this.conversations = new ConversationMemory()
    this.projects = new ProjectMemory()
    this.workspaces = new WorkspaceMemory()
    this.tasks = new TaskMemory()
    this.executions = new ExecutionMemory()
    this.preferences = new UserPreferences()
    this.activeWorkspace = null
    this.rawWorkspaceRoot = null
    this.workspaceDbId = null
  }

  getApi() {
    return globalThis.window?.api
  }

  init(workspaceRoot, { force = false } = {}) {
    if (!workspaceRoot) return
    const workspaceKey = normalizeSlashes(workspaceRoot)
    this.rawWorkspaceRoot = workspaceRoot

    if (!force && this.activeWorkspace === workspaceKey) return

    this.activeWorkspace = workspaceKey

    // Resolve workspace identity
    const api = this.getApi()
    const dbManager = getDirectDbManager()
    if (api?.db) {
      api.db.initWorkspace({ rootPath: workspaceKey }).then(res => {
        if (res?.success && res.workspace) {
          this.workspaceDbId = res.workspace.id
        }
      }).catch(() => {})
    } else if (dbManager?.db) {
      const ws = dbManager.getOrCreateWorkspace(workspaceKey)
      this.workspaceDbId = ws.id
    }

    this.conversations.load(workspaceRoot)
    this.projects.load(workspaceRoot)
    this.workspaces.load(workspaceRoot)
    this.tasks.load(workspaceRoot)
    this.executions.load(workspaceRoot)
    this.preferences.load()
  }

  getWorkspace() {
    return {
      rootPath: this.activeWorkspace,
      rawPath: this.rawWorkspaceRoot,
      id: this.workspaceDbId
    }
  }

  // ── Section 23 Required API Methods ──────────────────────────────────────

  saveConversation(chat) {
    if (!chat) return null
    const existing = this.conversations.chats.find(c => c.id === chat.id)
    if (existing) {
      Object.assign(existing, chat, { updatedAt: Date.now() })
    } else {
      this.conversations.chats.push(chat)
    }
    const api = this.getApi()
    const dbManager = getDirectDbManager()
    if (api?.db && this.workspaceDbId) {
      api.db.createConversation({ id: chat.id, workspaceId: this.workspaceDbId, title: chat.title })
    } else if (dbManager?.db && this.workspaceDbId) {
      dbManager.createConversation({ id: chat.id, workspaceId: this.workspaceDbId, title: chat.title })
    }
    this.conversations.save()
    return chat
  }

  getConversation(id) {
    return this.conversations.chats.find(c => c.id === id) || null
  }

  listConversations() {
    return this.conversations.getChats()
  }

  deleteConversation(id) {
    this.conversations.deleteChat(id)
    return true
  }

  saveMessage(msg) {
    if (!msg || !msg.conversationId) return null
    const api = this.getApi()
    const dbManager = getDirectDbManager()
    if (api?.db) {
      api.db.saveMessage({ conversationId: msg.conversationId, role: msg.role, content: msg.content, metadata: msg.metadata || null })
    } else if (dbManager?.db) {
      dbManager.saveMessage({ conversationId: msg.conversationId, role: msg.role, content: msg.content, metadata: msg.metadata || null })
    }
    this.conversations.addMessage(msg)
    return msg
  }

  getMessages(conversationId) {
    const chat = this.getConversation(conversationId)
    if (chat && Array.isArray(chat.messages)) return chat.messages
    const api = this.getApi()
    const dbManager = getDirectDbManager()
    if (api?.db) {
      api.db.getMessages({ conversationId }).then(res => {
        if (res?.success && Array.isArray(res.messages)) return res.messages
      }).catch(() => {})
    } else if (dbManager?.db) {
      const msgs = dbManager.getMessages(conversationId)
      return msgs.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        metadata: m.metadata_json ? JSON.parse(m.metadata_json) : null
      }))
    }
    return []
  }

  saveProjectMemory(memoryRecord) {
    if (!memoryRecord) return null
    this.projects.addRecord(memoryRecord)
    return memoryRecord
  }

  searchProjectMemory(category = null, minConfidence = 0.5) {
    return this.projects.getRecords(category, minConfidence)
  }

  deleteProjectMemory(id) {
    this.projects.records = this.projects.records.filter(r => r.id !== id)
    const api = this.getApi()
    const dbManager = getDirectDbManager()
    if (api?.db) {
      api.db.deleteProjectMemory({ id })
    } else if (dbManager?.db) {
      dbManager.deleteProjectMemory(id)
    }
    this.projects.save()
  }

  saveTask(task) {
    return this.tasks.saveTask(task)
  }

  getTasks() {
    return this.tasks.tasks
  }

  saveExecution(execution) {
    if (!execution || !execution.id) return null
    const api = this.getApi()
    const dbManager = getDirectDbManager()
    if (api?.db && this.workspaceDbId) {
      api.db.createAgentRun({
        id: execution.id,
        workspaceId: this.workspaceDbId,
        userPrompt: execution.userPrompt || '',
        state: execution.state || 'PLANNING'
      })
    } else if (dbManager?.db && this.workspaceDbId) {
      dbManager.createAgentRun({
        id: execution.id,
        workspaceId: this.workspaceDbId,
        userPrompt: execution.userPrompt || '',
        state: execution.state || 'PLANNING'
      })
    }
    this.executions.history.push(execution)
    this.executions.save()
    return execution
  }

  getExecution(runId) {
    const local = this.executions.history.find(e => e.id === runId)
    if (local) return local
    const dbManager = getDirectDbManager()
    if (dbManager?.db) {
      return dbManager.getAgentRun(runId)
    }
    return null
  }

  saveWorkspaceState(state) {
    this.workspaces.save(state)
  }

  getWorkspaceState() {
    return this.workspaces.getState()
  }
}

export const memoryManager = new MemoryManager()
