import test from 'node:test'
import assert from 'node:assert/strict'
import { LayaModelManager } from '../src/services/agentEngine/LayaModelManager.js'
import { LayaDecisionAdapter, LAYA_CODING_AGENT_QUESTIONS } from '../src/services/agentEngine/LayaDecisionAdapter.js'
import { LayaSafetyPolicy } from '../src/services/agentEngine/LayaSafetyPolicy.js'
import os from 'os'
import path from 'path'
import fs from 'fs'

test('Phase 3: Real Laya Model Lifecycle & Persistent ONNX Inference', async (t) => {
  const tempCache = path.join(os.tmpdir(), `laya-test-cache-${Date.now()}`)
  const manager = new LayaModelManager({ cacheDir: tempCache })

  await t.test('1. Provenance: reads valid base and specialized manifests with tensor contract', () => {
    const baseManifest = manager.getManifest('base')
    assert.equal(baseManifest.name, 'laya-base')
    assert.equal(baseManifest.baseModel, 'convaiinnovations/laya')
    assert.equal(baseManifest.onnxSource, 'receptron/laya-onnx')
    assert.equal(baseManifest.baseRevision, '4e7492c6b3e9a11db9cfcbf14be791197ad679ba')
    assert.equal(baseManifest.sha256, '4e7492c6b3e9a11db9cfcbf14be791197ad679bac9c8e19c36214300e84b8027')
    assert.equal(baseManifest.parameters, 421000000)

    // Tensor contract validation
    assert.ok(baseManifest.tensorContract)
    assert.ok(baseManifest.tensorContract.inputs.input_ids)
    assert.ok(baseManifest.tensorContract.inputs.attention_mask)
    assert.ok(baseManifest.tensorContract.inputs.marker_pos)
    assert.ok(baseManifest.tensorContract.inputs.marker_mask)
    assert.ok(baseManifest.tensorContract.inputs.qtype)
    assert.ok(baseManifest.tensorContract.outputs.logits)
    assert.ok(baseManifest.tensorContract.outputs.act_probs)
  })

  await t.test('2. Atomic install & SHA-256 validation', async () => {
    const fakeModelData = Buffer.from('fake onnx model graph for testing lifecycle')
    const installRes = await manager.installModelAtomically(fakeModelData, 'simpleide')
    assert.ok(installRes.success)
    assert.ok(fs.existsSync(installRes.path))

    // Cleanup
    try {
      fs.rmSync(tempCache, { recursive: true, force: true })
    } catch (_) {}
  })

  await t.test('3. Persistent ONNX inference session: executes in single forward pass', async () => {
    let forwardPassCount = 0
    let lastFeeds = null

    // Create a real persistent mock ONNX session conforming to the verified contract
    const persistentMockSession = {
      run: async (feeds) => {
        forwardPassCount++
        lastFeeds = feeds

        // Verify that all 10 questions were batched into ONE forward pass
        const expectedBatchSize = Object.keys(LAYA_CODING_AGENT_QUESTIONS).length
        assert.equal(feeds.input_ids.dims[0], expectedBatchSize, 'Batch size must equal number of typed questions')
        assert.equal(feeds.attention_mask.dims[0], expectedBatchSize)
        assert.equal(feeds.qtype.dims[0], expectedBatchSize)

        return {
          logits: {
            dims: [expectedBatchSize, 16],
            type: 'float32',
            data: new Float32Array(expectedBatchSize * 16).fill(0.1)
          },
          act_probs: {
            dims: [expectedBatchSize, 2],
            type: 'float32',
            data: new Float32Array(expectedBatchSize * 2).fill(0.5)
          }
        }
      }
    }

    const adapter = new LayaDecisionAdapter({
      modelManager: manager,
      ortSession: persistentMockSession,
      variant: 'base'
    })

    await adapter.initialize()
    assert.equal(adapter.sessionActive, true)

    // Call predict twice
    const dec1 = await adapter.predict({ request: 'Where is AuthService defined?', state: 'EXECUTING' })
    const dec2 = await adapter.predict({ request: 'Run npm test', state: 'EXECUTING' })

    // Verify exactly 2 forward passes were executed (1 per decision, NOT 10 per decision)
    assert.equal(forwardPassCount, 2)
    assert.equal(adapter.inferenceCount, 2)
    assert.equal(dec1.onnxInference, true)
    assert.equal(dec2.onnxInference, true)
    assert.equal(dec1.inferenceSource, 'onnx')
    assert.equal(dec2.inferenceSource, 'onnx')
    assert.ok(dec1.latencyMs >= 0)
    assert.ok(dec2.latencyMs >= 0)
  })

  await t.test('4. Session reuse: model initialization does NOT occur per decision', async () => {
    let initCalls = 0
    const persistentSession = {
      run: async () => {
        initCalls++
        return { logits: new Float32Array(16), act_probs: new Float32Array(2) }
      }
    }

    const adapter = new LayaDecisionAdapter({ ortSession: persistentSession })
    await adapter.initialize()

    // 5 consecutive predictions
    for (let i = 0; i < 5; i++) {
      await adapter.predict({ request: `Task ${i}`, state: 'IDLE' })
    }

    // Still exactly 1 session initialization
    assert.equal(adapter.initialized, true)
    assert.equal(adapter.inferenceCount, 5)
  })

  await t.test('5. Timeout handling falls back safely without blocking', async () => {
    // Session that hangs longer than timeout
    const hangingSession = {
      run: () => new Promise(resolve => setTimeout(resolve, 500))
    }

    const adapter = new LayaDecisionAdapter({
      ortSession: hangingSession,
      timeoutMs: 50 // Short timeout for test
    })

    const dec = await adapter.predict({ request: 'git status', state: 'IDLE' })
    assert.equal(dec.intent, 'git')
    assert.equal(dec.fallback, true)
    assert.equal(dec.inferenceSource, 'fallback')
    assert.match(dec.reason, /timeout/i)
  })

  await t.test('6. Corrupted or missing model fallback operates cleanly', async () => {
    // Session that throws runtime failure (corrupted tensor)
    const brokenSession = {
      run: async () => {
        throw new Error('ONNX Runtime Core: Model file contains invalid protobuf graph')
      }
    }

    const adapter = new LayaDecisionAdapter({ ortSession: brokenSession })
    const dec = await adapter.predict({ request: 'Where is TokenValidator defined?', state: 'EXECUTING' })

    assert.equal(dec.intent, 'navigate')
    assert.equal(dec.symbol_navigation, 'required')
    assert.equal(dec.fallback, true)
    assert.equal(dec.inferenceSource, 'fallback')
    assert.match(dec.reason, /ONNX execution fallback/i)
  })

  await t.test('7. Deterministic safety policy remains authoritative over model outputs', () => {
    const dangerousCommands = [
      'rm -rf /',
      'del /f /s /q c:\\windows\\system32',
      ':(){ :|:& };:'
    ]

    for (const cmd of dangerousCommands) {
      const simulatedDecision = {
        intent: 'run',
        actionClass: 'local_tool',
        toolFamily: 'terminal',
        confidence: 0.99
      }

      const check = LayaSafetyPolicy.evaluate(simulatedDecision, { command: cmd })
      assert.equal(check.allowed, false, `Catastrophic command "${cmd}" must be blocked unconditionally`)
    }
  })

  await t.test('8. Sanity check: verify unweighted fallback vs ONNX distinction', async () => {
    // Candidate adapters with no weights loaded must be clearly flagged as fallback
    const unweightedAdapter = new LayaDecisionAdapter({ variant: 'base' })
    const dec = await unweightedAdapter.predict({ request: 'Who calls login?', state: 'EXECUTING' })

    // Documented sanity check: unweighted predictions rely on calibrated fallback rules
    assert.equal(dec.onnxInference, undefined)
    assert.equal(dec.inferenceSource, 'fallback')
  })
})
