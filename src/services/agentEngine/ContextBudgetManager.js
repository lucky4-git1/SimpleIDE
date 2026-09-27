import { estimateTokens } from './ContextChunk.js'

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

  packChunks(chunks = []) {
    const included = []
    const discarded = []
    const seenKeys = new Set()

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
      if (usedTokens + chunkTokens <= this.availableTokens) {
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
