import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { LocalModelRuntime } from '../src/main/primeRouter/LocalModelRuntime.js'
import { PrimeRouter } from '../src/services/agentEngine/PrimeRouter.js'
import {
  PrimeRouterDecisionSchema,
  createFallbackDecision,
  extractSymbolHeuristics
} from '../src/services/agentEngine/primeRouterSchemas.js'
import { filterToolsByFamily } from '../src/services/agentEngine/LLMRouter.js'

describe('Phase 3: Laya + Symbol Intelligence & Semantic Navigation', () => {
  const runtime = new LocalModelRuntime()

  test('1. Refactor intent: Rename command flags refactor, symbol_navigation, find_references, and needsVerification', async () => {
    const decision = await runtime.predict({
      request: 'Rename generateToken to createAccessToken',
      state: 'IDLE'
    })

    assert.equal(decision.intent, 'refactor')
    assert.equal(decision.symbol_navigation, 'required')
    assert.equal(decision.find_references, 'required')
    assert.equal(decision.needsVerification, true)
    assert.equal(decision.symbol_query, 'generateToken')
    assert.ok(decision.suggested_tools.includes('find_references'))
    assert.ok(decision.suggested_tools.includes('find_definition'))
    assert.ok(decision.suggested_tools.includes('query_symbol_graph'))

    const parsed = PrimeRouterDecisionSchema.safeParse(decision)
    assert.ok(parsed.success, 'Decision must strictly validate against PrimeRouterDecisionSchema')
  })

  test('2. Refactor intent: Extract method flags refactor and extracts target symbol', async () => {
    const decision = await runtime.predict({
      request: 'Extract method calculateDiscount from Cart.js',
      state: 'IDLE'
    })

    assert.equal(decision.intent, 'refactor')
    assert.equal(decision.symbol_navigation, 'required')
    assert.equal(decision.find_references, 'required')
    assert.equal(decision.needsVerification, true)
    assert.equal(decision.symbol_query, 'calculateDiscount')
    assert.ok(decision.suggested_tools.includes('find_references'))
  })

  test('3. Refactor intent: Refactor class flags refactor and extracts target symbol', async () => {
    const decision = await runtime.predict({
      request: 'Refactor UserService class to support OAuth2',
      state: 'IDLE'
    })

    assert.equal(decision.intent, 'refactor')
    assert.equal(decision.symbol_navigation, 'required')
    assert.equal(decision.find_references, 'required')
    assert.equal(decision.needsVerification, true)
    assert.equal(decision.symbol_query, 'UserService')
    assert.ok(decision.suggested_tools.includes('find_references'))
  })

  test('4. Symbol navigation: Find all references and usages queries', async () => {
    const d1 = await runtime.predict({ request: 'Find all references to AuthService' })
    assert.equal(d1.intent, 'search')
    assert.equal(d1.symbol_navigation, 'required')
    assert.equal(d1.find_references, 'required')
    assert.equal(d1.symbol_query, 'AuthService')
    assert.ok(d1.suggested_tools.includes('find_references'))

    const d2 = await runtime.predict({ request: 'Where is handleLogin used?' })
    assert.equal(d2.symbol_navigation, 'required')
    assert.equal(d2.find_references, 'required')
    assert.equal(d2.symbol_query, 'handleLogin')

    const d3 = await runtime.predict({ request: 'Who calls validateSession' })
    assert.equal(d3.symbol_navigation, 'required')
    assert.equal(d3.find_references, 'required')
    assert.equal(d3.symbol_query, 'validateSession')
  })

  test('5. Symbol navigation: Go to definition queries', async () => {
    const d1 = await runtime.predict({ request: 'Go to definition of handleLogin' })
    assert.equal(d1.symbol_navigation, 'required')
    assert.equal(d1.find_references, 'none')
    assert.equal(d1.symbol_query, 'handleLogin')
    assert.ok(d1.suggested_tools.includes('find_definition'))

    const d2 = await runtime.predict({ request: 'Where is TokenManager defined?' })
    assert.equal(d2.symbol_navigation, 'required')
    assert.equal(d2.symbol_query, 'TokenManager')
    assert.ok(d2.suggested_tools.includes('find_definition'))
  })

  test('6. Symbol navigation: Symbol graph and call graph queries', async () => {
    const decision = await runtime.predict({ request: 'Show call graph of authenticate' })
    assert.equal(decision.symbol_navigation, 'required')
    assert.equal(decision.symbol_query, 'authenticate')
    assert.ok(decision.suggested_tools.includes('query_symbol_graph'))
    assert.ok(decision.suggested_tools.includes('get_callers'))
  })

  test('7. Non-symbol requests retain standard classification without false positive symbol navigation', async () => {
    const d1 = await runtime.predict({ request: 'git status' })
    assert.equal(d1.intent, 'git')
    assert.equal(d1.symbol_navigation, 'none')
    assert.equal(d1.find_references, 'none')
    assert.equal(d1.symbol_query, null)
    assert.deepEqual(d1.suggested_tools, [])

    const d2 = await runtime.predict({ request: 'npm test' })
    assert.equal(d2.intent, 'test')
    assert.equal(d2.symbol_navigation, 'none')
    assert.equal(d2.symbol_query, null)

    const d3 = await runtime.predict({ request: 'Tell me what npm test does' })
    assert.equal(d3.intent, 'explain')
    assert.equal(d3.symbol_navigation, 'none')
  })

  test('8. createFallbackDecision populates symbol navigation fields correctly', () => {
    const refactorFallback = createFallbackDecision({
      request: 'Rename parsePayload to decodePayload'
    })
    assert.equal(refactorFallback.intent, 'refactor')
    assert.equal(refactorFallback.symbol_navigation, 'required')
    assert.equal(refactorFallback.find_references, 'required')
    assert.equal(refactorFallback.needsVerification, true)
    assert.equal(refactorFallback.symbol_query, 'parsePayload')
    assert.ok(refactorFallback.suggested_tools.includes('find_references'))

    const searchFallback = createFallbackDecision({
      request: 'Find definition of AppConfig'
    })
    assert.equal(searchFallback.symbol_navigation, 'required')
    assert.equal(searchFallback.symbol_query, 'AppConfig')
    assert.ok(searchFallback.suggested_tools.includes('find_definition'))

    const genericFallback = createFallbackDecision({
      request: 'What is WebSockets?'
    })
    assert.equal(genericFallback.symbol_navigation, 'none')
    assert.equal(genericFallback.symbol_query, null)
  })

  test('9. ONNX complementation: heuristic complements simulated legacy ONNX output lacking symbol heads', async () => {
    const simulatedLegacyRuntime = new LocalModelRuntime()
    // Simulate an ONNX session returning a base classification without symbol navigation heads
    simulatedLegacyRuntime.ortSession = {}
    simulatedLegacyRuntime._runOnnxInference = async (req) => ({
      intent: 'edit',
      actionClass: 'main_llm',
      toolFamily: 'editor',
      needsLLM: true,
      needsVerification: false,
      confidence: 0.90
    })

    const decision = await simulatedLegacyRuntime.predict({
      request: 'Rename authHeader to tokenHeader'
    })

    // Heuristics must upgrade and complement the legacy output
    assert.equal(decision.intent, 'refactor')
    assert.equal(decision.symbol_navigation, 'required')
    assert.equal(decision.find_references, 'required')
    assert.equal(decision.needsVerification, true)
    assert.equal(decision.symbol_query, 'authHeader')
    assert.ok(decision.suggested_tools.includes('find_references'))
  })

  test('10. filterToolsByFamily respects suggested_tools from router decision', () => {
    const allTools = [
      { name: 'read_file' },
      { name: 'write_file' },
      { name: 'run_command' },
      { name: 'find_references' },
      { name: 'query_symbol_graph' }
    ]

    // Terminal family normally only allows run_command, read_process_output, etc.
    const toolsWithoutSuggestions = filterToolsByFamily(allTools, 'terminal')
    const toolNamesWithout = toolsWithoutSuggestions.map(t => t.name)
    assert.ok(toolNamesWithout.includes('run_command'))
    assert.ok(!toolNamesWithout.includes('find_references'))

    // When router suggests find_references and query_symbol_graph, they must be preserved
    const toolsWithSuggestions = filterToolsByFamily(allTools, 'terminal', ['find_references', 'query_symbol_graph'])
    const toolNamesWith = toolsWithSuggestions.map(t => t.name)
    assert.ok(toolNamesWith.includes('run_command'))
    assert.ok(toolNamesWith.includes('find_references'))
    assert.ok(toolNamesWith.includes('query_symbol_graph'))
  })
})
