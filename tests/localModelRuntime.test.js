import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { LocalModelRuntime } from '../src/main/primeRouter/LocalModelRuntime.js'
import { MainProcessRouterAdapter } from '../src/services/agentEngine/MainProcessRouterAdapter.js'
import { PrimeRouter } from '../src/services/agentEngine/PrimeRouter.js'

describe('Phase 3: Local Model Runtime & Main Process Integration', () => {
  test('1. LocalModelRuntime initializes and reports status', async () => {
    const runtime = new LocalModelRuntime()
    assert.equal(runtime.initialized, false)
    assert.equal(runtime.ready, false)

    await runtime.initInBackground()
    // Wait for the next tick timeout
    await new Promise(r => setTimeout(r, 100))

    const status = runtime.getStatus()
    assert.equal(status.initialized, true)
    assert.equal(status.ready, true)
    assert.equal(status.threadSettings.intraOpNumThreads, 2)
  })

  test('2. CPU prediction for test command is fast (< 100ms) and accurate', async () => {
    const runtime = new LocalModelRuntime()
    const result = await runtime.predict({ request: 'npm test', state: 'IDLE' })
    assert.equal(result.intent, 'test')
    assert.equal(result.actionClass, 'local_tool')
    assert.equal(result.toolFamily, 'testing')
    assert.equal(result.needsLLM, false)
    assert.equal(result.needsVerification, true)
    assert.ok(result.confidence >= 0.85)
    assert.ok(result.latencyMs < 100, `Latency was ${result.latencyMs}ms, should be < 100ms on CPU`)
  })

  test('3. Hard negative: "Tell me what npm test does" routes to explanation (main_llm), NOT terminal', async () => {
    const runtime = new LocalModelRuntime()
    const result = await runtime.predict({ request: 'Tell me what npm test does', state: 'IDLE' })
    assert.equal(result.intent, 'explain')
    assert.equal(result.actionClass, 'main_llm')
    assert.equal(result.needsLLM, true)
    assert.equal(result.toolFamily, 'none')
  })

  test('4. Hard negative: "Run npm test and explain why it fails" combines tools and LLM', async () => {
    const runtime = new LocalModelRuntime()
    const result = await runtime.predict({ request: 'run test and explain why it fails', state: 'IDLE' })
    assert.equal(result.actionClass, 'main_llm')
    assert.equal(result.needsLLM, true)
    assert.equal(result.needsVerification, true)
  })

  test('5. Hard negative: "Inspect auth.ts but don\'t modify anything" remains read-only', async () => {
    const runtime = new LocalModelRuntime()
    const result = await runtime.predict({ request: 'inspect auth.ts but don\'t modify anything', state: 'IDLE' })
    assert.equal(result.intent, 'inspect')
    assert.equal(result.actionClass, 'local_tool')
    assert.equal(result.toolFamily, 'filesystem')
    assert.equal(result.needsLLM, false)
    assert.equal(result.needsVerification, false)
  })

  test('6. Batch prediction processes multiple queries', async () => {
    const runtime = new LocalModelRuntime()
    const batch = [
      { request: 'git status' },
      { request: 'npm test' },
      { request: 'find auth handler' }
    ]
    const results = await runtime.batchPredict(batch)
    assert.equal(results.length, 3)
    assert.equal(results[0].intent, 'git')
    assert.equal(results[1].intent, 'test')
    assert.equal(results[2].intent, 'search')
  })

  test('7. MainProcessRouterAdapter bridges to PrimeRouter in assist and active modes', async () => {
    const runtime = new LocalModelRuntime()
    const mockApi = {
      primeRouter: {
        decide: async (params) => ({ success: true, decision: await runtime.predict(params) }),
        batchDecide: async (items) => ({ success: true, decisions: await runtime.batchPredict(items) }),
        getStatus: async () => ({ status: runtime.getStatus() })
      }
    }

    const adapter = new MainProcessRouterAdapter(mockApi)
    const router = new PrimeRouter({ adapter, mode: 'active' })

    const decision = await router.decide({ request: 'git status' })
    assert.equal(decision.intent, 'git')
    assert.equal(decision.actionClass, 'local_tool')
    assert.equal(decision.needsLLM, false)
  })
})
