import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { tmpdir } from 'os'
import fs from 'fs'

import { FailureClassifier, FAILURE_CATEGORIES } from '../src/services/agentEngine/FailureClassifier.js'
import { ConsistencyEngine, EVIDENCE_TYPES } from '../src/services/agentEngine/ConsistencyEngine.js'
import { CrashRecoveryService } from '../src/services/agentEngine/CrashRecoveryService.js'
import { VerificationManager } from '../src/services/agentEngine/VerificationManager.js'
import { ToolRunner } from '../src/services/agentEngine/ToolRunner.js'
import { DatabaseManager } from '../electron/database/DatabaseManager.js'

describe('Autonomous Agent Reliability & Consistency Test Suite', () => {

  describe('1. FailureClassifier', () => {
    test('Classifies missing runtime command error', () => {
      const res = FailureClassifier.classify({
        tool: 'run_command',
        command: 'python script.py',
        error: "'python' is not recognized as an internal or external command"
      })
      assert.equal(res.category, FAILURE_CATEGORIES.MISSING_RUNTIME)
      assert.equal(res.retryable, false)
      assert.equal(res.strategy, 'AVOID_RUNTIME_USE_NATIVE_TOOLS')
    })

    test('Classifies path error when file is missing', () => {
      const res = FailureClassifier.classify({
        tool: 'read_file',
        error: 'ENOENT: no such file or directory, open "src/missing.js"'
      })
      assert.equal(res.category, FAILURE_CATEGORIES.PATH_ERROR)
      assert.equal(res.retryable, true)
      assert.equal(res.strategy, 'VERIFY_OR_CREATE_FILE_PATH')
    })

    test('Classifies syntax error in markup or command', () => {
      const res = FailureClassifier.classify({
        tool: 'write_file',
        error: 'Refusing to write an incomplete standalone HTML document: missing <!doctype html>'
      })
      assert.equal(res.category, FAILURE_CATEGORIES.SYNTAX_ERROR)
      assert.equal(res.strategy, 'CORRECT_SYNTAX_OR_FORMAT')
    })

    test('Classifies permission error', () => {
      const res = FailureClassifier.classify({
        tool: 'delete_file',
        error: 'EACCES: permission denied, unlink "C:/protected/file.js"'
      })
      assert.equal(res.category, FAILURE_CATEGORIES.PERMISSION_ERROR)
      assert.equal(res.retryable, false)
    })
  })

  describe('2. ConsistencyEngine & Evidence Verification', () => {
    let consistency

    beforeEach(() => {
      consistency = new ConsistencyEngine('/test/workspace')
    })

    test('Reverts TODO marked complete when required file evidence is missing', () => {
      const todos = [
        { text: 'Create index.html file', status: 'complete' },
        { text: 'Verify layout', status: 'pending' }
      ]

      const reconciled = consistency.validateAndReconcileTodos(todos)
      assert.equal(reconciled[0].status, 'working')
      assert.ok(reconciled[0].note.includes('Reverted'))
    })

    test('Accepts TODO as complete when empirical file evidence exists', () => {
      consistency.recordEvidence(EVIDENCE_TYPES.FILE_CHANGE, 'index.html', { operation: 'write_file' })

      const todos = [
        { text: 'Create index.html file', status: 'complete' }
      ]

      const reconciled = consistency.validateAndReconcileTodos(todos)
      assert.equal(reconciled[0].status, 'complete')
    })

    test('Rejects completion state when mandatory TODO items remain incomplete', () => {
      const todos = [
        { text: 'Build landing page', status: 'working' }
      ]

      const validation = consistency.validateCompletionState({
        todos,
        requiresVerification: false,
        hasVerified: false,
        writtenFiles: []
      })

      assert.equal(validation.valid, false)
      assert.ok(/mandatory TODO items remain incomplete/i.test(validation.issues[0]))
    })
  })

  describe('3. VerificationManager Markup Validation', () => {
    let verifier

    beforeEach(() => {
      verifier = new VerificationManager('/test/workspace', null)
    })

    test('Detects malformed markdown URLs in HTML attributes', () => {
      const invalidHtml = '<img src="[https://picsum.photos/800](https://picsum.photos/800)" alt="Hero">'
      const res = verifier.validateMarkupContent('index.html', invalidHtml)
      assert.equal(res.valid, false)
      assert.ok(res.issues.some(i => i.includes('malformed Markdown URL')))
    })

    test('Detects invalid CSS properties and units', () => {
      const invalidCss = 'body { weight: 700; margin: 12u; }'
      const res = verifier.validateMarkupContent('styles.css', invalidCss)
      assert.equal(res.valid, false)
      assert.ok(res.issues.some(i => i.includes('invalid CSS property "weight"')))
      assert.ok(res.issues.some(i => i.includes('invalid CSS unit "u"')))
    })
  })

  describe('4. ToolRunner & Duplicate Guarding', () => {
    test('Blocks repeated executions after duplicate missing runtime failures', async () => {
      const mockApi = {
        runCommand: async () => ({ success: false, error: "'python' is not recognized as an internal or external command" })
      }
      const runner = new ToolRunner('/test/workspace', { api: mockApi })

      // First run: fails with MISSING_RUNTIME
      const res1 = await runner.run('run_command', { command: 'python script.py' })
      assert.equal(res1.success, false)
      assert.ok(res1.error.includes('MISSING_RUNTIME'))

      // Second run: fails with MISSING_RUNTIME
      const res2 = await runner.run('run_command', { command: 'python script.py' })
      assert.equal(res2.success, false)

      // Third run: blocked by duplicate guard
      const res3 = await runner.run('run_command', { command: 'python script.py' })
      assert.equal(res3.success, false)
      assert.ok(res3.error.includes('blocked: runtime environment is missing'))
    })
  })

  describe('5. CrashRecoveryService', () => {
    let testDbPath
    let dbManager

    beforeEach(() => {
      testDbPath = join(tmpdir(), `test_recovery_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.db`)
      dbManager = new DatabaseManager(testDbPath)
      dbManager.initialize()
    })

    afterEach(() => {
      dbManager.close()
      try {
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath)
      } catch {}
    })

    test('Recovers unfinished run and reconciles disk state', async () => {
      const ws = dbManager.getOrCreateWorkspace('/test/workspace')
      const run = dbManager.createAgentRun({ id: 'run-101', workspaceId: ws.id, userPrompt: 'Build landing page', state: 'EXECUTING' })
      dbManager.savePlanSteps('run-101', [{ id: 'step-1', title: 'Create index.html', status: 'pending' }])
      dbManager.logFileChange({ runId: 'run-101', filePath: '/test/workspace/index.html', afterHash: 'abc123hash' })

      const mockApi = {
        db: {
          getUnfinishedRuns: async () => ({ success: true, runs: [run] }),
          getAgentEvents: async () => ({ success: true, events: [] }),
          getToolExecutions: async () => ({ success: true, executions: [] }),
          getPlanSteps: async () => ({ success: true, steps: [{ id: 'step-1', title: 'Create index.html', status: 'pending' }] }),
          getFileChanges: async () => ({ success: true, changes: [{ file_path: '/test/workspace/index.html' }] }),
          getVerifications: async () => ({ success: true, verifications: [] }),
          logAgentEvent: async () => ({ success: true })
        },
        readFile: async (path) => path.includes('index.html') ? { success: true, content: '<html></html>' } : { success: false }
      }

      const recoveryService = new CrashRecoveryService('/test/workspace', { api: mockApi })
      const recovery = await recoveryService.recoverWorkspaceRuns(ws.id)

      assert.equal(recovery.hasUnfinished, true)
      assert.equal(recovery.status, 'RECONCILED')
      assert.equal(recovery.reconciledSteps[0].status, 'complete')
      assert.equal(recovery.checkpoint.verifiedFiles[0], '/test/workspace/index.html')
    })
  })
})
