import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUDGET_STATES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CONSECUTIVE_MALFORMED,
  MAX_MODEL_ATTEMPTS_PER_TURN,
  BudgetPolicy,
  isTransientFailure,
  withBoundedRetries
} from '../src/services/agentEngine/BudgetPolicy.js'
import { RunLedger } from '../src/services/agentEngine/RunLedger.js'
import { LLMRouter } from '../src/services/agentEngine/LLMRouter.js'
import { timeoutError } from '../src/main/ipc/aiResponse.js'
import { runAgentTask } from '../src/services/agentService.js'

const router = new LLMRouter(async () => ({ provider: 'openai', model: 'm', hasApiKey: true, apiKey: 'k' }))

describe('BudgetPolicy defaults and dimensions', () => {
  test('defaults derive from context window, cost disabled without pricing', () => {
    const policy = new BudgetPolicy({ contextWindow: 128000 })
    assert.strictEqual(policy.limits.maxRunInputTokens, 128000 * 20)
    assert.strictEqual(policy.limits.maxRunOutputTokens, 128000 * 4)
    assert.strictEqual(policy.limits.maxRunCost, null)
    assert.deepStrictEqual(policy.thresholds, { warning: 0.7, conservative: 0.85 })
    assert.ok(DEFAULT_REQUEST_TIMEOUT_MS >= 60000)
    assert.strictEqual(MAX_CONSECUTIVE_MALFORMED, 3)
    assert.strictEqual(MAX_MODEL_ATTEMPTS_PER_TURN, 3)
  })

  test('custom budgets override; invalid values fall back', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunInputTokens: 500, maxRunOutputTokens: -5 } })
    assert.strictEqual(policy.limits.maxRunInputTokens, 500)
    assert.strictEqual(policy.limits.maxRunOutputTokens, 1000 * 4)
  })

  test('input budget states: under, near, exceeded', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunInputTokens: 1000 } })
    assert.strictEqual(policy.evaluate({ totals: { inputActual: 100, inputEst: 100 } }).state, 'normal')
    const warn = policy.evaluate({ totals: { inputActual: 700, inputEst: 700 } })
    assert.strictEqual(warn.state, 'warning')
    assert.strictEqual(warn.dimension, 'input')
    const cons = policy.evaluate({ totals: { inputActual: 850, inputEst: 850 } })
    assert.strictEqual(cons.state, 'conservative')
    const out = policy.evaluate({ totals: { inputActual: 1000, inputEst: 1000 } })
    assert.strictEqual(out.state, 'exhausted')
    assert.ok(out.remaining.input === 0)
    assert.ok(out.message.includes('input') && out.message.includes('1000'))
  })

  test('output budget enforced independently', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunInputTokens: 1e9, maxRunOutputTokens: 100 } })
    const d = policy.evaluate({ totals: { inputActual: 10, outputActual: 100 } })
    assert.strictEqual(d.state, 'exhausted')
    assert.strictEqual(d.dimension, 'output')
  })

  test('cost enforced only with pricing configured', () => {
    const noPrice = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunCost: 1 } })
    assert.strictEqual(noPrice.evaluate({ totals: { inputActual: 1e9 } }).dimension === 'cost', false)
    const priced = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunCost: 5 }, pricing: { inputPerMTok: 10, outputPerMTok: 10 } })
    const d = priced.evaluate({ totals: { cost: 5 } })
    assert.strictEqual(d.state, 'exhausted')
    assert.strictEqual(d.dimension, 'cost')
  })

  test('unknown usage enforces on estimates, never reads as zero', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunInputTokens: 100 } })
    const d = policy.evaluate({ totals: { inputActual: 0, inputEst: 150, outputActual: 0, outputEst: 0 } })
    assert.strictEqual(d.state, 'exhausted')
    assert.strictEqual(d.usage.input, 150)
  })

  test('mixed actual and estimated usage takes the conservative max', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunInputTokens: 100 } })
    const d = policy.evaluate({ totals: { inputActual: 60, inputEst: 90 } })
    assert.strictEqual(d.usage.input, 90)
    assert.strictEqual(d.state, 'conservative')
    const w = policy.evaluate({ totals: { inputActual: 60, inputEst: 75 } })
    assert.strictEqual(w.state, 'warning')
  })

  test('per-request pressure near the window edge warns without stopping', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000 })
    const d = policy.evaluate({ totals: {}, windowShare: 0.95 })
    assert.strictEqual(d.state, 'warning')
    assert.strictEqual(d.dimension, 'request-context')
  })

  test('baseline deltas drive decisions, supporting resume allocations', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunInputTokens: 100 } })
    const baseline = { inputActual: 1000, inputEst: 1000 }
    const d = policy.evaluate({ totals: { inputActual: 1050, inputEst: 1050 }, baseline })
    assert.strictEqual(d.state, 'normal')
    assert.strictEqual(d.usage.input, 50)
  })
})

