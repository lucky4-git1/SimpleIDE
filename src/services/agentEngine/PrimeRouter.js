import {
  PrimeRouterInputSchema,
  PrimeRouterDecisionSchema,
  ROUTER_MODES,
  CONFIDENCE_THRESHOLDS,
  createFallbackDecision
} from './primeRouterSchemas.js'

/**
 * PrimeRouter: Lightweight local decision router abstraction for Prime AI.
 * Specializes in fast routing decisions (intent classification, tool family, LLM escalation).
 * Designed so that the underlying inference engine (Laya, ONNX, or custom models) can be
 * substituted without modifying AgentController, ToolRunner, or UI consumers.
 */
export class PrimeRouter {
  /**
   * @param {Object} options
   * @param {Object} [options.adapter] - Underlying model adapter with predict() method
   * @param {number} [options.maxCacheSize=128] - Bounded LRU cache size
   * @param {number} [options.cacheTtlMs=60000] - Cache TTL in milliseconds
   * @param {boolean} [options.enabled=true] - Master toggle
   * @param {string} [options.mode='assist'] - 'disabled' | 'assist' | 'active'
   * @param {string} [options.modelVersion='prime-router-0.1.0']
   */
  constructor({
    adapter = null,
    maxCacheSize = 128,
    cacheTtlMs = 60000,
    enabled = true,
    mode = ROUTER_MODES.ASSIST,
    modelVersion = 'prime-router-0.1.0'
  } = {}) {
    this.adapter = adapter
    this.maxCacheSize = Math.max(1, Number(maxCacheSize) || 128)
    this.cacheTtlMs = Math.max(1000, Number(cacheTtlMs) || 60000)
    this.enabled = Boolean(enabled)
    this.mode = Object.values(ROUTER_MODES).includes(mode) ? mode : ROUTER_MODES.ASSIST
    this.modelVersion = modelVersion
    this.cache = new Map() // LRU cache: key -> { decision, expiresAt }
  }

  setAdapter(adapter) {
    this.adapter = adapter
  }

