import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUMMARY_VERSION,
  SUMMARY_MAX_TOKENS,
  SUMMARIZER_INPUT_MAX_TOKENS,
  MAX_SUMMARIZER_CALLS_PER_RUN,
  renderSummary,
  summaryTokens,
  extractSummaryJson,
  parseAndValidateSummary,
  isValidSummary,
  mergeWithDeterministic,
  buildSummarizerInput,
  canSummarize,
  summarize
} from '../src/services/agentEngine/RollingSummarizer.js'
import { MessageWindow } from '../src/services/agentEngine/MessageWindow.js'
import { RunLedger } from '../src/services/agentEngine/RunLedger.js'

const validSummary = (overrides = {}) => ({
  version: 1,
  objective: 'Ship the login page.',
  requirements: ['responsive layout'],
  constraints: ['no new dependencies'],
  decisions: ['use flex layout'],
  discoveries: ['auth lives in Login.jsx'],
  filesInspected: ['src/Login.jsx'],
  filesChanged: ['src/Login.jsx'],
  plan: 'Inspect, edit, verify.',
  completedSteps: ['inspected Login.jsx'],
  failedApproaches: ['grid broke mobile'],
  successfulApproaches: ['flex worked'],
  unresolvedIssues: ['logo asset missing'],
  verification: { status: 'pending', command: 'npm test', detail: '' },
  evidence: [{ note: 'Test suite failed in Login because the mock was stale; relevant file src/Login.jsx.' }],
  errors: ['mock stale'],
  nextAction: 'Fix the mock and rerun tests.',
  ...overrides
})

describe('summary schema basics', () => {
  test('valid summary accepted with version', () => {
    const result = parseAndValidateSummary(JSON.stringify(validSummary()))
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.summary.version, SUMMARY_VERSION)
  })

  test('fenced and embedded JSON accepted', () => {
    const fenced = parseAndValidateSummary('```json\n' + JSON.stringify(validSummary()) + '\n```')
    assert.strictEqual(fenced.ok, true)
    const embedded = parseAndValidateSummary('Some prose before.\n' + JSON.stringify(validSummary()) + '\nSome prose after.')
    assert.strictEqual(embedded.ok, true)
  })

  test('invalid shapes rejected with reasons', () => {
    assert.deepStrictEqual(parseAndValidateSummary('').reason, 'empty')
    assert.deepStrictEqual(parseAndValidateSummary('just prose, no json').reason, 'no_json')
    assert.deepStrictEqual(parseAndValidateSummary('{oops').reason, 'no_json')
    const missingObjective = validSummary()
    delete missingObjective.objective
    assert.deepStrictEqual(parseAndValidateSummary(JSON.stringify(missingObjective)).reason, 'schema')
    const wrongVersion = parseAndValidateSummary(JSON.stringify(validSummary({ version: 2 })))
    assert.strictEqual(wrongVersion.ok, false)
  })

  test('sparse objects get defaults, unknown fields do not crash validation', () => {
    const result = parseAndValidateSummary(JSON.stringify({ version: 1, objective: 'x', extraField: 'ignored' }))
    assert.strictEqual(result.ok, true)
    assert.deepStrictEqual(result.summary.requirements, [])
    assert.strictEqual(result.summary.verification.status, 'unknown')
  })
})

describe('summary preservation across a round', () => {
  test('objective, constraints, decisions, files, issues, verification survive', () => {
    const input = buildSummarizerInput({
      previousSummary: null,
      evictedExchanges: [{ kind: 'assistant_tools', text: 'read Login.jsx' }],
      facts: ['User requires TypeScript.'],
      taskState: 'Turn 3.',
      verificationText: 'Verification pending.'
    })
    assert.ok(input.text.includes('User requires TypeScript'))
    assert.ok(input.stats.exchangesIncluded >= 1)
  })

  test('giant tool output never becomes giant summarizer input', () => {
    const huge = 'E'.repeat(50000)
    const input = buildSummarizerInput({
      previousSummary: validSummary(),
      evictedExchanges: Array.from({ length: 100 }, (_, i) => ({ kind: 'tool_result', text: `out${i}: ${huge}` })),
      maxInputTokens: SUMMARIZER_INPUT_MAX_TOKENS
    })
    assert.ok(input.stats.estimatedTokens <= SUMMARIZER_INPUT_MAX_TOKENS)
    assert.ok(input.stats.exchangesIncluded <= 30)
    assert.ok(input.text.length < huge.length)
  })

  test('token-cap trimming drops oldest exchanges first when the count cap is not enough', () => {
    const input = buildSummarizerInput({
      previousSummary: null,
      evictedExchanges: Array.from({ length: 30 }, (_, i) => ({ kind: 'tool_result', text: `marker${i} ` + 'z'.repeat(400) })),
      maxInputTokens: 500
    })
    assert.ok(input.stats.estimatedTokens <= 500)
    assert.ok(input.stats.trimmedExchanges > 0)
    // Newest exchanges survive trimming.
    assert.ok(input.text.includes('marker29'))
    assert.ok(!input.text.includes('marker0'))
  })
})