describe('transient classification and bounded retry', () => {
  test('categories and network strings are transient; rest is not', () => {
    for (const category of ['PROVIDER_GATEWAY_TIMEOUT', 'PROVIDER_OVERLOADED', 'PROVIDER_TIMEOUT', 'PROVIDER_EMPTY_RESPONSE']) {
      const e = new Error('x'); e.category = category
      assert.strictEqual(isTransientFailure(e), true, category)
    }
    assert.strictEqual(isTransientFailure(Object.assign(new Error('fetch failed'), {})), true)
    assert.strictEqual(isTransientFailure(new Error('socket hang up')), true)
    assert.strictEqual(isTransientFailure(new Error('Invalid request (400)')), false)
    const aborted = new Error('x'); aborted.name = 'AbortError'
    assert.strictEqual(isTransientFailure(aborted), false)
    assert.strictEqual(isTransientFailure(null), false)
  })

  test('success first try calls once', async () => {
    let n = 0
    const out = await withBoundedRetries(async () => { n++; return 'ok' })
    assert.strictEqual(out, 'ok')
    assert.strictEqual(n, 1)
  })

  test('transient twice then success totals three attempts', async () => {
    let n = 0
    const events = []
    const out = await withBoundedRetries(async () => {
      n++
      if (n < 3) { const e = new Error('504'); e.category = 'PROVIDER_GATEWAY_TIMEOUT'; throw e }
      return 'recovered'
    }, { onEvent: (e) => events.push(e) })
    assert.strictEqual(out, 'recovered')
    assert.strictEqual(n, 3)
    assert.strictEqual(events.length, 2)
  })

  test('persistent transient fails after exactly three attempts', async () => {
    let n = 0
    const err = await withBoundedRetries(async () => {
      n++
      const e = new Error('overloaded'); e.category = 'PROVIDER_OVERLOADED'; throw e
    }).then(() => null, (e) => e)
    assert.ok(err && err.message === 'overloaded')
    assert.strictEqual(n, 3)
  })

  test('non-transient and aborts never retry', async () => {
    let n = 0
    await withBoundedRetries(async () => { n++; throw new Error('bad request') }).then(() => null, () => null)
    assert.strictEqual(n, 1)
    const aborter = async () => { n++; const e = new Error('stop'); e.name = 'AbortError'; throw e }
    await withBoundedRetries(aborter, { signal: { get aborted() { return false } } }).then(() => null, () => null)
    assert.strictEqual(n, 2)
  })
})

describe('timeout plumbing and classification', () => {
  test('routeRequest forwards timeoutMs to the transport', async () => {
    let seen
    await router.routeRequest(
      { systemMessage: 's', userMessage: 'u', timeoutMs: 12345 },
      async (args) => { seen = args; return { choices: [{ message: { content: 'ok' } }] } }
    )
    assert.strictEqual(seen.timeoutMs, 12345)
  })

  test('timeoutMs absent by default (behavior preserved)', async () => {
    let seen
    await router.routeRequest(
      { systemMessage: 's', userMessage: 'u' },
      async (args) => { seen = args; return { choices: [{ message: { content: 'ok' } }] } }
    )
    // Null passes through as "no guard", identical to the old absent behavior.
    assert.strictEqual(seen.timeoutMs, null)
  })

  test('timeoutError is distinct from cancellation and gateway errors', () => {
    const t = timeoutError(180000)
    assert.strictEqual(t.category, 'PROVIDER_TIMEOUT')
    assert.ok(t.message.includes('180'))
    assert.ok(!/cancelled/i.test(t.message))
    const bare = timeoutError(null)
    assert.strictEqual(bare.category, 'PROVIDER_TIMEOUT')
  })

  test('failed transport attempts record estimates conservatively', async () => {
    const seen = []
    await router.routeRequest(
      { systemMessage: 'sys message here', userMessage: 'do it', usageSink: (c) => seen.push(c) },
      async () => { throw new Error('fetch failed') }
    ).then(() => null, () => null)
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].failed, true)
    assert.ok(seen[0].inputEst > 0)
    assert.strictEqual(seen[0].outputText, null)
  })
})

// ---- Full runAgentTask integration with mocked window.api ----

function setupEnv() {
  globalThis.localStorage = {
    store: new Map(),
    getItem(k) { const v = this.store.get(k); return v === undefined ? null : v },
    setItem(k, v) { this.store.set(k, v) },
    removeItem(k) { this.store.delete(k) }
  }
}

function baseApi(overrides = {}) {
  return {
    getAIConfig: async () => ({ hasApiKey: true, model: 'gpt-5.6-sol', provider: 'openai' }),
    listFiles: async () => ({ success: true, children: [] }),
    readFile: async () => ({ success: false, error: 'ENOENT: no such file' }),
    writeFile: async (p, c) => ({ success: true }),
    ...overrides
  }
}

