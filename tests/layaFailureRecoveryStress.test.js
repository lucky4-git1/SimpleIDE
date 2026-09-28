import test from 'node:test'
import assert from 'node:assert/strict'
import { LayaDecisionAdapter } from '../src/services/agentEngine/LayaDecisionAdapter.js'
import { LayaModelManager } from '../src/services/agentEngine/LayaModelManager.js'
import { ContextPlanner } from '../src/services/agentEngine/ContextPlanner.js'
import { ContextEngine } from '../src/services/agentEngine/ContextEngine.js'
import { PrimeRouter } from '../src/services/agentEngine/PrimeRouter.js'
import { FailureParser } from '../src/services/agentEngine/FailureParser.js'
import { LayaDebuggingController } from '../src/services/agentEngine/LayaDebuggingController.js'
import fs from 'node:fs'
import path from 'node:path'

test('Phase 12: Comprehensive Laya Failure & Recovery Stress Suite (14 Scenarios)', async (t) => {
  const tmpDir = path.join(process.cwd(), 'training', 'tmp_stress_' + Date.now())
  fs.mkdirSync(tmpDir, { recursive: true })

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch (_) {}
  })

  // 1. Invalid model output
  await t.test('1. Invalid model output: schema mismatch triggers safe fallback decision', async () => {
    const invalidAdapter = {
      async predict() {
        return {
          intent: 'INVALID_INTENT_STRING',
          actionClass: 'UNAUTHORIZED_ACTION',
          confidence: 'NOT_A_NUMBER'
        }
      }
    }
    const router = new PrimeRouter({ adapter: invalidAdapter })
    const decision = await router.decide({ request: 'Test request' })
    assert.equal(decision.fallback, true)
    assert.equal(decision.actionClass, 'main_llm')
    assert.match(decision.reason, /schema/i)
  })

  // 2. Malformed tensors
  await t.test('2. Malformed tensors: ONNX formatting errors fall back cleanly', () => {
    const adapter = new LayaDecisionAdapter()
    const malformedOutputs = { logits: 'not an array or tensor' }
    const formatted = adapter._formatOnnxOutputs(malformedOutputs, { task: 'git status' }, Date.now())
    assert.ok(formatted)
    assert.equal(formatted.intent, 'git')
  })

  // 3. Missing model
  await t.test('3. Missing model: non-existent model path falls back safely', async () => {
    const manager = new LayaModelManager({ cacheDir: path.join(tmpDir, 'non_existent') })
    const res = await manager.detectCorruption(path.join(tmpDir, 'non_existent', 'model.onnx'))
    assert.equal(res.corrupted, true)
    assert.match(res.reason, /does not exist/i)
  })

  // 4. Corrupted model (0-byte file)
  await t.test('4. Corrupted model: truncated or 0-byte file detected and triggers fallback', async () => {
    const corruptFile = path.join(tmpDir, 'corrupt.onnx')
    fs.writeFileSync(corruptFile, Buffer.alloc(0))

    const manager = new LayaModelManager({ cacheDir: tmpDir })
    const res = await manager.detectCorruption(corruptFile)
    assert.equal(res.corrupted, true)
    assert.match(res.reason, /0 bytes/i)
  })

  // 5. Timeout and abort signal
  await t.test('5. Timeout & cancellation: abortSignal aborts and returns safe fallback', async () => {
    const adapter = new LayaDecisionAdapter()
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      async () => adapter.predict({ task: 'long running task' }, { signal: controller.signal }),
      /aborted/i
    )
  })

  // 6. Low confidence (< 0.60)
  await t.test('6. Low confidence: forces safe LLM escalation and fallback', async () => {
    const lowConfAdapter = {
      async predict() {
        return {
          intent: 'edit',
          actionClass: 'local_tool',
          toolFamily: 'editor',
          confidence: 0.42,
          needsLLM: false,
          needsVerification: false
        }
      }
    }
    const router = new PrimeRouter({ adapter: lowConfAdapter })
    const decision = await router.decide({ request: 'Risky edit' })
    assert.equal(decision.fallback, true)
    assert.equal(decision.actionClass, 'main_llm')
    assert.equal(decision.needsLLM, true)
    assert.match(decision.reason, /Low confidence/i)
  })

  // 7. Unavailable ONNX runtime
  await t.test('7. Unavailable ONNX runtime: gracefully degrades without crashing process', async () => {
    const adapter = new LayaDecisionAdapter({ modelPath: 'invalid/path/to/weights.onnx' })
    const initRes = await adapter.initialize()
    assert.equal(initRes.success, true) // Initializes with fallback available
    const decision = await adapter.predict({ task: 'git status' })
    assert.ok(decision)
    assert.equal(decision.intent, 'git')
    assert.equal(decision.inferenceSource, 'fallback')
  })

  // 8. SymbolGraph failure
  await t.test('8. SymbolGraph failure: queries encountering broken AST fall back safely', async () => {
    const brokenCodeIntel = {
      findSymbols() { throw new Error('AST parsing failed on malformed syntax') },
      findSymbol() { throw new Error('AST parsing failed on malformed syntax') }
    }
    const planner = new ContextPlanner({ codeIntelligence: brokenCodeIntel })
    const { plan, observability } = await planner.planContext({ task: 'Where is brokenFunc defined?' })
    assert.ok(plan)
    assert.ok(observability)
  })

  // 9. ContextEngine failure
  await t.test('9. ContextEngine resilience: invalid options return valid ContextPackage', async () => {
    const engine = new ContextEngine()
    const pkg = await engine.buildContextPackage({ task: null, activeFile: null })
    assert.ok(pkg)
    assert.ok(Array.isArray(pkg.includedChunks))
  })

  // 10. Tool failure
  await t.test('10. Tool failure handling: failure recorded and parsed into structured representation', () => {
    const rawOutput = 'AssertionError [ERR_ASSERTION]: Expected true but received false\n    at tests/auth.test.js:12:5'
    const parsed = FailureParser.parse(rawOutput)
    assert.ok(parsed.hasFailure)
    assert.equal(parsed.failingFile, 'tests/auth.test.js')
    assert.equal(parsed.failingLine, 12)
  })

  // 11. Compiler failure
  await t.test('11. Compiler / linter error parsed into structured diagnostics', () => {
    const compileOutput = 'src/app.ts:24:5 - error TS2322: Type "string" is not assignable to type "number".'
    const parsed = FailureParser.parse(compileOutput)
    assert.ok(parsed.hasFailure)
    assert.equal(parsed.failingFile, 'src/app.ts')
    assert.equal(parsed.failingLine, 24)
  })

  // 12. Test failure attention window
  await t.test('12. Test failure window is bounded and < 400 tokens', () => {
    const giantLog = 'info 1\n'.repeat(500) + 'AssertionError: fail\n    at test.js:10:2\n' + 'info 2\n'.repeat(500)
    const parsed = FailureParser.parse(giantLog)
    assert.ok(parsed.formattedSummary.length <= 1500)
    assert.match(parsed.formattedSummary, /AssertionError/i)
  })

  // 13. Repeated failed attempts trigger progressive strategy escalation
  await t.test('13. Repeated failed attempts escalate strategies and prevent loops', () => {
    const controller = new LayaDebuggingController()
    const failure = { errorType: 'AssertionError', failingFile: 'tests/auth.test.js', errorMessage: 'expected true' }
    
    // Attempt 1
    const strat1 = controller.decideNextAction(failure, { attempt: 1 })
    assert.ok(strat1.strategy)

    // Attempt 2
    const strat2 = controller.decideNextAction(failure, { attempt: 2, currentStrategy: strat1.strategy })
    assert.notEqual(strat2.strategy, strat1.strategy)
  })

  // 14. Stuck loops engage loop breaker
  await t.test('14. Stuck loops trigger automated loop breaker and stop safely', () => {
    const controller = new LayaDebuggingController()
    const failure = { errorType: 'LoopError', failingFile: 'src/loop.js', errorMessage: 'Loop detected' }
    const stratHalt = controller.decideNextAction(failure, { attempt: 5, maxAttempts: 5 })
    assert.equal(stratHalt.strategy, 'ask_user')
    assert.match(stratHalt.reason, /Exceeded maximum/i)
  })
})
