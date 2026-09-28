/**
 * LayaStateSerializer: Strictly compresses agent state into a deterministic,
 * bounded context (<512 tokens / ~2000 characters) for Laya System-1 evaluation.
 *
 * Excludes:
 * - Huge file buffers and raw code dumps
 * - Giant command outputs and logs
 * - Secrets, API tokens, and credentials
 * - Binary payloads
 */
export class LayaStateSerializer {
  static MAX_CHARS = 1800 // Safe buffer under Laya's 512-token limit

  /**
   * Redacts sensitive credentials, tokens, and authorization headers.
   */
  static redactSecrets(text) {
    if (typeof text !== 'string') return text
    return text
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(?:api[_-]?key|secret|token|password|auth)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-]{8,})["']?/gi, 'token="[REDACTED]"')
  }

  /**
   * Compacts an action or observation object into a minimal single-line summary.
   */
  static compactObservation(obs) {
    if (!obs) return null
    const tool = obs.tool || obs.name || 'unknown'
    const status = obs.error ? 'FAILED' : (obs.status || 'OK')
    let detail = ''
    if (obs.error) {
      detail = String(obs.error).slice(0, 80).replace(/\s+/g, ' ')
    } else if (obs.result) {
      const resStr = typeof obs.result === 'string' ? obs.result : JSON.stringify(obs.result)
      detail = resStr.slice(0, 80).replace(/\s+/g, ' ')
    }
    return `[${tool}:${status}] ${detail}`.trim()
  }

  /**
   * Serializes the multi-dimensional agent state into compact structured JSON.
   *
   * @param {Object} input
   * @param {string} input.request - Active user prompt or task
   * @param {string} [input.state='IDLE'] - FSM State
   * @param {string} [input.activeFile] - Currently active relative file path
   * @param {string} [input.selectedSymbol] - Focused function/class/variable
   * @param {Array<string>} [input.diagnostics] - Compiler/linter error messages
   * @param {Array<Object>} [input.recentObservations] - Last 1-3 tool outcomes
   * @param {Array<string>} [input.symbolIds] - Relevant symbols from SymbolGraph
   * @param {Object} [input.failureState] - Assertion failure details if in recovery
   * @returns {Object} JSON-serializable state payload within 512-token limit
   */
  static serialize(input = {}) {
    const rawTask = String(input.request || input.task || '').trim()
    const task = this.redactSecrets(rawTask).slice(0, 300)

    const state = String(input.state || 'IDLE').toUpperCase()
    const activeFile = input.activeFile ? String(input.activeFile).slice(0, 100) : null
    const selectedSymbol = input.selectedSymbol ? String(input.selectedSymbol).slice(0, 60) : null

    // Compress top 2 diagnostics
    let diagnostics = []
    if (Array.isArray(input.diagnostics)) {
      diagnostics = input.diagnostics.slice(0, 2).map(d => {
        const str = typeof d === 'string' ? d : (d?.message || JSON.stringify(d))
        return this.redactSecrets(str).slice(0, 120).replace(/\s+/g, ' ')
      })
    }

    // Compress top 3 recent observations
    let history = []
    if (Array.isArray(input.recentObservations)) {
      history = input.recentObservations.slice(-3).map(o => this.compactObservation(o)).filter(Boolean)
    }

    // Relevant symbols (max 4)
    const symbols = Array.isArray(input.symbolIds) ? input.symbolIds.slice(0, 4) : []

    // Failure state
    let failure = null
    if (input.failureState) {
      failure = {
        error: String(input.failureState.error || input.failureState.message || '').slice(0, 100),
        file: input.failureState.file || null,
        line: input.failureState.line || null
      }
    }

    const payload = {
      task,
      state,
      target: activeFile ? { file: activeFile, symbol: selectedSymbol } : null,
      diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      history: history.length > 0 ? history : undefined,
      symbols: symbols.length > 0 ? symbols : undefined,
      failure: failure || undefined
    }

    // Clean undefined keys
    const cleanPayload = JSON.parse(JSON.stringify(payload))
    const serializedStr = JSON.stringify(cleanPayload)

    // Enforce strict character budget
    if (serializedStr.length > this.MAX_CHARS) {
      return {
        task: task.slice(0, 180),
        state,
        target: activeFile ? { file: activeFile } : null,
        history: history.slice(-1)
      }
    }

    return cleanPayload
  }
}
