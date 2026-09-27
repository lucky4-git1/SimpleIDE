import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PrimeRouter } from '../src/services/agentEngine/PrimeRouter.js'
import {
  PrimeRouterDecisionSchema,
  ROUTER_MODES,
  CONFIDENCE_THRESHOLDS,
  createFallbackDecision
} from '../src/services/agentEngine/primeRouterSchemas.js'

describe('PrimeRouter Abstraction & Decision Taxonomy', () => {
  test('1. Valid decision conforms strictly to Zod schema', () => {
    const valid = {
      intent: 'debug',
      actionClass: 'main_llm',
      toolFamily: 'filesystem',
      needsLLM: true,
      needsVerification: true,
      confidence: 0.93,
      modelVersion: 'prime-router-0.1.0',
      latencyMs: 42
    }
    const result = PrimeRouterDecisionSchema.safeParse(valid)
    assert.ok(result.success, 'Valid decision should parse without error')
    assert.equal(result.data.intent, 'debug')
    assert.equal(result.data.actionClass, 'main_llm')
    assert.equal(result.data.toolFamily, 'filesystem')
  })

  test('2. Rejects invalid intent and actionClass', () => {
    const invalid = {
      intent: 'hack_the_system',
      actionClass: 'execute_arbitrary_code',
      toolFamily: 'filesystem',
      needsLLM: true,
      needsVerification: false,
      confidence: 0.99
    }
    const result = PrimeRouterDecisionSchema.safeParse(invalid)
    assert.equal(result.success, false, 'Invalid enums must be rejected')
  })

  test('3. Fallback generator produces safe, valid decisions', () => {
    const fallback = createFallbackDecision({
      request: 'Run npm test to see what broke',
      reason: 'Network disconnect',
      latencyMs: 12
    })
    const validation = PrimeRouterDecisionSchema.safeParse(fallback)
    assert.ok(validation.success, 'Fallback must satisfy decision schema')
    assert.equal(fallback.actionClass, 'main_llm')
    assert.equal(fallback.needsLLM, true)
    assert.equal(fallback.toolFamily, 'testing')
    assert.equal(fallback.fallback, true)
  })

  test('4. Safe fallback when adapter throws or is unavailable', async () => {
    const routerWithoutAdapter = new PrimeRouter()
    const res1 = await routerWithoutAdapter.decide({ request: 'Inspect package.json' })
    assert.ok(res1, 'Must return a decision')
    assert.equal(res1.fallback, true)
    assert.equal(res1.actionClass, 'main_llm')

    const throwingAdapter = {
      async predict() {
        throw new Error('CUDA Out of memory')
      }
    }
    const routerWithThrowingAdapter = new PrimeRouter({ adapter: throwingAdapter })
    const res2 = await routerWithThrowingAdapter.decide({ request: 'Search for login' })
    assert.ok(res2, 'Must not crash on adapter exception')
    assert.equal(res2.fallback, true)
    assert.ok(res2.reason.includes('CUDA Out of memory'))
  })

  test('5. High confidence (>= 0.85) retains local routing', async () => {
    const mockAdapter = {
      async predict() {
        return {
          intent: 'git',
          actionClass: 'local_tool',
          toolFamily: 'git',
          needsLLM: false,
          needsVerification: false,
          confidence: 0.95
        }
      }
    }
    const router = new PrimeRouter({ adapter: mockAdapter, mode: ROUTER_MODES.ACTIVE })
    const decision = await router.decide({ request: 'git status' })
    assert.equal(decision.actionClass, 'local_tool')
    assert.equal(decision.needsLLM, false)
    assert.equal(decision.confidence, 0.95)
    assert.equal(decision.fallback, false)
  })

  test('6. Low confidence (< 0.60) forces LLM escalation and fallback flag', async () => {
    const mockAdapter = {
      async predict() {
        return {
          intent: 'run_command',
          actionClass: 'local_tool',
          toolFamily: 'terminal',
          needsLLM: false,
          needsVerification: false,
          confidence: 0.45
        }
      }
    }
    const router = new PrimeRouter({ adapter: mockAdapter, mode: ROUTER_MODES.ACTIVE })
    const decision = await router.decide({ request: 'deploy to production' })
    assert.equal(decision.actionClass, 'main_llm')
    assert.equal(decision.needsLLM, true)
    assert.equal(decision.fallback, true)
    assert.ok(decision.reason.includes('Low confidence'))
  })

  test('7. Moderate confidence (0.60 - 0.85) triggers conservative LLM escalation for modifications', async () => {
    const mockAdapter = {
      async predict() {
        return {
          intent: 'edit',
          actionClass: 'local_tool',
          toolFamily: 'editor',
          needsLLM: false,
          needsVerification: true,
          confidence: 0.75
        }
      }
    }
    const router = new PrimeRouter({ adapter: mockAdapter, mode: ROUTER_MODES.ACTIVE })
    const decision = await router.decide({ request: 'Refactor user auth handler' })
    assert.equal(decision.actionClass, 'main_llm')
    assert.equal(decision.needsLLM, true)
    assert.ok(decision.reason.includes('conservative'))
  })

  test('8. Feature flags: disabled mode and assist mode', async () => {
    const mockAdapter = {
      async predict() {
        return {
          intent: 'search',
          actionClass: 'local_tool',
          toolFamily: 'search',
          needsLLM: false,
          needsVerification: false,
          confidence: 0.90
        }
      }
    }
    // Disabled mode
    const disabledRouter = new PrimeRouter({ adapter: mockAdapter, mode: ROUTER_MODES.DISABLED })
    const disabledRes = await disabledRouter.decide({ request: 'Search for index.js' })
    assert.equal(disabledRes.fallback, true)
    assert.ok(disabledRes.reason.includes('disabled'))

    // Assist mode
    const assistRouter = new PrimeRouter({ adapter: mockAdapter, mode: ROUTER_MODES.ASSIST })
    const assistRes = await assistRouter.decide({ request: 'Search for index.js' })
    assert.equal(assistRes.assistMode, true)
  })

  test('9. LRU Cache hits and eviction', async () => {
    let callCount = 0
    const mockAdapter = {
      async predict({ request }) {
        callCount++
        return {
          intent: 'inspect',
          actionClass: 'local_tool',
          toolFamily: 'filesystem',
          needsLLM: false,
          needsVerification: false,
          confidence: 0.92
        }
      }
    }
    const router = new PrimeRouter({ adapter: mockAdapter, maxCacheSize: 2, cacheTtlMs: 5000 })
    
    // First call -> adapter invoked
    const res1 = await router.decide({ request: 'View package.json' })
    assert.equal(callCount, 1)
    assert.equal(res1.cached, undefined)

    // Second identical call -> cache hit
    const res2 = await router.decide({ request: 'View package.json' })
    assert.equal(callCount, 1, 'Should not invoke adapter on cache hit')
    assert.equal(res2.cached, true)

    // Add 2 more items to exceed maxCacheSize (2)
    await router.decide({ request: 'View index.html' })
    await router.decide({ request: 'View README.md' })
    assert.equal(callCount, 3)

    // First item should have been evicted
    await router.decide({ request: 'View package.json' })
    assert.equal(callCount, 4, 'Evicted item should re-trigger adapter call')
  })

  test('10. Batch decisions', async () => {
    const mockAdapter = {
      async predict({ request }) {
        return {
          intent: request.includes('test') ? 'test' : 'inspect',
          actionClass: 'local_tool',
          toolFamily: request.includes('test') ? 'testing' : 'filesystem',
          needsLLM: false,
          needsVerification: false,
          confidence: 0.95
        }
      }
    }
    const router = new PrimeRouter({ adapter: mockAdapter, mode: ROUTER_MODES.ACTIVE })
    const batch = [
      { request: 'Run tests' },
      { request: 'Inspect config' }
    ]
    const results = await router.batchDecide(batch)
    assert.equal(results.length, 2)
    assert.equal(results[0].intent, 'test')
    assert.equal(results[1].intent, 'inspect')
  })
})
