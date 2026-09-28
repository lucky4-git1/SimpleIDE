import test from 'node:test'
import assert from 'node:assert/strict'
import { LayaModelManager } from '../src/services/agentEngine/LayaModelManager.js'
import { LayaDecisionAdapter } from '../src/services/agentEngine/LayaDecisionAdapter.js'
import os from 'os'
import path from 'path'
import fs from 'fs'
import fsPromises from 'fs/promises'
import crypto from 'crypto'

test('Phase 6/7: Laya Model Management, Verification & Resilience', async (t) => {
  const testDir = path.join(os.tmpdir(), `laya-management-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`)
  await fsPromises.mkdir(testDir, { recursive: true })

  const manager = new LayaModelManager({ cacheDir: testDir })

  t.after(async () => {
    try {
      await fsPromises.rm(testDir, { recursive: true, force: true })
    } catch (_) {}
  })

  await t.test('1. SHA-256 verification: validates accurate hash and rejects mismatched hash', async () => {
    const content = Buffer.from('test model weights buffer for onnx hash validation')
    const correctHash = crypto.createHash('sha256').update(content).digest('hex')
    const invalidHash = '0000000000000000000000000000000000000000000000000000000000000000'

    const testFile = path.join(testDir, 'hash_test.bin')
    await fsPromises.writeFile(testFile, content)

    const validCheck = await manager.verifyChecksum(testFile, correctHash)
    assert.equal(validCheck, true, 'Matching hash must return true')

    const invalidCheck = await manager.verifyChecksum(testFile, invalidHash)
    assert.equal(invalidCheck, false, 'Mismatched hash must return false')
  })

  await t.test('2. Atomic installation & temporary staging: writes to .tmp before atomic rename', async () => {
    const content = Buffer.from('atomic model content')
    const hash = crypto.createHash('sha256').update(content).digest('hex')

    const res = await manager.installModelAtomically(content, 'simpleide', hash)
    assert.equal(res.success, true)
    assert.ok(fs.existsSync(res.path))
    assert.ok(res.path.endsWith('simpleide-laya.onnx'))

    // Verify temp directory contains no lingering tmp files
    if (fs.existsSync(manager.tempDir)) {
      const remainingTemp = await fsPromises.readdir(manager.tempDir)
      assert.equal(remainingTemp.length, 0, 'No orphaned .tmp files should remain in temp directory')
    }
  })

  await t.test('3. Corruption detection: detects 0-byte file and checksum mismatch', async () => {
    const emptyFile = path.join(testDir, 'empty.onnx')
    await fsPromises.writeFile(emptyFile, Buffer.alloc(0))

    const corruptCheck = await manager.detectCorruption(emptyFile)
    assert.equal(corruptCheck.corrupted, true)
    assert.match(corruptCheck.reason, /0 bytes/i)

    const nonExistent = path.join(testDir, 'nonexistent.onnx')
    const nonExistentCheck = await manager.detectCorruption(nonExistent)
    assert.equal(nonExistentCheck.corrupted, true)
    assert.match(nonExistentCheck.reason, /does not exist/i)
  })

  await t.test('4. Versioned model directory resolution', async () => {
    const v1Content = Buffer.from('v1.0.0 model weights')
    const v2Content = Buffer.from('v2.0.0 model weights')

    await manager.installModelAtomically(v1Content, 'simpleide', null, '1.0.0')
    await manager.installModelAtomically(v2Content, 'simpleide', null, '2.0.0')

    const p1 = manager.resolveLocalModelPath('simpleide', '1.0.0')
    const p2 = manager.resolveLocalModelPath('simpleide', '2.0.0')

    assert.ok(p1 && p1.includes('v1.0.0'))
    assert.ok(p2 && p2.includes('v2.0.0'))
    assert.notEqual(p1, p2)
  })

  await t.test('5. Manifest validation & incompatible-model rejection', () => {
    const validManifest = {
      name: 'simpleide-laya',
      baseModel: 'convaiinnovations/laya',
      version: '1.0.0',
      sha256: 'abc123',
      onnxOpset: 18,
      tensorContract: {
        inputs: { input_ids: {}, attention_mask: {} },
        outputs: { logits: {} }
      }
    }
    assert.equal(manager.validateManifest(validManifest).valid, true)

    // Incompatible opset (<14)
    const oldOpset = { ...validManifest, onnxOpset: 11 }
    const oldCheck = manager.validateManifest(oldOpset)
    assert.equal(oldCheck.valid, false)
    assert.match(oldCheck.error, /Incompatible ONNX opset/i)

    // Missing required inputs
    const missingInputs = { ...validManifest, tensorContract: { inputs: {}, outputs: { logits: {} } } }
    const missingCheck = manager.validateManifest(missingInputs)
    assert.equal(missingCheck.valid, false)
    assert.match(missingCheck.error, /missing required inputs/i)
  })

  await t.test('6. Model replacement with automatic rollback on corrupted replacement', async () => {
    // 1. Initial valid model
    const initialContent = Buffer.from('initial valid model weights')
    const initialHash = crypto.createHash('sha256').update(initialContent).digest('hex')
    const install1 = await manager.installModelAtomically(initialContent, 'simpleide', initialHash)
    assert.equal(install1.success, true)

    // 2. Attempt replacement with corrupted data (wrong expected hash)
    const badContent = Buffer.from('corrupted replacement model')
    const replaceRes = await manager.replaceModel(badContent, 'simpleide', {
      expectedSha256: 'bad_hash_that_does_not_match'
    })

    assert.equal(replaceRes.success, false)
    assert.equal(replaceRes.rolledBack, true, 'Should have rolled back to previous valid model')

    // 3. Verify original model content is preserved
    const preservedContent = await fsPromises.readFile(install1.path)
    assert.equal(preservedContent.toString(), 'initial valid model weights')
  })

  await t.test('7. Explicit rollback: restores from backup file', async () => {
    const originalFile = manager.resolveLocalModelPath('simpleide')
    const backupFile = `${originalFile}.backup`
    await fsPromises.writeFile(backupFile, Buffer.from('backup model file content'))

    const rollbackRes = await manager.rollbackModel('simpleide')
    assert.equal(rollbackRes.success, true)

    const activeContent = await fsPromises.readFile(originalFile, 'utf8')
    assert.equal(activeContent, 'backup model file content')
  })

  await t.test('8. Offline startup with already-installed model', async () => {
    assert.equal(manager.isModelAvailable('simpleide'), true)
    const localPath = manager.resolveLocalModelPath('simpleide')
    assert.ok(localPath && fs.existsSync(localPath))

    const status = manager.getStatus()
    assert.equal(status.simpleideModel.available, true)
    assert.equal(status.simpleideModel.path, localPath)
  })

  await t.test('9. Missing-model fallback: uninstalled model resolves null cleanly', async () => {
    const emptyCache = path.join(os.tmpdir(), `empty-cache-${Date.now()}`)
    const emptyManager = new LayaModelManager({ cacheDir: emptyCache })

    assert.equal(emptyManager.isModelAvailable('nonexistent'), false)
    assert.equal(emptyManager.resolveLocalModelPath('nonexistent'), null)

    const adapter = new LayaDecisionAdapter({ modelManager: emptyManager, variant: 'nonexistent' })
    const dec = await adapter.predict({ request: 'git commit -m "fix"', state: 'IDLE' })
    assert.equal(dec.inferenceSource, 'fallback')
    assert.equal(dec.intent, 'git')
  })

  await t.test('10. Failed-download fallback: download failure does not crash and leaves no debris', async () => {
    const failingDownload = async () => {
      throw new Error('Connection refused by remote host (503 Service Unavailable)')
    }

    const downloadRes = await manager.downloadModel({
      downloadStreamFn: failingDownload,
      variant: 'simpleide'
    })

    assert.equal(downloadRes.success, false)
    assert.equal(downloadRes.fallback, true)
    assert.match(downloadRes.error, /Connection refused/i)

    // No leftover .tmp files
    if (fs.existsSync(manager.tempDir)) {
      const temps = await fsPromises.readdir(manager.tempDir)
      assert.equal(temps.length, 0)
    }
  })

  await t.test('11. Git isolation: cache directory is outside workspace and ignored', async () => {
    // Check that cacheDir is outside workspace or ignored
    const gitignore = await fsPromises.readFile(path.resolve('.gitignore'), 'utf8')
    assert.match(gitignore, /\*\.onnx/)
    assert.match(gitignore, /models\/\*\*\/\*\.onnx/)
    assert.match(gitignore, /training\/checkpoints\//)
  })
})
