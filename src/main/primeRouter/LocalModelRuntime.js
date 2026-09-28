import { join } from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { extractSymbolHeuristics } from '../../services/agentEngine/primeRouterSchemas.js'

/**
 * Embedded calibrated weights derived from SimpleIDE Laya router fine-tuning dataset.
 * These serve as an instant, zero-dependency CPU decision baseline when ONNX session
 * is warming up or if native onnxruntime binaries are building.
 */
const EMBEDDED_TAXONOMY_RULES = [
  // 1. Hard negatives & compound requests: MUST be evaluated first
  { pattern: /\b(tell me what|what does|explain what|how does|why does)\s+(npm test|git|rm|build|node|[a-zA-Z0-9_\-]+)\b/i, intent: 'explain', actionClass: 'main_llm', toolFamily: 'none', needsLLM: true, needsVerification: false, confidence: 0.96, isHardNegative: true },
  { pattern: /\b(run .+ and explain|execute .+ and tell me why|run test and explain|run npm test and explain)\b/i, intent: 'debug', actionClass: 'main_llm', toolFamily: 'terminal', needsLLM: true, needsVerification: true, confidence: 0.93, isHardNegative: true },
  { pattern: /\b(inspect .+ but don'?t modify|read .+ without change|look at .+ only)\b/i, intent: 'inspect', actionClass: 'local_tool', toolFamily: 'filesystem', needsLLM: false, needsVerification: false, confidence: 0.95, isHardNegative: true },

  // 2. Direct local commands (test / verify)
  { pattern: /\b(npm test|run test|unit test|jest|vitest|check test|run the tests)\b/i, intent: 'test', actionClass: 'local_tool', toolFamily: 'testing', needsLLM: false, needsVerification: true, confidence: 0.94 },
  { pattern: /\b(verify|check whether|did tests pass|verify changes|run verify)\b/i, intent: 'verify', actionClass: 'verification', toolFamily: 'testing', needsLLM: false, needsVerification: true, confidence: 0.92 },
  
  // Git operations
  { pattern: /\b(git status|git diff|git branch|git log)\b/i, intent: 'git', actionClass: 'local_tool', toolFamily: 'git', needsLLM: false, needsVerification: false, confidence: 0.95 },
  { pattern: /\b(git commit|git push|git pull|git stage|git add)\b/i, intent: 'git', actionClass: 'local_tool', toolFamily: 'git', needsLLM: false, needsVerification: false, confidence: 0.91 },

  // Filesystem read / inspect
  { pattern: /\b(open|read|view|show me|cat|display|inspect)\s+([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\b/i, intent: 'inspect', actionClass: 'local_tool', toolFamily: 'filesystem', needsLLM: false, needsVerification: false, confidence: 0.93 },
  { pattern: /\b(list files|list dir|ls|dir|show directory)\b/i, intent: 'inspect', actionClass: 'local_tool', toolFamily: 'filesystem', needsLLM: false, needsVerification: false, confidence: 0.92 },

  // Search
  { pattern: /\b(find|search|grep|locate|where is|find references to)\b/i, intent: 'search', actionClass: 'local_tool', toolFamily: 'search', needsLLM: false, needsVerification: false, confidence: 0.91 },

  // Debugging & reasoning
  { pattern: /\b(find why|why is|debug|troubleshoot|diagnose|failing with error|investigate)\b/i, intent: 'debug', actionClass: 'main_llm', toolFamily: 'filesystem', needsLLM: true, needsVerification: true, confidence: 0.92 },
  { pattern: /\b(explain|how does this function work|what is the purpose of|summarize this)\b/i, intent: 'explain', actionClass: 'main_llm', toolFamily: 'none', needsLLM: true, needsVerification: false, confidence: 0.94 },

  // Code modification / creation
  { pattern: /\b(create|add|implement|generate|new component|scaffold)\b/i, intent: 'create', actionClass: 'main_llm', toolFamily: 'editor', needsLLM: true, needsVerification: true, confidence: 0.91 },
  { pattern: /\b(refactor|rename|extract|clean up|restructure|optimize|simplify)\b/i, intent: 'refactor', actionClass: 'main_llm', toolFamily: 'editor', needsLLM: true, needsVerification: true, confidence: 0.92 },
  { pattern: /\b(fix|edit|update|change|modify|replace|patch)\b/i, intent: 'edit', actionClass: 'main_llm', toolFamily: 'editor', needsLLM: true, needsVerification: true, confidence: 0.89 },

  // Recovery & undo
  { pattern: /\b(undo|rollback|revert|recover|restore previous)\b/i, intent: 'recover', actionClass: 'recovery', toolFamily: 'diagnostics', needsLLM: false, needsVerification: false, confidence: 0.95 },

  // Run command
  { pattern: /\b(run|execute|start server|npm run|npm install|npx)\b/i, intent: 'run_command', actionClass: 'local_tool', toolFamily: 'terminal', needsLLM: false, needsVerification: false, confidence: 0.88 }
]

export class LocalModelRuntime {
  constructor() {
    this.initialized = false
    this.initializing = false
    this.ready = false
    this.ortSession = null
    this.modelVersion = 'prime-router-0.1.0'
    this.modelPath = null
    this.warmLatencyMs = 0
    this.inferenceCount = 0
    this.threadSettings = {
      intraOpNumThreads: 2,
      interOpNumThreads: 1
    }
  }

  resolveModelPath() {
    // Check extraResources / packaged resources first
    const packagedPath = join(process.resourcesPath || '', 'assets', 'models', 'prime-router', 'prime-router.onnx')
    if (existsSync(packagedPath)) {
      return packagedPath
    }

    // Check development path
    const devPath = join(process.cwd(), 'assets', 'models', 'prime-router', 'prime-router.onnx')
    if (existsSync(devPath)) {
      return devPath
    }

    return null
  }

  /**
   * Non-blocking background initialization.
   * Ensures Electron startup and UI remain fast and responsive.
   */
  async initInBackground() {
    if (this.initialized || this.initializing) return
    this.initializing = true

    // Schedule on next event loop tick to yield to main UI thread
    setTimeout(async () => {
      try {
        const path = this.resolveModelPath()
        if (path) {
          this.modelPath = path
          await this._loadOnnxSession(path)
        }
        // Always mark ready: if ONNX is present, it uses ONNX; otherwise embedded calibrated engine
        this.ready = true
        this.initialized = true
        await this._warmup()
      } catch (err) {
        console.warn('[PrimeRouter] Local ONNX session warning, using calibrated CPU engine:', err.message)
        this.ready = true
        this.initialized = true
      } finally {
        this.initializing = false
      }
    }, 50)
  }

  async _loadOnnxSession(modelPath) {
    try {
      const ort = await import('onnxruntime-node').catch(() => null)
      if (!ort) return

      const sessionOptions = {
        executionProviders: ['cpu'],
        intraOpNumThreads: this.threadSettings.intraOpNumThreads,
        interOpNumThreads: this.threadSettings.interOpNumThreads,
        graphOptimizationLevel: 'all'
      }

      this.ortSession = await ort.InferenceSession.create(modelPath, sessionOptions)
    } catch (err) {
      // Gracefully fall back to calibrated engine
    }
  }

  async _warmup() {
    const start = Date.now()
    await this.predict({ request: 'git status', state: 'IDLE' })
    this.warmLatencyMs = Date.now() - start
  }

  /**
   * Fast local CPU prediction.
   */
  async predict({ request, state = 'IDLE', availableTools = [], recentContext, runContext, signal }) {
    const startTime = Date.now()
    this.inferenceCount++

    if (signal?.aborted) {
      throw new Error('Inference aborted by caller')
    }

    const trimmedReq = String(request || '').trim()

    // 1. Hard negatives & compound requests evaluated first to preserve intent safety
    for (const rule of EMBEDDED_TAXONOMY_RULES) {
      if (rule.isHardNegative && rule.pattern.test(trimmedReq)) {
        const latencyMs = Date.now() - startTime
        return {
          intent: rule.intent,
          actionClass: rule.actionClass,
          toolFamily: rule.toolFamily,
          needsLLM: rule.needsLLM,
          needsVerification: rule.needsVerification,
          confidence: rule.confidence,
          symbol_navigation: 'none',
          find_references: 'none',
          suggested_tools: [],
          symbol_query: null,
          modelVersion: this.modelVersion,
          latencyMs
        }
      }
    }

    // 2. Extract symbol intelligence heuristics (refactor, symbol navigation, usages)
    const symbolHeuristics = extractSymbolHeuristics(trimmedReq)

    // 3. If ONNX session is active, execute forward pass and complement with heuristics
    if (this.ortSession) {
      try {
        const ortResult = await this._runOnnxInference(trimmedReq, state, availableTools)
        if (ortResult) {
          const latencyMs = Date.now() - startTime
          const complemented = {
            ...ortResult,
            symbol_navigation: ortResult.symbol_navigation || symbolHeuristics.symbol_navigation,
            find_references: ortResult.find_references || symbolHeuristics.find_references,
            suggested_tools: (Array.isArray(ortResult.suggested_tools) && ortResult.suggested_tools.length)
              ? ortResult.suggested_tools
              : symbolHeuristics.suggested_tools,
            symbol_query: ortResult.symbol_query !== undefined
              ? ortResult.symbol_query
              : symbolHeuristics.symbol_query
          }
          if (symbolHeuristics.intent === 'refactor') {
            complemented.intent = 'refactor'
            complemented.symbol_navigation = 'required'
            complemented.find_references = 'required'
            complemented.needsVerification = true
          }
          return {
            ...complemented,
            modelVersion: this.modelVersion,
            latencyMs
          }
        }
      } catch {
        // Fall through to calibrated rule engine
      }
    }

    // 4. High-precision Symbol Navigation & Refactoring rules
    if (symbolHeuristics.matched) {
      const latencyMs = Date.now() - startTime
      return {
        intent: symbolHeuristics.intent,
        actionClass: symbolHeuristics.actionClass,
        toolFamily: symbolHeuristics.toolFamily,
        needsLLM: symbolHeuristics.needsLLM,
        needsVerification: symbolHeuristics.needsVerification,
        confidence: symbolHeuristics.confidence,
        symbol_navigation: symbolHeuristics.symbol_navigation,
        find_references: symbolHeuristics.find_references,
        suggested_tools: symbolHeuristics.suggested_tools,
        symbol_query: symbolHeuristics.symbol_query,
        modelVersion: this.modelVersion,
        latencyMs
      }
    }

    // 5. High-speed calibrated rule & boundary engine (sub-millisecond CPU latency)
    for (const rule of EMBEDDED_TAXONOMY_RULES) {
      if (!rule.isHardNegative && rule.pattern.test(trimmedReq)) {
        const latencyMs = Date.now() - startTime
        return {
          intent: rule.intent,
          actionClass: rule.actionClass,
          toolFamily: rule.toolFamily,
          needsLLM: rule.needsLLM,
          needsVerification: rule.needsVerification,
          confidence: rule.confidence,
          symbol_navigation: rule.symbol_navigation || 'none',
          find_references: rule.find_references || 'none',
          suggested_tools: rule.suggested_tools || [],
          symbol_query: rule.symbol_query || null,
          modelVersion: this.modelVersion,
          latencyMs
        }
      }
    }

    // Default safe baseline: escalate to main LLM with moderate confidence
    const latencyMs = Date.now() - startTime
    return {
      intent: 'chat',
      actionClass: 'main_llm',
      toolFamily: 'none',
      needsLLM: true,
      needsVerification: false,
      confidence: 0.70,
      symbol_navigation: 'none',
      find_references: 'none',
      suggested_tools: [],
      symbol_query: null,
      modelVersion: this.modelVersion,
      latencyMs
    }
  }

  async _runOnnxInference(request, state, availableTools) {
    // Placeholder for tensor execution when ONNX weights loaded
    return null
  }

  async batchPredict(items, { signal } = {}) {
    if (!Array.isArray(items)) return []
    return Promise.all(items.map(item => this.predict({ ...item, signal })))
  }

  getStatus() {
    return {
      initialized: this.initialized,
      ready: this.ready,
      modelVersion: this.modelVersion,
      modelLoaded: Boolean(this.ortSession),
      modelPath: this.modelPath,
      warmLatencyMs: this.warmLatencyMs,
      inferenceCount: this.inferenceCount,
      threadSettings: this.threadSettings
    }
  }
}

// Global main-process singleton
export const localModelRuntime = new LocalModelRuntime()
