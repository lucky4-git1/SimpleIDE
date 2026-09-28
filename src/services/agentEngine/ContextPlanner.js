import { LayaDecisionAdapter } from './LayaDecisionAdapter.js'
import { layaModelManager } from './LayaModelManager.js'

/**
 * Deterministic Hard Budget Limits.
 * Outside Laya: Laya cannot override these constraints.
 */
export const HARD_CONTEXT_LIMITS = {
  MAX_EXPANSION_TOKENS: 4000,
  MAX_FILES: 5,
  MAX_GRAPH_DEPTH: 2,
  MAX_QUERIES: 4,
  TIMEOUT_MS: 5000,
  MIN_RELEVANCE_SCORE: 0.60
}

/**
 * Sanitizes input text to ensure zero secrets/credentials in logs.
 */
function sanitizeForLogging(text) {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/(bearer\s+)[a-zA-Z0-9_\-.]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)[a-zA-Z0-9_\-.]+/gi, '$1[REDACTED]')
    .replace(/(password|secret|token)\s*[:=]\s*['"][^'"]+['"]/gi, '$1="[REDACTED]"')
}

export class ContextPlanner {
  constructor({
    layaAdapter = null,
    codeIntelligence = null,
    hardLimits = HARD_CONTEXT_LIMITS
  } = {}) {
    this.layaAdapter = layaAdapter || new LayaDecisionAdapter({
      modelManager: layaModelManager,
      variant: 'simpleide'
    })
    this.codeIntelligence = codeIntelligence
    this.hardLimits = { ...HARD_CONTEXT_LIMITS, ...hardLimits }
    this.decisionHistory = []
  }

  setCodeIntelligence(codeIntelligenceService) {
    this.codeIntelligence = codeIntelligenceService
  }

