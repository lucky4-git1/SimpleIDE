import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKPOINT_VERSION,
  MAX_RECENT_MESSAGES,
  buildCheckpointV2,
  migrateCheckpoint,
  restoreIntoWindow,
  takeRecentUnits
} from '../src/services/agentEngine/RunCheckpoint.js'
import { MessageWindow } from '../src/services/agentEngine/MessageWindow.js'
import { RunLedger } from '../src/services/agentEngine/RunLedger.js'

const sized = (n) => 'x'.repeat(Math.ceil(n * 3.8))
const asstCalls = (ids) => ({
  role: 'assistant', content: null,
  tool_calls: ids.map((id, i) => ({ id, type: 'function', function: { name: `tool${i}`, arguments: '{}' } }))
})
const toolRes = (id, text = 'ok') => ({ role: 'tool', tool_call_id: id, content: text })

function assertValidMessages(messages) {
  let callsOpen = false
  let first = true
  for (const m of messages) {
    const isToolLike = m.role === 'tool' ||
      (m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result'))
    if (isToolLike) {
      assert.ok(!first, 'leading tool message')
      assert.ok(callsOpen, 'tool result without preceding tool_calls')
    } else if (m.role === 'assistant' || m.role === 'model') {
      callsOpen = Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    } else {
      callsOpen = false
    }
    first = false
  }
}

const validSummary = () => ({
  version: 1,
  objective: 'Ship the login page.',
  requirements: [],
  constraints: ['no new dependencies'],
  decisions: ['use flex'],
  discoveries: [],
  filesInspected: ['src/Login.jsx'],
  filesChanged: ['src/Login.jsx'],
  plan: '',
  completedSteps: [],
  failedApproaches: [],
  successfulApproaches: [],
  unresolvedIssues: [],
  verification: { status: 'pending', command: 'npm test', detail: '' },
  evidence: [],
  errors: [],
  nextAction: 'continue'
})

function driveWindow(turns, budget = 8000) {
  const window = new MessageWindow({ maxWindowTokens: budget })
  window.seed([{ role: 'system', content: 'sys' }, { role: 'user', content: 'task ' + sized(200) }])
  window.addFact('User requires TypeScript.')
  const ledger = new RunLedger({ runId: 'run-1', model: 'm', contextWindow: 128000 })
  for (let t = 0; t < turns; t++) {
    ledger.advanceTurn()
    window.push(asstCalls([`c${t}`]))
    window.push(toolRes(`c${t}`, sized(200)))
    const report = window.build({ taskState: `turn ${t}` })
    ledger.recordWindow(report)
    ledger.recordCall({ model: 'm', inputEst: 500 + t, usage: { input: 500 + t, output: 20, total: 520 + t, reasoning: null } })
  }
  return { window, ledger }
}

describe('checkpoint v2 schema', () => {
  test('v2 build carries bounded state plus v1 text fields', () => {
    const { window, ledger } = driveWindow(5)
    window.setSummary(validSummary())
    const cp = buildCheckpointV2({
      base: { task: 't', workspace: '/w', approvedPlan: 'p', changedFiles: ['a.js'], observations: ['o'], verification: null, runtimeHistory: [] },
      ledger,
      messageWindow: window,
      meta: { model: 'm', provider: 'nvidia', runId: 'run-1', turns: ledger.turns, maxTurns: 50 }
    })
    assert.strictEqual(cp.version, CHECKPOINT_VERSION)
    assert.strictEqual(cp.task, 't')
    assert.deepStrictEqual(cp.facts, ['User requires TypeScript.'])
    assert.strictEqual(cp.summary.objective, 'Ship the login page.')
    assert.ok(Array.isArray(cp.recentMessages) && cp.recentMessages.length <= MAX_RECENT_MESSAGES)
    assert.ok(cp.ledger && cp.ledger.totals.calls === 5)
    assert.strictEqual(cp.model, 'm')
    assert.ok(typeof cp.savedAt === 'number')
  })

  test('missing summary is explicit null, never manufactured', () => {
    const { window, ledger } = driveWindow(2)
    const cp = buildCheckpointV2({ base: {}, ledger, messageWindow: window, meta: {} })
    assert.strictEqual(cp.summary, null)
    assert.deepStrictEqual(cp.facts, ['User requires TypeScript.'])
  })

  test('invalid inputs fail safely without throwing', () => {
    for (const bad of [null, undefined, 'str', 42, []]) {
      const { checkpoint, warnings } = migrateCheckpoint(bad)
      assert.strictEqual(checkpoint, null)
      assert.ok(warnings.length > 0)
    }
  })

  test('unknown future version keeps known fields and warns', () => {
    const { checkpoint, warnings } = migrateCheckpoint({ version: 99, task: 'hello', futureField: { x: 1 }, ledger: null })
    assert.strictEqual(checkpoint.version, CHECKPOINT_VERSION)
    assert.strictEqual(checkpoint.task, 'hello')
    assert.strictEqual(checkpoint.futureField, undefined)
    assert.ok(warnings.some(w => w.includes('newer')))
  })

  test('missing optional fields default safely', () => {
    const { checkpoint } = migrateCheckpoint({ task: 'only task' })
    assert.strictEqual(checkpoint.task, 'only task')
    assert.strictEqual(checkpoint.summary, null)
    assert.deepStrictEqual(checkpoint.facts, [])
    assert.deepStrictEqual(checkpoint.recentMessages, [])
    assert.strictEqual(checkpoint.ledger, null)
  })
})

describe('v1 and legacy migration', () => {
  test('v1 checkpoint migrates with text preserved and empty bounded state', () => {
    const v1 = {
      version: 1, task: 'old task', workspace: '/w', approvedPlan: 'plan',
      changedFiles: ['f.js'], observations: ['o1'], verification: null, runtimeHistory: [], savedAt: 1
    }
    const { checkpoint, migratedFrom } = migrateCheckpoint(v1)
    assert.strictEqual(migratedFrom, 'v1')
    assert.strictEqual(checkpoint.version, 2)
    assert.strictEqual(checkpoint.task, 'old task')
    assert.strictEqual(checkpoint.summary, null)
    assert.deepStrictEqual(checkpoint.facts, [])
    assert.deepStrictEqual(checkpoint.recentMessages, [])
  })

  test('large legacy transcript migrates bounded with integrity intact', () => {
    const legacy = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }]
    for (let i = 0; i < 150; i++) {
      legacy.push(asstCalls([`c${i}`]))
      legacy.push(toolRes(`c${i}`, sized(150)))
    }
    assert.ok(legacy.length > 300)
    const { checkpoint, warnings } = migrateCheckpoint({ version: 1, task: 't', nativeMessages: legacy })
    assert.ok(checkpoint.recentMessages.length <= MAX_RECENT_MESSAGES)
    assert.ok(checkpoint.recentMessages.length > 0)
    assertValidMessages(checkpoint.recentMessages)
    assert.ok(warnings.some(w => w.includes('legacy transcript')))
    assert.strictEqual(checkpoint.summary, null)
    // Memory: migrated state is small regardless of input transcript size.
    assert.ok(JSON.stringify(checkpoint.recentMessages).length < JSON.stringify(legacy).length / 5)
  })

  test('legacy tool history without summary still resumes', () => {
    const legacy = [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }, asstCalls(['a']), toolRes('a', 'done')]
    const { checkpoint } = migrateCheckpoint({ task: 't', nativeMessages: legacy })
    const window = new MessageWindow({ maxWindowTokens: 8000 })
    const restored = restoreIntoWindow({ window, checkpoint })
    assert.strictEqual(restored.droppedIncomplete, 0)
    const report = window.build({ taskState: 'resumed' })
    assertValidMessages(report.messages)
  })
})

