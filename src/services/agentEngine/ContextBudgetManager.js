import { estimateTokens } from './ContextChunk.js'

export const DEGRADATION_STAGES = Object.freeze({
  NORMAL: 'normal',
  COMPRESS: 'compress',
  SUMMARIZE: 'summarize',
  PIN: 'pin',
  CONSERVATIVE: 'conservative',
  EXHAUSTED: 'exhausted'
})

export class ContextBudgetManager {
  constructor({
    totalTokens = 128000,
    reservedOutputTokens = 4096,
    reservedSystemTokens = 2000
  } = {}) {
    this.configure({ totalTokens, reservedOutputTokens, reservedSystemTokens })
  }

  configure({ totalTokens = this.totalTokens, reservedOutputTokens = this.reservedOutputTokens, reservedSystemTokens = this.reservedSystemTokens } = {}) {
    this.totalTokens = Number(totalTokens) || 128000
    this.reservedOutputTokens = Number(reservedOutputTokens) || 4096
    this.reservedSystemTokens = Number(reservedSystemTokens) || 2000
    this.availableTokens = Math.max(0, this.totalTokens - this.reservedOutputTokens - this.reservedSystemTokens)
  }

  estimateTokens(text) {
    return estimateTokens(text)
  }

  /**
   * Preflight context estimation before sending request payload to the model provider.
   */
  estimatePreflightTokens({ systemMessage = '', userMessage = '', messages = [], tools = [] } = {}) {
    let tokens = 0
    if (systemMessage) tokens += estimateTokens(systemMessage)
    if (userMessage) tokens += estimateTokens(userMessage)

    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (m.content) tokens += estimateTokens(String(m.content))
        if (m.tool_calls) tokens += estimateTokens(JSON.stringify(m.tool_calls))
      }
    }

    if (Array.isArray(tools) && tools.length > 0) {
      tokens += estimateTokens(JSON.stringify(tools))
    }

    return tokens
  }

  /**
   * Evaluates the staged degradation sequence:
   * normal (<= 60%) -> compress (60-80%) -> summarize (80-90%) -> pin/conservative (90-100%) -> exhausted (100%)
   */
  evaluateDegradationStage({ currentTokens, totalTokens = this.totalTokens, turn = 1, maxTurns = 50 } = {}) {
    const ratio = Math.min(1.0, Math.max(0, currentTokens / Math.max(1000, totalTokens)))
    const turnRatio = turn / Math.max(1, maxTurns)

    if (ratio >= 1.0 || turnRatio >= 1.0) {
      return {
        stage: DEGRADATION_STAGES.EXHAUSTED,
        ratio,
        canProceed: false,
        action: 'checkpoint_and_stop'
      }
    }

    if (ratio >= 0.90 || turnRatio >= 0.90) {
      return {
        stage: DEGRADATION_STAGES.CONSERVATIVE,
        ratio,
        canProceed: true,
        action: 'restrict_to_readonly_and_finish'
      }
    }

    if (ratio >= 0.80) {
      return {
        stage: DEGRADATION_STAGES.SUMMARIZE,
        ratio,
        canProceed: true,
        action: 'mandatory_summary_and_facts_pinning'
      }
    }

    if (ratio >= 0.60) {
      return {
        stage: DEGRADATION_STAGES.COMPRESS,
        ratio,
        canProceed: true,
        action: 'compress_observations'
      }
    }

    return {
      stage: DEGRADATION_STAGES.NORMAL,
      ratio,
      canProceed: true,
      action: 'normal_execution'
    }
  }

  packChunks(chunks = [], maxBudget = null) {
    const included = []
    const discarded = []
    const seenKeys = new Set()

    const effectiveBudget = (maxBudget !== null && maxBudget !== undefined && Number(maxBudget) > 0)
      ? Math.min(Number(maxBudget), this.availableTokens)
      : this.availableTokens

    // 1. Deduplicate chunks
    const uniqueChunks = []
    for (const chunk of chunks) {
      const key = `${chunk.type}:${chunk.path || ''}:${chunk.id}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      uniqueChunks.push(chunk)
    }

    // 2. Rank chunks: first by Priority (descending), then by Score (descending)
    uniqueChunks.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return b.score - a.score
    })

    // 3. Fill budget
    let usedTokens = 0
    for (const chunk of uniqueChunks) {
      const chunkTokens = chunk.tokens || estimateTokens(chunk.content)
      if (usedTokens + chunkTokens <= effectiveBudget) {
        included.push(chunk)
        usedTokens += chunkTokens
      } else {
        discarded.push(chunk)
      }
    }

    return {
      includedChunks: included,
      discardedChunks: discarded,
      tokenBudget: {
        total: this.totalTokens,
        used: usedTokens + this.reservedSystemTokens,
        remaining: Math.max(0, this.availableTokens - usedTokens)
      }
    }
  }
}
