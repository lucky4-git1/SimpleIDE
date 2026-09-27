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
    this.callsByCaller = new Map() // callerName -> Array of { callee, file, line }
    this.callsByCallee = new Map() // calleeName -> Array of { caller, file, line }
    this.implementationsBySymbol = new Map() // symbolName -> Array of { name, extends, implements, file }
    this.diagnosticsByFile = new Map() // file relPath -> Array of { line, column, message, severity }
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
    this.callsByCaller.clear()
    this.callsByCallee.clear()
    this.implementationsBySymbol.clear()
    this.diagnosticsByFile.clear()
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

      // 4. Process Calls
      const calls = astResult.calls || []
      for (const call of calls) {
        const callerList = this.callsByCaller.get(call.caller) || []
        callerList.push(call)
        this.callsByCaller.set(call.caller, callerList)

        const calleeList = this.callsByCallee.get(call.callee) || []
        calleeList.push(call)
        this.callsByCallee.set(call.callee, calleeList)
      }

      // 5. Process Implementations
      const impls = astResult.implementations || []
      for (const impl of impls) {
        const list = this.implementationsBySymbol.get(impl.name) || []
        list.push(impl)
        this.implementationsBySymbol.set(impl.name, list)

        if (impl.extends) {
          const extList = this.implementationsBySymbol.get(impl.extends) || []
          extList.push(impl)
          this.implementationsBySymbol.set(impl.extends, extList)
        }
        for (const iface of impl.implements || []) {
          const ifaceList = this.implementationsBySymbol.get(iface) || []
          ifaceList.push(impl)
          this.implementationsBySymbol.set(iface, ifaceList)
        }
      }

      // 6. Process Diagnostics
      if (astResult.diagnostics?.length) {
        this.diagnosticsByFile.set(normPath, astResult.diagnostics)
      }
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
    this.diagnosticsByFile.delete(normPath)

    // Remove calls associated with this file
    for (const [caller, list] of this.callsByCaller.entries()) {
      const filtered = list.filter(c => c.file !== normPath)
      if (filtered.length) this.callsByCaller.set(caller, filtered)
      else this.callsByCaller.delete(caller)
    }
    for (const [callee, list] of this.callsByCallee.entries()) {
      const filtered = list.filter(c => c.file !== normPath)
      if (filtered.length) this.callsByCallee.set(callee, filtered)
      else this.callsByCallee.delete(callee)
    }

    // Remove implementations associated with this file
    for (const [sym, list] of this.implementationsBySymbol.entries()) {
      const filtered = list.filter(i => i.file !== normPath)
      if (filtered.length) this.implementationsBySymbol.set(sym, filtered)
      else this.implementationsBySymbol.delete(sym)
    }
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

  // ─── Query APIs ─────────────────────────────────────────────────────────

  findSymbol(name) {
    return this.symbolsByName.get(name) || []
  }

  findSymbols(query, kind = null) {
    if (!query) return []
    const q = query.toLowerCase()
    const results = []
    for (const [name, records] of this.symbolsByName.entries()) {
      if (name.toLowerCase().includes(q)) {
        for (const r of records) {
          if (!kind || r.kind?.toLowerCase() === kind.toLowerCase()) {
            results.push(r)
          }
        }
      }
    }
    return results.slice(0, 50)
  }

  getFileSymbols(path) {
    return this.symbolsByFile.get(normalizePath(path)) || []
  }

  findDefinition(symbolName, file = null) {
    let records = this.symbolsByName.get(symbolName) || []
    if (file) {
      const norm = normalizePath(file)
      records = records.filter(s => s.file === norm)
    }
    // Prefer non-export declaration records if available
    const nonExports = records.filter(s => s.kind !== 'export')
    return nonExports.length ? nonExports : records
  }

  findReferences(symbolName) {
    const refs = []
    const seen = new Set()

    // 1. Direct callers via call expressions
    const directCalls = this.callsByCallee.get(symbolName) || []
    for (const call of directCalls) {
      const key = `${call.file}:${call.line}:call:${call.caller}`
      if (!seen.has(key)) {
        seen.add(key)
        refs.push({
          symbol: symbolName,
          file: call.file,
          line: call.line,
          caller: call.caller,
          kind: 'call'
        })
      }
    }

    // 2. Import references from other files
    const defs = this.findDefinition(symbolName)
    for (const def of defs) {
      const callers = this.getImportedBy(def.file)
      for (const caller of callers) {
        const key = `${caller}:1:import:${def.file}`
        if (!seen.has(key)) {
          seen.add(key)
          refs.push({
            symbol: symbolName,
            file: caller,
            source: def.file,
            kind: 'import'
          })
        }
      }
    }

    return refs.slice(0, 100)
  }

  findImplementations(symbolName) {
    const impls = this.implementationsBySymbol.get(symbolName) || []
    return impls.filter(i => i.name !== symbolName).map(i => ({
      name: i.name,
      extends: i.extends,
      implements: i.implements,
      file: i.file
    }))
  }

  getCallers(functionName) {
    const calls = this.callsByCallee.get(functionName) || []
    return calls.map(c => ({
      caller: c.caller,
      file: c.file,
      line: c.line
    }))
  }

  getCallees(functionName) {
    const calls = this.callsByCaller.get(functionName) || []
    return calls.map(c => ({
      callee: c.callee,
      file: c.file,
      line: c.line
    }))
  }

  getDiagnostics(filePath = null) {
    if (filePath) {
      const norm = normalizePath(filePath)
      return this.diagnosticsByFile.get(norm) || []
    }
    const all = []
    for (const [file, diags] of this.diagnosticsByFile.entries()) {
      for (const d of diags) {
        all.push({ file, ...d })
      }
    }
    return all
  }

  getImportGraph(filePath) {
    const norm = normalizePath(filePath)
    return {
      file: norm,
      imports: this.getImports(norm),
      importedBy: this.getImportedBy(norm),
      exports: this.getExports(norm)
    }
  }

  getSymbolOverview(symbolName) {
    const defs = this.findDefinition(symbolName)
    const refs = this.findReferences(symbolName)
    const callers = this.getCallers(symbolName)
    const callees = this.getCallees(symbolName)
    const impls = this.findImplementations(symbolName)

    // Identify related test files
    const defFiles = new Set(defs.map(d => d.file))
    const testFiles = []
    const isTestFile = (path) => /\.(?:test|spec)\.[jt]sx?$/i.test(path) || /(?:^|\/)(?:tests|__tests__|specs)\//i.test(path)

    for (const file of this.files) {
      if (isTestFile(file)) {
        // Direct caller in test file or imports definition file
        const callsInTest = callers.some(c => c.file === file)
        const refsInTest = refs.some(r => r.file === file)
        const importsDef = Array.from(defFiles).some(df => {
          const importedBy = this.getImportedBy(df)
          return importedBy.includes(file)
        })

        if (callsInTest || refsInTest || importsDef) {
          testFiles.push(file)
        }
      }
    }

    return {
      symbol: symbolName,
      definition: defs[0] || null,
      definitions: defs,
      references: refs,
      callers,
      callees,
      implementations: impls,
      tests: Array.from(new Set(testFiles))
    }
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
