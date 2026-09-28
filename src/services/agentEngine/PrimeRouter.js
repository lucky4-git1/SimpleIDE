import {
  PrimeRouterInputSchema,
  PrimeRouterDecisionSchema,
  ROUTER_MODES,
  CONFIDENCE_THRESHOLDS,
  createFallbackDecision
} from './primeRouterSchemas.js'
import { layaDecisionAdapter } from './LayaDecisionAdapter.js'
import { LayaSafetyPolicy } from './LayaSafetyPolicy.js'

export const LAYA_ROLLOUT_MODES = Object.freeze({
  LEGACY: 'legacy',
  SHADOW: 'shadow',
  HYBRID: 'hybrid',
  LAYA: 'laya'
})

function sanitizeForLogging(text) {
  if (!text) return ''
  return String(text)
    .replace(/(?:bearer\s+|token[=:]\s*|password[=:]\s*|api[_-]?key[=:]\s*)[a-zA-Z0-9_.\-]+/gi, '[REDACTED_SECRET]')
    .slice(0, 500)
}

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
   * @param {string} [options.layaMode] - 'legacy' | 'shadow' | 'hybrid' | 'laya'
   * @param {string} [options.modelVersion='prime-router-0.1.0']
   */
  constructor({
    adapter = null,
    maxCacheSize = 128,
    cacheTtlMs = 60000,
    enabled = true,
    mode = ROUTER_MODES.ASSIST,
    layaMode = null,
    modelVersion = 'prime-router-0.1.0'
  } = {}) {
    this.adapter = adapter
    this.maxCacheSize = Math.max(1, Number(maxCacheSize) || 128)
    this.cacheTtlMs = Math.max(1000, Number(cacheTtlMs) || 60000)
    this.enabled = Boolean(enabled)
    this.mode = Object.values(ROUTER_MODES).includes(mode) ? mode : ROUTER_MODES.ASSIST
    const resolvedLayaMode = layaMode || process.env.SIMPLEIDE_LAYA_MODE || (adapter ? LAYA_ROLLOUT_MODES.LEGACY : LAYA_ROLLOUT_MODES.HYBRID)
    this.layaMode = Object.values(LAYA_ROLLOUT_MODES).includes(resolvedLayaMode) ? resolvedLayaMode : LAYA_ROLLOUT_MODES.HYBRID
    this.modelVersion = modelVersion
    this.cache = new Map() // LRU cache: key -> { decision, expiresAt }
    this.shadowTelemetry = [] // Records agreement/disagreement metrics
    this._pendingShadowPromises = new Set()
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

    // 4. Multi-mode Laya evaluation
    try {
      if (params.signal?.aborted) {
        throw new Error('Routing aborted by user')
      }

      let decision = null

      if (this.layaMode === LAYA_ROLLOUT_MODES.LAYA) {
        // Direct Laya execution
        try {
          const layaResult = await layaDecisionAdapter.predict({
            request: input.request,
            state: input.state,
            availableTools: input.availableTools,
            recentContext: input.recentContext,
            runContext: input.runContext,
            signal: params.signal
          })
          if (layaResult && layaResult.confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) {
            decision = layaResult
          }
        } catch (_) {
          // Fall back to adapter below
        }
      } else if (this.layaMode === LAYA_ROLLOUT_MODES.HYBRID) {
        // Hybrid: low-risk operations use Laya; high-risk edits use main LLM
        try {
          const layaResult = await layaDecisionAdapter.predict({
            request: input.request,
            state: input.state,
            availableTools: input.availableTools,
            recentContext: input.recentContext,
            runContext: input.runContext,
            signal: params.signal
          })
          if (layaResult && (layaResult.risk === 'low' || layaResult.intent === 'navigate') && layaResult.confidence >= CONFIDENCE_THRESHOLDS.HIGH) {
            decision = layaResult
          }
        } catch (_) {
          // Fall back to adapter below
        }
      }

      // If not decided by Laya (or in legacy/shadow mode), use adapter
      if (!decision) {
        const rawResult = await this.adapter.predict({
          request: input.request,
          state: input.state,
          availableTools: input.availableTools,
          recentContext: input.recentContext,
          runContext: input.runContext,
          signal: params.signal
        })
        decision = rawResult
      }

      const latencyMs = Date.now() - startTime

      // 5. Strictly validate output schema
      const parseResult = PrimeRouterDecisionSchema.safeParse({
        ...decision,
        modelVersion: decision?.modelVersion || this.modelVersion,
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

      decision = parseResult.data

      // 6. Shadow mode parallel execution & telemetry
      if (this.layaMode === LAYA_ROLLOUT_MODES.SHADOW) {
        const shadowPromise = (async () => {
          try {
            const shadowStart = Date.now()
            const layaShadowDecision = await layaDecisionAdapter.predict({
              request: input.request,
              state: input.state,
              availableTools: input.availableTools,
              recentContext: input.recentContext,
              runContext: input.runContext
            })
            const layaLatency = layaShadowDecision?.latencyMs ?? (Date.now() - shadowStart)
            const intentMatch = layaShadowDecision?.intent === decision.intent
            const actionMatch = layaShadowDecision?.actionClass === decision.actionClass
            const toolMatch = layaShadowDecision?.toolFamily === decision.toolFamily
            const needsLlmMatch = layaShadowDecision?.needsLLM === decision.needsLLM
            const agreement = Boolean(intentMatch && actionMatch && toolMatch)

            const telemetryEntry = {
              timestamp: Date.now(),
              request: sanitizeForLogging(input.request),
              productionIntent: decision.intent,
              layaIntent: layaShadowDecision?.intent,
              productionConfidence: decision.confidence,
              layaConfidence: layaShadowDecision?.confidence,
              legacyDecision: {
                intent: decision.intent,
                actionClass: decision.actionClass,
                toolFamily: decision.toolFamily,
                needsLLM: decision.needsLLM,
                needsVerification: decision.needsVerification,
                confidence: decision.confidence,
                latencyMs
              },
              layaDecision: layaShadowDecision ? {
                intent: layaShadowDecision.intent,
                actionClass: layaShadowDecision.actionClass,
                toolFamily: layaShadowDecision.toolFamily,
                needsLLM: layaShadowDecision.needsLLM,
                needsVerification: layaShadowDecision.needsVerification,
                confidence: layaShadowDecision.confidence,
                inferenceSource: layaShadowDecision.inferenceSource || 'fallback',
                modelVersion: layaShadowDecision.modelVersion,
                symbol_navigation: layaShadowDecision.symbol_navigation,
                context_breadth: layaShadowDecision.context_breadth,
                graph_depth: layaShadowDecision.graph_depth,
                risk: layaShadowDecision.risk,
                stuck: layaShadowDecision.stuck,
                latencyMs: layaLatency
              } : null,
              agreement,
              disagreements: {
                intent: !intentMatch,
                actionClass: !actionMatch,
                toolFamily: !toolMatch,
                needsLLM: !needsLlmMatch
              },
              confidence: {
                legacy: decision.confidence,
                laya: layaShadowDecision?.confidence ?? 0
              },
              latency: {
                legacyMs: latencyMs,
                layaMs: layaLatency
              },
              fallback: Boolean(layaShadowDecision?.fallback || layaShadowDecision?.inferenceSource === 'fallback'),
              fallbackReason: layaShadowDecision?.reason || null,
              inferenceSource: layaShadowDecision?.inferenceSource || 'fallback',
              modelVersion: layaShadowDecision?.modelVersion || 'unknown',
              contextDecision: {
                breadth: layaShadowDecision?.context_breadth || 'focused',
                depth: layaShadowDecision?.graph_depth ?? (layaShadowDecision?.symbol_navigation === 'required' ? 1 : 0),
                symbol_navigation: layaShadowDecision?.symbol_navigation || 'none'
              },
              toolFamilyDecision: {
                legacy: decision.toolFamily,
                laya: layaShadowDecision?.toolFamily
              },
              riskDecision: layaShadowDecision?.risk || 'low'
            }

            this.shadowTelemetry.push(telemetryEntry)
            if (this.shadowTelemetry.length > 1000) {
              this.shadowTelemetry.shift()
            }
          } catch (_) {
            // Shadow mode failures never disrupt production flow
          }
        })()

        this._pendingShadowPromises.add(shadowPromise)
        shadowPromise.finally(() => {
          this._pendingShadowPromises.delete(shadowPromise)
        })
      }

      // 7. Deterministic Safety Policy Gate
      const safetyCheck = LayaSafetyPolicy.evaluate(decision, { command: input.request })
      if (!safetyCheck.allowed) {
        decision = {
          ...decision,
          actionClass: 'user_input',
          needsLLM: true,
          fallback: true,
          reason: safetyCheck.reason || 'Blocked by safety policy'
        }
      }

      // 8. Confidence Calibration & Thresholding Policy
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

  setLayaMode(mode) {
    if (Object.values(LAYA_ROLLOUT_MODES).includes(mode)) {
      this.layaMode = mode
    }
  }

  getShadowTelemetry() {
    return [...this.shadowTelemetry]
  }

  async flushShadowTelemetry() {
    if (this._pendingShadowPromises.size > 0) {
      await Promise.all(Array.from(this._pendingShadowPromises))
    }
    return this.getShadowTelemetry()
  }

  getShadowTelemetrySummary() {
    const list = this.shadowTelemetry
    const total = list.length
    if (total === 0) {
      return {
        totalDecisions: 0,
        agreementRate: 100,
        disagreementRate: 0,
        confidenceDistribution: { below60: 0, medium60to85: 0, high85to95: 0, veryHigh95plus: 0 },
        legacyLatency: { p50: 0, p95: 0, p99: 0, mean: 0 },
        layaLatency: { p50: 0, p95: 0, p99: 0, mean: 0 },
        fallbackCount: 0,
        fallbackFrequency: 0,
        categoryDisagreements: { intent: 0, actionClass: 0, toolFamily: 0, needsLLM: 0 },
        contextSelectionDifferences: 0
      }
    }

    let agreements = 0
    let fallbacks = 0
    let contextDifferences = 0
    const catDisagreements = { intent: 0, actionClass: 0, toolFamily: 0, needsLLM: 0 }
    const confDist = { below60: 0, medium60to85: 0, high85to95: 0, veryHigh95plus: 0 }

    const legacyLats = []
    const layaLats = []

    for (const item of list) {
      if (item.agreement) agreements++
      if (item.fallback) fallbacks++
      if (item.disagreements?.intent) catDisagreements.intent++
      if (item.disagreements?.actionClass) catDisagreements.actionClass++
      if (item.disagreements?.toolFamily) catDisagreements.toolFamily++
      if (item.disagreements?.needsLLM) catDisagreements.needsLLM++

      if (item.contextDecision?.symbol_navigation === 'none') {
        contextDifferences++
      }

      const conf = item.confidence?.laya ?? 0
      if (conf < 0.60) confDist.below60++
      else if (conf < 0.85) confDist.medium60to85++
      else if (conf < 0.95) confDist.high85to95++
      else confDist.veryHigh95plus++

      if (typeof item.latency?.legacyMs === 'number') legacyLats.push(item.latency.legacyMs)
      if (typeof item.latency?.layaMs === 'number') layaLats.push(item.latency.layaMs)
    }

    const calcPercentiles = (arr) => {
      if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, mean: 0 }
      const sorted = [...arr].sort((a, b) => a - b)
      const mean = Number((sorted.reduce((s, v) => s + v, 0) / sorted.length).toFixed(2))
      const p50 = sorted[Math.floor(sorted.length * 0.50)]
      const p95 = sorted[Math.floor(sorted.length * 0.95)]
      const p99 = sorted[Math.floor(sorted.length * 0.99)]
      return { p50, p95, p99, mean }
    }

    return {
      totalDecisions: total,
      agreementRate: Number(((agreements / total) * 100).toFixed(1)),
      disagreementRate: Number((((total - agreements) / total) * 100).toFixed(1)),
      confidenceDistribution: confDist,
      legacyLatency: calcPercentiles(legacyLats),
      layaLatency: calcPercentiles(layaLats),
      fallbackCount: fallbacks,
      fallbackFrequency: Number(((fallbacks / total) * 100).toFixed(1)),
      categoryDisagreements: catDisagreements,
      contextSelectionDifferences: contextDifferences
    }
  }

  clearShadowTelemetry() {
    this.shadowTelemetry = []
  }

  getStatus() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      layaMode: this.layaMode,
      modelVersion: this.modelVersion,
      cacheSize: this.cache.size,
      maxCacheSize: this.maxCacheSize,
      hasAdapter: Boolean(this.adapter),
      adapterType: this.adapter?.constructor?.name || (this.adapter ? 'CustomAdapter' : 'None'),
      shadowTelemetryCount: this.shadowTelemetry.length
    }
  }
}
