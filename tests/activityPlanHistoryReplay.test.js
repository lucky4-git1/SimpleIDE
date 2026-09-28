import test from 'node:test'
import assert from 'node:assert/strict'
import { RunHistoryManager } from '../src/services/agentEngine/RunHistoryManager.js'
import { AgentReplayManager, sanitizeReplayValue } from '../src/services/agentEngine/AgentReplayManager.js'

test('Phase 23 — RunHistoryManager: records, lists, and reopens previous runs', () => {
  const historyMgr = new RunHistoryManager({ maxRuns: 10 })

  // Record a run
  const run1 = historyMgr.recordRun({
    runId: 'run-001',
    task: 'Fix authentication token expiration',
    durationMs: 4500,
    models: ['gpt-4o', 'local-laya'],
    filesChanged: ['src/auth.ts', 'tests/auth.test.ts'],
    tests: [{ name: 'auth.test.ts', passed: true }],
    result: 'complete',
    checkpoint: { todos: [] }
  })

  assert.ok(run1)
  assert.equal(historyMgr.listRuns().length, 1)

  // Reopen run
  const reopened = historyMgr.reopenRun('run-001')
  assert.equal(reopened.success, true)
  assert.equal(reopened.task, 'Fix authentication token expiration')
  assert.equal(reopened.filesChanged.length, 2)
  assert.equal(reopened.resumable, true)
})

test('Phase 24 — AgentReplayManager: records and streams playback while redacting secrets', async () => {
  const replayMgr = new AgentReplayManager()

  // 1. Secret redaction test
  const rawPayload = {
    apiKey: 'sk-1234567890abcdef',
    headerText: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token',
    publicParam: 'auth.ts'
  }
  const sanitized = sanitizeReplayValue(rawPayload)
  assert.equal(sanitized.apiKey, '[REDACTED_SECRET]')
  assert.ok(sanitized.headerText.includes('Bearer [REDACTED]'))
  assert.equal(sanitized.publicParam, 'auth.ts')

  // 2. Trajectory recording & streaming
  replayMgr.startTrajectory('run-replay-1', 'Refactor auth service')
  replayMgr.recordEvent('run-replay-1', 'laya_decision', { intent: 'refactor', actionClass: 'safe' })
  replayMgr.recordEvent('run-replay-1', 'tool_call', { name: 'find_definition', symbol: 'AuthService' })
  replayMgr.recordEvent('run-replay-1', 'verification', { passed: true })
  replayMgr.finalizeTrajectory('run-replay-1', { status: 'complete', summary: 'Successfully refactored' })

  const frames = []
  for await (const frame of replayMgr.replayStream('run-replay-1', { delayMs: 1 })) {
    frames.push(frame)
  }

  assert.equal(frames[0].type, 'trajectory_start')
  assert.equal(frames[1].type, 'laya_decision')
  assert.equal(frames[2].type, 'tool_call')
  assert.equal(frames[3].type, 'verification')
  assert.equal(frames[4].type, 'trajectory_end')
  assert.equal(frames[4].outcome.status, 'complete')
})