describe('round trip with simulated restart', () => {
  test('checkpoint, serialize, migrate, restore preserves bounded state', () => {
    const { window, ledger } = driveWindow(25)
    window.setSummary(validSummary())
    const cp = buildCheckpointV2({
      base: { task: 't', workspace: '/w', approvedPlan: '', changedFiles: [], observations: [], verification: null, runtimeHistory: [] },
      ledger, messageWindow: window, meta: { model: 'm', provider: 'p', runId: 'run-1', turns: 25, maxTurns: 50 }
    })
    const reloaded = JSON.parse(JSON.stringify(cp))
    const { checkpoint: migrated, warnings } = migrateCheckpoint(reloaded)
    assert.deepStrictEqual(warnings.filter(w => w.includes('legacy') || w.includes('malformed')), [])
    const fresh = new MessageWindow({ maxWindowTokens: 8000 })
    const restored = restoreIntoWindow({ window: fresh, checkpoint: migrated })
    assert.ok(restored.restoredMessages > 0)
    const freshLedger = new RunLedger({ runId: 'run-2', model: 'm', contextWindow: 128000 })
    assert.strictEqual(freshLedger.restore(migrated.ledger), true)
    assert.strictEqual(freshLedger.getTotals().calls, 25)
    assert.deepStrictEqual(fresh.facts, ['User requires TypeScript.'])
    assert.strictEqual(fresh.summary.objective, 'Ship the login page.')
    const report = fresh.build({ taskState: 'resumed turn' })
    assertValidMessages(report.messages)
    assert.ok(report.tokensAfter <= 8000 || report.overflow)
  })
})

