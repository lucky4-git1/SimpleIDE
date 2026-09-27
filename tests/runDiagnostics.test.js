import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { RunTimeline, TimelineTypes, FailureClasses, classifyFailureClass } from '../src/services/agentEngine/RunTimeline.js'
import { RunLedger } from '../src/services/agentEngine/RunLedger.js'
import { BudgetPolicy, withBoundedRetries } from '../src/services/agentEngine/BudgetPolicy.js'

describe('RunTimeline core', () => {
  test('events carry ordering, timestamps, and run association', () => {
    const timeline = new RunTimeline({ runId: 'r1' })
    const a = timeline.emit(TimelineTypes.RUN_STARTED, { model: 'm' })
    const b = timeline.emit(TimelineTypes.LLM_REQUEST, { turn: 1 })
    assert.strictEqual(a.seq, 1)
    assert.strictEqual(b.seq, 2)
    assert.strictEqual(a.runId, 'r1')
    assert.ok(typeof a.ts === 'number' && b.ts >= a.ts)
    assert.strictEqual(b.turn, 1)
    assert.strictEqual(timeline.count(), 2)
  })

  test('unknown types pass through without crashing', () => {
    const timeline = new RunTimeline({ runId: 'r1' })
    const e = timeline.emit('SOMETHING_NEW', { x: 1 })
    assert.strictEqual(e.type, 'SOMETHING_NEW')
    assert.strictEqual(timeline.emit('t').type, 't')
  })

  test('storage is bounded: oldest dropped first with a counter', () => {
    const timeline = new RunTimeline({ runId: 'r1', maxEvents: 5 })
    for (let i = 0; i < 8; i++) timeline.emit(TimelineTypes.LLM_REQUEST, { turn: i })
    assert.strictEqual(timeline.count(), 5)
    assert.strictEqual(timeline.dropped, 3)
    assert.strictEqual(timeline.events[0].turn, 3)
    assert.deepStrictEqual(timeline.tail(2).map(e => e.turn), [6, 7])
  })

  test('byType filters and snapshot summarizes without payloads', () => {
    const timeline = new RunTimeline({ runId: 'r1' })
    timeline.emit(TimelineTypes.LLM_REQUEST, {})
    timeline.emit(TimelineTypes.LLM_RESPONSE, {})
    timeline.emit(TimelineTypes.LLM_REQUEST, {})
    assert.strictEqual(timeline.byType(TimelineTypes.LLM_REQUEST).length, 2)
    assert.deepStrictEqual(timeline.snapshot(), { runId: 'r1', events: 3, dropped: 0, types: ['LLM_REQUEST', 'LLM_RESPONSE'] })
  })
})

describe('timeline privacy and JSON safety', () => {
  test('secrets, headers, and credentials never enter events', () => {
    const timeline = new RunTimeline({ runId: 'r1' })
    const e = timeline.emit(TimelineTypes.LLM_REQUEST, {
      apiKey: 'sk-secret',
      Authorization: 'Bearer abc',
      body: { model: 'm' },
      secret: 's',
      credential: 'c',
      password: 'p',
      inputTokens: 123,
      provider: 'nvidia'
    })
    assert.strictEqual(e.apiKey, undefined)
    assert.strictEqual(e.Authorization, undefined)
    assert.strictEqual(e.secret, undefined)
    assert.strictEqual(e.credential, undefined)
    assert.strictEqual(e.password, undefined)
    assert.strictEqual(e.inputTokens, 123)
    assert.strictEqual(e.provider, 'nvidia')
  })

  test('giant strings capped, functions and circular input safe', () => {
    const timeline = new RunTimeline({ runId: 'r1' })
    const circular = { x: 1 }
    circular.self = circular
    const e = timeline.emit(TimelineTypes.LLM_RESPONSE, {
      blob: 'z'.repeat(5000),
      fn: () => {},
      nested: { deep: { deeper: { deepest: { boom: 'x'.repeat(5000) } } } },
      circular
    })
    assert.ok(e.blob.length <= 300)
    assert.strictEqual(e.fn, '[function]')
    assert.strictEqual(JSON.stringify(e).length > 0, true)
  })

  test('full timeline snapshot serializes safely', () => {
    const timeline = new RunTimeline({ runId: 'r1', maxEvents: 10 })
    for (let i = 0; i < 15; i++) timeline.emit(TimelineTypes.LLM_REQUEST, { turn: i, huge: 'q'.repeat(2000) })
    const json = JSON.stringify({ timeline: timeline.tail(100), dropped: timeline.dropped })
    assert.ok(json.length > 0)
    const parsed = JSON.parse(json)
    assert.strictEqual(parsed.timeline.length, 10)
  })
})

