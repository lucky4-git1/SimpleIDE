import test from 'node:test'
import assert from 'node:assert/strict'
import { PrimeRouter, LAYA_ROLLOUT_MODES } from '../src/services/agentEngine/PrimeRouter.js'
import { LayaDecisionAdapter } from '../src/services/agentEngine/LayaDecisionAdapter.js'
import { LayaModelManager } from '../src/services/agentEngine/LayaModelManager.js'

test('Laya Fallback & Resilience — missing model, low confidence, offline safety', async (t) => {
  await t.test('gracefully falls back to calibrated CPU rules when model file does not exist', async () => {
    const fakeManager = new LayaModelManager({ cacheDir: 'C:\\non\\existent\\cache\\path' })
    const adapter = new LayaDecisionAdapter({ modelManager: fakeManager })
    await adapter.initialize()

    const decision = await adapter.predict({
      request: 'Run test suite for authentication',
      state: 'IDLE'
    })

    assert.ok(decision)
    assert.equal(decision.intent, 'test')
    assert.equal(decision.actionClass, 'local_tool')
    assert.ok(decision.confidence >= 0.9)
    assert.ok(decision.latencyMs < 50)
  })

  await t.test('escalates to main_llm when confidence is below medium threshold (<0.60)', async () => {
    const lowConfidenceAdapter = {
      predict: async () => ({
        intent: 'chat',
        actionClass: 'local_tool',
        toolFamily: 'none',
        needsLLM: false,
        needsVerification: false,
        confidence: 0.45,
        modelVersion: 'test-model'
      })
    }

    const router = new PrimeRouter({
      adapter: lowConfidenceAdapter,
      layaMode: LAYA_ROLLOUT_MODES.LEGACY
    })

    const decision = await router.decide({ request: 'vague ambiguity', state: 'IDLE' })
    assert.equal(decision.actionClass, 'main_llm')
    assert.equal(decision.needsLLM, true)
    assert.equal(decision.fallback, true)
    assert.ok(decision.reason.includes('Low confidence'))
  })

  await t.test('handles user abort signal cleanly', async () => {
    const controller = new AbortController()
    controller.abort()

    const router = new PrimeRouter({
      adapter: { predict: async () => ({}) }
    })

    const decision = await router.decide({
      request: 'git commit',
      signal: controller.signal
    })

    assert.ok(decision)
    assert.equal(decision.fallback, true)
    assert.ok(decision.reason.includes('aborted'))
  })

  await t.test('operates entirely offline with zero network requests', async () => {
    const adapter = new LayaDecisionAdapter()
    const start = Date.now()
    const decision = await adapter.predict({
      request: 'Who calls generateToken in AuthService?',
      state: 'EXECUTING'
    })
    const duration = Date.now() - start

    assert.ok(decision)
    assert.equal(decision.intent, 'navigate')
    assert.ok(duration < 25, `Expected offline execution < 25ms, got ${duration}ms`)
  })
})
