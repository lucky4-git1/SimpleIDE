function getDirectDbManager() {
  if (typeof window !== 'undefined') return null
  return globalThis.__nodeDbManager || null
}

function normalizeSlashes(path) {
  return String(path || '').replace(/\\/g, '/').toLowerCase()
}

function titleFromMessages(messages = []) {
  const firstUserMessage = messages.find(message => message?.role === 'user' && String(message.content || '').trim())
  if (!firstUserMessage) return 'New Chat'
  const text = String(firstUserMessage.content).replace(/\s+/g, ' ').trim()
  return text.length > 42 ? `${text.slice(0, 42).trimEnd()}…` : text
}

const MAX_STORED_TOOLS = 100
const MAX_AGENT_TEXT = 12000

function sanitizeAgentRun(agentRun) {
  if (!agentRun || typeof agentRun !== 'object') return null
  return {
    ...agentRun,
    summary: String(agentRun.summary || '').slice(0, MAX_AGENT_TEXT),
    plan: String(agentRun.plan || '').slice(0, MAX_AGENT_TEXT),
    task: String(agentRun.task || '').slice(0, 2000),
    tools: Array.isArray(agentRun.tools) ? agentRun.tools.slice(-MAX_STORED_TOOLS) : [],
    changedFiles: Array.isArray(agentRun.changedFiles) ? agentRun.changedFiles.slice(0, 50) : [],
    todos: Array.isArray(agentRun.todos) ? agentRun.todos.slice(0, 20) : [],
    checkpoint: agentRun.checkpoint && typeof agentRun.checkpoint === 'object'
      ? agentRun.checkpoint
      : null
  }
}

function migrateChat(chat) {
  if (!chat || typeof chat !== 'object') return chat
  chat.messages = Array.isArray(chat.messages) ? chat.messages : []
  if (!chat.title || chat.title === 'New Chat') chat.title = titleFromMessages(chat.messages)
  if (!('agentRun' in chat)) chat.agentRun = null
  if (!('planDraft' in chat)) chat.planDraft = ''
  if (!('lastChange' in chat)) chat.lastChange = null
  return chat
}

export class ConversationMemory {
  constructor(storageKey = 'prime_ai_conversations') {
    this.storageKey = storageKey
    this.chats = []
    this.activeChatId = null
    this.workspaceRoot = null
    this.workspaceDbId = null
    this.listeners = new Set()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  _notify() {
    for (const listener of this.listeners) {
      try { listener(this.getChats(), this.activeChatId) } catch { /* UI listeners are optional */ }
    }
  }

  getApi() {
    return globalThis.window?.api
  }

  load(workspaceRoot) {
    this.workspaceRoot = normalizeSlashes(workspaceRoot)
    if (!this.workspaceRoot) return

    const api = this.getApi()
    const dbManager = getDirectDbManager()

    // Keep the last complete renderer snapshot available while SQLite opens.
    // Older app versions wrote only the final bubble to SQLite, so replacing
    // this cache with an incomplete DB result used to make whole chats vanish.
    this._loadFallback({ createIfEmpty: false })

    // 1. Try SQLite initialization & loading
    try {
      if (api?.db) {
        // Via Electron IPC
        api.db.initWorkspace({ rootPath: this.workspaceRoot }).then(res => {
          if (res?.success && res?.workspace) {
            this.workspaceDbId = res.workspace.id
            this._migrateLegacyStorage()
            this._syncFromDb()
          }
        }).catch(() => this._loadFallback())
      } else if (dbManager) {
        // Direct Node / Test env
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
    const migratedKey = `prime_ai_sqlite_migrated_conversations_${this.workspaceRoot}`

    try {
      if (typeof localStorage === 'undefined') return
      if (localStorage.getItem(migratedKey)) return

      const legacyData = localStorage.getItem(key)
      if (!legacyData) {
        localStorage.setItem(migratedKey, 'true')
        return
      }

      const legacyChats = JSON.parse(legacyData).map(migrateChat)
      const api = this.getApi()
      const dbManager = getDirectDbManager()

      for (const chat of legacyChats) {
        if (api?.db && this.workspaceDbId) {
          api.db.createConversation({ id: chat.id, workspaceId: this.workspaceDbId, title: chat.title })
          if (Array.isArray(chat.messages)) {
            for (const msg of chat.messages) {
              api.db.saveMessage({ conversationId: chat.id, role: msg.role, content: msg.content, metadata: msg.metadata || null })
            }
          }
        } else if (dbManager?.db && this.workspaceDbId) {
          dbManager.createConversation({ id: chat.id, workspaceId: this.workspaceDbId, title: chat.title })
          if (Array.isArray(chat.messages)) {
            for (const msg of chat.messages) {
              dbManager.saveMessage({ conversationId: chat.id, role: msg.role, content: msg.content, metadata: msg.metadata || null })
            }
          }
        }
      }

      localStorage.setItem(migratedKey, 'true')
    } catch (err) {
      console.warn('Failed legacy conversation migration', err)
    }
  }

  _syncFromDbSync() {
    const dbManager = getDirectDbManager()
    if (!this.workspaceDbId || !dbManager?.db) return
    try {
      const dbConvs = dbManager.listConversations(this.workspaceDbId)
      this.chats = dbConvs.map(conv => {
        const msgs = dbManager.getMessages(conv.id)
        return {
          id: conv.id,
          title: conv.title || 'New Chat',
          createdAt: conv.created_at,
          updatedAt: conv.updated_at,
          messages: msgs.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            metadata: m.metadata_json ? JSON.parse(m.metadata_json) : null
          })),
          agentRun: null,
          planDraft: '',
          lastChange: null
        }
      })

      if (this.chats.length === 0) {
        this.createNewChat()
      } else {
        const sorted = this.getChats()
        this.activeChatId = sorted[0].id
      }
      this._notify()
    } catch (e) {
      console.warn('Sync from DB sync failed:', e)
      this._loadFallback()
    }
  }