const FINISH_JSON = '{"status":"Completed","thought":"ok","plan":[],"actions":[{"type":"finish","message":"done"}]}'
const READ_JSON = '{"status":"Inspecting","thought":"look","plan":["x"],"actions":[{"type":"read_file","path":"nope.js"}]}'
const okData = (text) => ({ success: true, data: { choices: [{ message: { content: text } }] } })

// Deterministic fallback-path runs (ollama has no native tools, so the JSON
// protocol applies from turn one). Native-path runs use explicit tool_calls.
const ollamaApi = (overrides = {}) => baseApi({
  getAIConfig: async () => ({ hasApiKey: true, model: 'qwen2.5-coder:7b', provider: 'ollama' }),
  ...overrides
})

describe('runAgentTask malformed cap', () => {
  test('three consecutive malformed responses fail safely with checkpoint', async () => {
    setupEnv()
    let calls = 0
    globalThis.window = { api: ollamaApi({ aiRequest: async () => { calls++; return okData('not json at all'); } }) }
    const { runAgentTask } = await import('../src/services/agentService.js')
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/budget_malformed' }, tools: {}, maxTurns: 10
    })
    assert.strictEqual(calls, 3)
    assert.strictEqual(result.failed, true)
    assert.ok(/invalid agent JSON|unusable/i.test(result.error))
    assert.ok(result.checkpoint && result.checkpoint.version === 2)
  })

  test('valid response resets the streak and the run completes', async () => {
    setupEnv()
    let calls = 0
    globalThis.window = { api: ollamaApi({ aiRequest: async () => { calls++; return okData(calls < 3 ? 'garbage {' : FINISH_JSON); } }) }
    const { runAgentTask } = await import('../src/services/agentService.js')
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/budget_reset' }, tools: {}, maxTurns: 10
    })
    assert.strictEqual(result.completed, true)
    assert.strictEqual(calls, 3)
  })

  test('native blank responses with no tool calls count as malformed', async () => {
    setupEnv()
    let calls = 0
    globalThis.window = {
      api: baseApi({
        aiRequest: async () => {
          calls++
          return { success: true, data: { choices: [{ message: { content: '   ' } }] } }
        }
      })
    }
    const { runAgentTask } = await import('../src/services/agentService.js')
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/budget_blank' }, tools: {}, maxTurns: 10
    })
    assert.strictEqual(calls, 3)
    assert.strictEqual(result.failed, true)
    assert.ok(/unusable/i.test(result.error))
  })
})

describe('runAgentTask bounded retry on transient 504s', () => {
  const nativeData = (calls) => ({
    success: true,
    data: { choices: [{ message: { tool_calls: calls } }] }
  })
  const nativeCall = (id, name, args) => ({
    id, type: 'function', function: { name, arguments: JSON.stringify(args) }
  })

  test('two 504s then success recovers with exactly three attempts', async () => {
    setupEnv()
    let calls = 0
    let configs = 0
    const seenModels = []
    globalThis.window = {
      api: baseApi({
        // Config is read once at run start plus twice per attempt
        // (requestAIText + routeRequest): first attempt is Lightning, then Ultra.
        getAIConfig: async () => ({ hasApiKey: true, model: configs++ < 3 ? 'nvidia/nemotron-3.5-lightning-30b-a3b' : 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia' }),
        readFile: async () => ({ success: true, content: 'export const x = 1' }),
        aiRequest: async (args) => {
          calls++
          seenModels.push(args.body.model)
          if (calls < 3) return { error: 'NVIDIA gateway timeout (provider-side): Gateway Timeout.', category: 'PROVIDER_GATEWAY_TIMEOUT' }
          return nativeData([nativeCall('cfin', 'finish', { message: 'done' })])
        }
      })
    }
    const { runAgentTask } = await import('../src/services/agentService.js')
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/budget_504' }, tools: {}, maxTurns: 10
    })
    assert.strictEqual(result.completed, true)
    assert.strictEqual(calls, 3)
    assert.deepStrictEqual(seenModels, [
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/nemotron-3-ultra-550b-a55b'
    ])
  })

  test('persistent 504s stop after three attempts with checkpoint, never looping', async () => {
    setupEnv()
    let calls = 0
    globalThis.window = {
      api: baseApi({
        aiRequest: async () => { calls++; return { error: 'Service temporarily overloaded', category: 'PROVIDER_OVERLOADED' } }
      })
    }
    const { runAgentTask } = await import('../src/services/agentService.js')
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/budget_504x' }, tools: {}, maxTurns: 10
    })
    assert.strictEqual(result.failed, true)
    assert.strictEqual(calls, 3)
    assert.ok(result.checkpoint && result.checkpoint.version === 2)
  })

  test('non-transient errors fail fast with a single attempt', async () => {
    setupEnv()
    let calls = 0
    globalThis.window = { api: ollamaApi({ aiRequest: async () => { calls++; return { error: 'Invalid request (400)' } } }) }
    const { runAgentTask } = await import('../src/services/agentService.js')
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/budget_400' }, tools: {}, maxTurns: 10
    })
    assert.strictEqual(result.failed, true)
    assert.strictEqual(calls, 1)
  })
})

