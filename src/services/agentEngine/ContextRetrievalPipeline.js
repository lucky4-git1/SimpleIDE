import { ContextChunk, CHUNK_TYPES, CHUNK_PRIORITY, estimateTokens } from './ContextChunk.js'
import { selectRelevantFiles } from '../fileIndex.js'
import { memoryManager } from '../memory/memoryManager.js'

function extractSourceRange(source, startLine = 1, endLine = 1, windowBefore = 5, windowAfter = 15) {
  if (!source || typeof source !== 'string') return ''
  const lines = source.split('\n')
  const total = lines.length
  const from = Math.max(1, startLine - windowBefore)
  const to = Math.min(total, endLine + windowAfter)

  if (from === 1 && to === total) return source

  const sliced = lines.slice(from - 1, to)
  return `// Lines ${from}-${to} of ${total}\n` + sliced.join('\n')
}

export class ContextRetrievalPipeline {
  constructor({ codeIntelligence = null, fileIndex = null } = {}) {
    this.codeIntelligence = codeIntelligence
    this.fileIndex = fileIndex
    this.chunkCache = new Map() // path -> { hash/content, chunk }
  }

  invalidateFile(path) {
    if (path) {
      this.chunkCache.delete(path)
    }
  }

  clearCache() {
    this.chunkCache.clear()
  }

