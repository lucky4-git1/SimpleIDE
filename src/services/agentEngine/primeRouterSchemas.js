import { z } from 'zod'

export const PRIME_ROUTER_INTENTS = [
  'chat',
  'explain',
  'inspect',
  'search',
  'navigate',
  'create',
  'edit',
  'refactor',
  'debug',
  'test',
  'build',
  'run',
  'review',
  'architecture',
  'configuration',
  'documentation',
  'run_command',
  'git',
  'web',
  'plan',
  'continue',
  'verify',
  'finish',
  'recover'
]

export const PRIME_ROUTER_ACTION_CLASSES = [
  'local_tool',
  'main_llm',
  'verification',
  'recovery',
  'user_input',
  'complete'
]

export const PRIME_ROUTER_TOOL_FAMILIES = [
  'filesystem',
  'editor',
  'terminal',
  'git',
  'search',
  'browser',
  'diagnostics',
  'testing',
  'none'
]

export const ROUTER_MODES = Object.freeze({
  DISABLED: 'disabled',
  ASSIST: 'assist',
  ACTIVE: 'active'
})

export const CONFIDENCE_THRESHOLDS = Object.freeze({
  HIGH: 0.85,
  MEDIUM: 0.60
})

export const IntentSchema = z.enum(PRIME_ROUTER_INTENTS)
export const ActionClassSchema = z.enum(PRIME_ROUTER_ACTION_CLASSES)
export const ToolFamilySchema = z.enum(PRIME_ROUTER_TOOL_FAMILIES)

export const PrimeRouterInputSchema = z.object({
  request: z.string().min(1),
  state: z.string().optional().default('IDLE'),
  availableTools: z.array(z.string()).optional().default([]),
  recentContext: z.any().optional(),
  runContext: z.record(z.any()).optional().default({})
})

export const PrimeRouterDecisionSchema = z.object({
  intent: IntentSchema,
  actionClass: ActionClassSchema,
  toolFamily: ToolFamilySchema,
  needsLLM: z.boolean(),
  needsVerification: z.boolean(),
  confidence: z.number().min(0).max(1),
  modelVersion: z.string().default('prime-router-0.1.0'),
  latencyMs: z.number().nonnegative().default(0),
  reason: z.string().optional(),
  fallback: z.boolean().default(false),
  symbol_navigation: z.enum(['required', 'optional', 'none']).default('none'),
  find_references: z.enum(['required', 'optional', 'none']).default('none'),
  suggested_tools: z.array(z.string()).default([]),
  symbol_query: z.string().nullable().optional().default(null)
})

const STOP_SYMBOLS = new Set([
  'the', 'this', 'that', 'all', 'code', 'file', 'files', 'method', 'function',
  'class', 'interface', 'variable', 'component', 'service', 'module', 'logic',
  'implementation', 'to', 'into', 'as', 'of', 'for', 'in', 'and'
])

