import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { tmpdir } from 'os'
import fs from 'fs'
import { DatabaseManager } from '../electron/database/DatabaseManager.js'

describe('DatabaseManager — SQLite Foundation & Agent Persistence Test Suite', () => {
  let dbManager
  let testDbPath

  beforeEach(() => {
    testDbPath = join(tmpdir(), `test_simple_ide_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.db`)
    dbManager = new DatabaseManager(testDbPath)
    dbManager.initialize()
  })

  afterEach(() => {
    dbManager.close()
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath)
      if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`)
      if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`)
    } catch { /* cleanup */ }
  })

  test('1. Database initializes with WAL mode, foreign keys, and migrations', () => {
    const health = dbManager.integrityCheck()
    assert.equal(health.healthy, true)

    const stats = dbManager.getStats()
    assert.equal(stats.healthy, true)
    assert.equal(stats.counts.workspaces, 0)
    assert.equal(stats.counts.conversations, 0)
  })

  test('2. Workspace normalization and isolation', () => {
    const ws1 = dbManager.getOrCreateWorkspace('C:\\Users\\test\\ProjectA\\', 'Project A')
    assert.ok(ws1.id)
    assert.equal(ws1.root_path, 'c:/users/test/projecta')

    // Same path normalized returns existing record
    const ws2 = dbManager.getOrCreateWorkspace('c:/users/test/projecta')
    assert.equal(ws2.id, ws1.id)

    // Different workspace
    const ws3 = dbManager.getOrCreateWorkspace('/home/user/projectB', 'Project B')
    assert.notEqual(ws3.id, ws1.id)
    assert.equal(ws3.root_path, '/home/user/projectb')
  })

  test('3. Conversation and message persistence', () => {
    const ws = dbManager.getOrCreateWorkspace('/test/workspace')
    const conv = dbManager.createConversation({ workspaceId: ws.id, title: 'Build Feature' })

    assert.equal(conv.workspace_id, ws.id)
    assert.equal(conv.title, 'Build Feature')

    const msg1 = dbManager.saveMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'Add dark mode support'
    })

    const msg2 = dbManager.saveMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'I will create dark mode CSS tokens.',
      metadata: { apiKey: 'sk-123456789012345678901234' } // verify secret redaction
    })

    const messages = dbManager.getMessages(conv.id)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].content, 'Add dark mode support')
    assert.ok(messages[1].metadata_json.includes('[REDACTED]'))
    assert.equal(messages[1].metadata_json.includes('sk-123456'), false)

    dbManager.replaceMessages(conv.id, [
      { role: 'user', content: 'Keep the complete conversation.' },
      { role: 'assistant', content: 'This full snapshot survives restart.', metadata: { token: 'private-value' } }
    ])
    const restored = dbManager.getMessages(conv.id)
    assert.equal(restored.length, 2)
    assert.equal(restored[0].content, 'Keep the complete conversation.')
    assert.equal(restored[1].content, 'This full snapshot survives restart.')
    assert.ok(restored[1].metadata_json.includes('[REDACTED]'))
  })

  test('4. Agent run state transitions and recovery queries', () => {
    const ws = dbManager.getOrCreateWorkspace('/test/workspace')
    const conv = dbManager.createConversation({ workspaceId: ws.id, title: 'Agent Chat' })

    const run = dbManager.createAgentRun({
      workspaceId: ws.id,
      conversationId: conv.id,
      userPrompt: 'Refactor auth service',
      state: 'PLANNING'
    })

    assert.equal(run.state, 'PLANNING')

    dbManager.updateAgentRunState(run.id, 'EXECUTING')
    let currentRun = dbManager.getAgentRun(run.id)
    assert.equal(currentRun.state, 'EXECUTING')
    assert.equal(currentRun.completed_at, null)

    const unfinished = dbManager.getUnfinishedAgentRuns(ws.id)
    assert.equal(unfinished.length, 1)
    assert.equal(unfinished[0].id, run.id)

    dbManager.updateAgentRunState(run.id, 'COMPLETED')
    currentRun = dbManager.getAgentRun(run.id)
    assert.equal(currentRun.state, 'COMPLETED')
    assert.ok(currentRun.completed_at > 0)

    const unfinishedAfter = dbManager.getUnfinishedAgentRuns(ws.id)
    assert.equal(unfinishedAfter.length, 0)
  })

  test('5. Agent events append-only log with sequence uniqueness', () => {
    const ws = dbManager.getOrCreateWorkspace('/test/workspace')
    const run = dbManager.createAgentRun({ workspaceId: ws.id, userPrompt: 'Fix bug' })

    const evt1 = dbManager.logAgentEvent({ runId: run.id, type: 'RUN_STARTED', sequence: 1 })
    const evt2 = dbManager.logAgentEvent({ runId: run.id, type: 'PLAN_CREATED', payload: { steps: 3 }, sequence: 2 })

    const events = dbManager.getAgentEvents(run.id)
    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'RUN_STARTED')
    assert.equal(events[1].type, 'PLAN_CREATED')

    // Duplicate sequence should throw unique constraint error
    assert.throws(() => {
      dbManager.logAgentEvent({ runId: run.id, type: 'DUPLICATE', sequence: 1 })
    })
  })

  test('6. Tool execution logging and secret redaction', () => {
    const ws = dbManager.getOrCreateWorkspace('/test/workspace')
    const run = dbManager.createAgentRun({ workspaceId: ws.id, userPrompt: 'Tool test' })

    const exec = dbManager.logToolExecution({
      runId: run.id,
      toolName: 'read_file',
      arguments: { path: '/test/config.json', secretKey: 'super-secret-pass' },
      status: 'running'
    })

    dbManager.updateToolExecution(exec.id, {
      result: { content: 'hello world', token: 'bearer xyz123' },
      status: 'success'
    })

    const executions = dbManager.getToolExecutions(run.id)
    assert.equal(executions.length, 1)
    assert.equal(executions[0].status, 'success')
    assert.ok(executions[0].arguments_json.includes('[REDACTED]'))
    assert.equal(executions[0].arguments_json.includes('super-secret-pass'), false)
  })

  test('7. Task and Plan Steps persistence', () => {
    const ws = dbManager.getOrCreateWorkspace('/test/workspace')
    const run = dbManager.createAgentRun({ workspaceId: ws.id, userPrompt: 'Add features' })

    const task = dbManager.saveTask({
      workspaceId: ws.id,
      runId: run.id,
      title: 'Update Settings UI',
      status: 'working'
    })
    assert.equal(task.title, 'Update Settings UI')

    const steps = dbManager.savePlanSteps(run.id, [
      { title: 'Inspect CSS', status: 'completed' },
      { title: 'Add dark mode toggle', status: 'pending' }
    ])

    assert.equal(steps.length, 2)
    assert.equal(steps[0].sequence, 1)
    assert.equal(steps[1].title, 'Add dark mode toggle')

    const retrievedSteps = dbManager.getPlanSteps(run.id)
    assert.equal(retrievedSteps.length, 2)
  })

  test('8. File changes and verification results logging', () => {
    const ws = dbManager.getOrCreateWorkspace('/test/workspace')
    const run = dbManager.createAgentRun({ workspaceId: ws.id, userPrompt: 'Refactor code' })

    dbManager.logFileChange({
      runId: run.id,
      filePath: '/test/src/App.jsx',
      beforeHash: 'abc1',
      afterHash: 'xyz2',
      beforeContent: 'const a = 1;',
      afterContent: 'const a = 2;'
    })

    dbManager.logVerificationResult({
      runId: run.id,
      command: 'npm test',
      status: 'passed',
      exitCode: 0,
      stdout: 'All tests passed',
      durationMs: 1200
    })

    const changes = dbManager.getFileChanges(run.id)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].file_path, '/test/src/App.jsx')

    const verifications = dbManager.getVerificationResults(run.id)
    assert.equal(verifications.length, 1)
    assert.equal(verifications[0].command, 'npm test')
    assert.equal(verifications[0].status, 'passed')
  })

  test('9. Project memory confidence score bound validation (0.0 to 1.0)', () => {
    const ws = dbManager.getOrCreateWorkspace('/test/workspace')

    const mem1 = dbManager.saveProjectMemory({
      workspaceId: ws.id,
      category: 'architecture',
      memoryKey: 'state_manager',
      value: 'Zustand',
      confidence: 0.9
    })

    assert.equal(mem1.confidence, 0.9)

    // Higher confidence updates existing
    const mem2 = dbManager.saveProjectMemory({
      workspaceId: ws.id,
      category: 'architecture',
      memoryKey: 'state_manager',
      value: 'Zustand v5',
      confidence: 0.95
    })
    assert.equal(mem2.value, 'Zustand v5')

    // Lower confidence is ignored
    const mem3 = dbManager.saveProjectMemory({
      workspaceId: ws.id,
      category: 'architecture',
      memoryKey: 'state_manager',
      value: 'Redux',
      confidence: 0.4
    })
    assert.equal(mem3.value, 'Zustand v5')

    const search = dbManager.searchProjectMemory(ws.id, 'architecture', 0.5)
    assert.equal(search.length, 1)
    assert.equal(search[0].value, 'Zustand v5')
  })

  test('10. Workspace state persistence', () => {
    const ws = dbManager.getOrCreateWorkspace('/test/workspace')

    const state = {
      activeFile: '/test/src/index.js',
      openTabs: ['/test/src/index.js', '/test/src/App.js'],
      expandedFolders: ['/test/src']
    }

    dbManager.saveWorkspaceState(ws.id, state)
    const loaded = dbManager.getWorkspaceState(ws.id)

    assert.deepEqual(loaded, state)
  })

  test('11. Database transaction rollback on error', () => {
    const ws = dbManager.getOrCreateWorkspace('/test/workspace')

    assert.throws(() => {
      dbManager.transaction(() => {
        dbManager.createConversation({ workspaceId: ws.id, title: 'Valid Conv' })
        throw new Error('Simulated failure during transaction')
      })
    })

    const conversations = dbManager.listConversations(ws.id)
    assert.equal(conversations.length, 0)
  })
})
