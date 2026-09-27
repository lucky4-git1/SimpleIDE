import { memoryManager } from '../memory/memoryManager.js'

export class Memory {
  constructor() {
    // Legacy stub properties mapped to memoryManager if needed
  }

  addConversation(message) {
    // Deprecated: Chat history now managed via AIPanel and conversationMemory.js
  }

  addWorkspaceEvent(event) {
    memoryManager.workspaces.events.push({ timestamp: Date.now(), ...event })
    memoryManager.workspaces.save()
  }

  addExecution(execution) {
    memoryManager.executions.history.push(execution)
    memoryManager.executions.save()
  }

  addKnowledge(fact) {
    if (!memoryManager.projects.data.architecture.includes(fact)) {
      memoryManager.projects.data.architecture.push(fact)
      memoryManager.projects.save()
    }
  }

  getRecentEdits() {
    return memoryManager.workspaces.events.filter(e => e.type === 'edit')
  }

  getRecentFailures() {
    return memoryManager.executions.history.filter(e => e.status === 'failed')
  }
}

export const globalMemory = new Memory()