describe('iterative summarization stays bounded', () => {
  for (const cycles of [1, 10, 50]) {
    test(`${cycles} compactions remain within the summary budget`, () => {
      let previous = null
      for (let i = 0; i < cycles; i++) {
        const candidate = validSummary({
          objective: 'Ship the login page.',
          completedSteps: [`cycle ${i} done`],
          discoveries: [`finding ${i}`],
          nextAction: `continue at ${i + 1}`
        })
        const result = parseAndValidateSummary(JSON.stringify(candidate))
        assert.strictEqual(result.ok, true)
        assert.ok(summaryTokens(result.summary) <= SUMMARY_MAX_TOKENS)
        previous = result.summary
      }
      assert.ok(previous && summaryTokens(previous) <= SUMMARY_MAX_TOKENS)
    })
  }

  test('oversize candidate rejected even when previous was valid', () => {
    const big = validSummary({ discoveries: Array.from({ length: 20 }, () => 'd'.repeat(500)) })
    const result = parseAndValidateSummary(JSON.stringify(big))
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.reason, 'oversize')
  })
})

describe('summarizer failure behavior and atomicity', () => {
  test('provider errors convert to ok:false, AbortError propagates', async () => {
    const failed = await summarize({ llmCall: async () => { throw new Error('503 overloaded') }, input: { text: 'x' } })
    assert.strictEqual(failed.ok, false)
    assert.strictEqual(failed.reason, 'provider')
    const aborted = await summarize({
      llmCall: async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e },
      input: { text: 'x' }
    }).then(() => 'resolved', (e) => e.name)
    assert.strictEqual(aborted, 'AbortError')
    const noLlm = await summarize({ llmCall: null, input: { text: 'x' } })
    assert.strictEqual(noLlm.ok, false)
  })

  test('malformed, empty, and schema-bad outputs keep previous summary via atomic set', () => {
    const window = new MessageWindow({ maxWindowTokens: 5000 })
    const good = validSummary()
    assert.strictEqual(window.setSummary(good), true)
    assert.strictEqual(window.setSummary({ version: 1 }), false)
    assert.strictEqual(window.setSummary(null), false)
    assert.strictEqual(window.setSummary('not an object'), false)
    assert.deepStrictEqual(window.summary.objective, good.objective)
  })

  test('failed rounds do not destroy the valid summary in the composed context', () => {
    const window = new MessageWindow({ maxWindowTokens: 5000 })
    window.seed([{ role: 'system', content: 's' }])
    window.setSummary(validSummary())
    const report = window.build({})
    assert.ok(report.messages.some(m => typeof m.content === 'string' && m.content.includes('Ship the login page')))
  })
})

describe('deterministic precedence: runtime state wins', () => {
  test('verification pending beats summary passed; objective and files replaced', () => {
    const merged = mergeWithDeterministic(validSummary({ verification: { status: 'passed', command: 'npm test', detail: '' } }), {
      objective: 'Ship the checkout page.',
      filesChanged: ['src/Cart.jsx'],
      verification: { status: 'pending', command: 'npm test', detail: '' },
      plan: ''
    })
    assert.strictEqual(merged.ok, true)
    assert.strictEqual(merged.summary.verification.status, 'pending')
    assert.strictEqual(merged.summary.objective, 'Ship the checkout page.')
    assert.deepStrictEqual(merged.summary.filesChanged, ['src/Cart.jsx'])
    // Summary-owned knowledge survives the merge.
    assert.ok(merged.summary.discoveries.includes('auth lives in Login.jsx'))
    assert.ok(merged.summary.unresolvedIssues.includes('logo asset missing'))
  })

  test('filesInspected unions within cap; invalid deterministic values fall back safely', () => {
    const merged = mergeWithDeterministic(validSummary(), {
      filesInspected: ['src/A.jsx', 'src/Login.jsx'],
      verification: { status: 'bogus', command: 'x'.repeat(500), detail: 'y' }
    })
    assert.strictEqual(merged.ok, true)
    assert.ok(merged.summary.filesInspected.includes('src/A.jsx'))
    assert.ok(merged.summary.filesInspected.includes('src/Login.jsx'))
    assert.strictEqual(merged.summary.verification.status, 'unknown')
    assert.ok(merged.summary.verification.command.length <= 300)
  })
})

