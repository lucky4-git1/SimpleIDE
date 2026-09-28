import test from 'node:test'
import assert from 'node:assert/strict'
import { SymbolGraph } from '../src/services/agentEngine/SymbolGraph.js'
import { PatchEngine } from '../src/services/agentEngine/PatchEngine.js'
import { FailureParser } from '../src/services/agentEngine/FailureParser.js'
import { FailureSymbolGraphBridge } from '../src/services/agentEngine/FailureSymbolGraphBridge.js'
import { LayaDebuggingController, DEBUG_STRATEGIES } from '../src/services/agentEngine/LayaDebuggingController.js'
import { AdaptiveContextWindow, CurrentAttention, AGENT_STAGES } from '../src/services/agentEngine/AdaptiveContextWindow.js'
import { DynamicToolSelector } from '../src/services/agentEngine/DynamicToolSelector.js'
import { AgentBenchmarkSuite } from '../src/services/agentEngine/AgentBenchmarkSuite.js'
import { performanceGates, PERFORMANCE_BUDGETS_MS } from '../src/services/agentEngine/PerformanceGates.js'
import { inlineDiffService } from '../src/services/inlineDiffService.js'

test('Phase 28 — End-to-End Target Behavior: Auth bug resolution flow', async () => {
  // 1. Setup SymbolGraph with authentication components
  const graph = new SymbolGraph(process.cwd())
  graph.addNode('sym-auth-service', { name: 'AuthService', file: 'src/services/auth.ts', kind: 'class' })
  graph.addNode('sym-validate-token', { name: 'validateToken', file: 'src/services/auth.ts', kind: 'function' })
  graph.addNode('sym-auth-middleware', { name: 'authMiddleware', file: 'src/middleware/authMiddleware.ts', kind: 'function' })
  graph.addNode('sym-auth-test', { name: 'auth.test.ts', file: 'tests/auth.test.ts', kind: 'test' })

  graph.addEdge('sym-auth-middleware', 'sym-validate-token', 'calls')
  graph.addEdge('sym-auth-test', 'sym-validate-token', 'tests')

  // 2. Measure Laya / Context performance gate
  const { result: contextBuildResult } = await performanceGates.measure('CONTEXT_BUILD', async () => {
    const attention = new CurrentAttention({
      currentTask: 'Fix authentication token validation bug',
      currentFile: 'src/services/auth.ts',
      currentSymbol: 'validateToken'
    })
    return AdaptiveContextWindow.buildContext(AGENT_STAGES.DEBUGGING, { attention })
  })
  assert.ok(contextBuildResult.includes('[CURRENT ATTENTION WINDOW]'))

  // 3. Dynamic Tool Selection (Phase 16)
  const availableTools = [
    { name: 'read_file' }, { name: 'edit_file' }, { name: 'apply_patch' },
    { name: 'find_definition' }, { name: 'find_references' }, { name: 'query_symbol_graph' },
    { name: 'run_command' }, { name: 'verify' }, { name: 'browser_screenshot' }
  ]
  const selectedTools = DynamicToolSelector.selectToolsForTask('Fix authentication token validation', availableTools)
  assert.ok(selectedTools.some(t => t.name === 'query_symbol_graph'))
  assert.ok(!selectedTools.some(t => t.name === 'browser_screenshot'))

  // 4. Initial Patch applied to auth.ts (Phase 5)
  const initialContent = 'export function validateToken(token: string) {\n  if (!token) return 500\n  return 200\n}'
  const patch1 = {
    file: 'src/services/auth.ts',
    edits: [{ startLine: 2, endLine: 2, replacement: '  if (!token) return 400' }]
  }
  const modifiedContent1 = PatchEngine.applyEdits(initialContent, patch1.edits)

  // 5. Test execution fails with 500 instead of 401
  const testOutput = `
FAIL tests/auth.test.ts:87
AssertionError: Expected 401 but received 500
    at validateToken (src/services/auth.ts:2:1)
    at tests/auth.test.ts:87:5
  Expected: 401
  Received: 500
`

  // 6. Smart Failure Attention (Phase 12)
  const parsedFailure = FailureParser.parse(testOutput)
  assert.equal(parsedFailure.hasFailure, true)
  assert.equal(parsedFailure.expected, '401')
  assert.equal(parsedFailure.received, '500')

  // 7. Failure → Symbol Graph Trace (Phase 13)
  const failureBridge = new FailureSymbolGraphBridge(graph)
  const trace = failureBridge.traceFailureGraph(parsedFailure)
  assert.ok(trace.recommendedSymbols.includes('validateToken'))

  // 8. Laya Debugging Controller Decision (Phase 14)
  const debugController = new LayaDebuggingController()
  const decision1 = debugController.decideNextAction(parsedFailure, { attempt: 1 })
  assert.ok([DEBUG_STRATEGIES.RETRY_MODIFIED, DEBUG_STRATEGIES.INSPECT_TEST].includes(decision1.strategy))

  // 9. Corrected Patch based on repair context
  const patch2 = {
    file: 'src/services/auth.ts',
    edits: [{ startLine: 2, endLine: 2, replacement: '  if (!token) return 401' }]
  }
  const finalContent = PatchEngine.applyEdits(initialContent, patch2.edits)
  assert.equal(finalContent, 'export function validateToken(token: string) {\n  if (!token) return 401\n  return 200\n}')

  // 10. Inline Diff Experience Session (Phase 6)
  const diffSession = inlineDiffService.showDiff('src/services/auth.ts', initialContent, finalContent)
  assert.ok(diffSession)
  assert.equal(diffSession.diff.insertedCount, 1)

  // Accept diff
  await inlineDiffService.acceptDiff('src/services/auth.ts')
  assert.equal(inlineDiffService.hasActiveDiff('src/services/auth.ts'), false)

  // 11. Performance Gate Verification (Phase 27)
  const audit = performanceGates.getAuditSummary()
  assert.ok(audit.totalMeasured > 0)
  assert.equal(audit.failedGates, 0)
})

test('Phase 25 — AgentBenchmarkSuite: runs standardized benchmark evaluations', async () => {
  const suite = new AgentBenchmarkSuite()

  const res1 = await suite.runBenchmarkTask('navigation', {
    task: 'Locate AuthService definition and callers',
    mockRun: async () => ({ success: true, turns: 1, toolCalls: ['find_definition'] })
  })
  assert.equal(res1.success, true)

  const res2 = await suite.runBenchmarkTask('bug_fixing', {
    task: 'Repair null token expiration crash',
    mockRun: async () => ({ success: true, turns: 2, toolCalls: ['read_file', 'apply_patch'] })
  })
  assert.equal(res2.success, true)

  const report = suite.generateEvaluationReport()
  assert.equal(report.totalBenchmarks, 2)
  assert.equal(report.passed, 2)
  assert.equal(report.passRate, '100.0%')
})
