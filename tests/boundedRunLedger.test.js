import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { RunLedger, LEDGER_CALL_TYPES } from '../src/services/agentEngine/RunLedger.js'
import { LLMRouter } from '../src/services/agentEngine/LLMRouter.js'
import { estimateTokens } from '../src/services/agentEngine/ContextChunk.js'

const router = new LLMRouter(async () => ({ provider: 'openai', model: 'gpt-4o', hasApiKey: true, apiKey: 'k' }))

describe('RunLedger basic accounting', () => {
  test('new ledger starts at zero', () => {
    const ledger = new RunLedger({ runId: 'r1', model: 'm', contextWindow: 128000 })
    assert.deepStrictEqual(ledger.getTotals(), {
      calls: 0, inputEst: 0, outputEst: 0,
      inputActual: 0, outputActual: 0, reasoningActual: 0,
      cost: null, actualComplete: true, turns: 0
    })
    assert.deepStrictEqual(ledger.getSegments(), [])
    assert.strictEqual(ledger.turns, 0)
  })

  test('input and output estimates accumulate, totals are correct', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    ledger.recordCall({ model: 'm', inputEst: 100, outputText: 'x'.repeat(38) })
    ledger.recordCall({ model: 'm', inputEst: 50, outputText: 'y'.repeat(19) })
    const totals = ledger.getTotals()
    assert.strictEqual(totals.calls, 2)
    assert.strictEqual(totals.inputEst, 150)
    assert.strictEqual(totals.outputEst, estimateTokens('x'.repeat(38)) + estimateTokens('y'.repeat(19)))
    // No provider usage seen: actuals unavailable but estimates retained.
    assert.strictEqual(totals.actualComplete, false)
  })

  test('turn counting is explicit and monotonic', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    assert.strictEqual(ledger.advanceTurn(), 1)
    assert.strictEqual(ledger.advanceTurn(), 2)
    assert.strictEqual(ledger.getTotals().turns, 2)
  })
})

describe('RunLedger actual usage reconciliation', () => {
  test('estimated input/output reconcile against actual provider usage', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    const call = ledger.recordCall({
      model: 'm',
      inputEst: 1000,
      outputText: 'hello world, this is a response',
      usage: { input: 900, output: 12, total: 912, reasoning: null }
    })
    assert.strictEqual(call.inputEst, 1000)
    assert.strictEqual(call.inputActual, 900)
    assert.strictEqual(call.outputActual, 12)
    assert.strictEqual(call.usageAvailable, true)
    const totals = ledger.getTotals()
    assert.strictEqual(totals.inputActual, 900)
    assert.strictEqual(totals.outputActual, 12)
    assert.strictEqual(totals.actualComplete, true)
  })

  test('reasoning tokens accumulate when providers expose them', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    ledger.recordCall({ model: 'm', inputEst: 10, usage: { input: 10, output: 5, total: 15, reasoning: 40 } })
    assert.strictEqual(ledger.getTotals().reasoningActual, 40)
  })

  test('missing usage keeps request data, flags unavailable, never crashes', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    const call = ledger.recordCall({ model: 'm', inputEst: 100, outputText: 'abc', usage: null })
    assert.strictEqual(call.usageAvailable, false)
    assert.strictEqual(call.inputActual, null)
    assert.strictEqual(ledger.getTotals().actualComplete, false)
    assert.strictEqual(ledger.getTotals().inputEst, 100)
    // Non-object usage shapes are equally safe.
    ledger.recordCall({ model: 'm', inputEst: 10, usage: 'garbage' })
    ledger.recordCall({ model: 'm', inputEst: 10 })
    assert.strictEqual(ledger.getTotals().calls, 3)
  })

  test('partial usage is handled defensively field by field', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    const call = ledger.recordCall({ model: 'm', inputEst: 10, usage: { input: 25 } })
    assert.strictEqual(call.inputActual, 25)
    assert.strictEqual(call.outputActual, null)
    assert.strictEqual(call.usageAvailable, true)
    // Negative and non-finite values are clamped, never subtracted.
    const bad = ledger.recordCall({ model: 'm', inputEst: -5, usage: { input: -3, output: NaN, reasoning: Infinity } })
    assert.strictEqual(bad.inputEst, 0)
    assert.strictEqual(bad.inputActual, null)
    const totals = ledger.getTotals()
    assert.ok(totals.inputActual >= 0 && totals.outputActual >= 0)
  })
})