  async retrieveChunks({
    task = '',
    activeFile = null,
    selection = null,
    openTabs = [],
    diagnostics = [],
    writtenFiles = new Set(),
    activeFileContent = null,
    codeIntelligence = null,
    fileIndex = null,
    graphDepth = 1,
    symbolQuery = null
  } = {}) {
    const codeIntel = codeIntelligence || this.codeIntelligence
    const index = fileIndex || this.fileIndex

    // Invalidate cache for edited files
    for (const file of writtenFiles) {
      this.invalidateFile(file)
    }

    const rawChunks = []

    // 1. ACTIVE FILE & SELECTION (CRITICAL / HIGH Priority)
    if (activeFile && activeFileContent) {
      if (selection) {
        rawChunks.push(new ContextChunk({
          id: `selection:${activeFile}`,
          type: CHUNK_TYPES.SELECTION,
          source: activeFile,
          path: activeFile,
          content: `Selection in ${activeFile}:\n${selection}`,
          summary: `Selected code in ${activeFile}`,
          score: 1.0,
          priority: CHUNK_PRIORITY.CRITICAL,
          metadata: { activeFile, selection }
        }))
      }

      rawChunks.push(new ContextChunk({
        id: `active:${activeFile}`,
        type: CHUNK_TYPES.ACTIVE_FILE,
        source: activeFile,
        path: activeFile,
        content: activeFileContent.length > 3000
          ? extractSourceRange(activeFileContent, 1, 100, 0, 50)
          : activeFileContent,
        summary: `Active editor file ${activeFile}`,
        score: 1.0,
        priority: CHUNK_PRIORITY.HIGH,
        metadata: { activeFile }
      }))
    }

    // 2. DIAGNOSTIC FILES (CRITICAL Priority)
    if (diagnostics.length > 0) {
      const diagText = diagnostics.map(d => typeof d === 'string' ? d : `${d.file || ''}: ${d.message || d}`).join('\n')
      rawChunks.push(new ContextChunk({
        id: 'diagnostics:current',
        type: CHUNK_TYPES.DIAGNOSTIC,
        source: 'diagnostics',
        content: `[Active Diagnostics]\n${diagText}`,
        summary: 'Active compiler/linter diagnostics',
        score: 0.95,
        priority: CHUNK_PRIORITY.CRITICAL
      }))
    }

    // 3. INTELLIGENT CONTEXT GRAPH TRAVERSAL (Prioritizing 1 through 9)
    const taskTerms = String(task).match(/[a-zA-Z0-9_]{3,}/g) || []
    const graphFiles = new Set()
    if (activeFile) graphFiles.add(activeFile)

    if (codeIntel) {
      const candidateSymbols = new Set()
      if (symbolQuery) {
        candidateSymbols.add(String(symbolQuery).trim())
      }

      // Check task terms for exact symbol matches
      for (const term of taskTerms.slice(0, 8)) {
        const matches = codeIntel.findSymbols(term)
        if (matches && matches.length > 0) {
          candidateSymbols.add(term)
        }
      }

      const foundSymbols = new Map()
      for (const symName of candidateSymbols) {
        const matches = codeIntel.findSymbols(symName)
        for (const sym of matches.slice(0, 4)) {
          if (!foundSymbols.has(sym.id)) {
            foundSymbols.set(sym.id, sym)
          }
        }
      }

      // If symbol graph is available, perform intelligent context graph traversal
      if (codeIntel.symbolGraph && (foundSymbols.size > 0 || activeFile)) {
        const targetQueries = []
        if (symbolQuery) targetQueries.push(symbolQuery)
        for (const sym of foundSymbols.values()) {
          targetQueries.push(sym.name)
        }
        if (activeFile) targetQueries.push(activeFile)

        const graphResult = codeIntel.symbolGraph.traverseContextGraph(targetQueries, { maxDepth: graphDepth })
        const { categories } = graphResult

        // 1. Current Symbol
        for (const sym of foundSymbols.values()) {
          if (sym.file) graphFiles.add(sym.file)
          rawChunks.push(new ContextChunk({
            id: `symbol:${sym.file}:${sym.name}`,
            type: CHUNK_TYPES.SYMBOL,
            source: sym.file,
            path: sym.file,
            content: `${sym.kind} ${sym.name} (${sym.file}:${sym.startLine}-${sym.endLine})\nSignature: ${sym.signature}`,
            summary: `Symbol ${sym.name} (${sym.kind}) in ${sym.file}`,
            score: 0.90,
            priority: CHUNK_PRIORITY.CRITICAL,
            metadata: { symbol: sym.name, kind: sym.kind, line: sym.startLine, relation: 'current_symbol' }
          }))
        }

        // 2. Definition
        for (const def of categories.definitions || []) {
          if (def.file) graphFiles.add(def.file)
          if (!foundSymbols.has(`${def.file}:${def.name}`)) {
            rawChunks.push(new ContextChunk({
              id: `definition:${def.file}:${def.name}`,
              type: CHUNK_TYPES.DEFINITION,
              source: def.file,
              path: def.file,
              content: `Definition of ${def.name} in ${def.file}:${def.line || 1}`,
              summary: `Definition ${def.name} in ${def.file}`,
              score: 0.98,
              priority: CHUNK_PRIORITY.CRITICAL,
              metadata: { symbol: def.name, file: def.file, line: def.line, relation: 'definition' }
            }))
          }
        }

        // 3. Direct References
        for (const ref of categories.references || []) {
          if (ref.file) graphFiles.add(ref.file)
          rawChunks.push(new ContextChunk({
            id: `reference:${ref.file}:${ref.name}`,
            type: CHUNK_TYPES.REFERENCE,
            source: ref.file,
            path: ref.file,
            content: `Reference to symbol in ${ref.file}:${ref.line || 1} (${ref.name})`,
            summary: `Direct reference in ${ref.file}`,
            score: 0.88,
            priority: CHUNK_PRIORITY.HIGH,
            metadata: { symbol: ref.name, file: ref.file, relation: 'reference' }
          }))
        }

        // 4. Callers
        for (const caller of categories.callers || []) {
          if (caller.file) graphFiles.add(caller.file)
          rawChunks.push(new ContextChunk({
            id: `caller:${caller.file}:${caller.name}`,
            type: CHUNK_TYPES.CALLER,
            source: caller.file,
            path: caller.file,
            content: `Caller function ${caller.name} in ${caller.file}:${caller.line || 1} (distance ${caller.graphDistance})`,
            summary: `Caller ${caller.name} in ${caller.file}`,
            score: caller.score || 0.85,
            priority: CHUNK_PRIORITY.HIGH,
            metadata: { symbol: caller.name, file: caller.file, relation: 'caller', graphDistance: caller.graphDistance }
          }))
        }

        // 5. Callees
        for (const callee of categories.callees || []) {
          if (callee.file) graphFiles.add(callee.file)
          rawChunks.push(new ContextChunk({
            id: `callee:${callee.file}:${callee.name}`,
            type: CHUNK_TYPES.CALLEE,
            source: callee.file,
            path: callee.file,
            content: `Callee function ${callee.name} in ${callee.file}:${callee.line || 1}`,
            summary: `Callee ${callee.name} in ${callee.file}`,
            score: 0.84,
            priority: CHUNK_PRIORITY.HIGH,
            metadata: { symbol: callee.name, file: callee.file, relation: 'callee' }
          }))
        }

        // 6. Related Tests
        for (const testItem of categories.tests || []) {
          if (testItem.file) graphFiles.add(testItem.file)
          rawChunks.push(new ContextChunk({
            id: `test:${testItem.file}:${testItem.name}`,
            type: CHUNK_TYPES.TEST,
            source: testItem.file,
            path: testItem.file,
            content: `Related test file: ${testItem.file}`,
            summary: `Test suite ${testItem.file}`,
            score: 0.80,
            priority: CHUNK_PRIORITY.HIGH,
            metadata: { file: testItem.file, relation: 'test' }
          }))
        }

        // 7. Imports / Dependencies
        const seedFiles = new Set()
        if (activeFile) seedFiles.add(activeFile)
        for (const sym of foundSymbols.values()) {
          if (sym.file) seedFiles.add(sym.file)
        }
        for (const imp of categories.imports || []) {
          if (imp.file) seedFiles.add(imp.file)
        }

        const addedDepFiles = new Set()
        for (const seed of seedFiles) {
          const related = codeIntel.getRelatedFiles(seed) || []
          for (const relPath of related.slice(0, Math.min(6, graphDepth * 6))) {
            if (addedDepFiles.has(relPath)) continue
            addedDepFiles.add(relPath)
            graphFiles.add(relPath)
            const imports = codeIntel.getImports(relPath) || []
            const exports = codeIntel.getExports(relPath) || []
            const impSummary = imports.map(i => i.source).join(', ')
            const expSummary = exports.map(e => e.name).join(', ')

            rawChunks.push(new ContextChunk({
              id: `dependency:${relPath}`,
              type: CHUNK_TYPES.DEPENDENCY,
              source: relPath,
              path: relPath,
              content: `Related dependency file: ${relPath}\nExports: ${expSummary || 'none'}\nImports: ${impSummary || 'none'}`,
              summary: `Dependency file ${relPath}`,
              score: 0.80,
              priority: CHUNK_PRIORITY.HIGH,
              metadata: { relatedTo: activeFile }
            }))
          }
        }

        // 8. Configuration
        for (const cfg of categories.configs || []) {
          if (cfg.file) graphFiles.add(cfg.file)
          rawChunks.push(new ContextChunk({
            id: `config:${cfg.file || cfg.name}`,
            type: CHUNK_TYPES.CONFIG,
            source: cfg.file || cfg.name,
            path: cfg.file || cfg.name,
            content: `Related configuration file: ${cfg.file || cfg.name}`,
            summary: `Config file ${cfg.file || cfg.name}`,
            score: 0.72,
            priority: CHUNK_PRIORITY.MEDIUM,
            metadata: { file: cfg.file, relation: 'configuration' }
          }))
        }

        // 9. Documentation
        for (const doc of categories.docs || []) {
          if (doc.file) graphFiles.add(doc.file)
          rawChunks.push(new ContextChunk({
            id: `doc:${doc.file || doc.name}`,
            type: CHUNK_TYPES.DOCUMENTATION,
            source: doc.file || doc.name,
            path: doc.file || doc.name,
            content: `Related documentation: ${doc.file || doc.name}`,
            summary: `Documentation ${doc.file || doc.name}`,
            score: 0.65,
            priority: CHUNK_PRIORITY.MEDIUM,
            metadata: { file: doc.file, relation: 'documentation' }
          }))
        }
      } else {
        // Fallback when symbolGraph is not populated
        for (const sym of foundSymbols.values()) {
          rawChunks.push(new ContextChunk({
            id: `symbol:${sym.file}:${sym.name}`,
            type: CHUNK_TYPES.SYMBOL,
            source: sym.file,
            path: sym.file,
            content: `${sym.kind} ${sym.name} (${sym.file}:${sym.startLine}-${sym.endLine})\nSignature: ${sym.signature}`,
            summary: `Symbol ${sym.name} (${sym.kind}) in ${sym.file}`,
            score: 0.90,
            priority: CHUNK_PRIORITY.CRITICAL,
            metadata: { symbol: sym.name, kind: sym.kind, line: sym.startLine }
          }))
        }

        const seedFiles = new Set()
        if (activeFile) seedFiles.add(activeFile)
        for (const sym of foundSymbols.values()) {
          if (sym.file) seedFiles.add(sym.file)
        }

        for (const seed of seedFiles) {
          const related = codeIntel.getRelatedFiles(seed) || []
          for (const relPath of related.slice(0, Math.min(6, graphDepth * 6))) {
            const imports = codeIntel.getImports(relPath) || []
            const exports = codeIntel.getExports(relPath) || []
            const impSummary = imports.map(i => i.source).join(', ')
            const expSummary = exports.map(e => e.name).join(', ')

            rawChunks.push(new ContextChunk({
              id: `dependency:${relPath}`,
              type: CHUNK_TYPES.DEPENDENCY,
              source: relPath,
              path: relPath,
              content: `Related dependency file: ${relPath}\nExports: ${expSummary || 'none'}\nImports: ${impSummary || 'none'}`,
              summary: `Dependency file ${relPath}`,
              score: 0.80,
              priority: CHUNK_PRIORITY.HIGH,
              metadata: { relatedTo: activeFile }
            }))
          }
        }
      }
    }

    // 10. LEXICAL FILE SEARCH (Broader Repository Search Fallback)
    if (index) {
      const fileList = Array.isArray(index) ? index : (Array.isArray(index.files) ? index.files : [])
      if (fileList.length > 0) {
        // Expand search query with sub-terms from camelCase symbols (e.g. generateToken -> generate, token)
        const expandedTerms = new Set(taskTerms)
        for (const t of taskTerms) {
          const subWords = t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]/).filter(w => w.length >= 3)
          for (const sw of subWords) expandedTerms.add(sw)
        }
        const lexicalQuery = Array.from(expandedTerms).join(' ')
        const lexicalMatches = selectRelevantFiles(fileList, lexicalQuery) || []
        for (const item of lexicalMatches.slice(0, 5)) {
          const file = typeof item === 'string' ? item : (item.file?.path || item.path || item.file)
          if (file && file !== activeFile && !graphFiles.has(file)) {
            rawChunks.push(new ContextChunk({
              id: `lexical:${file}`,
              type: CHUNK_TYPES.FILE,
              source: file,
              path: file,
              content: item.content || `Lexical search match file: ${file}`,
              summary: `Lexically relevant file ${file}`,
              score: 0.60,
              priority: CHUNK_PRIORITY.LOW
            }))
          }
        }
      }
    }

    // 6. PROJECT MEMORY (MEDIUM Priority)
    const memoryRecords = memoryManager.projects.getRecords(null, 0.5) || []
    if (memoryRecords.length > 0) {
      const memText = memoryRecords.map(r => `${r.category.toUpperCase()} - ${r.key}: ${r.value}`).join('\n')
      rawChunks.push(new ContextChunk({
        id: 'memory:project',
        type: CHUNK_TYPES.MEMORY,
        source: 'memory',
        content: `[Project Memory]\n${memText}`,
        summary: 'Project facts and memory',
        score: 0.50,
        priority: CHUNK_PRIORITY.MEDIUM
      }))
    }

    return rawChunks
  }

  async retrieveContextGraph({
    task = '',
    symbolQuery = null,
    activeFile = null,
    graphDepth = 2,
    codeIntelligence = null
  } = {}) {
    const codeIntel = codeIntelligence || this.codeIntelligence
    if (!codeIntel?.symbolGraph) {
      return { found: false, target: symbolQuery || task, items: [], categories: {} }
    }
    const targetQueries = []
    if (symbolQuery) targetQueries.push(symbolQuery)
    if (task) {
      const taskTerms = String(task).match(/[a-zA-Z0-9_]{3,}/g) || []
      for (const term of taskTerms.slice(0, 8)) {
        const matches = codeIntel.findSymbols(term)
        if (matches && matches.length > 0) {
          targetQueries.push(term)
        }
      }
    }
    if (activeFile) targetQueries.push(activeFile)

    return codeIntel.symbolGraph.traverseContextGraph(targetQueries, { maxDepth: graphDepth })
  }
}
