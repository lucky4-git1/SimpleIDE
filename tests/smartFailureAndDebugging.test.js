import test from 'node:test'
import assert from 'node:assert/strict'
import { FailureParser } from '../src/services/agentEngine/FailureParser.js'
import { FailureSymbolGraphBridge } from '../src/services/agentEngine/FailureSymbolGraphBridge.js'
import { LayaDebuggingController, DEBUG_STRATEGIES } from '../src/services/agentEngine/LayaDebuggingController.js'
import { SymbolGraph } from '../src/services/agentEngine/SymbolGraph.js'

test('Phase 12 — FailureParser: extracts error, failing file, line, expected/received, and format window', () => {
  const rawLog = `
FAIL tests/auth.test.ts:87:5
AssertionError: Expected 401 but received 500
    at validateToken (src/services/auth.ts:143:12)
    at authenticate (src/middleware/authMiddleware.ts:24:9)
    at tests/auth.test.ts:87:5
  Expected: 401
  Received: 500
`

  const parsed = FailureParser.parse(rawLog)
  assert.equal(parsed.hasFailure, true)
  assert.equal(parsed.errorType, 'AssertionError')
  assert.equal(parsed.failingFile, 'src/services/auth.ts')
  assert.equal(parsed.failingLine, 143)
  assert.equal(parsed.expected, '401')
  assert.equal(parsed.received, '500')
  assert.ok(parsed.relatedSymbols.includes('validateToken'))
  assert.ok(parsed.formattedSummary.includes('[SMART FAILURE ATTENTION]'))
  assert.ok(parsed.formattedSummary.includes('Expected: 401'))
})

test('Phase 13 — FailureSymbolGraphBridge: traces failing test to implementation, callers, and dependencies', () => {
  const graph = new SymbolGraph(process.cwd())
  graph.addNode('sym-1', { name: 'validateToken', file: 'src/services/auth.ts', kind: 'function' })
  graph.addNode('sym-2', { name: 'authMiddleware', file: 'src/middleware/authMiddleware.ts', kind: 'function' })
  graph.addEdge('sym-2', 'sym-1', 'calls')

  const bridge = new FailureSymbolGraphBridge(graph)
  const parsedFailure = {
    hasFailure: true,
    errorType: 'AssertionError',
    failingFile: 'src/services/auth.ts',
    failingLine: 143,
    relatedSymbols: ['validateToken'],
    stackFrames: [{ symbol: 'validateToken', file: 'src/services/auth.ts', line: 143 }],
    formattedSummary: '[SMART FAILURE ATTENTION]\nError in validateToken'
  }

  const trace = bridge.traceFailureGraph(parsedFailure)
  assert.ok(trace.repairFiles.includes('src/services/auth.ts'))
  assert.ok(trace.recommendedSymbols.includes('validateToken'))

  const repairContext = bridge.buildRepairContext(parsedFailure)
  assert.ok(repairContext.includes('[TARGETED REPAIR CONTEXT]'))
  assert.ok(repairContext.includes('validateToken'))
})

test('Phase 14 — LayaDebuggingController: progressive decision ladder and loop breaker', () => {
  const controller = new LayaDebuggingController()
  const failure = {
    errorType: 'TypeError',
    failingFile: 'src/services/auth.ts',
    failingLine: 45,
    errorMessage: 'Cannot read property id of undefined',
    relatedSymbols: ['validateToken']
  }

  // Attempt 1: inspect definition
  const d1 = controller.decideNextAction(failure, { attempt: 1 })
  assert.equal(d1.strategy, DEBUG_STRATEGIES.INSPECT_DEFINITION)

  // Attempt 2: find references
  const d2 = controller.decideNextAction(failure, { attempt: 2, currentStrategy: d1.strategy })
  assert.equal(d2.strategy, DEBUG_STRATEGIES.FIND_REFERENCES)

  // Loop breaking: if same strategy fails twice, forces strategy change
  controller.decideNextAction(failure, { attempt: 3, currentStrategy: 'retry_modified' })
  const dLoop = controller.decideNextAction(failure, { attempt: 4, currentStrategy: 'retry_modified' })
  assert.equal(dLoop.strategy, DEBUG_STRATEGIES.CHANGE_STRATEGY)

  // Ceiling: max attempts triggers ask_user
  const dMax = controller.decideNextAction(failure, { attempt: 5 })
  assert.equal(dMax.strategy, DEBUG_STRATEGIES.ASK_USER)
})
