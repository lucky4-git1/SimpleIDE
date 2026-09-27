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
    graphDepth = 1
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

    // 3. EXACT SYMBOL MATCHES & DEFINITIONS (CRITICAL / HIGH Priority)
    const taskTerms = String(task).match(/[a-zA-Z0-9_]{3,}/g) || []
    if (codeIntel) {
      const foundSymbols = new Map()

      for (const term of taskTerms.slice(0, 6)) {
        const matches = codeIntel.findSymbols(term)
        for (const sym of matches.slice(0, 4)) {
          if (!foundSymbols.has(sym.id)) {
            foundSymbols.set(sym.id, sym)
          }
        }
      }

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

      // 4. RELATED FILES & DEPENDENCIES (HIGH Priority, Bounded Graph Depth = 1 or 2)
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

    // 5. LEXICAL FILE SEARCH (MEDIUM Priority)
    if (index) {
      const fileList = Array.isArray(index) ? index : (Array.isArray(index.files) ? index.files : [])
      if (fileList.length > 0) {
        const lexicalMatches = selectRelevantFiles(fileList, task) || []
        for (const item of lexicalMatches.slice(0, 5)) {
          const file = typeof item === 'string' ? item : (item.file?.path || item.path || item.file)
          if (file && file !== activeFile) {
            rawChunks.push(new ContextChunk({
              id: `lexical:${file}`,
              type: CHUNK_TYPES.FILE,
              source: file,
              path: file,
              content: `Lexical search match file: ${file}`,
              summary: `Lexically relevant file ${file}`,
              score: 0.60,
              priority: CHUNK_PRIORITY.MEDIUM
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
}