describe('failure classification taxonomy', () => {
  test('cancel, timeout, gateway, and generic errors stay distinct', () => {
    const aborted = new Error('x'); aborted.name = 'AbortError'
    assert.strictEqual(classifyFailureClass(aborted), FailureClasses.CANCELLED)
    const timeout = new Error('x'); timeout.category = 'PROVIDER_TIMEOUT'
    assert.strictEqual(classifyFailureClass(timeout), FailureClasses.TIMEOUT)
    const gateway = new Error('x'); gateway.category = 'PROVIDER_GATEWAY_TIMEOUT'
    assert.strictEqual(classifyFailureClass(gateway), FailureClasses.GATEWAY)
    const overloaded = new Error('x'); overloaded.category = 'PROVIDER_OVERLOADED'
    assert.strictEqual(classifyFailureClass(overloaded), FailureClasses.GATEWAY)
    assert.strictEqual(classifyFailureClass(new Error('boom')), FailureClasses.ERROR)
    assert.strictEqual(classifyFailureClass(null), null)
  })
})

describe('budget gauges', () => {
  test('five dimensions reported independently, never merged', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000 })
    const g = policy.gauges({ totals: { inputActual: 500, inputEst: 500, outputActual: 50, outputEst: 50 }, turn: 3, maxTurns: 50 })
    assert.strictEqual(g.runInput.usage, 500)
    assert.strictEqual(g.runInput.limit, 20000)
    assert.strictEqual(g.runInput.remaining, 19500)
    assert.strictEqual(g.runOutput.usage, 50)
    assert.strictEqual(g.runTurns.usage, 3)
    assert.strictEqual(g.runTurns.remaining, 47)
    assert.ok(!('combined' in g) && !('total' in g))
  })

  test('disabled cost is explicit, not zero', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000 })
    const g = policy.gauges({ totals: {} })
    assert.strictEqual(g.runCost.enabled, false)
    assert.strictEqual(g.runCost.usage, null)
    assert.strictEqual(g.runCost.limit, null)
    assert.strictEqual(g.runCost.state, 'disabled')
  })

  test('enabled cost shows usage and percent', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunCost: 10 }, pricing: { inputPerMTok: 1, outputPerMTok: 1 } })
    const g = policy.gauges({ totals: { cost: 2.5 } })
    assert.strictEqual(g.runCost.enabled, true)
    assert.strictEqual(g.runCost.usage, 2.5)
    assert.strictEqual(g.runCost.percent, 0.25)
  })

  test('gauge state follows the worst dimension', () => {
    const policy = new BudgetPolicy({ contextWindow: 1000, budgets: { maxRunInputTokens: 100 } })
    assert.strictEqual(policy.gauges({ totals: { inputActual: 95, inputEst: 95 } }).state, 'conservative')
    assert.strictEqual(policy.gauges({ totals: { inputActual: 95, inputEst: 95 } }).runInput.state, 'conservative')
  })
})

describe('per-model metrics from the ledger', () => {
  test('A -> B -> A yields correct per-model latency, errors, and timeouts', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    ledger.recordCall({ model: 'A', inputEst: 100, outputText: 'ok', durationMs: 100, outcome: 'ok', usage: { input: 90, output: 5, total: 95, reasoning: null } })
    ledger.recordCall({ model: 'B', inputEst: 200, durationMs: 400, outcome: 'failed', failureCategory: 'PROVIDER_TIMEOUT', usage: null })
    ledger.recordCall({ model: 'B', inputEst: 200, outputText: 'ok', durationMs: 300, outcome: 'ok', usage: { input: 190, output: 8, total: 198, reasoning: null } })
    ledger.recordCall({ model: 'A', inputEst: 100, durationMs: 200, outcome: 'cancelled', usage: null })
    const segments = ledger.getSegments()
    const a = segments.find(s => s.model === 'A')
    const b = segments.find(s => s.model === 'B')
    assert.strictEqual(a.calls, 2)
    assert.strictEqual(a.cancels, 1)
    assert.strictEqual(a.avgLatencyMs, 150)
    assert.strictEqual(a.medianLatencyMs, 150)
    assert.strictEqual(b.calls, 2)
    assert.strictEqual(b.errors, 1)
    assert.strictEqual(b.timeouts, 1)
    assert.strictEqual(b.avgLatencyMs, 350)
    assert.strictEqual(b.medianLatencyMs, 350)
    const outcomes = ledger.getOutcomeTotals()
    assert.deepStrictEqual({ ok: outcomes.ok, failed: outcomes.failed, cancelled: outcomes.cancelled, timeouts: outcomes.timeouts }, { ok: 2, failed: 1, cancelled: 1, timeouts: 1 })
  })

  test('latency ring stays bounded over many calls', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    for (let i = 0; i < 80; i++) {
      ledger.recordCall({ model: 'm', inputEst: 10, durationMs: i, outcome: 'ok' })
    }
    const [segment] = ledger.getSegments()
    assert.ok(segment.latencies.length <= 50)
    assert.strictEqual(segment.latencyCount, 80)
    assert.strictEqual(segment.avgLatencyMs, (79 * 80 / 2) / 80)
  })
})

