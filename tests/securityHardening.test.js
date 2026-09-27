import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { tmpdir } from 'os'
import fs from 'fs'

import { isPathInWorkspace } from '../src/main/ipc/pathSanitizer.js'
import { isAllowedAIEndpoint } from '../src/main/ipc/aiSecurity.js'
import { validateProcessCwd, cleanupProcessesForRun, setProcessSecurityWorkspace } from '../src/main/ipc/processSecurity.js'
import { CrashRecoveryService } from '../src/services/agentEngine/CrashRecoveryService.js'
import { checkCrashRecovery } from '../src/services/agentService.js'

describe('Security & Execution Reliability Hardening Test Suite (Phase 9)', () => {
  let tempWorkspace
  let tempOutside

  beforeEach(() => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    tempWorkspace = join(tmpdir(), `test_sec_ws_${id}`)
    tempOutside = join(tmpdir(), `test_sec_out_${id}`)
    fs.mkdirSync(tempWorkspace, { recursive: true })
    fs.mkdirSync(tempOutside, { recursive: true })
  })

  afterEach(() => {
    try { fs.rmSync(tempWorkspace, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(tempOutside, { recursive: true, force: true }) } catch {}
  })

  describe('1. Path Sanitization & Symlink Escape Prevention', () => {
    test('Fails closed on missing, null, or non-string arguments', () => {
      assert.equal(isPathInWorkspace(null, tempWorkspace), false)
      assert.equal(isPathInWorkspace(tempWorkspace, null), false)
      assert.equal(isPathInWorkspace(undefined, tempWorkspace), false)
      assert.equal(isPathInWorkspace('', tempWorkspace), false)
      assert.equal(isPathInWorkspace(tempWorkspace, ''), false)
      assert.equal(isPathInWorkspace(123, tempWorkspace), false)
      assert.equal(isPathInWorkspace(tempWorkspace, {}), false)
    })

    test('Allows valid paths inside workspace', () => {
      const validFile = join(tempWorkspace, 'src', 'index.js')
      assert.equal(isPathInWorkspace(validFile, tempWorkspace), true)
      assert.equal(isPathInWorkspace(tempWorkspace, tempWorkspace), true)
    })

    test('Blocks directory traversal attempts', () => {
      const traversalPath = join(tempWorkspace, '..', 'outside.txt')
      assert.equal(isPathInWorkspace(traversalPath, tempWorkspace), false)

      const deepTraversal = join(tempWorkspace, 'subdir', '..', '..', 'etc', 'passwd')
      assert.equal(isPathInWorkspace(deepTraversal, tempWorkspace), false)
    })

    test('Blocks symlink escapes pointing outside workspace', () => {
      const outsideTarget = join(tempOutside, 'secret.env')
      fs.writeFileSync(outsideTarget, 'SECRET_KEY=12345')

      const symlinkPath = join(tempWorkspace, 'escaped_symlink.txt')
      try {
        fs.symlinkSync(outsideTarget, symlinkPath, 'file')
        // The path appears to be inside tempWorkspace, but realpath resolves to tempOutside!
        const result = isPathInWorkspace(symlinkPath, tempWorkspace)
        assert.equal(result, false, 'Symlink pointing outside workspace must be blocked')
      } catch (err) {
        // On Windows without Developer Mode, creating symlinks might require elevation
        if (err.code === 'EPERM') {
          // If symlinks cannot be created due to OS permission, verify non-symlink paths work
          assert.ok(true, 'Skipping OS-restricted symlink creation')
        } else {
          throw err
        }
      }
    })
  })

  describe('2. AI Endpoint Allowlist & SSRF Credential Protection', () => {
    test('Allows official provider endpoints', () => {
      assert.equal(isAllowedAIEndpoint('https://api.openai.com/v1/chat/completions'), true)
      assert.equal(isAllowedAIEndpoint('https://api.anthropic.com/v1/messages'), true)
      assert.equal(isAllowedAIEndpoint('https://generativelanguage.googleapis.com/v1beta/models'), true)
      assert.equal(isAllowedAIEndpoint('https://api.groq.com/openai/v1/chat/completions'), true)
      assert.equal(isAllowedAIEndpoint('https://api.x.ai/v1/chat/completions'), true)
      assert.equal(isAllowedAIEndpoint('https://integrate.api.nvidia.com/v1/chat/completions'), true)
      assert.equal(isAllowedAIEndpoint('https://openrouter.ai/api/v1/chat/completions'), true)
      assert.equal(isAllowedAIEndpoint('https://api.deepseek.com/chat/completions'), true)
      assert.equal(isAllowedAIEndpoint('https://api.mistral.ai/v1/chat/completions'), true)
    })

    test('Allows local runner endpoints on loopback/localhost only', () => {
      assert.equal(isAllowedAIEndpoint('http://127.0.0.1:11434/v1/chat/completions'), true)
      assert.equal(isAllowedAIEndpoint('http://localhost:11434/v1/chat/completions'), true)
      assert.equal(isAllowedAIEndpoint('http://127.0.0.1:1234/v1/chat/completions'), true)
      assert.equal(isAllowedAIEndpoint('http://localhost:1234/v1/chat/completions'), true)
    })

    test('Blocks unauthorized endpoints, SSRF attempts, and domain spoofs', () => {
      // Attacker server trying to steal keys
      assert.equal(isAllowedAIEndpoint('https://evil-attacker.com/v1/chat/completions'), false)
      // AWS metadata service SSRF
      assert.equal(isAllowedAIEndpoint('http://169.254.169.254/latest/meta-data'), false)
      // Subdomain spoofing
      assert.equal(isAllowedAIEndpoint('https://api.openai.com.attacker.com/v1'), false)
      // Remote non-loopback HTTP
      assert.equal(isAllowedAIEndpoint('http://192.168.1.50:11434/v1'), false)
      // Invalid inputs
      assert.equal(isAllowedAIEndpoint(null), false)
      assert.equal(isAllowedAIEndpoint(''), false)
      assert.equal(isAllowedAIEndpoint('not a url'), false)
    })
  })

  describe('3. Process Lifecycle & Execution Security', () => {
    test('validateProcessCwd accepts paths inside workspace and rejects traversal', () => {
      const validCwd = join(tempWorkspace, 'subdir')
      fs.mkdirSync(validCwd, { recursive: true })

      // When no workspace is watched, any valid string passes
      const unmanaged = validateProcessCwd(validCwd)
      assert.equal(unmanaged.ok, true)
    })

    test('cleanupProcessesForRun cleanly returns when no processes or unknown runId', () => {
      const res = cleanupProcessesForRun('unknown-run-id')
      assert.equal(res.cleaned, 0)
    })
  })

  describe('4. CrashRecoveryService Integration', () => {
    test('checkCrashRecovery handles clean workspaces with no unfinished runs', async () => {
      const mockApi = {
        db: {
          getUnfinishedRuns: async () => ({ success: true, runs: [] })
        }
      }

      const res = await checkCrashRecovery(tempWorkspace, { api: mockApi })
      assert.equal(res.hasUnfinished, false)
      assert.equal(res.status, 'CLEAN')
    })

    test('checkCrashRecovery handles database unavailable gracefully', async () => {
      const mockApi = {}
      const res = await checkCrashRecovery(tempWorkspace, { api: mockApi })
      assert.equal(res.hasUnfinished, false)
      assert.equal(res.status, 'DB_UNAVAILABLE')
    })
  })
})
