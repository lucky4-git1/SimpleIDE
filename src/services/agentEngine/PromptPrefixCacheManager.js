/**
 * PromptPrefixCacheManager.js
 *
 * Implements Phase 18: Prompt Prefix Caching
 * Segregates stable content (system prompt, agent policies, tool schemas, repository instructions)
 * from dynamic conversation turns to leverage provider prefix caching.
 * Tracks cache hits, misses, tokens saved, and hit rates.
 */

function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return hash.toString(16)
}

export class PromptPrefixCacheManager {
  constructor() {
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      tokensSaved: 0,
      lastPrefixHash: null
    }
  }

  /**
   * Builds provider-optimized prefix payload with cache annotations where supported.
   */
  prepareCachedPrefix(provider, { systemPrompt, toolDefinitions = [], projectMetadata = '' }) {
    const p = String(provider || '').toLowerCase()
    const stableContent = `${systemPrompt}\n\n[Project Metadata]\n${projectMetadata}`
    const prefixHash = hashString(stableContent + JSON.stringify(toolDefinitions.map(t => t.name)))

    const isHit = this.stats.lastPrefixHash === prefixHash
    if (isHit) {
      this.stats.cacheHits++
      // Approximate tokens saved (~4 chars per token)
      this.stats.tokensSaved += Math.floor(stableContent.length / 4)
    } else {
      this.stats.cacheMisses++
      this.stats.lastPrefixHash = prefixHash
    }

    if (p === 'anthropic') {
      return {
        system: [
          {
            type: 'text',
            text: stableContent,
            cache_control: { type: 'ephemeral' }
          }
        ],
        cached: true,
        isHit
      }
    }

    // Default OpenAI / compatible prefix structure
    return {
      system: stableContent,
      cached: true,
      isHit
    }
  }

  getMetrics() {
    const total = this.stats.cacheHits + this.stats.cacheMisses
    const hitRate = total > 0 ? (this.stats.cacheHits / total) : 0
    return {
      ...this.stats,
      totalRequests: total,
      cacheHitRate: Number(hitRate.toFixed(2))
    }
  }

  reset() {
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      tokensSaved: 0,
      lastPrefixHash: null
    }
  }
}

export const promptPrefixCacheManager = new PromptPrefixCacheManager()
