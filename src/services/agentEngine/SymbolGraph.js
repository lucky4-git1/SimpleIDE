function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\//, '')
}

export const NODE_KINDS = {
  FILE: 'file',
  MODULE: 'module',
  FUNCTION: 'function',
  CLASS: 'class',
  INTERFACE: 'interface',
  VARIABLE: 'variable',
  COMPONENT: 'component',
  ROUTE: 'route',
  TEST: 'test'
}

export const EDGE_KINDS = {
  IMPORTS: 'imports',
  EXPORTS: 'exports',
  CALLS: 'calls',
  REFERENCES: 'references',
  EXTENDS: 'extends',
  IMPLEMENTS: 'implements',
  RENDERS: 'renders',
  TESTS: 'tests'
}

export class SymbolNode {
  constructor({ id, name, kind = NODE_KINDS.FUNCTION, file = '', line = 1, metadata = {} }) {
    this.name = name
    this.kind = kind
    this.file = normalizePath(file)
    this.line = line
    this.metadata = metadata
    this.id = id || `${this.kind}:${this.file}:${this.name}`
  }
}

export class SymbolEdge {
  constructor({ from, to, kind = EDGE_KINDS.REFERENCES, metadata = {} }) {
    this.from = from
    this.to = to
    this.kind = kind
    this.metadata = metadata
    this.id = `${this.kind}:${this.from}->${this.to}`
  }
}

export class SymbolGraph {
  constructor(workspaceRoot = '') {
    this.root = normalizePath(workspaceRoot)
    this.nodes = new Map() // nodeId -> SymbolNode
    this.nodesByName = new Map() // lowerName -> Set<nodeId>
    this.nodesByFile = new Map() // normFile -> Set<nodeId>
    this.outgoing = new Map() // nodeId -> Map<edgeId, SymbolEdge>
    this.incoming = new Map() // nodeId -> Map<edgeId, SymbolEdge>
  }

  clear() {
    this.nodes.clear()
    this.nodesByName.clear()
    this.nodesByFile.clear()
    this.outgoing.clear()
    this.incoming.clear()
  }

  addNode(node) {
    if (!node || !node.id) return null
    const existing = this.nodes.get(node.id)
    if (existing) {
      existing.name = node.name
      existing.line = node.line
      existing.metadata = { ...existing.metadata, ...node.metadata }
      return existing
    }

    this.nodes.set(node.id, node)

    // Index by lower-case name
    const lowerName = node.name.toLowerCase()
    const nameSet = this.nodesByName.get(lowerName) || new Set()
    nameSet.add(node.id)
    this.nodesByName.set(lowerName, nameSet)

    // Index by file
    if (node.file) {
      const fileSet = this.nodesByFile.get(node.file) || new Set()
      fileSet.add(node.id)
      this.nodesByFile.set(node.file, fileSet)
    }

    return node
  }

  addEdge(fromId, toId, kind, metadata = {}) {
    if (!fromId || !toId || fromId === toId) return null
    const edge = new SymbolEdge({ from: fromId, to: toId, kind, metadata })

    // Outgoing from source
    const outMap = this.outgoing.get(fromId) || new Map()
    outMap.set(edge.id, edge)
    this.outgoing.set(fromId, outMap)

    // Incoming to target
    const inMap = this.incoming.get(toId) || new Map()
    inMap.set(edge.id, edge)
    this.incoming.set(toId, inMap)

    return edge
  }

  removeNode(nodeId) {
    const node = this.nodes.get(nodeId)
    if (!node) return

    // 1. Remove outgoing edges
    const outMap = this.outgoing.get(nodeId)
    if (outMap) {
      for (const edge of outMap.values()) {
        const inMap = this.incoming.get(edge.to)
        if (inMap) inMap.delete(edge.id)
      }
      this.outgoing.delete(nodeId)
    }

    // 2. Remove incoming edges
    const inMap = this.incoming.get(nodeId)
    if (inMap) {
      for (const edge of inMap.values()) {
        const outMap = this.outgoing.get(edge.from)
        if (outMap) outMap.delete(edge.id)
      }
      this.incoming.delete(nodeId)
    }

    // 3. Remove from name index
    const lowerName = node.name.toLowerCase()
    const nameSet = this.nodesByName.get(lowerName)
    if (nameSet) {
      nameSet.delete(nodeId)
      if (!nameSet.size) this.nodesByName.delete(lowerName)
    }

    // 4. Remove from file index
    if (node.file) {
      const fileSet = this.nodesByFile.get(node.file)
      if (fileSet) {
        fileSet.delete(nodeId)
        if (!fileSet.size) this.nodesByFile.delete(node.file)
      }
    }

    // 5. Remove node
    this.nodes.delete(nodeId)
  }

