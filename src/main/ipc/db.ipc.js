import { ipcMain } from 'electron'
import { databaseManager } from '../../../electron/database/DatabaseManager.js'

export function registerDbIPC() {
  // Initialize Database Manager upon startup if needed
  databaseManager.initialize()

  // ── Workspaces ────────────────────────────────────────────────────────────
  ipcMain.handle('db:workspace:init', async (_, { rootPath, name }) => {
    try {
      const workspace = databaseManager.getOrCreateWorkspace(rootPath, name)
      return { success: true, workspace }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:workspace:get', async (_, { rootPath }) => {
    try {
      const workspace = databaseManager.getWorkspaceByPath(rootPath)
      return { success: true, workspace }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ── Conversations ─────────────────────────────────────────────────────────
  ipcMain.handle('db:conversations:create', async (_, { workspaceId, title, id }) => {
    try {
      const conversation = databaseManager.createConversation({ id, workspaceId, title })
      return { success: true, conversation }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:conversations:list', async (_, { workspaceId }) => {
    try {
      const conversations = databaseManager.listConversations(workspaceId)
      return { success: true, conversations }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:conversations:get', async (_, { id }) => {
    try {
      const conversation = databaseManager.getConversation(id)
      return { success: true, conversation }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:conversations:delete', async (_, { id }) => {
    try {
      databaseManager.deleteConversation(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:conversations:rename', async (_, { id, title }) => {
    try {
      databaseManager.renameConversation(id, title)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ── Messages ──────────────────────────────────────────────────────────────
  ipcMain.handle('db:messages:save', async (_, messageData) => {
    try {
      const message = databaseManager.saveMessage(messageData)
      return { success: true, message }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:messages:get', async (_, { conversationId }) => {
    try {
      const messages = databaseManager.getMessages(conversationId)
      return { success: true, messages }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:messages:replace', async (_, { conversationId, messages }) => {
    try {
      databaseManager.replaceMessages(conversationId, messages)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ── Agent Runs ────────────────────────────────────────────────────────────
  ipcMain.handle('db:agent:createRun', async (_, runData) => {
    try {
      const run = databaseManager.createAgentRun(runData)
      return { success: true, run }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:agent:updateRunState', async (_, { id, state, error, completedAt }) => {
    try {
      databaseManager.updateAgentRunState(id, state, { error, completedAt })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('db:agent:getRun', async (_, { id }) => {
    try {
      const run = databaseManager.getAgentRun(id)
      return { success: true, run }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:agent:listRuns', async (_, { workspaceId }) => {
    try {
      const runs = databaseManager.listAgentRuns(workspaceId)
      return { success: true, runs }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:agent:getUnfinished', async (_, { workspaceId }) => {
    try {
      const runs = databaseManager.getUnfinishedAgentRuns(workspaceId)
      return { success: true, runs }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ── Agent Events ──────────────────────────────────────────────────────────
  ipcMain.handle('db:agent:logEvent', async (_, eventData) => {
    try {
      const event = databaseManager.logAgentEvent(eventData)
      return { success: true, event }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:agent:getEvents', async (_, { runId }) => {
    try {
      const events = databaseManager.getAgentEvents(runId)
      return { success: true, events }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ── Tool Executions ───────────────────────────────────────────────────────
  ipcMain.handle('db:agent:logTool', async (_, toolData) => {
    try {
      const execution = databaseManager.logToolExecution(toolData)
      return { success: true, execution }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:agent:updateTool', async (_, { id, result, status, error }) => {
    try {
      databaseManager.updateToolExecution(id, { result, status, error })
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('db:agent:getTools', async (_, { runId }) => {
    try {
      const executions = databaseManager.getToolExecutions(runId)
      return { success: true, executions }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ── Tasks & Plan Steps ────────────────────────────────────────────────────
  ipcMain.handle('db:tasks:save', async (_, taskData) => {
    try {
      const task = databaseManager.saveTask(taskData)
      return { success: true, task }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:tasks:list', async (_, { workspaceId }) => {
    try {
      const tasks = databaseManager.getTasks(workspaceId)
      return { success: true, tasks }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:plan:saveSteps', async (_, { runId, steps }) => {
    try {
      const savedSteps = databaseManager.savePlanSteps(runId, steps)
      return { success: true, steps: savedSteps }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:plan:getSteps', async (_, { runId }) => {
    try {
      const steps = databaseManager.getPlanSteps(runId)
      return { success: true, steps }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ── File Changes & Verification ───────────────────────────────────────────
  ipcMain.handle('db:changes:log', async (_, changeData) => {
    try {
      const change = databaseManager.logFileChange(changeData)
      return { success: true, change }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:changes:get', async (_, { runId }) => {
    try {
      const changes = databaseManager.getFileChanges(runId)
      return { success: true, changes }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:verification:log', async (_, verData) => {
    try {
      const ver = databaseManager.logVerificationResult(verData)
      return { success: true, verification: ver }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:verification:get', async (_, { runId }) => {
    try {
      const verifications = databaseManager.getVerificationResults(runId)
      return { success: true, verifications }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ── Project Memory & Workspace State ─────────────────────────────────────
  ipcMain.handle('db:memory:saveProject', async (_, memData) => {
    try {
      const memory = databaseManager.saveProjectMemory(memData)
      return { success: true, memory }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:memory:searchProject', async (_, { workspaceId, category, minConfidence }) => {
    try {
      const memories = databaseManager.searchProjectMemory(workspaceId, category, minConfidence)
      return { success: true, memories }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:memory:deleteProject', async (_, { id }) => {
    try {
      databaseManager.deleteProjectMemory(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:workspace:saveState', async (_, { workspaceId, state }) => {
    try {
      databaseManager.saveWorkspaceState(workspaceId, state)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:workspace:getState', async (_, { workspaceId }) => {
    try {
      const state = databaseManager.getWorkspaceState(workspaceId)
      return { success: true, state }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ── Health & Storage Stats ────────────────────────────────────────────────
  ipcMain.handle('db:storage:getStats', async () => {
    try {
      const stats = databaseManager.getStats()
      return { success: true, stats }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:storage:integrityCheck', async () => {
    try {
      const check = databaseManager.integrityCheck()
      return { success: true, check }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:storage:prune', async (_, options) => {
    try {
      databaseManager.pruneHistory(options)
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('db:storage:clearAll', async () => {
    try {
      databaseManager.clearAllData()
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}