describe('tool exchange resume cases', () => {
  test('A. checkpoint before any tool call resumes cleanly', () => {
    const window = new MessageWindow({ maxWindowTokens: 8000 })
    const { checkpoint } = migrateCheckpoint({ task: 't', recentMessages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }] })
    const restored = restoreIntoWindow({ window, checkpoint })
    assert.strictEqual(restored.droppedIncomplete, 0)
    assertValidMessages(window.build({}).messages.filter(m => m.role !== 'user' || !String(m.content).includes('TASK STATE')))
  })

  test('B. trailing unanswered tool call is dropped explicitly, not sent', () => {
    const window = new MessageWindow({ maxWindowTokens: 8000 })
    const { checkpoint } = migrateCheckpoint({
      task: 't',
      recentMessages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }, asstCalls(['dangling'])]
    })
    const restored = restoreIntoWindow({ window, checkpoint })
    assert.strictEqual(restored.droppedIncomplete, 1)
    assert.ok(restored.warnings.some(w => w.includes('incomplete')))
    assertValidMessages(window.build({}).messages)
  })

  test('C. complete exchange restores intact', () => {
    const window = new MessageWindow({ maxWindowTokens: 8000 })
    const { checkpoint } = migrateCheckpoint({
      task: 't',
      recentMessages: [{ role: 'system', content: 's' }, asstCalls(['c']), toolRes('c', 'out')]
    })
    const restored = restoreIntoWindow({ window, checkpoint })
    assert.strictEqual(restored.droppedIncomplete, 0)
    assert.strictEqual(restored.restoredMessages, 3)
  })

  test('D. multiple exchanges restore in order', () => {
    const window = new MessageWindow({ maxWindowTokens: 8000 })
    const msgs = [{ role: 'system', content: 's' }]
    for (let i = 0; i < 4; i++) { msgs.push(asstCalls([`c${i}`])); msgs.push(toolRes(`c${i}`, `r${i}`)) }
    const { checkpoint } = migrateCheckpoint({ task: 't', recentMessages: msgs })
    restoreIntoWindow({ window, checkpoint })
    const report = window.build({})
    assertValidMessages(report.messages)
    assert.ok(JSON.stringify(report.messages).includes('r3'))
  })

  test('E. failed tool execution restores as ordinary evidence', () => {
    const window = new MessageWindow({ maxWindowTokens: 8000 })
    const { checkpoint } = migrateCheckpoint({
      task: 't',
      recentMessages: [{ role: 'system', content: 's' }, asstCalls(['f']), { role: 'tool', tool_call_id: 'f', content: 'Error: boom' }]
    })
    const restored = restoreIntoWindow({ window, checkpoint })
    assert.strictEqual(restored.droppedIncomplete, 0)
    assert.ok(JSON.stringify(window.build({}).messages).includes('Error: boom'))
  })
})

