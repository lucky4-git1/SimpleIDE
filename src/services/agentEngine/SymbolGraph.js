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
