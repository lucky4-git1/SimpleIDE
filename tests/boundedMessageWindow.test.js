import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MessageWindow, MESSAGE_KINDS, REASONING_POLICIES } from '../src/services/agentEngine/MessageWindow.js'
import { RunLedger } from '../src/services/agentEngine/RunLedger.js'
import { estimateTokens } from '../src/services/agentEngine/ContextChunk.js'

// Deterministic payload of ~n tokens under the project's estimator.
const sized = (n) => 'x'.repeat(Math.ceil(n * 3.8))

const asst = (text) => ({ role: 'assistant', content: text })
const asstCalls = (ids) => ({
  role: 'assistant',
  content: null,
  tool_calls: ids.map((id, i) => ({ id, type: 'function', function: { name: `tool${i}`, arguments: '{}' } }))
})
const toolRes = (id, text = 'ok') => ({ role: 'tool', tool_call_id: id, content: text })
const user = (text) => ({ role: 'user', content: text })

// Structural validity for OpenAI-compatible sequences: no leading tool
// message, and every tool message follows an assistant message that carried
// tool calls (consecutive tool results share the flag).
function assertValidSequence(messages) {
  assert.ok(messages.length > 0, 'context must never be empty when history exists')
  let callsOpen = false
  let first = true
  for (const m of messages) {
    const isToolLike = m.role === 'tool' ||
      (m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result'))
    if (isToolLike) {
      assert.ok(!first, 'leading tool message without its assistant call')
      assert.ok(callsOpen, 'tool result without a preceding assistant tool_calls message')
    } else if (m.role === 'assistant' || m.role === 'model') {
      const calls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0 ||
        (Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_use')) ||
        (Array.isArray(m.parts) && m.parts.some(p => p && p.functionCall))
      callsOpen = calls
    } else {
      callsOpen = false
    }
    first = false
  }
}

describe('MessageWindow basics', () => {
  test('empty window builds to facts/task-state only, never crashes', () => {
    const window = new MessageWindow({ maxWindowTokens: 1000 })
    assert.ok(window.isEmpty())
    const report = window.build({})
    assert.deepStrictEqual(report.messages, [])
    assert.strictEqual(report.evicted, 0)
  })

  test('seed + small exchange fits entirely, nothing evicted', () => {
    const window = new MessageWindow({ maxWindowTokens: 5000 })
    window.seed([{ role: 'system', content: 'sys' }, user('do the thing')])
    window.push(asstCalls(['c1']))
    window.push(toolRes('c1', 'result'))
    window.push(asst('done'))
    const report = window.build({ taskState: 'state' })
    assert.strictEqual(report.evicted, 0)
    // system + initial user + asst + tool + asst + facts? (no facts) + task state
    assert.strictEqual(report.messages.length, 6)
    assert.strictEqual(report.messages[0].role, 'system')
    assertValidSequence(report.messages)
  })

  test('facts and task state lead history and survive pressure', () => {
    const window = new MessageWindow({ maxWindowTokens: 400 })
    window.seed([{ role: 'system', content: 'sys' }, user('task ' + sized(300))])
    window.addFact('User requires TypeScript.')
    for (let i = 0; i < 6; i++) {
      window.push(asstCalls([`c${i}`]))
      window.push(toolRes(`c${i}`, sized(120)))
    }
    const report = window.build({ taskState: 'working on files' })
    assert.ok(report.evicted > 0)
    assert.ok(report.tokensAfter <= 400 || report.overflow)
    const texts = report.messages.map(m => JSON.stringify(m.content || m))
    assert.ok(texts.some(t => t.includes('User requires TypeScript')), 'fact must survive')
    assert.ok(texts.some(t => t.includes('working on files')), 'task state must be present')
    assert.strictEqual(report.factsIncluded, 1)
    assertValidSequence(report.messages)
  })
})

describe('MessageWindow long runs stay bounded', () => {
  for (const turns of [5, 20, 50, 100]) {
    test(`${turns} turns remain within the configured window`, () => {
      const window = new MessageWindow({ maxWindowTokens: 8000 })
      window.seed([{ role: 'system', content: 'sys' }, user('big task ' + sized(2000))])
      window.addFact('Objective: ship it.')
      for (let t = 0; t < turns; t++) {
        window.push(asstCalls([`c${t}a`, `c${t}b`]))
        window.push(toolRes(`c${t}a`, sized(300)))
        window.push(toolRes(`c${t}b`, sized(300)))
        window.push(user(`reflection note ${t}`), MESSAGE_KINDS.SCAFFOLD)
        const report = window.build({ taskState: `turn ${t}` })
        assert.ok(report.tokensAfter <= 8000 || report.overflow, `turn ${t} exceeded window`)
        assertValidSequence(report.messages)
      }
      const final = window.build({ taskState: 'final' })
      assert.ok(final.tokensAfter <= 8000, 'final context bounded')
      if (turns >= 20) assert.ok(window.evictedTotal > 0, 'overflowing runs must evict cumulatively')
      assert.strictEqual(final.factsIncluded, 1)
      // Storage itself stays bounded (window + pinned anchor + facts live outside entries).
      assert.ok(window.length <= 201, `entries array bounded, got ${window.length}`)
    })
  }
})

describe('MessageWindow tool-call integrity', () => {
  test('multi-call turn survives a cut without splitting the exchange', () => {
    const window = new MessageWindow({ maxWindowTokens: 700 })
    window.seed([{ role: 'system', content: 's' }, user('go')])
    window.push(asstCalls(['a1', 'a2']))
    window.push(toolRes('a1', sized(200)))
    window.push(toolRes('a2', sized(200)))
    window.push(asst('interim ' + sized(200)))
    window.push(asstCalls(['b1']))
    window.push(toolRes('b1', sized(100)))
    const report = window.build({})
    assert.ok(report.evicted > 0)
    assertValidSequence(report.messages)
    // The newest complete exchange is intact.
    const lastTool = [...report.messages].reverse().find(m => m.role === 'tool')
    assert.strictEqual(lastTool.tool_call_id, 'b1')
  })

  test('failed tools and empty results are retained safely', () => {
    const window = new MessageWindow({ maxWindowTokens: 5000 })
    window.seed([{ role: 'system', content: 's' }, user('go')])
    window.push(asstCalls(['f1', 'e1']))
    window.push({ role: 'tool', tool_call_id: 'f1', content: 'Error: boom [Category: TIMEOUT]' })
    window.push({ role: 'tool', tool_call_id: 'e1', content: '' })
    const report = window.build({})
    assert.strictEqual(report.evicted, 0)
    assertValidSequence(report.messages)
  })

  test('degenerate leading tool result is dropped, never sent first', () => {
    const window = new MessageWindow({ maxWindowTokens: 50000 })
    window.push(toolRes('orphan', 'no call precedes me'))
    window.push(user('hello'))
    window.push(asst('hi'))
    const report = window.build({})
    assert.strictEqual(report.orphansDropped, 1)
    assert.ok(report.messages[0].role !== 'tool')
    assertValidSequence(report.messages)
  })

  test('Anthropic-shaped exchanges keep validity across cuts', () => {
    const window = new MessageWindow({ maxWindowTokens: 600 })
    window.seed([{ role: 'user', content: 'go' }])
    for (let i = 0; i < 5; i++) {
      window.push({ role: 'assistant', content: [{ type: 'text', text: 't' }, { type: 'tool_use', id: `u${i}`, name: 'read', input: {} }] })
      window.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${i}`, content: sized(150) }] })
    }
    const report = window.build({})
    assert.ok(report.evicted > 0)
    assertValidSequence(report.messages)
  })
})

describe('MessageWindow facts and task state', () => {
  test('facts deduplicate, clip, and cap deterministically', () => {
    const window = new MessageWindow({ maxFacts: 3, factChars: 10 })
    assert.strictEqual(window.addFact('  hello  '), true)
    assert.strictEqual(window.addFact('hello'), false)
    assert.strictEqual(window.addFact(''), false)
    assert.strictEqual(window.addFact('0123456789ABCDEF'), true)
    assert.deepStrictEqual(window.facts, ['hello', '0123456789'])
    window.addFact('f3')
    window.addFact('f4')
    assert.strictEqual(window.facts.length, 3)
    assert.strictEqual(window.factsOverflow, 1)
  })

  test('denial-style facts survive repeated compaction', () => {
    const window = new MessageWindow({ maxWindowTokens: 500 })
    window.seed([{ role: 'system', content: 's' }, user('task')])
    window.addFact('User denied run_command; do not retry it without explicit new approval.')
    for (let i = 0; i < 10; i++) {
      window.push(asstCalls([`c${i}`]))
      window.push(toolRes(`c${i}`, sized(150)))
      window.build({})
    }
    const report = window.build({})
    const blob = JSON.stringify(report.messages)
    assert.ok(blob.includes('User denied run_command'))
  })
})

describe('MessageWindow reasoning policy hook', () => {
  const reasoningMsg = () => ({ role: 'assistant', content: 'answer', reasoning_content: 'long chain of thought' })

  test('default policy preserves existing behavior', () => {
    const window = new MessageWindow({ maxWindowTokens: 5000 })
    window.seed([{ role: 'system', content: 's' }])
    window.push(reasoningMsg())
    const report = window.build({})
    const kept = report.messages.find(m => m.content === 'answer')
    assert.strictEqual(kept.reasoning_content, 'long chain of thought')
  })

  test('policy none strips reasoning fields but keeps content and validity', () => {
    const window = new MessageWindow({ maxWindowTokens: 5000, reasoningPolicy: REASONING_POLICIES.NONE })
    window.seed([{ role: 'system', content: 's' }])
    window.push(reasoningMsg())
    window.push(asstCalls(['c1']))
    window.push(toolRes('c1', 'r'))
    const report = window.build({})
    const kept = report.messages.find(m => m.content === 'answer')
    assert.strictEqual(kept.reasoning_content, undefined)
    assertValidSequence(report.messages)
  })

  test('summary_only / preserve_recent / provider_required preserve in Phase 2', () => {
    for (const policy of [REASONING_POLICIES.SUMMARY_ONLY, REASONING_POLICIES.PRESERVE_RECENT, REASONING_POLICIES.PROVIDER_REQUIRED]) {
      const window = new MessageWindow({ maxWindowTokens: 5000, reasoningPolicy: policy })
      window.seed([{ role: 'system', content: 's' }])
      window.push(reasoningMsg())
      const report = window.build({})
      assert.strictEqual(report.messages.find(m => m.content === 'answer').reasoning_content, 'long chain of thought', policy)
    }
  })
})

describe('MessageWindow robustness and determinism', () => {
  test('empty and malformed pushes never crash', () => {
    const window = new MessageWindow({ maxWindowTokens: 1000 })
    assert.strictEqual(window.push(null), null)
    assert.strictEqual(window.push(undefined), null)
    assert.strictEqual(window.push(42), null)
    assert.strictEqual(window.push('just a string'), null)
    const report = window.build({})
    assert.strictEqual(report.droppedMalformed, 4)
    assert.deepStrictEqual(report.messages, [])
  })

  test('same sequence plus same config yields identical builds', () => {
    const drive = () => {
      const window = new MessageWindow({ maxWindowTokens: 900 })
      window.seed([{ role: 'system', content: 's' }, user('task ' + sized(100))])
      window.addFact('fact one')
      for (let i = 0; i < 12; i++) {
        window.push(asstCalls([`c${i}`]))
        window.push(toolRes(`c${i}`, sized(120)))
        window.build({ taskState: `t${i}` })
      }
      return window.build({ taskState: 'end' })
    }
    assert.deepStrictEqual(drive(), drive())
  })

  test('single oversized unit is kept whole with overflow flagged, never emptied', () => {
    const window = new MessageWindow({ maxWindowTokens: 50 })
    window.seed([{ role: 'system', content: 's' }])
    window.push(asst(sized(500)))
    const report = window.build({})
    assert.ok(report.messages.length > 0)
    assert.strictEqual(report.overflow, true)
  })
})

describe('RunLedger window observations (Phase 2)', () => {
  test('window reports accumulate observation-only', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    ledger.recordWindow({ tokensBefore: 1000, tokensAfter: 800, retained: 6, evicted: 4, exchangesRetained: 2, factsIncluded: 1, overflow: false })
    ledger.recordWindow({ tokensBefore: 900, tokensAfter: 850, retained: 7, evicted: 0, exchangesRetained: 2, factsIncluded: 1, overflow: false })
    const w = ledger.getWindow()
    assert.strictEqual(w.builds, 2)
    assert.strictEqual(w.compactions, 1)
    assert.strictEqual(w.evictedMessages, 4)
    assert.strictEqual(w.exchangesRetained, 4)
    assert.strictEqual(w.retainedLast, 7)
    assert.strictEqual(w.tokensAfterLast, 850)
    assert.strictEqual(w.overflowLast, false)
    assert.ok(ledger.snapshot().window.builds === 2)
  })

  test('window observations never affect token totals or enforcement state', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    ledger.recordCall({ model: 'm', inputEst: 100 })
    const before = ledger.getTotals()
    ledger.recordWindow({ tokensBefore: 99999, tokensAfter: 1, retained: 0, evicted: 500, overflow: true })
    const after = ledger.getTotals()
    assert.deepStrictEqual(after, before)
  })
})