describe('runAgentTask budget enforcement', () => {
  test('exhausted input budget stops cleanly with checkpoint and clear reason', async () => {
    setupEnv()
    let calls = 0
    globalThis.window = { api: ollamaApi({ aiRequest: async () => { calls++; return okData(READ_JSON); } }) }
    const { runAgentTask } = await import('../src/services/agentService.js')
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/budget_exh' }, tools: {},
      maxTurns: 10, budgets: { maxRunInputTokens: 60 }
    })
    assert.strictEqual(calls, 1)
    assert.strictEqual(result.failed, true)
    assert.strictEqual(result.status, 'Incomplete')
    assert.ok(/budget/i.test(result.error) && /input/i.test(result.error))
    assert.ok(result.checkpoint && result.checkpoint.version === 2)
    assert.ok(result.checkpoint.ledger && result.checkpoint.ledger.totals.calls >= 1)
  })

  test('conservative mode announces, restricts, and still completes', async () => {
    setupEnv()
    let calls = 0
    const bodies = []
    globalThis.window = {
      api: ollamaApi({
        aiRequest: async (args) => {
          calls++
          bodies.push(JSON.stringify(args.body.messages || args.body.contents || []))
          return okData(calls < 2 ? READ_JSON : FINISH_JSON)
        }
      })
    }
    const events = []
    const { runAgentTask } = await import('../src/services/agentService.js')
    // First-turn output (~28 tokens) lands between 85% and 100% of 30.
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/budget_cons' }, tools: {},
      maxTurns: 10, budgets: { maxRunInputTokens: 1e9, maxRunOutputTokens: 30 }, onEvent: (e) => events.push(e)
    })
    assert.strictEqual(result.completed, true)
    assert.strictEqual(calls, 2)
    assert.ok(events.some(e => e.type === 'status' && /conservative/i.test(e.message || '')))
    // Reflection injected during the normal first turn is present upstream…
    assert.ok(bodies[1].includes('REFLECTION'))
  })

  test('existing max-turns boundary is preserved', async () => {
    setupEnv()
    globalThis.window = { api: ollamaApi({ aiRequest: async () => okData(READ_JSON) }) }
    const { runAgentTask } = await import('../src/services/agentService.js')
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/budget_turns' }, tools: {}, maxTurns: 2
    })
    assert.strictEqual(result.error, 'Max turns reached without task completion.')
    assert.ok(result.checkpoint && result.checkpoint.version === 2)
  })
})

describe('resume keeps budget continuity', () => {
  test('restored usage counts toward the same allocation, never resets', () => {
    const first = new RunLedger({ runId: 'r1', model: 'A', contextWindow: 1000 })
    first.recordCall({ model: 'A', inputEst: 800, usage: { input: 800, output: 10, total: 810, reasoning: null } })
    const resumed = new RunLedger({ runId: 'r2', model: 'A', contextWindow: 1000 })
    assert.strictEqual(resumed.restore(first.snapshot()), true)
    const baseline = resumed.getTotals()
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunInputTokens: 1000 } })
    // Same allocation: 800 already consumed → warning, not a fresh 1000.
    const atResume = policy.evaluate({ totals: resumed.getTotals(), baseline })
    assert.strictEqual(atResume.state, 'normal')
    assert.strictEqual(atResume.usage.input, 0)
    resumed.recordCall({ model: 'A', inputEst: 300, usage: { input: 300, output: 5, total: 305, reasoning: null } })
    const later = policy.evaluate({ totals: resumed.getTotals(), baseline })
    assert.strictEqual(later.usage.input, 300)
    assert.strictEqual(resumed.getTotals().inputActual, 1100)
    assert.strictEqual(resumed.priorRuns.length, 1)
  })
})

describe('long run approaching multiple limits', () => {
  test('states progress normal, warning, conservative, exhausted in order', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunInputTokens: 1000, maxRunOutputTokens: 200 } })
    const totals = { inputActual: 0, inputEst: 0, outputActual: 0, outputEst: 0 }
    const seen = []
    for (let i = 0; i < 10; i++) {
      totals.inputActual += 100
      totals.inputEst += 100
      totals.outputActual += 10
      totals.outputEst += 10
      seen.push(policy.evaluate({ totals }).state)
    }
    assert.deepStrictEqual(seen, ['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'warning', 'warning', 'conservative', 'exhausted'])
  })
})