describe('RunLedger model segments', () => {
  test('model A -> B -> A keeps per-model segments and cumulative totals', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    ledger.recordCall({ model: 'A', inputEst: 100, usage: { input: 100, output: 10, total: 110, reasoning: null } })
    ledger.recordCall({ model: 'B', inputEst: 200, usage: { input: 200, output: 20, total: 220, reasoning: null } })
    ledger.recordCall({ model: 'A', inputEst: 50, usage: { input: 50, output: 5, total: 55, reasoning: null } })
    const segments = ledger.getSegments()
    assert.strictEqual(segments.length, 2)
    const a = segments.find(s => s.model === 'A')
    const b = segments.find(s => s.model === 'B')
    assert.strictEqual(a.calls, 2)
    assert.strictEqual(a.inputActual, 150)
    assert.strictEqual(b.calls, 1)
    assert.strictEqual(b.inputActual, 200)
    const totals = ledger.getTotals()
    assert.strictEqual(totals.calls, 3)
    assert.strictEqual(totals.inputActual, 350)
    assert.strictEqual(totals.outputActual, 35)
  })

  test('unknown call types normalize to OTHER without crashing', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    const call = ledger.recordCall({ model: 'm', callType: 'bogus', inputEst: 10 })
    assert.strictEqual(call.callType, LEDGER_CALL_TYPES.OTHER)
  })
})

describe('RunLedger monotonicity and determinism', () => {
  test('cumulative usage never decreases across a long deterministic run', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    let prev = ledger.getTotals()
    for (let i = 0; i < 100; i++) {
      ledger.advanceTurn()
      ledger.recordCall({
        model: i % 2 ? 'A' : 'B',
        inputEst: 100 + i,
        outputText: 'out',
        usage: { input: 100 + i, output: 10, total: 110 + i, reasoning: i % 3 ? 5 : null }
      })
      const next = ledger.getTotals()
      assert.ok(next.inputEst >= prev.inputEst)
      assert.ok(next.inputActual >= prev.inputActual)
      assert.ok(next.outputActual >= prev.outputActual)
      assert.ok(next.reasoningActual >= prev.reasoningActual)
      prev = next
    }
    const totals = ledger.getTotals()
    assert.strictEqual(totals.calls, 100)
    assert.strictEqual(totals.turns, 100)
    assert.strictEqual(totals.inputEst, 100 * 100 + 99 * 100 / 2)
    assert.strictEqual(totals.inputActual, totals.inputEst)
  })
})

describe('RunLedger cost', () => {
  test('no pricing data means cost stays null (nothing invented)', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    ledger.recordCall({ model: 'm', inputEst: 1000000, usage: { input: 1000000, output: 500000, total: 1500000, reasoning: null } })
    assert.strictEqual(ledger.getTotals().cost, null)
    assert.strictEqual(ledger.snapshot().pricingAvailable, false)
  })

  test('injected pricing produces estimated vs actual cost correctly', () => {
    const ledger = new RunLedger({ runId: 'r1', pricing: { inputPerMTok: 2, outputPerMTok: 8 } })
    const actual = ledger.recordCall({ model: 'm', inputEst: 1e6, usage: { input: 1e6, output: 5e5, total: 1.5e6, reasoning: null } })
    assert.strictEqual(actual.cost, 2 + 4)
    assert.strictEqual(actual.costEstimated, false)
    const estimated = ledger.recordCall({ model: 'm', inputEst: 1e6, outputText: 'hi' })
    assert.strictEqual(estimated.costEstimated, true)
    const totals = ledger.getTotals()
    assert.strictEqual(totals.actualComplete, false)
  })
})