  removeFile(filePath) {
    const norm = normalizePath(filePath)
    const nodeIds = this.nodesByFile.get(norm)
    if (nodeIds) {
      const idsToRemove = Array.from(nodeIds)
      for (const id of idsToRemove) {
        this.removeNode(id)
      }
      this.nodesByFile.delete(norm)
    }
  }

  findNodes(query, kind = null) {
    if (!query) return []
    const q = String(query).toLowerCase()
    const exact = []
    const partial = []

    for (const [name, ids] of this.nodesByName.entries()) {
      const isExact = name === q
      const isPartial = !isExact && name.includes(q)

      if (isExact || isPartial) {
        for (const id of ids) {
          const node = this.nodes.get(id)
          if (node && (!kind || node.kind === kind)) {
            if (isExact) exact.push(node)
            else partial.push(node)
          }
        }
      }
    }
    return [...exact, ...partial]
  }

  getNode(nodeId) {
    return this.nodes.get(nodeId) || null
  }

  getIncomingEdges(nodeId, filterKinds = null) {
    const map = this.incoming.get(nodeId)
    if (!map) return []
    const edges = Array.from(map.values())
    return filterKinds ? edges.filter(e => filterKinds.includes(e.kind)) : edges
  }

  getOutgoingEdges(nodeId, filterKinds = null) {
    const map = this.outgoing.get(nodeId)
    if (!map) return []
    const edges = Array.from(map.values())
    return filterKinds ? edges.filter(e => filterKinds.includes(e.kind)) : edges
  }

  queryUsages(symbolOrFile) {
    const query = String(symbolOrFile).trim()
    const matchedNodes = this.findNodes(query)
    const targetNode = matchedNodes[0] || null

    if (!targetNode && !this.nodesByFile.has(normalizePath(query))) {
      return {
        target: query,
        found: false,
        usages: [],
        treeText: `${query} (not found in symbol graph)`
      }
    }

    const targetIds = targetNode ? [targetNode.id] : Array.from(this.nodesByFile.get(normalizePath(query)) || [])
    const usages = []
    const seen = new Set()

    for (const tid of targetIds) {
      const inEdges = this.getIncomingEdges(tid)
      for (const edge of inEdges) {
        const sourceNode = this.getNode(edge.from)
        if (sourceNode && !seen.has(sourceNode.id)) {
          seen.add(sourceNode.id)
          usages.push({
            name: sourceNode.name,
            kind: sourceNode.kind,
            file: sourceNode.file,
            line: sourceNode.line,
            relation: edge.kind,
            detail: edge.metadata?.detail || ''
          })
        }
      }
    }

    // Format formatted ASCII tree:
    // AuthService
    // ├── LoginController [calls] (src/controllers/LoginController.js:12)
    // ├── SessionMiddleware [references] (src/middleware/session.js:5)
    // └── auth.test.ts [tests] (tests/auth.test.ts:3)
    let treeLines = [targetNode ? targetNode.name : query]
    if (usages.length === 0) {
      treeLines.push('└── (no direct incoming usages found)')
    } else {
      usages.forEach((u, idx) => {
        const isLast = idx === usages.length - 1
        const prefix = isLast ? '└── ' : '├── '
        const loc = u.file ? ` (${u.file}${u.line ? `:${u.line}` : ''})` : ''
        treeLines.push(`${prefix}${u.name} [${u.relation}]${loc}`)
      })
    }

    return {
      target: targetNode ? targetNode.name : query,
      found: true,
      kind: targetNode?.kind || 'file',
      file: targetNode?.file || query,
      usages,
      count: usages.length,
      treeText: treeLines.join('\n')
    }
  }

