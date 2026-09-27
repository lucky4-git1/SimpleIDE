import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeculativeAnalyzer, ANALYSIS_DIMENSIONS } from '../src/services/agentEngine/SpeculativeAnalyzer.js'
import { DynamicToolSelector } from '../src/services/agentEngine/DynamicToolSelector.js'

test('Phase 15 — SpeculativeAnalyzer: multi-dimensional read-only analysis and synthesis', async () => {
  const analyzer = new SpeculativeAnalyzer(process.cwd())
  const result = await analyzer.analyze('Refactor authentication middleware to use JWT tokens')

  assert.ok(result.findings[ANALYSIS_DIMENSIONS.ARCHITECTURE])
  assert.ok(result.findings[ANALYSIS_DIMENSIONS.SECURITY])
  assert.equal(result.findings[ANALYSIS_DIMENSIONS.SECURITY].isSecuritySensitive, true)
  assert.ok(result.synthesis.includes('[SPECULATIVE ANALYSIS SYNTHESIS]'))
  assert.ok(result.recommendations.length > 0)
})

test('Phase 16 — DynamicToolSelector: filters toolsets dynamically based on task category', () => {
  const mockTools = [
    { name: 'read_file' }, { name: 'edit_file' }, { name: 'apply_patch' }, { name: 'write_file' },
    { name: 'browser_screenshot' }, { name: 'browser_audit' }, { name: 'validate_standalone_html' },
    { name: 'find_definition' }, { name: 'find_references' }, { name: 'query_symbol_graph' },
    { name: 'run_command' }, { name: 'verify' }, { name: 'git_status' }, { name: 'git_commit' },
    { name: 'search_web' }, { name: 'search_documentation' }
  ]

  // 1. UI task -> receives browser tools, no git or symbol graph
  const uiTools = DynamicToolSelector.selectToolsForTask('Adjust CSS padding and responsive layout', mockTools)
  const uiNames = uiTools.map(t => t.name)
  assert.ok(uiNames.includes('browser_screenshot'))
  assert.ok(uiNames.includes('apply_patch'))
  assert.equal(uiNames.includes('git_commit'), false)

  // 2. Auth task -> receives code intelligence & symbol graph
  const authTools = DynamicToolSelector.selectToolsForTask('Fix JWT authentication expiration bug', mockTools)
  const authNames = authTools.map(t => t.name)
  assert.ok(authNames.includes('find_definition'))
  assert.ok(authNames.includes('query_symbol_graph'))
  assert.equal(authNames.includes('browser_screenshot'), false)

  // 3. Research task -> receives search tools
  const researchTools = DynamicToolSelector.selectToolsForTask('Explain how this project handles auth', mockTools)
  const resNames = researchTools.map(t => t.name)
  assert.ok(resNames.includes('search_documentation'))
  assert.equal(resNames.includes('git_commit'), false)
})