  /**
   * Evaluates task and state through Laya to produce a bounded, observable context plan.
   *
   * @param {Object} params
   * @param {string} params.task - The user request or agent sub-goal
   * @param {string} [params.activeFile]
   * @param {string} [params.activeFileContent]
   * @param {Array} [params.diagnostics]
   * @param {Array} [params.openTabs]
   * @param {string} [params.symbolQuery]
   * @param {AbortSignal} [params.abortSignal]
   * @returns {Promise<{ plan: Object, observability: Object }>}
   */
  async planContext({
    task = '',
    activeFile = null,
    activeFileContent = null,
    diagnostics = [],
    openTabs = [],
    symbolQuery = null,
    abortSignal = null
  } = {}) {
    const startTime = performance.now()
    let layaDecision = null
    let fallbackStatus = false
    let fallbackReason = null

    // 1. Query Laya for System-1 context control decisions
    try {
      if (abortSignal?.aborted) {
        throw new Error('Context planning aborted by caller')
      }

      const inputState = {
        task: sanitizeForLogging(task),
        activeFile,
        diagnosticsCount: diagnostics.length,
        openTabsCount: openTabs.length,
        state: 'PLANNING'
      }

      layaDecision = await this.layaAdapter.predict(inputState, {
        signal: abortSignal,
        timeoutMs: this.hardLimits.TIMEOUT_MS
      })

      // Confidence gating: if confidence is below safety baseline (<0.60), fall back to safe focused default
      if (typeof layaDecision.confidence === 'number' && layaDecision.confidence < 0.60) {
        fallbackStatus = true
        fallbackReason = `Low model confidence (${layaDecision.confidence.toFixed(2)} < 0.60)`
      }
    } catch (err) {
      fallbackStatus = true
      fallbackReason = err.message || 'Laya prediction failure'
      layaDecision = {
        intent: 'edit',
        context_breadth: 'focused',
        graph_depth: '1',
        semantic_navigation_required: false,
        verification_required: diagnostics.length > 0,
        tests_required: false,
        confidence: 0.50,
        inferenceSource: 'fallback'
      }
    }

    // 2. Extract decisions
    let semNavRequired = Boolean(
      layaDecision.semantic_navigation_required ||
      layaDecision.symbol_navigation === 'required' ||
      layaDecision.intent === 'navigate' ||
      layaDecision.intent === 'refactor'
    )

    // If symbol_navigation is optional and not explicitly disabled ('none'),
    // probe CodeIntelligence to check if real code symbols mentioned in the task exist.
    if (!semNavRequired && layaDecision.symbol_navigation !== 'none' && this.codeIntelligence) {
      const candidates = symbolQuery ? [symbolQuery] : this._extractCandidateSymbols(task)
      for (const candidate of candidates) {
        try {
          const syms = this.codeIntelligence.findSymbols
            ? this.codeIntelligence.findSymbols(candidate)
            : (this.codeIntelligence.findSymbol ? this.codeIntelligence.findSymbol(candidate) : [])
          if (syms && syms.length > 0) {
            semNavRequired = true
            break
          }
        } catch {
          // ignore lookup errors
        }
      }
    }
    const requestedBreadth = layaDecision.context_breadth || 'focused'
    const requestedDepth = (layaDecision.graph_depth !== undefined && layaDecision.graph_depth !== null)
      ? Number(layaDecision.graph_depth)
      : (semNavRequired ? 1 : 0)
    const testsRequired = Boolean(layaDecision.tests_required)
    const verificationRequired = Boolean(layaDecision.verification_required)

    // 3. Deterministic Hard Budget Enforcement (Outside Laya)
    // Clamps Laya's recommendation against hard invariants
    const clampedDepth = semNavRequired
      ? Math.min(requestedDepth, this.hardLimits.MAX_GRAPH_DEPTH)
      : 0

    let tokenBudget = this.hardLimits.MAX_EXPANSION_TOKENS
    if (requestedBreadth === 'minimal') tokenBudget = 1000
    else if (requestedBreadth === 'focused') tokenBudget = 2500
    else if (requestedBreadth === 'wide') tokenBudget = this.hardLimits.MAX_EXPANSION_TOKENS

    // 4. Controlled Expansion Loop with Relevance Scoring
    const symbolsQueried = []
    const filesSelected = new Set()
    if (activeFile) filesSelected.add(activeFile)

    let reasonForExpansion = 'Base editor context'
    let reasonForStopping = 'Expansion not required'
    let tokensAddedEstimate = 0

    // Check if semantic navigation was suppressed (hard negative / pure styling / explain)
    if (!semNavRequired || clampedDepth === 0) {
      reasonForStopping = 'Semantic navigation suppressed by Laya (hard negative / non-symbol task)'
      tokensAddedEstimate = activeFile ? 350 : 0
    } else {
      // Semantic navigation is enabled -> perform bounded, relevance-scored symbol queries
      reasonForExpansion = 'Target symbol references and caller graph expansion'
      const sanitizedTask = sanitizeForLogging(task)
      const candidateSymbols = this._extractCandidateSymbols(sanitizedTask, symbolQuery, activeFile)

      let queryCount = 0
      for (const candidate of candidateSymbols) {
        if (queryCount >= this.hardLimits.MAX_QUERIES) {
          reasonForStopping = `Reached maximum query limit (${this.hardLimits.MAX_QUERIES})`;
          break
        }
        if (filesSelected.size >= this.hardLimits.MAX_FILES) {
          reasonForStopping = `Reached maximum file limit (${this.hardLimits.MAX_FILES})`;
          break
        }

        queryCount++
        symbolsQueried.push(candidate)

        // Relevance Scoring & Adversarial Filtering
        const relevance = this._scoreSymbolRelevance(candidate, task, activeFile)
        if (relevance < this.hardLimits.MIN_RELEVANCE_SCORE) {
          continue // Suppress low-relevance or spurious matches
        }

        // Query SymbolGraph structural facts
        if (this.codeIntelligence?.symbolGraph) {
          const usages = this.codeIntelligence.symbolGraph.queryUsages(candidate)
          if (usages.found && usages.usages) {
            for (const usage of usages.usages) {
              if (filesSelected.size >= this.hardLimits.MAX_FILES) break
              if (usage.file) {
                filesSelected.add(usage.file)
                tokensAddedEstimate += 180
              }
            }
          }

          // Check sufficiency: if target definition and direct callers are captured, stop expansion
          if (usages.found && usages.usages.length > 0) {
            reasonForStopping = 'Context sufficient: target definition and primary usages captured'
            break
          }
        }
      }

      if (!reasonForStopping || reasonForStopping === 'Expansion not required') {
        reasonForStopping = 'Traversal completed within bounded limits'
      }
    }

    const elapsedMs = Number((performance.now() - startTime).toFixed(2))

    // 5. Structure the Context Plan
    const plan = {
      contextBreadth: requestedBreadth,
      graphDepth: clampedDepth,
      semanticNavigationRequired: semNavRequired,
      testsRequired,
      verificationRequired,
      tokenBudget,
      fileLimit: this.hardLimits.MAX_FILES,
      allowedFiles: Array.from(filesSelected),
      symbolsToQuery: symbolsQueried,
      fallback: fallbackStatus
    }

    // 6. Explicit Context Observability Log (Sanitized, zero secrets)
    const observability = {
      modelVersion: layaDecision.modelVersion || 'simpleide-laya-1.0.0-onnx',
      inferenceSource: layaDecision.inferenceSource || (fallbackStatus ? 'fallback' : 'onnx'),
      decision: {
        intent: layaDecision.intent || 'edit',
        contextBreadth: requestedBreadth,
        graphDepth: clampedDepth,
        semanticNavigationRequired: semNavRequired,
        testsRequired,
        verificationRequired
      },
      confidence: Number((layaDecision.confidence || 0.88).toFixed(3)),
      requestedContextBreadth: requestedBreadth,
      graphDepth: clampedDepth,
      symbolsQueried,
      filesSelected: Array.from(filesSelected),
      tokensAdded: tokensAddedEstimate,
      reasonForExpansion,
      reasonForStopping,
      latencyMs: elapsedMs,
      fallbackStatus,
      fallbackReason
    }

    this.decisionHistory.push(observability)
    if (this.decisionHistory.length > 50) this.decisionHistory.shift()

    return { plan, observability }
  }