  queryDependencies(symbolOrFile) {
    const query = String(symbolOrFile).trim()
    const matchedNodes = this.findNodes(query)
    const targetNode = matchedNodes[0] || null

    if (!targetNode && !this.nodesByFile.has(normalizePath(query))) {
      return {
        target: query,
        found: false,
        dependencies: [],
        treeText: `${query} (not found in symbol graph)`
      }
    }

    const targetIds = targetNode ? [targetNode.id] : Array.from(this.nodesByFile.get(normalizePath(query)) || [])
    const dependencies = []
    const seen = new Set()

    for (const tid of targetIds) {
      const outEdges = this.getOutgoingEdges(tid)
      for (const edge of outEdges) {
        const destNode = this.getNode(edge.to)
        if (destNode && !seen.has(destNode.id)) {
          seen.add(destNode.id)
          dependencies.push({
            name: destNode.name,
            kind: destNode.kind,
            file: destNode.file,
            line: destNode.line,
            relation: edge.kind,
            detail: edge.metadata?.detail || ''
          })
        }
      }
    }

    let treeLines = [targetNode ? targetNode.name : query]
    if (dependencies.length === 0) {
      treeLines.push('└── (no outgoing dependencies found)')
    } else {
      dependencies.forEach((d, idx) => {
        const isLast = idx === dependencies.length - 1
        const prefix = isLast ? '└── ' : '├── '
        const loc = d.file ? ` (${d.file}${d.line ? `:${d.line}` : ''})` : ''
        treeLines.push(`${prefix}${d.name} [${d.relation}]${loc}`)
      })
    }

    return {
      target: targetNode ? targetNode.name : query,
      found: true,
      kind: targetNode?.kind || 'file',
      file: targetNode?.file || query,
      dependencies,
      count: dependencies.length,
      treeText: treeLines.join('\n')
    }
  }

  queryCallGraph(functionName, direction = 'callers', maxDepth = 2) {
    const query = String(functionName).trim()
    const matchedNodes = this.findNodes(query, NODE_KINDS.FUNCTION)
    const rootNode = matchedNodes[0] || this.findNodes(query)[0]

    if (!rootNode) {
      return { target: query, found: false, graph: [], treeText: `${query} (not found)` }
    }

    const isCallers = direction === 'callers'
    const visited = new Set([rootNode.id])

    const explore = (currentId, currentDepth) => {
      if (currentDepth >= maxDepth) return []
      const edges = isCallers
        ? this.getIncomingEdges(currentId, [EDGE_KINDS.CALLS])
        : this.getOutgoingEdges(currentId, [EDGE_KINDS.CALLS])

      const branch = []
      for (const edge of edges) {
        const nextId = isCallers ? edge.from : edge.to
        if (visited.has(nextId)) continue
        visited.add(nextId)
        const nextNode = this.getNode(nextId)
        if (nextNode) {
          branch.push({
            name: nextNode.name,
            kind: nextNode.kind,
            file: nextNode.file,
            line: nextNode.line,
            children: explore(nextId, currentDepth + 1)
          })
        }
      }
      return branch
    }

    const treeData = explore(rootNode.id, 0)

    const renderBranch = (nodes, indent = '') => {
      const lines = []
      nodes.forEach((n, idx) => {
        const isLast = idx === nodes.length - 1
        const prefix = indent + (isLast ? '└── ' : '├── ')
        const loc = n.file ? ` (${n.file}:${n.line})` : ''
        lines.push(`${prefix}${n.name}${loc}`)
        if (n.children && n.children.length) {
          const nextIndent = indent + (isLast ? '    ' : '│   ')
          lines.push(...renderBranch(n.children, nextIndent))
        }
      })
      return lines
    }

    const treeLines = [`${rootNode.name} [${direction}]`, ...renderBranch(treeData)]

    return {
      target: rootNode.name,
      found: true,
      direction,
      depth: maxDepth,
      graph: treeData,
      treeText: treeLines.join('\n')
    }
  }