describe('model switch across resume', () => {
  test('A -> checkpoint -> restart -> A continues ledger and stays valid', () => {
    const ledger = new RunLedger({ runId: 'r1', model: 'A', contextWindow: 128000 })
    ledger.recordCall({ model: 'A', inputEst: 100, usage: { input: 100, output: 10, total: 110, reasoning: null } })
    const resumed = new RunLedger({ runId: 'r2', model: 'A', contextWindow: 128000 })
    assert.strictEqual(resumed.restore(ledger.snapshot()), true)
    resumed.recordCall({ model: 'A', inputEst: 50, usage: { input: 50, output: 5, total: 55, reasoning: null } })
    assert.strictEqual(resumed.getTotals().inputActual, 150)
    assert.strictEqual(resumed.getSegments().length, 1)
  })

  test('A -> checkpoint -> switch to B continues cleanly', () => {
    const ledger = new RunLedger({ runId: 'r1', model: 'A', contextWindow: 128000 })
    ledger.recordCall({ model: 'A', inputEst: 100, usage: { input: 100, output: 10, total: 110, reasoning: null } })
    const resumed = new RunLedger({ runId: 'r2', model: 'B', contextWindow: 262144 })
    resumed.restore(ledger.snapshot())
    resumed.recordCall({ model: 'B', inputEst: 200, usage: { input: 200, output: 20, total: 220, reasoning: null } })
    assert.strictEqual(resumed.getSegments().length, 2)
    assert.strictEqual(resumed.getTotals().inputActual, 300)
  })

  test('A -> B -> checkpoint -> restart -> A keeps all segments and validity', () => {
    const window = new MessageWindow({ maxWindowTokens: 8000 })
    window.seed([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }])
    window.push(asstCalls(['c1']))
    window.push(toolRes('c1', 'r1'))
    const ledger = new RunLedger({ runId: 'r1', model: 'A', contextWindow: 128000 })
    ledger.recordCall({ model: 'A', inputEst: 10, usage: { input: 10, output: 1, total: 11, reasoning: null } })
    ledger.recordCall({ model: 'B', inputEst: 20, usage: { input: 20, output: 2, total: 22, reasoning: null } })
    const cp = buildCheckpointV2({ base: {}, ledger, messageWindow: window, meta: { model: 'B', runId: 'r1', turns: 2, maxTurns: 50 } })
    const reloaded = JSON.parse(JSON.stringify(cp))
    const { checkpoint } = migrateCheckpoint(reloaded)
    const fresh = new MessageWindow({ maxWindowTokens: 8000 })
    restoreIntoWindow({ window: fresh, checkpoint })
    const resumedLedger = new RunLedger({ runId: 'r2', model: 'A', contextWindow: 128000 })
    resumedLedger.restore(checkpoint.ledger)
    resumedLedger.recordCall({ model: 'A', inputEst: 5, usage: { input: 5, output: 1, total: 6, reasoning: null } })
    assert.strictEqual(resumedLedger.getSegments().length, 2)
    assert.strictEqual(resumedLedger.getTotals().calls, 3)
    assertValidMessages(fresh.build({ taskState: 'resumed' }).messages)
  })
})

describe('long run round trip stays bounded', () => {
  test('50+ turns, compaction, summary, checkpoint, restart, 50+ more turns', () => {
    const first = driveWindow(55)
    first.window.setSummary(validSummary())
    const cp = buildCheckpointV2({
      base: { task: 't', workspace: '/w', approvedPlan: '', changedFiles: [], observations: [], verification: null, runtimeHistory: [] },
      ledger: first.ledger, messageWindow: first.window,
      meta: { model: 'm', provider: 'p', runId: 'run-1', turns: 55, maxTurns: 100 }
    })
    const sizeBefore = JSON.stringify(cp).length
    const reloaded = JSON.parse(JSON.stringify(cp))
    const { checkpoint } = migrateCheckpoint(reloaded)
    const fresh = new MessageWindow({ maxWindowTokens: 8000 })
    const restored = restoreIntoWindow({ window: fresh, checkpoint })
    assert.ok(restored.restoredMessages > 0)
    const resumedLedger = new RunLedger({ runId: 'run-2', model: 'm', contextWindow: 128000 })
    assert.strictEqual(resumedLedger.restore(checkpoint.ledger), true)
    for (let t = 0; t < 55; t++) {
      resumedLedger.advanceTurn()
      fresh.push(asstCalls([`n${t}`]))
      fresh.push(toolRes(`n${t}`, sized(200)))
      const report = fresh.build({ taskState: `resumed ${t}` })
      resumedLedger.recordWindow(report)
      resumedLedger.recordCall({ model: 'm', inputEst: 400, usage: { input: 400, output: 15, total: 415, reasoning: null } })
      assert.ok(report.tokensAfter <= 8000 || report.overflow)
      assertValidMessages(report.messages)
    }
    const final = fresh.build({ taskState: 'end' })
    // Single summary instance: no duplicate accumulation across resume.
    const summaries = final.messages.filter(m => typeof m.content === 'string' && m.content.includes('ROLLING SUMMARY')).length
    assert.strictEqual(summaries, 1)
    assert.deepStrictEqual(fresh.facts, ['User requires TypeScript.'])
    assert.strictEqual(fresh.summary.objective, 'Ship the login page.')
    const totals = resumedLedger.getTotals()
    assert.strictEqual(totals.calls, 110)
    assert.ok(totals.inputActual > first.ledger.getTotals().inputActual)
    assert.strictEqual(sizeBefore, JSON.stringify(buildCheckpointV2({
      base: { task: 't', workspace: '/w', approvedPlan: '', changedFiles: [], observations: [], verification: null, runtimeHistory: [] },
      ledger: first.ledger, messageWindow: first.window,
      meta: { model: 'm', provider: 'p', runId: 'run-1', turns: 55, maxTurns: 100 }
    })).length)
  })
})