  setMode(mode) {
    if (Object.values(ROUTER_MODES).includes(mode)) {
      this.mode = mode
    }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled)
  }

  clearCache() {
    this.cache.clear()
  }

  _computeCacheKey(input) {
    const req = String(input.request || '').trim().toLowerCase()
    const state = String(input.state || 'IDLE').toUpperCase()
    const tools = Array.isArray(input.availableTools) ? input.availableTools.slice().sort().join(',') : ''
    return `${state}::${tools}::${req}`
  }

  _getFromCache(key) {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }
    // Refresh LRU position
    this.cache.delete(key)
    this.cache.set(key, entry)
    return { ...entry.decision, cached: true, latencyMs: 0 }
  }

  _putInCache(key, decision) {
    if (this.cache.size >= this.maxCacheSize) {
      // Evict oldest entry (first key in insertion order)
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) this.cache.delete(oldestKey)
    }
    this.cache.set(key, {
      decision,
      expiresAt: Date.now() + this.cacheTtlMs
    })
  }

  /**
   * Primary routing API.
   * @param {Object} params
   * @param {string} params.request - User task or sub-action description
   * @param {string} [params.state='IDLE'] - Current agent FSM state
   * @param {string[]} [params.availableTools=[]] - Current tools available
   * @param {any} [params.recentContext] - Recent turns or observations
   * @param {Object} [params.runContext={}] - Run-specific metadata
   * @param {AbortSignal} [params.signal] - Cancellation signal
   * @returns {Promise<Object>} Strictly validated PrimeRouterDecision
   */
  async decide(params) {
    const startTime = Date.now()
    const parsedInput = PrimeRouterInputSchema.safeParse(params || {})
    if (!parsedInput.success) {
      return createFallbackDecision({
        request: params?.request || '',
        reason: 'Invalid input schema: ' + parsedInput.error.message,
        latencyMs: Date.now() - startTime,
        modelVersion: this.modelVersion
      })
    }

    const input = parsedInput.data

    // 1. Check feature flags
    if (!this.enabled || this.mode === ROUTER_MODES.DISABLED) {
      return createFallbackDecision({
        request: input.request,
        reason: 'PrimeRouter is disabled by configuration',
        latencyMs: Date.now() - startTime,
        modelVersion: this.modelVersion
      })
    }

    // 2. Check LRU Cache
    const cacheKey = this._computeCacheKey(input)
    const cached = this._getFromCache(cacheKey)
    if (cached) {
      return cached
    }

    // 3. Check adapter availability
    if (!this.adapter || typeof this.adapter.predict !== 'function') {
      const fallback = createFallbackDecision({
        request: input.request,
        reason: 'No local model adapter available',
        latencyMs: Date.now() - startTime,
        modelVersion: this.modelVersion
      })
      this._putInCache(cacheKey, fallback)
      return fallback
    }

    // 4. Delegate to adapter with timeout / signal support
    try {
      if (params.signal?.aborted) {
        throw new Error('Routing aborted by user')
      }

      const rawResult = await this.adapter.predict({
        request: input.request,
        state: input.state,
        availableTools: input.availableTools,
        recentContext: input.recentContext,
        runContext: input.runContext,
        signal: params.signal
      })

      const latencyMs = Date.now() - startTime

      // 5. Strictly validate output schema
      const parseResult = PrimeRouterDecisionSchema.safeParse({
        ...rawResult,
        modelVersion: rawResult?.modelVersion || this.modelVersion,
        latencyMs
      })

      if (!parseResult.success) {
        const fallback = createFallbackDecision({
          request: input.request,
          reason: 'Model output schema mismatch: ' + parseResult.error.message,
          latencyMs,
          modelVersion: this.modelVersion
        })
        return fallback
      }

      let decision = parseResult.data

      // 6. Confidence Calibration & Thresholding Policy
      // >= 0.85: trust local routing
      // 0.60 - 0.85: conservative fallback (require LLM for writes/terminal/unfamiliar tools)
      // < 0.60: force escalation to main LLM
      if (decision.confidence < CONFIDENCE_THRESHOLDS.MEDIUM) {
        decision = {
          ...decision,
          actionClass: 'main_llm',
          needsLLM: true,
          fallback: true,
          reason: `Low confidence (${decision.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLDS.MEDIUM})`
        }
      } else if (decision.confidence < CONFIDENCE_THRESHOLDS.HIGH) {
        // Conservative policy: if modifying or running commands, enforce needsLLM
        if (
          decision.toolFamily === 'terminal' ||
          decision.toolFamily === 'editor' ||
          decision.intent === 'edit' ||
          decision.intent === 'create' ||
          decision.intent === 'refactor'
        ) {
          decision = {
            ...decision,
            actionClass: 'main_llm',
            needsLLM: true,
            reason: `Moderate confidence (${decision.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLDS.HIGH}), conservative LLM escalation`
          }
        }
      }

      // In assist mode: decisions are advisory, record for metrics
      if (this.mode === ROUTER_MODES.ASSIST) {
        decision = {
          ...decision,
          assistMode: true
        }
      }

      this._putInCache(cacheKey, decision)
      return decision
    } catch (err) {
      const latencyMs = Date.now() - startTime
      return createFallbackDecision({
        request: input.request,
        reason: 'Adapter prediction error: ' + err.message,
        latencyMs,
        modelVersion: this.modelVersion
      })
    }
  }

  /**
   * Batched decision API: processes multiple inputs in one call.
   */
  async batchDecide(items, { signal } = {}) {
    if (!Array.isArray(items) || items.length === 0) return []

    // If the adapter supports batching natively, use it
    if (this.adapter && typeof this.adapter.batchPredict === 'function') {
      const startTime = Date.now()
      try {
        const rawResults = await this.adapter.batchPredict(items, { signal })
        const latencyMs = Math.round((Date.now() - startTime) / items.length)
        return rawResults.map((raw, idx) => {
          const validated = PrimeRouterDecisionSchema.safeParse({
            ...raw,
            modelVersion: raw?.modelVersion || this.modelVersion,
            latencyMs
          })
          return validated.success
            ? validated.data
            : createFallbackDecision({
                request: items[idx]?.request || '',
                reason: 'Batch item schema failure',
                latencyMs,
                modelVersion: this.modelVersion
              })
        })
      } catch (err) {
        // Fall back to parallel individual decide()
      }
    }

    return Promise.all(items.map(item => this.decide({ ...item, signal })))
  }

  getStatus() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      modelVersion: this.modelVersion,
      cacheSize: this.cache.size,
      maxCacheSize: this.maxCacheSize,
      hasAdapter: Boolean(this.adapter),
      adapterType: this.adapter?.constructor?.name || (this.adapter ? 'CustomAdapter' : 'None')
    }
  }
}
