export class ContextPackage {
  constructor({
    task = '',
    workspace = {},
    activeFile = null,
    selection = null,
    openTabs = [],

    relevantFiles = [],
    relevantSymbols = [],
    dependencies = [],
    diagnostics = [],
    observations = [],
    memory = [],
    documentation = [],

    includedChunks = [],
    discardedChunks = [],

    tokenBudget = {
      total: 128000,
      reservedOutput: 4096,
      used: 0,
      remaining: 123904
    },

    retrievalMetadata = {
      sources: [],
      rankingMethod: 'STRUCTURAL_LEXICAL_PRIORITY',
      timestamp: Date.now()
    }
  }) {
    this.task = task
    this.workspace = workspace
    this.activeFile = activeFile
    this.selection = selection
    this.openTabs = Array.isArray(openTabs) ? openTabs : []

    this.relevantFiles = relevantFiles
    this.relevantSymbols = relevantSymbols
    this.dependencies = dependencies
    this.diagnostics = diagnostics
    this.observations = observations
    this.memory = memory
    this.documentation = documentation

    this.includedChunks = includedChunks
    this.discardedChunks = discardedChunks

    this.tokenBudget = tokenBudget
    this.retrievalMetadata = retrievalMetadata
  }
}