  async _syncFromDb() {
    const api = this.getApi()
    if (!api?.db || !this.workspaceDbId) return
    try {
      const res = await api.db.listConversations({ workspaceId: this.workspaceDbId })
      if (res?.success && Array.isArray(res.conversations)) {
        const chatsList = []
        for (const conv of res.conversations) {
          const msgRes = await api.db.getMessages({ conversationId: conv.id })
          const msgs = (msgRes?.success && Array.isArray(msgRes.messages)) ? msgRes.messages : []
          chatsList.push({
            id: conv.id,
            title: conv.title || 'New Chat',
            createdAt: conv.created_at,
            updatedAt: conv.updated_at,
            messages: msgs.map(m => ({
              id: m.id,
              role: m.role,
              content: m.content,
              metadata: m.metadata_json ? JSON.parse(m.metadata_json) : null
            })),
            agentRun: null,
            planDraft: '',
            lastChange: null
          })
        }
        const cachedById = new Map(this.chats.map(chat => [chat.id, chat]))
        const dbIds = new Set(chatsList.map(chat => chat.id))
        this.chats = chatsList.map(chat => {
          const cached = cachedById.get(chat.id)
          const dbIsIncomplete = cached && (
            (cached.messages?.length || 0) > (chat.messages?.length || 0) ||
            Number(cached.updatedAt || 0) > Number(chat.updatedAt || 0)
          )
          if (!dbIsIncomplete) return chat

          // Backfill the durable store from the complete local snapshot. This
          // is deliberately non-blocking; the cache remains usable either way.
          api.db.replaceMessages?.({ conversationId: chat.id, messages: cached.messages || [] })
          return { ...chat, ...cached, messages: cached.messages || [] }
        })

        // If SQLite was unavailable when a chat was first created, preserve
        // that cache and seed it now rather than discarding it at startup.
        for (const cached of cachedById.values()) {
          if (dbIds.has(cached.id)) continue
          this.chats.push(cached)
          api.db.createConversation({ id: cached.id, workspaceId: this.workspaceDbId, title: cached.title })
            .then(result => {
              if (result?.success) {
                return api.db.replaceMessages?.({ conversationId: cached.id, messages: cached.messages || [] })
              }
            })
            .catch(() => {})
        }
        if (this.chats.length === 0) {
          this.createNewChat()
        } else {
          const sorted = this.getChats()
          if (!this.activeChatId || !this.chats.some(c => c.id === this.activeChatId)) {
            this.activeChatId = sorted[0].id
          }
        }
        this._notify()
      }
    } catch (e) {
      console.warn('Sync from DB failed:', e)
    }
  }

  _loadFallback({ createIfEmpty = true } = {}) {
    try {
      if (typeof localStorage !== 'undefined') {
        const data = localStorage.getItem(`${this.storageKey}_${this.workspaceRoot}`)
        this.chats = data ? JSON.parse(data).map(migrateChat) : []
      } else {
        this.chats = []
      }
    } catch {
      this.chats = []
    }

    if (this.chats.length === 0 && createIfEmpty) {
      this.createNewChat()
    } else if (this.chats.length > 0) {
      const sorted = this.getChats()
      this.activeChatId = sorted[0].id
    }
    this._notify()
  }

