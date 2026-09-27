import { globalLanguageRegistry, SymbolRecord } from './LanguageRegistry.js'

export const INDEX_STATE = {
  IDLE: 'IDLE',
  INDEXING: 'INDEXING',
  READY: 'READY',
  UPDATING: 'UPDATING',
  ERROR: 'ERROR'
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\//, '')
}

function resolveRelativeImport(fromFile, importSource) {
  if (!importSource.startsWith('.')) return null // External package dependency
  const fromDir = fromFile.includes('/') ? fromFile.substring(0, fromFile.lastIndexOf('/')) : ''
  const parts = `${fromDir}/${importSource}`.split('/')
  const resolved = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (resolved.length) resolved.pop()
    } else {
      resolved.push(part)
    }
  }
  return resolved.join('/')
}

export class CodeIntelligenceService {
  constructor(workspaceRoot, { api, abortSignal } = {}) {
    this.root = workspaceRoot
    this.api = api || globalThis.window?.api
    this.abortSignal = abortSignal || null
    this.state = INDEX_STATE.IDLE
    this.languageRegistry = globalLanguageRegistry

    // Core index stores
    this.symbolsByName = new Map() // symbol name -> SymbolRecord[]
    this.symbolsByFile = new Map() // file relPath -> SymbolRecord[]
    this.importsByFile = new Map() // file relPath -> import records
    this.exportsByFile = new Map() // file relPath -> export records
    this.importedByFile = new Map() // file relPath -> Set<file relPath>
    this.files = new Set()
    this.folders = new Set()
  }

  getApi() {
    return this.api || globalThis.window?.api
  }

  getState() {
    return this.state
  }

  throwIfAborted() {
    if (this.abortSignal?.aborted) {
      const error = new Error('Agent cancelled.')
      error.name = 'AbortError'
      throw error
    }
  }

  async indexWorkspace() {
    this.state = INDEX_STATE.INDEXING
    try {
      this.clearIndex()
      await this.scanDirectory(this.root)
      this.throwIfAborted()
      this.rebuildImportedByGraph()
      this.state = INDEX_STATE.READY
      return this.getProjectStructure()
    } catch (err) {
      // Cancellation must propagate so the Stop button works during
      // indexing; anything else keeps the old partial-index behavior.
      if (err?.name === 'AbortError' || this.abortSignal?.aborted) {
        this.state = INDEX_STATE.IDLE
        throw err
      }
      console.error('[CodeIntelligenceService] Workspace indexing error:', err)
      this.state = INDEX_STATE.ERROR
      return this.getProjectStructure()
    }
  }

  clearIndex() {
    this.symbolsByName.clear()
    this.symbolsByFile.clear()
    this.importsByFile.clear()
    this.exportsByFile.clear()
    this.importedByFile.clear()
    this.files.clear()
    this.folders.clear()
  }

