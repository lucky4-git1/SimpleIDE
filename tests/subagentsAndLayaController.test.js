import test from 'node:test'
import assert from 'node:assert/strict'
import { SubagentManager, SubagentWorker, SUBAGENT_ROLES } from '../src/services/agentEngine/SubagentManager.js'
import { layaSubagentController } from '../src/services/agentEngine/LayaSubagentController.js'

test('Phase 10 — SubagentWorker: enforces strict read-only policy and blocks write tools', async () => {
  const worker = new SubagentWorker(SUBAGENT_ROLES.CODE_SCANNER, process.cwd())

  // Read-only tools allowed
  assert.equal(worker.isToolAllowed('read_file'), true)
  assert.equal(worker.isToolAllowed('find_definition'), true)
  assert.equal(worker.isToolAllowed('search_files'), true)

  // Write tools strictly prohibited
  assert.equal(worker.isToolAllowed('write_file'), false)
  assert.equal(worker.isToolAllowed('edit_file'), false)
  assert.equal(worker.isToolAllowed('delete_file'), false)
  assert.equal(worker.isToolAllowed('apply_patch'), false)

  await assert.rejects(
    () => worker.runSafeTool('write_file', { path: 'malicious.js', content: 'hack' }),
    /Security policy violation: Subagent .* is restricted to read-only tools/
  )
})

test('Phase 10 — SubagentManager: executes parallel read-only workers concurrently with bounded results', async () => {
  const manager = new SubagentManager(process.cwd())

  const results = await manager.runParallel(
    [SUBAGENT_ROLES.CODE_SCANNER, SUBAGENT_ROLES.TEST_ANALYZER],
    'Investigate authentication token validation'
  )

  assert.equal(results.length, 2)
  assert.equal(results[0].status, 'complete')
  assert.equal(results[1].status, 'complete')
  assert.ok(results[0].findings.length > 0)
  assert.ok(results[0].findings.length <= 2000, 'Findings must remain strictly bounded')
})

test('Phase 11 — LayaSubagentController: skips delegation on trivial tasks and delegates on complex investigations', () => {
  // 1. Trivial tasks -> no workers
  const trivial1 = layaSubagentController.decideDelegation('Rename variable x to y')
  assert.equal(trivial1.shouldDelegate, false)
  assert.equal(trivial1.workers.length, 0)

  const trivial2 = layaSubagentController.decideDelegation('Fix typo in comment')
  assert.equal(trivial2.shouldDelegate, false)

  // 2. Complex investigations -> spawns targeted workers
  const complex1 = layaSubagentController.decideDelegation('Analyze why authentication fails across the application')
  assert.equal(complex1.shouldDelegate, true)
  assert.ok(complex1.workers.includes(SUBAGENT_ROLES.CODE_SCANNER))

  const complexTest = layaSubagentController.decideDelegation('Investigate why tests are failing in auth test suite')
  assert.equal(complexTest.shouldDelegate, true)
  assert.ok(complexTest.workers.includes(SUBAGENT_ROLES.TEST_ANALYZER))
})
