import test from 'node:test'
import assert from 'node:assert/strict'
import { PrimeRouter, LAYA_ROLLOUT_MODES } from '../src/services/agentEngine/PrimeRouter.js'
import { ROUTER_MODES } from '../src/services/agentEngine/primeRouterSchemas.js'

test('Phase 9 & 10: Shadow Mode, Live Telemetry & Hybrid Rollout Evaluation', async (t) => {
  // Mock legacy adapter simulating existing Prime Router behavior
  const legacyAdapter = {
    async predict({ request }) {
      const lower = String(request).toLowerCase()
      if (lower.includes('status') || lower.includes('git')) {
        return {
          intent: 'git',
          actionClass: 'local_tool',
          toolFamily: 'git',
          needsLLM: false,
          needsVerification: false,
          confidence: 0.90,
          modelVersion: 'legacy-prime-0.1.0'
        }
      }
      if (lower.includes('test')) {
        return {
          intent: 'test',
          actionClass: 'local_tool',
          toolFamily: 'testing',
          needsLLM: false,
          needsVerification: true,
          confidence: 0.92,
          modelVersion: 'legacy-prime-0.1.0'
        }
      }
      return {
        intent: 'edit',
        actionClass: 'main_llm',
        toolFamily: 'editor',
        needsLLM: true,
        needsVerification: false,
        confidence: 0.85,
        modelVersion: 'legacy-prime-0.1.0'
      }
    }
  }

  await t.test('1. Shadow Mode: Legacy decision remains authoritative while Laya telemetry is recorded', async () => {
    const router = new PrimeRouter({
      adapter: legacyAdapter,
      layaMode: LAYA_ROLLOUT_MODES.SHADOW,
      mode: ROUTER_MODES.ACTIVE
    })

    // Execute decision
    const decision = await router.decide({ request: 'git status' })

    // 1. Authoritative decision comes from legacy adapter
    assert.equal(decision.modelVersion, 'legacy-prime-0.1.0')
    assert.equal(decision.intent, 'git')
    assert.equal(decision.actionClass, 'local_tool')

    // 2. Wait for shadow promise to complete
    const telemetry = await router.flushShadowTelemetry()
    assert.ok(telemetry.length >= 1)

    const entry = telemetry[0]
    assert.equal(entry.request, 'git status')
    assert.ok(entry.legacyDecision)
    assert.ok(entry.layaDecision)
    assert.equal(entry.legacyDecision.intent, 'git')
    assert.equal(typeof entry.agreement, 'boolean')
    assert.ok(entry.confidence.legacy >= 0.85)
    assert.ok(entry.confidence.laya >= 0.80)
    assert.ok(entry.latency.legacyMs >= 0)
    assert.ok(entry.latency.layaMs >= 0)
    assert.equal(entry.inferenceSource, 'fallback') // unweighted/headless test fallback
    assert.ok(entry.contextDecision)
    assert.ok(entry.riskDecision)
  })

  await t.test('2. Shadow Mode: Telemetry Summary aggregates percentiles, distribution, and differences', async () => {
    const router = new PrimeRouter({
      adapter: legacyAdapter,
      layaMode: LAYA_ROLLOUT_MODES.SHADOW,
      mode: ROUTER_MODES.ACTIVE
    })

    const requests = [
      'git status',
      'npm test',
      'Change button color in theme.css',
      'Where is authenticateUser defined?',
      'Refactor token handler'
    ]

    for (const req of requests) {
      await router.decide({ request: req })
    }

    await router.flushShadowTelemetry()
    const summary = router.getShadowTelemetrySummary()

    assert.equal(summary.totalDecisions, 5)
    assert.ok(summary.agreementRate >= 0 && summary.agreementRate <= 100)
    assert.ok(summary.disagreementRate >= 0 && summary.disagreementRate <= 100)
    assert.equal(Number((summary.agreementRate + summary.disagreementRate).toFixed(1)), 100)
    assert.ok(summary.legacyLatency.p50 >= 0)
    assert.ok(summary.layaLatency.p50 >= 0)
    assert.ok(summary.confidenceDistribution)
    assert.ok(summary.categoryDisagreements)
  })

  await t.test('3. Hybrid Mode: Low-risk navigation uses Laya; high-risk edits escalate to LLM', async () => {
    const router = new PrimeRouter({
      adapter: legacyAdapter,
      layaMode: LAYA_ROLLOUT_MODES.HYBRID,
      mode: ROUTER_MODES.ACTIVE
    })

    // Low-risk semantic navigation request
    const navDecision = await router.decide({ request: 'Where is generateToken defined and who calls it?' })
    assert.equal(navDecision.intent, 'navigate')
    assert.equal(navDecision.actionClass, 'local_tool')
    assert.equal(navDecision.needsLLM, false)

    // High-risk edit request
    const editDecision = await router.decide({ request: 'Refactor authenticateUser and delete legacy methods' })
    assert.equal(editDecision.needsLLM, true)
    assert.equal(editDecision.actionClass, 'main_llm')
  })

  await t.test('4. Deterministic safety policy cannot be bypassed in ANY rollout mode', async () => {
    const modes = [
      LAYA_ROLLOUT_MODES.LEGACY,
      LAYA_ROLLOUT_MODES.SHADOW,
      LAYA_ROLLOUT_MODES.HYBRID,
      LAYA_ROLLOUT_MODES.LAYA
    ]

    for (const mode of modes) {
      const router = new PrimeRouter({
        adapter: legacyAdapter,
        layaMode: mode,
        mode: ROUTER_MODES.ACTIVE
      })

      const catastrophicCmd = 'rm -rf /'
      const decision = await router.decide({ request: catastrophicCmd })

      // Authoritative safety interception: blocked from local_tool execution
      assert.notEqual(decision.actionClass, 'local_tool')
      assert.equal(decision.needsLLM, true)
      assert.equal(decision.fallback, true)
      assert.match(decision.reason, /safety policy|prohibited|blocked/i)
    }
  })

  await t.test('5. Four rollout modes operate independently and deterministically', async () => {
    // A. Legacy Mode: Laya not invoked, zero shadow telemetry
    const legacyRouter = new PrimeRouter({ adapter: legacyAdapter, layaMode: LAYA_ROLLOUT_MODES.LEGACY })
    const resA = await legacyRouter.decide({ request: 'git status' })
    assert.equal(resA.modelVersion, 'legacy-prime-0.1.0')
    assert.equal(legacyRouter.getShadowTelemetry().length, 0)

    // B. Shadow Mode: Legacy output, shadow telemetry recorded
    const shadowRouter = new PrimeRouter({ adapter: legacyAdapter, layaMode: LAYA_ROLLOUT_MODES.SHADOW })
    const resB = await shadowRouter.decide({ request: 'git status' })
    assert.equal(resB.modelVersion, 'legacy-prime-0.1.0')
    await shadowRouter.flushShadowTelemetry()
    assert.equal(shadowRouter.getShadowTelemetry().length, 1)

    // C. Hybrid Mode: Laya for low risk, legacy/LLM for high risk
    const hybridRouter = new PrimeRouter({ adapter: legacyAdapter, layaMode: LAYA_ROLLOUT_MODES.HYBRID })
    const resC = await hybridRouter.decide({ request: 'Find definition of verifyToken' })
    assert.equal(resC.intent, 'navigate')

    // D. Laya Mode: Laya model direct control
    const layaRouter = new PrimeRouter({ adapter: legacyAdapter, layaMode: LAYA_ROLLOUT_MODES.LAYA })
    const resD = await layaRouter.decide({ request: 'Find callers of verifyToken' })
    assert.equal(resD.intent, 'navigate')
  })
})