  /**
   * Explores the context graph around a symbol or file with graph distance and relevance.
   * Categorizes neighbors into the 9-point priority hierarchy:
   * 1. Current Symbol
   * 2. Definition
   * 3. Direct References
   * 4. Callers
   * 5. Callees
   * 6. Related Tests
   * 7. Imports
   * 8. Configuration
   * 9. Documentation
   *
   * @param {string|string[]} symbolOrFile - Symbol name(s) or file path(s)
   * @param {Object} [options]
   * @param {number} [options.maxDepth=2]
   * @returns {Object} Graph traversal result with categorized nodes and relevance scores
   */
  traverseContextGraph(symbolOrFile, { maxDepth = 2 } = {}) {
    const queries = Array.isArray(symbolOrFile) ? symbolOrFile : [symbolOrFile]
    const rootNodes = []
    const seenNodeIds = new Set()

    for (const raw of queries) {
      const q = String(raw || '').trim()
      if (!q) continue
      const matched = this.findNodes(q)
      if (matched.length > 0) {
        for (const m of matched) {
          if (!seenNodeIds.has(m.id)) {
            seenNodeIds.add(m.id)
            rootNodes.push(m)
          }
        }
      } else {
        const fileNorm = normalizePath(q)
        const fileNodeIds = this.nodesByFile.get(fileNorm) || new Set()
        for (const id of fileNodeIds) {
          const n = this.getNode(id)
          if (n && !seenNodeIds.has(n.id)) {
            seenNodeIds.add(n.id)
            rootNodes.push(n)
          }
        }
      }
    }

    if (rootNodes.length === 0) {
      return {
        found: false,
        target: String(symbolOrFile),
        items: [],
        categories: {
          currentSymbols: [],
          definitions: [],
          references: [],
          callers: [],
          callees: [],
          tests: [],
          imports: [],
          configs: [],
          docs: []
        }
      }
    }

    const categories = {
      currentSymbols: [],
      definitions: [],
      references: [],
      callers: [],
      callees: [],
      tests: [],
      imports: [],
      configs: [],
      docs: []
    }

    const items = []
    const visited = new Set()

    // 1. Current Symbol & Definition (Distance 0)
    for (const node of rootNodes) {
      if (visited.has(node.id)) continue
      visited.add(node.id)

      const isSymbol = node.kind !== NODE_KINDS.FILE && node.kind !== NODE_KINDS.TEST
      if (isSymbol) {
        const item = {
          node,
          category: 'current_symbol',
          relation: 'current_symbol',
          graphDistance: 0,
          score: 1.0,
          file: node.file,
          name: node.name,
          kind: node.kind,
          line: node.line
        }
        categories.currentSymbols.push(item)
        items.push(item)
      }

      const defItem = {
        node,
        category: 'definition',
        relation: 'definition',
        graphDistance: 0,
        score: 0.98,
        file: node.file,
        name: node.name,
        kind: node.kind,
        line: node.line
      }
      categories.definitions.push(defItem)
      items.push(defItem)
    }

    // 2. Explore Distance 1 Neighbors
    for (const rootNode of rootNodes) {
      // Incoming edges (References, Callers, Tests)
      const inEdges = this.getIncomingEdges(rootNode.id)
      for (const edge of inEdges) {
        const sourceNode = this.getNode(edge.from)
        if (!sourceNode || visited.has(sourceNode.id)) continue
        visited.add(sourceNode.id)

        const isTest = sourceNode.kind === NODE_KINDS.TEST ||
          edge.kind === EDGE_KINDS.TESTS ||
          /(?:test|spec)s?\/|\.(?:test|spec)\.[jt]sx?$/i.test(sourceNode.file || sourceNode.name)

        if (isTest) {
          const item = {
            node: sourceNode,
            category: 'tests',
            relation: 'test',
            graphDistance: 1,
            score: 0.80,
            file: sourceNode.file,
            name: sourceNode.name,
            kind: sourceNode.kind,
            line: sourceNode.line
          }
          categories.tests.push(item)
          items.push(item)
        } else if (edge.kind === EDGE_KINDS.CALLS) {
          const item = {
            node: sourceNode,
            category: 'callers',
            relation: 'caller',
            graphDistance: 1,
            score: 0.88,
            file: sourceNode.file,
            name: sourceNode.name,
            kind: sourceNode.kind,
            line: sourceNode.line
          }
          categories.callers.push(item)
          items.push(item)
        } else {
          const item = {
            node: sourceNode,
            category: 'references',
            relation: 'reference',
            graphDistance: 1,
            score: 0.92,
            file: sourceNode.file,
            name: sourceNode.name,
            kind: sourceNode.kind,
            line: sourceNode.line
          }
          categories.references.push(item)
          items.push(item)
        }
      }

      // Outgoing edges (Callees, Imports)
      const outEdges = this.getOutgoingEdges(rootNode.id)
      for (const edge of outEdges) {
        const destNode = this.getNode(edge.to)
        if (!destNode || visited.has(destNode.id)) continue
        visited.add(destNode.id)

        const isConfig = /(?:config|\.env|rc\.)/i.test(destNode.file || destNode.name) ||
          destNode.name === 'package.json'
        const isDoc = /\.md$/i.test(destNode.file || destNode.name) ||
          /docs\//i.test(destNode.file || '')

        if (isConfig) {
          const item = {
            node: destNode,
            category: 'configs',
            relation: 'config',
            graphDistance: 1,
            score: 0.72,
            file: destNode.file,
            name: destNode.name,
            kind: destNode.kind,
            line: destNode.line
          }
          categories.configs.push(item)
          items.push(item)
        } else if (isDoc) {
          const item = {
            node: destNode,
            category: 'docs',
            relation: 'documentation',
            graphDistance: 1,
            score: 0.65,
            file: destNode.file,
            name: destNode.name,
            kind: destNode.kind,
            line: destNode.line
          }
          categories.docs.push(item)
          items.push(item)
        } else if (edge.kind === EDGE_KINDS.CALLS) {
          const item = {
            node: destNode,
            category: 'callees',
            relation: 'callee',
            graphDistance: 1,
            score: 0.84,
            file: destNode.file,
            name: destNode.name,
            kind: destNode.kind,
            line: destNode.line
          }
          categories.callees.push(item)
          items.push(item)
        } else if (edge.kind === EDGE_KINDS.IMPORTS) {
          const item = {
            node: destNode,
            category: 'imports',
            relation: 'import',
            graphDistance: 1,
            score: 0.76,
            file: destNode.file,
            name: destNode.name,
            kind: destNode.kind,
            line: destNode.line
          }
          categories.imports.push(item)
          items.push(item)
        }
      }

      // Check file node edges if rootNode is a symbol
      if (rootNode.file) {
        const fileNode = this.getNode(`file:${rootNode.file}`)
        if (fileNode && fileNode.id !== rootNode.id) {
          const fileOut = this.getOutgoingEdges(fileNode.id, [EDGE_KINDS.IMPORTS])
          for (const edge of fileOut) {
            const destNode = this.getNode(edge.to)
            if (!destNode || visited.has(destNode.id)) continue
            visited.add(destNode.id)

            const isConfig = /(?:config|\.env|rc\.)/i.test(destNode.file || destNode.name) ||
              destNode.name === 'package.json'
            if (isConfig) {
              const item = {
                node: destNode,
                category: 'configs',
                relation: 'config',
                graphDistance: 1,
                score: 0.72,
                file: destNode.file,
                name: destNode.name,
                kind: destNode.kind,
                line: destNode.line
              }
              categories.configs.push(item)
              items.push(item)
            } else {
              const item = {
                node: destNode,
                category: 'imports',
                relation: 'import',
                graphDistance: 1,
                score: 0.76,
                file: destNode.file,
                name: destNode.name,
                kind: destNode.kind,
                line: destNode.line
              }
              categories.imports.push(item)
              items.push(item)
            }
          }

          const fileIn = this.getIncomingEdges(fileNode.id, [EDGE_KINDS.TESTS])
          for (const edge of fileIn) {
            const srcNode = this.getNode(edge.from)
            if (!srcNode || visited.has(srcNode.id)) continue
            visited.add(srcNode.id)
            const item = {
              node: srcNode,
              category: 'tests',
              relation: 'test',
              graphDistance: 1,
              score: 0.80,
              file: srcNode.file,
              name: srcNode.name,
              kind: srcNode.kind,
              line: srcNode.line
            }
            categories.tests.push(item)
            items.push(item)
          }
        }
      }
    }

    // 3. Multi-hop callers (Distance 2) if maxDepth >= 2
    if (maxDepth >= 2) {
      const distance1Callers = [...categories.callers]
      for (const callerItem of distance1Callers) {
        const callerEdges = this.getIncomingEdges(callerItem.node.id, [EDGE_KINDS.CALLS])
        for (const edge of callerEdges) {
          const secondHop = this.getNode(edge.from)
          if (!secondHop || visited.has(secondHop.id)) continue
          visited.add(secondHop.id)

          const item = {
            node: secondHop,
            category: 'callers',
            relation: 'caller',
            graphDistance: 2,
            score: 0.82,
            file: secondHop.file,
            name: secondHop.name,
            kind: secondHop.kind,
            line: secondHop.line
          }
          categories.callers.push(item)
          items.push(item)
        }
      }
    }

    return {
      found: true,
      target: String(symbolOrFile),
      items,
      categories
    }
  }

  getGraphSummary() {
    let edgesCount = 0
    for (const map of this.outgoing.values()) {
      edgesCount += map.size
    }

    return {
      nodesCount: this.nodes.size,
      edgesCount,
      filesCount: this.nodesByFile.size,
      symbolsCount: this.nodesByName.size
    }
  }
}