describe('retry observation hooks', () => {
  test('onRetry reports willRetry true until the final attempt', async () => {
    const seen = []
    const err = await withBoundedRetries(async () => {
      const e = new Error('504'); e.category = 'PROVIDER_GATEWAY_TIMEOUT'; throw e
    }, { maxAttempts: 3, onRetry: (info) => seen.push(info) }).then(() => null, (e) => e)
    assert.ok(err)
    assert.deepStrictEqual(seen.map(s => s.willRetry), [true, true, false])
    assert.ok(seen.every(s => s.attempt <= 3 && s.maxAttempts === 3))
  })
})

// ---- End-to-end diagnostic timeline: Lightning -> Ultra -> 504 -> retry ----

function setupEnv() {
  globalThis.localStorage = {
    store: new Map(),
    getItem(k) { const v = this.store.get(k); return v === undefined ? null : v },
    setItem(k, v) { this.store.set(k, v) },
    removeItem(k) { this.store.delete(k) }
  }
}

describe('diagnostic timeline for the original 504 scenario', () => {
  test('Lightning ok, Ultra timeouts with retry, recovery visible without debugging', async () => {
    setupEnv()
    let calls = 0
    let configs = 0
    const nativeData = (calls) => ({ success: true, data: { choices: [{ message: { tool_calls: calls } }] } })
    globalThis.window = {
      api: {
        getAIConfig: async () => ({ hasApiKey: true, model: configs++ < 3 ? 'nvidia/nemotron-3.5-lightning-30b-a3b' : 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia' }),
        listFiles: async () => ({ success: true, children: [] }),
        readFile: async () => ({ success: true, content: 'export const x = 1' }),
        writeFile: async () => ({ success: true }),
        aiRequest: async (args) => {
          calls++
          if (calls === 1) {
            return nativeData([{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'x.js' }) } }])
          }
          if (calls <= 3) return { error: 'Provider request timed out after 180s without a response.', category: 'PROVIDER_TIMEOUT' }
          return nativeData([{ id: 'c2', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ message: 'done' }) } }])
        }
      }
    }
    const { runAgentTask } = await import('../src/services/agentService.js')
    const result = await runAgentTask({
      task: 'do thing', context: { currentFolder: 'C:/test/diag_504' }, tools: {}, maxTurns: 10
    })
    assert.strictEqual(result.completed, true)
    const d = result.diagnostics
    assert.ok(d, 'diagnostics attached')
    const types = d.timeline.map(e => e.type)
    assert.strictEqual(types[0], 'RUN_STARTED')
    assert.ok(types.includes('LLM_REQUEST'))
    assert.ok(types.includes('LLM_RESPONSE'))
    assert.ok(types.includes('MODEL_SWITCH'))
    assert.ok(types.includes('RETRY_STARTED'))
    assert.ok(types.includes('RUN_COMPLETED'))
    const switchEvent = d.timeline.find(e => e.type === 'MODEL_SWITCH')
    assert.ok(switchEvent.from.includes('lightning') && switchEvent.to.includes('ultra'))
    const retries = d.timeline.filter(e => e.type === 'RETRY_STARTED')
    assert.strictEqual(retries.length, 2)
    assert.ok(retries.every(e => e.category === 'PROVIDER_TIMEOUT'))
    assert.ok(d.models.length >= 2)
    const ultra = d.models.find(m => m.model.includes('ultra'))
    assert.strictEqual(ultra.timeouts, 2)
    assert.ok(ultra.avgLatencyMs === null || ultra.avgLatencyMs >= 0)
    assert.ok(d.gauges && d.gauges.runInput && d.gauges.runOutput && d.gauges.runCost && d.gauges.runTurns && d.gauges.requestContext)
    assert.strictEqual(d.gauges.runCost.enabled, false)
    // Full diagnostics snapshot is JSON-safe.
    assert.ok(JSON.stringify(d).length > 0)
  })
})
