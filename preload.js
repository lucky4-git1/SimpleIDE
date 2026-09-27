const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  writeFile: (path, content) => ipcRenderer.invoke('write-file', path, content),
  formatCode: (path, content) => ipcRenderer.invoke('format-code', path, content),
  listFiles: (path) => ipcRenderer.invoke('list-files', path),
  searchWorkspace: (params) => ipcRenderer.invoke('search-workspace', params),
  createFile: (path, isDir) => ipcRenderer.invoke('create-file', path, isDir),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),
  deleteFile: (path) => ipcRenderer.invoke('delete-file', path),
  moveFile: (oldPath, newPath) => ipcRenderer.invoke('move-file', oldPath, newPath),
  runCode: (command) => ipcRenderer.invoke('run-code', command),
  runCommand: (params) => ipcRenderer.invoke('run-command', params),
  cancelCommand: (requestId) => ipcRenderer.send('run-command:cancel', requestId),
  startTerminal: (params) => ipcRenderer.invoke('terminal-start', params),
  writeTerminal: (params) => ipcRenderer.invoke('terminal-write', params),
  stopTerminal: (params) => ipcRenderer.invoke('terminal-stop', params),
  onTerminalData: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on('terminal-data', handler)
    return () => ipcRenderer.removeListener('terminal-data', handler)
  },
  startProcess: (params) => ipcRenderer.invoke('process-start', params),
  stopProcess: (id) => ipcRenderer.invoke('process-stop', id),
  restartProcess: (id) => ipcRenderer.invoke('process-restart', id),
  getProcess: (id) => ipcRenderer.invoke('process-get', id),
  listProcesses: () => ipcRenderer.invoke('process-list'),
  readProcessOutput: (params) => ipcRenderer.invoke('process-output', params),
  browserAction: (opts) => ipcRenderer.invoke('browser-action', opts),
  startServer: (folderPath) => ipcRenderer.invoke('start-server', folderPath),
  openInBrowser: (relativePath) => ipcRenderer.invoke('open-in-browser', relativePath),
  aiRequest: (params) => ipcRenderer.invoke('ai-request', params),
  cancelAIRequest: (requestId) => ipcRenderer.send('ai-request:cancel', requestId),
  getAIConfig: () => ipcRenderer.invoke('ai-config:get'),
  saveAIConfig: (config) => ipcRenderer.invoke('ai-config:save', config),
  listModels: (params) => ipcRenderer.invoke('ai-models:list', params),
  startAIStream: (params) => ipcRenderer.send('ai-stream:start', params),
  cancelAIStream: (requestId) => ipcRenderer.send('ai-stream:cancel', requestId),
  onAIStreamEvent: (callback) => {
    const handler = (_, event) => callback(event)
    ipcRenderer.on('ai-stream:event', handler)
    return () => ipcRenderer.removeListener('ai-stream:event', handler)
  },
  watchWorkspace: (folderPath) => ipcRenderer.invoke('watch-workspace', folderPath),
  unwatchWorkspace: () => ipcRenderer.invoke('unwatch-workspace'),
  onWorkspaceChanged: (callback) => {
    const handler = (_, change) => callback(change)
    ipcRenderer.on('workspace-changed', handler)
    return () => ipcRenderer.removeListener('workspace-changed', handler)
  },
  gitStatus: (folderPath) => ipcRenderer.invoke('git-status', folderPath),
  gitStage: (params) => ipcRenderer.invoke('git-stage', params),
  gitUnstage: (params) => ipcRenderer.invoke('git-unstage', params),
  gitCommit: (params) => ipcRenderer.invoke('git-commit', params),
  gitPush: (folderPath) => ipcRenderer.invoke('git-push', folderPath),
  gitPull: (folderPath) => ipcRenderer.invoke('git-pull', folderPath),
  gitDiff: (params) => ipcRenderer.invoke('git-diff', params),
  skills: {
    list: (workspaceId) => ipcRenderer.invoke('skills:list', { workspaceId }),
    get: (id) => ipcRenderer.invoke('skills:get', { id }),
    create: (skill) => ipcRenderer.invoke('skills:create', { skill }),
    update: (id, skill) => ipcRenderer.invoke('skills:update', { id, skill }),
    delete: (id) => ipcRenderer.invoke('skills:delete', { id }),
    enable: (id) => ipcRenderer.invoke('skills:enable', { id }),
    disable: (id) => ipcRenderer.invoke('skills:disable', { id })
    ,recordUsage: (data) => ipcRenderer.invoke('skills:usage', data)
  },

  // Database & Durable Memory APIs
  db: {
    initWorkspace: (params) => ipcRenderer.invoke('db:workspace:init', params),
    getWorkspace: (params) => ipcRenderer.invoke('db:workspace:get', params),
    createConversation: (params) => ipcRenderer.invoke('db:conversations:create', params),
    listConversations: (params) => ipcRenderer.invoke('db:conversations:list', params),
    getConversation: (params) => ipcRenderer.invoke('db:conversations:get', params),
    deleteConversation: (params) => ipcRenderer.invoke('db:conversations:delete', params),
    renameConversation: (params) => ipcRenderer.invoke('db:conversations:rename', params),
    saveMessage: (params) => ipcRenderer.invoke('db:messages:save', params),
    getMessages: (params) => ipcRenderer.invoke('db:messages:get', params),
    replaceMessages: (params) => ipcRenderer.invoke('db:messages:replace', params),
    createAgentRun: (params) => ipcRenderer.invoke('db:agent:createRun', params),
    updateAgentRunState: (params) => ipcRenderer.invoke('db:agent:updateRunState', params),
    getAgentRun: (params) => ipcRenderer.invoke('db:agent:getRun', params),
    listAgentRuns: (params) => ipcRenderer.invoke('db:agent:listRuns', params),
    getUnfinishedRuns: (params) => ipcRenderer.invoke('db:agent:getUnfinished', params),
    logAgentEvent: (params) => ipcRenderer.invoke('db:agent:logEvent', params),
    getAgentEvents: (params) => ipcRenderer.invoke('db:agent:getEvents', params),
    logToolExecution: (params) => ipcRenderer.invoke('db:agent:logTool', params),
    updateToolExecution: (params) => ipcRenderer.invoke('db:agent:updateTool', params),
    getToolExecutions: (params) => ipcRenderer.invoke('db:agent:getTools', params),
    saveTask: (params) => ipcRenderer.invoke('db:tasks:save', params),
    listTasks: (params) => ipcRenderer.invoke('db:tasks:list', params),
    savePlanSteps: (params) => ipcRenderer.invoke('db:plan:saveSteps', params),
    getPlanSteps: (params) => ipcRenderer.invoke('db:plan:getSteps', params),
    logFileChange: (params) => ipcRenderer.invoke('db:changes:log', params),
    getFileChanges: (params) => ipcRenderer.invoke('db:changes:get', params),
    logVerification: (params) => ipcRenderer.invoke('db:verification:log', params),
    getVerifications: (params) => ipcRenderer.invoke('db:verification:get', params),
    saveProjectMemory: (params) => ipcRenderer.invoke('db:memory:saveProject', params),
    searchProjectMemory: (params) => ipcRenderer.invoke('db:memory:searchProject', params),
    deleteProjectMemory: (params) => ipcRenderer.invoke('db:memory:deleteProject', params),
    saveWorkspaceState: (params) => ipcRenderer.invoke('db:workspace:saveState', params),
    getWorkspaceState: (params) => ipcRenderer.invoke('db:workspace:getState', params),
    getStorageStats: () => ipcRenderer.invoke('db:storage:getStats'),
    integrityCheck: () => ipcRenderer.invoke('db:storage:integrityCheck'),
    pruneHistory: (params) => ipcRenderer.invoke('db:storage:prune', params),
    clearAllData: () => ipcRenderer.invoke('db:storage:clearAll')
  },

  conversations: {
    list: (workspaceId) => ipcRenderer.invoke('db:conversations:list', { workspaceId }),
    create: (workspaceId, title) => ipcRenderer.invoke('db:conversations:create', { workspaceId, title }),
    get: (id) => ipcRenderer.invoke('db:conversations:get', { id }),
    delete: (id) => ipcRenderer.invoke('db:conversations:delete', { id }),
    rename: (id, title) => ipcRenderer.invoke('db:conversations:rename', { id, title })
  },

  memory: {
    search: (workspaceId, category, minConfidence) => ipcRenderer.invoke('db:memory:searchProject', { workspaceId, category, minConfidence }),
    save: (memData) => ipcRenderer.invoke('db:memory:saveProject', memData),
    delete: (id) => ipcRenderer.invoke('db:memory:deleteProject', { id })
  },

  agent: {
    getRun: (id) => ipcRenderer.invoke('db:agent:getRun', { id }),
    getEvents: (runId) => ipcRenderer.invoke('db:agent:getEvents', { runId }),
    getUnfinished: (workspaceId) => ipcRenderer.invoke('db:agent:getUnfinished', { workspaceId })
  },

  workspace: {
    getState: (workspaceId) => ipcRenderer.invoke('db:workspace:getState', { workspaceId }),
    saveState: (workspaceId, state) => ipcRenderer.invoke('db:workspace:saveState', { workspaceId, state })
  },

  storage: {
    getStats: () => ipcRenderer.invoke('db:storage:getStats'),
    integrityCheck: () => ipcRenderer.invoke('db:storage:integrityCheck'),
    clearHistory: () => ipcRenderer.invoke('db:storage:prune', { runDays: 0, toolDays: 0, verificationDays: 0 }),
    clearAllData: () => ipcRenderer.invoke('db:storage:clearAll')
  },

  primeRouter: {
    decide: (params) => ipcRenderer.invoke('prime-router:decide', params),
    batchDecide: (items) => ipcRenderer.invoke('prime-router:batch', items),
    getStatus: () => ipcRenderer.invoke('prime-router:status'),
    init: () => ipcRenderer.invoke('prime-router:init')
  }
})
