import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ToolResultStore, TOOL_RESULT_CLASSES } from '../src/services/agentEngine/ToolResultStore.js'
import { ContextBudgetManager, DEGRADATION_STAGES } from '../src/services/agentEngine/ContextBudgetManager.js'

describe('Phase 8: Bounded Context & Tool Result Management', () => {
  test('1. ToolResultStore truncates giant outputs and creates reference pointers', () => {
    const store = new ToolResultStore({ pinCapChars: 200 })
    const giantOutput = 'A'.repeat(5000)
    const record = store.record({
      id: 'call-1',
      tool: 'run_command',
      output: giantOutput
    })

    assert.equal(record.isTruncated, true)
    assert.ok(record.summary.length < 500, 'Summary should be bounded')
    assert.ok(record.summary.includes('ref:call-1'), 'Summary must contain reference pointer')
    assert.equal(store.get('call-1').rawOutput.length, 5000, 'Full raw output must be preserved in store')
    assert.equal(store.getFormattedForPrompt('call-1'), record.summary)
  })

  test('2. ToolResultStore classifies outputs correctly', () => {
    const store = new ToolResultStore()
    
    assert.equal(store.classify('run_command', '', {}), TOOL_RESULT_CLASSES.EPHEMERAL)
    assert.equal(store.classify('verify', 'Tests passed', {}), TOOL_RESULT_CLASSES.IMPORTANT)
    assert.equal(store.classify('run_command', 'Error: Segmentation fault', { isError: true }), TOOL_RESULT_CLASSES.IMPORTANT)
    assert.equal(store.classify('write_file', 'Saved 10 lines', {}), TOOL_RESULT_CLASSES.PERSISTENT)
    assert.equal(store.classify('read_file', 'const a = 1', {}), TOOL_RESULT_CLASSES.RECENT)
  })

  test('3. Preflight estimation measures total prompt tokens', () => {
    const budgetManager = new ContextBudgetManager({ totalTokens: 100000 })
    const tokens = budgetManager.estimatePreflightTokens({
      systemMessage: 'You are an AI coding assistant.',
      userMessage: 'Fix the bug in src/auth.js',
      messages: [
        { role: 'assistant', content: 'I will look into it' }
      ],
      tools: [{ name: 'read_file', description: 'Read file contents' }]
    })

    assert.ok(tokens > 10, 'Should compute positive token estimate')
    assert.ok(tokens < 1000, 'Should not overestimate reasonable input')
  })

  test('4. ContextBudgetManager staged degradation sequence', () => {
    const budgetManager = new ContextBudgetManager({ totalTokens: 10000 })

    // Normal (< 60%)
    const normal = budgetManager.evaluateDegradationStage({ currentTokens: 4000, totalTokens: 10000, turn: 5, maxTurns: 50 })
    assert.equal(normal.stage, DEGRADATION_STAGES.NORMAL)
    assert.equal(normal.canProceed, true)

    // Compress (60% - 80%)
    const compress = budgetManager.evaluateDegradationStage({ currentTokens: 6500, totalTokens: 10000, turn: 10, maxTurns: 50 })
    assert.equal(compress.stage, DEGRADATION_STAGES.COMPRESS)
    assert.equal(compress.canProceed, true)

    // Summarize (80% - 90%)
    const summarize = budgetManager.evaluateDegradationStage({ currentTokens: 8500, totalTokens: 10000, turn: 15, maxTurns: 50 })
    assert.equal(summarize.stage, DEGRADATION_STAGES.SUMMARIZE)
    assert.equal(summarize.canProceed, true)

    // Conservative (90% - 100%)
    const conservative = budgetManager.evaluateDegradationStage({ currentTokens: 9500, totalTokens: 10000, turn: 20, maxTurns: 50 })
    assert.equal(conservative.stage, DEGRADATION_STAGES.CONSERVATIVE)
    assert.equal(conservative.canProceed, true)

    // Exhausted (>= 100%)
    const exhausted = budgetManager.evaluateDegradationStage({ currentTokens: 10500, totalTokens: 10000, turn: 25, maxTurns: 50 })
    assert.equal(exhausted.stage, DEGRADATION_STAGES.EXHAUSTED)
    assert.equal(exhausted.canProceed, false)
  })
})