  async scanDirectory(dir) {
    const api = this.getApi()
    if (!api) return

    const result = await api.listFiles(dir)
    if (!result || !result.success) return
    const entries = result.children || []

    const rootNorm = normalizePath(this.root)

    for (const entry of entries) {
      this.throwIfAborted()
      const fullPath = `${dir}/${entry.name}`.replace(/\\/g, '/')
      const normFull = normalizePath(fullPath)
      const relPath = normFull.toLowerCase().startsWith(rootNorm.toLowerCase())
        ? normFull.slice(rootNorm.length).replace(/^\//, '')
        : entry.name

      if (entry.isDirectory && ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'].includes(entry.name)) {
        continue
      }

      if (entry.isDirectory) {
        this.folders.add(relPath)
        await this.scanDirectory(fullPath)
      } else {
        this.files.add(relPath)
        await this.indexFileByPath(fullPath, relPath)
      }
    }
  }

  async indexFileByPath(fullPath, relPath) {
    const api = this.getApi()
    if (!api) return
    try {
      const res = await api.readFile(fullPath)
      if (res && res.success && typeof res.content === 'string') {
        this.indexFile(relPath, res.content)
      }
    } catch {
      // Ignore unreadable files
    }
  }

  indexFile(relPath, source) {
    const normPath = normalizePath(relPath)
    this.files.add(normPath)

    // Remove existing file records before re-indexing
    this.removeFileFromIndex(normPath)

    const parser = this.languageRegistry.getParser(normPath)
    let astResult = null

    if (parser) {
      astResult = parser.parse(source, normPath)
    }

    if (astResult) {
      // 1. Process Symbols
      const symbols = astResult.symbols || []
      this.symbolsByFile.set(normPath, symbols)
      for (const sym of symbols) {
        const list = this.symbolsByName.get(sym.name) || []
        list.push(sym)
        this.symbolsByName.set(sym.name, list)
      }

      // 2. Process Imports
      this.importsByFile.set(normPath, astResult.imports || [])

      // 3. Process Exports
      this.exportsByFile.set(normPath, astResult.exports || [])
    } else {
      // Fallback regex parsing for imports/exports if AST parsing failed/unsupported
      this.parseFileFallback(normPath, source)
    }

    this.updateImportedByForFile(normPath)
  }

  toRelativePath(filePath) {
    if (!filePath) return ''
    const normFile = normalizePath(filePath)
    const normRoot = normalizePath(this.root)
    if (normRoot && normFile.toLowerCase().startsWith(normRoot.toLowerCase())) {
      return normFile.slice(normRoot.length).replace(/^\//, '')
    }
    return normFile
  }

  updateFile(filePath, source) {
    const relPath = this.toRelativePath(filePath)
    this.state = INDEX_STATE.UPDATING
    this.indexFile(relPath, source)
    this.rebuildImportedByGraph()
    this.state = INDEX_STATE.READY
  }

  removeFile(filePath) {
    const relPath = this.toRelativePath(filePath)
    this.state = INDEX_STATE.UPDATING
    this.files.delete(relPath)
    this.removeFileFromIndex(relPath)
    this.rebuildImportedByGraph()
    this.state = INDEX_STATE.READY
  }

  removeFileFromIndex(normPath) {
    const oldSymbols = this.symbolsByFile.get(normPath) || []
    for (const sym of oldSymbols) {
      const list = this.symbolsByName.get(sym.name)
      if (list) {
        const filtered = list.filter(s => s.file !== normPath)
        if (filtered.length) this.symbolsByName.set(sym.name, filtered)
        else this.symbolsByName.delete(sym.name)
      }
    }
    this.symbolsByFile.delete(normPath)
    this.importsByFile.delete(normPath)
    this.exportsByFile.delete(normPath)
  }

  parseFileFallback(relPath, content) {
    const symbols = []
    const imports = []
    const exports = []

    // Fallback regex import extraction
    const importRegex = /import\s+(?:(?:\*\s+as\s+\w+)|(?:{[^}]+})|(?:\w+))\s+from\s+['"]([^'"]+)['"]/g
    let match
    while ((match = importRegex.exec(content)) !== null) {
      imports.push({ file: relPath, source: match[1], specifiers: [] })
    }

    // Fallback regex export extraction
    const exportRegex = /export\s+(?:const|function|class|default)\s+(\w+)/g
    while ((match = exportRegex.exec(content)) !== null) {
      const name = match[1]
      const isComp = /^[A-Z]/.test(name) && /\.(jsx|tsx)$/.test(relPath)
      const kind = isComp ? 'component' : 'export'
      symbols.push(new SymbolRecord({
        name,
        kind,
        file: relPath,
        exported: true
      }))
      exports.push({ file: relPath, name, isDefault: false })
    }

    this.symbolsByFile.set(relPath, symbols)
    for (const sym of symbols) {
      const list = this.symbolsByName.get(sym.name) || []
      list.push(sym)
      this.symbolsByName.set(sym.name, list)
    }
    this.importsByFile.set(relPath, imports)
    this.exportsByFile.set(relPath, exports)
  }

  updateImportedByForFile(fromFile) {
    const imports = this.importsByFile.get(fromFile) || []
    for (const imp of imports) {
      const targetRel = resolveRelativeImport(fromFile, imp.source)
      if (targetRel) {
        // Match targetRel against indexed files (handling missing extensions like .js, .jsx, .ts, .tsx)
        const matchedTarget = this.resolveFileWithExtensions(targetRel)
        if (matchedTarget) {
          const callers = this.importedByFile.get(matchedTarget) || new Set()
          callers.add(fromFile)
          this.importedByFile.set(matchedTarget, callers)
        }
      }
    }
  }

  rebuildImportedByGraph() {
    this.importedByFile.clear()
    for (const [fromFile] of this.importsByFile) {
      this.updateImportedByForFile(fromFile)
    }
  }

  resolveFileWithExtensions(candidate) {
    const norm = normalizePath(candidate)
    if (this.files.has(norm)) return norm
    for (const ext of ['.js', '.jsx', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts', '/index.tsx']) {
      if (this.files.has(norm + ext)) return norm + ext
    }
    return null
  }

  // ─── Query APIs ─────────────────────────────────────────────────────────

  findSymbol(name) {
    return this.symbolsByName.get(name) || []
  }

  findSymbols(query) {
    if (!query) return []
    const q = query.toLowerCase()
    const results = []
    for (const [name, records] of this.symbolsByName.entries()) {
      if (name.toLowerCase().includes(q)) {
        results.push(...records)
      }
    }
    return results
  }

  getFileSymbols(path) {
    return this.symbolsByFile.get(normalizePath(path)) || []
  }

  findDefinition(symbolName) {
    return (this.symbolsByName.get(symbolName) || []).filter(s => s.kind !== 'export')
  }

  findReferences(symbolName) {
    const defs = this.findSymbol(symbolName)
    const references = []
    for (const def of defs) {
      const callers = this.getImportedBy(def.file)
      for (const caller of callers) {
        references.push({ symbol: symbolName, file: caller, source: def.file })
      }
    }
    return references
  }

  getImports(path) {
    return this.importsByFile.get(normalizePath(path)) || []
  }

  getImportedBy(path) {
    const norm = normalizePath(path)
    const callers = this.importedByFile.get(norm)
    return callers ? Array.from(callers) : []
  }

  getExports(path) {
    return this.exportsByFile.get(normalizePath(path)) || []
  }

  getDependents(path) {
    return this.getImportedBy(path)
  }

  getRelatedFiles(path) {
    const norm = normalizePath(path)
    const importedBy = this.getImportedBy(norm)
    const imports = (this.getImports(norm) || [])
      .map(i => resolveRelativeImport(norm, i.source))
      .filter(Boolean)
      .map(p => this.resolveFileWithExtensions(p))
      .filter(Boolean)

    return Array.from(new Set([...importedBy, ...imports]))
  }

  getProjectStructure() {
    let symbolsCount = 0
    for (const list of this.symbolsByName.values()) {
      symbolsCount += list.length
    }
    let edgesCount = 0
    for (const set of this.importedByFile.values()) {
      edgesCount += set.size
    }

    return {
      state: this.state,
      filesCount: this.files.size,
      foldersCount: this.folders.size,
      symbolsCount,
      importGraphEdges: edgesCount
    }
  }

  getWorkspaceSymbolSummary(limit = 35) {
    const summaryLines = []
    let count = 0

    for (const [file, symbols] of this.symbolsByFile.entries()) {
      if (count >= limit) break
      if (!symbols || !symbols.length) continue
      const names = Array.from(new Set(symbols.map(s => s.name))).slice(0, 6).join(', ')
      if (names) {
        summaryLines.push(`${file}: ${names}`)
        count++
      }
    }

    return summaryLines.join('\n')
  }
}
