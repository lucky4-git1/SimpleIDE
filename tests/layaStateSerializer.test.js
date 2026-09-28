import test from 'node:test'
import assert from 'node:assert/strict'
import { LayaStateSerializer } from '../src/services/agentEngine/LayaStateSerializer.js'

test('LayaStateSerializer — token bounding and secret redaction', async (t) => {
  await t.test('redacts authorization headers and api keys', () => {
    const raw = 'Calling service with Bearer sk-ant-api03-abcdef123456 and apiKey="SECRET_12345678"'
    const redacted = LayaStateSerializer.redactSecrets(raw)
    assert.ok(!redacted.includes('sk-ant-api03-abcdef123456'))
    assert.ok(!redacted.includes('SECRET_12345678'))
    assert.ok(redacted.includes('[REDACTED]'))
  })

  await t.test('compacts giant tool observations cleanly', () => {
    const hugeResult = 'line\n'.repeat(500)
    const obs = { tool: 'grep_search', status: 'OK', result: hugeResult }
    const compacted = LayaStateSerializer.compactObservation(obs)
    assert.ok(compacted.length < 120)
    assert.ok(compacted.startsWith('[grep_search:OK]'))
  })

  await t.test('enforces strict character budget under 512 tokens (~1800 chars)', () => {
    const hugeInput = {
      request: 'A'.repeat(2000),
      state: 'EXECUTING',
      activeFile: 'src/very/long/path/Component.jsx',
      diagnostics: ['Error: something broke '.repeat(50)],
      recentObservations: Array(20).fill({ tool: 'editor', result: 'giant buffer '.repeat(20) })
    }

    const serialized = LayaStateSerializer.serialize(hugeInput)
    const jsonStr = JSON.stringify(serialized)
    assert.ok(jsonStr.length <= 1800, `Output length ${jsonStr.length} exceeds 1800 chars`)
    assert.ok(serialized.task)
    assert.ok(serialized.state === 'EXECUTING')
  })
})
