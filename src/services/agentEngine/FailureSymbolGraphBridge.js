/**
 * FailureSymbolGraphBridge.js
 *
 * Implements Phase 13: Failure → Symbol Graph
 * Connects parsed failures directly to the project symbol graph.
 * Traces: test → function → implementation → caller → dependency
 * Generates a minimal repair context for debugging.
 */

export class FailureSymbolGraphBridge {
  constructor(symbolGraph, codeIntelligence) {
    this.symbolGraph = symbolGraph
    this.codeIntelligence = codeIntelligence
  }

  /**
   * Explores the symbol graph starting from parsed failure attributes.
   */
  traceFailureGraph(parsedFailure) {
    if (!parsedFailure || !parsedFailure.hasFailure) {
      return { tracedNodes: [], recommendedSymbols: [], repairFiles: [] }
    }

    const { failingFile, relatedSymbols = [], stackFrames = [] } = parsedFailure
    const repairFiles = new Set()
    const recommendedSymbols = new Set(relatedSymbols)
    const tracedNodes = []

    if (failingFile) repairFiles.add(failingFile)

    for (const frame of stackFrames) {
      if (frame.file) repairFiles.add(frame.file)
      if (frame.symbol) recommendedSymbols.add(frame.symbol)
    }

    // Query SymbolGraph for each candidate symbol
    if (this.symbolGraph) {
      for (const symbol of recommendedSymbols) {
        const usages = this.symbolGraph.queryUsages(symbol, { depth: 1 })
        const deps = this.symbolGraph.queryDependencies(symbol, { depth: 1 })

        if (usages.found) {
          tracedNodes.push({ symbol, type: 'usages', items: usages.usages.slice(0, 5) })
          for (const u of usages.usages) {
            if (u.file) repairFiles.add(u.file)
          }
        }

        if (deps.found) {
          tracedNodes.push({ symbol, type: 'dependencies', items: deps.dependencies.slice(0, 5) })
          for (const d of deps.dependencies) {
            if (d.file) repairFiles.add(d.file)
          }
        }
      }
    }

    return {
      failingFile,
      recommendedSymbols: [...recommendedSymbols].slice(0, 8),
      repairFiles: [...repairFiles].slice(0, 6),
      tracedNodes
    }
  }

  /**
   * Builds formatted failure repair context for ContextEngine prompt injection.
   */
  buildRepairContext(parsedFailure) {
    const trace = this.traceFailureGraph(parsedFailure)
    const lines = [
      parsedFailure.formattedSummary,
      '',
      `[TARGETED REPAIR CONTEXT]`,
      `Files to inspect: ${trace.repairFiles.join(', ') || 'N/A'}`,
      `Key symbols: ${trace.recommendedSymbols.join(', ') || 'N/A'}`
    ]

    if (trace.tracedNodes.length) {
      lines.push('Graph Relationships:')
      for (const node of trace.tracedNodes.slice(0, 4)) {
        lines.push(`  • ${node.symbol} (${node.type}): ${node.items.map(i => i.target || i.source).join(', ')}`)
      }
    }

    return lines.join('\n')
  }
}