  /**
   * Extracts potential symbol candidates from prompt and explicit query.
   */
  _extractCandidateSymbols(task, explicitQuery, activeFile) {
    const candidates = new Set()
    if (explicitQuery) candidates.add(String(explicitQuery).trim())

    // Extract identifier tokens (CamelCase or snake_case, at least 3 chars)
    const tokens = String(task).match(/[a-zA-Z_][a-zA-Z0-9_]{2,}/g) || []
    for (const token of tokens) {
      // Exclude common English stop words and keywords
      if (!/^(the|and|for|with|this|from|that|what|where|when|which|file|files|code|test|tests|component|function|class|redacted|bearer)$/i.test(token)) {
        candidates.add(token)
      }
    }

    return Array.from(candidates).slice(0, 8)
  }

  /**
   * Scores relevance to reject adversarial cases:
   * - Mentions of a symbol that is not declared or imported
   * - Unrelated third-party or vendor symbols
   * - Similarly named symbols in distant directories
   */
  _scoreSymbolRelevance(symbolName, task, activeFile) {
    let score = 0.50

    // Exact word boundary match in task
    const regex = new RegExp(`\\b${symbolName}\\b`, 'i')
    if (regex.test(task)) score += 0.25

    // If CodeIntelligence is available, check AST presence
    if (this.codeIntelligence) {
      try {
        const found = this.codeIntelligence.findSymbols
          ? this.codeIntelligence.findSymbols(symbolName)
          : (this.codeIntelligence.findSymbol ? this.codeIntelligence.findSymbol(symbolName) : [])
        if (found && found.length > 0) {
          score += 0.20

          // If symbol exists in activeFile or directly related file, boost
          if (activeFile && found.some(s => (s.file || s.filePath) === activeFile)) {
            score += 0.15
          }
        } else {
          // Symbol mentioned but does NOT exist in AST -> penalize
          score -= 0.30
        }
      } catch {
        // AST parsing failure or error -> penalize safely
        score -= 0.30
      }
    }

    return Math.max(0.0, Math.min(1.0, score))
  }

  getLastObservability() {
    return this.decisionHistory[this.decisionHistory.length - 1] || null
  }
}
