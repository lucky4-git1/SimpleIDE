import test from 'node:test'
import assert from 'node:assert/strict'
import { PrimeRouter, LAYA_ROLLOUT_MODES } from '../src/services/agentEngine/PrimeRouter.js'
import { LayaSafetyPolicy } from '../src/services/agentEngine/LayaSafetyPolicy.js'
import { MainProcessRouterAdapter } from '../src/services/agentEngine/MainProcessRouterAdapter.js'

test('Laya Integration & Multi-Mode Rollout — legacy, shadow, hybrid, laya', async (t) => {
  const baseAdapter = new MainProcessRouterAdapter()

  await t.test('legacy mode relies entirely on base adapter', async () => {
    const router = new PrimeRouter({
      adapter: baseAdapter,
      layaMode: LAYA_ROLLOUT_MODES.LEGACY
    })

    const decision = await router.decide({ request: 'git status', state: 'IDLE' })
    assert.equal(decision.intent, 'git')
    assert.equal(router.getShadowTelemetry().length, 0)
  })

  await t.test('shadow mode records telemetry in background without altering production decision', async () => {
    const router = new PrimeRouter({
      adapter: baseAdapter,
      layaMode: LAYA_ROLLOUT_MODES.SHADOW
    })

    const decision = await router.decide({ request: 'npm test', state: 'IDLE' })
    assert.equal(decision.intent, 'test')

    // Allow shadow promise microtask to resolve
    await new Promise(r => setTimeout(r, 50))
    const telemetry = router.getShadowTelemetry()
    assert.ok(telemetry.length >= 1)
    assert.equal(telemetry[0].productionIntent, 'test')
    assert.equal(telemetry[0].layaIntent, 'test')
    assert.equal(telemetry[0].agreement, true)
  })

  await t.test('hybrid mode routes low-risk navigation to Laya directly', async () => {
    const router = new PrimeRouter({
      adapter: baseAdapter,
      layaMode: LAYA_ROLLOUT_MODES.HYBRID
    })

    const decision = await router.decide({
      request: 'Who calls validateTerminalCwd in the codebase?',
      state: 'EXECUTING'
    })
    assert.equal(decision.intent, 'navigate')
    assert.equal(decision.symbol_navigation, 'required')
  })

  await t.test('laya mode acts as primary controller', async () => {
    const router = new PrimeRouter({
      adapter: baseAdapter,
      layaMode: LAYA_ROLLOUT_MODES.LAYA
    })

    const decision = await router.decide({
      request: 'Change the button color to deep blue',
      state: 'EXECUTING'
    })
    assert.equal(decision.intent, 'edit')
    assert.equal(decision.symbol_navigation, 'none') // Enforced hard negative
  })

  await t.test('LayaSafetyPolicy blocks catastrophic commands unconditionally', () => {
    const catastrophicCmds = [
      'rm -rf /',
      'del /s /q c:\\',
      ':(){ :|:& };:'
    ]

    for (const cmd of catastrophicCmds) {
      const check = LayaSafetyPolicy.evaluate({}, { command: cmd })
      assert.equal(check.allowed, false)
      assert.ok(check.reason.includes('safety policy'))
    }
  })

  await t.test('LayaSafetyPolicy requires user confirmation for destructive writes', () => {
    const checkUnapproved = LayaSafetyPolicy.evaluate(
      { risk: 'high', toolFamily: 'editor' },
      { name: 'write_file', userApproved: false }
    )
    assert.equal(checkUnapproved.requiresApproval, true)

    const checkApproved = LayaSafetyPolicy.evaluate(
      { risk: 'high', toolFamily: 'editor' },
      { name: 'write_file', userApproved: true }
    )
    assert.equal(checkApproved.requiresApproval, false)
  })
})