  save() {
    if (!this.workspaceRoot) return
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${this.storageKey}_${this.workspaceRoot}`, JSON.stringify(this.chats))
      }
    } catch (e) {
      console.warn('Failed to save conversations to localStorage fallback', e)
    }
  }

  createNewChat() {
    const newChat = {
      id: crypto.randomUUID(),
      title: 'New Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      agentRun: null,
      planDraft: '',
      lastChange: null
    }
    this.chats.push(newChat)
    this.activeChatId = newChat.id

    const api = this.getApi()
    const dbManager = getDirectDbManager()

    if (api?.db && this.workspaceDbId) {
      api.db.createConversation({ id: newChat.id, workspaceId: this.workspaceDbId, title: newChat.title })
    } else if (dbManager?.db && this.workspaceDbId) {
      dbManager.createConversation({ id: newChat.id, workspaceId: this.workspaceDbId, title: newChat.title })
    }

    this.save()
    this._notify()
    return newChat
  }

  getChats() {
    return [...this.chats].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getActiveChat() {
    return this.chats.find(c => c.id === this.activeChatId) || null
  }

  setActiveChat(id) {
    if (this.chats.some(c => c.id === id)) {
      this.activeChatId = id
      this.save()
      this._notify()
    }
  }

  deleteChat(id) {
    this.chats = this.chats.filter(c => c.id !== id)

    const api = this.getApi()
    const dbManager = getDirectDbManager()

    if (api?.db) {
      api.db.deleteConversation({ id })
    } else if (dbManager?.db) {
      dbManager.deleteConversation(id)
    }

    if (this.chats.length === 0) {
      this.createNewChat()
    } else if (this.activeChatId === id) {
      this.activeChatId = this.getChats()[0].id
    }
    this.save()
    this._notify()
  }

  renameChat(id, newTitle) {
    const chat = this.chats.find(c => c.id === id)
    if (chat) {
      chat.title = newTitle
      chat.updatedAt = Date.now()

      const api = this.getApi()
      const dbManager = getDirectDbManager()

      if (api?.db) {
        api.db.renameConversation({ id, title: newTitle })
      } else if (dbManager?.db) {
        dbManager.renameConversation(id, newTitle)
      }

      this.save()
      this._notify()
    }
  }

  addMessage(message) {
    const chat = this.getActiveChat()
    if (!chat) return

    chat.messages.push(message)
    chat.updatedAt = Date.now()

    if (chat.title === 'New Chat' && message.role === 'user') {
      chat.title = titleFromMessages(chat.messages)
      this.renameChat(chat.id, chat.title)
    }

    const api = this.getApi()
    const dbManager = getDirectDbManager()

    if (api?.db) {
      api.db.saveMessage({ conversationId: chat.id, role: message.role, content: message.content, metadata: message.metadata || null })
    } else if (dbManager?.db) {
      dbManager.saveMessage({ conversationId: chat.id, role: message.role, content: message.content, metadata: message.metadata || null })
    }

    this.save()
    this._notify()
  }

  setMessages(messages, chatId) {
    const chat = chatId ? this.chats.find(c => c.id === chatId) : this.getActiveChat()
    if (!chat) return
    const next = Array.isArray(messages) ? messages : []
    try {
      if (JSON.stringify(chat.messages) === JSON.stringify(next)) return
    } catch { /* fall through and save */ }

    chat.messages = next
    if (chat.title === 'New Chat') chat.title = titleFromMessages(next)
    chat.updatedAt = Date.now()

    const api = this.getApi()
    const dbManager = getDirectDbManager()

    if (api?.db) {
      // Persist a full snapshot. Saving only the latest streaming bubble made
      // SQLite an incomplete source of truth after an app restart.
      api.db.replaceMessages?.({ conversationId: chat.id, messages: next })
    } else if (dbManager?.db) {
      dbManager.replaceMessages(chat.id, next)
    }

    this.save()
  }

  setAgentState(chatId, { agentRun, planDraft, lastChange } = {}, { touch = true } = {}) {
    const chat = this.chats.find(c => c.id === chatId)
    if (!chat) return
    let changed = false
    if (agentRun !== undefined) {
      const sanitized = sanitizeAgentRun(agentRun)
      try {
        changed = changed || JSON.stringify(chat.agentRun) !== JSON.stringify(sanitized)
      } catch { changed = true }
      chat.agentRun = sanitized
    }
    if (planDraft !== undefined) {
      const text = String(planDraft || '').slice(0, MAX_AGENT_TEXT)
      changed = changed || chat.planDraft !== text
      chat.planDraft = text
    }
    if (lastChange !== undefined) {
      try {
        changed = changed || JSON.stringify(chat.lastChange) !== JSON.stringify(lastChange)
      } catch { changed = true }
      chat.lastChange = lastChange
    }
    if (!changed) return
    if (touch) chat.updatedAt = Date.now()
    this.save()
    this._notify()
  }

  getAgentState(chatId) {
    const chat = this.chats.find(c => c.id === chatId)
    if (!chat) return null
    return { agentRun: chat.agentRun || null, planDraft: chat.planDraft || '', lastChange: chat.lastChange || null }
  }

  searchChats(query) {
    if (!query) return this.getChats()
    const q = query.toLowerCase()
    return this.chats.filter(chat =>
      chat.title.toLowerCase().includes(q) ||
      chat.messages.some(m => String(m.content || '').toLowerCase().includes(q))
    ).sort((a, b) => b.updatedAt - a.updatedAt)
  }
}
