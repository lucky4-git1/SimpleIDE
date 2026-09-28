export class PromptContextFormatter {
  static formatPromptContext(contextPackage) {
    if (!contextPackage || !Array.isArray(contextPackage.includedChunks)) {
      return ''
    }

    const sections = []

    // Group included chunks by type for structured output
    const groups = new Map()
    for (const chunk of contextPackage.includedChunks) {
      const list = groups.get(chunk.type) || []
      list.push(chunk)
      groups.set(chunk.type, list)
    }

    // 1. Task Section
    if (contextPackage.task) {
      sections.push(`[Current Task]\n${contextPackage.task}`)
    }

    // 2. Active File & Selection
    const activeChunks = groups.get('ACTIVE_FILE') || []
    const selectionChunks = groups.get('SELECTION') || []
    if (selectionChunks.length > 0 || activeChunks.length > 0) {
      let activeStr = '[Workspace State]\n'
      for (const sel of selectionChunks) activeStr += `${sel.content}\n`
      for (const act of activeChunks) activeStr += `Active File: ${act.path}\n\`\`\`\n${act.content}\n\`\`\`\n`
      sections.push(activeStr.trim())
    }

    // 3. Diagnostics
    const diagChunks = groups.get('DIAGNOSTIC') || []
    if (diagChunks.length > 0) {
      sections.push(diagChunks.map(c => c.content).join('\n\n'))
    }

    // 4. Code Symbols & Definitions
    const symChunks = groups.get('SYMBOL') || []
    if (symChunks.length > 0) {
      sections.push(`[Code Intelligence Symbols]\n` + symChunks.map(s => `- ${s.content}`).join('\n'))
    }

    // 5. Dependencies & Related Files
    const depChunks = groups.get('DEPENDENCY') || []
    const callerChunks = groups.get('CALLER') || []
    const calleeChunks = groups.get('CALLEE') || []
    const refChunks = groups.get('REFERENCE') || []
    const testChunks = groups.get('TEST') || []
    const configChunks = groups.get('CONFIG') || []
    const docChunks = groups.get('DOCUMENTATION') || []

    const allDepChunks = [...depChunks, ...callerChunks, ...calleeChunks, ...refChunks, ...testChunks, ...configChunks, ...docChunks]
    if (allDepChunks.length > 0) {
      sections.push(`[Related File Dependencies]\n` + allDepChunks.map(d => `- ${d.content}`).join('\n'))
    }

    // 6. Lexically Relevant Files
    const fileChunks = groups.get('FILE') || []
    if (fileChunks.length > 0) {
      sections.push(`[Lexically Relevant Files]\n` + fileChunks.map(f => `- ${f.path}`).join('\n'))
    }

    // 7. Project Memory
    const memChunks = groups.get('MEMORY') || []
    if (memChunks.length > 0) {
      sections.push(memChunks.map(m => m.content).join('\n\n'))
    }

    // 8. Tool Results & Observations
    const toolChunks = groups.get('TOOL_RESULT') || []
    if (toolChunks.length > 0) {
      sections.push(`[Recent Observations & Tool Results]\n` + toolChunks.map(t => t.content).join('\n\n'))
    }

    return sections.join('\n\n')
  }

  static formatDebugSummary(contextPackage) {
    if (!contextPackage) return 'ContextPackage is null'

    const b = contextPackage.tokenBudget || {}
    let debug = `=== CONTEXT PACKAGE DEBUG DIAGNOSTICS ===\n`
    debug += `Task: "${contextPackage.task}"\n`
    debug += `Token Budget: Total=${b.total}, Used=${b.used}, Remaining=${b.remaining}\n`
    debug += `Ranking Method: ${contextPackage.retrievalMetadata?.rankingMethod || 'N/A'}\n\n`

    debug += `INCLUDED CHUNKS (${contextPackage.includedChunks?.length || 0}):\n`
    for (const chunk of contextPackage.includedChunks || []) {
      debug += `  - [${chunk.type}] Priority=${chunk.priority}, Score=${chunk.score.toFixed(2)}, Tokens=${chunk.tokens}, Path=${chunk.path || chunk.source}\n`
    }

    debug += `\nDISCARDED CHUNKS (${contextPackage.discardedChunks?.length || 0}):\n`
    for (const chunk of contextPackage.discardedChunks || []) {
      debug += `  - [${chunk.type}] Priority=${chunk.priority}, Score=${chunk.score.toFixed(2)}, Tokens=${chunk.tokens}, Path=${chunk.path || chunk.source}\n`
    }

    return debug
  }
}
