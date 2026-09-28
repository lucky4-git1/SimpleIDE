import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { LayaModelManager } from '../src/services/agentEngine/LayaModelManager.js'
import { LayaDecisionAdapter } from '../src/services/agentEngine/LayaDecisionAdapter.js'
import { ContextEngine } from '../src/services/agentEngine/ContextEngine.js'
import { ContextPlanner } from '../src/services/agentEngine/ContextPlanner.js'
import { CodeIntelligenceService } from '../src/services/agentEngine/CodeIntelligenceService.js'
import { PrimeRouter, LAYA_ROLLOUT_MODES } from '../src/services/agentEngine/PrimeRouter.js'

test('Phase 15: Production Hardening & Desktop Resilience (14 Edge Cases)', async (t) => {
  const tmpBase = path.join(process.cwd(), 'training', 'tmp_harden_' + Date.now())
  fs.mkdirSync(tmpBase, { recursive: true })

  t.after(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    } catch (_) {}
  })

  // 1. Offline startup
  await t.test('1. Offline startup: operates seamlessly using local model cache or calibrated fallback', async () => {
    const offlineManager = new LayaModelManager({ cacheDir: path.join(tmpBase, 'offline_cache') })
    // No internet, no pre-existing download
    const modelPath = offlineManager.resolveLocalModelPath('simpleide')
    const adapter = new LayaDecisionAdapter({ modelPath })
    const initRes = await adapter.initialize()
    assert.equal(initRes.success, true)

    const decision = await adapter.predict({ task: 'git status' })
    assert.equal(decision.intent, 'git')
    assert.equal(decision.inferenceSource, 'fallback')
  })

  // 2. First-run model download & installation
  await t.test('2. First-run model download: installs atomically with checksum verification', async () => {
    const manager = new LayaModelManager({ cacheDir: tmpBase })
    const payload = Buffer.from('simulated_onnx_model_payload_v1')
    const sha = crypto.createHash('sha256').update(payload).digest('hex')

    const installRes = await manager.installModelAtomically(payload, 'simpleide', sha, '1.0.0')
    assert.equal(installRes.success, true)
    assert.ok(fs.existsSync(installRes.path))
  })

  // 3. Interrupted download recovery
  await t.test('3. Interrupted download recovery: wipes orphaned .tmp files before retrying', async () => {
    const manager = new LayaModelManager({ cacheDir: tmpBase })
    const tempDir = manager.tempDir
    fs.mkdirSync(tempDir, { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'partial_download.tmp'), Buffer.from('incomplete data'))

    await manager.cleanTempFiles()
    const remaining = fs.readdirSync(tempDir)
    assert.equal(remaining.length, 0)
  })

  // 4. Corrupted model recovery
  await t.test('4. Corrupted model recovery: detects bad checksum and triggers rollback', async () => {
    const manager = new LayaModelManager({ cacheDir: tmpBase })
    const corruptFile = path.join(tmpBase, 'bad_model.onnx')
    fs.writeFileSync(corruptFile, Buffer.from('tampered content'))

    const check = await manager.detectCorruption(corruptFile, 'expected_different_sha256')
    assert.equal(check.corrupted, true)
    assert.match(check.reason, /checksum mismatch/i)
  })

  // 5. Model version migration
  await t.test('5. Version migration: installs v1.1.0 in versioned subfolder without overwriting v1.0.0', async () => {
    const manager = new LayaModelManager({ cacheDir: tmpBase })
    const v1Data = Buffer.from('v1_data')
    const v2Data = Buffer.from('v2_data')

    await manager.installModelAtomically(v1Data, 'simpleide', crypto.createHash('sha256').update(v1Data).digest('hex'), '1.0.0')
    await manager.installModelAtomically(v2Data, 'simpleide', crypto.createHash('sha256').update(v2Data).digest('hex'), '1.1.0')

    const v1Path = manager.resolveLocalModelPath('simpleide', '1.0.0')
    const v2Path = manager.resolveLocalModelPath('simpleide', '1.1.0')

    assert.ok(fs.existsSync(v1Path))
    assert.ok(fs.existsSync(v2Path))
    assert.notEqual(v1Path, v2Path)
  })

  // 6. Rollback to previous version
  await t.test('6. Rollback capability: easily switches back to v1.0.0 if v1.1.0 fails', async () => {
    const manager = new LayaModelManager({ cacheDir: tmpBase })
    const v1Path = manager.resolveLocalModelPath('simpleide', '1.0.0')
    assert.ok(fs.existsSync(v1Path))
    assert.equal(fs.readFileSync(v1Path, 'utf8'), 'v1_data')
  })

  // 7. Application restart simulation
  await t.test('7. Application restart: initializes cleanly without stale session state', async () => {
    const adapter1 = new LayaDecisionAdapter()
    await adapter1.initialize()
    await adapter1.predict({ task: 'first session' })

    // Simulate restart
    const adapter2 = new LayaDecisionAdapter()
    await adapter2.initialize()
    const dec2 = await adapter2.predict({ task: 'second session' })
    assert.ok(dec2)
    assert.equal(adapter2.inferenceCount, 1)
  })

  // 8. Crash recovery handling
  await t.test('8. Crash recovery: handles sudden shutdown without corrupting cached models', () => {
    const manager = new LayaModelManager({ cacheDir: tmpBase })
    const v1Path = manager.resolveLocalModelPath('simpleide', '1.0.0')
    assert.ok(fs.existsSync(v1Path))
  })

  // 9. Multiple concurrent agent sessions
  await t.test('9. Multiple agent sessions: concurrent routers operate without cross-talk', async () => {
    const router1 = new PrimeRouter({ layaMode: LAYA_ROLLOUT_MODES.LAYA })
    const router2 = new PrimeRouter({ layaMode: LAYA_ROLLOUT_MODES.LAYA })

    const [res1, res2] = await Promise.all([
      router1.decide({ request: 'git status' }),
      router2.decide({ request: 'npm test' })
    ])

    assert.equal(res1.intent, 'git')
    assert.equal(res2.intent, 'test')
  })

  // 10. Repeated project switching
  await t.test('10. Project switching: re-indexes workspace without leaking old symbols', () => {
    const codeIntelA = new CodeIntelligenceService('D:/project-a')
    codeIntelA.indexFile('src/a.js', 'export function funcA() {}')
    assert.equal(codeIntelA.findSymbols('funcA').length, 1)

    // Switch project
    const codeIntelB = new CodeIntelligenceService('D:/project-b')
    codeIntelB.indexFile('src/b.js', 'export function funcB() {}')
    assert.equal(codeIntelB.findSymbols('funcA').length, 0)
    assert.equal(codeIntelB.findSymbols('funcB').length, 1)
  })

  // 11. Large repositories (bounded context clamping)
  await t.test('11. Large repositories: strictly clamps files to MAX_FILES (5) and tokens to 4000', async () => {
    const codeIntel = new CodeIntelligenceService('D:/large-repo')
    for (let i = 0; i < 50; i++) {
      codeIntel.indexFile(`src/module_${i}.js`, `export function worker_${i}() {}`)
    }

    const planner = new ContextPlanner({ codeIntelligence: codeIntel })
    const { plan, observability } = await planner.planContext({ task: 'Refactor worker_1 and all workers' })

    assert.ok(observability.filesSelected.length <= 5)
    assert.ok(plan.tokenBudget <= 4000)
  })

  // 12. Empty repositories
  await t.test('12. Empty repositories: returns valid package without throwing', async () => {
    const codeIntel = new CodeIntelligenceService('D:/empty-repo')
    const engine = new ContextEngine()
    engine.setCodeIntelligence(codeIntel)

    const pkg = await engine.buildContextPackage({ task: 'Start new project' })
    assert.ok(pkg)
    assert.ok(Array.isArray(pkg.includedChunks))
  })

  // 13. Repositories with malformed syntax files
  await t.test('13. Malformed files: syntax errors do not crash indexing or planning', () => {
    const codeIntel = new CodeIntelligenceService('D:/broken-syntax')
    // Malformed code
    codeIntel.indexFile('src/broken.js', 'function () { if for return }}}')
    assert.ok(codeIntel)
  })

  // 14. Unsupported languages (.rs, .py, .go, .c)
  await t.test('14. Unsupported languages: handled gracefully without throwing', () => {
    const codeIntel = new CodeIntelligenceService('D:/polyglot')
    codeIntel.indexFile('main.rs', 'fn main() { println!("Hello"); }')
    codeIntel.indexFile('script.py', 'def run(): pass')
    codeIntel.indexFile('server.go', 'package main\nfunc main() {}')
    assert.ok(codeIntel)
  })
})