describe('RunLedger summarizer accounting shape', () => {
  test('summarizer calls tracked separately without any summarizer existing', () => {
    const ledger = new RunLedger({ runId: 'r1', compactionBudget: { maxCalls: 12 } })
    ledger.recordCall({ model: 'm', callType: 'agent', inputEst: 100 })
    ledger.recordCall({ model: 'm', callType: 'summarizer', inputEst: 500, outputText: 'summary' })
    const compaction = ledger.getCompaction()
    assert.strictEqual(compaction.calls, 1)
    assert.strictEqual(compaction.inputEst, 500)
    assert.strictEqual(ledger.getTotals().calls, 2)
    assert.strictEqual(ledger.compactionBudget.maxCalls, 12)
  })
})

describe('LLMRouter usage extraction', () => {
  test('OpenAI-compatible usage with reasoning details', () => {
    assert.deepStrictEqual(router.extractUsage('nvidia', {
      usage: { prompt_tokens: 17, completion_tokens: 33, total_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } }
    }), { input: 17, output: 33, total: 50, reasoning: 20 })
  })

  test('OpenAI-compatible usage without details', () => {
    assert.deepStrictEqual(router.extractUsage('openai', {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }), { input: 10, output: 5, total: 15, reasoning: null })
  })

  test('Anthropic usage shape', () => {
    assert.deepStrictEqual(router.extractUsage('anthropic', {
      usage: { input_tokens: 30, output_tokens: 12 }
    }), { input: 30, output: 12, total: 42, reasoning: null })
  })

  test('Gemini usage shape with thoughts', () => {
    assert.deepStrictEqual(router.extractUsage('gemini', {
      usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9, totalTokenCount: 49, thoughtsTokenCount: 7 }
    }), { input: 40, output: 9, total: 49, reasoning: 7 })
  })

  test('missing or malformed usage never throws and yields nulls', () => {
    assert.deepStrictEqual(router.extractUsage('openai', {}), { input: null, output: null, total: null, reasoning: null })
    assert.deepStrictEqual(router.extractUsage('openai', null), { input: null, output: null, total: null, reasoning: null })
    assert.deepStrictEqual(router.extractUsage('ollama', { usage: { prompt_tokens: 'many' } }), { input: null, output: null, total: null, reasoning: null })
  })
})

describe('routeRequest usage sink wiring', () => {
  test('sink receives normalized measurement and return value is unchanged', async () => {
    const seen = []
    const text = await router.routeRequest(
      {
        systemMessage: 'sys', userMessage: 'hi', maxTokens: 64, temperature: 0.3,
        usageSink: (call) => seen.push(call)
      },
      async () => ({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
      })
    )
    assert.strictEqual(text, 'hello')
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].model, 'gpt-4o')
    assert.strictEqual(seen[0].provider, 'openai')
    assert.strictEqual(seen[0].callType, 'agent')
    assert.ok(seen[0].inputEst > 0)
    assert.strictEqual(seen[0].outputText, 'hello')
    assert.deepStrictEqual(seen[0].usage, { input: 20, output: 4, total: 24, reasoning: null })
  })

  test('requests without usage succeed and report null usage', async () => {
    const seen = []
    const text = await router.routeRequest(
      { systemMessage: 'sys', userMessage: 'hi', usageSink: (call) => seen.push(call) },
      async () => ({ choices: [{ message: { content: 'hi' } }] })
    )
    assert.strictEqual(text, 'hi')
    assert.deepStrictEqual(seen[0].usage, { input: null, output: null, total: null, reasoning: null })
  })

  test('absent sink changes nothing and a throwing sink cannot break requests', async () => {
    const plain = await router.routeRequest(
      { systemMessage: 'sys', userMessage: 'hi' },
      async () => ({ choices: [{ message: { content: 'ok' } }] })
    )
    assert.strictEqual(plain, 'ok')
    const throwing = await router.routeRequest(
      { systemMessage: 'sys', userMessage: 'hi', usageSink: () => { throw new Error('ledger blew up') } },
      async () => ({ choices: [{ message: { content: 'still ok' } }] })
    )
    assert.strictEqual(throwing, 'still ok')
  })

  test('returnRaw path still returns raw data and still measures', async () => {
    const seen = []
    const raw = { choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
    const out = await router.routeRequest(
      { systemMessage: 's', userMessage: 'u', returnRaw: true, usageSink: (call) => seen.push(call) },
      async () => raw
    )
    assert.strictEqual(out, raw)
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].outputText, null)
    assert.strictEqual(seen[0].usage.input, 3)
  })
})
