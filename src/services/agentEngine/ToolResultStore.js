/**
 * ToolResultStore: Manages the lifecycle and prompt footprint of tool execution results.
 * Prevents large command or file results from repeatedly bloating the LLM prompt.
 */

export const TOOL_RESULT_CLASSES = Object.freeze({
  EPHEMERAL: 'ephemeral',
  RECENT: 'recent',
  IMPORTANT: 'important',
  SUMMARIZED: 'summarized',
  PERSISTENT: 'persistent',
  DISCARDABLE: 'discardable'
})

export const DEFAULT_PIN_CAP_CHARS = 4000

export class ToolResultStore {
  constructor({ maxEntries = 200, pinCapChars = DEFAULT_PIN_CAP_CHARS } = {}) {
    this.maxEntries = maxEntries
    this.pinCapChars = pinCapChars
    this.store = new Map() // id -> { id, tool, rawOutput, summary, classification, turn, timestamp }
  }

  /**
   * Classify tool result lifecycle category.
   */
  classify(toolName, output, { isError = false, isVerification = false } = {}) {
    const text = String(output || '')
    if (!text || text.trim().length === 0) {
      return TOOL_RESULT_CLASSES.EPHEMERAL
    }

    if (isVerification || toolName === 'verify') {
      return TOOL_RESULT_CLASSES.IMPORTANT
    }

    if (isError) {
      return TOOL_RESULT_CLASSES.IMPORTANT
    }

    if (toolName === 'write_file' || toolName === 'create_file' || toolName === 'edit_file') {
      return TOOL_RESULT_CLASSES.PERSISTENT
    }

    return TOOL_RESULT_CLASSES.RECENT
  }

  /**
   * Store a tool execution result. If the result exceeds pinCapChars,
   * stores full result and creates a compact pointer summary.
   */
  record({ id, tool, output, isError = false, isVerification = false, turn = 0 }) {
    const rawOutput = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    const classification = this.classify(tool, rawOutput, { isError, isVerification })
    const entryId = id || `tr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`

    let summary = rawOutput
    let isTruncated = false

    if (rawOutput.length > this.pinCapChars) {
      isTruncated = true
      const head = rawOutput.slice(0, Math.floor(this.pinCapChars * 0.6))
      const tail = rawOutput.slice(-Math.floor(this.pinCapChars * 0.3))
      summary = `${head}\n\n[... truncated ${rawOutput.length - head.length - tail.length} chars. Full output stored in ToolResultStore at ref:${entryId} ...]\n\n${tail}`
    }

    // Maintain max entries bound
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest) this.store.delete(oldest)
    }

    const record = {
      id: entryId,
      tool,
      rawOutput,
      summary,
      isTruncated,
      classification,
      turn,
      timestamp: Date.now()
    }

    this.store.set(entryId, record)
    return record
  }

  get(id) {
    return this.store.get(id) || null
  }

  getFormattedForPrompt(id) {
    const entry = this.store.get(id)
    if (!entry) return ''
    return entry.isTruncated ? entry.summary : entry.rawOutput
  }

  clear() {
    this.store.clear()
  }
}

export const globalToolResultStore = new ToolResultStore()
