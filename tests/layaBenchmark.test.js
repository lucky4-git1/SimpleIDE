import test from 'node:test'
import assert from 'node:assert/strict'
import { PrimeRouter, LAYA_ROLLOUT_MODES } from '../src/services/agentEngine/PrimeRouter.js'
import { LayaDecisionAdapter } from '../src/services/agentEngine/LayaDecisionAdapter.js'
import { MainProcessRouterAdapter } from '../src/services/agentEngine/MainProcessRouterAdapter.js'

test('Laya Benchmark Suite — 3-System Evaluation & Real IDE Efficiency', async (t) => {
  // Synthesize 100 realistic IDE benchmark tasks across the 13 task domains
  const TASK_TYPES = [
    { type: 'style_edit', text: 'Change the button color to deep blue in Button.jsx', expectedIntent: 'edit', expectedSemNav: 'none', hardNegative: true },
    { type: 'text_edit', text: 'Update the card header title in Dashboard.jsx', expectedIntent: 'edit', expectedSemNav: 'none', hardNegative: true },
    { type: 'call_graph', text: 'Who calls AuthService.login across the repository?', expectedIntent: 'navigate', expectedSemNav: 'required', hardNegative: false },
    { type: 'definition', text: 'Where is validateTerminalCwd declared and defined?', expectedIntent: 'navigate', expectedSemNav: 'required', hardNegative: false },
    { type: 'references', text: 'Find all references to SymbolGraph.queryCallers', expectedIntent: 'navigate', expectedSemNav: 'required', hardNegative: false },
    { type: 'debug_test', text: 'Why did unit test testTokenExpiration fail with assertion mismatch?', expectedIntent: 'debug', expectedSemNav: 'required', hardNegative: false },
    { type: 'debug_runtime', text: 'Fix undefined property error in UserProfile.jsx', expectedIntent: 'debug', expectedSemNav: 'required', hardNegative: false },
    { type: 'run_tests', text: 'Run npm test to verify authentication changes', expectedIntent: 'test', expectedSemNav: 'none', hardNegative: false },
    { type: 'verify', text: 'Verify that all tests pass after refactoring', expectedIntent: 'test', expectedSemNav: 'none', hardNegative: false },
    { type: 'git_status', text: 'Check git status and unstaged diffs', expectedIntent: 'git', expectedSemNav: 'none', hardNegative: false },
    { type: 'refactor', text: 'Rename function generateToken to createAccessToken across files', expectedIntent: 'refactor', expectedSemNav: 'required', hardNegative: false },
    { type: 'stuck_recovery', text: 'Tool execution failed 3 times repeatedly with the same stack trace', expectedIntent: 'debug', expectedSemNav: 'required', stuck: true },
    { type: 'general_search', text: 'Find where the phrase "API_KEY" appears in config files', expectedIntent: 'search', expectedSemNav: 'optional', hardNegative: false }
  ]

  const benchmarkDataset = []
  for (let i = 0; i < 100; i++) {
    const item = TASK_TYPES[i % TASK_TYPES.length]
    benchmarkDataset.push({
      id: `bench-${i + 1}`,
      ...item
    })
  }

  // System A: Legacy Prime Router
  const systemA = new PrimeRouter({
    adapter: new MainProcessRouterAdapter(),
    layaMode: LAYA_ROLLOUT_MODES.LEGACY
  })

  // System B: Base Pretrained Laya (generic base)
  const systemB = new LayaDecisionAdapter({ variant: 'base' })

  // System C: Fine-Tuned SimpleIDE-Laya
  const systemC = new PrimeRouter({
    adapter: new MainProcessRouterAdapter(),
    layaMode: LAYA_ROLLOUT_MODES.LAYA
  })

  await t.test('evaluates 3 systems across 100 tasks', async () => {
    let systemACorrect = 0
    let systemBCorrect = 0
    let systemCCorrect = 0

    let systemAHardNegCorrect = 0
    let systemBHardNegCorrect = 0
    let systemCHardNegCorrect = 0

    let totalHardNegatives = 0

    const systemALatencies = []
    const systemCLatencies = []

    for (const item of benchmarkDataset) {
      if (item.hardNegative) totalHardNegatives++

      // Eval System A
      const startA = Date.now()
      const decA = await systemA.decide({ request: item.text, state: 'EXECUTING' })
      systemALatencies.push(Date.now() - startA)

      if (decA.intent === item.expectedIntent || (item.expectedIntent === 'navigate' && decA.intent === 'search')) {
        systemACorrect++
      }
      if (item.hardNegative && decA.symbol_navigation === 'none') {
        systemAHardNegCorrect++
      }

      // Eval System B
      const decB = await systemB.predict({ request: item.text, state: 'EXECUTING' })
      if (decB.intent === item.expectedIntent || (item.expectedIntent === 'navigate' && decB.intent === 'search')) {
        systemBCorrect++
      }
      if (item.hardNegative && decB.symbol_navigation === 'none') {
        systemBHardNegCorrect++
      }

      // Eval System C (Fine-Tuned SimpleIDE-Laya)
      const startC = Date.now()
      const decC = await systemC.decide({ request: item.text, state: 'EXECUTING' })
      systemCLatencies.push(Date.now() - startC)

      if (decC.intent === item.expectedIntent) {
        systemCCorrect++
      }
      if (item.hardNegative && decC.symbol_navigation === 'none') {
        systemCHardNegCorrect++
      }
    }

    const accuracyA = (systemACorrect / 100) * 100
    const accuracyB = (systemBCorrect / 100) * 100
    const accuracyC = (systemCCorrect / 100) * 100

    const hardNegPrecB = (systemBHardNegCorrect / totalHardNegatives) * 100
    const hardNegPrecC = (systemCHardNegCorrect / totalHardNegatives) * 100

    assert.ok(accuracyC >= accuracyA, `Expected System C (${accuracyC}%) >= System A (${accuracyA}%)`)
    assert.ok(hardNegPrecC === 100, `Expected 100% hard negative precision, got ${hardNegPrecC}%`)

    // Real IDE Efficiency Metric:
    // agent_efficiency = successful_tasks / (LLM_calls + weighted_tool_calls + context_tokens / 1000)
    const avgLatencyC = systemCLatencies.reduce((a, b) => a + b, 0) / systemCLatencies.length
    assert.ok(avgLatencyC < 25, `Average latency ${avgLatencyC}ms must be < 25ms`)
  })

  await t.test('measures Brier score calibration for fine-tuned Laya decisions', async () => {
    // Brier score: mean squared error of probability predictions
    // BS = (1/N) * sum((forecast - actual)^2)
    const samples = [
      { text: 'Who calls AuthService.login?', isNavigate: true },
      { text: 'Where is validateTerminalCwd?', isNavigate: true },
      { text: 'Change button color to red', isNavigate: false },
      { text: 'Update spacing on card', isNavigate: false },
      { text: 'Run npm test', isNavigate: false }
    ]

    let totalSquaredError = 0
    for (const sample of samples) {
      const decision = await systemC.decide({ request: sample.text, state: 'EXECUTING' })
      const prob = decision.symbol_navigation === 'required' ? decision.confidence : (1 - decision.confidence)
      const actual = sample.isNavigate ? 1.0 : 0.0
      totalSquaredError += Math.pow(prob - actual, 2)
    }

    const brierScore = totalSquaredError / samples.length
    assert.ok(brierScore < 0.15, `Brier score ${brierScore.toFixed(4)} must be well calibrated (< 0.15)`)
  })
})
