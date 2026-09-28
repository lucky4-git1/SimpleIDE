import test from 'node:test'
import assert from 'node:assert/strict'
import { AdaptiveContextWindow, CurrentAttention, AGENT_STAGES } from '../src/services/agentEngine/AdaptiveContextWindow.js'
import { PromptPrefixCacheManager } from '../src/services/agentEngine/PromptPrefixCacheManager.js'
import { AgentMemoryHierarchy } from '../src/services/agentEngine/AgentMemoryHierarchy.js'

test('Phase 17 & 19 — AdaptiveContextWindow & CurrentAttention: formats stage-specific context', () => {
  const attention = new CurrentAttention({
    currentTask: 'Fix token expiration',
    currentFile: 'src/auth.ts',
    currentSymbol: 'generateToken',
    relevantCallers: ['loginController', 'authMiddleware']
  })

  // Format attention
  const formatted = attention.format()
  assert.ok(formatted.includes('[CURRENT ATTENTION WINDOW]'))
  assert.ok(formatted.includes('Active File: src/auth.ts'))
  assert.ok(formatted.includes('generateToken'))

  // Implementation stage
  const implCtx = AdaptiveContextWindow.buildContext(AGENT_STAGES.IMPLEMENTATION, {
    attention,
    symbolOverview: { name: 'generateToken', definition: 'export function generateToken(user: User): string' }
  })
  assert.ok(implCtx.includes('[STAGE: IMPLEMENTATION]'))
  assert.ok(implCtx.includes('export function generateToken'))

  // Verification stage
  const verifCtx = AdaptiveContextWindow.buildContext(AGENT_STAGES.VERIFICATION, {
    attention,
    changedFiles: ['src/auth.ts', 'tests/auth.test.ts'],
    testResults: '✓ 12 tests passed'
  })
  assert.ok(verifCtx.includes('[STAGE: VERIFICATION]'))
  assert.ok(verifCtx.includes('Modified Files (2): src/auth.ts, tests/auth.test.ts'))
  assert.ok(verifCtx.includes('✓ 12 tests passed'))
})

test('Phase 18 — PromptPrefixCacheManager: prepares cached prefixes and tracks hit rate', () => {
  const cacheMgr = new PromptPrefixCacheManager()

  const systemPrompt = 'You are Prime AI Agent V3.'
  const toolDefs = [{ name: 'read_file' }, { name: 'edit_file' }]

  // 1. Initial call (cache miss)
  const res1 = cacheMgr.prepareCachedPrefix('anthropic', {
    systemPrompt,
    toolDefinitions: toolDefs
  })
  assert.equal(res1.isHit, false)
  assert.equal(res1.system[0].cache_control.type, 'ephemeral')

  // 2. Identical prefix call (cache hit)
  const res2 = cacheMgr.prepareCachedPrefix('anthropic', {
    systemPrompt,
    toolDefinitions: toolDefs
  })
  assert.equal(res2.isHit, true)

  const metrics = cacheMgr.getMetrics()
  assert.equal(metrics.cacheHits, 1)
  assert.equal(metrics.cacheMisses, 1)
  assert.equal(metrics.cacheHitRate, 0.5)
  assert.ok(metrics.tokensSaved > 0)
})

test('Phase 20 — AgentMemoryHierarchy: manages 5 distinct memory tiers independently', () => {
  const mem = new AgentMemoryHierarchy('task-101', process.cwd(), {
    preferences: { autoApprove: true, theme: 'dark' }
  })

  // Tier 1: Immediate
  mem.setImmediate('Current turn: reading auth.ts')
  assert.equal(mem.getImmediate(), 'Current turn: reading auth.ts')
  mem.clearImmediate()
  assert.equal(mem.getImmediate(), null)

  // Tier 2: Working
  mem.setWorking('scratch_var', 42)
  assert.equal(mem.getWorking('scratch_var'), 42)

  // Tier 3: Run
  mem.recordStep({ action: 'edit_file', path: 'src/auth.ts' })
  mem.recordFileChange('src/auth.ts')
  const runSummary = mem.getRunSummary()
  assert.equal(runSummary.stepsCount, 1)
  assert.ok(runSummary.filesChanged.includes('src/auth.ts'))

  // Tier 4: Project
  mem.addProjectFact('Uses Vite build runner')
  assert.ok(mem.getProjectFacts().includes('Uses Vite build runner'))

  // Tier 5: Preferences
  assert.equal(mem.getPreference('theme'), 'dark')

  const snap = mem.snapshot()
  assert.equal(snap.tier3_run.stepsCount, 1)
  assert.equal(snap.tier4_projectFactsCount, 1)
})
