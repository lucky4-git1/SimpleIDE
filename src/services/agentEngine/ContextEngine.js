import { globalMemory } from './Memory.js'
import { memoryManager } from '../memory/memoryManager.js'
import { ContextPackage } from './ContextPackage.js'
import { ContextRetrievalPipeline } from './ContextRetrievalPipeline.js'
import { ContextBudgetManager } from './ContextBudgetManager.js'
import { ObservationManager } from './ObservationManager.js'
import { PromptContextFormatter } from './PromptContextFormatter.js'

function normalizeWorkspacePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

export class ContextEngine {
  constructor() {
    this.state = {
      workspacePath: null,
      activeFile: null,
      cursorPosition: null,
      selection: null,
      openTabs: [],
      gitBranch: 'main',
      diagnostics: [],
      errors: [],
      recentCommands: [],
      terminalOutput: ''
    }
    this.memory = globalMemory
    this.codeIntelligence = null
    this.fileIndex = null

    this.pipeline = new ContextRetrievalPipeline()
    this.budgetManager = new ContextBudgetManager()
    this.observationManager = new ObservationManager()
  }

  setCodeIntelligence(codeIntelligenceService) {
    this.codeIntelligence = codeIntelligenceService
    this.pipeline.codeIntelligence = codeIntelligenceService
  }

  setFileIndex(fileIndex) {
    this.fileIndex = fileIndex
    this.pipeline.fileIndex = fileIndex
  }

  // ContextEngine is shared by every open workspace.  Clear all derived
  // state when the folder changes so a previous project can never be offered
  // to the next agent run as relevant context.
  resetWorkspace(workspacePath) {
    const previousWorkspace = normalizeWorkspacePath(this.state.workspacePath)
    const nextWorkspace = normalizeWorkspacePath(workspacePath)
    const hasChanged = Boolean(previousWorkspace && nextWorkspace && previousWorkspace !== nextWorkspace)

    if (hasChanged) {
      this.state = {
        workspacePath,
        activeFile: null,
        cursorPosition: null,
        selection: null,
        openTabs: [],
        gitBranch: 'main',
        diagnostics: [],
        errors: [],
        recentCommands: [],
        terminalOutput: ''
      }
      this.codeIntelligence = null
      this.fileIndex = []
      this.pipeline.codeIntelligence = null
      this.pipeline.fileIndex = []
      this.pipeline.clearCache?.()
      this.observationManager.clear()
      return true
    }

    this.state.workspacePath = workspacePath
    return false
  }

  notifyFileChange(filePath, content, operation = 'write') {
    if (this.codeIntelligence) {
      if (operation === 'delete' || content === null || content === undefined) {
        this.codeIntelligence.removeFile(filePath)
      } else {
        this.codeIntelligence.updateFile(filePath, content)
      }
    }
    if (this.pipeline) {
      this.pipeline.invalidateFile(filePath)
      if (this.codeIntelligence?.toRelativePath) {
        this.pipeline.invalidateFile(this.codeIntelligence.toRelativePath(filePath))
      }
    }
  }

  updateState(partialState) {
    this.state = { ...this.state, ...partialState }
  }

  addObservation({ turn, tool, status, summary, details }) {
    return this.observationManager.addObservation({ turn, tool, status, summary, details })
  }

  async buildContextPackage({
    task = '',
    activeFile = this.state.activeFile,
    selection = this.state.selection,
    openTabs = this.state.openTabs,
    diagnostics = [...this.state.diagnostics, ...this.state.errors],
    writtenFiles = new Set(),
    activeFileContent = null,
    totalTokens = 128000
  } = {}) {
    this.budgetManager.configure({ totalTokens })

    // 1. Retrieve raw candidate chunks
    const retrievedChunks = await this.pipeline.retrieveChunks({
      task,
      activeFile,
      selection,
      openTabs,
      diagnostics,
      writtenFiles,
      activeFileContent,
      codeIntelligence: this.codeIntelligence,
      fileIndex: this.fileIndex
    })

    // 2. Add compressed observation chunks
    const obsChunks = this.observationManager.compressObservations()
    const allChunks = [...retrievedChunks, ...obsChunks]

    // 3. Pack chunks according to ContextBudgetManager
    const packed = this.budgetManager.packChunks(allChunks)

    // 4. Construct ContextPackage canonical representation
    const pkg = new ContextPackage({
      task,
      workspace: { path: this.state.workspacePath },
      activeFile,
      selection,
      openTabs,
      includedChunks: packed.includedChunks,
      discardedChunks: packed.discardedChunks,
      tokenBudget: packed.tokenBudget,
      retrievalMetadata: {
        sources: Array.from(new Set(packed.includedChunks.map(c => c.source))),
        rankingMethod: 'STRUCTURAL_LEXICAL_PRIORITY',
        timestamp: Date.now()
      }
    })

    return pkg
  }

  getRelevantCodeStructure({ task, activeFile } = {}) {
    if (!this.codeIntelligence) return null

    const files = new Set()
    const symbols = []

    if (activeFile) {
      files.add(activeFile)
      const fileSyms = this.codeIntelligence.getFileSymbols(activeFile)
      symbols.push(...fileSyms.slice(0, 8))

      const related = this.codeIntelligence.getRelatedFiles(activeFile)
      for (const r of related) files.add(r)
    }

    if (task) {
      const terms = String(task).match(/[a-zA-Z0-9_]{3,}/g) || []
      for (const term of terms.slice(0, 5)) {
        const found = this.codeIntelligence.findSymbols(term)
        for (const sym of found.slice(0, 4)) {
          symbols.push(sym)
          files.add(sym.file)
        }
      }
    }

    const uniqueSymbols = Array.from(new Map(symbols.map(s => [s.id || `${s.file}:${s.name}`, s])).values()).slice(0, 10)

    return {
      files: Array.from(files).slice(0, 10),
      symbols: uniqueSymbols,
      structure: this.codeIntelligence.getProjectStructure()
    }
  }

  async gatherDynamicContext({ task, toolsContext = {}, recentToolResults = [], knowledgeDocs = [] }) {
    const pkg = await this.buildContextPackage({ task })
    return PromptContextFormatter.formatPromptContext(pkg)
  }

  reportError(error) {
    this.state.errors.push(error)
    this.memory.addWorkspaceEvent({ type: 'error', detail: error })
  }

  reportEdit(file, diff) {
    this.memory.addWorkspaceEvent({ type: 'edit', file, diff })
  }
}

export const globalContextEngine = new ContextEngine()