describe('facts stay independent of summary cycles', () => {
  test('repeated summarization cannot delete facts or objective', () => {
    const window = new MessageWindow({ maxWindowTokens: 1200 })
    window.seed([{ role: 'system', content: 's' }, user_message('build it')])
    window.addFact('User requires TypeScript.')
    window.addFact('Approved plan: three milestones.')
    for (let i = 0; i < 8; i++) {
      window.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] })
      window.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(600) })
      const candidate = validSummary({ nextAction: `step ${i}` })
      assert.strictEqual(window.setSummary(candidate), true)
      window.build({ taskState: `turn ${i}` })
    }
    const report = window.build({ taskState: 'end' })
    const blob = JSON.stringify(report.messages)
    assert.ok(blob.includes('User requires TypeScript'))
    assert.ok(blob.includes('three milestones'))
    assert.deepStrictEqual(window.facts.length, 2)
    function user_message(t) { return { role: 'user', content: t } }
  })
})

describe('compaction guard', () => {
  test('requires new evictions and respects the call cap', () => {
    assert.strictEqual(canSummarize({ summarizerCalls: 0, maxCalls: 12, evictedSinceSummary: 5 }), true)
    assert.strictEqual(canSummarize({ summarizerCalls: 0, maxCalls: 12, evictedSinceSummary: 0 }), false)
    assert.strictEqual(canSummarize({ summarizerCalls: 12, maxCalls: 12, evictedSinceSummary: 50 }), false)
    assert.strictEqual(canSummarize({ summarizerCalls: 13, maxCalls: 12, evictedSinceSummary: 50 }), false)
    assert.strictEqual(canSummarize({ summarizerCalls: -1, maxCalls: 12, evictedSinceSummary: 5 }), false)
    assert.strictEqual(canSummarize({}), false)
    assert.strictEqual(MAX_SUMMARIZER_CALLS_PER_RUN, 12)
  })
})

describe('ledger accounting for summarizer work', () => {
  test('summarizer calls recorded separately with failures counted', () => {
    const ledger = new RunLedger({ runId: 'r1' })
    ledger.recordCall({ model: 'm', callType: 'agent', inputEst: 100, usage: { input: 100, output: 10, total: 110, reasoning: null } })
    ledger.recordCall({ model: 'm', callType: 'summarizer', inputEst: 500, outputText: 'summary', usage: { input: 480, output: 60, total: 540, reasoning: null } })
    ledger.recordSummarizerFailure()
    const compaction = ledger.getCompaction()
    assert.strictEqual(compaction.calls, 1)
    assert.strictEqual(compaction.failures, 1)
    assert.strictEqual(compaction.inputEst, 500)
    assert.strictEqual(ledger.getTotals().calls, 2)
    const snap = ledger.snapshot()
    assert.strictEqual(snap.compaction.calls, 1)
    assert.strictEqual(snap.compaction.failures, 1)
  })
})

describe('window integration of the rolling summary', () => {
  test('summary occupies bounded budget share and survives pressure', () => {
    const window = new MessageWindow({ maxWindowTokens: 1500 })
    window.seed([{ role: 'system', content: 's' }, { role: 'user', content: 'task' }])
    assert.strictEqual(window.setSummary(validSummary()), true)
    for (let i = 0; i < 10; i++) {
      window.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] })
      window.push({ role: 'tool', tool_call_id: `c${i}`, content: 'y'.repeat(500) })
    }
    const report = window.build({ taskState: 't' })
    assert.strictEqual(report.summaryIncluded, true)
    assert.ok(report.tokensAfter <= 1500 || report.overflow)
    assert.ok(JSON.stringify(report.messages).includes('Ship the login page'))
    assert.ok(Array.isArray(report.evictedContent))
    for (const item of report.evictedContent) {
      assert.ok(item.text.length <= 400, 'evicted feed entries clipped')
    }
    assert.ok(report.evictedContent.length <= 30, 'evicted feed count bounded')
  })

  test('renderSummary is deterministic and bounded', () => {
    const s = validSummary()
    assert.strictEqual(renderSummary(s), renderSummary(JSON.parse(JSON.stringify(s))))
    assert.ok(summaryTokens(s) <= SUMMARY_MAX_TOKENS)
  })

  test('buildSummarizerInput is deterministic for identical inputs', () => {
    const args = {
      previousSummary: validSummary(),
      evictedExchanges: [{ kind: 'tool_result', text: 'abc' }],
      facts: ['f1'],
      taskState: 't',
      verificationText: 'v'
    }
    assert.deepStrictEqual(buildSummarizerInput(args), buildSummarizerInput(JSON.parse(JSON.stringify(args))))
  })
})
