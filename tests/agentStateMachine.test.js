import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AgentRuntime, AGENT_STATES, AGENT_EVENTS } from '../src/services/agentEngine/AgentRuntime.js'

const S = AGENT_STATES
const E = AGENT_EVENTS

describe('Formal Agent Runtime State Machine — Milestone 4 Test Suite', () => {

  test('1. Initial state is IDLE', () => {
    const runtime = new AgentRuntime()
    assert.equal(runtime.getState(), S.IDLE)
    assert.equal(runtime.isActive(), false)
    assert.equal(runtime.isTerminal(), false)
  })

  test('2. Valid transition IDLE → PLANNING via TASK_STARTED', () => {
    const runtime = new AgentRuntime()
    const result = runtime.transition(E.TASK_STARTED, { taskId: 'test-1' })
    assert.equal(result.success, true)
    assert.equal(result.from, S.IDLE)
    assert.equal(result.to, S.PLANNING)
    assert.equal(runtime.getState(), S.PLANNING)
    assert.equal(runtime.getTaskId(), 'test-1')
  })

  test('3. Invalid transition IDLE → EXECUTING is rejected with error', () => {
    const runtime = new AgentRuntime()
    const errors = []
    const runtime2 = new AgentRuntime({
      onError: (err) => errors.push(err)
    })
    const result = runtime2.transition(E.ACTION_COMPLETED)
    assert.equal(result.success, false)
    assert.ok(result.error.includes('not valid'))
    assert.equal(runtime2.getState(), S.IDLE)
    assert.equal(errors.length, 1)
  })

  test('4. Full happy path: IDLE → PLANNING → EXECUTING → EVALUATING → VERIFYING → COMPLETED', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED, { taskId: 'happy-path' })
    assert.equal(runtime.getState(), S.PLANNING)

    runtime.transition(E.PLAN_RECEIVED, { turn: 1 })
    assert.equal(runtime.getState(), S.EXECUTING)

    runtime.transition(E.ACTION_COMPLETED, { tool: 'write_file' })
    assert.equal(runtime.getState(), S.EVALUATING)

    // Finish with verification required
    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true,
      hasWrittenFiles: true,
      hasVerified: false
    })
    assert.equal(runtime.getState(), S.VERIFYING)

    runtime.transition(E.VERIFICATION_PASSED)
    assert.equal(runtime.getState(), S.COMPLETED)
    assert.equal(runtime.isTerminal(), true)
    assert.equal(runtime.didComplete(), true)
  })

  test('5. Cancellation from EXECUTING → CANCELLED', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    assert.equal(runtime.getState(), S.EXECUTING)

    runtime.transition(E.USER_CANCELLED)
    assert.equal(runtime.getState(), S.CANCELLED)
    assert.equal(runtime.wasCancelled(), true)
    assert.equal(runtime.isTerminal(), true)
  })

  test('6. Cancellation from AWAITING_APPROVAL → CANCELLED', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.APPROVAL_REQUIRED)
    assert.equal(runtime.getState(), S.AWAITING_APPROVAL)

    runtime.transition(E.USER_CANCELLED)
    assert.equal(runtime.getState(), S.CANCELLED)
  })

  test('7. FINISH_REQUESTED guard routes to VERIFYING when verification required', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    assert.equal(runtime.getState(), S.EVALUATING)

    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true,
      hasWrittenFiles: true,
      hasVerified: false
    })
    assert.equal(runtime.getState(), S.VERIFYING)
  })

  test('8. FINISH_REQUESTED guard routes to COMPLETED when verification not required', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    assert.equal(runtime.getState(), S.EVALUATING)

    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: false,
      hasWrittenFiles: true,
      hasVerified: false
    })
    assert.equal(runtime.getState(), S.COMPLETED)
  })

  test('9. FINISH_REQUESTED routes to COMPLETED when already verified', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)

    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true,
      hasWrittenFiles: true,
      hasVerified: true // Already verified
    })
    assert.equal(runtime.getState(), S.COMPLETED)
  })

  test('10. VERIFICATION_FAILED routes to REPAIRING', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true,
      hasWrittenFiles: true,
      hasVerified: false
    })
    assert.equal(runtime.getState(), S.VERIFYING)

    runtime.transition(E.VERIFICATION_FAILED)
    assert.equal(runtime.getState(), S.REPAIRING)
  })

  test('11. REPAIR_SUCCEEDED routes back to VERIFYING', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true, hasWrittenFiles: true, hasVerified: false
    })
    runtime.transition(E.VERIFICATION_FAILED)
    assert.equal(runtime.getState(), S.REPAIRING)

    runtime.transition(E.REPAIR_SUCCEEDED)
    assert.equal(runtime.getState(), S.VERIFYING)
  })

  test('12. REPAIR_FAILED routes to REPLANNING', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true, hasWrittenFiles: true, hasVerified: false
    })
    runtime.transition(E.VERIFICATION_FAILED)
    assert.equal(runtime.getState(), S.REPAIRING)

    runtime.transition(E.REPAIR_FAILED)
    assert.equal(runtime.getState(), S.REPLANNING)
  })

  test('13. MAX_REPAIR_ATTEMPTS routes to FAILED', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true, hasWrittenFiles: true, hasVerified: false
    })
    runtime.transition(E.VERIFICATION_FAILED)
    assert.equal(runtime.getState(), S.REPAIRING)

    runtime.transition(E.MAX_REPAIR_ATTEMPTS)
    assert.equal(runtime.getState(), S.FAILED)
    assert.equal(runtime.didFail(), true)
  })

  test('14. MAX_REPLANS routes to FAILED', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true, hasWrittenFiles: true, hasVerified: false
    })
    runtime.transition(E.VERIFICATION_FAILED)
    runtime.transition(E.REPAIR_FAILED)
    assert.equal(runtime.getState(), S.REPLANNING)

    runtime.transition(E.MAX_REPLANS)
    assert.equal(runtime.getState(), S.FAILED)
  })

  test('15. REPLANNING → PLANNING → EXECUTING round-trip', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true, hasWrittenFiles: true, hasVerified: false
    })
    runtime.transition(E.VERIFICATION_FAILED)
    runtime.transition(E.REPAIR_FAILED)
    assert.equal(runtime.getState(), S.REPLANNING)

    runtime.transition(E.REPLAN_ISSUED)
    assert.equal(runtime.getState(), S.PLANNING)

    runtime.transition(E.PLAN_RECEIVED)
    assert.equal(runtime.getState(), S.EXECUTING)
  })

  test('16. State history is recorded for every transition', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED, { taskId: 'hist-test' })
    runtime.transition(E.PLAN_RECEIVED, { turn: 1 })
    runtime.transition(E.ACTION_COMPLETED, { tool: 'read_file' })

    const history = runtime.getHistory()
    assert.equal(history.length, 3)

    assert.equal(history[0].from, S.IDLE)
    assert.equal(history[0].to, S.PLANNING)
    assert.equal(history[0].event, E.TASK_STARTED)
    assert.ok(typeof history[0].timestamp === 'number')

    assert.equal(history[1].from, S.PLANNING)
    assert.equal(history[1].to, S.EXECUTING)

    assert.equal(history[2].from, S.EXECUTING)
    assert.equal(history[2].to, S.EVALUATING)
  })

  test('17. History is capped at 200 entries', () => {
    const runtime = new AgentRuntime()
    // Drive 210 transitions by oscillating IDLE → PLANNING → FAIL → IDLE
    for (let i = 0; i < 70; i++) {
      runtime.transition(E.TASK_STARTED)
      runtime.transition(E.PLAN_ERROR)
      runtime.transition(E.TASK_RESET)
    }
    const history = runtime.getHistory()
    assert.ok(history.length <= 200, `History length ${history.length} exceeds cap of 200`)
  })

  test('18. getValidEvents() returns correct events for each state', () => {
    const runtime = new AgentRuntime()
    // IDLE should accept TASK_STARTED
    const idleEvents = runtime.getValidEvents()
    assert.ok(idleEvents.includes(E.TASK_STARTED))
    assert.ok(!idleEvents.includes(E.PLAN_RECEIVED))

    // PLANNING
    runtime.transition(E.TASK_STARTED)
    const planningEvents = runtime.getValidEvents()
    assert.ok(planningEvents.includes(E.PLAN_RECEIVED))
    assert.ok(planningEvents.includes(E.PLAN_ERROR))
    assert.ok(planningEvents.includes(E.USER_CANCELLED))
    assert.ok(!planningEvents.includes(E.ACTION_COMPLETED))

    // EXECUTING
    runtime.transition(E.PLAN_RECEIVED)
    const executingEvents = runtime.getValidEvents()
    assert.ok(executingEvents.includes(E.ACTION_COMPLETED))
    assert.ok(executingEvents.includes(E.APPROVAL_REQUIRED))
    assert.ok(executingEvents.includes(E.USER_CANCELLED))
  })

  test('19. canTransition() returns correct boolean', () => {
    const runtime = new AgentRuntime()
    assert.equal(runtime.canTransition(E.TASK_STARTED), true)
    assert.equal(runtime.canTransition(E.PLAN_RECEIVED), false)
    assert.equal(runtime.canTransition(E.ACTION_COMPLETED), false)

    runtime.transition(E.TASK_STARTED)
    assert.equal(runtime.canTransition(E.PLAN_RECEIVED), true)
    assert.equal(runtime.canTransition(E.TASK_STARTED), false)
  })

  test('20. Reset returns to IDLE from terminal states', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.USER_CANCELLED)
    assert.equal(runtime.getState(), S.CANCELLED)

    const resetResult = runtime.reset()
    assert.equal(resetResult.success, true)
    assert.equal(runtime.getState(), S.IDLE)
    // History should be preserved
    assert.ok(runtime.getHistory().length > 0)
  })

  test('21. Reset from non-terminal active state is rejected', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    assert.equal(runtime.getState(), S.PLANNING)

    const resetResult = runtime.reset()
    assert.equal(resetResult.success, false)
    assert.ok(resetResult.error.includes('Cannot reset'))
    assert.equal(runtime.getState(), S.PLANNING) // Still in PLANNING
  })

  test('22. onTransition callback is invoked with correct arguments', () => {
    const transitions = []
    const runtime = new AgentRuntime({
      onTransition: (from, to, event, payload) => {
        transitions.push({ from, to, event, payload })
      }
    })

    runtime.transition(E.TASK_STARTED, { taskId: 'cb-test' })
    runtime.transition(E.PLAN_RECEIVED, { turn: 1 })

    assert.equal(transitions.length, 2)
    assert.equal(transitions[0].from, S.IDLE)
    assert.equal(transitions[0].to, S.PLANNING)
    assert.equal(transitions[0].event, E.TASK_STARTED)
    assert.equal(transitions[0].payload.taskId, 'cb-test')

    assert.equal(transitions[1].from, S.PLANNING)
    assert.equal(transitions[1].to, S.EXECUTING)
    assert.equal(transitions[1].event, E.PLAN_RECEIVED)
  })

  test('23. APPROVAL_GRANTED returns from AWAITING_APPROVAL to EXECUTING', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.APPROVAL_REQUIRED)
    assert.equal(runtime.getState(), S.AWAITING_APPROVAL)

    runtime.transition(E.APPROVAL_GRANTED)
    assert.equal(runtime.getState(), S.EXECUTING)
    assert.equal(runtime.isActive(), true)
  })

  test('24. APPROVAL_DENIED from AWAITING_APPROVAL routes to CANCELLED', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.APPROVAL_REQUIRED)
    runtime.transition(E.APPROVAL_DENIED)
    assert.equal(runtime.getState(), S.CANCELLED)
  })

  test('25. MAX_TURNS from EXECUTING routes to FAILED', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    assert.equal(runtime.getState(), S.EXECUTING)

    runtime.transition(E.MAX_TURNS)
    assert.equal(runtime.getState(), S.FAILED)
    assert.equal(runtime.didFail(), true)
  })

  test('26. FATAL_ERROR from PLANNING routes to FAILED', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    assert.equal(runtime.getState(), S.PLANNING)

    runtime.transition(E.FATAL_ERROR, { error: 'LLM API unreachable' })
    assert.equal(runtime.getState(), S.FAILED)
  })

  test('27. VERIFICATION_SKIPPED routes to COMPLETED', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true, hasWrittenFiles: true, hasVerified: false
    })
    assert.equal(runtime.getState(), S.VERIFYING)

    runtime.transition(E.VERIFICATION_SKIPPED)
    assert.equal(runtime.getState(), S.COMPLETED)
  })

  test('28. NEEDS_REPLAN from EVALUATING returns to PLANNING', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    assert.equal(runtime.getState(), S.EVALUATING)

    runtime.transition(E.NEEDS_REPLAN)
    assert.equal(runtime.getState(), S.PLANNING)
  })

  test('29. MORE_ACTIONS from EVALUATING returns to EXECUTING', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED)
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    assert.equal(runtime.getState(), S.EVALUATING)

    runtime.transition(E.MORE_ACTIONS)
    assert.equal(runtime.getState(), S.EXECUTING)
  })

  test('30. getLastTransition() returns the most recent entry', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED, { taskId: 'last-tx' })
    runtime.transition(E.PLAN_RECEIVED, { turn: 1 })

    const last = runtime.getLastTransition()
    assert.equal(last.from, S.PLANNING)
    assert.equal(last.to, S.EXECUTING)
    assert.equal(last.event, E.PLAN_RECEIVED)
  })

  test('31. getTransitionCount() returns correct count', () => {
    const runtime = new AgentRuntime()
    assert.equal(runtime.getTransitionCount(), 0)

    runtime.transition(E.TASK_STARTED)
    assert.equal(runtime.getTransitionCount(), 1)

    runtime.transition(E.PLAN_RECEIVED)
    assert.equal(runtime.getTransitionCount(), 2)
  })

  test('32. Reset from IDLE is a no-op success', () => {
    const runtime = new AgentRuntime()
    const result = runtime.reset()
    assert.equal(result.success, true)
    assert.equal(runtime.getState(), S.IDLE)
  })

  test('33. setMetadata and getMetadata work correctly', () => {
    const runtime = new AgentRuntime()
    runtime.setMetadata('repairAttempts', 3)
    runtime.setMetadata('requiresVerification', true)

    const meta = runtime.getMetadata()
    assert.equal(meta.repairAttempts, 3)
    assert.equal(meta.requiresVerification, true)

    // Returns copy, not reference
    meta.repairAttempts = 999
    assert.equal(runtime.getMetadata().repairAttempts, 3)
  })

  test('34. Payload with large strings is truncated in history', () => {
    const runtime = new AgentRuntime()
    const longString = 'x'.repeat(1000)
    runtime.transition(E.TASK_STARTED, { taskId: 'trunc', data: longString })

    const history = runtime.getHistory()
    assert.ok(history[0].payload.data.length < 1000)
    assert.ok(history[0].payload.data.endsWith('…'))
  })

  test('35. Full repair cycle: VERIFY → REPAIR → VERIFY → COMPLETE', () => {
    const runtime = new AgentRuntime()
    runtime.transition(E.TASK_STARTED, { taskId: 'repair-cycle' })
    runtime.transition(E.PLAN_RECEIVED)
    runtime.transition(E.ACTION_COMPLETED)
    runtime.transition(E.FINISH_REQUESTED, {
      requiresVerification: true, hasWrittenFiles: true, hasVerified: false
    })
    assert.equal(runtime.getState(), S.VERIFYING)

    runtime.transition(E.VERIFICATION_FAILED)
    assert.equal(runtime.getState(), S.REPAIRING)

    runtime.transition(E.REPAIR_SUCCEEDED)
    assert.equal(runtime.getState(), S.VERIFYING)

    runtime.transition(E.VERIFICATION_PASSED)
    assert.equal(runtime.getState(), S.COMPLETED)
    assert.equal(runtime.didComplete(), true)

    // Verify history captured the full journey
    const history = runtime.getHistory()
    const states = history.map(h => h.to)
    assert.ok(states.includes(S.VERIFYING))
    assert.ok(states.includes(S.REPAIRING))
    assert.ok(states.includes(S.COMPLETED))
  })
})