describe('checkpoint size is transcript-independent', () => {
  test('20-turn and 100-turn histories yield similarly sized checkpoints', () => {
    const sizes = []
    for (const turns of [20, 100]) {
      const { window, ledger } = driveWindow(turns)
      window.setSummary(validSummary())
      const cp = buildCheckpointV2({
        base: { task: 't', workspace: '/w', approvedPlan: '', changedFiles: [], observations: [], verification: null, runtimeHistory: [] },
        ledger, messageWindow: window, meta: { model: 'm', runId: 'r', turns, maxTurns: 100 }
      })
      sizes.push(JSON.stringify(cp).length)
    }
    assert.ok(sizes[0] < 96 * 1024 && sizes[1] < 96 * 1024)
    assert.ok(sizes[1] / sizes[0] < 3, `100-turn checkpoint (${sizes[1]}) must not dwarf 20-turn (${sizes[0]})`)
  })
})

describe('corruption handling', () => {
  test('bad summary version and malformed facts fail safe', () => {
    const { checkpoint, warnings } = migrateCheckpoint({
      task: 't',
      summary: { version: 99, objective: 'x' },
      facts: ['ok fact', 42, null, '   ', { x: 1 }],
      ledger: { bogus: true }
    })
    assert.strictEqual(checkpoint.summary, null)
    assert.deepStrictEqual(checkpoint.facts, ['ok fact'])
    assert.strictEqual(checkpoint.ledger, null)
    assert.ok(warnings.length >= 2)
  })

  test('missing task and partial checkpoints still migrate', () => {
    const { checkpoint } = migrateCheckpoint({ observations: ['o'] })
    assert.strictEqual(checkpoint.task, '')
    assert.deepStrictEqual(checkpoint.observations, ['o'])
    assert.strictEqual(checkpoint.summary, null)
  })

  test('restore with nothing valid reports instead of crashing', () => {
    const window = new MessageWindow({ maxWindowTokens: 8000 })
    assert.deepStrictEqual(restoreIntoWindow({ window: null, checkpoint: null }).warnings, ['nothing to restore'])
    const empty = restoreIntoWindow({ window, checkpoint: { facts: [], summary: null, recentMessages: [] } })
    assert.strictEqual(empty.restoredMessages, 0)
    assert.strictEqual(empty.droppedIncomplete, 0)
  })

  test('malformed recentMessages array entries are skipped', () => {
    const window = new MessageWindow({ maxWindowTokens: 8000 })
    const { checkpoint } = migrateCheckpoint({ task: 't', recentMessages: [null, 'str', 42, { role: 'user', content: 'hi' }] })
    const restored = restoreIntoWindow({ window, checkpoint })
    assert.strictEqual(restored.restoredMessages, 1)
    assertValidMessages(window.build({}).messages)
  })
})

describe('takeRecentUnits boundaries', () => {
  test('takes newest units within count and drops leading orphans', () => {
    const entries = []
    for (let i = 0; i < 5; i++) {
      entries.push({ msg: asstCalls([`c${i}`]), kind: 'assistant_tools', tokens: 10 })
      entries.push({ msg: toolRes(`c${i}`), kind: 'tool_result', tokens: 10 })
    }
    const recent = takeRecentUnits(entries, 4)
    assert.strictEqual(recent.length, 4)
    assertValidMessages([{ role: 'system', content: 's' }, ...recent])
    assert.deepStrictEqual(takeRecentUnits([], 4), [])
    assert.deepStrictEqual(takeRecentUnits(null, 4), [])
  })
})