function cleanExtractedSymbol(sym) {
  if (!sym) return null
  const cleaned = String(sym).replace(/^[`'"]|[`'"]$/g, '').trim()
  if (!cleaned || STOP_SYMBOLS.has(cleaned.toLowerCase())) return null
  return cleaned
}

/**
 * Extracts symbol intelligence and semantic navigation heuristics from a request string.
 */
export function extractSymbolHeuristics(request) {
  const req = String(request || '').trim()
  const lower = req.toLowerCase()

  // 1. Refactor / Rename / Extract Intent Detection
  if (/\b(rename|extract|refactor)\b/i.test(req)) {
    let symbol_query = null

    // Rename pattern: "rename [keyword]? <symbol> to <newSymbol>" or "rename <symbol>"
    const renameMatch = req.match(/\brename\s+(?:function|method|class|interface|variable|const|let|var|symbol)?\s*([`'"]?[a-zA-Z0-9_$]+[`'"]?)(?:\s+(?:to|into|as)\s+([`'"]?[a-zA-Z0-9_$]+[`'"]?))?/i)
    if (renameMatch) {
      symbol_query = cleanExtractedSymbol(renameMatch[1])
    }

    // Extract pattern: "extract [keyword]? <symbol>"
    if (!symbol_query) {
      const extractMatch = req.match(/\bextract\s+(?:method|function|class|interface|variable|component)?\s*([`'"]?[a-zA-Z0-9_$]+[`'"]?)/i)
      if (extractMatch) {
        symbol_query = cleanExtractedSymbol(extractMatch[1])
      }
    }

    // Refactor pattern: "refactor [keyword]? <symbol>"
    if (!symbol_query) {
      const refactorMatch = req.match(/\brefactor\s+(?:the\s+)?(?:function|method|class|interface|module|component|service)?\s*([`'"]?[a-zA-Z0-9_$]+[`'"]?)/i)
      if (refactorMatch) {
        symbol_query = cleanExtractedSymbol(refactorMatch[1])
      }
    }

    return {
      matched: true,
      intent: 'refactor',
      actionClass: 'main_llm',
      toolFamily: 'editor',
      needsLLM: true,
      needsVerification: true,
      confidence: 0.93,
      symbol_navigation: 'required',
      find_references: 'required',
      suggested_tools: ['find_references', 'find_definition', 'query_symbol_graph'],
      symbol_query
    }
  }

  // 2. Find References / Usages Queries
  if (/\b(find\s+(?:all\s+)?references|find\s+usages|where\s+is\s+[`'"]?[a-zA-Z0-9_$]+[`'"]?\s+used|who\s+calls)\b/i.test(req)) {
    let symbol_query = null
    const refMatch = req.match(/\b(?:references\s+(?:to|for)|usages\s+of|who\s+calls)\s+([`'"]?[a-zA-Z0-9_$]+[`'"]?)/i)
    if (refMatch) {
      symbol_query = cleanExtractedSymbol(refMatch[1])
    } else {
      const usedMatch = req.match(/\bwhere\s+is\s+([`'"]?[a-zA-Z0-9_$]+[`'"]?)\s+used\b/i)
      if (usedMatch) {
        symbol_query = cleanExtractedSymbol(usedMatch[1])
      }
    }

    return {
      matched: true,
      intent: 'search',
      actionClass: 'local_tool',
      toolFamily: 'search',
      needsLLM: false,
      needsVerification: false,
      confidence: 0.94,
      symbol_navigation: 'required',
      find_references: 'required',
      suggested_tools: ['find_references', 'query_symbol_graph', 'get_callers'],
      symbol_query
    }
  }

  // 3. Find Definition Queries
  if (/\b(?:(?:find|go\s*to|show)\s+definition|where\s+is\s+[`'"]?[a-zA-Z0-9_$]+[`'"]?\s+defined)\b/i.test(req)) {
    let symbol_query = null
    const defMatch = req.match(/\bdefinition\s+(?:of|for)\s+([`'"]?[a-zA-Z0-9_$]+[`'"]?)/i)
    if (defMatch) {
      symbol_query = cleanExtractedSymbol(defMatch[1])
    } else {
      const definedMatch = req.match(/\bwhere\s+is\s+([`'"]?[a-zA-Z0-9_$]+[`'"]?)\s+defined\b/i)
      if (definedMatch) {
        symbol_query = cleanExtractedSymbol(definedMatch[1])
      }
    }

    return {
      matched: true,
      intent: 'search',
      actionClass: 'local_tool',
      toolFamily: 'search',
      needsLLM: false,
      needsVerification: false,
      confidence: 0.94,
      symbol_navigation: 'required',
      find_references: 'none',
      suggested_tools: ['find_definition', 'query_symbol_graph'],
      symbol_query
    }
  }

  // 4. Symbol Graph / Call Graph Queries
  if (/\b(call\s*graph|callers\s+of|callees\s+of|dependencies\s+of|implementations\s+of|symbol\s*graph)\b/i.test(req)) {
    let symbol_query = null
    const graphMatch = req.match(/\b(?:graph\s+(?:of|for)|callers\s+of|callees\s+of|dependencies\s+of|implementations\s+of)\s+([`'"]?[a-zA-Z0-9_$]+[`'"]?)/i)
    if (graphMatch) {
      symbol_query = cleanExtractedSymbol(graphMatch[1])
    }

    return {
      matched: true,
      intent: 'search',
      actionClass: 'local_tool',
      toolFamily: 'search',
      needsLLM: false,
      needsVerification: false,
      confidence: 0.92,
      symbol_navigation: 'required',
      find_references: 'none',
      suggested_tools: ['query_symbol_graph', 'get_callers', 'find_implementations'],
      symbol_query
    }
  }

  // 5. Symbol search
  if (/\b(find\s+symbol|search\s+symbol)\b/i.test(req)) {
    let symbol_query = null
    const symMatch = req.match(/\b(?:symbol)\s+([`'"]?[a-zA-Z0-9_$]+[`'"]?)/i)
    if (symMatch) {
      symbol_query = cleanExtractedSymbol(symMatch[1])
    }

    return {
      matched: true,
      intent: 'search',
      actionClass: 'local_tool',
      toolFamily: 'search',
      needsLLM: false,
      needsVerification: false,
      confidence: 0.91,
      symbol_navigation: 'required',
      find_references: 'none',
      suggested_tools: ['find_symbol', 'query_symbol_graph'],
      symbol_query
    }
  }

  return {
    matched: false,
    symbol_navigation: 'none',
    find_references: 'none',
    suggested_tools: [],
    symbol_query: null
  }
}

/**
 * Creates a safe fallback decision that escalates to main LLM.
 */
export function createFallbackDecision({
  request = '',
  reason = 'Fallback to authoritative LLM',
  latencyMs = 0,
  modelVersion = 'prime-router-fallback'
} = {}) {
  const heuristics = extractSymbolHeuristics(request)
  const lower = String(request).toLowerCase()
  let intent = heuristics.matched ? heuristics.intent : 'chat'
  let toolFamily = heuristics.matched ? heuristics.toolFamily : 'none'

  if (!heuristics.matched) {
    if (/\b(test|jest|vitest|npm test)\b/.test(lower)) {
      intent = 'test'
      toolFamily = 'testing'
    } else if (/\b(git status|git diff|git commit|git push)\b/.test(lower)) {
      intent = 'git'
      toolFamily = 'git'
    } else if (/\b(find|search|grep|locate)\b/.test(lower)) {
      intent = 'search'
      toolFamily = 'search'
    } else if (/\b(open|read|view|inspect)\b/.test(lower)) {
      intent = 'inspect'
      toolFamily = 'filesystem'
    } else if (/\b(fix|bug|error|failing|debug)\b/.test(lower)) {
      intent = 'debug'
      toolFamily = 'filesystem'
    } else if (/\b(create|write|add component|build)\b/.test(lower)) {
      intent = 'create'
      toolFamily = 'editor'
    }
  }

  const needsVerification = heuristics.matched && heuristics.needsVerification !== undefined
    ? heuristics.needsVerification
    : (intent === 'create' || intent === 'edit' || intent === 'refactor' || intent === 'test')

  return {
    intent,
    actionClass: 'main_llm',
    toolFamily,
    needsLLM: true,
    needsVerification,
    confidence: 0.5,
    modelVersion,
    latencyMs,
    reason,
    fallback: true,
    symbol_navigation: heuristics.symbol_navigation || 'none',
    find_references: heuristics.find_references || 'none',
    suggested_tools: heuristics.suggested_tools || [],
    symbol_query: heuristics.symbol_query || null
  }
}
